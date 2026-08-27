#!/usr/bin/env node
import path from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import {
  labelsFor,
  loadSuite,
  parseFlags,
  parseJsonl,
  resolveInputPath,
  resolveOutputPath,
  score,
  writeJsonlAtomic,
} from "./lib.mjs";

const specification = {
  "--input": { name: "input" },
  "--out": { name: "out" },
  "--decisions": { name: "decisions" },
};

const unscoredRawKeys = new Set([
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
]);

function isIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validateRawRecord(record, byId, seen) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) throw new Error("raw record is malformed");
  if (record.scoringStatus !== "UNSCORED") {
    throw new Error(`adjudication accepts only UNSCORED attempts: ${record.attemptId ?? "unknown"}`);
  }
  const keys = Object.keys(record);
  if (keys.length !== unscoredRawKeys.size || keys.some((key) => !unscoredRawKeys.has(key))) {
    throw new Error("raw record contains missing or undeclared fields");
  }
  if (typeof record.attemptId !== "string" || record.attemptId.length === 0) throw new Error("raw attempt id is malformed");
  if (seen.has(record.attemptId)) throw new Error(`duplicate attempt: ${record.attemptId}`);
  seen.add(record.attemptId);
  const item = byId.get(record.caseId);
  if (!item) throw new Error(`unknown case in raw record: ${record.caseId}`);
  if (!item.variants.some(({ locale }) => locale === record.locale)) throw new Error(`case/locale mismatch: ${record.attemptId}`);
  if (!['baseline', 'skill'].includes(record.mode) || !Number.isInteger(record.repetition) || record.repetition < 1) {
    throw new Error(`case/locale mismatch: ${record.attemptId}`);
  }
  const expectedAttempt = `${record.caseId}/${record.locale}/${record.mode}/${record.repetition}`;
  if (record.attemptId !== expectedAttempt) throw new Error(`case/locale mismatch: ${record.attemptId}`);
  if (typeof record.response !== "string" || !Array.isArray(record.events) || !record.events.every((value) => typeof value === "string")) {
    throw new Error(`raw record is malformed: ${record.attemptId}`);
  }
  if (!isIsoTimestamp(record.startedAt) || !isIsoTimestamp(record.endedAt) || record.endedAt < record.startedAt) {
    throw new Error(`raw record timestamp is malformed: ${record.attemptId}`);
  }
  if (typeof record.adapter !== "string" || record.adapter.length === 0 || record.adapter.length > 255
    || path.basename(record.adapter) !== record.adapter || !/^[a-zA-Z0-9._-]+$/u.test(record.adapter)) {
    throw new Error(`raw record adapter is malformed: ${record.attemptId}`);
  }
  if (record.missingRequired !== null || record.observedForbidden !== null || record.passed !== null) {
    throw new Error(`adjudication accepts only UNSCORED attempts: ${record.attemptId}`);
  }
  if (Object.hasOwn(record, "actions")) throw new Error(`UNSCORED attempt may not contain actions: ${record.attemptId}`);
  return item;
}

function fixtureSelections(file, attempts) {
  const fixture = JSON.parse(readFileSync(resolveInputPath(file), "utf8"));
  if (!Array.isArray(fixture)) throw new Error("decisions fixture must be an array");
  const attemptIds = new Set(attempts.map(({ attemptId }) => attemptId));
  const selections = new Map();
  for (const decision of fixture) {
    if (decision === null || typeof decision !== "object" || typeof decision.attemptId !== "string") {
      throw new Error("decision is malformed");
    }
    if (!attemptIds.has(decision.attemptId)) throw new Error(`unknown attempt in decisions: ${decision.attemptId}`);
    if (selections.has(decision.attemptId)) throw new Error(`duplicate attempt in decisions: ${decision.attemptId}`);
    if (!Array.isArray(decision.selectedActions) || !decision.selectedActions.every((value) => typeof value === "string")) {
      throw new Error(`selectedActions must be an array of strings: ${decision.attemptId}`);
    }
    selections.set(decision.attemptId, decision.selectedActions);
  }
  for (const { attemptId } of attempts) {
    if (!selections.has(attemptId)) throw new Error(`missing fixture decision: ${attemptId}`);
  }
  return selections;
}

function validateSelection(item, selected, attemptId) {
  if (new Set(selected).size !== selected.length) throw new Error(`duplicate selected action: ${attemptId}`);
  const allowed = new Set(labelsFor(item));
  const unknown = selected.find((label) => !allowed.has(label));
  if (unknown) throw new Error(`unknown selected action ${unknown}: ${attemptId}`);
}

async function manualSelections(attempts, itemByAttempt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("interactive adjudication requires a TTY; --decisions is only for bounded test fixtures");
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const selections = new Map();
  try {
    for (const attempt of attempts) {
      const allowed = labelsFor(itemByAttempt.get(attempt.attemptId));
      process.stdout.write(`\nAttempt ${attempt.attemptId}\nResponse:\n${attempt.response}\nAllowed action labels:\n`);
      allowed.forEach((label, index) => process.stdout.write(`  ${index + 1}. ${label}\n`));
      const answer = await terminal.question("Select comma-separated numbers (blank for none): ");
      const selected = answer.trim() === "" ? [] : answer.split(",").map((part) => {
        const index = Number(part.trim());
        if (!Number.isInteger(index) || index < 1 || index > allowed.length) throw new Error("selection must use displayed label numbers only");
        return allowed[index - 1];
      });
      selections.set(attempt.attemptId, selected);
    }
  } finally {
    terminal.close();
  }
  return selections;
}

async function main() {
  const options = parseFlags(process.argv.slice(2), specification);
  if (options.decisions && process.env.NODE_ENV !== "test") {
    throw new Error("--decisions is restricted to test fixtures with NODE_ENV=test");
  }
  const input = resolveInputPath(options.input);
  const output = resolveOutputPath(options.out);
  if (path.resolve(input) === path.resolve(output)) throw new Error("input and output may not be the same file or alias");
  const inputStat = lstatSync(input);
  try {
    const outputStat = lstatSync(output);
    if (inputStat.dev === outputStat.dev && inputStat.ino === outputStat.ino) {
      throw new Error("input and output may not be the same file or alias");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const suite = loadSuite();
  const byId = new Map(suite.cases.map((item) => [item.id, item]));
  const attempts = parseJsonl(input);
  const seen = new Set();
  const itemByAttempt = new Map();
  for (const attempt of attempts) itemByAttempt.set(attempt.attemptId, validateRawRecord(attempt, byId, seen));

  const selections = options.decisions
    ? fixtureSelections(options.decisions, attempts)
    : await manualSelections(attempts, itemByAttempt);
  const reviewer = options.decisions ? "fixture" : "manual";
  const records = attempts.map((attempt) => {
    const selectedActions = selections.get(attempt.attemptId);
    const item = itemByAttempt.get(attempt.attemptId);
    validateSelection(item, selectedActions, attempt.attemptId);
    return {
      attemptId: attempt.attemptId,
      selectedActions,
      ...score(item, selectedActions),
      reviewer,
      reviewedAt: new Date().toISOString(),
    };
  });
  writeJsonlAtomic(output, records);
  process.stdout.write(`${records.length} attempts adjudicated\n`);
}

main().catch((error) => {
  process.stderr.write(`eval adjudicator: ${error.message}\n`);
  process.exitCode = 1;
});
