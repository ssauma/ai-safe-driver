import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.resolve(testDir, "../plugins/ai-safe-driver/scripts/session-drift-hook.mjs");
const stateRoots = new Set();

const makeStateDir = (label = "state") => {
  const dir = mkdtempSync(path.join(tmpdir(), `ai-safe-driver-${label}-`));
  stateRoots.add(dir);
  return dir;
};

const runDriftHook = (stateDir, input, extraEnv = {}) => spawnSync(
  process.execPath,
  [hookScript],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      AI_SAFE_DRIVER_TEST_MODE: "1",
      AI_SAFE_DRIVER_STATE_DIR: stateDir,
      ...extraEnv,
    },
    input: typeof input === "string" ? input : JSON.stringify(input),
  },
);

const runWithoutTestMode = (stateDir, input) => {
  const {
    AI_SAFE_DRIVER_TEST_MODE: _testMode,
    AI_SAFE_DRIVER_STATE_DIR: _stateDir,
    ...env
  } = process.env;
  return spawnSync(process.execPath, [hookScript], {
    encoding: "utf8",
    env: { ...env, AI_SAFE_DRIVER_STATE_DIR: stateDir },
    input: JSON.stringify(input),
  });
};

const stateName = (sessionId) => `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.json`;
const stateFile = (root, sessionId) => path.join(root, stateName(sessionId));
const lockFile = (root, sessionId) => `${stateFile(root, sessionId)}.lock`;
const reclaimerGuardDirectory = (root) => path.join(root, ".reclaimer-guards");
const ensureReclaimerGuardDirectory = (root) => {
  const directory = reclaimerGuardDirectory(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
};
const reclaimerGuardFile = (root, sessionId, identity, epoch) => (
  path.join(
    ensureReclaimerGuardDirectory(root),
    `${path.basename(lockFile(root, sessionId))}.reclaim.${identity.dev}-${identity.ino}.${epoch}`,
  )
);
const ageHistoricalGuard = (file, now) => utimesSync(file, new Date(now - 30_001), new Date(now - 30_001));
const readState = (root, sessionId) => JSON.parse(readFileSync(stateFile(root, sessionId), "utf8"));
const mode = (file) => statSync(file).mode & 0o777;
const assertSucceeded = (result) => assert.equal(result.status, 0, result.stderr);
const assertNoOutput = (result) => {
  assertSucceeded(result);
  assert.equal(result.stdout, "");
};
const assertBoundedStderr = (result) => {
  assertSucceeded(result);
  assert.equal(result.stdout, "");
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 512, result.stderr);
  assert.ok(result.stderr.split("\n").filter(Boolean).length <= 1, result.stderr);
};
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const barrierPath = (dir, point, suffix) => path.join(dir, `${point}.${suffix}`);
const startDriftHook = (stateDir, input, extraEnv = {}, extraArgs = []) => {
  const child = spawn(process.execPath, [...extraArgs, hookScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      AI_SAFE_DRIVER_TEST_MODE: "1",
      AI_SAFE_DRIVER_STATE_DIR: stateDir,
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(input));
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
  return { child, result };
};
const waitForBarrier = async ({ child, result }, dir, point) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(barrierPath(dir, point, "ready"))) return;
    if (child.exitCode !== null) break;
    await wait(20);
  }
  if (child.exitCode === null) child.kill("SIGKILL");
  await result;
  throw new Error(`hook did not reach test barrier: ${point}`);
};
const releaseBarrier = (dir, point) => writeFileSync(barrierPath(dir, point, "continue"), "release");
const writeStateAtomicallyForTest = (file, state) => {
  const temporary = `${file}.test-replacement`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, file);
};
const plainState = (overrides = {}) => ({
  schema: "ai-safe-driver-session-state-v1",
  correctionCount: 1,
  protestCount: 0,
  recurrenceCount: 0,
  assistantAcknowledged: false,
  repairPromised: false,
  lastSignalAt: 1,
  cooldownRemaining: 0,
  recoveryInjected: false,
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

test.afterEach(() => {
  for (const root of stateRoots) rmSync(root, { recursive: true, force: true });
  stateRoots.clear();
});

test("a correction stores only private state in user-only paths", () => {
  const root = makeStateDir("private");
  const sessionId = "session-private-42";
  const prompt = "그게 아니라 내가 요청한 건 이 형식이야.";
  chmodSync(root, 0o755);

  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt,
  }));

  const file = stateFile(root, sessionId);
  const serialized = readFileSync(file, "utf8");
  const state = JSON.parse(serialized);
  assert.equal(readdirSync(root).length, 1);
  assert.equal(mode(root), 0o700);
  assert.equal(mode(file), 0o600);
  assert.equal(lstatSync(file).isFile(), true);
  assert.equal(path.basename(file).includes(sessionId), false);
  assert.equal(serialized.includes(prompt), false);
  assert.equal(state.schema, "ai-safe-driver-session-state-v1");
});

test("Stop records acknowledgment categories without retaining assistant text", () => {
  const root = makeStateDir("stop");
  const sessionId = "session-stop";
  const assistantText = "맞습니다. 요청한 항목을 넣지 않았습니다. 죄송합니다. 다시 고치겠습니다.";

  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  }));
  assertNoOutput(runDriftHook(root, {
    hook_event_name: "Stop", session_id: sessionId, last_assistant_message: assistantText,
  }));

  const serialized = readFileSync(stateFile(root, sessionId), "utf8");
  const state = JSON.parse(serialized);
  assert.equal(state.assistantAcknowledged, true);
  assert.equal(state.repairPromised, true);
  assert.equal(serialized.includes(assistantText), false);
  assert.equal(serialized.includes("안 했잖아."), false);
});

test("an acknowledged later recurrence injects bounded recovery context", () => {
  const root = makeStateDir("trigger");
  const sessionId = "session-trigger";
  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  }));
  assertNoOutput(runDriftHook(root, {
    hook_event_name: "Stop", session_id: sessionId,
    last_assistant_message: "맞습니다. 죄송합니다. 다시 고치겠습니다.",
  }));

  const result = runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "한다고 해놓고 또 안 했잖아.",
  });
  assertSucceeded(result);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(output.suppressOutput, true);
  assert.match(output.hookSpecificOutput.additionalContext, /acknowledged_recurrence/u);
  assert.match(output.hookSpecificOutput.additionalContext, /Load and follow the ai-safe-driver skill now/u);
  assert.ok(Buffer.byteLength(output.hookSpecificOutput.additionalContext, "utf8") <= 4096);
});

test("routine apology without an active correction cycle creates no state", () => {
  const root = makeStateDir("apology");
  assertNoOutput(runDriftHook(root, {
    hook_event_name: "Stop", session_id: "session-apology", last_assistant_message: "Sorry for the delay.",
  }));
  assert.deepEqual(readdirSync(root), []);
});

test("stateless explicit health checks inject but do not persist in every supported language", () => {
  const cases = [
    ["Korean", "대화 상태가 정상인지 점검해 줘"],
    ["English", "Are we drifting?"],
    ["Chinese", "对话跑偏了吗？"],
    ["Japanese", "会話がずれているか確認して"],
  ];
  for (const [language, prompt] of cases) {
    const root = makeStateDir(`health-${language}`);
    const result = runDriftHook(root, { hook_event_name: "UserPromptSubmit", prompt });
    assertSucceeded(result);
    const output = JSON.parse(result.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /explicit_health_check/u, language);
    assert.deepEqual(readdirSync(root), [], language);
  }
});

test("stateless repeated-tool diagnoses inject but do not persist in every supported language", () => {
  const cases = [
    ["Korean", "같은 툴 호출이 또 실패했어. 원인을 점검해줘."],
    ["English", "The same tool call failed again. Diagnose why."],
    ["Chinese", "分析为什么同一个工具调用又失败了。"],
    ["Japanese", "同じツール呼び出しがまたエラーになった原因を診断して。"],
  ];
  for (const [language, prompt] of cases) {
    const root = makeStateDir(`tool-${language}`);
    const result = runDriftHook(root, { hook_event_name: "UserPromptSubmit", prompt });
    assertSucceeded(result);
    const output = JSON.parse(result.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /explicit_tool_diagnosis/u, language);
    assert.deepEqual(readdirSync(root), [], language);
  }
});

test("emphasis alone emits nothing and does not create state", () => {
  const root = makeStateDir("emphasis");
  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: "session-emphasis", prompt: "THIS IS REALLY BAD!!!!!!",
  }));
  assert.deepEqual(readdirSync(root), []);
});

test("malformed and oversized input fail open with bounded diagnostics", () => {
  const root = makeStateDir("bad-input");
  assertBoundedStderr(runDriftHook(root, "{not json"));
  assertBoundedStderr(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: "session-oversized", prompt: "x".repeat(256 * 1024),
  }));
  assert.deepEqual(readdirSync(root), []);
});

test("expired state is pruned without creating a record for a neutral prompt", () => {
  const root = makeStateDir("expired");
  const expiredSession = "expired-session";
  writeFileSync(stateFile(root, expiredSession), JSON.stringify(plainState({ expiresAt: Date.now() - 1 })), { mode: 0o600 });

  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: "neutral-session", prompt: "Continue with the plan.",
  }));
  assert.equal(existsSync(stateFile(root, expiredSession)), false);
  assert.deepEqual(readdirSync(root), []);
});

test("a symlinked state file is rejected without following or replacing it", () => {
  const root = makeStateDir("symlink-file");
  const sessionId = "session-symlink";
  const victim = path.join(root, "victim.json");
  writeFileSync(victim, "do not touch", { mode: 0o600 });
  symlinkSync(victim, stateFile(root, sessionId));

  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  }));
  assert.equal(lstatSync(stateFile(root, sessionId)).isSymbolicLink(), true);
  assert.equal(readFileSync(victim, "utf8"), "do not touch");
});

test("a symlinked state root is rejected without writing through it", () => {
  const parent = makeStateDir("symlink-root");
  const actualRoot = path.join(parent, "actual");
  const linkedRoot = path.join(parent, "linked");
  mkdirSync(actualRoot, { mode: 0o700 });
  symlinkSync(actualRoot, linkedRoot);

  assertNoOutput(runDriftHook(linkedRoot, {
    hook_event_name: "UserPromptSubmit", session_id: "session-root", prompt: "안 했잖아.",
  }));
  assert.deepEqual(readdirSync(actualRoot), []);
  assert.equal(lstatSync(linkedRoot).isSymbolicLink(), true);
});

test("invalid stored schemas are rejected instead of being interpreted as correction state", () => {
  const root = makeStateDir("invalid-schema");
  const sessionId = "session-invalid";
  const file = stateFile(root, sessionId);
  writeFileSync(file, JSON.stringify({ schema: "untrusted", correctionCount: 99 }), { mode: 0o600 });

  assertNoOutput(runDriftHook(root, {
    hook_event_name: "Stop", session_id: sessionId, last_assistant_message: "You're right. I'll fix it.",
  }));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { schema: "untrusted", correctionCount: 99 });
});

test("atomic updates replace a regular state file with no temporary artifacts", () => {
  const root = makeStateDir("atomic");
  const sessionId = "session-atomic";
  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  }));
  assertNoOutput(runDriftHook(root, {
    hook_event_name: "Stop", session_id: sessionId, last_assistant_message: "맞습니다. 다시 고치겠습니다.",
  }));

  const file = stateFile(root, sessionId);
  assert.equal(lstatSync(file).isFile(), true);
  assert.equal(mode(file), 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).assistantAcknowledged, true);
  assert.deepEqual(readdirSync(root), [stateName(sessionId)]);
});

test("an active regular lock fails open while a stale regular lock is safely cleared", () => {
  const root = makeStateDir("lock");
  const sessionId = "session-lock";
  const lock = lockFile(root, sessionId);
  writeFileSync(lock, "lock", { mode: 0o600 });

  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  }));
  assert.equal(existsSync(stateFile(root, sessionId)), false);
  assert.equal(lstatSync(lock).isFile(), true);

  utimesSync(lock, new Date(0), new Date(0));
  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  }));
  assert.equal(existsSync(stateFile(root, sessionId)), true);
  assert.equal(existsSync(lock), false);
});

test("a symlink lock is never removed or followed, including when stale", () => {
  const root = makeStateDir("symlink-lock");
  const sessionId = "session-lock-symlink";
  const victim = path.join(root, "lock-victim");
  writeFileSync(victim, "do not touch", { mode: 0o600 });
  symlinkSync(victim, lockFile(root, sessionId));

  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  }));
  assert.equal(lstatSync(lockFile(root, sessionId)).isSymbolicLink(), true);
  assert.equal(readFileSync(victim, "utf8"), "do not touch");
  assert.equal(existsSync(stateFile(root, sessionId)), false);
});

test("cooldown suppresses an immediate duplicate recovery injection", () => {
  const root = makeStateDir("cooldown");
  const sessionId = "session-cooldown";
  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  }));
  assertNoOutput(runDriftHook(root, {
    hook_event_name: "Stop", session_id: sessionId, last_assistant_message: "맞습니다. 다시 고치겠습니다.",
  }));
  const first = runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "한다고 해놓고 또 안 했잖아.",
  });
  assertSucceeded(first);
  assert.notEqual(first.stdout, "");

  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "한다고 해놓고 또 안 했잖아.",
  }));
  assert.equal(readState(root, sessionId).cooldownRemaining, 1);
});

test("neutral prompts leave an existing record expiry unchanged", () => {
  const root = makeStateDir("neutral-expiry");
  const sessionId = "session-neutral";
  const original = plainState({ expiresAt: Date.now() + 50_000, lastSignalAt: 1234 });
  writeFileSync(stateFile(root, sessionId), JSON.stringify(original), { mode: 0o600 });

  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "Continue with the plan.",
  }));
  const after = readState(root, sessionId);
  assert.equal(after.expiresAt, original.expiresAt);
  assert.equal(after.lastSignalAt, original.lastSignalAt);
});

test("the state directory override is ignored without explicit test mode", () => {
  const overrideRoot = makeStateDir("override");
  const sessionId = `non-test-${process.pid}-${Date.now()}`;
  const defaultFile = stateFile(path.join(tmpdir(), "ai-safe-driver"), sessionId);
  rmSync(defaultFile, { force: true });

  const result = runWithoutTestMode(overrideRoot, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  });
  assertNoOutput(result);
  assert.equal(existsSync(stateFile(overrideRoot, sessionId)), false);
  assert.equal(existsSync(defaultFile), true);
  rmSync(defaultFile, { force: true });
});

test("unrecognized state keys are rejected and raw text never survives a state update", () => {
  const root = makeStateDir("canonical-state");
  const sessionId = "session-canonical-state";
  const secretPrompt = "private user requirement must never be persisted";
  const secretAssistant = "private assistant response must never be persisted";
  writeFileSync(stateFile(root, sessionId), JSON.stringify(plainState({
    prompt: secretPrompt,
    last_assistant_message: secretAssistant,
  })), { mode: 0o600 });

  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  }));
  const serialized = readFileSync(stateFile(root, sessionId), "utf8");
  assert.equal(serialized.includes(secretPrompt), false);
  assert.equal(serialized.includes(secretAssistant), false);
  assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), [
    "assistantAcknowledged",
    "cooldownRemaining",
    "correctionCount",
    "expiresAt",
    "lastSignalAt",
    "protestCount",
    "recoveryInjected",
    "recurrenceCount",
    "repairPromised",
    "schema",
  ]);
});

test("pruning an expired record never removes a fresh atomic replacement", async () => {
  const root = makeStateDir("prune-race");
  const barrier = makeStateDir("prune-barrier");
  const sessionId = "session-prune-race";
  const file = stateFile(root, sessionId);
  writeFileSync(file, JSON.stringify(plainState({ expiresAt: Date.now() - 1 })), { mode: 0o600 });
  const fresh = plainState({ correctionCount: 7, expiresAt: Date.now() + 60_000 });
  const hook = startDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: "unrelated-neutral", prompt: "Continue with the plan.",
  }, {
    AI_SAFE_DRIVER_TEST_BARRIER_DIR: barrier,
    AI_SAFE_DRIVER_TEST_BARRIER: "after-expired-state-read",
  });

  await waitForBarrier(hook, barrier, "after-expired-state-read");
  writeStateAtomicallyForTest(file, fresh);
  releaseBarrier(barrier, "after-expired-state-read");
  assertNoOutput(await hook.result);
  assert.deepEqual(readState(root, sessionId), fresh);
});

test("an active old lease lock is not stolen merely because its mtime is old", () => {
  const root = makeStateDir("active-old-lock");
  const sessionId = "session-active-old-lock";
  const lock = lockFile(root, sessionId);
  const liveLease = {
    owner: "another-live-hook",
    leaseExpiresAt: Date.now() + 60_000,
  };
  writeFileSync(lock, JSON.stringify(liveLease), { mode: 0o600 });
  utimesSync(lock, new Date(0), new Date(0));

  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  }));
  assert.equal(existsSync(stateFile(root, sessionId)), false);
  assert.deepEqual(JSON.parse(readFileSync(lock, "utf8")), liveLease);
});

test("lock release leaves a successor lock created after the owner releases", async () => {
  const root = makeStateDir("lock-release-race");
  const barrier = makeStateDir("lock-release-barrier");
  const sessionId = "session-lock-release-race";
  const lock = lockFile(root, sessionId);
  const successor = { owner: "successor-hook", leaseExpiresAt: Date.now() + 60_000 };
  const hook = startDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  }, {
    AI_SAFE_DRIVER_TEST_BARRIER_DIR: barrier,
    AI_SAFE_DRIVER_TEST_BARRIER: "before-lock-release",
  });

  await waitForBarrier(hook, barrier, "before-lock-release");
  rmSync(lock);
  writeFileSync(lock, JSON.stringify(successor), { mode: 0o600 });
  releaseBarrier(barrier, "before-lock-release");
  assertNoOutput(await hook.result);
  assert.deepEqual(JSON.parse(readFileSync(lock, "utf8")), successor);
});

test("a state file swapped to a symlink after validation is never read through", async () => {
  const root = makeStateDir("state-read-race");
  const barrier = makeStateDir("state-read-barrier");
  const sessionId = "session-state-read-race";
  const file = stateFile(root, sessionId);
  const victim = path.join(root, "state-read-victim.json");
  const audit = path.join(barrier, "read-followed");
  const preload = path.join(barrier, "read-audit.cjs");
  const victimState = plainState({ correctionCount: 99 });
  const victimSerialized = JSON.stringify(victimState);
  writeFileSync(file, JSON.stringify(plainState()), { mode: 0o600 });
  writeFileSync(victim, victimSerialized, { mode: 0o600 });
  writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const promises = require('node:fs/promises');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const originalReadFile = promises.readFile;",
    "promises.readFile = async (file, ...args) => {",
    "  if (file === process.env.AI_SAFE_DRIVER_TEST_AUDIT_STATE_PATH && fs.lstatSync(file).isSymbolicLink()) {",
    "    fs.writeFileSync(process.env.AI_SAFE_DRIVER_TEST_AUDIT_PATH, 'followed');",
    "  }",
    "  return originalReadFile(file, ...args);",
    "};",
    "syncBuiltinESMExports();",
  ].join("\n"));
  const hook = startDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "Continue with the plan.",
  }, {
    AI_SAFE_DRIVER_TEST_BARRIER_DIR: barrier,
    AI_SAFE_DRIVER_TEST_BARRIER: "before-state-open",
    AI_SAFE_DRIVER_TEST_AUDIT_STATE_PATH: file,
    AI_SAFE_DRIVER_TEST_AUDIT_PATH: audit,
  }, ["--require", preload]);

  await waitForBarrier(hook, barrier, "before-state-open");
  rmSync(file);
  symlinkSync(victim, file);
  releaseBarrier(barrier, "before-state-open");
  assertNoOutput(await hook.result);
  assert.equal(existsSync(audit), false);
  assert.equal(lstatSync(file).isSymbolicLink(), true);
  assert.equal(readFileSync(victim, "utf8"), victimSerialized);
});

test("two reclaimers ignore a crashed guard without deleting the current epoch successor", async () => {
  const root = makeStateDir("stale-guard-recovery");
  const firstBarrier = makeStateDir("stale-guard-first");
  const secondBarrier = makeStateDir("stale-guard-second");
  const sessionId = "session-stale-guard-recovery";
  const now = 1_000_000;
  const epochMs = 1_000;
  const epoch = now / epochMs;
  const extraEnv = {
    AI_SAFE_DRIVER_TEST_NOW_MS: String(now),
    AI_SAFE_DRIVER_TEST_RECLAIM_EPOCH_MS: String(epochMs),
  };
  const staleLock = lockFile(root, sessionId);
  writeFileSync(staleLock, JSON.stringify({
    owner: "expired-hook",
    leaseExpiresAt: now - 1,
  }), { mode: 0o600 });
  const identity = lstatSync(staleLock);
  const crashedGuard = reclaimerGuardFile(root, sessionId, identity, epoch - 3);
  writeFileSync(crashedGuard, JSON.stringify({
    owner: "crashed-reclaimer",
    leaseExpiresAt: now - 1,
    lockDev: identity.dev,
    lockIno: identity.ino,
    epoch: epoch - 3,
  }), { mode: 0o600 });
  ageHistoricalGuard(crashedGuard, now);
  const first = startDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  }, {
    ...extraEnv,
    AI_SAFE_DRIVER_TEST_BARRIER_DIR: firstBarrier,
    AI_SAFE_DRIVER_TEST_BARRIERS: "after-stale-lock-reread,before-lock-release",
  });
  await waitForBarrier(first, firstBarrier, "after-stale-lock-reread");
  const second = startDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId,
    prompt: "You said you would fix it and still did not.",
  }, {
    ...extraEnv,
    AI_SAFE_DRIVER_TEST_BARRIER_DIR: secondBarrier,
    AI_SAFE_DRIVER_TEST_BARRIERS: "after-stale-lock-reread",
  });

  await waitForBarrier(second, secondBarrier, "after-stale-lock-reread");
  releaseBarrier(firstBarrier, "after-stale-lock-reread");
  await waitForBarrier(first, firstBarrier, "before-lock-release");
  assertNoOutput(await second.result);
  assert.equal(readState(root, sessionId).correctionCount, 1);
  assert.equal(lstatSync(lockFile(root, sessionId)).isFile(), true);
  assert.equal(existsSync(crashedGuard), false);
  const successorGuard = reclaimerGuardFile(root, sessionId, identity, epoch);
  assert.equal(existsSync(successorGuard), true);
  const successor = JSON.parse(readFileSync(successorGuard, "utf8"));
  assert.notEqual(successor.owner, "expired-hook");
  assert.ok(successor.leaseExpiresAt > now);
  releaseBarrier(firstBarrier, "before-lock-release");
  assertNoOutput(await first.result);
  assert.equal(existsSync(lockFile(root, sessionId)), false);
  assert.equal(existsSync(successorGuard), false);
  assert.equal(existsSync(crashedGuard), false);
});

test("an active adjacent-epoch reclaimer guard excludes a current-epoch contender", () => {
  const root = makeStateDir("adjacent-epoch-guard");
  const sessionId = "session-adjacent-epoch-guard";
  const now = 2_000_000;
  const epochMs = 1_000;
  const epoch = now / epochMs;
  const extraEnv = {
    AI_SAFE_DRIVER_TEST_NOW_MS: String(now),
    AI_SAFE_DRIVER_TEST_RECLAIM_EPOCH_MS: String(epochMs),
  };
  const staleLock = lockFile(root, sessionId);
  writeFileSync(staleLock, JSON.stringify({
    owner: "expired-hook",
    leaseExpiresAt: now - 1,
  }), { mode: 0o600 });
  const identity = lstatSync(staleLock);
  const activePreviousEpochGuard = reclaimerGuardFile(root, sessionId, identity, epoch - 1);
  const activeGuard = {
    owner: "previous-epoch-reclaimer",
    leaseExpiresAt: now + epochMs,
    lockDev: identity.dev,
    lockIno: identity.ino,
    epoch: epoch - 1,
  };
  writeFileSync(activePreviousEpochGuard, JSON.stringify(activeGuard), { mode: 0o600 });

  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  }, extraEnv));
  assert.equal(existsSync(stateFile(root, sessionId)), false);
  assert.deepEqual(JSON.parse(readFileSync(activePreviousEpochGuard, "utf8")), activeGuard);
});

test("pruning bounds expired historical guards without deleting active foreign guards", () => {
  const root = makeStateDir("reclaimer-guard-pruning");
  const sessionId = "session-reclaimer-guard-pruning";
  const now = 3_000_000;
  const epochMs = 1_000;
  const epoch = now / epochMs;
  const extraEnv = {
    AI_SAFE_DRIVER_TEST_NOW_MS: String(now),
    AI_SAFE_DRIVER_TEST_RECLAIM_EPOCH_MS: String(epochMs),
  };
  const staleLock = lockFile(root, sessionId);
  writeFileSync(staleLock, JSON.stringify({
    owner: "expired-hook",
    leaseExpiresAt: now - 1,
  }), { mode: 0o600 });
  const identity = lstatSync(staleLock);
  const historicalGuards = Array.from({ length: 8 }, (_, index) => {
    const guardEpoch = epoch - index - 3;
    const file = reclaimerGuardFile(root, sessionId, identity, guardEpoch);
    writeFileSync(file, JSON.stringify({
      owner: `crashed-${guardEpoch}`,
      leaseExpiresAt: now - 1,
      lockDev: identity.dev,
      lockIno: identity.ino,
      epoch: guardEpoch,
    }), { mode: 0o600 });
    ageHistoricalGuard(file, now);
    return file;
  });
  const activeCurrentGuard = reclaimerGuardFile(root, sessionId, identity, epoch);
  const activeAdjacentGuard = reclaimerGuardFile(root, sessionId, identity, epoch - 1);
  const currentRecord = {
    owner: "foreign-current-epoch",
    leaseExpiresAt: now + epochMs,
    lockDev: identity.dev,
    lockIno: identity.ino,
    epoch,
  };
  const adjacentRecord = { ...currentRecord, owner: "foreign-adjacent-epoch", epoch: epoch - 1 };
  writeFileSync(activeCurrentGuard, JSON.stringify(currentRecord), { mode: 0o600 });
  writeFileSync(activeAdjacentGuard, JSON.stringify(adjacentRecord), { mode: 0o600 });

  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  }, extraEnv));
  assert.equal(existsSync(stateFile(root, sessionId)), false);
  for (const historicalGuard of historicalGuards) assert.equal(existsSync(historicalGuard), false);
  assert.deepEqual(JSON.parse(readFileSync(activeCurrentGuard, "utf8")), currentRecord);
  assert.deepEqual(JSON.parse(readFileSync(activeAdjacentGuard, "utf8")), adjacentRecord);
});

test("cleanup bounds expired guards orphaned under prior lock identities", () => {
  const root = makeStateDir("orphaned-identity-guards");
  const sessionId = "session-orphaned-identity-guards";
  const now = 4_000_000;
  const epochMs = 1_000;
  const epoch = now / epochMs;
  const extraEnv = {
    AI_SAFE_DRIVER_TEST_NOW_MS: String(now),
    AI_SAFE_DRIVER_TEST_RECLAIM_EPOCH_MS: String(epochMs),
  };
  const staleLock = lockFile(root, sessionId);
  writeFileSync(staleLock, JSON.stringify({ owner: "expired-hook", leaseExpiresAt: now - 1 }), { mode: 0o600 });
  const successorIdentity = lstatSync(staleLock);
  const orphanedGuards = Array.from({ length: 6 }, (_, index) => {
    const orphanIdentity = { dev: successorIdentity.dev + index + 1, ino: successorIdentity.ino + index + 1 };
    const guardEpoch = epoch - index - 3;
    const file = reclaimerGuardFile(root, sessionId, orphanIdentity, guardEpoch);
    writeFileSync(file, JSON.stringify({
      owner: `crashed-prior-identity-${index}`,
      leaseExpiresAt: now - 1,
      lockDev: orphanIdentity.dev,
      lockIno: orphanIdentity.ino,
      epoch: guardEpoch,
    }), { mode: 0o600 });
    ageHistoricalGuard(file, now);
    return file;
  });

  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  }, extraEnv));
  assert.equal(readState(root, sessionId).correctionCount, 1);
  for (const orphanedGuard of orphanedGuards) assert.equal(existsSync(orphanedGuard), false);
});

test("an active adjacent guard is found behind more than 128 historical or malformed entries", () => {
  const root = makeStateDir("guard-discovery-boundary");
  const sessionId = "session-guard-discovery-boundary";
  const now = 5_000_000;
  const epochMs = 1_000;
  const epoch = now / epochMs;
  const extraEnv = {
    AI_SAFE_DRIVER_TEST_NOW_MS: String(now),
    AI_SAFE_DRIVER_TEST_RECLAIM_EPOCH_MS: String(epochMs),
  };
  const staleLock = lockFile(root, sessionId);
  writeFileSync(staleLock, JSON.stringify({ owner: "expired-hook", leaseExpiresAt: now - 1 }), { mode: 0o600 });
  const identity = lstatSync(staleLock);
  const prefix = path.join(ensureReclaimerGuardDirectory(root), `${path.basename(staleLock)}.reclaim.`);
  for (let index = 0; index < 130; index += 1) {
    const historicalGuard = `${prefix}000-${String(index).padStart(3, "0")}.0`;
    writeFileSync(historicalGuard, "malformed", { mode: 0o600 });
    ageHistoricalGuard(historicalGuard, now);
  }
  const activeGuard = reclaimerGuardFile(root, sessionId, identity, epoch - 1);
  const activeRecord = {
    owner: "hidden-adjacent-reclaimer",
    leaseExpiresAt: now + epochMs,
    lockDev: identity.dev,
    lockIno: identity.ino,
    epoch: epoch - 1,
  };
  writeFileSync(activeGuard, JSON.stringify(activeRecord), { mode: 0o600 });
  assert.ok(readdirSync(reclaimerGuardDirectory(root)).indexOf(path.basename(activeGuard)) > 128);

  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아.",
  }, extraEnv));
  assert.equal(existsSync(stateFile(root, sessionId)), false);
  assert.deepEqual(JSON.parse(readFileSync(activeGuard, "utf8")), activeRecord);
});

test("cleanup progresses through malformed historical guards without touching active foreign guards", () => {
  const root = makeStateDir("malformed-guard-cleanup");
  const sessionId = "session-malformed-guard-cleanup";
  const now = 6_000_000;
  const epochMs = 1_000;
  const epoch = now / epochMs;
  const extraEnv = {
    AI_SAFE_DRIVER_TEST_NOW_MS: String(now),
    AI_SAFE_DRIVER_TEST_RECLAIM_EPOCH_MS: String(epochMs),
  };
  const staleLock = lockFile(root, sessionId);
  writeFileSync(staleLock, JSON.stringify({ owner: "expired-hook", leaseExpiresAt: now - 1 }), { mode: 0o600 });
  const identity = lstatSync(staleLock);
  const historicalGuards = Array.from({ length: 150 }, (_, index) => {
    const guardEpoch = epoch - index - 3;
    const file = reclaimerGuardFile(root, sessionId, identity, guardEpoch);
    const kind = index % 3;
    const content = kind === 0
      ? "{partial"
      : kind === 1
        ? JSON.stringify({ owner: `partial-${index}` })
        : JSON.stringify({
          owner: `inconsistent-${index}`,
          leaseExpiresAt: now - 1,
          lockDev: identity.dev + 1,
          lockIno: identity.ino + 1,
          epoch: guardEpoch - 1,
        });
    writeFileSync(file, content, { mode: 0o600 });
    ageHistoricalGuard(file, now);
    return file;
  });
  const activeCurrentGuard = reclaimerGuardFile(root, sessionId, identity, epoch);
  const activeAdjacentGuard = reclaimerGuardFile(root, sessionId, identity, epoch - 1);
  const currentRecord = {
    owner: "foreign-current-epoch",
    leaseExpiresAt: now + epochMs,
    lockDev: identity.dev,
    lockIno: identity.ino,
    epoch,
  };
  const adjacentRecord = { ...currentRecord, owner: "foreign-adjacent-epoch", epoch: epoch - 1 };
  writeFileSync(activeCurrentGuard, JSON.stringify(currentRecord), { mode: 0o600 });
  writeFileSync(activeAdjacentGuard, JSON.stringify(adjacentRecord), { mode: 0o600 });
  const input = { hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아." };

  assertNoOutput(runDriftHook(root, input, extraEnv));
  const remainingAfterFirstRun = historicalGuards.filter((file) => existsSync(file));
  assert.ok(remainingAfterFirstRun.length < historicalGuards.length);
  assertNoOutput(runDriftHook(root, input, extraEnv));
  assertNoOutput(runDriftHook(root, input, extraEnv));
  for (const historicalGuard of historicalGuards) assert.equal(existsSync(historicalGuard), false);
  assert.equal(existsSync(stateFile(root, sessionId)), false);
  assert.deepEqual(JSON.parse(readFileSync(activeCurrentGuard, "utf8")), currentRecord);
  assert.deepEqual(JSON.parse(readFileSync(activeAdjacentGuard, "utf8")), adjacentRecord);
});

test("a delayed epoch-selected reclaimer aborts without overlapping the current reclaimer", async () => {
  const root = makeStateDir("delayed-reclaimer-epoch");
  const firstBarrier = makeStateDir("delayed-reclaimer-first");
  const secondBarrier = makeStateDir("delayed-reclaimer-second");
  const sessionId = "session-delayed-reclaimer-epoch";
  const epochMs = 250;
  const staleLock = lockFile(root, sessionId);
  writeFileSync(staleLock, JSON.stringify({ owner: "expired-hook", leaseExpiresAt: Date.now() - 1 }), { mode: 0o600 });
  const input = { hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아." };
  const first = startDriftHook(root, input, {
    AI_SAFE_DRIVER_TEST_RECLAIM_EPOCH_MS: String(epochMs),
    AI_SAFE_DRIVER_TEST_BARRIER_DIR: firstBarrier,
    AI_SAFE_DRIVER_TEST_BARRIER: "after-reclaimer-epoch-selection",
  });

  await waitForBarrier(first, firstBarrier, "after-reclaimer-epoch-selection");
  await wait(epochMs * 5);
  while (Date.now() % epochMs > epochMs / 3) await wait(5);
  const second = startDriftHook(root, input, {
    AI_SAFE_DRIVER_TEST_RECLAIM_EPOCH_MS: String(epochMs),
    AI_SAFE_DRIVER_TEST_BARRIER_DIR: secondBarrier,
    AI_SAFE_DRIVER_TEST_BARRIER: "before-lock-release",
  });
  await waitForBarrier(second, secondBarrier, "before-lock-release");
  releaseBarrier(firstBarrier, "after-reclaimer-epoch-selection");

  assertNoOutput(await first.result);
  assert.equal(readState(root, sessionId).correctionCount, 1);
  assert.equal(lstatSync(lockFile(root, sessionId)).isFile(), true);
  assert.equal(mode(reclaimerGuardDirectory(root)), 0o700);
  assert.equal(readdirSync(reclaimerGuardDirectory(root)).length, 1);
  releaseBarrier(secondBarrier, "before-lock-release");
  assertNoOutput(await second.result);
  assert.equal(readState(root, sessionId).correctionCount, 1);
  assert.deepEqual(readdirSync(reclaimerGuardDirectory(root)), []);
});

test("historical guard cleanup streams a private directory without materializing the state root", async () => {
  const root = makeStateDir("guard-directory-streaming");
  const barrier = makeStateDir("guard-directory-audit");
  const guardDirectory = reclaimerGuardDirectory(root);
  const sessionId = "session-guard-directory-streaming";
  const now = 7_000_000;
  const epochMs = 1_000;
  const epoch = now / epochMs;
  const extraEnv = {
    AI_SAFE_DRIVER_TEST_NOW_MS: String(now),
    AI_SAFE_DRIVER_TEST_RECLAIM_EPOCH_MS: String(epochMs),
  };
  const staleLock = lockFile(root, sessionId);
  writeFileSync(staleLock, JSON.stringify({ owner: "expired-hook", leaseExpiresAt: now - 1 }), { mode: 0o600 });
  const identity = lstatSync(staleLock);
  for (let index = 0; index < 1_024; index += 1) {
    writeFileSync(path.join(root, `ordinary-root-entry-${String(index).padStart(4, "0")}.tmp`), "ordinary", { mode: 0o600 });
  }
  ensureReclaimerGuardDirectory(root);
  const historicalGuards = Array.from({ length: 150 }, (_, index) => {
    const file = path.join(guardDirectory, path.basename(reclaimerGuardFile(root, sessionId, identity, epoch - index - 3)));
    writeFileSync(file, index % 2 === 0 ? "{partial" : JSON.stringify({ owner: `partial-${index}` }), { mode: 0o600 });
    ageHistoricalGuard(file, now);
    return file;
  });
  const activeGuard = path.join(guardDirectory, path.basename(reclaimerGuardFile(root, sessionId, identity, epoch)));
  const activeRecord = {
    owner: "foreign-current-epoch",
    leaseExpiresAt: now + epochMs,
    lockDev: identity.dev,
    lockIno: identity.ino,
    epoch,
  };
  writeFileSync(activeGuard, JSON.stringify(activeRecord), { mode: 0o600 });
  const audit = path.join(barrier, "cleanup-read-root");
  const preload = path.join(barrier, "cleanup-read-audit.cjs");
  writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const promises = require('node:fs/promises');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const originalReaddir = promises.readdir;",
    "promises.readdir = async (file, ...args) => {",
    "  if (file === process.env.AI_SAFE_DRIVER_TEST_AUDIT_ROOT && new Error().stack.includes('cleanupHistoricalReclaimerGuards')) {",
    "    fs.writeFileSync(process.env.AI_SAFE_DRIVER_TEST_AUDIT_PATH, 'root materialized');",
    "  }",
    "  return originalReaddir(file, ...args);",
    "};",
    "syncBuiltinESMExports();",
  ].join("\n"));
  const input = { hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "안 했잖아." };
  const auditEnv = {
    ...extraEnv,
    AI_SAFE_DRIVER_TEST_AUDIT_ROOT: root,
    AI_SAFE_DRIVER_TEST_AUDIT_PATH: audit,
  };

  assertNoOutput(await startDriftHook(root, input, auditEnv, ["--require", preload]).result);
  const remainingAfterFirstRun = historicalGuards.filter((file) => existsSync(file));
  assert.ok(remainingAfterFirstRun.length < historicalGuards.length);
  assertNoOutput(await startDriftHook(root, input, auditEnv, ["--require", preload]).result);
  assertNoOutput(await startDriftHook(root, input, auditEnv, ["--require", preload]).result);
  for (const historicalGuard of historicalGuards) assert.equal(existsSync(historicalGuard), false);
  assert.equal(existsSync(audit), false);
  assert.equal(existsSync(stateFile(root, sessionId)), false);
  assert.deepEqual(JSON.parse(readFileSync(activeGuard, "utf8")), activeRecord);
});

test("a malformed state for one session cannot suppress another session's recovery cycle", () => {
  const root = makeStateDir("corrupt-session-isolation");
  const corruptSession = "session-corrupt";
  const healthySession = "session-healthy";
  writeFileSync(stateFile(root, corruptSession), "{corrupt json", { mode: 0o600 });

  assertNoOutput(runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: healthySession, prompt: "안 했잖아.",
  }));
  assert.equal(readState(root, healthySession).correctionCount, 1);
  assertNoOutput(runDriftHook(root, {
    hook_event_name: "Stop", session_id: healthySession,
    last_assistant_message: "맞습니다. 죄송합니다. 다시 고치겠습니다.",
  }));
  const recurrence = runDriftHook(root, {
    hook_event_name: "UserPromptSubmit", session_id: healthySession, prompt: "한다고 해놓고 또 안 했잖아.",
  });
  assertSucceeded(recurrence);
  assert.equal(JSON.parse(recurrence.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(readState(root, healthySession).recoveryInjected, true);
});
