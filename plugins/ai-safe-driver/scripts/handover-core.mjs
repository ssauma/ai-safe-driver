import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const MAX_HANDOVER_BYTES = 6 * 1024;
export const MAX_APPROVAL_BYTES = 4 * 1024;

const capReason = (label, maxBytes) => `${label} exceeds ${maxBytes / 1024} KiB`;
const regularFileReason = (label) => `${label} is not a regular file`;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameStableFileStat = (left, right) => sameIdentity(left, right)
  && left.size === right.size
  && left.mode === right.mode
  && left.uid === right.uid
  && left.mtimeMs === right.mtimeMs
  && left.ctimeMs === right.ctimeMs;

export const readBoundedRegularFile = async ({
  filePath,
  label,
  maxBytes,
  openFlags,
  openFile,
  lstatPath,
}) => {
  const preOpenStat = await lstatPath(filePath);
  if (!preOpenStat.isFile() || preOpenStat.isSymbolicLink()) {
    throw new Error(regularFileReason(label));
  }

  let handle;
  try {
    handle = await openFile(filePath, openFlags);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") {
      throw new Error(regularFileReason(label));
    }
    throw error;
  }

  try {
    const openedStat = await handle.stat();
    const postOpenStat = await lstatPath(filePath);
    if (
      !openedStat.isFile()
      || !postOpenStat.isFile()
      || postOpenStat.isSymbolicLink()
      || openedStat.dev !== preOpenStat.dev
      || openedStat.ino !== preOpenStat.ino
      || openedStat.dev !== postOpenStat.dev
      || openedStat.ino !== postOpenStat.ino
    ) {
      throw new Error(regularFileReason(label));
    }
    if (openedStat.size > maxBytes) throw new Error(capReason(label, maxBytes));

    const chunks = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(4096, maxBytes + 1 - totalBytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > maxBytes) throw new Error(capReason(label, maxBytes));

    const bytes = Buffer.concat(chunks, totalBytes);
    const afterReadStat = await handle.stat();
    const postReadStat = await lstatPath(filePath);
    if (
      !afterReadStat.isFile()
      || !postReadStat.isFile()
      || postReadStat.isSymbolicLink()
      || !sameStableFileStat(openedStat, afterReadStat)
      || !sameStableFileStat(openedStat, postReadStat)
      || bytes.length !== openedStat.size
    ) {
      throw new Error(`${label} changed during read`);
    }

    return { bytes, stat: afterReadStat };
  } finally {
    await handle.close();
  }
};

const SCHEMA = "ai-safe-driver-handover-v1";
const REQUIRED_HEADINGS = [
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

export const validateHandoverStat = (stat, uid) => {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("handover is not a regular file");
  }
  if (stat.size > MAX_HANDOVER_BYTES) {
    throw new Error("handover exceeds 6 KiB");
  }
  if (uid !== undefined) {
    if (stat.uid !== uid) throw new Error("handover has unsafe owner");
    if ((stat.mode & 0o022) !== 0) throw new Error("handover has unsafe permissions");
  }
};

export const validateHandoverDocument = ({
  content,
  stat,
  bytes = Buffer.from(content, "utf8"),
  uid,
}) => {
  validateHandoverStat(stat, uid);

  for (const heading of REQUIRED_HEADINGS) {
    if (!content.includes(`${heading}\n`)) throw new Error(`handover is missing ${heading}`);
  }

  return {
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
};

export const readAndValidateHandover = async ({
  filePath,
  openFlags,
  openFile,
  lstatPath,
  uid,
}) => {
  const file = await readBoundedRegularFile({
    filePath,
    label: "handover",
    maxBytes: MAX_HANDOVER_BYTES,
    openFlags,
    openFile,
    lstatPath,
  });
  let content;
  try {
    content = utf8Decoder.decode(file.bytes);
  } catch {
    throw new Error("handover is not valid UTF-8");
  }
  return {
    bytes: file.bytes,
    content,
    stat: file.stat,
    ...validateHandoverDocument({ content, stat: file.stat, bytes: file.bytes, uid }),
  };
};

export const validateSecureDirectoryStat = ({ stat, label, uid }) => {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular directory`);
  }
  if (uid !== undefined) {
    if (stat.uid !== uid) throw new Error(`${label} has unsafe owner`);
    if ((stat.mode & 0o022) !== 0) throw new Error(`${label} has unsafe permissions`);
  }
  return { dev: stat.dev, ino: stat.ino };
};

export const captureSecureDirectoryBoundary = async ({
  workspacePath,
  statePath,
  lstatPath,
  uid,
}) => {
  const [workspaceStat, stateStat] = await Promise.all([
    lstatPath(workspacePath),
    lstatPath(statePath),
  ]);
  return {
    workspace: validateSecureDirectoryStat({ stat: workspaceStat, label: "workspace", uid }),
    state: validateSecureDirectoryStat({ stat: stateStat, label: "handover directory", uid }),
  };
};

export const assertSecureDirectoryBoundary = async ({
  boundary,
  workspacePath,
  statePath,
  lstatPath,
  uid,
}) => {
  const current = await captureSecureDirectoryBoundary({ workspacePath, statePath, lstatPath, uid });
  if (!sameIdentity(boundary.workspace, current.workspace)) {
    throw new Error("workspace identity changed");
  }
  if (!sameIdentity(boundary.state, current.state)) {
    throw new Error("handover directory identity changed");
  }
};

export const validateApprovalFileStat = ({ approval, stat, uid }) => {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("approval is not a regular file");
  if (uid !== undefined) {
    if (stat.uid !== uid) throw new Error("approval has unsafe owner");
    if ((stat.mode & 0o777) !== 0o600) throw new Error("approval has unsafe permissions");
  }
  if (
    !Number.isFinite(approval.approval_dev)
    || !Number.isFinite(approval.approval_ino)
    || approval.approval_dev !== stat.dev
    || approval.approval_ino !== stat.ino
  ) {
    throw new Error("approval file identity mismatch");
  }
};

const isMissing = (error) => error
  && typeof error === "object"
  && "code" in error
  && error.code === "ENOENT";

const unlinkPrivateIfOwned = async ({
  privatePath,
  identity,
  lstatPath,
  unlinkFile,
}) => {
  if (!identity) return;
  try {
    const current = await lstatPath(privatePath);
    if (
      current.isFile()
      && !current.isSymbolicLink()
      && sameIdentity(identity, current)
    ) {
      await unlinkFile(privatePath);
    }
  } catch (error) {
    if (!isMissing(error)) {
      // Private-name cleanup is best effort and never widens to another inode.
    }
  }
};

const finalNameMatches = async ({
  armedPath,
  identity,
  finalOpenFlags,
  openFile,
  lstatPath,
}) => {
  let handle;
  try {
    const before = await lstatPath(armedPath);
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || !sameIdentity(identity, before)
    ) return false;
    handle = await openFile(armedPath, finalOpenFlags);
    const opened = await handle.stat();
    const after = await lstatPath(armedPath);
    return opened.isFile()
      && after.isFile()
      && !after.isSymbolicLink()
      && sameIdentity(identity, opened)
      && sameIdentity(identity, after);
  } catch {
    return false;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Identity inspection already completed or failed closed.
      }
    }
  }
};

export const writeExclusiveApproval = async ({
  armedPath,
  privatePath,
  approval,
  openFile,
  linkFile,
  unlinkFile,
  lstatPath,
  finalOpenFlags,
  validateBoundary,
  uid,
}) => {
  let handle;
  let created = false;
  let closed = false;
  let published = false;
  let identity;
  let persistedApproval;
  try {
    await validateBoundary();
    handle = await openFile(privatePath, "wx", 0o600);
    created = true;
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("approval is not a regular file");
    identity = { dev: stat.dev, ino: stat.ino };
    await handle.chmod(0o600);
    const securedStat = await handle.stat();
    if (!securedStat.isFile() || !sameIdentity(stat, securedStat)) {
      throw new Error("approval file identity changed");
    }
    if (uid !== undefined) {
      if (securedStat.uid !== uid) throw new Error("approval has unsafe owner");
      if ((securedStat.mode & 0o777) !== 0o600) {
        throw new Error("approval has unsafe permissions");
      }
    }
    persistedApproval = {
      ...approval,
      approval_dev: securedStat.dev,
      approval_ino: securedStat.ino,
    };
    const rawApproval = `${JSON.stringify(persistedApproval)}\n`;
    await handle.writeFile(rawApproval, "utf8");
    await handle.sync();
    const preparedStat = await handle.stat();
    if (
      !preparedStat.isFile()
      || !sameIdentity(identity, preparedStat)
      || preparedStat.size !== Buffer.byteLength(rawApproval)
    ) {
      throw new Error("approval changed during persistence");
    }
    if (uid !== undefined) {
      if (preparedStat.uid !== uid) throw new Error("approval has unsafe owner");
      if ((preparedStat.mode & 0o777) !== 0o600) {
        throw new Error("approval has unsafe permissions");
      }
    }
    await handle.close();
    closed = true;
    await validateBoundary();
    const sourceStat = await lstatPath(privatePath);
    if (
      !sourceStat.isFile()
      || sourceStat.isSymbolicLink()
      || !sameStableFileStat(preparedStat, sourceStat)
    ) {
      throw new Error("approval private file identity changed");
    }
    try {
      await linkFile(privatePath, armedPath);
      published = true;
    } catch (linkError) {
      published = await finalNameMatches({
        armedPath,
        identity,
        finalOpenFlags,
        openFile,
        lstatPath,
      });
      if (!published) throw linkError;
    }
    await unlinkPrivateIfOwned({ privatePath, identity, lstatPath, unlinkFile });
    return persistedApproval;
  } catch (error) {
    if (handle && !closed) {
      try {
        await handle.close();
      } catch {
        // No final name exists before publication; cleanup continues by private name.
      }
    }
    if (created && !published) {
      await unlinkPrivateIfOwned({ privatePath, identity, lstatPath, unlinkFile });
    }
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw error;
    }
    throw new Error("approval could not be persisted", { cause: error });
  }
};

export const unlinkSameFile = async ({ filePath, identity, lstatPath, unlinkPath }) => {
  const current = await lstatPath(filePath);
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || !sameIdentity(identity, current)
  ) {
    throw new Error("approval file identity mismatch");
  }
  await unlinkPath(filePath);
};

export const validateApproval = ({ approval, source, digest, now }) => {
  const createdAt = Date.parse(approval.created_at);
  const expiresAt = Date.parse(approval.expires_at);

  if (approval.schema !== SCHEMA) throw new Error("unknown approval schema");
  if (approval.action !== source) throw new Error("approved action does not match session transition");
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) throw new Error("invalid approval timestamps");
  if (expiresAt <= createdAt || expiresAt - createdAt > 15 * 60 * 1000) {
    throw new Error("approval window exceeds 15 minutes");
  }
  if (now < createdAt - 60_000 || now > expiresAt) throw new Error("approval is not currently valid");
  if (!/^[a-f0-9]{64}$/.test(approval.handover_sha256) || approval.handover_sha256 !== digest) {
    throw new Error("handover checksum mismatch");
  }
};

export const buildApproval = ({
  action,
  handover,
  handoverBytes,
  now = Date.now(),
  ttlMs = 10 * 60 * 1000,
}) => {
  if (action !== "compact" && action !== "clear") throw new Error("invalid handover action");
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60 * 1000) {
    throw new Error("invalid approval window");
  }
  return {
    schema: SCHEMA,
    action,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
    handover_sha256: createHash("sha256").update(
      handoverBytes ?? Buffer.from(handover, "utf8"),
    ).digest("hex"),
  };
};

export const deliverThenConsume = async ({ payload, emit, consume }) => {
  await emit(payload);
  await consume();
};
