import { homedir, tmpdir } from "node:os";
import path from "node:path";

const isPlatformAbsolute = (value, platform) => {
  if (typeof value !== "string" || value.length === 0) return false;
  if (platform !== "win32") return path.posix.isAbsolute(value);
  return /^[a-z]:[\\/]/iu.test(value)
    || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(value);
};

export const resolveStateRoot = ({
  env = process.env,
  platform = process.platform,
  home = homedir(),
  temporary = tmpdir(),
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
} = {}) => {
  const paths = platform === "win32" ? path.win32 : path.posix;
  for (const name of ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"]) {
    const pluginData = env[name];
    if (!pluginData) continue;
    // Host-owned plugin roots have strict precedence: a relative value is an
    // unsafe host configuration, so fail closed instead of silently redirecting.
    if (!isPlatformAbsolute(pluginData, platform)) {
      throw new Error("plugin data must be an absolute plugin data directory");
    }
    return paths.join(pluginData, "session-state");
  }
  if (isPlatformAbsolute(env.XDG_STATE_HOME, platform)) {
    return paths.join(env.XDG_STATE_HOME, "ai-safe-driver");
  }
  if (platform === "win32" && isPlatformAbsolute(env.LOCALAPPDATA, platform)) {
    return paths.join(env.LOCALAPPDATA, "ai-safe-driver");
  }
  if (isPlatformAbsolute(home, platform)) {
    return paths.join(home, ".local", "state", "ai-safe-driver");
  }
  if (isPlatformAbsolute(temporary, platform)) {
    return paths.join(temporary, `ai-safe-driver-${uid ?? "unknown"}`);
  }
  throw new Error("no absolute state directory is available");
};
