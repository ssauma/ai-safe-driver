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
