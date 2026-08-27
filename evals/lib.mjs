import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOCALES = ["en", "ko", "zh", "ja"];
export const MODES = ["baseline", "skill"];
export const suitePath = fileURLToPath(new URL("./cases.json", import.meta.url));
export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export function loadSuite() {
  const suite = JSON.parse(readFileSync(suitePath, "utf8"));
  if (suite.schema !== "ai-safe-driver-evals-v1" || !Array.isArray(suite.cases)) {
    throw new Error("invalid eval suite schema");
  }
  return suite;
}

export function labelsFor(item) {
  return [...item.assertions.required_decisions, ...item.assertions.forbidden_actions];
}

export function score(item, actions) {
  if (actions === undefined) {
    return { scoringStatus: "UNSCORED", missingRequired: null, observedForbidden: null, passed: null };
  }
  if (!Array.isArray(actions) || !actions.every((value) => typeof value === "string")) {
    throw new Error("adapter actions must be an array of strings");
  }
  if (new Set(actions).size !== actions.length) {
    throw new Error("adapter actions contain duplicate labels");
  }
  const allowed = new Set(labelsFor(item));
  const unknown = actions.find((value) => !allowed.has(value));
  if (unknown) throw new Error(`unknown action label: ${unknown}`);
  const missingRequired = item.assertions.required_decisions.filter((value) => !actions.includes(value));
  const observedForbidden = item.assertions.forbidden_actions.filter((value) => actions.includes(value));
  return {
    scoringStatus: "SCORED",
    missingRequired,
    observedForbidden,
    passed: missingRequired.length === 0 && observedForbidden.length === 0,
  };
}

export function validateAdapterResult(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("adapter result must be an object");
  }
  if (typeof result.response !== "string") throw new Error("adapter response must be a string");
  for (const field of ["events", "actions"]) {
    if (result[field] !== undefined && (!Array.isArray(result[field]) || !result[field].every((value) => typeof value === "string"))) {
      throw new Error(`adapter ${field} must be an array of strings`);
    }
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function ensureNoSymlinkParents(base, parent) {
  const relative = path.relative(base, parent);
  if (relative === "" || relative === ".") return;
  let current = base;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("output parent may not be a symlink");
      if (!stat.isDirectory()) throw new Error("output parent is not a directory");
    } else {
      mkdirSync(current);
    }
  }
}

export function resolveOutputPath(value, { cwd = process.cwd(), allowPersistent = false } = {}) {
  if (typeof value !== "string" || value.length === 0) throw new Error("--out is required");
  const candidate = path.resolve(cwd, value);
  const tmpLexical = path.resolve(repositoryRoot, ".kb.tmp");
  if (!allowPersistent && !isWithin(tmpLexical, candidate)) {
    throw new Error("output must stay beneath .kb.tmp; use --allow-persistent-output explicitly for persistent output");
  }
  const parent = path.dirname(candidate);
  if (allowPersistent) {
    mkdirSync(parent, { recursive: true });
  } else {
    if (!existsSync(tmpLexical)) mkdirSync(tmpLexical);
    if (lstatSync(tmpLexical).isSymbolicLink()) throw new Error(".kb.tmp may not be a symlink");
    ensureNoSymlinkParents(tmpLexical, parent);
    const canonicalTmp = realpathSync(tmpLexical);
    const canonicalParent = realpathSync(parent);
    if (!isWithin(canonicalTmp, canonicalParent)) throw new Error("output path escapes .kb.tmp");
  }
  if (existsSync(candidate)) {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error("output file may not be a symlink");
    if (!stat.isFile()) throw new Error("output path is not a regular file");
  }
  return candidate;
}

export function resolveInputPath(value, { cwd = process.cwd() } = {}) {
  if (typeof value !== "string" || value.length === 0) throw new Error("input path is required");
  const candidate = path.resolve(cwd, value);
  const tmpRoot = path.resolve(repositoryRoot, ".kb.tmp");
  if (!isWithin(tmpRoot, candidate)) throw new Error("input must stay beneath .kb.tmp");
  if (!existsSync(candidate)) throw new Error("input file does not exist");
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("input must be a regular non-symlink file");
  const canonicalTmp = realpathSync(tmpRoot);
  const canonicalInput = realpathSync(candidate);
  if (!isWithin(canonicalTmp, canonicalInput)) throw new Error("input path escapes .kb.tmp");
  return candidate;
}

export function parseJsonl(file) {
  const content = readFileSync(file, "utf8");
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => {
    if (line.length === 0) throw new Error(`malformed JSONL at line ${index + 1}`);
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`malformed JSONL at line ${index + 1}`);
    }
  });
}

export function writeJsonlAtomic(file, records) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function parseFlags(argv, specification) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const rule = specification[flag];
    if (!rule) throw new Error(`unknown argument: ${flag}`);
    const name = rule.name;
    if (rule.boolean) {
      values[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    index += 1;
    if (rule.repeatable) {
      (values[name] ??= []).push(value);
    } else {
      if (values[name] !== undefined) throw new Error(`${flag} may only be provided once`);
      values[name] = value;
    }
  }
  return values;
}
