#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
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
const LOCK_LEASE_MS = 30 * 1000;
const RECLAIM_GUARD_LEASE_MS = LOCK_LEASE_MS;
const MAX_RECLAIMER_GUARD_CLEANUP = 64;
const ACTIVE_GUARD_EPOCH_WINDOW = 1;
const TEST_MODE = process.env.AI_SAFE_DRIVER_TEST_MODE === "1";
const testNow = Number(process.env.AI_SAFE_DRIVER_TEST_NOW_MS);
const testEpochMs = Number(process.env.AI_SAFE_DRIVER_TEST_RECLAIM_EPOCH_MS);
const clockNow = () => TEST_MODE && Number.isFinite(testNow) ? testNow : Date.now();
const reclaimerEpochMs = TEST_MODE && Number.isFinite(testEpochMs) && testEpochMs > 0
  ? testEpochMs
  : RECLAIM_GUARD_LEASE_MS;
const configuredTestRoot = TEST_MODE
  ? process.env.AI_SAFE_DRIVER_STATE_DIR
  : undefined;
const root = path.resolve(configuredTestRoot || path.join(tmpdir(), "ai-safe-driver"));
const sessionKey = (id) => createHash("sha256").update(id).digest("hex").slice(0, 32);
const statePath = (id) => path.join(root, `${sessionKey(id)}.json`);

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
const STATE_KEYS = [
  "schema",
  "correctionCount",
  "protestCount",
  "recurrenceCount",
  "assistantAcknowledged",
  "repairPromised",
  "lastSignalAt",
  "cooldownRemaining",
  "recoveryInjected",
  "expiresAt",
];

const ensureRoot = async () => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error("unsafe state root");
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
};

const hasStateFields = (value) => value !== null
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

const canonicalState = (value) => {
  if (!hasStateFields(value)) throw new Error("invalid state schema");
  return Object.fromEntries(STATE_KEYS.map((key) => [key, value[key]]));
};

const hasOnlyStateKeys = (value) => Object.keys(value).length === STATE_KEYS.length
  && STATE_KEYS.every((key) => Object.hasOwn(value, key));

const assertRegularFile = async (file) => {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe state file");
  return info;
};

const hasIdentity = (info, identity) => info.isFile()
  && !info.isSymbolicLink()
  && info.dev === identity.dev
  && info.ino === identity.ino;

const testBarrier = async (point, automaticReleasePath) => {
  const directory = TEST_MODE && process.env.AI_SAFE_DRIVER_TEST_BARRIER_DIR;
  const configured = [process.env.AI_SAFE_DRIVER_TEST_BARRIER, process.env.AI_SAFE_DRIVER_TEST_BARRIERS]
    .filter(Boolean)
    .flatMap((value) => value.split(","));
  if (!directory || !configured.includes(point)) return;
  const ready = path.join(directory, `${point}.ready`);
  const proceed = path.join(directory, `${point}.continue`);
  const handle = await open(ready, "wx", 0o600);
  await handle.close();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await lstat(proceed);
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (automaticReleasePath) {
      try {
        await lstat(automaticReleasePath);
        return;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("test barrier timed out");
};

const readRegularFile = async (file) => {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("unsafe state file");
    return { content: await handle.readFile("utf8"), identity: { dev: info.dev, ino: info.ino } };
  } finally {
    await handle.close();
  }
};

const readStateFile = async (file) => {
  try {
    await assertRegularFile(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  await testBarrier("before-state-open");
  const { content, identity } = await readRegularFile(file);
  const parsed = JSON.parse(content);
  return { state: canonicalState(parsed), canonicalized: !hasOnlyStateKeys(parsed), identity };
};

const loadState = async (id) => readStateFile(statePath(id));

const readLock = async (file) => {
  let record;
  try {
    record = await readRegularFile(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let lock;
  try {
    lock = JSON.parse(record.content);
  } catch {
    return { ...record, valid: false };
  }
  const valid = lock !== null
    && typeof lock === "object"
    && typeof lock.owner === "string"
    && lock.owner.length > 0
    && Number.isFinite(lock.leaseExpiresAt);
  return { ...record, valid, lock };
};

const writeStateAtomically = async (id, state) => {
  const serializedState = canonicalState(state);
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
    await handle.writeFile(JSON.stringify(serializedState), "utf8");
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
      await withFileLock(file, async () => {
        const record = await readStateFile(file);
        if (!record || record.state.expiresAt > Date.now()) return;
        await testBarrier("after-expired-state-read");
        const current = await lstat(file);
        if (!current.isFile() || current.isSymbolicLink()) return;
        if (current.dev !== record.identity.dev || current.ino !== record.identity.ino) return;
        await rm(file);
      });
    } catch (error) {
      if (isMissing(error)) continue;
      // A corrupt record must not suppress processing of independent sessions.
      continue;
    }
  }
};

const writeLock = async (file, owner) => {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ owner, leaseExpiresAt: clockNow() + LOCK_LEASE_MS }), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { file, owner };
};

const reclaimerEpoch = () => Math.floor(clockNow() / reclaimerEpochMs);
const reclaimerGuardPath = (file, identity, epoch) => (
  `${file}.reclaim.${identity.dev}-${identity.ino}.${epoch}`
);

const readReclaimerGuard = async (file) => {
  const record = await readLock(file);
  if (!record || !record.valid) return record;
  return record;
};

const writeReclaimerGuard = async (file, owner, lockIdentity, epoch) => {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({
      owner,
      leaseExpiresAt: clockNow() + RECLAIM_GUARD_LEASE_MS,
      lockDev: lockIdentity.dev,
      lockIno: lockIdentity.ino,
      epoch,
    }), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { file, owner };
};

const guardNameParts = (name) => {
  const match = /^(.+\.json\.lock)\.reclaim\.(\d+)-(\d+)\.(\d+)$/u.exec(name);
  if (!match) return undefined;
  return {
    lockName: match[1],
    lockDev: Number(match[2]),
    lockIno: Number(match[3]),
    epoch: Number(match[4]),
  };
};

const isExactActiveGuard = (record, lockIdentity, epoch) => record?.valid
  && record.lock.lockDev === lockIdentity.dev
  && record.lock.lockIno === lockIdentity.ino
  && record.lock.epoch === epoch
  && record.lock.leaseExpiresAt > clockNow();

const activeReclaimerGuards = async (lockFile, lockIdentity) => {
  const active = [];
  for (const epoch of [reclaimerEpoch(), reclaimerEpoch() - ACTIVE_GUARD_EPOCH_WINDOW]) {
    const file = reclaimerGuardPath(lockFile, lockIdentity, epoch);
    try {
      const record = await readReclaimerGuard(file);
      if (isExactActiveGuard(record, lockIdentity, epoch)) active.push({ file, record });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return active;
};

const cleanupHistoricalReclaimerGuards = async () => {
  const entries = await readdir(root, { withFileTypes: true });
  const currentEpoch = reclaimerEpoch();
  let inspected = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const parts = guardNameParts(entry.name);
    if (!parts || parts.epoch > currentEpoch - ACTIVE_GUARD_EPOCH_WINDOW - 1) continue;
    if (inspected >= MAX_RECLAIMER_GUARD_CLEANUP) break;
    inspected += 1;
    try {
      const file = path.join(root, entry.name);
      const record = await readReclaimerGuard(file);
      if (!record?.valid || record.lock.leaseExpiresAt > clockNow()) continue;
      if (record.lock.lockDev !== parts.lockDev || record.lock.lockIno !== parts.lockIno) continue;
      if (record.lock.epoch !== parts.epoch) continue;
      await rm(file);
    } catch (error) {
      if (!isMissing(error)) continue;
    }
  }
};

const acquireReclaimerGuard = async (lockFile, lockIdentity) => {
  await cleanupHistoricalReclaimerGuards();
  if ((await activeReclaimerGuards(lockFile, lockIdentity)).length > 0) return undefined;
  const epoch = reclaimerEpoch();
  const file = reclaimerGuardPath(lockFile, lockIdentity, epoch);
  const owner = randomUUID();
  try {
    await writeReclaimerGuard(file, owner, lockIdentity, epoch);
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
    return undefined;
  }
  const active = await activeReclaimerGuards(lockFile, lockIdentity);
  const adjacentWinner = active.some(({ file: candidate, record }) => (
    candidate !== file && record.lock.epoch <= epoch
  ));
  if (adjacentWinner) {
    await releaseReclaimerGuard({ file, owner });
    return undefined;
  }
  return { file, owner, lockIdentity, epoch };
};

const releaseReclaimerGuard = async ({ file, owner, lockIdentity, epoch }) => {
  const current = await readReclaimerGuard(file);
  if (!current || !current.valid || current.lock.owner !== owner) return;
  if (lockIdentity && (current.lock.lockDev !== lockIdentity.dev || current.lock.lockIno !== lockIdentity.ino)) return;
  if (epoch !== undefined && current.lock.epoch !== epoch) return;
  await rm(file);
};

const discardExpiredLock = async (file, record) => {
  if (!record) return false;
  if (record.valid && record.lock.leaseExpiresAt > clockNow()) return false;
  if (!record.valid && clockNow() - (await assertRegularFile(file)).mtimeMs <= LOCK_LEASE_MS) return false;
  const current = await readLock(file);
  if (!current || current.identity.dev !== record.identity.dev || current.identity.ino !== record.identity.ino) return false;
  if (record.valid !== current.valid) return false;
  if (record.valid && (
    current.lock.owner !== record.lock.owner
    || current.lock.leaseExpiresAt !== record.lock.leaseExpiresAt
    || current.lock.leaseExpiresAt > clockNow()
  )) return false;
  const guardFile = reclaimerGuardPath(file, current.identity, reclaimerEpoch());
  await testBarrier("after-stale-lock-reread", guardFile);
  const guard = await acquireReclaimerGuard(file, current.identity);
  if (!guard) return false;
  const confirmed = await readLock(file);
  if (!confirmed || confirmed.identity.dev !== current.identity.dev || confirmed.identity.ino !== current.identity.ino) {
    await releaseReclaimerGuard(guard);
    return false;
  }
  if (current.valid !== confirmed.valid || (current.valid && (
    confirmed.lock.owner !== current.lock.owner
    || confirmed.lock.leaseExpiresAt !== current.lock.leaseExpiresAt
    || confirmed.lock.leaseExpiresAt > clockNow()
  ))) {
    await releaseReclaimerGuard(guard);
    return false;
  }
  await rm(file);
  return guard;
};

const acquireLock = async (file) => {
  const owner = randomUUID();
  try {
    return await writeLock(file, owner);
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
  }

  const existing = await readLock(file);
  if (!existing) return undefined;
  if (existing.valid && existing.lock.leaseExpiresAt > clockNow()) return undefined;
  if (!existing.valid && clockNow() - (await assertRegularFile(file)).mtimeMs <= LOCK_LEASE_MS) return undefined;
  const reclaimerGuard = await discardExpiredLock(file, existing);
  if (!reclaimerGuard) return undefined;
  const retryCreateLock = async () => {
    return writeLock(file, owner);
  };
  try {
    return { ...(await retryCreateLock()), reclaimerGuard };
  } catch (error) {
    await releaseReclaimerGuard(reclaimerGuard);
    if (!error || error.code !== "EEXIST") throw error;
  }
  return undefined;
};

const releaseLock = async ({ file, owner }) => {
  const current = await readLock(file);
  if (!current || !current.valid || current.lock.owner !== owner) return;
  await testBarrier("before-lock-release");
  const confirmation = await readLock(file);
  if (!confirmation || !confirmation.valid || confirmation.lock.owner !== owner) return;
  await rm(file);
};

const withFileLock = async (file, callback) => {
  await ensureRoot();
  const lock = await acquireLock(`${file}.lock`);
  if (!lock) return undefined;
  try {
    return await callback();
  } finally {
    await releaseLock(lock).catch(() => undefined);
    if (lock.reclaimerGuard) await releaseReclaimerGuard(lock.reclaimerGuard).catch(() => undefined);
  }
};

const withSessionLock = (id, callback) => withFileLock(statePath(id), callback);

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
    const loaded = await loadState(input.session_id);
    const existing = loaded?.state;
    const initial = existing || createInitialState();
    const result = applyUserTurn(initial, signals);
    if (!existing) {
      const hasSignal = signals.correction || signals.protest || signals.recurrence
        || signals.explicitHealthCheck || signals.explicitToolDiagnosis;
      if (hasSignal) await writeStateAtomically(input.session_id, result.state);
    } else if (loaded.canonicalized || !statesEqual(existing, result.state)) {
      await writeStateAtomically(input.session_id, result.state);
    }
    return result.inject ? result.reason : undefined;
  });
};

const handleStop = async (input) => {
  if (!isSessionId(input.session_id)) return;
  await pruneExpired();
  await withSessionLock(input.session_id, async () => {
    const loaded = await loadState(input.session_id);
    const existing = loaded?.state;
    if (!existing) return;
    const next = applyAssistantTurn(existing, classifyAssistantResponse(input.last_assistant_message));
    if (loaded.canonicalized || !statesEqual(existing, next)) await writeStateAtomically(input.session_id, next);
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
