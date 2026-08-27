import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  linkSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoot = path.join(root, ".kb.tmp", "ASD-TASK-8", "tests");
const ids = [
  "repeated-instruction-mismatch",
  "repeated-tool-authentication",
  "strict-output-contract",
  "recoverable-first-mistake",
  "unrecoverable-context-contamination",
  "explicit-drift-check",
  "compaction-cannot-repair-external-state",
  "long-session-format-degradation",
  "comedy-cannot-replace-engineering",
  "high-risk-without-permission",
  "approved-compact-handover",
  "file-approval-is-not-clear-approval",
  "invalid-or-stale-approval",
  "correction-repair-recurrence",
  "fabricated-link-stale-answer",
  "authorization-boundary-after-correction",
  "explicit-tool-diagnosis-vs-raw-error",
  "unfamiliar-wording-direct-invocation",
  "wrong-task-broken-repair-promise",
  "execution-avoidance",
  "output-language-status-regression",
  "neutral-recurrence-and-anger",
];
const rawKeys = [
  "actions",
  "adapter",
  "attemptId",
  "caseId",
  "endedAt",
  "events",
  "locale",
  "missingRequired",
  "mode",
  "observedForbidden",
  "passed",
  "repetition",
  "response",
  "scoringStatus",
  "startedAt",
];
const adjudicatedKeys = [
  "attemptId",
  "missingRequired",
  "observedForbidden",
  "passed",
  "reviewedAt",
  "reviewer",
  "scoringStatus",
  "selectedActions",
];

mkdirSync(scratchRoot, { recursive: true });

const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const readJsonl = (file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const area = () => mkdtempSync(path.join(scratchRoot, "case-"));
const runCli = (script, args, options = {}) => spawnSync(
  process.execPath,
  [path.join(root, script), ...args],
  { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "test" }, ...options },
);
const writeAdapter = (dir, source) => {
  const adapter = path.join(dir, "fixture-adapter.mjs");
  writeFileSync(adapter, source);
  return adapter;
};
const writeDecisions = (dir, value) => {
  const decisions = path.join(dir, "decisions.json");
  writeFileSync(decisions, `${JSON.stringify(value)}\n`);
  return decisions;
};
const runOne = ({ adapter, out, extra = [] }) => runCli("evals/run-evals.mjs", [
  "--adapter", adapter,
  "--mode", "baseline",
  "--repetitions", "1",
  "--case", "repeated-tool-authentication",
  "--locale", "ko",
  "--out", out,
  ...extra,
]);

test("behavior cases have stable ids, localized turns, and executable assertions", () => {
  const suite = readJson("evals/cases.json");
  assert.equal(suite.schema, "ai-safe-driver-evals-v1");
  assert.deepEqual(suite.cases.map(({ id }) => id), ids);
  assert.equal(suite.cases.length, 22);
  for (const item of suite.cases) {
    assert.match(item.id, /^[a-z0-9-]+$/u);
    assert.deepEqual(item.variants.map(({ locale }) => locale).sort(), ["en", "ja", "ko", "zh"]);
    for (const variant of item.variants) {
      assert.ok(variant.turns.length > 0);
      assert.ok(variant.turns.every(({ role, content }) => role === "user" && typeof content === "string" && content.length > 0));
    }
    assert.ok(item.assertions.required_decisions.length + item.assertions.forbidden_actions.length > 0);
    assert.ok([...item.assertions.required_decisions, ...item.assertions.forbidden_actions]
      .every((label) => /^[a-z0-9_]+$/u.test(label)));
  }
});

test("fake adapter emits 176 bounded scored attempts for two repetitions", () => {
  const dir = area();
  const out = path.join(dir, "fake.jsonl");
  const result = runCli("evals/run-evals.mjs", [
    "--adapter", "./evals/adapters/fake.mjs",
    "--mode", "baseline",
    "--repetitions", "2",
    "--out", out,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const records = readJsonl(out);
  assert.equal(records.length, 22 * 4 * 2);
  assert.equal(new Set(records.map(({ attemptId }) => attemptId)).size, records.length);
  for (const record of records) {
    assert.equal(record.scoringStatus, "SCORED");
    assert.equal(record.passed, true);
    assert.deepEqual(Object.keys(record).sort(), rawKeys);
    assert.equal(record.adapter, "fake.mjs");
  }
});

test("case and locale filters select one variant and unknown filters fail before output", () => {
  const dir = area();
  const selected = path.join(dir, "selected.jsonl");
  const ok = runCli("evals/run-evals.mjs", [
    "--adapter", "./evals/adapters/fake.mjs",
    "--mode", "skill",
    "--repetitions", "2",
    "--case", "repeated-tool-authentication",
    "--locale", "ko",
    "--out", selected,
  ]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(readJsonl(selected).map(({ caseId, locale, repetition }) => [caseId, locale, repetition]), [
    ["repeated-tool-authentication", "ko", 1],
    ["repeated-tool-authentication", "ko", 2],
  ]);

  for (const [flag, value] of [["--case", "unknown-case"], ["--locale", "xx"]]) {
    const out = path.join(dir, `${value}.jsonl`);
    const result = runCli("evals/run-evals.mjs", [
      "--adapter", "./evals/adapters/fake.mjs", "--mode", "baseline", "--repetitions", "1",
      flag, value, "--out", out,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown (?:case|locale)/iu);
    assert.throws(() => readFileSync(out), /ENOENT/u);
  }
});

test("missing actions are UNSCORED while an empty action array is SCORED", () => {
  const dir = area();
  const missingAdapter = writeAdapter(dir, `export async function run() { return { response: "synthetic fixture", events: ["observed"], ignored: "drop me" }; }\n`);
  const missingOut = path.join(dir, "missing.jsonl");
  const missing = runOne({ adapter: missingAdapter, out: missingOut });
  assert.equal(missing.status, 0, missing.stderr);
  const [unscored] = readJsonl(missingOut);
  assert.equal(unscored.scoringStatus, "UNSCORED");
  assert.equal(unscored.actions, undefined);
  assert.equal(unscored.missingRequired, null);
  assert.equal(unscored.observedForbidden, null);
  assert.equal(unscored.passed, null);
  assert.deepEqual(Object.keys(unscored).sort(), rawKeys.filter((key) => key !== "actions"));

  const emptyAdapter = writeAdapter(dir, `export async function run() { return { response: "synthetic fixture", actions: [] }; }\n`);
  const emptyOut = path.join(dir, "empty.jsonl");
  const empty = runOne({ adapter: emptyAdapter, out: emptyOut });
  assert.equal(empty.status, 0, empty.stderr);
  const [scored] = readJsonl(emptyOut);
  assert.equal(scored.scoringStatus, "SCORED");
  assert.equal(scored.passed, false);
  assert.ok(scored.missingRequired.length > 0);
});

test("adapter output validation rejects invalid types and undeclared action labels", () => {
  const fixtures = [
    ["bad response", `{ response: 42 }`, /response.*string/iu],
    ["bad events", `{ response: "ok", events: [42] }`, /events.*strings/iu],
    ["bad actions", `{ response: "ok", actions: "label" }`, /actions.*strings/iu],
    ["unknown action", `{ response: "ok", actions: ["invented_label"] }`, /unknown action/iu],
  ];
  for (const [name, returned, message] of fixtures) {
    const dir = area();
    const adapter = writeAdapter(dir, `export async function run() { return ${returned}; }\n`);
    const out = path.join(dir, "invalid.jsonl");
    const result = runOne({ adapter, out });
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, message);
  }
});

test("runner serializes only declared bounded fields and an adapter basename", () => {
  const dir = area();
  const adapter = writeAdapter(dir, `export async function run() { return {
    response: "synthetic raw response",
    events: ["event"],
    actions: ["stop_unchanged_retry", "classify_authentication", "keep_token_causes_unconfirmed", "check_auth_without_disclosure", "require_verified_change_before_retry"],
    credentials: "must-not-leak", env: process.env, turns: ["must-not-leak"], arbitrary: { path: import.meta.url }
  }; }\n`);
  const out = path.join(dir, "bounded.jsonl");
  const result = runOne({ adapter, out });
  assert.equal(result.status, 0, result.stderr);
  const [record] = readJsonl(out);
  assert.deepEqual(Object.keys(record).sort(), rawKeys);
  assert.equal(record.adapter, "fixture-adapter.mjs");
  assert.doesNotMatch(JSON.stringify(record), /must-not-leak|process\.env|file:/u);
});

test("runner confines output beneath canonical .kb.tmp unless persistence is explicit", () => {
  const dir = area();
  const persistent = path.join(root, "evals", "persistent-fixture-output.jsonl");
  const denied = runOne({ adapter: "./evals/adapters/fake.mjs", out: persistent });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /\.kb\.tmp|persistent/iu);

  const allowed = runOne({ adapter: "./evals/adapters/fake.mjs", out: persistent, extra: ["--allow-persistent-output"] });
  assert.equal(allowed.status, 0, allowed.stderr);
  unlinkSync(persistent);

  const outside = path.join(dir, "outside");
  mkdirSync(outside);
  const link = path.join(root, ".kb.tmp", "ASD-TASK-8", `escape-${path.basename(dir)}`);
  symlinkSync(outside, link, "dir");
  const escaped = runOne({ adapter: "./evals/adapters/fake.mjs", out: path.join(link, "escape.jsonl") });
  assert.notEqual(escaped.status, 0);
  assert.match(escaped.stderr, /symlink|outside|escape/iu);

  const target = path.join(dir, "target.jsonl");
  writeFileSync(target, "untouched\n");
  const outputLink = path.join(dir, "output-link.jsonl");
  symlinkSync(target, outputLink, "file");
  const linked = runOne({ adapter: "./evals/adapters/fake.mjs", out: outputLink });
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /symlink/iu);
  assert.equal(readFileSync(target, "utf8"), "untouched\n");

  const canonical = path.join(dir, "canonical-from-parent.jsonl");
  const fromParent = runCli("evals/run-evals.mjs", [
    "--adapter", path.join(root, "evals", "adapters", "fake.mjs"),
    "--mode", "baseline", "--repetitions", "1",
    "--case", "repeated-tool-authentication", "--locale", "ko", "--out", canonical,
  ], { cwd: path.dirname(root) });
  assert.equal(fromParent.status, 0, fromParent.stderr);
  assert.equal(readJsonl(canonical).length, 1);
});

test("adjudication scores only UNSCORED attempts and writes no raw material", () => {
  const dir = area();
  const adapter = writeAdapter(dir, `export async function run() { return { response: "SYNTHETIC-SECRET-LIKE-TEXT", events: ["private-event"] }; }\n`);
  const raw = path.join(dir, "raw.jsonl");
  const generated = runOne({ adapter, out: raw });
  assert.equal(generated.status, 0, generated.stderr);
  const [{ attemptId }] = readJsonl(raw);
  const decisions = writeDecisions(dir, [{
    attemptId,
    selectedActions: [
      "stop_unchanged_retry",
      "classify_authentication",
      "keep_token_causes_unconfirmed",
      "check_auth_without_disclosure",
      "require_verified_change_before_retry",
    ],
    response: "inject-me",
    path: root,
  }]);
  const out = path.join(dir, "adjudicated.jsonl");
  const result = runCli("evals/adjudicate.mjs", ["--input", raw, "--out", out, "--decisions", decisions]);
  assert.equal(result.status, 0, result.stderr);
  const [record] = readJsonl(out);
  assert.deepEqual(Object.keys(record).sort(), adjudicatedKeys);
  assert.equal(record.attemptId, attemptId);
  assert.equal(record.reviewer, "fixture");
  assert.equal(record.scoringStatus, "SCORED");
  assert.equal(record.passed, true);
  assert.doesNotMatch(JSON.stringify(record), /SYNTHETIC|private-event|inject-me|ai-safe-driver/u);
  assert.match(readFileSync(raw, "utf8"), /SYNTHETIC-SECRET-LIKE-TEXT/u);
});

test("adjudication rejects unknown labels, duplicate attempts, scored input, and input-output alias", () => {
  const dir = area();
  const adapter = writeAdapter(dir, `export async function run() { return { response: "fixture" }; }\n`);
  const raw = path.join(dir, "raw.jsonl");
  assert.equal(runOne({ adapter, out: raw }).status, 0);
  const [record] = readJsonl(raw);

  for (const selectedActions of [["invented_label"], ["stop_unchanged_retry", "stop_unchanged_retry"]]) {
    const decisions = writeDecisions(dir, [{ attemptId: record.attemptId, selectedActions }]);
    const result = runCli("evals/adjudicate.mjs", ["--input", raw, "--out", path.join(dir, `${selectedActions.length}.jsonl`), "--decisions", decisions]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown|duplicate/iu);
  }

  writeFileSync(path.join(dir, "duplicate.jsonl"), `${JSON.stringify(record)}\n${JSON.stringify(record)}\n`);
  const decisions = writeDecisions(dir, [{ attemptId: record.attemptId, selectedActions: [] }]);
  const duplicate = runCli("evals/adjudicate.mjs", ["--input", path.join(dir, "duplicate.jsonl"), "--out", path.join(dir, "dupe-out.jsonl"), "--decisions", decisions]);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /duplicate attempt/iu);

  const scoredRaw = path.join(dir, "scored.jsonl");
  assert.equal(runOne({ adapter: "./evals/adapters/fake.mjs", out: scoredRaw }).status, 0);
  const scored = runCli("evals/adjudicate.mjs", ["--input", scoredRaw, "--out", path.join(dir, "scored-out.jsonl"), "--decisions", decisions]);
  assert.notEqual(scored.status, 0);
  assert.match(scored.stderr, /UNSCORED/iu);

  const alias = runCli("evals/adjudicate.mjs", ["--input", raw, "--out", raw, "--decisions", decisions]);
  assert.notEqual(alias.status, 0);
  assert.match(alias.stderr, /same|alias/iu);

  const hardlink = path.join(dir, "raw-hardlink.jsonl");
  linkSync(raw, hardlink);
  const linkedAlias = runCli("evals/adjudicate.mjs", ["--input", raw, "--out", hardlink, "--decisions", decisions]);
  assert.notEqual(linkedAlias.status, 0);
  assert.match(linkedAlias.stderr, /same|alias/iu);
});

test("adjudication rejects malformed or mismatched raw records and requires TTY without fixtures", () => {
  const dir = area();
  const malformed = path.join(dir, "malformed.jsonl");
  writeFileSync(malformed, "{\"attemptId\":\n");
  const bad = runCli("evals/adjudicate.mjs", ["--input", malformed, "--out", path.join(dir, "bad-out.jsonl"), "--decisions", writeDecisions(dir, [])]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /malformed JSONL/iu);

  const mismatched = path.join(dir, "mismatch.jsonl");
  writeFileSync(mismatched, `${JSON.stringify({
    attemptId: "unknown/en/baseline/1", caseId: "unknown", locale: "en", mode: "baseline", repetition: 1,
    response: "fixture", events: [], scoringStatus: "UNSCORED", missingRequired: null,
    observedForbidden: null, passed: null, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), adapter: "fixture.mjs",
  })}\n`);
  const mismatch = runCli("evals/adjudicate.mjs", ["--input", mismatched, "--out", path.join(dir, "mismatch-out.jsonl"), "--decisions", writeDecisions(dir, [])]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /unknown case|mismatch/iu);

  const adapter = writeAdapter(dir, `export async function run() { return { response: "fixture" }; }\n`);
  const raw = path.join(dir, "raw.jsonl");
  assert.equal(runOne({ adapter, out: raw }).status, 0);
  const noTty = runCli("evals/adjudicate.mjs", ["--input", raw, "--out", path.join(dir, "tty-out.jsonl")], { input: "" });
  assert.notEqual(noTty.status, 0);
  assert.match(noTty.stderr, /TTY|decisions/iu);

  const [valid] = readJsonl(raw);
  for (const mutation of [
    { ...valid, credentials: "unexpected" },
    { ...valid, startedAt: "not-a-timestamp" },
    { ...valid, adapter: path.join(root, "fixture-adapter.mjs") },
  ]) {
    const malformedRaw = path.join(dir, `raw-${Math.random().toString(16).slice(2)}.jsonl`);
    writeFileSync(malformedRaw, `${JSON.stringify(mutation)}\n`);
    const decision = writeDecisions(dir, [{ attemptId: valid.attemptId, selectedActions: [] }]);
    const rejected = runCli("evals/adjudicate.mjs", ["--input", malformedRaw, "--out", path.join(dir, `${path.basename(malformedRaw)}.out`), "--decisions", decision]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /malformed|field|timestamp|adapter/iu);
  }

  const [{ attemptId }] = readJsonl(raw);
  const fixture = writeDecisions(dir, [{ attemptId, selectedActions: [] }]);
  const productionFixture = runCli("evals/adjudicate.mjs", [
    "--input", raw, "--out", path.join(dir, "production-fixture.jsonl"), "--decisions", fixture,
  ], { env: { ...process.env, NODE_ENV: "production" } });
  assert.notEqual(productionFixture.status, 0);
  assert.match(productionFixture.stderr, /test fixture|NODE_ENV/iu);
});

test("localized Markdown views name cases.json as canonical and expose all 22 cases", () => {
  for (const file of ["evals/cases.md", "evals/cases.ko.md", "evals/cases.zh.md", "evals/cases.ja.md"]) {
    const content = readFileSync(path.join(root, file), "utf8");
    assert.match(content, /cases\.json/u, file);
    assert.equal([...content.matchAll(/^## \d+\./gmu)].length, 22, file);
  }
});
