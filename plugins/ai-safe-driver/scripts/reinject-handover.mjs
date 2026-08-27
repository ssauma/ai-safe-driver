#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";

import {
  MAX_APPROVAL_BYTES,
  assertSecureDirectoryBoundary,
  buildHandoverContext,
  captureSecureDirectoryBoundary,
  deliverThenConsume,
  readAndValidateHandover,
  readBoundedRegularFile,
  unlinkSameFile,
  validateApproval,
  validateApprovalFileStat,
} from "./handover-core.mjs";

const ALLOWED_SOURCES = new Set(["compact", "clear"]);
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const NON_BLOCK = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
const READ_FLAGS = constants.O_RDONLY | NO_FOLLOW | NON_BLOCK;
const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

const reportSkipped = (code) => {
  process.stderr.write(`AI Safe Driver handover skipped: ${code}\n`);
  process.exitCode = 0;
};

let input;
try {
  let rawInput = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) rawInput += chunk;
  input = JSON.parse(rawInput);
} catch {
  reportSkipped("invalid-hook-input");
}

if (input && ALLOWED_SOURCES.has(input.source) && typeof input.cwd === "string") {
  const stateRoot = path.resolve(input.cwd, ".ai-safe-driver");
  const handoverPath = path.join(stateRoot, "handover.md");
  const armedPath = path.join(stateRoot, "armed.json");

  try {
    const directoryBoundary = await captureSecureDirectoryBoundary({
      workspacePath: path.resolve(input.cwd),
      statePath: stateRoot,
      lstatPath: lstat,
      uid,
    });
    const validateBoundary = () => assertSecureDirectoryBoundary({
      boundary: directoryBoundary,
      workspacePath: path.resolve(input.cwd),
      statePath: stateRoot,
      lstatPath: lstat,
      uid,
    });
    const [handoverFile, approvalFile] = await Promise.all([
      readAndValidateHandover({
        filePath: handoverPath,
        openFlags: READ_FLAGS,
        openFile: open,
        lstatPath: lstat,
        uid,
      }),
      readBoundedRegularFile({
        filePath: armedPath,
        label: "approval",
        maxBytes: MAX_APPROVAL_BYTES,
        openFlags: READ_FLAGS,
        openFile: open,
        lstatPath: lstat,
      }),
    ]);
    await validateBoundary();
    const handover = handoverFile.content;
    const rawApproval = approvalFile.bytes.toString("utf8");
    const approval = JSON.parse(rawApproval);
    validateApprovalFileStat({ approval, stat: approvalFile.stat, uid });
    validateApproval({ approval, source: input.source, digest: handoverFile.digest, now: Date.now() });

    const additionalContext = buildHandoverContext(handover);

    const payload = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    });
    const emit = (output) => new Promise((resolve, reject) => {
      let failed = false;
      const onError = (error) => {
        failed = true;
        reject(error);
      };
      process.stdout.once("error", onError);
      process.stdout.write(output, "utf8", (error) => {
        if (error) {
          failed = true;
          reject(error);
          return;
        }
        if (failed) return;
        process.stdout.off("error", onError);
        resolve();
      });
    });

    await deliverThenConsume({
      payload,
      emit,
      consume: async () => {
        await validateBoundary();
        await unlinkSameFile({
          filePath: armedPath,
          identity: approvalFile.stat,
          lstatPath: lstat,
          unlinkPath: unlink,
        });
      },
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      // No armed handover is the normal, dormant state.
    } else {
      reportSkipped("operation-failed");
    }
  }
}
