import { homedir } from "node:os";
import { cpSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HostAdapterBlockedError,
  runHostProcess,
  sanitizedHostEnvironment,
} from "./host-process.mjs";

const localRepositoryRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_RECORDS = 64;

const RECORD_EVENTS = new Map([
  ["thread.started", "harness.codex_thread_started"],
  ["turn.started", "harness.codex_turn_started"],
  ["turn.completed", "harness.codex_turn_completed"],
]);
const ITEM_EVENTS = new Map([
  ["agent_message", "harness.codex_agent_message"],
  ["reasoning", "harness.codex_reasoning"],
  ["command_execution", "tool.codex_command_execution"],
  ["file_change", "tool.codex_file_change"],
  ["mcp_tool_call", "tool.codex_mcp_call"],
  ["web_search", "tool.codex_web_search"],
  ["todo_list", "harness.codex_todo_list"],
  ["collab_tool_call", "tool.codex_collab_call"],
  ["error", "harness.codex_item_error"],
]);
const TERMINAL_ONLY_ITEM_TYPES = new Set(["agent_message", "reasoning", "file_change", "error"]);
const UNSUPPORTED_PROVIDER_VARIABLES = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
];

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

function assertFreshEmptyBaseline(directory) {
  if (readdirSync(directory).length !== 0) {
    throw new HostAdapterBlockedError("Codex host run is BLOCKED because the baseline profile is not fresh and empty");
  }
}

function exactEntries(directory, expected) {
  const actual = readdirSync(directory).sort();
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

function assertRegularDirectory(directory) {
  return !lstatSync(directory).isSymbolicLink() && statSync(directory).isDirectory();
}

function parseExpectedSkillConfig(config) {
  const expectedKeys = new Map([
    ["marketplaces.ai-safe-driver", new Set(["source_type", "source"])],
    ['plugins."ai-safe-driver@ai-safe-driver"', new Set(["enabled"])],
  ]);
  const values = new Map();
  let section;
  for (const rawLine of config.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/u);
    if (sectionMatch !== null) {
      section = sectionMatch[1];
      if (!expectedKeys.has(section) || values.has(section)) throw new Error("unexpected");
      values.set(section, new Map());
      continue;
    }
    const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/u);
    if (section === undefined || assignment === null || !expectedKeys.get(section).has(assignment[1])) {
      throw new Error("unexpected");
    }
    const sectionValues = values.get(section);
    if (sectionValues.has(assignment[1])) throw new Error("unexpected");
    sectionValues.set(assignment[1], assignment[2]);
  }
  for (const [name, keys] of expectedKeys) {
    const sectionValues = values.get(name);
    if (sectionValues === undefined || sectionValues.size !== keys.size
      || [...keys].some((key) => !sectionValues.has(key))) {
      throw new Error("unexpected");
    }
  }
  let source;
  try {
    source = JSON.parse(values.get("marketplaces.ai-safe-driver").get("source"));
  } catch {
    throw new Error("unexpected");
  }
  if (values.get("marketplaces.ai-safe-driver").get("source_type") !== '"local"'
    || values.get('plugins."ai-safe-driver@ai-safe-driver"').get("enabled") !== "true"
    || typeof source !== "string" || realpathSync(source) !== localRepositoryRoot) {
    throw new Error("unexpected");
  }
}

function assertCanonicalPluginMirror(canonicalDirectory, installedDirectory, counter = { entries: 0 }) {
  if (!assertRegularDirectory(canonicalDirectory) || !assertRegularDirectory(installedDirectory)) {
    throw new Error("unexpected");
  }
  const entries = readdirSync(canonicalDirectory).sort();
  if (!exactEntries(installedDirectory, entries)) throw new Error("unexpected");
  for (const entry of entries) {
    counter.entries += 1;
    if (counter.entries > 256) throw new Error("unexpected");
    const canonicalPath = path.join(canonicalDirectory, entry);
    const installedPath = path.join(installedDirectory, entry);
    const canonicalStat = lstatSync(canonicalPath);
    const installedStat = lstatSync(installedPath);
    if (canonicalStat.isSymbolicLink() || installedStat.isSymbolicLink()) throw new Error("unexpected");
    if (canonicalStat.isDirectory() && installedStat.isDirectory()) {
      assertCanonicalPluginMirror(canonicalPath, installedPath, counter);
    } else if (canonicalStat.isFile() && installedStat.isFile()
      && canonicalStat.size <= 2 * 1024 * 1024 && canonicalStat.size === installedStat.size
      && readFileSync(canonicalPath).equals(readFileSync(installedPath))) {
      continue;
    } else {
      throw new Error("unexpected");
    }
  }
}

function assertExpectedSkillProfile(directory) {
  try {
    const rootEntries = readdirSync(directory).sort();
    if (!rootEntries.includes("config.toml") || !rootEntries.includes("plugins")
      || rootEntries.some((entry) => ![".tmp", "config.toml", "plugins"].includes(entry))) {
      throw new Error("unexpected");
    }
    const configPath = path.join(directory, "config.toml");
    if (lstatSync(configPath).isSymbolicLink() || !statSync(configPath).isFile() || statSync(configPath).size > 64 * 1024) {
      throw new Error("unexpected");
    }
    const config = readFileSync(configPath, "utf8");
    parseExpectedSkillConfig(config);

    const pluginsRoot = path.join(directory, "plugins");
    const cacheRoot = path.join(pluginsRoot, "cache");
    const marketplaceRoot = path.join(cacheRoot, "ai-safe-driver");
    const pluginRoot = path.join(marketplaceRoot, "ai-safe-driver");
    if (!assertRegularDirectory(pluginsRoot) || !exactEntries(pluginsRoot, ["cache"])
      || !assertRegularDirectory(cacheRoot) || !exactEntries(cacheRoot, ["ai-safe-driver"])
      || !assertRegularDirectory(marketplaceRoot) || !exactEntries(marketplaceRoot, ["ai-safe-driver"])
      || !assertRegularDirectory(pluginRoot)) {
      throw new Error("unexpected");
    }
    const versions = readdirSync(pluginRoot);
    if (versions.length !== 1 || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u.test(versions[0])) {
      throw new Error("unexpected");
    }
    const versionRoot = path.join(pluginRoot, versions[0]);
    const manifestPath = path.join(versionRoot, ".codex-plugin", "plugin.json");
    if (!assertRegularDirectory(versionRoot) || lstatSync(manifestPath).isSymbolicLink() || !statSync(manifestPath).isFile()) {
      throw new Error("unexpected");
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest === null || typeof manifest !== "object" || manifest.name !== "ai-safe-driver"
      || manifest.version !== versions[0]) {
      throw new Error("unexpected");
    }
    assertCanonicalPluginMirror(path.join(localRepositoryRoot, "plugins", "ai-safe-driver"), versionRoot);
  } catch {
    throw new HostAdapterBlockedError("Codex host run is BLOCKED because the skill profile contains unexpected or contaminated state");
  }
}

function createCodexAttempt(runtimeRoot, skillSeed, mode) {
  try {
    const codexHome = mkdtempSync(path.join(runtimeRoot, "attempt-"));
    if (mode === "skill") {
      cpSync(path.join(skillSeed, "config.toml"), path.join(codexHome, "config.toml"));
      cpSync(path.join(skillSeed, "plugins"), path.join(codexHome, "plugins"), { recursive: true });
      assertExpectedSkillProfile(codexHome);
    }
    return codexHome;
  } catch {
    throw new HostAdapterBlockedError("Codex host run is BLOCKED because a fresh disposable attempt could not be provisioned");
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

export function buildCodexCommand({
  executable = "codex",
  mode,
  repositoryRoot = localRepositoryRoot,
  baselineCodexHome,
  skillCodexHome,
  baselineRuntimeRoot,
  skillRuntimeRoot,
  baselineAcknowledgement,
  skillAcknowledgement,
  normalCodexHome,
  hostCwd = process.cwd(),
}) {
  assertMode(mode);
  assertExecutable(executable);
  const absoluteRepositoryRoot = assertAbsoluteDirectory(repositoryRoot, "Codex repository root");
  const baseline = assertAbsoluteDirectory(baselineCodexHome, "Codex baseline profile");
  const skill = assertAbsoluteDirectory(skillCodexHome, "Codex skill profile");
  const baselineRuntime = assertAbsoluteDirectory(baselineRuntimeRoot, "Codex baseline runtime root");
  const skillRuntime = assertAbsoluteDirectory(skillRuntimeRoot, "Codex skill runtime root");
  if (baselineAcknowledgement !== "1" || skillAcknowledgement !== "1") {
    throw new HostAdapterBlockedError("Codex host run is BLOCKED until both immutable seeds and runtime roots are acknowledged as isolated");
  }
  const isolatedDirectories = [baseline, skill, baselineRuntime, skillRuntime];
  if (isolatedDirectories.some((directory, index) => (
    isolatedDirectories.slice(index + 1).some((other) => pathsOverlap(directory, other))
  ))) {
    throw new HostAdapterBlockedError("Codex baseline and skill seeds and runtime roots must be physically distinct");
  }
  const normalDirectories = [
    physicalDirectoryIfPresent(normalCodexHome, hostCwd),
    physicalDirectoryIfPresent(path.join(homedir(), ".codex"), hostCwd),
  ].filter(Boolean);
  if (normalDirectories.some((normal) => isolatedDirectories.some((directory) => pathsOverlap(normal, directory)))) {
    throw new HostAdapterBlockedError("Codex adapter refuses a normal profile or its descendants");
  }
  assertFreshEmptyBaseline(baseline);
  assertExpectedSkillProfile(skill);
  return {
    executable,
    args: ["exec", "--ephemeral", "--json", "-C", absoluteRepositoryRoot, "-"],
    codexHome: createCodexAttempt(mode === "baseline" ? baselineRuntime : skillRuntime, skill, mode),
  };
}

export function parseCodexOutput(output) {
  const lines = output.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > MAX_RECORDS) throw new Error("Codex host returned an unexpected record count");
  const events = [];
  let response;
  let completed = false;
  const itemLifecycles = new Map();

  for (const [index, line] of lines.entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error("Codex host returned malformed JSONL");
    }
    if (record === null || typeof record !== "object" || Array.isArray(record) || typeof record.type !== "string") {
      throw new Error("Codex host returned an unexpected JSONL record");
    }
    if (record.type === "turn.failed" || record.type === "error") throw new Error("Codex host reported a failed turn");
    if (index === 0) {
      if (record.type !== "thread.started" || typeof record.thread_id !== "string"
        || record.thread_id.length === 0 || record.thread_id.length > 128) {
        throw new Error("Codex host returned records in an unexpected order");
      }
    } else if (index === 1 && record.type !== "turn.started") {
      throw new Error("Codex host returned records in an unexpected order");
    } else if (index > 1 && (record.type === "thread.started" || record.type === "turn.started")) {
      throw new Error("Codex host returned records in an unexpected order");
    }
    if (completed) throw new Error("Codex host returned records in an unexpected order");
    if (RECORD_EVENTS.has(record.type)) {
      events.push(RECORD_EVENTS.get(record.type));
      if (record.type === "turn.completed") {
        if (index !== lines.length - 1) throw new Error("Codex host returned records in an unexpected order");
        if ([...itemLifecycles.values()].some(({ phase }) => phase !== "completed")) {
          throw new Error("Codex host returned an unfinished item lifecycle");
        }
        completed = true;
      }
      continue;
    }
    if (!["item.started", "item.updated", "item.completed"].includes(record.type)
      || record.item === null || typeof record.item !== "object" || Array.isArray(record.item)) {
      throw new Error("Codex host returned an unexpected JSONL record");
    }
    if (typeof record.item.id !== "string" || record.item.id.length < 1 || record.item.id.length > 128
      || typeof record.item.type !== "string" || !ITEM_EVENTS.has(record.item.type)) {
      throw new Error("Codex host returned an unexpected item record");
    }
    const existing = itemLifecycles.get(record.item.id);
    if (existing !== undefined && existing.type !== record.item.type) {
      throw new Error("Codex host returned a contradictory item lifecycle type");
    }
    if (record.type === "item.started") {
      if (TERMINAL_ONLY_ITEM_TYPES.has(record.item.type) || existing !== undefined) {
        throw new Error("Codex host returned an unexpected item lifecycle order");
      }
      itemLifecycles.set(record.item.id, { type: record.item.type, phase: "started" });
      continue;
    }
    if (record.type === "item.updated") {
      if (TERMINAL_ONLY_ITEM_TYPES.has(record.item.type) || existing?.phase !== "started") {
        throw new Error("Codex host returned an unexpected item lifecycle order");
      }
      continue;
    }
    if (TERMINAL_ONLY_ITEM_TYPES.has(record.item.type)) {
      if (existing !== undefined) throw new Error("Codex host returned a duplicate terminal item lifecycle");
    } else if (existing?.phase !== "started") {
      throw new Error("Codex host returned an unexpected item lifecycle order");
    }
    itemLifecycles.set(record.item.id, { type: record.item.type, phase: "completed" });
    events.push(ITEM_EVENTS.get(record.item.type));
    if (record.item.type === "agent_message") {
      if (typeof record.item.text !== "string") {
        throw new Error("Codex host returned an unexpected response record");
      }
      response = record.item.text;
    }
  }
  if (!completed || response === undefined) throw new Error("Codex host did not return a completed response");
  return { response, events };
}

export async function run(request) {
  const prompt = promptFor(request);
  if (UNSUPPORTED_PROVIDER_VARIABLES.some((name) => typeof process.env[name] === "string" && process.env[name].length > 0)) {
    throw new HostAdapterBlockedError("Codex host run is BLOCKED because the configured provider is outside the adapter allowlist");
  }
  if (typeof process.env.CODEX_API_KEY !== "string" || process.env.CODEX_API_KEY.length === 0) {
    throw new HostAdapterBlockedError("Codex host run is BLOCKED because direct non-persistent authentication is unavailable");
  }
  const command = buildCodexCommand({
    executable: process.env.AI_SAFE_DRIVER_CODEX_EXECUTABLE || "codex",
    mode: request.mode,
    repositoryRoot: localRepositoryRoot,
    baselineCodexHome: process.env.AI_SAFE_DRIVER_CODEX_BASELINE_HOME,
    skillCodexHome: process.env.AI_SAFE_DRIVER_CODEX_SKILL_HOME,
    baselineRuntimeRoot: process.env.AI_SAFE_DRIVER_CODEX_BASELINE_RUNTIME_ROOT,
    skillRuntimeRoot: process.env.AI_SAFE_DRIVER_CODEX_SKILL_RUNTIME_ROOT,
    baselineAcknowledgement: process.env.AI_SAFE_DRIVER_CODEX_BASELINE_HOME_ISOLATED,
    skillAcknowledgement: process.env.AI_SAFE_DRIVER_CODEX_SKILL_HOME_ISOLATED,
    normalCodexHome: process.env.CODEX_HOME,
    hostCwd: process.cwd(),
  });
  const env = {
    ...sanitizedHostEnvironment(process.env, ["CODEX_API_KEY"]),
    HOME: command.codexHome,
    CODEX_HOME: command.codexHome,
  };
  const { stdout } = await runHostProcess({
    executable: command.executable,
    args: command.args,
    input: prompt,
    env,
    timeoutMs: TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  return parseCodexOutput(stdout);
}
