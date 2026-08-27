import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HostAdapterBlockedError,
  runHostProcess,
  sanitizedHostEnvironment,
} from "./host-process.mjs";

const repositoryRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const localPluginDirectory = realpathSync(path.join(repositoryRoot, "plugins", "ai-safe-driver"));
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 128 * 1024;
const UNSUPPORTED_PROVIDER_VARIABLES = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
];
const REQUIRED_RESULT_KEYS = [
  "type",
  "subtype",
  "is_error",
  "duration_ms",
  "duration_api_ms",
  "num_turns",
  "result",
  "session_id",
  "total_cost_usd",
  "usage",
];
const OPTIONAL_RESULT_KEYS = new Set([
  "stop_reason",
  "structured_output",
  "modelUsage",
  "permission_denials",
  "permission_denials_count",
  "uuid",
  "ttft_ms",
  "terminal_reason",
  "fast_mode_state",
]);

function assertMode(mode) {
  if (mode !== "baseline" && mode !== "skill") throw new Error("host adapter mode is invalid");
}

function assertAbsoluteDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  try {
    if (lstatSync(value).isSymbolicLink() || !statSync(value).isDirectory()) throw new Error("invalid");
    return realpathSync(value);
  } catch {
    throw new Error(`${label} must be an existing directory`);
  }
}

function physicalDirectoryIfPresent(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  try {
    return statSync(value).isDirectory() ? realpathSync(value) : null;
  } catch {
    return null;
  }
}

function assertFreshEmptyProfile(directory) {
  if (readdirSync(directory).length !== 0) {
    throw new HostAdapterBlockedError("Claude host run is BLOCKED because a disposable profile is not fresh and empty");
  }
}

function assertExecutable(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("host executable is invalid");
  if (value.includes(path.sep) && !path.isAbsolute(value)) throw new Error("host executable path must be absolute");
  if (path.isAbsolute(value)) {
    try {
      if (!statSync(value).isFile()) throw new Error("invalid");
    } catch {
      throw new Error("host executable path is invalid");
    }
  }
}

function promptFor({ caseId, locale, mode, turns }) {
  assertMode(mode);
  if (typeof caseId !== "string" || !/^[a-z0-9-]{1,80}$/u.test(caseId)
    || !["en", "ko", "zh", "ja"].includes(locale)
    || !Array.isArray(turns) || turns.length < 1 || turns.length > 32
    || !turns.every(({ role, content }) => (role === "user" || role === "assistant")
      && typeof content === "string" && content.length > 0)) {
    throw new Error("host adapter request is invalid");
  }
  const prompt = turns.length === 1 && turns[0].role === "user"
    ? turns[0].content
    : JSON.stringify(turns);
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new Error("host adapter request exceeds the input limit");
  return prompt;
}

export function buildClaudeCommand({
  executable = "claude",
  mode,
  pluginDir = localPluginDirectory,
  baselineConfigDir,
  skillConfigDir,
  baselineAcknowledgement,
  skillAcknowledgement,
  normalConfigDir,
}) {
  assertMode(mode);
  assertExecutable(executable);
  const baseline = assertAbsoluteDirectory(baselineConfigDir, "Claude baseline config directory");
  const skill = assertAbsoluteDirectory(skillConfigDir, "Claude skill config directory");
  if (baselineAcknowledgement !== "1" || skillAcknowledgement !== "1") {
    throw new HostAdapterBlockedError("Claude host run is BLOCKED until both disposable profiles are acknowledged as isolated");
  }
  if (baseline === skill) {
    throw new HostAdapterBlockedError("Claude baseline and skill config directories must be physically distinct");
  }
  const normalDirectories = [
    physicalDirectoryIfPresent(normalConfigDir),
    physicalDirectoryIfPresent(path.join(homedir(), ".claude")),
  ].filter(Boolean);
  if (normalDirectories.includes(baseline) || normalDirectories.includes(skill)) {
    throw new HostAdapterBlockedError("Claude adapter refuses a normal config directory");
  }
  assertFreshEmptyProfile(baseline);
  assertFreshEmptyProfile(skill);
  const args = ["--bare", "-p", "--no-session-persistence", "--output-format", "json"];
  if (mode === "skill") {
    const absolutePluginDirectory = assertAbsoluteDirectory(pluginDir, "Claude plugin directory");
    if (absolutePluginDirectory !== localPluginDirectory) {
      throw new Error("Claude skill mode requires the canonical plugin directory");
    }
    args.push("--plugin-dir", absolutePluginDirectory);
  }
  return { executable, args, configDir: mode === "baseline" ? baseline : skill };
}

export function parseClaudeOutput(output) {
  let record;
  try {
    record = JSON.parse(output);
  } catch {
    throw new Error("Claude host returned malformed JSON");
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Claude host returned an unexpected result record");
  }
  const keys = Object.keys(record);
  if (REQUIRED_RESULT_KEYS.some((key) => !keys.includes(key))
    || keys.some((key) => !REQUIRED_RESULT_KEYS.includes(key) && !OPTIONAL_RESULT_KEYS.has(key))) {
    throw new Error("Claude host returned an unexpected result record");
  }
  if (record.type !== "result" || typeof record.subtype !== "string" || typeof record.is_error !== "boolean") {
    throw new Error("Claude host returned an unexpected result record");
  }
  if (record.subtype !== "success" || record.is_error === true) throw new Error("Claude host reported a failed result");
  const finiteNonnegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!finiteNonnegative(record.duration_ms) || !finiteNonnegative(record.duration_api_ms)
    || !Number.isSafeInteger(record.num_turns) || record.num_turns < 0
    || typeof record.result !== "string"
    || typeof record.session_id !== "string" || record.session_id.length < 1 || record.session_id.length > 128
    || !(record.total_cost_usd === null || finiteNonnegative(record.total_cost_usd))
    || record.usage === null || typeof record.usage !== "object" || Array.isArray(record.usage)
    || ("ttft_ms" in record && !finiteNonnegative(record.ttft_ms))
    || ("stop_reason" in record && record.stop_reason !== null && typeof record.stop_reason !== "string")
    || ("modelUsage" in record && (record.modelUsage === null || typeof record.modelUsage !== "object" || Array.isArray(record.modelUsage)))
    || ("permission_denials" in record && !Array.isArray(record.permission_denials))
    || ("permission_denials_count" in record && (!Number.isSafeInteger(record.permission_denials_count) || record.permission_denials_count < 0))
    || ("uuid" in record && typeof record.uuid !== "string")
    || ("terminal_reason" in record && typeof record.terminal_reason !== "string")
    || ("fast_mode_state" in record && typeof record.fast_mode_state !== "string")) {
    throw new Error("Claude host returned an unexpected result record");
  }
  return { response: record.result, events: [] };
}

export async function run(request) {
  const prompt = promptFor(request);
  if (UNSUPPORTED_PROVIDER_VARIABLES.some((name) => typeof process.env[name] === "string" && process.env[name].length > 0)) {
    throw new HostAdapterBlockedError("Claude host run is BLOCKED because the configured provider is outside the adapter allowlist");
  }
  if (typeof process.env.ANTHROPIC_API_KEY !== "string" || process.env.ANTHROPIC_API_KEY.length === 0) {
    throw new HostAdapterBlockedError("Claude host run is BLOCKED because direct non-persistent authentication is unavailable");
  }
  const command = buildClaudeCommand({
    executable: process.env.AI_SAFE_DRIVER_CLAUDE_EXECUTABLE || "claude",
    mode: request.mode,
    baselineConfigDir: process.env.AI_SAFE_DRIVER_CLAUDE_BASELINE_CONFIG_DIR,
    skillConfigDir: process.env.AI_SAFE_DRIVER_CLAUDE_SKILL_CONFIG_DIR,
    baselineAcknowledgement: process.env.AI_SAFE_DRIVER_CLAUDE_BASELINE_CONFIG_ISOLATED,
    skillAcknowledgement: process.env.AI_SAFE_DRIVER_CLAUDE_SKILL_CONFIG_ISOLATED,
    normalConfigDir: process.env.CLAUDE_CONFIG_DIR,
  });
  const env = {
    ...sanitizedHostEnvironment(process.env, ["ANTHROPIC_API_KEY"]),
    HOME: command.configDir,
    CLAUDE_CONFIG_DIR: command.configDir,
  };
  const { stdout } = await runHostProcess({
    executable: command.executable,
    args: command.args,
    input: prompt,
    env,
    timeoutMs: TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  return parseClaudeOutput(stdout);
}
