import { spawn } from "node:child_process";

const OPERATIONAL_ENVIRONMENT = [
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "CI",
  "TERM",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
];

export class HostAdapterBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "HostAdapterBlockedError";
    this.code = "HOST_ADAPTER_BLOCKED";
  }
}

export function sanitizedHostEnvironment(source, allowedCredentialNames = []) {
  const result = {};
  for (const name of [...OPERATIONAL_ENVIRONMENT, ...allowedCredentialNames]) {
    if (typeof source[name] === "string" && source[name].length > 0) result[name] = source[name];
  }
  return result;
}

export function runHostProcess({
  executable,
  args,
  input,
  env,
  cwd,
  timeoutMs,
  maxOutputBytes,
  platform = process.platform,
}) {
  if (platform === "win32") {
    throw new HostAdapterBlockedError("host adapter execution is BLOCKED on Windows");
  }
  if (typeof executable !== "string" || executable.length === 0 || !Array.isArray(args)) {
    throw new Error("host adapter command is invalid");
  }
  if (typeof input !== "string" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1
    || env === null || typeof env !== "object" || Array.isArray(env)
    || (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0))) {
    throw new Error("host adapter process bounds are invalid");
  }

  return new Promise((resolve, reject) => {
    const processGroup = true;
    const child = spawn(executable, args, {
      detached: processGroup,
      cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure = null;
    let settled = false;

    const stop = (reason) => {
      if (failure === null) failure = reason;
      if (processGroup && Number.isInteger(child.pid)) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall through to the direct-child kill if the group is already gone.
        }
      }
      child.kill("SIGKILL");
    };
    const collect = (target, chunk, stream) => {
      if (failure !== null) return;
      const bytes = Buffer.byteLength(chunk);
      if (stream === "stdout") stdoutBytes += bytes;
      else stderrBytes += bytes;
      if (stdoutBytes + stderrBytes > maxOutputBytes) {
        stop("oversized");
        return;
      }
      target.push(Buffer.from(chunk));
    };

    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("host adapter could not start"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure === "timeout") {
        reject(new Error("host adapter timed out"));
      } else if (failure === "oversized") {
        reject(new Error("host adapter output exceeded the configured limit"));
      } else if (code !== 0) {
        reject(new Error("host adapter exited with a nonzero status"));
      } else if (stderrBytes !== 0) {
        reject(new Error("host adapter reported unexpected stderr"));
      } else {
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: "",
        });
      }
    });

    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    timer.unref();
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
