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
    `${skillRoot}/references/recovery.md`,
    `${skillRoot}/references/handover.md`,
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
    assert.equal(declaration.version, "0.3.0");
  }
  assert.equal(claudeMarket.plugins[0].source, `./${pluginRoot}`);
  assert.equal(codexMarket.plugins[0].source.path, `./${pluginRoot}`);
  assert.equal(codexPlugin.skills, "./skills/");
  assert.match(read("CONTRIBUTING.md"), /version `0\.3\.0`/i);
  assert.match(read("CONTRIBUTING.ko.md"), /버전 `0\.3\.0`/);
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
  assert.match(skill, /only after the user separately approves preparing a handover/i);
  assert.match(skill, /\[handover procedure\]\(references\/handover\.md\)/i);
  assert.match(skill, /Do not read (?:that|the) reference merely because the hook fired/i);
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
  assert.deepEqual(Object.keys(output).sort(), ["hookSpecificOutput"]);
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
