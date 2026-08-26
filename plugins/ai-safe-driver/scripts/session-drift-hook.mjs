#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  STATE_SCHEMA,
  applyAssistantTurn,
  applyUserTurn,
  classifyAssistantResponse,
  classifyUserPrompt,
  createInitialState,
} from "./drift-detector.mjs";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_CONTEXT_BYTES = 4096;
const LOCK_STALE_MS = 5 * 60 * 1000;
const configuredTestRoot = process.env.AI_SAFE_DRIVER_TEST_MODE === "1"
  ? process.env.AI_SAFE_DRIVER_STATE_DIR
  : undefined;
const root = path.resolve(configuredTestRoot || path.join(tmpdir(), "ai-safe-driver"));
const sessionKey = (id) => createHash("sha256").update(id).digest("hex").slice(0, 32);
const statePath = (id) => path.join(root, `${sessionKey(id)}.json`);
const lockPath = (id) => `${statePath(id)}.lock`;

const readStdin = async () => {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) throw new Error("hook input too large");
  }
  return JSON.parse(raw);
};

const recoveryContext = (reason) => [
  "AI Safe Driver observed a repeated-correction recovery signal.",
  `Trigger category: ${reason}. This is an observable rule label, not hidden model-state measurement.`,
  "Load and follow the ai-safe-driver skill now. Stop defending the previous response.",
  "Re-anchor to the user's latest goal and name the exact repeated mismatch.",
  "Separate evidence, supported cause, hypotheses, and unknowns.",
  "Do not retry a tool unless the user explicitly requested diagnosis and a relevant condition changed.",
  "Do not write files, create a handover, compact, or clear without separate explicit approval.",
].join("\n").slice(0, MAX_CONTEXT_BYTES);

const isMissing = (error) => error && error.code === "ENOENT";
const isSessionId = (value) => typeof value === "string" && value.length > 0;

const ensureRoot = async () => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe state root");
  await chmod(root, 0o700);
};

const isValidState = (value) => value !== null
  && typeof value === "object"
  && value.schema === STATE_SCHEMA
  && Number.isFinite(value.correctionCount)
  && Number.isFinite(value.protestCount)
  && Number.isFinite(value.recurrenceCount)
  && typeof value.assistantAcknowledged === "boolean"
  && typeof value.repairPromised === "boolean"
  && Number.isFinite(value.lastSignalAt)
  && Number.isFinite(value.cooldownRemaining)
  && typeof value.recoveryInjected === "boolean"
  && Number.isFinite(value.expiresAt);

const assertRegularFile = async (file) => {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe state file");
  return info;
};

const loadState = async (id) => {
  const file = statePath(id);
  try {
    await assertRegularFile(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (!isValidState(parsed)) throw new Error("invalid state schema");
  return parsed;
};

const writeStateAtomically = async (id, state) => {
  if (!isValidState(state)) throw new Error("refusing invalid state");
  await ensureRoot();
  const file = statePath(id);
  try {
    await assertRegularFile(file);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const temporary = path.join(root, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await chmod(temporary, 0o600);
    await handle.writeFile(JSON.stringify(state), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertRegularFile(temporary);
    try {
      await assertRegularFile(file);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const pruneExpired = async () => {
  await ensureRoot();
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.endsWith(".json") || entry.isSymbolicLink() || !entry.isFile()) continue;
    const file = path.join(root, entry.name);
    try {
      await assertRegularFile(file);
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (isValidState(parsed) && parsed.expiresAt <= Date.now()) {
        await assertRegularFile(file);
        await rm(file);
      }
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
  }
};

const acquireLock = async (id) => {
  const file = lockPath(id);
  const createLock = async () => {
    const handle = await open(file, "wx", 0o600);
    await chmod(file, 0o600);
    await handle.close();
    return file;
  };
  try {
    return await createLock();
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
  }

  const existing = await assertRegularFile(file);
  if (Date.now() - existing.mtimeMs <= LOCK_STALE_MS) return undefined;
  await assertRegularFile(file);
  await rm(file);
  try {
    return await createLock();
  } catch (error) {
    if (error && error.code === "EEXIST") return undefined;
    throw error;
  }
};

const withSessionLock = async (id, callback) => {
  await ensureRoot();
  const file = await acquireLock(id);
  if (!file) return undefined;
  try {
    return await callback();
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
};

const statesEqual = (left, right) => (
  left.schema === right.schema
  && left.correctionCount === right.correctionCount
  && left.protestCount === right.protestCount
  && left.recurrenceCount === right.recurrenceCount
  && left.assistantAcknowledged === right.assistantAcknowledged
  && left.repairPromised === right.repairPromised
  && left.lastSignalAt === right.lastSignalAt
  && left.cooldownRemaining === right.cooldownRemaining
  && left.recoveryInjected === right.recoveryInjected
  && left.expiresAt === right.expiresAt
);

const handleUserPrompt = async (input) => {
  const signals = classifyUserPrompt(input.prompt);
  if (!isSessionId(input.session_id)) {
    if (signals.explicitHealthCheck) return "explicit_health_check";
    if (signals.explicitToolDiagnosis) return "explicit_tool_diagnosis";
    return undefined;
  }

  await pruneExpired();
  return withSessionLock(input.session_id, async () => {
    const existing = await loadState(input.session_id);
    const initial = existing || createInitialState();
    const result = applyUserTurn(initial, signals);
    if (!existing) {
      const hasSignal = signals.correction || signals.protest || signals.recurrence
        || signals.explicitHealthCheck || signals.explicitToolDiagnosis;
      if (hasSignal) await writeStateAtomically(input.session_id, result.state);
    } else if (!statesEqual(existing, result.state)) {
      await writeStateAtomically(input.session_id, result.state);
    }
    return result.inject ? result.reason : undefined;
  });
};

const handleStop = async (input) => {
  if (!isSessionId(input.session_id)) return;
  await pruneExpired();
  await withSessionLock(input.session_id, async () => {
    const existing = await loadState(input.session_id);
    if (!existing) return;
    const next = applyAssistantTurn(existing, classifyAssistantResponse(input.last_assistant_message));
    if (!statesEqual(existing, next)) await writeStateAtomically(input.session_id, next);
  });
};

const main = async () => {
  const input = await readStdin();
  if (input === null || typeof input !== "object" || Array.isArray(input)) return;
  if (input.hook_event_name === "Stop") {
    await handleStop(input);
    return;
  }
  if (input.hook_event_name !== "UserPromptSubmit") return;
  const reason = await handleUserPrompt(input);
  if (!reason) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: recoveryContext(reason),
    },
    suppressOutput: true,
  }));
};

main().catch(() => {
  process.stderr.write("ai-safe-driver hook: unavailable\n");
  process.exitCode = 0;
});
