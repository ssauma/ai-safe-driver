import { lstatSync, mkdirSync, mkdtempSync, realpathSync, statSync } from "node:fs";
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
  "uuid",
  "session_id",
  "is_error",
  "duration_ms",
  "duration_api_ms",
  "num_turns",
  "result",
  "stop_reason",
  "total_cost_usd",
  "usage",
  "modelUsage",
  "permission_denials",
];
const SERVICE_TIERS = new Set(["standard", "priority", "batch"]);
const SPEEDS = new Set(["standard", "fast"]);
const ITERATION_TYPES_WITH_MODEL = new Set(["message", "advisor_message", "fallback_message"]);
const FALLBACK_REASONS = new Set([
  "body_mismatch",
  "continuation_excluded",
  "continuation_only",
  "expired",
  "invalid_target_model",
  "not_enabled",
  "reprice_unavailable",
  "temporarily_unavailable",
  "variant_fields_present",
  "wrong_organization",
  "wrong_platform",
  "wrong_workspace",
]);
const TERMINAL_REASONS = new Set([
  "blocking_limit",
  "rapid_refill_breaker",
  "prompt_too_long",
  "image_error",
  "model_error",
  "api_error",
  "malformed_tool_use_exhausted",
  "aborted_streaming",
  "aborted_tools",
  "stop_hook_prevented",
  "hook_stopped",
  "tool_deferred",
  "max_turns",
  "background_requested",
  "completed",
  "budget_exhausted",
  "structured_output_retry_exhausted",
  "tool_deferred_unavailable",
  "turn_setup_failed",
]);
const FAST_MODE_STATES = new Set(["off", "cooldown", "on"]);
const FAST_MODE_DISABLED_REASONS = new Set([
  "free",
  "preference",
  "extra_usage_disabled",
  "network_error",
  "unknown",
  "not_first_party",
  "disabled_by_env",
  "model_not_allowed",
  "sdk_opt_in_required",
  "pending",
]);
const COST_BASES = new Set(["list", "managed", "unknown"]);

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

function physicalDirectoryIfPresent(value, hostCwd) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const candidate = path.isAbsolute(value) ? value : path.resolve(hostCwd, value);
    return statSync(candidate).isDirectory() ? realpathSync(candidate) : null;
  } catch {
    return null;
  }
}

function pathsOverlap(first, second) {
  return first === second || first.startsWith(`${second}${path.sep}`) || second.startsWith(`${first}${path.sep}`);
}

function createAttempt(runtimeRoot) {
  try {
    const attemptRoot = mkdtempSync(path.join(runtimeRoot, "attempt-"));
    const home = path.join(attemptRoot, "home");
    const configDir = path.join(attemptRoot, "claude-config");
    const pluginData = path.join(attemptRoot, "plugin-data");
    const workingDirectory = path.join(attemptRoot, "workspace");
    for (const directory of [home, configDir, pluginData, workingDirectory]) mkdirSync(directory);
    return { home, configDir, pluginData, workingDirectory };
  } catch {
    throw new HostAdapterBlockedError("Claude host run is BLOCKED because a fresh disposable attempt could not be created");
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
  baselineRuntimeRoot,
  skillRuntimeRoot,
  baselineAcknowledgement,
  skillAcknowledgement,
  normalConfigDir,
  hostCwd = process.cwd(),
}) {
  assertMode(mode);
  assertExecutable(executable);
  const baseline = assertAbsoluteDirectory(baselineRuntimeRoot, "Claude baseline runtime root");
  const skill = assertAbsoluteDirectory(skillRuntimeRoot, "Claude skill runtime root");
  if (baselineAcknowledgement !== "1" || skillAcknowledgement !== "1") {
    throw new HostAdapterBlockedError("Claude host run is BLOCKED until both disposable runtime roots are acknowledged as isolated");
  }
  if (pathsOverlap(baseline, skill)) {
    throw new HostAdapterBlockedError("Claude baseline and skill runtime roots must be physically distinct");
  }
  const normalDirectories = [
    physicalDirectoryIfPresent(normalConfigDir, hostCwd),
    physicalDirectoryIfPresent(path.join(homedir(), ".claude"), hostCwd),
  ].filter(Boolean);
  if (normalDirectories.some((normal) => pathsOverlap(normal, baseline) || pathsOverlap(normal, skill))) {
    throw new HostAdapterBlockedError("Claude adapter refuses a normal config directory or its descendants");
  }
  const args = ["-p", "--no-session-persistence", "--output-format", "json"];
  if (mode === "skill") {
    const absolutePluginDirectory = assertAbsoluteDirectory(pluginDir, "Claude plugin directory");
    if (absolutePluginDirectory !== localPluginDirectory) {
      throw new Error("Claude skill mode requires the canonical plugin directory");
    }
    args.push("--plugin-dir", absolutePluginDirectory);
  }
  return { executable, args, ...createAttempt(mode === "baseline" ? baseline : skill) };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasKeys(record, keys) {
  return keys.every((key) => Object.hasOwn(record, key));
}

function validOptional(record, key, validator) {
  return !Object.hasOwn(record, key) || validator(record[key]);
}

function validCacheCreation(cacheCreation, nullable = false) {
  if (cacheCreation === null) return nullable;
  return isObject(cacheCreation)
    && hasKeys(cacheCreation, ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"])
    && nonnegativeInteger(cacheCreation.ephemeral_5m_input_tokens)
    && nonnegativeInteger(cacheCreation.ephemeral_1h_input_tokens);
}

function validFallbackCredit(fallbackCredit) {
  if (!isObject(fallbackCredit) || !isObject(fallbackCredit.status)) return false;
  if (fallbackCredit.status.type === "redeemed") return true;
  return fallbackCredit.status.type === "not_applied"
    && FALLBACK_REASONS.has(fallbackCredit.status.reason)
    && validOptional(fallbackCredit.status, "remove_to_redeem", (value) => (
      value === null || (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    ));
}

function validUsageIteration(iteration) {
  const integerFields = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ];
  if (!isObject(iteration)
    || !hasKeys(iteration, [...integerFields, "cache_creation", "type"])
    || integerFields.some((key) => !nonnegativeInteger(iteration[key]))
    || !validCacheCreation(iteration.cache_creation, true)) return false;
  if (iteration.type === "compaction") return true;
  return ITERATION_TYPES_WITH_MODEL.has(iteration.type) && typeof iteration.model === "string";
}

function validUsage(usage) {
  const integerFields = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ];
  if (!isObject(usage) || !hasKeys(usage, [
    ...integerFields,
    "cache_creation",
    "fallback_credit",
    "output_tokens_details",
    "server_tool_use",
    "service_tier",
    "speed",
    "inference_geo",
    "iterations",
  ]) || integerFields.some((key) => !nonnegativeInteger(usage[key]))) return false;
  if (!validCacheCreation(usage.cache_creation)
    || !validFallbackCredit(usage.fallback_credit)
    || !isObject(usage.output_tokens_details)
    || !hasKeys(usage.output_tokens_details, ["thinking_tokens"])
    || !nonnegativeInteger(usage.output_tokens_details.thinking_tokens)) return false;
  if (!isObject(usage.server_tool_use)
    || !hasKeys(usage.server_tool_use, ["web_search_requests", "web_fetch_requests"])
    || !nonnegativeInteger(usage.server_tool_use.web_search_requests)
    || !nonnegativeInteger(usage.server_tool_use.web_fetch_requests)) return false;
  return SERVICE_TIERS.has(usage.service_tier)
    && SPEEDS.has(usage.speed)
    && typeof usage.inference_geo === "string"
    && Array.isArray(usage.iterations)
    && usage.iterations.every(validUsageIteration);
}

function validModelUsage(modelUsage) {
  if (!isObject(modelUsage)) return false;
  const integerFields = [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "webSearchRequests",
    "contextWindow",
    "maxOutputTokens",
  ];
  return Object.values(modelUsage).every((usage) => (
    isObject(usage)
    && hasKeys(usage, [...integerFields, "costUSD"])
    && integerFields.every((key) => nonnegativeInteger(usage[key]))
    && finiteNonnegative(usage.costUSD)
    && validOptional(usage, "canonicalModel", (value) => typeof value === "string")
    && validOptional(usage, "provider", (value) => typeof value === "string")
    && validOptional(usage, "costBasis", (value) => COST_BASES.has(value))
  ));
}

function validPermissionDenials(permissionDenials) {
  return Array.isArray(permissionDenials) && permissionDenials.every((denial) => (
    isObject(denial)
    && typeof denial.tool_name === "string" && denial.tool_name.length > 0 && denial.tool_name.length <= 128
    && typeof denial.tool_use_id === "string" && denial.tool_use_id.length > 0 && denial.tool_use_id.length <= 128
    && isObject(denial.tool_input)
  ));
}

function validDeferredToolUse(value) {
  return isObject(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && isObject(value.input);
}

function validOrigin(origin) {
  if (!isObject(origin) || typeof origin.kind !== "string") return false;
  switch (origin.kind) {
    case "human":
    case "coordinator":
    case "unclassified":
    case "auto-continuation":
    case "observer-activity":
      return true;
    case "channel":
      return typeof origin.server === "string";
    case "peer":
      return typeof origin.from === "string"
        && validOptional(origin, "fromMode", (value) => value === "bypass" || value === "prompting")
        && ["name", "fromSession", "senderTaskId", "body"].every((key) => (
          validOptional(origin, key, (value) => typeof value === "string")
        ))
        && validOptional(origin, "verifiedPeerPid", (value) => nonnegativeInteger(value));
    case "task-notification":
      return validOptional(origin, "subkind", (value) => (
        value === "scheduled-trigger" || value === "peer-send-message" || value === "projects-relay"
      ));
    case "observer":
      return typeof origin.from === "string" && typeof origin.senderTaskId === "string";
    default:
      return false;
  }
}

function validClaudeSuccess(record) {
  return hasKeys(record, REQUIRED_RESULT_KEYS)
    && record.type === "result"
    && record.subtype === "success"
    && typeof record.is_error === "boolean"
    && finiteNonnegative(record.duration_ms)
    && finiteNonnegative(record.duration_api_ms)
    && nonnegativeInteger(record.num_turns)
    && typeof record.result === "string"
    && typeof record.uuid === "string" && record.uuid.length >= 1 && record.uuid.length <= 128
    && typeof record.session_id === "string" && record.session_id.length >= 1 && record.session_id.length <= 128
    && (record.stop_reason === null || typeof record.stop_reason === "string")
    && finiteNonnegative(record.total_cost_usd)
    && validUsage(record.usage)
    && validModelUsage(record.modelUsage)
    && validPermissionDenials(record.permission_denials)
    && validOptional(record, "ttft_ms", finiteNonnegative)
    && validOptional(record, "ttft_stream_ms", finiteNonnegative)
    && validOptional(record, "time_to_request_ms", finiteNonnegative)
    && validOptional(record, "user_message_uuid", (value) => (
      typeof value === "string" && value.length >= 1 && value.length <= 128
    ))
    && validOptional(record, "request_sent_wall_ms", finiteNonnegative)
    && validOptional(record, "time_to_request_from_spawn_ms", finiteNonnegative)
    && validOptional(record, "warm_spare_claimed", (value) => typeof value === "boolean")
    && validOptional(record, "time_origin_ms", finiteNonnegative)
    && validOptional(record, "api_error_status", (value) => value === null || nonnegativeInteger(value))
    && validOptional(record, "queued_turn_count", nonnegativeInteger)
    && validOptional(record, "deferred_tool_use", validDeferredToolUse)
    && validOptional(record, "terminal_reason", (value) => TERMINAL_REASONS.has(value))
    && validOptional(record, "fast_mode_state", (value) => FAST_MODE_STATES.has(value))
    && validOptional(record, "fast_mode_disabled_reason", (value) => FAST_MODE_DISABLED_REASONS.has(value))
    && validOptional(record, "origin", validOrigin);
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
  if (!validClaudeSuccess(record)) {
    throw new Error("Claude host returned an unexpected result record");
  }
  if (record.is_error || record.api_error_status !== undefined && record.api_error_status !== null) {
    throw new Error("Claude host reported a failed result");
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
    baselineRuntimeRoot: process.env.AI_SAFE_DRIVER_CLAUDE_BASELINE_RUNTIME_ROOT,
    skillRuntimeRoot: process.env.AI_SAFE_DRIVER_CLAUDE_SKILL_RUNTIME_ROOT,
    baselineAcknowledgement: process.env.AI_SAFE_DRIVER_CLAUDE_BASELINE_RUNTIME_ROOT_ISOLATED,
    skillAcknowledgement: process.env.AI_SAFE_DRIVER_CLAUDE_SKILL_RUNTIME_ROOT_ISOLATED,
    normalConfigDir: process.env.CLAUDE_CONFIG_DIR,
    hostCwd: process.cwd(),
  });
  const env = {
    ...sanitizedHostEnvironment(process.env, ["ANTHROPIC_API_KEY"]),
    HOME: command.home,
    CLAUDE_CONFIG_DIR: command.configDir,
    PLUGIN_DATA: command.pluginData,
    CLAUDE_PLUGIN_DATA: command.pluginData,
  };
  const { stdout } = await runHostProcess({
    executable: command.executable,
    args: command.args,
    input: request.mode === "skill" ? `/ai-safe-driver:ai-safe-driver ${prompt}` : prompt,
    env,
    cwd: command.workingDirectory,
    timeoutMs: TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  return parseClaudeOutput(stdout);
}
