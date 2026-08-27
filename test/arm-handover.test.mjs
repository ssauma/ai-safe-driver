import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const armScript = path.resolve("plugins/ai-safe-driver/scripts/arm-handover.mjs");
const validHandover = `# AI Safe Driver Handover

## Current goal
Preserve the current goal.
## Latest explicit instructions
Do not retry unchanged.
## Exclusions and authorization boundaries
No unapproved writes.
## Confirmed facts and verified changes
Not applicable
## Repeated failures and observed evidence
Not applicable
## Unresolved hypotheses
Not applicable
## Output contract
Not applicable
## Next bounded action
Inspect one changed condition.
## Success check
Verify the result.
## Stop condition
Stop after the same failure.
## Transition rationale
Compact with continuity.
`;

const makeWorkspace = () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "asd-arm-")));
  execFileSync("git", ["init", "-q"], { cwd });
  mkdirSync(path.join(cwd, ".ai-safe-driver"));
  writeFileSync(path.join(cwd, ".ai-safe-driver", "handover.md"), validHandover);
  return cwd;
};

const runArm = (cwd, ...args) => spawnSync(process.execPath, [armScript, "--cwd", cwd, ...args], {
  cwd,
  encoding: "utf8",
});

const runArmWith = (cwd, args, options = {}) => spawnSync(
  process.execPath,
  [armScript, "--cwd", cwd, ...args],
  { cwd, encoding: "utf8", ...options },
);

const runArmWithUmask = (cwd, action, mask) => spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "--eval",
    `process.umask(${mask});
process.argv = [process.execPath, ${JSON.stringify(armScript)}, "--cwd", ${JSON.stringify(cwd)}, "--action", ${JSON.stringify(action)}];
await import(${JSON.stringify(pathToFileURL(armScript).href)});`,
  ],
  { cwd, encoding: "utf8" },
);

const addLocalExclude = (cwd) => {
  const exclude = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd, encoding: "utf8" }).trim();
  writeFileSync(path.resolve(cwd, exclude), ".ai-safe-driver/\n", { flag: "a" });
};

const assertBoundedFailure = (result, cwd) => {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 512, result.stderr);
  assert.equal(result.stderr.trim().split("\n").length, 1, result.stderr);
  assert.equal(result.stderr.includes(cwd), false, result.stderr);
  assert.equal(result.stderr.includes("Preserve the current goal"), false, result.stderr);
};

test("check rejects a Git workspace whose handover directory is not ignored", () => {
  const cwd = makeWorkspace();
  const result = runArm(cwd, "--check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not git-ignored/i);
  assert.equal(result.stdout, "");
});

test("check accepts a local info/exclude entry", () => {
  const cwd = makeWorkspace();
  addLocalExclude(cwd);
  const result = runArm(cwd, "--check");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /handover_sha256/i);
});

test("arming writes exclusive mode-0600 digest-bound approval", () => {
  const cwd = makeWorkspace();
  addLocalExclude(cwd);
  const result = runArm(cwd, "--action", "compact");
  assert.equal(result.status, 0, result.stderr);
  const armedPath = path.join(cwd, ".ai-safe-driver", "armed.json");
  const approval = JSON.parse(readFileSync(armedPath, "utf8"));
  assert.equal(approval.schema, "ai-safe-driver-handover-v1");
  assert.equal(approval.action, "compact");
  assert.equal(approval.handover_sha256, createHash("sha256").update(validHandover).digest("hex"));
  assert.equal(statSync(armedPath).mode & 0o777, 0o600);
  assert.equal(Date.parse(approval.expires_at) - Date.parse(approval.created_at), 10 * 60 * 1000);
});

test("arming refuses an existing approval without changing its bytes", () => {
  const cwd = makeWorkspace();
  addLocalExclude(cwd);
  assert.equal(runArm(cwd, "--action", "compact").status, 0);
  const armedPath = path.join(cwd, ".ai-safe-driver", "armed.json");
  const before = readFileSync(armedPath);
  const result = runArm(cwd, "--action", "clear");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists/i);
  assert.deepEqual(readFileSync(armedPath), before);
});

test("check is read-only", () => {
  const cwd = makeWorkspace();
  addLocalExclude(cwd);
  const handoverPath = path.join(cwd, ".ai-safe-driver", "handover.md");
  const excludePath = path.resolve(cwd, execFileSync(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    { cwd, encoding: "utf8" },
  ).trim());
  const handoverBefore = readFileSync(handoverPath);
  const excludeBefore = readFileSync(excludePath);

  const result = runArm(cwd, "--check");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(handoverPath), handoverBefore);
  assert.deepEqual(readFileSync(excludePath), excludeBefore);
  assert.equal(existsSync(path.join(cwd, ".ai-safe-driver", "armed.json")), false);
});

test("requires an absolute cwd and exactly one mode", () => {
  const cwd = makeWorkspace();
  addLocalExclude(cwd);

  const relative = spawnSync(process.execPath, [armScript, "--cwd", ".", "--check"], {
    cwd,
    encoding: "utf8",
  });
  assertBoundedFailure(relative, cwd);
  assert.match(relative.stderr, /absolute/i);

  for (const args of [
    [],
    ["--action", "archive"],
    ["--check", "--action", "compact"],
    ["--action", "compact", "--unexpected"],
  ]) {
    assertBoundedFailure(runArm(cwd, ...args), cwd);
  }
});

test("rejects a symlinked or otherwise noncanonical cwd instead of retargeting approval", () => {
  const cwd = makeWorkspace();
  addLocalExclude(cwd);
  const aliasRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "asd-arm-alias-")));
  const alias = path.join(aliasRoot, "workspace");
  symlinkSync(cwd, alias, "dir");

  const result = runArm(alias, "--check");

  assertBoundedFailure(result, alias);
  assert.match(result.stderr, /exact workspace/i);
});

test("check rejects tracked handover payloads even when an ignore rule exists", () => {
  const cwd = makeWorkspace();
  addLocalExclude(cwd);
  execFileSync("git", ["add", "-f", ".ai-safe-driver/handover.md"], { cwd });

  const result = runArm(cwd, "--check");

  assertBoundedFailure(result, cwd);
  assert.match(result.stderr, /tracked/i);
});

test("a Git marker fails closed when Git is unavailable", () => {
  const cwd = makeWorkspace();
  const result = runArmWith(cwd, ["--check"], {
    env: { ...process.env, PATH: "" },
  });

  assertBoundedFailure(result, cwd);
  assert.match(result.stderr, /git.*unavailable/i);
});

test("ignores inherited Git repository overrides when checking the selected workspace", () => {
  const cwd = makeWorkspace();
  const alternate = realpathSync(mkdtempSync(path.join(tmpdir(), "asd-arm-git-env-")));
  execFileSync("git", ["init", "-q"], { cwd: alternate });
  const alternateExclude = execFileSync(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    { cwd: alternate, encoding: "utf8" },
  ).trim();
  writeFileSync(path.resolve(alternate, alternateExclude), ".ai-safe-driver/\n", { flag: "a" });

  const result = runArmWith(cwd, ["--check"], {
    env: {
      ...process.env,
      GIT_DIR: path.join(alternate, ".git"),
      GIT_WORK_TREE: cwd,
    },
  });

  assertBoundedFailure(result, cwd);
  assert.match(result.stderr, /not git-ignored/i);
});

test("arming enforces mode 0600 even under a restrictive umask", () => {
  const cwd = makeWorkspace();
  addLocalExclude(cwd);

  const result = runArmWithUmask(cwd, "clear", 0o777);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(path.join(cwd, ".ai-safe-driver", "armed.json")).mode & 0o777, 0o600);
});

test("check uses the shared regular-file and heading validation without writing", () => {
  const cwd = makeWorkspace();
  addLocalExclude(cwd);
  const handoverPath = path.join(cwd, ".ai-safe-driver", "handover.md");
  writeFileSync(handoverPath, validHandover.replace("## Stop condition\n", ""));

  const result = runArm(cwd, "--check");

  assertBoundedFailure(result, cwd);
  assert.match(result.stderr, /missing ## Stop condition/i);
  assert.equal(existsSync(path.join(cwd, ".ai-safe-driver", "armed.json")), false);
});

test("check rejects a symlinked handover", () => {
  const cwd = makeWorkspace();
  addLocalExclude(cwd);
  const handoverPath = path.join(cwd, ".ai-safe-driver", "handover.md");
  const outside = path.join(cwd, "outside.md");
  writeFileSync(outside, validHandover);
  unlinkSync(handoverPath);
  symlinkSync(outside, handoverPath);

  const result = runArm(cwd, "--check");

  assertBoundedFailure(result, cwd);
  assert.match(result.stderr, /not a regular file/i);
});
