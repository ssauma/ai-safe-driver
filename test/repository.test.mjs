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
const assertMatchesAll = (content, patterns, filePath) => {
  for (const pattern of patterns) {
    assert.match(content, pattern, `${filePath} is missing ${pattern}`);
  }
};

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
    assert.equal(declaration.version, "0.2.0");
  }
  assert.equal(claudeMarket.plugins[0].source, `./${pluginRoot}`);
  assert.equal(codexMarket.plugins[0].source.path, `./${pluginRoot}`);
  assert.equal(codexPlugin.skills, "./skills/");
});

test("explains direct and hook-triggered recovery truthfully in English", () => {
  const content = read("README.md");
  assertMatchesAll(content, [
    /(?:call|invoke|run) (?:the skill|it) directly/i,
    /local (?:deterministic )?hooks?/i,
    /correction[\s\S]{0,180}(?:acknowledg|repair promise)[\s\S]{0,180}(?:same|recurr|return)/i,
    /(?:may|can) miss (?:unfamiliar|unknown) (?:wording|phrasing)/i,
    /anger alone (?:is not|does not count as) drift/i,
    /tool failures?[\s\S]{0,140}explicit (?:diagnosis|diagnostic) request/i,
    /temporary state[\s\S]{0,180}categor(?:y|ies)[\s\S]{0,100}(?:count|timestamp)/i,
    /never (?:stores?|contains?) (?:the )?(?:conversation|prompt|response) text/i,
    /Korean[\s\S]{0,160}English[\s\S]{0,160}(?:Simplified|Traditional) Chinese[\s\S]{0,160}Japanese/i,
  ], "README.md");
});

test("explains direct and hook-triggered recovery naturally in Korean", () => {
  const content = read("README.ko.md");
  assertMatchesAll(content, [
    /스킬을 직접 (?:호출|실행)/,
    /로컬[\s\S]{0,40}훅/,
    /정정[\s\S]{0,180}(?:인정|수정 약속)[\s\S]{0,180}(?:같은|반복|다시)/,
    /낯선 (?:표현|말투)[\s\S]{0,80}(?:놓칠|감지하지 못)/,
    /화가 났다는 이유만으로[\s\S]{0,60}드리프트/,
    /툴 실패[\s\S]{0,140}명시적[\s\S]{0,60}진단 요청/,
    /임시 상태[\s\S]{0,180}(?:범주|종류)[\s\S]{0,100}(?:횟수|개수|타임스탬프|시각)/,
    /대화 (?:내용|원문)[\s\S]{0,60}(?:저장하지|담지)/,
    /한국어[\s\S]{0,160}영어[\s\S]{0,160}(?:간체|번체)[\s\S]{0,80}중국어[\s\S]{0,160}일본어/,
  ], "README.ko.md");
});

test("treats hook evidence as a recovery prompt rather than a final diagnosis", () => {
  const skill = read(`${skillRoot}/SKILL.md`);
  assertMatchesAll(skill, [
    /^## Hook-triggered recovery$/m,
    /local hook may add bounded recovery context/i,
    /observable repeated-correction sequence/i,
    /explicit health or repeated-tool diagnosis request/i,
    /reason to inspect evidence, not as proof of drift/i,
    /not as a final dashboard percentage/i,
    /If the evidence does not show repetition[\s\S]{0,120}without escalating/i,
    /Anger, profanity, capitalization, or punctuation alone never raises the drift label/i,
    /Hook state is not permission to retry a tool, write a file, create or arm a handover, compact, or clear/i,
  ], `${skillRoot}/SKILL.md`);
});

test("ships matched English, Korean, Chinese, and Japanese behavioral evaluations", () => {
  for (const filePath of [
    "evals/cases.md",
    "evals/cases.ko.md",
    "evals/cases.zh.md",
    "evals/cases.ja.md",
  ]) {
    assert.equal(existsSync(filePath), true, `missing ${filePath}`);
  }
});

test("evaluates multilingual drift signals by preserved decisions", () => {
  const contracts = [
    {
      filePath: "evals/cases.md",
      patterns: [
        /How many times do I have to tell you/i,
        /already answered[\s\S]{0,100}asked again/i,
        /nonexistent (?:link|URL)|made[- ]up (?:link|URL)/i,
        /I didn't ask you/i,
        /explicit repeated-tool diagnosis/i,
        /raw tool (?:error|failure)[\s\S]{0,100}(?:without|no) (?:a )?diagnosis request/i,
        /unfamiliar (?:wording|phrase)[\s\S]{0,120}direct invocation/i,
        /wrong task|re-anchor/i,
        /broken repair promise/i,
        /execution avoidance/i,
        /output contract|language regression/i,
        /oscillat(?:ing|ion) status|back-and-forth status/i,
        /ordinary[\s\S]{0,80}(?:again|continue|format)/i,
      ],
    },
    {
      filePath: "evals/cases.ko.md",
      patterns: [
        /몇 번(?:을|이나)? 말해야/,
        /이미 답했[\s\S]{0,100}또 (?:묻|물)/,
        /없는 (?:링크|URL)[\s\S]{0,80}(?:지어|꾸며|만들)/,
        /부탁하지 않았|요청하지 않았/,
        /반복[\s\S]{0,80}툴[\s\S]{0,80}진단/,
        /단순한 툴 (?:오류|실패)[\s\S]{0,100}진단 요청/,
        /낯선 (?:표현|말투)[\s\S]{0,120}직접 (?:호출|실행)/,
        /잘못된 작업|다시 고정/,
        /깨진 수정 약속|수정 약속을 어김/,
        /실행 회피/,
        /출력 계약|언어 (?:회귀|이탈)/,
        /오락가락[\s\S]{0,40}상태|상태 주장[\s\S]{0,40}오락가락/,
        /일상적인[\s\S]{0,100}(?:다시|계속|형식)/,
      ],
    },
    {
      filePath: "evals/cases.zh.md",
      patterns: [
        /说了多少遍|說了多少遍/,
        /已经回答过了，怎么又问同一个问题|已經回答過了，怎麼又問同一個問題/,
        /不存在的(?:链接|連結)|编造的(?:链接|連結)|捏造的(?:链接|連結)/,
        /我没让你|我沒讓你|我没有要求|我沒有要求/,
        /重复工具诊断|重複工具診斷|工具[\s\S]{0,40}反复失败[\s\S]{0,40}诊断/,
        /原始工具(?:错误|錯誤|失败|失敗)[\s\S]{0,100}(?:没有|沒有)诊断请求/,
        /陌生(?:措辞|表述)[\s\S]{0,120}直接调用|直接調用/,
        /做错任务|做錯任務|重新锚定|重新錨定/,
        /修复承诺|修復承諾|改正承诺|改正承諾/,
        /逃避执行|逃避執行/,
        /输出契约|輸出契約|语言退化|語言退化/,
        /状态反复|狀態反覆|来回改口|來回改口/,
        /还是选择 JSON 格式|還是選擇 JSON 格式/,
      ],
    },
    {
      filePath: "evals/cases.ja.md",
      patterns: [
        /何回同じことを言わせるの/,
        /さっき答えましたよね/,
        /存在しない(?:リンク|URL)|作り話/,
        /頼んでいない|依頼していない/,
        /繰り返すツール[\s\S]{0,50}診断|ツール[\s\S]{0,50}繰り返し失敗[\s\S]{0,50}診断/,
        /単なるツール(?:エラー|失敗)[\s\S]{0,100}診断依頼/,
        /未知の(?:言い回し|表現)[\s\S]{0,120}直接呼び出/,
        /間違った作業|再アンカー/,
        /修正の約束|直したと言ったのに/,
        /実行回避/,
        /出力契約|言語の退行/,
        /状態[\s\S]{0,30}(?:行ったり来たり|二転三転)/,
        /また同じ形式でお願いします/,
      ],
    },
  ];

  for (const { filePath, patterns } of contracts) {
    const content = read(filePath);
    assertMatchesAll(content, patterns, filePath);
    assertMatchesAll(content, [
      /(?:every case|모든 사례|所有案例|すべてのケース)[\s\S]{0,220}(?:automatic retr|자동 재시도|自动重试|自動再試行)/i,
      /(?:every case|모든 사례|所有案例|すべてのケース)[\s\S]{0,300}(?:state-changing|상태 변경|状态变更|状態変更)/i,
    ], filePath);
  }
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
