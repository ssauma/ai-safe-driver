import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const MAX_HANDOVER_BYTES = 6 * 1024;
export const MAX_APPROVAL_BYTES = 4 * 1024;

const capReason = (label, maxBytes) => `${label} exceeds ${maxBytes / 1024} KiB`;
const regularFileReason = (label) => `${label} is not a regular file`;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;

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

    return { bytes: Buffer.concat(chunks, totalBytes), stat: openedStat };
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

export const validateHandoverStat = (stat) => {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("handover is not a regular file");
  }
  if (stat.size > MAX_HANDOVER_BYTES) {
    throw new Error("handover exceeds 6 KiB");
  }
};

export const validateHandoverDocument = ({ content, stat, bytes = Buffer.from(content, "utf8") }) => {
  validateHandoverStat(stat);

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
    ...validateHandoverDocument({ content, stat: file.stat, bytes: file.bytes }),
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
  if (uid === undefined) return;
  if (stat.uid !== uid) throw new Error("approval has unsafe owner");
  if ((stat.mode & 0o777) !== 0o600) throw new Error("approval has unsafe permissions");
  if (
    !Number.isFinite(approval.approval_dev)
    || !Number.isFinite(approval.approval_ino)
    || approval.approval_dev !== stat.dev
    || approval.approval_ino !== stat.ino
  ) {
    throw new Error("approval file identity mismatch");
  }
};

const invalidateHandle = async (handle) => {
  await handle.chmod(0o000);
  await handle.truncate(0);
  await handle.sync();
};

const invalidateCreatedFile = async ({
  handle,
  fallbackHandle,
  identity,
  armedPath,
  openFile,
  cleanupOpenFlags,
}) => {
  try {
    await invalidateHandle(handle);
    return;
  } catch (primaryError) {
    // A close failure can leave the original descriptor unusable; reopen and fstat before mutation.
    if (!identity) {
      throw new Error("approval could not be safely invalidated", { cause: primaryError });
    }
  }

  if (fallbackHandle) {
    try {
      const fallbackStat = await fallbackHandle.stat();
      if (!fallbackStat.isFile() || !sameIdentity(identity, fallbackStat)) {
        throw new Error("approval cleanup identity mismatch");
      }
      await invalidateHandle(fallbackHandle);
      return;
    } catch (error) {
      throw new Error("approval could not be safely invalidated", { cause: error });
    }
  }

  let cleanupHandle;
  try {
    cleanupHandle = await openFile(armedPath, cleanupOpenFlags);
    const current = await cleanupHandle.stat();
    if (!current.isFile() || !sameIdentity(identity, current)) {
      throw new Error("approval cleanup identity mismatch");
    }
    await invalidateHandle(cleanupHandle);
  } catch (error) {
    throw new Error("approval could not be safely invalidated", { cause: error });
  } finally {
    if (cleanupHandle) {
      try {
        await cleanupHandle.close();
      } catch {
        // The inode was invalidated before this best-effort close.
      }
    }
  }
};

export const writeExclusiveApproval = async ({
  armedPath,
  approval,
  openFile,
  validateBoundary,
  uid,
  cleanupOpenFlags = "r+",
}) => {
  let handle;
  let publicationHandle;
  let identity;
  let closed = false;
  try {
    handle = await openFile(armedPath, "wx", 0o600);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("approval is not a regular file");
    identity = { dev: stat.dev, ino: stat.ino };
    // open(2)'s requested mode is filtered by umask; establish the promised
    // owner-only access before retaining a second descriptor for final publication.
    await handle.chmod(0o600);
    publicationHandle = await openFile(armedPath, cleanupOpenFlags);
    const publicationStat = await publicationHandle.stat();
    if (!publicationStat.isFile() || !sameIdentity(identity, publicationStat)) {
      throw new Error("approval publication identity mismatch");
    }
    await handle.chmod(0o000);
    await validateBoundary();
    const persistedApproval = uid === undefined
      ? approval
      : { ...approval, approval_dev: stat.dev, approval_ino: stat.ino };
    await handle.writeFile(`${JSON.stringify(persistedApproval)}\n`, "utf8");
    await handle.sync();
    await validateBoundary();
    await handle.close();
    closed = true;
    handle = publicationHandle;
    publicationHandle = undefined;
    closed = false;
    await validateBoundary();
    await handle.chmod(0o600);
    // Publication is the final failure gate. Closing an already-fsynced descriptor
    // cannot turn a successful approval into a reported failure.
    try {
      await handle.close();
    } catch {
      // Best-effort descriptor release after successful publication.
    }
    closed = true;
    return persistedApproval;
  } catch (error) {
    if (!handle) throw error;
    let cleanupError;
    try {
      await invalidateCreatedFile({
        handle,
        fallbackHandle: publicationHandle,
        identity,
        armedPath,
        openFile,
        cleanupOpenFlags,
      });
    } catch (failure) {
      cleanupError = failure;
    }
    if (!closed) {
      try {
        await handle.close();
      } catch {
        // Invalidation already ran; do not hide the persistence refusal.
      }
    }
    if (publicationHandle) {
      try {
        await publicationHandle.close();
      } catch {
        // Invalidation already ran; do not hide the persistence refusal.
      }
    }
    if (cleanupError) throw cleanupError;
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
