#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import {
  assertSecureDirectoryBoundary,
  buildApproval,
  captureSecureDirectoryBoundary,
  readAndValidateHandover,
  writeExclusiveApproval,
} from "./handover-core.mjs";

const APPROVAL_TTL_MS = 10 * 60 * 1000;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const NON_BLOCK = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
const READ_FLAGS = constants.O_RDONLY | NO_FOLLOW | NON_BLOCK;
const MAX_OUTPUT_BYTES = 512;
const STATE_PATHS = [
  { pathspec: ".ai-safe-driver/handover.md", label: "handover payload" },
  { pathspec: ".ai-safe-driver/armed.json", label: "armed.json approval" },
];
const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

class Refusal extends Error {}

const refuse = (message) => {
  throw new Refusal(message);
};

const parseArguments = (argv) => {
  let cwd;
  let check = false;
  let action;
  let expectedDigest;

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
    } else if (argument === "--handover-sha256") {
      if (expectedDigest !== undefined || index + 1 >= argv.length) {
        refuse("invalid --handover-sha256 argument");
      }
      expectedDigest = argv[index + 1];
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
  if (check && expectedDigest !== undefined) refuse("check mode does not accept a handover digest");
  if (action !== undefined && !/^[a-f0-9]{64}$/u.test(expectedDigest ?? "")) {
    refuse("action requires a valid handover SHA-256");
  }
  return { cwd, check, action, expectedDigest };
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

const hasAncestorGitMarker = async (cwd) => {
  let current = cwd;
  while (true) {
    try {
      await lstat(path.join(current, ".git"));
      return true;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        refuse("Git workspace marker cannot be verified");
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
};

const runGit = (cwd, args) => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  }
  env.LC_ALL = "C";
  env.LANG = "C";
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
  const marker = await hasAncestorGitMarker(cwd);
  const repository = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (isUnavailable(repository)) {
    if (marker) refuse("Git is unavailable for a Git workspace");
    return;
  }
  if (repository.error || repository.signal || repository.status === null) {
    refuse("Git workspace validation failed");
  }
  if (repository.status !== 0 || repository.stdout.trim() !== "true") {
    const expectedNonRepository = !marker
      && repository.status === 128
      && /not a git repository/iu.test(repository.stderr);
    if (!expectedNonRepository) refuse("Git workspace validation failed");
    return;
  }

  for (const { pathspec, label } of STATE_PATHS) {
    const tracked = runGit(cwd, ["ls-files", "--error-unmatch", pathspec]);
    const ignored = runGit(cwd, ["check-ignore", "-q", pathspec]);
    if (isUnavailable(tracked) || isUnavailable(ignored)) refuse("Git is unavailable for a Git workspace");
    if (tracked.error || ignored.error || tracked.signal || ignored.signal) {
      refuse("Git workspace validation failed");
    }
    if (tracked.status === 0) refuse(`${label} is tracked by Git`);
    if (tracked.status !== 1) refuse("Git tracked-file check failed");
    if (ignored.status !== 0) refuse(`${label} is not git-ignored`);
  }
};

const readVerifiedHandover = async (handoverPath) => {
  try {
    return await readAndValidateHandover({
      filePath: handoverPath,
      openFlags: READ_FLAGS,
      openFile: open,
      lstatPath: lstat,
      uid,
    });
  } catch (error) {
    if (error instanceof Error && /^handover (?:is not|exceeds|is missing|has)/u.test(error.message)) {
      refuse(error.message);
    }
    refuse("handover validation failed");
  }
};

const safeFailureLine = (reason) => {
  const ascii = reason.replace(/[\r\n]/gu, " ").replace(/[^\x20-\x7e]/gu, "?").slice(0, 400);
  return `AI Safe Driver handover refused: ${ascii}\n`;
};

const writeBounded = (stream, output) => {
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) {
    return Promise.reject(new Error("output exceeds limit"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const swallowLaterErrors = () => {};
    const finish = (error) => {
      if (settled) return;
      settled = true;
      stream.off("error", onError);
      if (error) {
        stream.on("error", swallowLaterErrors);
        reject(new Error("stream write failed", { cause: error }));
      } else {
        resolve();
      }
    };
    const onError = (error) => finish(error);
    stream.once("error", onError);
    try {
      stream.write(output, "utf8", (error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
};

const writeErrorLine = async (line) => {
  try {
    await writeBounded(process.stderr, line);
  } catch {
    // There is no further bounded channel available.
  }
};

try {
  const options = parseArguments(process.argv.slice(2));
  const cwd = await resolveWorkspace(options.cwd);
  await verifyGitSafety(cwd);
  const stateRoot = path.join(cwd, ".ai-safe-driver");
  const directoryBoundary = await captureSecureDirectoryBoundary({
    workspacePath: cwd,
    statePath: stateRoot,
    lstatPath: lstat,
    uid,
  });
  const validateBoundary = () => assertSecureDirectoryBoundary({
    boundary: directoryBoundary,
    workspacePath: cwd,
    statePath: stateRoot,
    lstatPath: lstat,
    uid,
  });
  const handoverPath = path.join(stateRoot, "handover.md");
  const armedPath = path.join(stateRoot, "armed.json");
  const verified = await readVerifiedHandover(handoverPath);
  await validateBoundary();

  if (options.check) {
    try {
      await writeBounded(process.stdout, `${JSON.stringify({ handover_sha256: verified.digest })}\n`);
    } catch {
      refuse("check result could not be written");
    }
  } else {
    if (verified.digest !== options.expectedDigest) refuse("handover digest does not match checked content");
    const approval = buildApproval({
      action: options.action,
      handoverBytes: verified.bytes,
      now: Date.now(),
      ttlMs: APPROVAL_TTL_MS,
    });
    if (approval.handover_sha256 !== verified.digest) refuse("handover digest verification failed");
    const privatePath = path.join(
      stateRoot,
      `.armed-${randomBytes(16).toString("hex")}.tmp`,
    );
    try {
      await writeExclusiveApproval({
        armedPath,
        privatePath,
        approval,
        openFile: open,
        linkFile: link,
        unlinkFile: unlink,
        lstatPath: lstat,
        finalOpenFlags: READ_FLAGS,
        validateBoundary,
        uid,
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        refuse("approval already exists");
      }
      if (error instanceof Error && error.message === "approval could not be persisted") {
        refuse(error.message);
      }
      refuse("approval could not be created");
    }
    const result = `${JSON.stringify({
      action: approval.action,
      expires_at: approval.expires_at,
      handover_sha256: approval.handover_sha256,
    })}\n`;
    try {
      await writeBounded(process.stdout, result);
    } catch {
      await writeErrorLine("AI Safe Driver handover armed: result output unavailable\n");
    }
  }
} catch (error) {
  const reason = error instanceof Refusal
    ? error.message
    : error instanceof Error && /^(?:workspace|handover directory|handover|approval) /u.test(error.message)
      ? error.message
      : "validation failed";
  await writeErrorLine(safeFailureLine(reason));
  process.exitCode = 1;
}
