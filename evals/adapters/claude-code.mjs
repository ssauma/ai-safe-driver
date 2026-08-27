import { lstatSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runHostProcess, sanitizedHostEnvironment } from "./host-process.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const localPluginDirectory = path.join(repositoryRoot, "plugins", "ai-safe-driver");
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 128 * 1024;

function assertMode(mode) {
  if (mode !== "baseline" && mode !== "skill") throw new Error("host adapter mode is invalid");
}

function assertAbsoluteDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  try {
    if (lstatSync(value).isSymbolicLink() || !statSync(value).isDirectory()) throw new Error("invalid");
    return path.resolve(value);
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

export function buildClaudeCommand({ executable = "claude", mode, pluginDir = localPluginDirectory }) {
  assertMode(mode);
  assertExecutable(executable);
  const args = ["-p", "--no-session-persistence", "--output-format", "json"];
  if (mode === "skill") {
    const absolutePluginDirectory = assertAbsoluteDirectory(pluginDir, "Claude plugin directory");
    args.push("--plugin-dir", absolutePluginDirectory);
  }
  return { executable, args };
}

export function parseClaudeOutput(output) {
  let record;
  try {
    record = JSON.parse(output);
  } catch {
    throw new Error("Claude host returned malformed JSON");
  }
  if (record === null || typeof record !== "object" || Array.isArray(record) || record.type !== "result") {
    throw new Error("Claude host returned an unexpected result record");
  }
  if (record.is_error === true || record.subtype !== "success") throw new Error("Claude host reported a failed result");
  if (typeof record.result !== "string") throw new Error("Claude host returned an unexpected result record");
  return { response: record.result, events: [] };
}

export async function run(request) {
  const prompt = promptFor(request);
  const command = buildClaudeCommand({
    executable: process.env.AI_SAFE_DRIVER_CLAUDE_EXECUTABLE || "claude",
    mode: request.mode,
  });
  const env = sanitizedHostEnvironment(process.env, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
  const { stdout } = await runHostProcess({
    ...command,
    input: prompt,
    env,
    timeoutMs: TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  return parseClaudeOutput(stdout);
}
