import { createHash } from "node:crypto";

export const MAX_HANDOVER_BYTES = 6 * 1024;

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

export const validateHandoverDocument = ({ content, stat }) => {
  validateHandoverStat(stat);

  for (const heading of REQUIRED_HEADINGS) {
    if (!content.includes(`${heading}\n`)) throw new Error(`handover is missing ${heading}`);
  }

  return {
    digest: createHash("sha256").update(content).digest("hex"),
  };
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

export const buildApproval = ({ action, handover, now = Date.now(), ttlMs = 10 * 60 * 1000 }) => {
  if (action !== "compact" && action !== "clear") throw new Error("invalid handover action");
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60 * 1000) {
    throw new Error("invalid approval window");
  }
  return {
    schema: SCHEMA,
    action,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
    handover_sha256: createHash("sha256").update(handover).digest("hex"),
  };
};

export const deliverThenConsume = async ({ payload, emit, consume }) => {
  await emit(payload);
  await consume();
};
