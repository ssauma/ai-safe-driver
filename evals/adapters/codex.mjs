import { homedir } from "node:os";
import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runHostProcess, sanitizedHostEnvironment } from "./host-process.mjs";

const localRepositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
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

export function buildCodexCommand({
  executable = "codex",
  mode,
  repositoryRoot = localRepositoryRoot,
  codexHome,
  isolatedAcknowledgement,
}) {
  assertMode(mode);
  assertExecutable(executable);
  const absoluteRepositoryRoot = assertAbsoluteDirectory(repositoryRoot, "Codex repository root");
  const absoluteCodexHome = assertAbsoluteDirectory(codexHome, "Codex profile");
  if (isolatedAcknowledgement !== "1") {
    throw new Error("Codex profile requires explicit isolated-profile acknowledgement");
  }
  try {
    if (absoluteCodexHome === realpathSync(path.join(homedir(), ".codex"))) {
      throw new Error("Codex adapter refuses the normal profile");
    }
  } catch (error) {
    if (error.message === "Codex adapter refuses the normal profile") throw error;
  }
  return {
    executable,
    args: ["exec", "--ephemeral", "--json", "-C", absoluteRepositoryRoot, "-"],
    codexHome: absoluteCodexHome,
  };
}

export function parseCodexOutput(output) {
  const lines = output.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > MAX_RECORDS) throw new Error("Codex host returned an unexpected record count");
  const events = [];
  let response;
  let completed = false;

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
        completed = true;
      }
      continue;
    }
    if (!["item.started", "item.updated", "item.completed"].includes(record.type)
      || record.item === null || typeof record.item !== "object" || Array.isArray(record.item)
      || !ITEM_EVENTS.has(record.item.type)) {
      throw new Error("Codex host returned an unexpected JSONL record");
    }
    if (record.type === "item.completed") {
      events.push(ITEM_EVENTS.get(record.item.type));
      if (record.item.type === "agent_message") {
        if (typeof record.item.text !== "string" || response !== undefined) {
          throw new Error("Codex host returned an unexpected response record");
        }
        response = record.item.text;
      }
    }
  }
  if (!completed || response === undefined) throw new Error("Codex host did not return a completed response");
  return { response, events };
}

export async function run(request) {
  const prompt = promptFor(request);
  const profile = request.mode === "baseline"
    ? process.env.AI_SAFE_DRIVER_CODEX_BASELINE_HOME
    : process.env.CODEX_HOME;
  const command = buildCodexCommand({
    executable: process.env.AI_SAFE_DRIVER_CODEX_EXECUTABLE || "codex",
    mode: request.mode,
    repositoryRoot: localRepositoryRoot,
    codexHome: profile,
    isolatedAcknowledgement: process.env.AI_SAFE_DRIVER_CODEX_HOME_ISOLATED,
  });
  const env = {
    ...sanitizedHostEnvironment(process.env, ["OPENAI_API_KEY", "CODEX_API_KEY"]),
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
