import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
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
const validDigest = () => createHash("sha256").update(Buffer.from(validHandover)).digest("hex");

const makeWorkspace = () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "asd-arm-")));
  execFileSync("git", ["init", "-q"], { cwd });
  mkdirSync(path.join(cwd, ".ai-safe-driver"));
  writeFileSync(path.join(cwd, ".ai-safe-driver", "handover.md"), validHandover);
  return cwd;
};

const makeNonGitWorkspace = () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "asd-arm-nongit-")));
  mkdirSync(path.join(cwd, ".ai-safe-driver"), { mode: 0o700 });
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
process.argv = [process.execPath, ${JSON.stringify(armScript)}, "--cwd", ${JSON.stringify(cwd)}, "--action", ${JSON.stringify(action)}, "--handover-sha256", ${JSON.stringify(validDigest())}];
await import(${JSON.stringify(pathToFileURL(armScript).href)});`,
  ],
  { cwd, encoding: "utf8" },
);

const addLocalExclude = (cwd) => {
  const exclude = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd, encoding: "utf8" }).trim();
  writeFileSync(path.resolve(cwd, exclude), ".ai-safe-driver/\n", { flag: "a" });
};

const runAction = (cwd, action, digest = validDigest()) => runArm(
  cwd,
  "--action",
  action,
  "--handover-sha256",
  digest,
);

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
  const result = runAction(cwd, "compact");
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
  assert.equal(runAction(cwd, "compact").status, 0);
  const armedPath = path.join(cwd, ".ai-safe-driver", "armed.json");
  const before = readFileSync(armedPath);
  const result = runAction(cwd, "clear");
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
    ["--cwd", cwd, "--check"],
    ["--check", "--check"],
    ["--action", "compact", "--action", "clear"],
    ["--action"],
    ["--action", "compact"],
    ["--action", "compact", "--handover-sha256"],
    ["--action", "compact", "--handover-sha256", "not-a-digest"],
    ["--action", "compact", "--handover-sha256", validDigest(), "--handover-sha256", validDigest()],
    ["--check", "--handover-sha256", validDigest()],
  ]) {
    assertBoundedFailure(runArm(cwd, ...args), cwd);
  }

  for (const rawArgs of [["--cwd"], ["--check"], ["--cwd", cwd]]) {
    const result = spawnSync(process.execPath, [armScript, ...rawArgs], { cwd, encoding: "utf8" });
    assertBoundedFailure(result, cwd);
  }
});

test("action is bound to the exact digest returned by check", () => {
  const cwd = makeWorkspace();
  addLocalExclude(cwd);
  const checked = runArm(cwd, "--check");
  assert.equal(checked.status, 0, checked.stderr);
  const digest = JSON.parse(checked.stdout).handover_sha256;
  writeFileSync(
    path.join(cwd, ".ai-safe-driver", "handover.md"),
    validHandover.replace("Preserve the current goal.", "A different valid goal."),
  );

  const result = runAction(cwd, "compact", digest);

  assertBoundedFailure(result, cwd);
  assert.match(result.stderr, /digest.*match|does not match/i);
  assert.equal(existsSync(path.join(cwd, ".ai-safe-driver", "armed.json")), false);
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

test("nested paths in an ancestor repository fail closed when Git is unavailable", () => {
  const repository = makeWorkspace();
  addLocalExclude(repository);
  const cwd = path.join(repository, "nested", "workspace");
  mkdirSync(path.join(cwd, ".ai-safe-driver"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(cwd, ".ai-safe-driver", "handover.md"), validHandover);

  const result = runArmWith(cwd, ["--check"], { env: { ...process.env, PATH: "" } });

  assertBoundedFailure(result, cwd);
  assert.match(result.stderr, /git.*unavailable/i);
});

test("genuine non-Git workspaces remain usable with or without Git", () => {
  const cwd = makeNonGitWorkspace();
  const withGit = runArm(cwd, "--check");
  assert.equal(withGit.status, 0, withGit.stderr);
  const withoutGit = runArmWith(cwd, ["--check"], { env: { ...process.env, PATH: "" } });
  assert.equal(withoutGit.status, 0, withoutGit.stderr);
});

test("unexpected Git command failures do not masquerade as a non-Git workspace", () => {
  const cwd = makeNonGitWorkspace();
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), "asd-arm-fake-git-")));
  const fakeGit = path.join(bin, "git");
  writeFileSync(fakeGit, "#!/bin/sh\nexit 2\n");
  chmodSync(fakeGit, 0o700);

  const result = runArmWith(cwd, ["--check"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });

  assertBoundedFailure(result, cwd);
  assert.match(result.stderr, /Git workspace validation failed/i);
});

test("recognizes a repository whose root uses a .git file", () => {
  const cwd = makeWorkspace();
  const gitData = path.join(cwd, "git-data");
  renameSync(path.join(cwd, ".git"), gitData);
  writeFileSync(path.join(cwd, ".git"), `gitdir: ${gitData}\n`);
  addLocalExclude(cwd);

  const result = runArm(cwd, "--check");

  assert.equal(result.status, 0, result.stderr);
});

test("recognizes a nested repository independently of its parent", () => {
  const parent = makeWorkspace();
  const cwd = path.join(parent, "nested-repository");
  mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  mkdirSync(path.join(cwd, ".ai-safe-driver"), { mode: 0o700 });
  writeFileSync(path.join(cwd, ".ai-safe-driver", "handover.md"), validHandover);
  addLocalExclude(cwd);

  const result = runArm(cwd, "--check");

  assert.equal(result.status, 0, result.stderr);
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

test("Git safety requires both handover and approval paths to be ignored", () => {
  const cwd = makeWorkspace();
  const exclude = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd, encoding: "utf8" }).trim();
  writeFileSync(path.resolve(cwd, exclude), ".ai-safe-driver/handover.md\n", { flag: "a" });

  const result = runArm(cwd, "--check");

  assertBoundedFailure(result, cwd);
  assert.match(result.stderr, /armed\.json.*not git-ignored|approval.*not git-ignored/i);
});

test("Git safety rejects a previously tracked absent approval path", () => {
  const cwd = makeWorkspace();
  addLocalExclude(cwd);
  const armedPath = path.join(cwd, ".ai-safe-driver", "armed.json");
  writeFileSync(armedPath, "{}\n");
  execFileSync("git", ["add", "-f", ".ai-safe-driver/armed.json"], { cwd });
  unlinkSync(armedPath);

  const result = runArm(cwd, "--check");

  assertBoundedFailure(result, cwd);
  assert.match(result.stderr, /armed\.json.*tracked|approval.*tracked/i);
});

test("rejects unsafe workspace and state-directory permissions on POSIX", { skip: typeof process.getuid !== "function" }, () => {
  const workspaceUnsafe = makeNonGitWorkspace();
  chmodSync(workspaceUnsafe, 0o777);
  const workspaceResult = runArm(workspaceUnsafe, "--check");
  assertBoundedFailure(workspaceResult, workspaceUnsafe);
  assert.match(workspaceResult.stderr, /workspace.*permissions/i);

  const stateUnsafe = makeNonGitWorkspace();
  chmodSync(path.join(stateUnsafe, ".ai-safe-driver"), 0o777);
  const stateResult = runArm(stateUnsafe, "--check");
  assertBoundedFailure(stateResult, stateUnsafe);
  assert.match(stateResult.stderr, /handover directory.*permissions/i);
});

test("rejects a stable symlinked state directory", () => {
  const cwd = makeNonGitWorkspace();
  const state = path.join(cwd, ".ai-safe-driver");
  const realState = path.join(cwd, "state-target");
  renameSync(state, realState);
  symlinkSync(realState, state, "dir");

  const result = runArm(cwd, "--check");

  assertBoundedFailure(result, cwd);
  assert.match(result.stderr, /handover directory.*regular directory/i);
});

test("check hashes exact valid UTF-8 bytes and rejects malformed UTF-8", () => {
  const cwd = makeNonGitWorkspace();
  const handoverPath = path.join(cwd, ".ai-safe-driver", "handover.md");
  const raw = Buffer.concat([Buffer.from(validHandover), Buffer.from("검증된 바이트\n")]);
  writeFileSync(handoverPath, raw);
  const checked = runArm(cwd, "--check");
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).handover_sha256, createHash("sha256").update(raw).digest("hex"));

  for (const malformed of [Buffer.from([0xc0, 0xaf]), Buffer.from([0xe0, 0x80, 0xaf])]) {
    writeFileSync(handoverPath, Buffer.concat([Buffer.from(validHandover), malformed]));
    const result = runArm(cwd, "--check");
    assertBoundedFailure(result, cwd);
    assert.match(result.stderr, /valid UTF-8/i);
  }
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
