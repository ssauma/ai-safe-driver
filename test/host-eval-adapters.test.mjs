import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildClaudeCommand,
  parseClaudeOutput,
  run as runClaude,
} from "../evals/adapters/claude-code.mjs";
import {
  buildCodexCommand,
  parseCodexOutput,
  run as runCodex,
} from "../evals/adapters/codex.mjs";
import { runHostProcess } from "../evals/adapters/host-process.mjs";
import { validateEventLabels } from "../evals/lib.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const pluginDir = path.join(repositoryRoot, "plugins", "ai-safe-driver");

function area() {
  return mkdtempSync(path.join(os.tmpdir(), "asd-host-adapter-"));
}

function fixture(name, source) {
  const file = path.join(area(), name);
  writeFileSync(file, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  chmodSync(file, 0o700);
  return file;
}

function withEnvironment(pairs, callback) {
  const previous = new Map(Object.keys(pairs).map((key) => [key, process.env[key]]));
  Object.assign(process.env, pairs);
  return Promise.resolve(callback()).finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const request = {
  caseId: "strict-output-contract",
  locale: "en",
  turns: [{ role: "user", content: "SYNTHETIC_PRIVATE_PROMPT" }],
};

test("Claude command keeps the prompt off argv and adds the plugin only in skill mode", () => {
  const executable = fixture("claude-fixture", "process.stdout.write('{}')");
  assert.deepEqual(buildClaudeCommand({ executable, mode: "baseline", pluginDir }), {
    executable,
    args: ["-p", "--no-session-persistence", "--output-format", "json"],
  });
  assert.deepEqual(buildClaudeCommand({ executable, mode: "skill", pluginDir }), {
    executable,
    args: ["-p", "--no-session-persistence", "--output-format", "json", "--plugin-dir", pluginDir],
  });
  assert.throws(() => buildClaudeCommand({ executable, mode: "skill", pluginDir: "relative/plugin" }), /absolute/iu);
});

test("Codex command is ephemeral JSONL, reads stdin, and requires an acknowledged isolated profile", () => {
  const executable = fixture("codex-fixture", "process.stdout.write('{}')");
  const baselineHome = path.join(area(), "baseline-home");
  const skillHome = path.join(area(), "skill-home");
  mkdirSync(baselineHome);
  mkdirSync(skillHome);

  const baseline = buildCodexCommand({
    executable,
    mode: "baseline",
    repositoryRoot,
    codexHome: baselineHome,
    isolatedAcknowledgement: "1",
  });
  const skill = buildCodexCommand({
    executable,
    mode: "skill",
    repositoryRoot,
    codexHome: skillHome,
    isolatedAcknowledgement: "1",
  });
  assert.deepEqual(baseline, {
    executable,
    args: ["exec", "--ephemeral", "--json", "-C", repositoryRoot, "-"],
    codexHome: realpathSync(baselineHome),
  });
  assert.deepEqual(skill, { ...baseline, codexHome: realpathSync(skillHome) });
  assert.notEqual(baseline.codexHome, skill.codexHome);
  assert.throws(() => buildCodexCommand({
    executable,
    mode: "skill",
    repositoryRoot,
    codexHome: skillHome,
    isolatedAcknowledgement: "",
  }), /isolated/iu);
  assert.throws(() => buildCodexCommand({
    executable,
    mode: "skill",
    repositoryRoot: "relative/repository",
    codexHome: skillHome,
    isolatedAcknowledgement: "1",
  }), /absolute/iu);

  const aliasedParent = area();
  const physicalParent = area();
  const physicalProfile = path.join(physicalParent, "profile");
  mkdirSync(physicalProfile);
  const alias = path.join(aliasedParent, "alias");
  symlinkSync(physicalParent, alias, "dir");
  const canonical = buildCodexCommand({
    executable,
    mode: "skill",
    repositoryRoot,
    codexHome: path.join(alias, "profile"),
    isolatedAcknowledgement: "1",
  });
  assert.equal(canonical.codexHome, realpathSync(physicalProfile));
});

test("documented Claude JSON and Codex JSONL response shapes parse to safe observations", () => {
  assert.deepEqual(parseClaudeOutput(JSON.stringify({ type: "result", subtype: "success", result: "answer" })), {
    response: "answer",
    events: [],
  });
  const parsed = parseCodexOutput([
    JSON.stringify({ type: "thread.started", thread_id: "opaque" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "opaque", type: "agent_message", text: "answer" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
  ].join("\n"));
  assert.equal(parsed.response, "answer");
  assert.deepEqual(parsed.events, [
    "harness.codex_thread_started",
    "harness.codex_turn_started",
    "harness.codex_agent_message",
    "harness.codex_turn_completed",
  ]);
  assert.doesNotThrow(() => validateEventLabels(parsed.events));
  assert.equal("actions" in parsed, false);
});

test("parsers reject malformed, unexpected, failed, and missing-response records", () => {
  assert.throws(() => parseClaudeOutput("not json"), /malformed/iu);
  assert.throws(() => parseClaudeOutput(JSON.stringify({ type: "other", result: "answer" })), /unexpected/iu);
  assert.throws(() => parseClaudeOutput(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "answer" })), /failed/iu);
  assert.throws(() => parseCodexOutput("not jsonl"), /malformed/iu);
  assert.throws(() => parseCodexOutput(JSON.stringify({ type: "future.event" })), /unexpected/iu);
  assert.throws(() => parseCodexOutput(JSON.stringify({ type: "turn.failed", error: { message: "raw" } })), /failed/iu);
  assert.throws(() => parseCodexOutput([
    JSON.stringify({ type: "thread.started", thread_id: "opaque" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n")), /response/iu);
  assert.throws(() => parseCodexOutput([
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "thread.started", thread_id: "opaque" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answer" } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n")), /order/iu);
  assert.throws(() => parseCodexOutput([
    JSON.stringify({ type: "thread.started", thread_id: "opaque" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "turn.completed" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answer" } }),
  ].join("\n")), /order/iu);
});

test("bounded process execution rejects timeout, oversized output, and nonzero exit without leaking child data", async () => {
  const hanging = fixture("hang", "setInterval(() => {}, 1_000)");
  await assert.rejects(() => runHostProcess({
    executable: hanging,
    args: [],
    input: "SYNTHETIC_PRIVATE_PROMPT",
    env: {},
    timeoutMs: 25,
    maxOutputBytes: 1024,
  }), (error) => /timed out/iu.test(error.message) && !error.message.includes(hanging));

  const noisy = fixture("noisy", "process.stdout.write('x'.repeat(2048))");
  await assert.rejects(() => runHostProcess({
    executable: noisy,
    args: [],
    input: "SYNTHETIC_PRIVATE_PROMPT",
    env: {},
    timeoutMs: 1_000,
    maxOutputBytes: 128,
  }), /output exceeded/iu);

  const failing = fixture("fail", "process.stderr.write('SYNTHETIC_SECRET_VALUE /private/workspace SYNTHETIC_PRIVATE_PROMPT'); process.exit(7)");
  await assert.rejects(() => runHostProcess({
    executable: failing,
    args: [],
    input: "SYNTHETIC_PRIVATE_PROMPT",
    env: { OPENAI_API_KEY: "SYNTHETIC_SECRET_VALUE" },
    timeoutMs: 1_000,
    maxOutputBytes: 1024,
  }), (error) => {
    assert.match(error.message, /nonzero/iu);
    assert.doesNotMatch(error.message, /SYNTHETIC|private|workspace|OPENAI|\.tmp/iu);
    return true;
  });

  const descendant = fixture("descendant", `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { stdio: ["ignore", "inherit", "inherit"] });
setInterval(() => {}, 1000);`);
  const startedAt = Date.now();
  await assert.rejects(() => runHostProcess({
    executable: descendant,
    args: [],
    input: "prompt",
    env: {},
    timeoutMs: 25,
    maxOutputBytes: 1024,
  }), /timed out/iu);
  assert.ok(Date.now() - startedAt < 750, "timeout must terminate descendants holding stdio");
});

test("real adapters send prompts through stdin and return no semantic actions", async () => {
  const claude = fixture("claude-ok", `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: input && !input.includes("strict-output-contract") ? "stdin-clean" : "contaminated" })));`);
  await withEnvironment({ AI_SAFE_DRIVER_CLAUDE_EXECUTABLE: claude }, async () => {
    const result = await runClaude({ ...request, mode: "baseline" });
    assert.equal(result.response, "stdin-clean");
    assert.equal("actions" in result, false);
  });

  const codex = fixture("codex-ok", `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "opaque" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "opaque", type: "agent_message", text: input ? "stdin-ok" : "missing" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
});`);
  const isolatedHome = path.join(area(), "codex-home");
  mkdirSync(isolatedHome);
  await withEnvironment({
    AI_SAFE_DRIVER_CODEX_EXECUTABLE: codex,
    AI_SAFE_DRIVER_CODEX_HOME_ISOLATED: "1",
    CODEX_HOME: isolatedHome,
  }, async () => {
    const result = await runCodex({ ...request, mode: "skill" });
    assert.equal(result.response, "stdin-ok");
    assert.equal("actions" in result, false);
  });
});

test("host smoke result schema is strict, bounded, and requires each known id exactly once", () => {
  const schema = JSON.parse(readFileSync(path.join(repositoryRoot, "evals", "host-smoke-results.schema.json"), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["host", "host_version", "os", "node_version", "results"]);
  assert.deepEqual(schema.properties.host.enum, ["claude-code", "codex"]);
  assert.equal(schema.properties.results.minItems, 10);
  assert.equal(schema.properties.results.maxItems, 10);
  assert.equal(schema.properties.results.items.additionalProperties, false);
  assert.equal(schema.properties.results.items.properties.note.maxLength, 300);
  assert.ok(Array.isArray(schema.properties.results.items.properties.note.allOf));
  assert.ok(schema.properties.results.items.properties.note.allOf.some((rule) => rule.not?.pattern));
  assert.deepEqual(schema.properties.results.items.properties.status.enum, ["PASS", "FAIL", "BLOCKED"]);
  assert.equal(schema.properties.results.allOf.length, 10);
  assert.ok(schema.properties.results.allOf.every(({ contains, minContains, maxContains }) => (
    contains.properties.id.const && minContains === 1 && maxContains === 1
  )));
});

test("release documentation separates deterministic, real print-mode, and interactive evidence", () => {
  const document = readFileSync(path.join(repositoryRoot, "docs", "release-smoke-test.md"), "utf8");
  for (const id of [
    "manifest-and-hook-trust",
    "direct-visible-repeated-failure",
    "correction-recurrence-wake",
    "strict-json-output",
    "manual-compact-reload",
    "next-compact-transition",
    "clear-transition",
    "approval-rejection",
    "no-node-limitation",
    "bounded-payload",
  ]) assert.match(document, new RegExp(`\\b${id}\\b`, "u"));
  assert.match(document, /all 10 cases.*each host/isu);
  assert.match(document, /print.mode.*interactive/isu);
  assert.match(document, /PASS.*FAIL.*BLOCKED/isu);
  assert.match(document, /manual adjudication/iu);
  assert.match(document, /\.kb\.tmp\/ASD-HOST-EVAL/u);
  assert.match(document, /AI_SAFE_DRIVER_CODEX_HOME_ISOLATED=1/u);
  assert.match(document, /explicit.*approval.*credentialed/isu);
  assert.match(document, /PreCompact\.trigger/u);
  assert.match(document, /SessionStart\.source/u);
  assert.match(document, /observation.*record/isu);
  assert.match(document, /NOT RUN/iu);
  assert.doesNotMatch(document, /real host runs?:\s*PASS/iu);
});

test("contribution and PR gates keep deterministic, adjudicated, and interactive checks distinct", () => {
  for (const file of ["CONTRIBUTING.md", "CONTRIBUTING.ko.md", ".github/PULL_REQUEST_TEMPLATE.md"]) {
    const content = readFileSync(path.join(repositoryRoot, file), "utf8");
    assert.match(content, /deterministic|결정적/iu, file);
    assert.match(content, /adjudicat|판정/iu, file);
    assert.match(content, /interactive|대화형/iu, file);
    assert.match(content, /untrusted|신뢰할 수 없는/iu, file);
    assert.match(content, /credential|자격 증명/iu, file);
  }
});
