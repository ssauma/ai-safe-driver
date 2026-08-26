import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const name = "ai-safe-driver";
const pluginRoot = `plugins/${name}`;
const skillRoot = `${pluginRoot}/skills/${name}`;

const read = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));

test("ships one canonical skill for both hosts", () => {
  for (const path of [
    ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json",
    `${pluginRoot}/.claude-plugin/plugin.json`,
    `${pluginRoot}/.codex-plugin/plugin.json`,
    `${skillRoot}/SKILL.md`,
    `${skillRoot}/agents/openai.yaml`,
    `${pluginRoot}/hooks/hooks.json`,
    `${pluginRoot}/scripts/drift-detector.mjs`,
    `${pluginRoot}/scripts/reinject-handover.mjs`,
    `${pluginRoot}/scripts/session-drift-hook.mjs`,
    `${pluginRoot}/templates/handover.md`,
  ]) {
    assert.equal(existsSync(path), true, `missing ${path}`);
  }
});

test("keeps identity, source paths, and versions aligned", () => {
  const claudeMarket = json(".claude-plugin/marketplace.json");
  const codexMarket = json(".agents/plugins/marketplace.json");
  const claudePlugin = json(`${pluginRoot}/.claude-plugin/plugin.json`);
  const codexPlugin = json(`${pluginRoot}/.codex-plugin/plugin.json`);
  const declarations = [claudeMarket.plugins[0], codexMarket.plugins[0], claudePlugin, codexPlugin];

  for (const declaration of declarations) {
    assert.equal(declaration.name, name);
    assert.equal(declaration.version, "0.1.0");
  }
  assert.equal(claudeMarket.plugins[0].source, `./${pluginRoot}`);
  assert.equal(codexMarket.plugins[0].source.path, `./${pluginRoot}`);
  assert.equal(codexPlugin.skills, "./skills/");
});

test("keeps English and Korean narrative pages separate", () => {
  for (const path of ["README.md", "CONTRIBUTING.md", "evals/cases.md"]) {
    assert.doesNotMatch(read(path), /[\uac00-\ud7a3]/u, `${path} contains Hangul`);
  }
  for (const path of ["README.ko.md", "CONTRIBUTING.ko.md", "evals/cases.ko.md"]) {
    assert.match(read(path), /[\uac00-\ud7a3]/u, `${path} lacks Hangul`);
  }
  assert.match(read("README.md"), /\[Korean\]\(README\.ko\.md\)/);
  assert.match(read("README.ko.md"), /\[English\]\(README\.md\)/);
});

test("defines an on-demand metaphorical dashboard and protects strict formats", () => {
  const skill = read(`${skillRoot}/SKILL.md`);
  assert.match(skill, /안전하게 드리프트중입니다\. <percentage>%/);
  assert.match(skill, /Drifting safely\. <percentage>%/);
  assert.match(skill, /not a measurement/i);
  assert.match(skill, /Do not append the dashboard or countersteering question to ordinary responses/);
  assert.match(skill, /output contract wins/i);
  assert.match(skill, /Compaction is helpful only when/);
  assert.match(skill, /long-session format failure/);
  assert.match(skill, /Change one condition at a time/);
  assert.match(skill, /Bound retries/);
  assert.match(skill, /start a fresh session/);
  assert.match(skill, /new session/i);
  assert.match(skill, /File writes, handover arming, compaction, and context reset require explicit runtime approval/);
  assert.match(skill, /Do not infer this approval from the file-write approval/);
  assert.match(skill, /Never claim that an ordinary assistant response can execute an interactive slash command/);
  assert.match(skill, /The hook never writes the handover and never initiates/);
  assert.match(skill, /카운터 스티어링 하시겠습니까\?/);
  assert.match(skill, /Would you like me to countersteer\?/);
  assert.match(skill, /A yes authorizes that recovery discussion only/);
  assert.match(skill, /At `75%` or `100%`, put the countersteering question/);
});

test("does not describe a drifting session as operating normally", () => {
  for (const filePath of [
    "README.md",
    "README.ko.md",
    "evals/cases.md",
    "evals/cases.ko.md",
    `${skillRoot}/SKILL.md`,
  ]) {
    const content = read(filePath);
    assert.doesNotMatch(content, /정상운행중입니다|Driving as intended/, filePath);
  }
});

test("uses a real multiline discovery guide instead of the dashboard slogan", () => {
  const skill = read(`${skillRoot}/SKILL.md`);
  assert.match(skill, /^description: \|\n  Use when /m);
  assert.doesNotMatch(skill, /^description: 정상운행중입니다\./m);
  assert.match(skill, /repeating a mistake/);
  assert.match(skill, /conversation health check/);
});

test("ships drift detection hooks and keeps handover permission gated", () => {
  const hookConfig = json(`${pluginRoot}/hooks/hooks.json`);
  assert.deepEqual(Object.keys(hookConfig.hooks).sort(), ["SessionStart", "Stop", "UserPromptSubmit"]);

  const promptHook = hookConfig.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(promptHook.type, "command");
  assert.equal(promptHook.command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-drift-hook.mjs"');
  assert.equal(promptHook.timeout, 5);
  assert.equal(promptHook.statusMessage, "Checking for a repeated correction cycle");
  assert.equal(promptHook.additionalContextLimit, 4096);

  const stopHook = hookConfig.hooks.Stop[0].hooks[0];
  assert.deepEqual(Object.keys(stopHook).sort(), ["command", "timeout", "type"]);
  assert.equal(stopHook.type, "command");
  assert.equal(stopHook.command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-drift-hook.mjs"');
  assert.equal(stopHook.timeout, 5);

  assert.equal(hookConfig.hooks.SessionStart[0].matcher, "compact|clear");
  assert.match(hookConfig.hooks.SessionStart[0].hooks[0].command, /reinject-handover\.mjs/);
  for (const event of ["UserPromptSubmit", "Stop", "SessionStart"]) {
    const command = hookConfig.hooks[event][0].hooks[0].command;
    assert.doesNotMatch(command, /\/compact|\/clear/);
  }
});

test("contains no installers, MCP, app, or network components", () => {
  for (const filePath of [
    `${pluginRoot}/install.sh`,
    `${pluginRoot}/.mcp.json`,
    `${pluginRoot}/.app.json`,
  ]) {
    assert.equal(existsSync(filePath), false, `unexpected ${filePath}`);
  }
});

const hookScript = path.resolve(`${pluginRoot}/scripts/reinject-handover.mjs`);

const validHandover = (note = "Not applicable") => `# AI Safe Driver Handover

## Current goal
${note}
## Latest explicit instructions
${note}
## Exclusions and authorization boundaries
${note}
## Confirmed facts and verified changes
${note}
## Repeated failures and observed evidence
${note}
## Unresolved hypotheses
${note}
## Output contract
${note}
## Next bounded action
${note}
## Success check
${note}
## Stop condition
${note}
## Transition rationale
${note}
`;

const runHook = (cwd, source) => spawnSync(
  process.execPath,
  [hookScript],
  {
    cwd,
    encoding: "utf8",
    input: JSON.stringify({ source, cwd, hook_event_name: "SessionStart" }),
  },
);

const approvalFor = (handover, action, overrides = {}) => {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000);
  return {
    schema: "ai-safe-driver-handover-v1",
    action,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    handover_sha256: createHash("sha256").update(handover).digest("hex"),
    ...overrides,
  };
};

const withState = (callback) => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-safe-driver-"));
  const state = path.join(root, ".ai-safe-driver");
  try {
    return callback({ root, state });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("hook is dormant without an explicit approval record", () => withState(({ root }) => {
  const result = runHook(root, "compact");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
}));

test("hook loads a matching handover once and keeps the handover", () => withState(({ root, state }) => {
  const handover = validHandover("Preserve the exact JSON contract.");
  mkdirSync(state);
  writeFileSync(path.join(state, "handover.md"), handover);
  writeFileSync(path.join(state, "armed.json"), JSON.stringify(approvalFor(handover, "compact")));

  const first = runHook(root, "compact");
  assert.equal(first.status, 0);
  const output = JSON.parse(first.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /BEGIN HANDOVER/);
  assert.match(output.hookSpecificOutput.additionalContext, /preserve the exact JSON contract/i);
  assert.equal(existsSync(path.join(state, "armed.json")), false);
  assert.equal(readFileSync(path.join(state, "handover.md"), "utf8"), handover);

  const second = runHook(root, "compact");
  assert.equal(second.stdout, "");
}));

test("hook rejects mismatched, changed, and expired approvals without consuming them", () => withState(({ root, state }) => {
  const handover = validHandover();
  mkdirSync(state);
  const armed = path.join(state, "armed.json");
  writeFileSync(path.join(state, "handover.md"), handover);

  writeFileSync(armed, JSON.stringify(approvalFor(handover, "clear")));
  assert.equal(runHook(root, "compact").stdout, "");
  assert.equal(existsSync(armed), true);

  writeFileSync(armed, JSON.stringify(approvalFor("different", "compact")));
  assert.equal(runHook(root, "compact").stdout, "");
  assert.equal(existsSync(armed), true);

  const expiredStart = new Date(Date.now() - 20 * 60 * 1000);
  writeFileSync(armed, JSON.stringify(approvalFor(handover, "compact", {
    created_at: expiredStart.toISOString(),
    expires_at: new Date(expiredStart.getTime() + 10 * 60 * 1000).toISOString(),
  })));
  assert.equal(runHook(root, "compact").stdout, "");
  assert.equal(existsSync(armed), true);
}));

test("hook accepts a separately approved clear transition", () => withState(({ root, state }) => {
  const handover = validHandover("Resume in a fresh chat.");
  mkdirSync(state);
  writeFileSync(path.join(state, "handover.md"), handover);
  writeFileSync(path.join(state, "armed.json"), JSON.stringify(approvalFor(handover, "clear")));

  const result = runHook(root, "clear");
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /fresh chat/);
  assert.equal(existsSync(path.join(state, "armed.json")), false);
}));

test("hook rejects symlinked and oversized handovers without consuming approval", () => withState(({ root, state }) => {
  mkdirSync(state);
  const outside = path.join(root, "outside.md");
  const handoverPath = path.join(state, "handover.md");
  const armed = path.join(state, "armed.json");
  const handover = validHandover("Outside file must not load.");
  writeFileSync(outside, handover);
  symlinkSync(outside, handoverPath);
  writeFileSync(armed, JSON.stringify(approvalFor(handover, "compact")));
  assert.equal(runHook(root, "compact").stdout, "");
  assert.equal(existsSync(armed), true);

  rmSync(handoverPath);
  const oversized = "x".repeat(64 * 1024 + 1);
  writeFileSync(handoverPath, oversized);
  writeFileSync(armed, JSON.stringify(approvalFor(oversized, "compact")));
  assert.equal(runHook(root, "compact").stdout, "");
  assert.equal(existsSync(armed), true);
}));

test("hook rejects a structurally incomplete handover", () => withState(({ root, state }) => {
  const handover = "# AI Safe Driver Handover\n\n## Current goal\nToo little context.\n";
  mkdirSync(state);
  const armed = path.join(state, "armed.json");
  writeFileSync(path.join(state, "handover.md"), handover);
  writeFileSync(armed, JSON.stringify(approvalFor(handover, "compact")));

  assert.equal(runHook(root, "compact").stdout, "");
  assert.equal(existsSync(armed), true);
}));
