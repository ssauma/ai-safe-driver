import {
  MODES,
  labelsFor,
  score,
  validateAdapterLabel,
  validateEventLabels,
  validateSuite,
} from "./lib.mjs";

const UNSCORED_RAW_KEYS = new Set([
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
const DISPLAY_LIMIT = 4096;
const FORMAT_CONTROL = /\p{Cf}/u;

function isIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function validateRawRecord(record, byId, seen) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) throw new Error("raw record is malformed");
  if (record.scoringStatus !== "UNSCORED") {
    throw new Error(`adjudication accepts only UNSCORED attempts: ${record.attemptId ?? "unknown"}`);
  }
  const keys = Object.keys(record);
  if (keys.length !== UNSCORED_RAW_KEYS.size || keys.some((key) => !UNSCORED_RAW_KEYS.has(key))) {
    throw new Error("raw record contains missing or undeclared fields");
  }
  if (typeof record.attemptId !== "string" || record.attemptId.length === 0) throw new Error("raw attempt id is malformed");
  if (seen.has(record.attemptId)) throw new Error(`duplicate attempt: ${record.attemptId}`);
  seen.add(record.attemptId);
  const item = byId.get(record.caseId);
  if (!item) throw new Error(`unknown case in raw record: ${record.caseId}`);
  if (!item.variants.some(({ locale }) => locale === record.locale)) throw new Error(`case/locale mismatch: ${record.attemptId}`);
  if (!MODES.includes(record.mode) || !Number.isInteger(record.repetition) || record.repetition < 1) {
    throw new Error(`case/locale mismatch: ${record.attemptId}`);
  }
  const expectedAttempt = `${record.caseId}/${record.locale}/${record.mode}/${record.repetition}`;
  if (record.attemptId !== expectedAttempt) throw new Error(`case/locale mismatch: ${record.attemptId}`);
  if (typeof record.response !== "string") throw new Error(`raw record is malformed: ${record.attemptId}`);
  validateEventLabels(record.events, "raw record events");
  if (!isIsoTimestamp(record.startedAt) || !isIsoTimestamp(record.endedAt) || record.endedAt < record.startedAt) {
    throw new Error(`raw record timestamp is malformed: ${record.attemptId}`);
  }
  try {
    validateAdapterLabel(record.adapter);
  } catch {
    throw new Error(`raw record adapter is malformed: ${record.attemptId}`);
  }
  if (record.missingRequired !== null || record.observedForbidden !== null || record.passed !== null) {
    throw new Error(`adjudication accepts only UNSCORED attempts: ${record.attemptId}`);
  }
  return item;
}

export function validateAttempts(attempts, suite) {
  validateSuite(suite);
  if (!Array.isArray(attempts)) throw new Error("raw attempts must be an array");
  const byId = new Map(suite.cases.map((item) => [item.id, item]));
  const seen = new Set();
  return attempts.map((attempt) => ({
    attempt,
    item: validateRawRecord(attempt, byId, seen),
  }));
}

export async function adjudicateAttempts({ attempts, suite, selectActions, reviewer, now = () => new Date().toISOString() }) {
  if (typeof selectActions !== "function") throw new Error("selectActions must be a function");
  if (!new Set(["manual", "fixture"]).has(reviewer)) throw new Error("reviewer must be manual or fixture");
  const contexts = validateAttempts(attempts, suite);
  const records = [];
  for (const { attempt, item } of contexts) {
    const allowedActions = Object.freeze(labelsFor(item));
    const visibleAttempt = Object.freeze({ attemptId: attempt.attemptId, response: attempt.response });
    const selection = await selectActions({ attempt: visibleAttempt, allowedActions });
    if (!Array.isArray(selection) || !selection.every((value) => typeof value === "string")) {
      throw new Error(`selected actions must be an array of strings: ${attempt.attemptId}`);
    }
    const selectedActions = [...selection];
    const scoring = score(item, selectedActions);
    const reviewedAt = now();
    if (!isIsoTimestamp(reviewedAt)) throw new Error("review timestamp must be ISO-8601");
    records.push({
      attemptId: attempt.attemptId,
      selectedActions,
      ...scoring,
      reviewer,
      reviewedAt,
    });
  }
  return records;
}

function displayCharacter(character) {
  const code = character.codePointAt(0);
  if (character === "\n") return character;
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || FORMAT_CONTROL.test(character)) {
    return code <= 0xffff
      ? `\\u${code.toString(16).padStart(4, "0")}`
      : `\\u{${code.toString(16)}}`;
  }
  return character;
}

export function renderUntrustedResponse(response) {
  if (typeof response !== "string") throw new Error("response must be a string");
  let escaped = "";
  let truncated = false;
  for (const character of response) {
    const displayedCharacter = displayCharacter(character);
    if (escaped.length + displayedCharacter.length > DISPLAY_LIMIT) {
      truncated = true;
      break;
    }
    escaped += displayedCharacter;
  }
  const displayed = escaped.split("\n").map((line) => `| ${line}`).join("\n");
  return [
    "----- BEGIN UNTRUSTED RESPONSE (DISPLAY ONLY) -----",
    displayed,
    ...(truncated ? ["| [display truncated]"] : []),
    "----- END UNTRUSTED RESPONSE -----",
  ].join("\n");
}
