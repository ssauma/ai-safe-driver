#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import {
  buildApproval,
  readAndValidateHandover,
} from "./handover-core.mjs";

const APPROVAL_TTL_MS = 10 * 60 * 1000;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const NON_BLOCK = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
const READ_FLAGS = constants.O_RDONLY | NO_FOLLOW | NON_BLOCK;
const HANDOVER_PATHSPEC = ".ai-safe-driver/handover.md";

class Refusal extends Error {}

const refuse = (message) => {
  throw new Refusal(message);
};

const parseArguments = (argv) => {
  let cwd;
  let check = false;
  let action;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cwd") {
      if (cwd !== undefined || index + 1 >= argv.length) refuse("invalid --cwd argument");
      cwd = argv[index + 1];
      index += 1;
    } else if (argument === "--check") {
      if (check) refuse("invalid --check argument");
      check = true;
    } else if (argument === "--action") {
      if (action !== undefined || index + 1 >= argv.length) refuse("invalid --action argument");
      action = argv[index + 1];
      index += 1;
    } else {
      refuse("unexpected argument");
    }
  }

  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) refuse("--cwd must be absolute");
  if (check === (action !== undefined)) refuse("choose exactly one check or action mode");
  if (action !== undefined && action !== "compact" && action !== "clear") {
    refuse("action must be compact or clear");
  }
  return { cwd, check, action };
};

const resolveWorkspace = async (candidate) => {
  if (path.resolve(candidate) !== candidate) refuse("--cwd must name the exact workspace");
  try {
    const workspace = await realpath(candidate);
    if (workspace !== candidate) refuse("--cwd must name the exact workspace");
    const workspaceStat = await lstat(workspace);
    if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) refuse("workspace is not a directory");
    return workspace;
  } catch (error) {
    if (error instanceof Refusal) throw error;
    refuse("workspace cannot be resolved");
  }
};

const hasGitMarker = async (cwd) => {
  try {
    await lstat(path.join(cwd, ".git"));
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    refuse("Git workspace marker cannot be verified");
  }
};

const runGit = (cwd, args) => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  }
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
};

const isUnavailable = (result) => result.error
  && typeof result.error === "object"
  && "code" in result.error
  && result.error.code === "ENOENT";

const verifyGitSafety = async (cwd) => {
  const marker = await hasGitMarker(cwd);
  const repository = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (isUnavailable(repository)) {
    if (marker) refuse("Git is unavailable for a Git workspace");
    return;
  }
  if (repository.error) refuse("Git workspace validation failed");
  if (repository.status !== 0 || repository.stdout.trim() !== "true") {
    if (marker) refuse("Git workspace validation failed");
    return;
  }

  const tracked = runGit(cwd, ["ls-files", "--error-unmatch", HANDOVER_PATHSPEC]);
  const ignored = runGit(cwd, ["check-ignore", "-q", HANDOVER_PATHSPEC]);
  if (isUnavailable(tracked) || isUnavailable(ignored)) refuse("Git is unavailable for a Git workspace");
  if (tracked.error || ignored.error) refuse("Git workspace validation failed");
  if (tracked.status === 0) refuse("handover payload is tracked by Git");
  if (tracked.status !== 1) refuse("Git tracked-file check failed");
  if (ignored.status !== 0) refuse("handover payload is not git-ignored");
};

const validateStateDirectory = async (cwd) => {
  const stateRoot = path.join(cwd, ".ai-safe-driver");
  try {
    const stateStat = await lstat(stateRoot);
    if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) refuse("handover directory is not a regular directory");
  } catch (error) {
    if (error instanceof Refusal) throw error;
    refuse("handover directory is unavailable");
  }
  return stateRoot;
};

const readVerifiedHandover = async (handoverPath) => {
  try {
    return await readAndValidateHandover({
      filePath: handoverPath,
      openFlags: READ_FLAGS,
      openFile: open,
      lstatPath: lstat,
    });
  } catch (error) {
    if (error instanceof Error && /^handover (?:is not|exceeds|is missing)/u.test(error.message)) {
      refuse(error.message);
    }
    refuse("handover validation failed");
  }
};

const writeApproval = async ({ armedPath, approval }) => {
  let handle;
  try {
    handle = await open(armedPath, "wx", 0o600);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      refuse("approval already exists");
    }
    refuse("approval could not be created");
  }

  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(approval)}\n`, "utf8");
    await handle.sync();
  } catch {
    refuse("approval could not be persisted");
  } finally {
    await handle.close();
  }
};

const safeFailureLine = (reason) => {
  const ascii = reason.replace(/[\r\n]/gu, " ").replace(/[^\x20-\x7e]/gu, "?").slice(0, 400);
  return `AI Safe Driver handover refused: ${ascii}\n`;
};

try {
  const options = parseArguments(process.argv.slice(2));
  const cwd = await resolveWorkspace(options.cwd);
  await verifyGitSafety(cwd);
  const stateRoot = await validateStateDirectory(cwd);
  const handoverPath = path.join(stateRoot, "handover.md");
  const armedPath = path.join(stateRoot, "armed.json");
  const verified = await readVerifiedHandover(handoverPath);

  if (options.check) {
    process.stdout.write(`${JSON.stringify({ handover_sha256: verified.digest })}\n`);
  } else {
    const approval = buildApproval({
      action: options.action,
      handover: verified.content,
      now: Date.now(),
      ttlMs: APPROVAL_TTL_MS,
    });
    if (approval.handover_sha256 !== verified.digest) refuse("handover digest verification failed");
    await writeApproval({ armedPath, approval });
    process.stdout.write(`${JSON.stringify({
      action: approval.action,
      expires_at: approval.expires_at,
      handover_sha256: approval.handover_sha256,
    })}\n`);
  }
} catch (error) {
  const reason = error instanceof Refusal ? error.message : "validation failed";
  process.stderr.write(safeFailureLine(reason));
  process.exitCode = 1;
}
