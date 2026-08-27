import { homedir, tmpdir } from "node:os";
import path from "node:path";

export const resolveStateRoot = ({
  env = process.env,
  platform = process.platform,
  home = homedir(),
  temporary = tmpdir(),
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
} = {}) => {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const pluginData = env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA;
  if (pluginData) return paths.resolve(pluginData, "session-state");
  if (env.XDG_STATE_HOME) return paths.resolve(env.XDG_STATE_HOME, "ai-safe-driver");
  if (platform === "win32" && env.LOCALAPPDATA) return paths.resolve(env.LOCALAPPDATA, "ai-safe-driver");
  if (home) return paths.resolve(home, ".local", "state", "ai-safe-driver");
  return paths.resolve(temporary, `ai-safe-driver-${uid ?? "unknown"}`);
};
