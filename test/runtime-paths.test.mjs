import assert from "node:assert/strict";
import test from "node:test";
import { resolveStateRoot } from "../plugins/ai-safe-driver/scripts/runtime-paths.mjs";

test("prefers plugin data and never uses the shared tmp name", () => {
  assert.equal(
    resolveStateRoot({ env: { CLAUDE_PLUGIN_DATA: "/plugin-data" }, platform: "linux", home: "/home/u", temporary: "/tmp", uid: 1001 }),
    "/plugin-data/session-state",
  );
  assert.equal(
    resolveStateRoot({ env: { PLUGIN_DATA: "/codex-data" }, platform: "linux", home: "/home/u", temporary: "/tmp", uid: 1001 }),
    "/codex-data/session-state",
  );
  assert.equal(
    resolveStateRoot({ env: {}, platform: "linux", home: "", temporary: "/tmp", uid: 1001 }),
    "/tmp/ai-safe-driver-1001",
  );
});

test("uses XDG and platform fallbacks", () => {
  assert.equal(resolveStateRoot({ env: { XDG_STATE_HOME: "/state" }, platform: "linux", home: "/home/u", temporary: "/tmp", uid: 7 }), "/state/ai-safe-driver");
  assert.equal(
    resolveStateRoot({ env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, platform: "win32", home: "", temporary: "C:\\Temp", uid: undefined }),
    "C:\\Users\\u\\AppData\\Local\\ai-safe-driver",
  );
});

test("never resolves relative POSIX state variables against the hook working directory", () => {
  assert.throws(
    () => resolveStateRoot({
      env: { CLAUDE_PLUGIN_DATA: ".claude-state" },
      platform: "linux",
      home: "/home/u",
      temporary: "/tmp",
      uid: 7,
    }),
    /absolute plugin data directory/iu,
  );
  assert.throws(
    () => resolveStateRoot({
      env: { PLUGIN_DATA: "codex-state" },
      platform: "linux",
      home: "/home/u",
      temporary: "/tmp",
      uid: 7,
    }),
    /absolute plugin data directory/iu,
  );
  assert.equal(
    resolveStateRoot({
      env: { XDG_STATE_HOME: ".state" },
      platform: "linux",
      home: "/home/u",
      temporary: "/tmp",
      uid: 7,
    }),
    "/home/u/.local/state/ai-safe-driver",
  );
  assert.equal(
    resolveStateRoot({ env: {}, platform: "linux", home: "relative-home", temporary: "/tmp", uid: 7 }),
    "/tmp/ai-safe-driver-7",
  );
  assert.throws(
    () => resolveStateRoot({ env: {}, platform: "linux", home: "relative-home", temporary: "tmp", uid: 7 }),
    /absolute state directory/iu,
  );
});

test("accepts Windows drive and UNC roots but rejects drive-relative state variables", () => {
  assert.equal(
    resolveStateRoot({
      env: { PLUGIN_DATA: "D:\\Codex\\data" },
      platform: "win32",
      home: "",
      temporary: "C:\\Temp",
      uid: undefined,
    }),
    "D:\\Codex\\data\\session-state",
  );
  assert.equal(
    resolveStateRoot({
      env: { CLAUDE_PLUGIN_DATA: "\\\\server\\share\\claude" },
      platform: "win32",
      home: "",
      temporary: "C:\\Temp",
      uid: undefined,
    }),
    "\\\\server\\share\\claude\\session-state",
  );
  assert.equal(
    resolveStateRoot({
      env: { LOCALAPPDATA: "\\\\server\\share\\local" },
      platform: "win32",
      home: "",
      temporary: "C:\\Temp",
      uid: undefined,
    }),
    "\\\\server\\share\\local\\ai-safe-driver",
  );
  assert.throws(
    () => resolveStateRoot({
      env: { CLAUDE_PLUGIN_DATA: "C:claude-data" },
      platform: "win32",
      home: "C:\\Users\\u",
      temporary: "C:\\Temp",
      uid: undefined,
    }),
    /absolute plugin data directory/iu,
  );
  assert.equal(
    resolveStateRoot({
      env: { XDG_STATE_HOME: "D:state", LOCALAPPDATA: "C:local" },
      platform: "win32",
      home: "relative-home",
      temporary: "C:\\Temp",
      uid: null,
    }),
    "C:\\Temp\\ai-safe-driver-unknown",
  );
});
