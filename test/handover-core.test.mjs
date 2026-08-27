import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MAX_APPROVAL_BYTES,
  MAX_HANDOVER_BYTES,
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
const regularStat = (size = Buffer.byteLength(validHandover)) => ({
  dev: 1,
  ino: 2,
  size,
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

test("handover cap is six KiB for both host output limits", () => {
  assert.equal(MAX_HANDOVER_BYTES, 6 * 1024);
});

test("approval input cap is four KiB", () => {
  assert.equal(MAX_APPROVAL_BYTES, 4 * 1024);
});

const fakeHandle = ({ content, stat, onRead = () => {} }) => {
  let position = 0;
  let closed = false;
  return {
    handle: {
      stat: async () => stat,
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
    { message: "handover exceeds 6 KiB" },
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

const persistenceHandle = ({ failAt, stat }) => {
  let invalidated = false;
  let closeCalls = 0;
  let chmodCalls = 0;
  let syncCalls = 0;
  return {
    handle: {
      stat: async () => stat,
      chmod: async () => {
        chmodCalls += 1;
        if (failAt === "chmod" && chmodCalls === 1) throw new Error("chmod failed");
        if (failAt === "final-chmod" && chmodCalls === 3) throw new Error("final chmod failed");
      },
      writeFile: async () => { if (failAt === "write") throw new Error("write failed"); },
      sync: async () => {
        syncCalls += 1;
        if (failAt === "sync" && syncCalls === 1) throw new Error("sync failed");
        if (failAt === "final-sync" && syncCalls === 2) throw new Error("final sync failed");
      },
      close: async () => {
        closeCalls += 1;
        if (failAt === "close" && closeCalls === 1) throw new Error("close failed");
      },
      truncate: async () => { invalidated = true; },
    },
    wasInvalidated: () => invalidated,
  };
};

test("exclusive approval persistence removes or invalidates its own inode on every post-create failure", async () => {
  for (const failAt of ["chmod", "write", "sync", "final-chmod", "close"]) {
    const stat = { ...regularStat(0), dev: 7, ino: 8, uid: 501, mode: 0o100600 };
    const file = persistenceHandle({ failAt, stat });
    let removed = false;
    await assert.rejects(() => writeExclusiveApproval({
      armedPath: "armed.json",
      approval: validApproval(),
      openFile: async () => file.handle,
      lstatPath: async () => stat,
      unlinkPath: async () => { removed = true; },
      validateBoundary: async () => {},
      uid: 501,
    }), /approval could not be persisted/);
    assert.equal(file.wasInvalidated(), true, failAt);
    assert.equal(removed, false, `${failAt} must not use pathname unlink cleanup`);
  }
});

test("approval is published only after every fallible persistence gate", async () => {
  const stat = { ...regularStat(0), dev: 7, ino: 8, uid: 501, mode: 0o100600 };
  const file = persistenceHandle({ stat });
  const modes = [];
  file.handle.chmod = async (mode) => { modes.push(mode); };
  let checks = 0;

  await assert.rejects(() => writeExclusiveApproval({
    armedPath: "armed.json",
    approval: validApproval(),
    openFile: async () => file.handle,
    validateBoundary: async () => {
      checks += 1;
      if (checks === 2) throw new Error("late boundary failure");
    },
    uid: 501,
  }), /approval could not be persisted/);

  assert.equal(modes.filter((mode) => mode === 0o600).length, 1);
  assert.equal(file.wasInvalidated(), true);
});

test("failed persistence never deletes a replacement inode", async () => {
  const created = { ...regularStat(0), dev: 7, ino: 8, uid: 501, mode: 0o100600 };
  const replacement = { ...created, ino: 9 };
  const file = persistenceHandle({ failAt: "sync", stat: created });
  let removed = false;

  await assert.rejects(() => writeExclusiveApproval({
    armedPath: "armed.json",
    approval: validApproval(),
    openFile: async () => file.handle,
    lstatPath: async () => replacement,
    unlinkPath: async () => { removed = true; },
    validateBoundary: async () => {},
    uid: 501,
  }), /approval could not be persisted/);

  assert.equal(removed, false);
  assert.equal(file.wasInvalidated(), true);
});

test("cleanup reopens and invalidates only the created inode when the original handle cannot clean up", async () => {
  const created = { ...regularStat(0), dev: 7, ino: 8, uid: 501, mode: 0o100600 };
  const primary = persistenceHandle({ failAt: "sync", stat: created });
  primary.handle.truncate = async () => { throw new Error("primary handle unavailable"); };
  const cleanup = persistenceHandle({ stat: created });
  const cleanupModes = [];
  cleanup.handle.chmod = async (mode) => { cleanupModes.push(mode); };
  let openCalls = 0;
  let removed = false;

  await assert.rejects(() => writeExclusiveApproval({
    armedPath: "armed.json",
    approval: validApproval(),
    openFile: async () => {
      openCalls += 1;
      return openCalls === 1 ? primary.handle : cleanup.handle;
    },
    lstatPath: async () => created,
    unlinkPath: async () => { removed = true; },
    validateBoundary: async () => {},
    uid: 501,
  }), /approval could not be persisted/);

  assert.equal(openCalls, 2);
  assert.deepEqual(cleanupModes, [0o000]);
  assert.equal(cleanup.wasInvalidated(), true);
  assert.equal(removed, false);
});

test("cleanup failure is surfaced instead of being swallowed", async () => {
  const created = { ...regularStat(0), dev: 7, ino: 8, uid: 501, mode: 0o100600 };
  const primary = persistenceHandle({ failAt: "sync", stat: created });
  primary.handle.truncate = async () => { throw new Error("primary cleanup failed"); };
  let openCalls = 0;

  await assert.rejects(() => writeExclusiveApproval({
    armedPath: "armed.json",
    approval: validApproval(),
    openFile: async () => {
      openCalls += 1;
      if (openCalls === 1) return primary.handle;
      throw new Error("cleanup reopen failed");
    },
    lstatPath: async () => created,
    unlinkPath: async () => { throw new Error("must not unlink"); },
    validateBoundary: async () => {},
    uid: 501,
  }), /approval could not be safely invalidated/);
});

test("cleanup identity mismatch is surfaced instead of treated as safe invalidation", async () => {
  const created = { ...regularStat(0), dev: 7, ino: 8, uid: 501, mode: 0o100600 };
  const replacement = { ...created, ino: 9 };
  const primary = persistenceHandle({ failAt: "sync", stat: created });
  primary.handle.truncate = async () => { throw new Error("primary cleanup failed"); };
  const cleanup = persistenceHandle({ stat: replacement });
  let openCalls = 0;

  await assert.rejects(() => writeExclusiveApproval({
    armedPath: "armed.json",
    approval: validApproval(),
    openFile: async () => {
      openCalls += 1;
      return openCalls === 1 ? primary.handle : cleanup.handle;
    },
    validateBoundary: async () => {},
    uid: 501,
  }), /approval could not be safely invalidated/);

  assert.equal(cleanup.wasInvalidated(), false);
});

test("initial stat failure neutralizes and closes the exclusively created file", async () => {
  const file = persistenceHandle({ stat: regularStat(0) });
  let closeCalls = 0;
  file.handle.stat = async () => { throw new Error("stat failed"); };
  file.handle.close = async () => { closeCalls += 1; };

  await assert.rejects(() => writeExclusiveApproval({
    armedPath: "armed.json",
    approval: validApproval(),
    openFile: async () => file.handle,
    validateBoundary: async () => {},
    uid: 501,
  }), /approval could not be persisted/);

  assert.equal(file.wasInvalidated(), true);
  assert.equal(closeCalls, 1);
});

test("directory replacement during persistence invalidates the created approval", async () => {
  const stat = { ...regularStat(0), dev: 7, ino: 8, uid: 501, mode: 0o100600 };
  const file = persistenceHandle({ stat });
  let checks = 0;
  let removed = false;

  await assert.rejects(() => writeExclusiveApproval({
    armedPath: "armed.json",
    approval: validApproval(),
    openFile: async () => file.handle,
    lstatPath: async () => stat,
    unlinkPath: async () => { removed = true; },
    validateBoundary: async () => {
      checks += 1;
      if (checks === 2) throw new Error("handover directory identity changed");
    },
    uid: 501,
  }), /approval could not be persisted/);

  assert.equal(removed || file.wasInvalidated(), true);
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
