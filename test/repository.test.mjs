import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  MAX_HANDOVER_BYTES,
  MAX_HANDOVER_CONTEXT_BYTES,
} from "../plugins/ai-safe-driver/scripts/handover-core.mjs";

const name = "ai-safe-driver";
const pluginRoot = `plugins/${name}`;
const skillRoot = `${pluginRoot}/skills/${name}`;

const read = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));
const packageVersion = json("package.json").version;
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
    `${skillRoot}/references/recovery.md`,
    `${skillRoot}/references/handover.md`,
    `${skillRoot}/agents/openai.yaml`,
    `${pluginRoot}/hooks/hooks.json`,
    `${pluginRoot}/scripts/drift-detector.mjs`,
    `${pluginRoot}/scripts/arm-handover.mjs`,
    `${pluginRoot}/scripts/handover-core.mjs`,
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
    assert.equal(declaration.version, packageVersion);
  }
  assert.match(packageVersion, /^\d+\.\d+\.\d+$/u);
  assert.equal(claudeMarket.plugins[0].source, `./${pluginRoot}`);
  assert.equal(codexMarket.plugins[0].source.path, `./${pluginRoot}`);
  assert.equal(codexPlugin.skills, "./skills/");
  assert.match(read("CONTRIBUTING.md"), /version aligned in `package\.json`, both plugin manifests, and both marketplace entries/i);
  assert.match(read("CONTRIBUTING.ko.md"), /`package\.json`, 두 플러그인 매니페스트, 두 마켓플레이스 항목의 버전/);
});

test("documents the supported hook runtime and fresh-session boundary in every locale", () => {
  const contracts = [
    [
      "README.md",
      "Automatic hooks require Node.js 20 or later.",
      "In a fresh session, include a short description of the repeated failure or provide an approved handover; the skill cannot inspect an invisible prior conversation.",
    ],
    [
      "README.ko.md",
      "자동 훅을 사용하려면 Node.js 20 이상이 필요합니다.",
      "새 세션에서는 반복된 실패를 짧게 설명하거나 승인된 핸드오버를 제공해야 합니다. 이 스킬은 보이지 않는 이전 대화를 읽을 수 없습니다.",
    ],
    [
      "README.zh-CN.md",
      "自动钩子需要 Node.js 20 或更高版本。",
      "在新会话中，请简要说明反复发生的失败或提供已批准的交接文件；此技能无法读取不可见的先前对话。",
    ],
    [
      "README.zh-TW.md",
      "自動鉤子需要 Node.js 20 或更新版本。",
      "在新的工作階段中，請簡述反覆發生的失敗或提供已核准的交接檔案；此技能無法讀取不可見的先前對話。",
    ],
    [
      "README.ja.md",
      "自動フックには Node.js 20 以降が必要です。",
      "新しいセッションでは、繰り返した失敗を短く説明するか、承認済みのハンドオーバーを渡してください。このスキルは見えない以前の会話を読むことはできません。",
    ],
  ];

  for (const [filePath, runtimeLine, freshSessionLine] of contracts) {
    const content = read(filePath);
    assert.equal(content.includes(runtimeLine), true, `${filePath} is missing its Node.js 20 hook requirement`);
    assert.equal(content.includes(freshSessionLine), true, `${filePath} is missing its fresh-session boundary`);
  }
});

test("keeps repository tests local instead of shipping CI jobs", () => {
  assert.equal(existsSync(".github/workflows"), false, "public repository must not ship CI jobs");
});

test("aligns the package version and direct-invocation prompt", () => {
  assert.equal(packageVersion, "0.4.0");
  assert.equal(
    read(`${skillRoot}/agents/openai.yaml`).includes(
      "Use $ai-safe-driver to diagnose the repeated failure described in this prompt or visible conversation. If no evidence is available, ask for the goal, repeated result, latest correction, and output contract; never invent prior-session context.",
    ),
    true,
    "openai.yaml is missing its direct-invocation evidence boundary",
  );
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
    /Korean[\s\S]{0,160}English[\s\S]{0,160}Simplified Chinese[\s\S]{0,160}Traditional Chinese[\s\S]{0,160}Japanese/i,
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
    /한국어[\s\S]{0,160}영어[\s\S]{0,160}간체 중국어[\s\S]{0,160}번체 중국어[\s\S]{0,160}일본어/,
  ], "README.ko.md");
});

test("preserves the complete negative-signal boundary in user and skill guidance", () => {
  const english = read("README.md");
  assertMatchesAll(english, [
    /Anger alone is not drift/i,
    /capitalization/i,
    /profanity/i,
    /punctuation/i,
    /repeated characters/i,
  ], "README.md");

  const korean = read("README.ko.md");
  assertMatchesAll(korean, [
    /화가 났다는 이유만으로[\s\S]{0,60}드리프트/,
    /대문자/,
    /욕설/,
    /문장부호/,
    /같은 글자 반복/,
  ], "README.ko.md");

  const skill = read(`${skillRoot}/SKILL.md`);
  assert.match(
    skill,
    /Anger, profanity, capitalization, punctuation, or repeated characters alone never raises the drift label/i,
  );
});

test("pins the exact Claude Code and Codex remote install commands", () => {
  const commands = [
    "/plugin marketplace add ssauma/ai-safe-driver",
    "/plugin install ai-safe-driver@ai-safe-driver",
    "codex plugin marketplace add ssauma/ai-safe-driver",
    "codex plugin add ai-safe-driver@ai-safe-driver",
  ];

  for (const filePath of ["README.md", "README.ko.md", "README.zh-CN.md", "README.zh-TW.md", "README.ja.md"]) {
    const content = read(filePath);
    for (const command of commands) {
      assert.equal(content.includes(command), true, `${filePath} is missing ${command}`);
    }
  }
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
    /Anger[\s\S]{0,80}profanity[\s\S]{0,80}capitalization[\s\S]{0,80}punctuation[\s\S]{0,80}repeated characters[\s\S]{0,80}alone never raises the drift label/i,
    /Hook state is not permission to retry a tool, write a file, create or arm a handover, compact, or clear/i,
  ], `${skillRoot}/SKILL.md`);
});

test("keeps the skill as a small router and loads details only when needed", () => {
  const skill = read(`${skillRoot}/SKILL.md`);
  const recovery = read(`${skillRoot}/references/recovery.md`);
  const handover = read(`${skillRoot}/references/handover.md`);
  const words = skill.trim().split(/\s+/u).length;

  assert.ok(Buffer.byteLength(skill, "utf8") <= 3000, `SKILL.md is ${Buffer.byteLength(skill, "utf8")} bytes`);
  assert.ok(words <= 400, `SKILL.md is ${words} words`);
  assert.match(skill, /same failure twice[\s\S]{0,160}explicit (?:drift|conversation-health) check/i);
  assert.match(skill, /explicit (?:compaction|new-session) question/i);
  assert.match(skill, /\[recovery procedure\]\(references\/recovery\.md\)/i);
  assert.match(skill, /Do not read (?:it|the recovery procedure)[\s\S]{0,120}condition is confirmed/i);
  assert.match(skill, /may read the bundled handover procedure without mutation approval/i);
  assert.match(skill, /\[handover procedure\]\(references\/handover\.md\)/i);
  assert.match(skill, /Reading the procedure is not approval to write or arm anything/i);
  assert.match(recovery, /^# Recovery procedure$/m);
  assert.match(recovery, /Recovery contract/);
  assert.match(recovery, /On-demand drift dashboard/);
  assert.match(recovery, /offer a handover[\s\S]{0,180}separate approval/i);
  assert.match(recovery, /container[\s\S]{0,100}keys or columns[\s\S]{0,100}ordering[\s\S]{0,100}forbidden extras[\s\S]{0,100}valid example/i);
  assert.match(recovery, /proposed handover preview[\s\S]{0,180}persist[\s\S]{0,100}file-write approval/i);
  assert.match(handover, /\.ai-safe-driver\/handover\.md/);
  assert.match(handover, /\.ai-safe-driver\/armed\.json/);
  assert.match(handover, /ai-safe-driver-handover-v1/);
  assert.match(handover, /The hook never writes the handover and never initiates/i);
});

test("requires accepted countersteering to reach a verified outcome", () => {
  const recovery = read(`${skillRoot}/references/recovery.md`);

  assertMatchesAll(recovery, [
    /^## Countersteering outcome gate$/m,
    /accepting countersteering starts recovery discussion; it does not complete recovery/i,
    /choose exactly one session path/i,
    /continue[\s\S]{0,220}bounded correction[\s\S]{0,220}(?:success|stop) condition[\s\S]{0,220}verif/i,
    /transition[\s\S]{0,220}handover procedure[\s\S]{0,220}first approval gate/i,
    /transition[\s\S]{0,400}before requesting (?:the first )?approval[\s\S]{0,80}explicitly state[\s\S]{0,180}neither compaction nor (?:a )?fresh-session transition has started/i,
    /do not (?:say|claim)[\s\S]{0,100}countersteering (?:is )?complete[\s\S]{0,220}(?:verified correction|handover has been loaded)/i,
    /multiple failure classes[\s\S]{0,220}compaction[\s\S]{0,220}confirmed (?:external )?state[\s\S]{0,220}fresh session/i,
  ], `${skillRoot}/references/recovery.md`);
});

test("opens every localized README with the self-deprecating drift dashboard", () => {
  const contracts = [
    ["README.md", /Drifting safely\. 100%/],
    ["README.ko.md", /안전하게 드리프트중입니다\. 100%/],
    ["README.zh-CN.md", /正在安全漂移。100%/],
    ["README.zh-TW.md", /正在安全甩尾。100%/],
    ["README.ja.md", /安全にドリフト中です。100%/],
  ];

  for (const [filePath, dashboard] of contracts) {
    const opening = read(filePath).slice(0, 700);
    assert.match(opening, dashboard, `${filePath} hides the dashboard below the opening`);
  }
});

test("ships the GitHub Community Standards files", () => {
  for (const filePath of [
    "README.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "SECURITY.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/conduct_contact.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/security_contact.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/PULL_REQUEST_TEMPLATE.md",
  ]) {
    assert.equal(existsSync(filePath), true, `missing ${filePath}`);
  }

  const codeOfConduct = read("CODE_OF_CONDUCT.md");
  assert.match(codeOfConduct, /Our standards/i);
  assert.match(codeOfConduct, /Reporting/i);
  assert.match(codeOfConduct, /@ssauma/);
  assert.match(codeOfConduct, /public issue titled [`“\"]Private conduct contact requested/i);
  assert.match(codeOfConduct, /Do not include (?:the )?report details/i);
  assert.match(codeOfConduct, /issues\/new\?template=conduct_contact\.yml/i);

  const security = read("SECURITY.md");
  assert.match(security, /Supported versions/i);
  assert.match(security, /Reporting a vulnerability/i);
  assert.match(security, /security\/advisories\/new/i);
  assert.match(security, /Do not (?:open|report)[\s\S]{0,100}public issue/i);
  assert.match(security, /If private vulnerability reporting is unavailable[\s\S]{0,220}Security contact requested/i);
  assert.match(security, /draft security advisory[\s\S]{0,120}collaborator/i);
  assert.match(security, /issues\/new\?template=security_contact\.yml/i);

  for (const filePath of [
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/conduct_contact.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/security_contact.yml",
  ]) {
    const content = read(filePath);
    assert.match(content, /^name:/m, `${filePath} lacks name`);
    assert.match(content, /^description:/m, `${filePath} lacks description`);
    assert.match(content, /^body:/m, `${filePath} lacks body`);
    const fields = [...content.matchAll(/^  - type: (?!markdown\s*$)[^\n]+\n([\s\S]*?)(?=^  - type:|(?![\s\S]))/gmu)];
    assert.ok(fields.length > 0, `${filePath} lacks interactive fields`);
    const ids = fields.map((field) => field[1].match(/^    id:\s*([a-zA-Z0-9_-]+)\s*$/mu)?.[1]);
    assert.equal(ids.every(Boolean), true, `${filePath} has a field without an id`);
    assert.equal(new Set(ids).size, ids.length, `${filePath} has duplicate field ids`);
  }

  assert.match(read(".github/ISSUE_TEMPLATE/conduct_contact.yml"), /^title:\s*"Private conduct contact requested"$/m);
  assert.match(read(".github/ISSUE_TEMPLATE/security_contact.yml"), /^title:\s*"Security contact requested"$/m);
  assert.match(read(".github/ISSUE_TEMPLATE/conduct_contact.yml"), /Do not include report details/i);
  assert.match(read(".github/ISSUE_TEMPLATE/security_contact.yml"), /Do not include vulnerability details/i);

  assert.match(read(".github/ISSUE_TEMPLATE/config.yml"), /blank_issues_enabled:\s*false/);
  assertMatchesAll(read(".github/PULL_REQUEST_TEMPLATE.md"), [
    /^## Summary$/m,
    /^## Verification$/m,
    /npm test/,
    /claude plugin validate \./,
    /four version declarations/i,
  ], ".github/PULL_REQUEST_TEMPLATE.md");
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

test("ships linked narrative pages in English, Korean, Simplified Chinese, Traditional Chinese, and Japanese", () => {
  for (const path of ["CONTRIBUTING.md", "evals/cases.md"]) {
    assert.doesNotMatch(read(path), /[\uac00-\ud7a3]/u, `${path} contains Hangul`);
  }
  assert.match(read("README.md"), /^# AI Safe Driver[\s\S]{0,160}\bEnglish\b/);
  for (const path of ["README.ko.md", "CONTRIBUTING.ko.md", "evals/cases.ko.md"]) {
    assert.match(read(path), /[\uac00-\ud7a3]/u, `${path} lacks Hangul`);
  }

  const readmes = ["README.md", "README.ko.md", "README.zh-CN.md", "README.zh-TW.md", "README.ja.md"];
  for (const filePath of readmes) {
    const content = read(filePath);
    for (const linkedPath of readmes) {
      if (linkedPath !== filePath) assert.match(content, new RegExp(`\\(${linkedPath.replace(".", "\\.")}\\)`));
    }
  }

  const simplifiedChinese = read("README.zh-CN.md");
  assertMatchesAll(simplifiedChinese, [
    /简体中文/,
    /韩语[\s\S]{0,160}英语[\s\S]{0,160}简体中文[\s\S]{0,80}繁体中文[\s\S]{0,160}日语/,
    /直接(?:调用|运行)[\s\S]{0,100}(?:技能|skill)/i,
    /生气[\s\S]{0,80}(?:不代表|不能|不算)[\s\S]{0,40}漂移/,
    /不会保存[\s\S]{0,80}(?:对话|提示|回复)[\s\S]{0,40}(?:原文|文字)/,
  ], "README.zh-CN.md");

  const traditionalChinese = read("README.zh-TW.md");
  assertMatchesAll(traditionalChinese, [
    /繁體中文/,
    /韓文[\s\S]{0,160}英文[\s\S]{0,160}簡體中文[\s\S]{0,80}繁體中文[\s\S]{0,160}日文/,
    /直接(?:呼叫|執行)[\s\S]{0,100}(?:技能|skill)/i,
    /生氣[\s\S]{0,80}(?:不代表|不能|不算)[\s\S]{0,40}漂移/,
    /不會儲存[\s\S]{0,80}(?:對話|提示|回覆)[\s\S]{0,40}(?:原文|文字)/,
  ], "README.zh-TW.md");

  const japanese = read("README.ja.md");
  assertMatchesAll(japanese, [
    /日本語/,
    /韓国語[\s\S]{0,160}英語[\s\S]{0,160}簡体字[\s\S]{0,80}繁体字[\s\S]{0,160}日本語/,
    /スキルを直接(?:呼び出|実行)/,
    /怒り[\s\S]{0,100}ドリフト/,
    /会話[\s\S]{0,80}(?:原文|本文)[\s\S]{0,40}保存しません/,
  ], "README.ja.md");
});

test("keeps the same hook and consent boundaries in all localized readmes", () => {
  const contracts = [
    {
      filePath: "README.md",
      patterns: [
        /observed repeated tool failures[\s\S]{0,120}explicit diagnosis request/i,
        /never automatically (?:runs?|executes?) `\/(?:compact|clear)`/i,
        /separate approval[\s\S]{0,180}(?:write|create)[\s\S]{0,180}(?:transition|`\/compact`|`\/clear`)/i,
        /one[- ]time approval[\s\S]{0,180}(?:without|no) valid approval[\s\S]{0,100}(?:does nothing|no changes)/i,
      ],
    },
    {
      filePath: "README.ko.md",
      patterns: [
        /관찰된 반복 툴 실패[\s\S]{0,120}명시적 진단 요청/,
        /`\/(?:compact|clear)`[\s\S]{0,100}자동으로 실행하지/,
        /파일[\s\S]{0,100}별도 승인[\s\S]{0,180}(?:전환|`\/compact`|`\/clear`)[\s\S]{0,100}별도 승인/,
        /일회성 승인[\s\S]{0,180}유효한 승인이 없으면[\s\S]{0,100}아무것도 바꾸지/,
      ],
    },
    {
      filePath: "README.zh-CN.md",
      patterns: [
        /观察到工具反复失败[\s\S]{0,120}明确的诊断请求/,
        /不会自动执行 `\/(?:compact|clear)`/,
        /写入文件[\s\S]{0,100}单独批准[\s\S]{0,180}(?:切换|`\/compact`|`\/clear`)[\s\S]{0,100}单独批准/,
        /一次性批准[\s\S]{0,180}没有有效批准[\s\S]{0,100}不会做任何更改/,
      ],
    },
    {
      filePath: "README.zh-TW.md",
      patterns: [
        /觀察到工具反覆失敗[\s\S]{0,120}明確的診斷要求/,
        /不會自動執行 `\/(?:compact|clear)`/,
        /寫入檔案[\s\S]{0,100}另行核准[\s\S]{0,180}(?:切換|`\/compact`|`\/clear`)[\s\S]{0,100}另行核准/,
        /一次性核准[\s\S]{0,180}沒有有效核准[\s\S]{0,100}不會做任何變更/,
      ],
    },
    {
      filePath: "README.ja.md",
      patterns: [
        /ツールが繰り返し失敗した事実[\s\S]{0,140}明示的な診断依頼/,
        /`\/(?:compact|clear)` を自動実行しません/,
        /ファイルへの書き込み[\s\S]{0,100}個別の承認[\s\S]{0,180}(?:遷移|`\/compact`|`\/clear`)[\s\S]{0,100}個別の承認/,
        /一度限りの承認[\s\S]{0,180}有効な承認がなければ[\s\S]{0,100}何も変更しません/,
      ],
    },
  ];

  for (const { filePath, patterns } of contracts) assertMatchesAll(read(filePath), patterns, filePath);
});

test("uses locale-native technical prose and keeps English Hangul intentional", () => {
  assert.doesNotMatch(read("README.zh-CN.md"), /用来处理代理|支持韩文|安静退出|短期类别|同一个失败的工具调用又执行了一遍|是有帮助、没有用|为 `compact` 或 `clear` 中的一种转换/);
  assertMatchesAll(read("README.zh-CN.md"), [/智能体/, /韩语/, /英语/, /日语/, /静默退出/], "README.zh-CN.md");

  assert.doesNotMatch(read("README.zh-TW.md"), /宿主模型|安靜結束|校驗和|內部處理方式則依照事故復原來做/);
  assertMatchesAll(read("README.zh-TW.md"), [/AI 代理程式/, /執行這項技能的模型/, /靜默結束/, /SHA-256 雜湊值/], "README.zh-TW.md");

  assert.doesNotMatch(read("README.ja.md"), /決定的ルール|複数の訴え方|足りない事実|Claude CodeとCodex|MCPサーバー|内容の確認と信頼を求める/);
  assertMatchesAll(read("README.ja.md"), [/あらかじめ定めたルール/, /複数の言い回し/, /不足している情報/], "README.ja.md");

  const hangulLines = read("README.md").split("\n").filter((line) => /[\uac00-\ud7a3]/u.test(line));
  assert.deepEqual(hangulLines, [
    "English | [한국어](README.ko.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md)",
    "- Korean: `왜 같은 실수를 계속 반복해?`",
  ]);
});

test("documents SessionStart timing and both forbidden automatic transitions in every readme", () => {
  const contracts = [
    ["README.md", /handover hook runs after `\/compact` or `\/clear`[\s\S]{0,120}loads a handover only when[\s\S]{0,80}approved/i, /never automatically runs [^\n]*`\/compact`/i, /never automatically runs [^\n]*`\/clear`/i],
    ["README.ko.md", /핸드오버용 훅은 `\/compact`나 `\/clear` 뒤에 실행[\s\S]{0,120}승인[\s\S]{0,80}핸드오버만 불러/, /자동으로 실행하지[^\n]*`\/compact`|`\/compact`[^\n]*자동으로 실행하지/, /자동으로 실행하지[^\n]*`\/clear`|`\/clear`[^\n]*자동으로 실행하지/],
    ["README.zh-CN.md", /交接钩子会在 `\/compact` 或 `\/clear` 之后运行[\s\S]{0,120}只会载入[\s\S]{0,80}批准/, /不会自动执行[^\n]*`\/compact`|`\/compact`[^\n]*不会自动执行/, /不会自动执行[^\n]*`\/clear`|`\/clear`[^\n]*不会自动执行/],
    ["README.zh-TW.md", /交接 Hook 會在 `\/compact` 或 `\/clear` 後執行[\s\S]{0,120}只會載入[\s\S]{0,80}核准/, /不會自動執行[^\n]*`\/compact`|`\/compact`[^\n]*不會自動執行/, /不會自動執行[^\n]*`\/clear`|`\/clear`[^\n]*不會自動執行/],
    ["README.ja.md", /引き継ぎフックは `\/compact` または `\/clear` の後に動き[\s\S]{0,120}承認[\s\S]{0,80}引き継ぎだけを読み込/, /自動実行しません[^\n]*`\/compact`|`\/compact`[^\n]*自動実行しません/, /自動実行しません[^\n]*`\/clear`|`\/clear`[^\n]*自動実行しません/],
  ];

  for (const [filePath, timing, compact, clear] of contracts) {
    const content = read(filePath);
    assert.match(content, timing, `${filePath} does not describe actual SessionStart timing`);
    assert.match(content, compact, `${filePath} does not forbid automatic /compact`);
    assert.match(content, clear, `${filePath} does not forbid automatic /clear`);
    assert.match(content, /\(CONTRIBUTING\.md\)/, `${filePath} does not link English contributing guidance`);
    assert.match(content, /\(CONTRIBUTING\.ko\.md\)/, `${filePath} does not link Korean contributing guidance`);
  }
});

test("discloses the permission-gated local Git exclude write in every readme", () => {
  const contracts = [
    ["README.md", "worktree's local Git exclude file", "never changes a shared `.gitignore` or Git configuration"],
    ["README.ko.md", "worktree의 로컬 Git exclude 파일", "공유 `.gitignore`나 Git 설정은 바꾸지 않습니다"],
    ["README.zh-CN.md", "worktree 的本地 Git 排除文件", "不会修改共享的 `.gitignore` 或 Git 配置"],
    ["README.zh-TW.md", "worktree 的本機 Git 排除檔", "不會修改共用的 `.gitignore` 或 Git 設定"],
    ["README.ja.md", "worktree 専用のローカル Git 除外ファイル", "共有の `.gitignore` や Git 設定は変更しません"],
  ];

  for (const [filePath, localWrite, sharedBoundary] of contracts) {
    const content = read(filePath);
    assert.equal(content.includes(localWrite), true, `${filePath} is missing the local Git exclude disclosure`);
    assert.equal(content.includes(sharedBoundary), true, `${filePath} is missing the shared Git boundary`);
  }
});

test("defines an on-demand metaphorical dashboard and protects strict formats", () => {
  const skill = read(`${skillRoot}/references/recovery.md`);
  const handover = read(`${skillRoot}/references/handover.md`);
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
  assert.match(handover, /Do not infer this approval from the file-write approval/);
  assert.match(handover, /Never claim that an ordinary assistant response can execute an interactive slash command/);
  assert.match(handover, /The hook never writes the handover and never initiates/);
  assert.match(skill, /카운터 스티어링 하시겠습니까\?/);
  assert.match(skill, /Would you like me to countersteer\?/);
  assert.match(skill, /A yes authorizes that recovery discussion only/);
  assert.match(skill, /At `75%` or `100%`, put the countersteering question/);
});

test("documents deterministic handover checking and two separate mutation approvals", () => {
  const skill = read(`${skillRoot}/SKILL.md`);
  const handover = read(`${skillRoot}/references/handover.md`);
  const armSource = read(`${pluginRoot}/scripts/arm-handover.mjs`);
  const coreSource = read(`${pluginRoot}/scripts/handover-core.mjs`);

  assert.match(skill, /may read the bundled handover procedure without mutation approval/i);
  assert.match(skill, /Countersteering remains discussion-only/i);
  assert.match(handover, /exact handover path/i);
  assert.match(handover, /content preview/i);
  assert.match(handover, /local Git exclude path/i);
  assert.match(handover, /ask before writing either file/i);
  assert.match(handover, /arm-handover\.mjs"? --cwd .* --check/i);
  assert.match(handover, /ask which exact transition to arm/i);
  assert.match(handover, /capture[d]? .*handover_sha256|capture .*SHA-256/i);
  assert.match(handover, /--action compact[^\n]*--handover-sha256/);
  assert.match(handover, /--action clear[^\n]*--handover-sha256/);
  assert.match(handover, /private[^\n]*inode[^\n]*atomic|atomically[^\n]*armed\.json/i);
  assert.match(handover, /handover[^\n]*invoking uid[^\n]*group\/other write/i);
  assert.match(handover, /publication[^\n]*commit point/i);
  assert.match(handover, /stdout[^\n]*does not undo|does not undo[^\n]*stdout/i);
  assert.match(handover, /path-based[^\n]*invoking uid[^\n]*trust boundary/i);
  assert.doesNotMatch(handover, /Write `armed\.json` as one JSON object/i);
  assert.doesNotMatch(handover, /"schema": "ai-safe-driver-handover-v1"/);

  assert.match(armSource, /readBoundedRegularFile|readAndValidateHandover/);
  assert.match(armSource, /writeExclusiveApproval/);
  assert.match(coreSource, /openFile\(privatePath, "wx", 0o600\)/);
  assert.match(coreSource, /linkFile\(privatePath, armedPath\)/);
  assert.doesNotMatch(coreSource, /openFile\(armedPath, "wx", 0o600\)/);
  assert.match(coreSource, /handle\.sync\(\)/);
  assert.doesNotMatch(armSource, /git[^\n]*config/i);

  const ignoreLines = read(".gitignore").split(/\r?\n/u);
  assert.equal(ignoreLines.filter((line) => line === ".ai-safe-driver/").length, 1);
});

test("documents the bounded handover and compact delivery contract", () => {
  const policyDocuments = [
    [`${skillRoot}/references/handover.md`, /complete wrapped model-visible context no larger than 6 KiB/],
    ["evals/cases.md", /exceeds 6 KiB/],
    ["evals/cases.ko.md", /6 KiB를 초과/],
  ];
  for (const [filePath, sixKiBContract] of policyDocuments) {
    const content = read(filePath);
    assert.match(content, sixKiBContract, filePath);
    assert.doesNotMatch(content, /64 KiB/, filePath);
  }

  const handover = read(`${skillRoot}/references/handover.md`);
  assert.match(handover, /next compact transition, whether the host triggers it manually or automatically/i);
  assert.match(handover, /never initiates `?\/compact`?/i);
  assert.match(handover, /does not acknowledge host or model receipt/i);
  assert.match(handover, /does not guarantee exactly-once delivery/i);
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
  assert.equal(Object.hasOwn(promptHook, "additionalContextLimit"), false);

  const sessionHook = hookConfig.hooks.SessionStart[0].hooks[0];
  assert.equal(sessionHook.additionalContextLimit, 5000);

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

test("handover hook uses the bounded no-follow reader for both state files", () => {
  const source = read(`${pluginRoot}/scripts/reinject-handover.mjs`);
  const coreSource = read(`${pluginRoot}/scripts/handover-core.mjs`);
  assert.match(source, /O_NOFOLLOW/);
  assert.match(source, /O_NONBLOCK/);
  assert.match(source, /readBoundedRegularFile/);
  assert.doesNotMatch(source, /\breadFile\(/);
  assert.match(source, /readAndValidateHandover/);
  assert.match(coreSource, /label: "handover"/);
  assert.match(source, /label: "approval"/);
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

const runHookWithFailedStdout = (cwd, source, message = "broken pipe") => spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "--eval",
    `process.stdout.write = (_payload, _encoding, callback) => {
      callback(new Error(${JSON.stringify(message)}));
      return false;
    };
    await import(${JSON.stringify(pathToFileURL(hookScript).href)});`,
  ],
  {
    cwd,
    encoding: "utf8",
    input: JSON.stringify({ source, cwd, hook_event_name: "SessionStart" }),
  },
);

const runHookWithApprovalReplacement = (cwd, source, armedPath, replacementApproval) => spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "--eval",
    `import { chmodSync, statSync, unlinkSync, writeFileSync } from "node:fs";
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (payload, encoding, callback) => {
      unlinkSync(${JSON.stringify(armedPath)});
      writeFileSync(${JSON.stringify(armedPath)}, "{}\\n", { mode: 0o600 });
      const stat = statSync(${JSON.stringify(armedPath)});
      const replacement = {
        ...${JSON.stringify(replacementApproval)},
        approval_dev: stat.dev,
        approval_ino: stat.ino,
      };
      writeFileSync(${JSON.stringify(armedPath)}, JSON.stringify(replacement), { mode: 0o600 });
      chmodSync(${JSON.stringify(armedPath)}, 0o600);
      return originalWrite(payload, encoding, callback);
    };
    await import(${JSON.stringify(pathToFileURL(hookScript).href)});`,
  ],
  {
    cwd,
    encoding: "utf8",
    input: JSON.stringify({ source, cwd, hook_event_name: "SessionStart" }),
  },
);

const HOOK_FAILURE_NOTICE = "AI Safe Driver handover skipped: operation-failed\n";
const assertBoundedHookFailure = (result, forbidden = []) => {
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, HOOK_FAILURE_NOTICE);
  assert.equal(Buffer.byteLength(result.stderr, "utf8") <= 512, true);
  assert.match(result.stderr, /^[\x20-\x7e]+\n$/u);
  for (const value of forbidden) assert.equal(result.stderr.includes(value), false, value);
};

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

const bindApprovalToFile = (armedPath, approval) => {
  if (!existsSync(armedPath)) writeFileSync(armedPath, "{}\n", { mode: 0o600 });
  chmodSync(armedPath, 0o600);
  const stat = statSync(armedPath);
  return { ...approval, approval_dev: stat.dev, approval_ino: stat.ino };
};

const writeApprovalSync = (armedPath, approval) => {
  const bound = bindApprovalToFile(armedPath, approval);
  writeFileSync(armedPath, JSON.stringify(bound), { mode: 0o600 });
  chmodSync(armedPath, 0o600);
  return bound;
};

// Some filesystems immediately reuse an unlinked inode number for the next
// file created at the same path, so the original file is renamed aside to keep
// its inode occupied while the replacement is created.
const recreateOnDifferentInode = (filePath, contents) => {
  const originalIno = statSync(filePath).ino;
  const inodeHolder = `${filePath}.original-inode-holder`;
  renameSync(filePath, inodeHolder);
  try {
    writeFileSync(filePath, contents, { mode: 0o600 });
    chmodSync(filePath, 0o600);
  } finally {
    rmSync(inodeHolder, { force: true });
  }
  return originalIno;
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
  assert.equal(result.stderr, "");
}));

test("hook reports a missing handover when an approval exists and preserves that approval", () => withState(({ root, state }) => {
  mkdirSync(state);
  const armed = path.join(state, "armed.json");
  writeApprovalSync(armed, approvalFor(validHandover(), "compact"));

  const result = runHook(root, "compact");

  assertBoundedHookFailure(result, [armed, path.join(state, "handover.md")]);
  assert.equal(existsSync(armed), true);
}));

test("hook loads a matching handover once and keeps the handover", () => withState(({ root, state }) => {
  const handover = validHandover("Preserve the exact JSON contract.");
  mkdirSync(state);
  writeFileSync(path.join(state, "handover.md"), handover);
  writeApprovalSync(path.join(state, "armed.json"), approvalFor(handover, "compact"));

  const first = runHook(root, "compact");
  assert.equal(first.status, 0);
  const output = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(output).sort(), ["hookSpecificOutput"]);
  assert.match(output.hookSpecificOutput.additionalContext, /BEGIN HANDOVER/);
  assert.match(output.hookSpecificOutput.additionalContext, /preserve the exact JSON contract/i);
  assert.equal(existsSync(path.join(state, "armed.json")), false);
  assert.equal(readFileSync(path.join(state, "handover.md"), "utf8"), handover);

  const second = runHook(root, "compact");
  assert.equal(second.stdout, "");
}));

test("hook keeps approval and emits a fixed bounded notice when stdout reports hostile failure text", () => withState(({ root, state }) => {
  const handover = validHandover();
  mkdirSync(state);
  const armed = path.join(state, "armed.json");
  writeFileSync(path.join(state, "handover.md"), handover);
  writeApprovalSync(armed, approvalFor(handover, "compact"));

  const sentinelPath = path.join(root, "sentinel-secret.txt");
  const hostileMessage = `${sentinelPath}\nsecond line\u0000검증${"x".repeat(2048)}`;
  const result = runHookWithFailedStdout(root, "compact", hostileMessage);
  assertBoundedHookFailure(result, [sentinelPath, "second line", "검증", "xxx"]);
  assert.equal(existsSync(armed), true);
}));

test("hook fails open and never consumes a replacement approval raced in before consumption", () => withState(({ root, state }) => {
  const handover = validHandover();
  mkdirSync(state);
  const armed = path.join(state, "armed.json");
  writeFileSync(path.join(state, "handover.md"), handover);
  writeApprovalSync(armed, approvalFor(handover, "compact"));
  const replacementApproval = approvalFor(handover, "clear");

  const result = runHookWithApprovalReplacement(root, "compact", armed, replacementApproval);

  assert.equal(result.status, 0);
  assert.notEqual(result.stdout, "");
  assert.equal(result.stderr, HOOK_FAILURE_NOTICE);
  const preserved = JSON.parse(readFileSync(armed, "utf8"));
  assert.equal(preserved.action, "clear");
  const preservedStat = statSync(armed);
  assert.equal(preserved.approval_dev, preservedStat.dev);
  assert.equal(preserved.approval_ino, preservedStat.ino);
}));

test("hook accepts a four KiB approval and rejects one extra byte", () => withState(({ root, state }) => {
  const handover = validHandover();
  mkdirSync(state);
  const armed = path.join(state, "armed.json");
  writeFileSync(path.join(state, "handover.md"), handover);

  const rawApproval = JSON.stringify(bindApprovalToFile(armed, approvalFor(handover, "compact")));
  const atCap = `${rawApproval}${" ".repeat(4 * 1024 - Buffer.byteLength(rawApproval))}`;
  assert.equal(Buffer.byteLength(atCap), 4 * 1024);
  writeFileSync(armed, atCap);
  assert.notEqual(runHook(root, "compact").stdout, "");
  assert.equal(existsSync(armed), false);

  const oversizedApproval = JSON.stringify(bindApprovalToFile(armed, approvalFor(handover, "compact")));
  const oversizedBound = `${oversizedApproval}${" ".repeat(4 * 1024 + 1 - Buffer.byteLength(oversizedApproval))}`;
  assert.equal(Buffer.byteLength(oversizedBound), 4 * 1024 + 1);
  writeFileSync(armed, oversizedBound);
  const result = runHook(root, "compact");
  assertBoundedHookFailure(result, [armed, "approval exceeds 4 KiB"]);
  assert.equal(existsSync(armed), true);
}));

test("hook rejects mismatched, changed, and expired approvals without consuming them", () => withState(({ root, state }) => {
  const handover = validHandover();
  mkdirSync(state);
  const armed = path.join(state, "armed.json");
  writeFileSync(path.join(state, "handover.md"), handover);

  writeApprovalSync(armed, approvalFor(handover, "clear"));
  assert.equal(runHook(root, "compact").stdout, "");
  assert.equal(existsSync(armed), true);

  writeApprovalSync(armed, approvalFor("different", "compact"));
  assert.equal(runHook(root, "compact").stdout, "");
  assert.equal(existsSync(armed), true);

  const expiredStart = new Date(Date.now() - 20 * 60 * 1000);
  writeApprovalSync(armed, approvalFor(handover, "compact", {
    created_at: expiredStart.toISOString(),
    expires_at: new Date(expiredStart.getTime() + 10 * 60 * 1000).toISOString(),
  }));
  assert.equal(runHook(root, "compact").stdout, "");
  assert.equal(existsSync(armed), true);
}));

test("hook accepts a separately approved clear transition", () => withState(({ root, state }) => {
  const handover = validHandover("Resume in a fresh chat.");
  mkdirSync(state);
  writeFileSync(path.join(state, "handover.md"), handover);
  writeApprovalSync(path.join(state, "armed.json"), approvalFor(handover, "clear"));

  const result = runHook(root, "clear");
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /fresh chat/);
  assert.equal(existsSync(path.join(state, "armed.json")), false);
}));

test("hook rejects symlinked handovers without consuming approval", () => withState(({ root, state }) => {
  mkdirSync(state);
  const outside = path.join(root, "outside.md");
  const handoverPath = path.join(state, "handover.md");
  const armed = path.join(state, "armed.json");
  const handover = validHandover("Outside file must not load.");
  writeFileSync(outside, handover);
  symlinkSync(outside, handoverPath);
  writeApprovalSync(armed, approvalFor(handover, "compact"));
  assert.equal(runHook(root, "compact").stdout, "");
  assert.equal(existsSync(armed), true);

}));

test("hook rejects a non-file handover before reading it", () => withState(({ root, state }) => {
  mkdirSync(state);
  const handoverPath = path.join(state, "handover.md");
  const armed = path.join(state, "armed.json");
  mkdirSync(handoverPath);
  writeApprovalSync(armed, approvalFor(validHandover(), "compact"));

  const result = runHook(root, "compact");
  assertBoundedHookFailure(result, [handoverPath, "handover is not a regular file"]);
  assert.equal(existsSync(armed), true);
}));

test("hook emits an exact six KiB model-visible context and rejects a document one byte over its allowance", () => withState(({ root, state }) => {
  mkdirSync(state);
  const handoverPath = path.join(state, "handover.md");
  const armed = path.join(state, "armed.json");
  const base = validHandover();
  const atAllowance = `${base}${"x".repeat(MAX_HANDOVER_BYTES - Buffer.byteLength(base))}`;
  assert.equal(Buffer.byteLength(atAllowance), MAX_HANDOVER_BYTES);
  writeFileSync(handoverPath, atAllowance);
  writeApprovalSync(armed, approvalFor(atAllowance, "compact"));
  const accepted = runHook(root, "compact");
  assert.equal(accepted.status, 0);
  const context = JSON.parse(accepted.stdout).hookSpecificOutput.additionalContext;
  assert.equal(Buffer.byteLength(context, "utf8"), MAX_HANDOVER_CONTEXT_BYTES);
  assert.equal(existsSync(armed), false);

  const oversized = `${atAllowance}x`;
  assert.equal(Buffer.byteLength(oversized), MAX_HANDOVER_BYTES + 1);
  writeFileSync(handoverPath, oversized);
  writeApprovalSync(armed, approvalFor(oversized, "compact"));
  assertBoundedHookFailure(runHook(root, "compact"), [handoverPath, "model-visible context allowance"]);
  assert.equal(existsSync(armed), true);
}));

test("hook rejects a structurally incomplete handover", () => withState(({ root, state }) => {
  const handover = "# AI Safe Driver Handover\n\n## Current goal\nToo little context.\n";
  mkdirSync(state);
  const armed = path.join(state, "armed.json");
  writeFileSync(path.join(state, "handover.md"), handover);
  writeApprovalSync(armed, approvalFor(handover, "compact"));

  assert.equal(runHook(root, "compact").stdout, "");
  assert.equal(existsSync(armed), true);
}));

test("hook rejects approval inode replacement after arming", { skip: typeof process.getuid !== "function" }, () => withState(({ root, state }) => {
  const handover = validHandover();
  mkdirSync(state, { mode: 0o700 });
  const armed = path.join(state, "armed.json");
  writeFileSync(path.join(state, "handover.md"), handover);
  writeApprovalSync(armed, approvalFor(handover, "compact"));
  const copiedApproval = readFileSync(armed);
  const originalIno = recreateOnDifferentInode(armed, copiedApproval);
  assert.notEqual(statSync(armed).ino, originalIno);

  const result = runHook(root, "compact");

  assertBoundedHookFailure(result, [armed, "approval file identity mismatch"]);
  assert.equal(existsSync(armed), true);
}));

test("hook rejects unsafe state-directory and approval modes on POSIX", { skip: typeof process.getuid !== "function" }, () => {
  withState(({ root, state }) => {
    const handover = validHandover();
    mkdirSync(state, { mode: 0o700 });
    const armed = path.join(state, "armed.json");
    writeFileSync(path.join(state, "handover.md"), handover);
    writeApprovalSync(armed, approvalFor(handover, "compact"));
    chmodSync(state, 0o777);
    const result = runHook(root, "compact");
    assertBoundedHookFailure(result, [state, "handover directory has unsafe permissions"]);
  });

  withState(({ root, state }) => {
    const handover = validHandover();
    mkdirSync(state, { mode: 0o700 });
    const armed = path.join(state, "armed.json");
    writeFileSync(path.join(state, "handover.md"), handover);
    writeApprovalSync(armed, approvalFor(handover, "compact"));
    chmodSync(armed, 0o644);
    const result = runHook(root, "compact");
    assertBoundedHookFailure(result, [armed, "approval has unsafe permissions"]);
  });

  withState(({ root, state }) => {
    const handover = validHandover();
    mkdirSync(state, { mode: 0o700 });
    const handoverPath = path.join(state, "handover.md");
    const armed = path.join(state, "armed.json");
    writeFileSync(handoverPath, handover);
    chmodSync(handoverPath, 0o620);
    writeApprovalSync(armed, approvalFor(handover, "compact"));
    const result = runHook(root, "compact");
    assertBoundedHookFailure(result, [handoverPath, "handover has unsafe permissions"]);
    assert.equal(existsSync(armed), true);
  });
});

test("hook rejects malformed UTF-8 handover bytes using their exact raw digest", () => withState(({ root, state }) => {
  mkdirSync(state, { mode: 0o700 });
  const handover = Buffer.concat([Buffer.from(validHandover()), Buffer.from([0xc0, 0xaf])]);
  const armed = path.join(state, "armed.json");
  writeFileSync(path.join(state, "handover.md"), handover);
  writeApprovalSync(armed, approvalFor(handover, "compact"));

  const result = runHook(root, "compact");

  assertBoundedHookFailure(result, [path.join(state, "handover.md"), "handover is not valid UTF-8"]);
  assert.equal(existsSync(armed), true);
}));
