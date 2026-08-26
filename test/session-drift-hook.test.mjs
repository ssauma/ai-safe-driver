import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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

const runDriftHook = (stateDir, input) => spawnSync(
  process.execPath,
  [hookScript],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      AI_SAFE_DRIVER_TEST_MODE: "1",
      AI_SAFE_DRIVER_STATE_DIR: stateDir,
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
