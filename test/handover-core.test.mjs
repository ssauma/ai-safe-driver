import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  HANDOVER_CONTEXT_OVERHEAD_BYTES,
  MAX_APPROVAL_BYTES,
  MAX_HANDOVER_BYTES,
  MAX_HANDOVER_CONTEXT_BYTES,
  buildHandoverContext,
  buildApproval,
  deliverThenConsume,
  readAndValidateHandover,
  readBoundedRegularFile,
  validateApproval,
  validateApprovalFileStat,
  validateHandoverDocument,
  validateSecureDirectoryStat,
  writeExclusiveApproval,
} from "../plugins/ai-safe-driver/scripts/handover-core.mjs";

const requiredHeadings = [
  "## Current goal",
  "## Latest explicit instructions",
  "## Exclusions and authorization boundaries",
  "## Confirmed facts and verified changes",
  "## Repeated failures and observed evidence",
  "## Unresolved hypotheses",
  "## Output contract",
  "## Next bounded action",
  "## Success check",
  "## Stop condition",
  "## Transition rationale",
];

const validHandover = requiredHeadings.map((heading) => `${heading}\nNot applicable\n`).join("");
const padDocumentToBytes = (content, targetBytes, { multibyte = false } = {}) => {
  const remaining = targetBytes - Buffer.byteLength(content, "utf8");
  assert.ok(remaining >= 0);
  if (!multibyte) return `${content}${"x".repeat(remaining)}`;
  return `${content}${"한".repeat(Math.floor(remaining / 3))}${"x".repeat(remaining % 3)}`;
};
const regularStat = (size = Buffer.byteLength(validHandover)) => ({
  dev: 1,
  ino: 2,
  size,
  uid: 501,
  mode: 0o100600,
  mtimeMs: 1,
  ctimeMs: 1,
  isFile: () => true,
  isSymbolicLink: () => false,
});
const digestFor = (content) => createHash("sha256").update(content).digest("hex");
const directoryStat = ({ dev = 1, ino = 2, uid = 501, mode = 0o40700 } = {}) => ({
  dev,
  ino,
  uid,
  mode,
  isDirectory: () => true,
  isSymbolicLink: () => false,
});
const validApproval = ({
  action = "compact",
  digest = digestFor(validHandover),
  createdAt = "2026-08-27T00:00:00.000Z",
  expiresAt = "2026-08-27T00:10:00.000Z",
} = {}) => ({
  schema: "ai-safe-driver-handover-v1",
  action,
  created_at: createdAt,
  expires_at: expiresAt,
  handover_sha256: digest,
});

test("handover allowance reserves the exact fixed wrapper overhead", () => {
  assert.equal(MAX_HANDOVER_CONTEXT_BYTES, 6 * 1024);
  assert.equal(MAX_HANDOVER_BYTES + HANDOVER_CONTEXT_OVERHEAD_BYTES, MAX_HANDOVER_CONTEXT_BYTES);
  assert.equal(Buffer.byteLength(buildHandoverContext(""), "utf8"), HANDOVER_CONTEXT_OVERHEAD_BYTES);
});

test("final model-visible handover context enforces ASCII and multibyte byte boundaries", () => {
  for (const multibyte of [false, true]) {
    const exact = padDocumentToBytes(validHandover, MAX_HANDOVER_BYTES, { multibyte });
    assert.equal(Buffer.byteLength(exact, "utf8"), MAX_HANDOVER_BYTES);
    assert.doesNotThrow(() => validateHandoverDocument({ content: exact, stat: regularStat(MAX_HANDOVER_BYTES) }));

    const context = buildHandoverContext(exact);
    assert.equal(Buffer.byteLength(context, "utf8"), MAX_HANDOVER_CONTEXT_BYTES);
    assert.throws(
      () => buildHandoverContext(`${exact}x`),
      { message: "handover exceeds model-visible context allowance" },
    );
    assert.throws(
      () => validateHandoverDocument({ content: `${exact}x`, stat: regularStat(MAX_HANDOVER_BYTES + 1) }),
      { message: "handover exceeds model-visible context allowance" },
    );
  }
});

test("approval input cap is four KiB", () => {
  assert.equal(MAX_APPROVAL_BYTES, 4 * 1024);
});

const fakeHandle = ({ content, stat, onRead = () => {} }) => {
  let position = 0;
  let closed = false;
  return {
    handle: {
      stat: async () => (typeof stat === "function" ? stat() : stat),
      read: async (target, offset, length) => {
        onRead(length);
        const bytesRead = content.copy(target, offset, position, position + length);
        position += bytesRead;
        return { bytesRead, buffer: target };
      },
      close: async () => { closed = true; },
    },
    isClosed: () => closed,
  };
};

test("bounded reader rejects a replaced path before reading from the opened handle", async () => {
  let readCalls = 0;
  const opened = regularStat(4);
  const file = fakeHandle({
    content: Buffer.from("safe"),
    stat: opened,
    onRead: () => { readCalls += 1; },
  });

  await assert.rejects(() => readBoundedRegularFile({
    filePath: "handover.md",
    label: "handover",
    maxBytes: MAX_HANDOVER_BYTES,
    openFlags: 123,
    openFile: async () => file.handle,
    lstatPath: async () => ({ ...regularStat(4), ino: opened.ino + 1 }),
  }), { message: "handover is not a regular file" });
  assert.equal(readCalls, 0);
  assert.equal(file.isClosed(), true);
});

test("no-follow fallback rejects replacement between pre-open and post-open identity checks", async () => {
  let lstatCalls = 0;
  let readCalls = 0;
  const opened = regularStat(4);
  const file = fakeHandle({
    content: Buffer.from("safe"),
    stat: opened,
    onRead: () => { readCalls += 1; },
  });

  await assert.rejects(() => readBoundedRegularFile({
    filePath: "handover.md",
    label: "handover",
    maxBytes: MAX_HANDOVER_BYTES,
    openFlags: 0,
    openFile: async () => file.handle,
    lstatPath: async () => {
      lstatCalls += 1;
      return lstatCalls === 1 ? opened : { ...opened, ino: opened.ino + 1 };
    },
  }), { message: "handover is not a regular file" });
  assert.equal(lstatCalls, 2);
  assert.equal(readCalls, 0);
  assert.equal(file.isClosed(), true);
});

test("bounded reader reads and closes the same verified handle", async () => {
  const content = Buffer.from("approved");
  const stat = regularStat(content.length);
  const file = fakeHandle({ content, stat });
  const opened = [];

  const result = await readBoundedRegularFile({
    filePath: "armed.json",
    label: "approval",
    maxBytes: MAX_APPROVAL_BYTES,
    openFlags: 456,
    openFile: async (...args) => {
      opened.push(args);
      return file.handle;
    },
    lstatPath: async () => stat,
  });

  assert.deepEqual(result, { bytes: content, stat });
  assert.deepEqual(opened, [["armed.json", 456]]);
  assert.equal(file.isClosed(), true);
});

test("bounded reader rejects the cap plus one byte even when the opened stat was stale", async () => {
  const content = Buffer.alloc(MAX_APPROVAL_BYTES + 1, 0x20);
  const stat = regularStat(MAX_APPROVAL_BYTES);
  const readLengths = [];
  const file = fakeHandle({ content, stat, onRead: (length) => readLengths.push(length) });

  await assert.rejects(() => readBoundedRegularFile({
    filePath: "armed.json",
    label: "approval",
    maxBytes: MAX_APPROVAL_BYTES,
    openFlags: 456,
    openFile: async () => file.handle,
    lstatPath: async () => stat,
  }), { message: "approval exceeds 4 KiB" });
  assert.equal(readLengths.reduce((sum, length) => sum + length, 0) <= MAX_APPROVAL_BYTES + 1, true);
  assert.equal(file.isClosed(), true);
});

test("bounded reader rejects growth after its trusted pre-read snapshot", async () => {
  const content = Buffer.from("published later");
  const before = regularStat(0);
  const after = { ...before, size: content.length, mtimeMs: 2, ctimeMs: 2 };
  let handleStats = 0;
  let pathStats = 0;
  const file = fakeHandle({
    content,
    stat: () => {
      handleStats += 1;
      return handleStats === 1 ? before : after;
    },
  });

  await assert.rejects(() => readBoundedRegularFile({
    filePath: "armed.json",
    label: "approval",
    maxBytes: MAX_APPROVAL_BYTES,
    openFlags: 456,
    openFile: async () => file.handle,
    lstatPath: async () => {
      pathStats += 1;
      return pathStats <= 2 ? before : after;
    },
  }), /approval changed during read/);

  assert.equal(handleStats, 2);
  assert.equal(pathStats, 3);
  assert.equal(file.isClosed(), true);
});

test("bounded reader rejects post-read path replacement and short reads", async () => {
  const content = Buffer.from("short");
  const stable = regularStat(content.length + 1);
  let pathStats = 0;
  const shortFile = fakeHandle({ content, stat: stable });
  await assert.rejects(() => readBoundedRegularFile({
    filePath: "armed.json",
    label: "approval",
    maxBytes: MAX_APPROVAL_BYTES,
    openFlags: 456,
    openFile: async () => shortFile.handle,
    lstatPath: async () => stable,
  }), /approval changed during read/);

  const exact = Buffer.from("complete");
  const opened = regularStat(exact.length);
  const replaced = { ...opened, ino: opened.ino + 1 };
  const replacedFile = fakeHandle({ content: exact, stat: opened });
  let replacementPathStats = 0;
  await assert.rejects(() => readBoundedRegularFile({
    filePath: "armed.json",
    label: "approval",
    maxBytes: MAX_APPROVAL_BYTES,
    openFlags: 456,
    openFile: async () => replacedFile.handle,
    lstatPath: async () => {
      replacementPathStats += 1;
      return replacementPathStats === 3 ? replaced : opened;
    },
  }), /approval changed during read/);
});

test("handover document validation returns its verified digest", () => {
  assert.deepEqual(
    validateHandoverDocument({ content: validHandover, stat: regularStat() }),
    { digest: digestFor(validHandover) },
  );
});

test("same-handle validation hashes raw bytes and decodes UTF-8 strictly", async () => {
  const raw = Buffer.concat([Buffer.from(validHandover), Buffer.from("검증\n")]);
  const stat = regularStat(raw.length);
  const file = fakeHandle({ content: raw, stat });
  const verified = await readAndValidateHandover({
    filePath: "handover.md",
    openFlags: 0,
    openFile: async () => file.handle,
    lstatPath: async () => stat,
  });
  assert.equal(verified.digest, digestFor(raw));
  assert.deepEqual(verified.bytes, raw);

  for (const suffix of [Buffer.from([0xc0, 0xaf]), Buffer.from([0xe0, 0x80, 0xaf])]) {
    const malformed = Buffer.concat([Buffer.from(validHandover), suffix]);
    const malformedStat = regularStat(malformed.length);
    const malformedFile = fakeHandle({ content: malformed, stat: malformedStat });
    await assert.rejects(() => readAndValidateHandover({
      filePath: "handover.md",
      openFlags: 0,
      openFile: async () => malformedFile.handle,
      lstatPath: async () => malformedStat,
    }), /handover is not valid UTF-8/);
  }
});

test("same-handle handover validation enforces POSIX owner and write permissions", async () => {
  for (const [stat, expected] of [
    [{ ...regularStat(), uid: 502 }, /handover has unsafe owner/],
    [{ ...regularStat(), mode: 0o100620 }, /handover has unsafe permissions/],
  ]) {
    const file = fakeHandle({ content: Buffer.from(validHandover), stat });
    await assert.rejects(() => readAndValidateHandover({
      filePath: "handover.md",
      openFlags: 0,
      openFile: async () => file.handle,
      lstatPath: async () => stat,
      uid: 501,
    }), expected);
  }

  const nonPosixStat = { ...regularStat(), uid: 502, mode: 0o100666 };
  const nonPosixFile = fakeHandle({ content: Buffer.from(validHandover), stat: nonPosixStat });
  await assert.doesNotReject(() => readAndValidateHandover({
    filePath: "handover.md",
    openFlags: 0,
    openFile: async () => nonPosixFile.handle,
    lstatPath: async () => nonPosixStat,
    uid: undefined,
  }));
});

test("secure-directory validation enforces POSIX owner and write permissions only when available", () => {
  assert.deepEqual(
    validateSecureDirectoryStat({ stat: directoryStat(), label: "workspace", uid: 501 }),
    { dev: 1, ino: 2 },
  );
  assert.throws(
    () => validateSecureDirectoryStat({ stat: directoryStat({ uid: 502 }), label: "workspace", uid: 501 }),
    /workspace has unsafe owner/,
  );
  assert.throws(
    () => validateSecureDirectoryStat({ stat: directoryStat({ mode: 0o40720 }), label: "workspace", uid: 501 }),
    /workspace has unsafe permissions/,
  );
  assert.doesNotThrow(() => validateSecureDirectoryStat({
    stat: directoryStat({ uid: 502, mode: 0o40777 }),
    label: "workspace",
    uid: undefined,
  }));
});

test("approval-file validation binds POSIX mode, owner, and inode", () => {
  const approval = { ...validApproval(), approval_dev: 7, approval_ino: 8 };
  const stat = { ...regularStat(), dev: 7, ino: 8, uid: 501, mode: 0o100600 };
  assert.doesNotThrow(() => validateApprovalFileStat({ approval, stat, uid: 501 }));
  assert.throws(
    () => validateApprovalFileStat({ approval, stat: { ...stat, uid: 502 }, uid: 501 }),
    /approval has unsafe owner/,
  );
  assert.throws(
    () => validateApprovalFileStat({ approval, stat: { ...stat, mode: 0o100644 }, uid: 501 }),
    /approval has unsafe permissions/,
  );
  assert.throws(
    () => validateApprovalFileStat({ approval, stat: { ...stat, ino: 9 }, uid: 501 }),
    /approval file identity mismatch/,
  );
  assert.throws(
    () => validateApprovalFileStat({ approval, stat: { ...stat, ino: 9 }, uid: undefined }),
    /approval file identity mismatch/,
  );
});

test("handover document validation preserves regular-file, size, and heading failures", () => {
  assert.throws(
    () => validateHandoverDocument({
      content: validHandover,
      stat: { ...regularStat(), isFile: () => false },
    }),
    { message: "handover is not a regular file" },
  );
  assert.throws(
    () => validateHandoverDocument({
      content: validHandover,
      stat: { ...regularStat(), isSymbolicLink: () => true },
    }),
    { message: "handover is not a regular file" },
  );
  assert.throws(
    () => validateHandoverDocument({ content: validHandover, stat: regularStat(MAX_HANDOVER_BYTES + 1) }),
    { message: "handover exceeds model-visible context allowance" },
  );
  assert.throws(
    () => validateHandoverDocument({
      content: validHandover.replace("## Stop condition\n", ""),
      stat: regularStat(),
    }),
    { message: "handover is missing ## Stop condition" },
  );
});

test("approval validation accepts a matching current approval", () => {
  assert.doesNotThrow(() => validateApproval({
    approval: validApproval(),
    source: "compact",
    digest: digestFor(validHandover),
    now: Date.parse("2026-08-27T00:05:00.000Z"),
  }));
});

test("approval validation preserves schema, action, and timestamp failures", () => {
  const base = {
    source: "compact",
    digest: digestFor(validHandover),
    now: Date.parse("2026-08-27T00:05:00.000Z"),
  };
  assert.throws(
    () => validateApproval({ ...base, approval: { ...validApproval(), schema: "other" } }),
    { message: "unknown approval schema" },
  );
  assert.throws(
    () => validateApproval({ ...base, approval: validApproval({ action: "clear" }) }),
    { message: "approved action does not match session transition" },
  );
  assert.throws(
    () => validateApproval({ ...base, approval: validApproval({ createdAt: "not-a-date" }) }),
    { message: "invalid approval timestamps" },
  );
  assert.throws(
    () => validateApproval({
      ...base,
      approval: validApproval({ expiresAt: "2026-08-27T00:15:00.001Z" }),
    }),
    { message: "approval window exceeds 15 minutes" },
  );
});

test("approval validation preserves current-window and digest failures", () => {
  const digest = digestFor(validHandover);
  const base = { source: "compact", digest };
  assert.throws(
    () => validateApproval({
      ...base,
      approval: validApproval(),
      now: Date.parse("2026-08-26T23:58:59.999Z"),
    }),
    { message: "approval is not currently valid" },
  );
  assert.throws(
    () => validateApproval({
      ...base,
      approval: validApproval(),
      now: Date.parse("2026-08-27T00:10:00.001Z"),
    }),
    { message: "approval is not currently valid" },
  );
  assert.throws(
    () => validateApproval({
      ...base,
      approval: validApproval({ digest: "not-a-digest" }),
      now: Date.parse("2026-08-27T00:05:00.000Z"),
    }),
    { message: "handover checksum mismatch" },
  );
  assert.throws(
    () => validateApproval({
      ...base,
      approval: validApproval({ digest: "0".repeat(64) }),
      now: Date.parse("2026-08-27T00:05:00.000Z"),
    }),
    { message: "handover checksum mismatch" },
  );
});

test("buildApproval creates a bounded approval record", () => {
  assert.deepEqual(buildApproval({
    action: "clear",
    handover: validHandover,
    now: Date.parse("2026-08-27T00:00:00.000Z"),
    ttlMs: 60_000,
  }), {
    schema: "ai-safe-driver-handover-v1",
    action: "clear",
    created_at: "2026-08-27T00:00:00.000Z",
    expires_at: "2026-08-27T00:01:00.000Z",
    handover_sha256: digestFor(validHandover),
  });
  assert.throws(() => buildApproval({ action: "retry", handover: validHandover }), /invalid handover action/);
  assert.throws(() => buildApproval({ action: "compact", handover: validHandover, ttlMs: 0 }), /invalid approval window/);
  assert.throws(
    () => buildApproval({ action: "compact", handover: validHandover, ttlMs: 15 * 60 * 1000 + 1 }),
    /invalid approval window/,
  );
});

const approvalFileStat = (size = 0) => ({
  ...regularStat(size),
  dev: 7,
  ino: 8,
  uid: 501,
  mode: 0o100600,
});

const approvalWriter = ({ failAt } = {}) => {
  const events = [];
  let raw = "";
  let size = 0;
  const handle = {
    stat: async () => approvalFileStat(size),
    chmod: async (mode) => {
      events.push(`chmod:${mode.toString(8)}`);
      if (failAt === "chmod") throw new Error("chmod failed");
    },
    writeFile: async (content) => {
      events.push("write");
      if (failAt === "write") throw new Error("write failed");
      raw = content;
      size = Buffer.byteLength(content);
    },
    sync: async () => {
      events.push("sync");
      if (failAt === "sync") throw new Error("sync failed");
    },
    close: async () => {
      events.push("close");
      if (failAt === "close") throw new Error("close failed");
    },
  };
  return {
    handle,
    events,
    getRaw: () => raw,
    getStat: () => approvalFileStat(size),
  };
};

test("approval is fully prepared on a private inode before exclusive final-name publication", async () => {
  const file = approvalWriter();
  const events = [];
  const result = await writeExclusiveApproval({
    armedPath: ".state/armed.json",
    privatePath: ".state/.armed-unpredictable.tmp",
    approval: validApproval(),
    openFile: async (filePath, flags, mode) => {
      assert.deepEqual([filePath, flags, mode], [".state/.armed-unpredictable.tmp", "wx", 0o600]);
      return file.handle;
    },
    linkFile: async (source, destination) => {
      events.push("link");
      assert.deepEqual([source, destination], [".state/.armed-unpredictable.tmp", ".state/armed.json"]);
      assert.deepEqual(file.events, ["chmod:600", "write", "sync", "close"]);
    },
    unlinkFile: async (filePath) => { events.push(`unlink:${filePath}`); },
    lstatPath: async () => file.getStat(),
    finalOpenFlags: "read-no-follow",
    validateBoundary: async () => { events.push("boundary"); },
    uid: 501,
  });

  const persisted = JSON.parse(file.getRaw());
  assert.equal(persisted.approval_dev, 7);
  assert.equal(persisted.approval_ino, 8);
  assert.equal(result.approval_dev, 7);
  assert.equal(result.approval_ino, 8);
  assert.deepEqual(events, [
    "boundary",
    "boundary",
    "link",
    "unlink:.state/.armed-unpredictable.tmp",
  ]);
});

test("every pre-publication failure leaves the final approval name absent", async () => {
  for (const failAt of ["chmod", "write", "sync", "close", "boundary", "link"]) {
    const file = approvalWriter({ failAt: failAt === "boundary" || failAt === "link" ? undefined : failAt });
    let finalVisible = false;
    let privateRemoved = false;
    let boundaryCalls = 0;
    const failure = Object.assign(new Error(`${failAt} failed`), failAt === "link" ? { code: "EIO" } : {});

    await assert.rejects(() => writeExclusiveApproval({
      armedPath: "armed.json",
      privatePath: ".armed-private.tmp",
      approval: validApproval(),
      openFile: async () => file.handle,
      linkFile: async () => {
        if (failAt === "link") throw failure;
        finalVisible = true;
      },
      unlinkFile: async () => { privateRemoved = true; },
      lstatPath: async (filePath) => {
        if (filePath === "armed.json") throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return file.getStat();
      },
      finalOpenFlags: "read-no-follow",
      validateBoundary: async () => {
        boundaryCalls += 1;
        if (failAt === "boundary" && boundaryCalls === 2) throw failure;
      },
      uid: 501,
    }), /approval could not be persisted/);

    assert.equal(finalVisible, false, failAt);
    assert.equal(privateRemoved, true, failAt);
  }
});

test("exclusive publication never overwrites armed.json and post-commit cleanup is best effort", async () => {
  const existing = approvalWriter();
  const replacement = { ...existing.getStat(), ino: 9 };
  const existsError = Object.assign(new Error("exists"), { code: "EEXIST" });
  let privateRemoved = false;
  await assert.rejects(() => writeExclusiveApproval({
    armedPath: "armed.json",
    privatePath: ".armed-private.tmp",
    approval: validApproval(),
    openFile: async () => existing.handle,
    linkFile: async () => { throw existsError; },
    unlinkFile: async () => { privateRemoved = true; },
    lstatPath: async (filePath) => filePath === "armed.json" ? replacement : existing.getStat(),
    finalOpenFlags: "read-no-follow",
    validateBoundary: async () => {},
    uid: 501,
  }), (error) => error.code === "EEXIST");
  assert.equal(privateRemoved, true);

  const committed = approvalWriter();
  let linked = false;
  await assert.doesNotReject(() => writeExclusiveApproval({
    armedPath: "armed.json",
    privatePath: ".armed-private.tmp",
    approval: validApproval(),
    openFile: async () => committed.handle,
    linkFile: async () => { linked = true; },
    unlinkFile: async () => { throw new Error("private cleanup failed"); },
    lstatPath: async () => committed.getStat(),
    finalOpenFlags: "read-no-follow",
    validateBoundary: async () => {},
    uid: 501,
  }));
  assert.equal(linked, true);
});

test("link-created-then-error is recovered as a committed publication", async () => {
  const file = approvalWriter();
  let finalNode;
  let privateRemoved = false;
  const makeReader = () => {
    let position = 0;
    return {
      stat: async () => file.getStat(),
      read: async (target, offset, length) => {
        const bytes = Buffer.from(finalNode);
        const bytesRead = bytes.copy(target, offset, position, position + length);
        position += bytesRead;
        return { bytesRead, buffer: target };
      },
      close: async () => {},
    };
  };

  const result = await writeExclusiveApproval({
    armedPath: "armed.json",
    privatePath: ".armed-private.tmp",
    approval: validApproval(),
    openFile: async (filePath, flags) => flags === "wx" ? file.handle : makeReader(),
    linkFile: async () => {
      finalNode = file.getRaw();
      throw Object.assign(new Error("link reply lost"), { code: "EIO" });
    },
    unlinkFile: async () => { privateRemoved = true; },
    lstatPath: async (filePath) => {
      if (filePath === "armed.json" && finalNode === undefined) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return file.getStat();
    },
    finalOpenFlags: "read-no-follow",
    validateBoundary: async () => {},
    uid: 501,
  });

  assert.equal(result.approval_ino, 8);
  assert.equal(privateRemoved, true);
  assert.notEqual(finalNode, undefined);
});

test("source or cleanup replacement is never linked or unlinked", async () => {
  const file = approvalWriter();
  const replacement = { ...file.getStat(), ino: 9 };
  let linked = false;
  let unlinked = false;

  await assert.rejects(() => writeExclusiveApproval({
    armedPath: "armed.json",
    privatePath: ".armed-private.tmp",
    approval: validApproval(),
    openFile: async () => file.handle,
    linkFile: async () => { linked = true; },
    unlinkFile: async () => { unlinked = true; },
    lstatPath: async () => replacement,
    finalOpenFlags: "read-no-follow",
    validateBoundary: async () => {},
    uid: 501,
  }), /approval could not be persisted/);

  assert.equal(linked, false);
  assert.equal(unlinked, false);
});

test("a staged consumer cannot open the final name while producer persistence is paused", async () => {
  const nodes = new Map();
  let releaseSync;
  let reachedSync;
  const syncReached = new Promise((resolve) => { reachedSync = resolve; });
  const syncRelease = new Promise((resolve) => { releaseSync = resolve; });
  const statFor = (node) => approvalFileStat(Buffer.byteLength(node.raw));
  const makeReader = (node) => {
    let position = 0;
    return {
      stat: async () => statFor(node),
      read: async (target, offset, length) => {
        const content = Buffer.from(node.raw);
        const bytesRead = content.copy(target, offset, position, position + length);
        position += bytesRead;
        return { bytesRead, buffer: target };
      },
      close: async () => {},
    };
  };
  const node = { raw: "" };
  const writerHandle = {
    stat: async () => statFor(node),
    chmod: async () => {},
    writeFile: async (raw) => { node.raw = raw; },
    sync: async () => { reachedSync(); await syncRelease; },
    close: async () => {},
  };
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const openFile = async (filePath, flags) => {
    if (flags === "wx") {
      nodes.set(filePath, node);
      return writerHandle;
    }
    const opened = nodes.get(filePath);
    if (!opened) throw missing();
    return makeReader(opened);
  };
  const lstatPath = async (filePath) => {
    const opened = nodes.get(filePath);
    if (!opened) throw missing();
    return statFor(opened);
  };

  const writing = writeExclusiveApproval({
    armedPath: "armed.json",
    privatePath: ".armed-private.tmp",
    approval: validApproval(),
    openFile,
    linkFile: async (source, destination) => {
      if (nodes.has(destination)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      nodes.set(destination, nodes.get(source));
    },
    unlinkFile: async (filePath) => { nodes.delete(filePath); },
    lstatPath,
    finalOpenFlags: "read-no-follow",
    validateBoundary: async () => {},
    uid: 501,
  });

  await syncReached;
  let premature;
  try {
    premature = await readBoundedRegularFile({
      filePath: "armed.json",
      label: "approval",
      maxBytes: MAX_APPROVAL_BYTES,
      openFlags: "read",
      openFile,
      lstatPath,
    });
  } catch (error) {
    assert.equal(error.code, "ENOENT");
  } finally {
    releaseSync();
  }
  await writing;
  assert.equal(premature, undefined);

  const published = await readBoundedRegularFile({
    filePath: "armed.json",
    label: "approval",
    maxBytes: MAX_APPROVAL_BYTES,
    openFlags: "read",
    openFile,
    lstatPath,
  });
  assert.equal(JSON.parse(published.bytes).approval_ino, 8);
});

test("failed emission does not consume approval", async () => {
  let consumed = false;
  await assert.rejects(() => deliverThenConsume({
    payload: "context",
    emit: async () => { throw new Error("broken pipe"); },
    consume: async () => { consumed = true; },
  }), /broken pipe/);
  assert.equal(consumed, false);
});

test("successful emission consumes approval afterward", async () => {
  const order = [];
  await deliverThenConsume({
    payload: "context",
    emit: async () => { order.push("emit"); },
    consume: async () => { order.push("consume"); },
  });
  assert.deepEqual(order, ["emit", "consume"]);
});
