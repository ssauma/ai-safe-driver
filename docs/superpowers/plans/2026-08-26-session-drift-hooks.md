# Session Drift Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local, cross-host hooks that wake AI Safe Driver after an observable repeated-correction cycle without treating anger alone as drift or storing conversation text.

**Architecture:** A pure classifier and reducer identify user and assistant signal categories. One command hook adapts Claude Code and Codex input, persists category-only session state under the operating system temporary directory, and emits bounded recovery context from `UserPromptSubmit`; `Stop` records assistant acknowledgment and repair promises without emitting output. The existing handover hook remains separate and permission gated.

**Tech Stack:** Node.js 20 ESM, built-in `node:test`, Claude Code plugin hooks, Codex plugin hooks, JSON state files with atomic rename.

## Global Constraints

- Keep the repository private throughout implementation and verification.
- Support Claude Code and Codex from one canonical plugin copy.
- Detect conservative recovery signals in Korean, English, Simplified or Traditional Chinese, and Japanese with the same state machine.
- Use deterministic local rules only; make no network request and invoke no model classifier.
- Store category counters and timestamps only; never persist prompt or response text.
- Refresh state expiry only for a qualifying signal; neutral turns must not keep old state alive.
- Anger, profanity, capitalization, repeated characters, or punctuation cannot trigger recovery alone.
- Standalone recurrence words such as `또`, `다시`, `계속`, `again`, `still`, and `continue` cannot trigger or advance recurrence without a failure or protest anchor.
- Analyze a tool failure only when the user explicitly requests diagnosis of a repeated failure.
- Hooks may inject instructions but may not retry tools, write project files, create a handover, invoke `/compact`, or invoke `/clear`.
- Keep existing handover approval gates unchanged.
- Delegate all build and test commands to the repository's build/test runner; keep raw logs in `.kb.tmp/<task-id>/`.
- Preserve separate English `README.md` and Korean `README.ko.md` pages with matching commands, safety claims, and feature claims.
- Bump the four plugin version declarations from `0.1.0` to `0.2.0` together.

---

### Task 1: Deterministic conversation signal classifier

**Files:**
- Create: `plugins/ai-safe-driver/scripts/drift-detector.mjs`
- Create: `test/drift-detector.test.mjs`

**Interfaces:**
- Consumes: a user or assistant string supplied by a hook adapter.
- Produces: `classifyUserPrompt(text): UserSignals`, `classifyAssistantResponse(text): AssistantSignals`, `createInitialState(now): DriftState`, `applyUserTurn(state, signals, now): UserTurnResult`, and `applyAssistantTurn(state, signals, now): DriftState`.
- `UserSignals` contains booleans `correction`, `recurrence`, `protest`, `explicitHealthCheck`, `explicitToolDiagnosis`, and `emphasis`.
- `AssistantSignals` contains booleans `acknowledgment`, `apology`, and `repairPromise`.
- `UserTurnResult` contains `{ state, inject, reason }`, where `reason` is `null`, `explicit_health_check`, `explicit_tool_diagnosis`, `acknowledged_recurrence`, or `repeated_correction`.

- [ ] **Step 1: Write the failing classifier tests**

Create table-driven Korean and English cases in `test/drift-detector.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAssistantTurn,
  applyUserTurn,
  classifyAssistantResponse,
  classifyUserPrompt,
  createInitialState,
} from "../plugins/ai-safe-driver/scripts/drift-detector.mjs";

test("classifies user correction and recurrence signals across supported languages", () => {
  const cases = [
    ["안 했잖아.", { correction: true }],
    ["한다고 해놓고 또 안 했잖아.", { correction: true, recurrence: true }],
    ["왜 같은 실수를 계속 반복해?", { recurrence: true, protest: true }],
    ["You said you would fix it and still did not.", { correction: true, recurrence: true }],
    ["Why do you keep making the same mistake?", { recurrence: true, protest: true }],
    ["你说已经改好了，怎么还是没改？", { correction: true, recurrence: true, protest: true }],
    ["我都說過不要動那一段，你怎麼又改了？", { correction: true, recurrence: true, protest: true }],
    ["修正すると言ったのに、また同じ間違いです。", { correction: true, recurrence: true }],
    ["何度言えば分かるの？ また元の形式に戻っています。", { recurrence: true, protest: true }],
  ];
  for (const [text, expected] of cases) {
    const actual = classifyUserPrompt(text);
    for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, text);
  }
});

test("classifies assistant acknowledgment without treating it as a trigger", () => {
  for (const text of [
    "맞습니다. 요청한 항목을 넣지 않았습니다. 죄송합니다. 다시 고치겠습니다.",
    "You're right. I missed that requirement. Sorry. I'll fix it.",
  ]) {
    const signals = classifyAssistantResponse(text);
    assert.equal(signals.acknowledgment, true);
    assert.equal(signals.apology, true);
    assert.equal(signals.repairPromise, true);
  }
});

test("does not treat emphasis or ordinary apology as drift", () => {
  assert.deepEqual(classifyUserPrompt("이게 뭐야!!!!!"), {
    correction: false,
    recurrence: false,
    protest: false,
    explicitHealthCheck: false,
    explicitToolDiagnosis: false,
    emphasis: true,
  });
  assert.deepEqual(classifyAssistantResponse("Sorry for the delay."), {
    acknowledgment: false,
    apology: true,
    repairPromise: false,
  });
});

test("does not treat neutral recurrence words as a repeated failure", () => {
  for (const text of [
    "계속 진행해.",
    "또 다른 질문이 있어.",
    "다시 설명해줘.",
    "Continue with the plan.",
    "I have another question.",
    "Explain it again.",
    "请再解释一次。",
    "还有一个问题。",
    "请继续处理。",
    "このまま続けてください。",
    "また後で確認します。",
    "別の質問があります。",
  ]) {
    assert.equal(classifyUserPrompt(text).recurrence, false, text);
  }
});

test("recognizes additional correction shapes without using emotion as proof", () => {
  const cases = [
    "그게 아니라 내가 요청한 건 설치만 하는 거였어.",
    "한다고 해놓고 또 반영 안 했잖아.",
    "하지 말랬는데 왜 또 바꿨어?",
    "말만 하지 말고, 같은 질문 그만하고 진행해.",
    "출력 형식이 또 원래대로 돌아갔어.",
    "아까는 됐다더니 지금은 안 된다며. 왜 계속 왔다 갔다 해?",
    "That's not what I asked for.",
    "You said you fixed it, but the output format broke again.",
    "I told you not to change that, and you did it again.",
    "Stop asking the same question and do the requested step.",
    "这不是我让你做的。",
    "别再道歉了，先把漏掉的内容补上。",
    "你又说做完了，可是内容还是没变。",
    "そうじゃなくて、私が頼んだのはそこだけです。",
    "触らないでと言ったところまで、また変えています。",
    "謝るだけで、まだ直っていません。",
  ];
  for (const text of cases) {
    const signals = classifyUserPrompt(text);
    assert.equal(signals.correction || signals.protest, true, text);
  }
});

test("requires an explicit repeated-tool diagnosis request", () => {
  assert.equal(classifyUserPrompt("같은 툴 호출이 또 실패했어. 원인을 점검해줘.").explicitToolDiagnosis, true);
  assert.equal(classifyUserPrompt("툴이 실패했어.").explicitToolDiagnosis, false);
  assert.equal(classifyUserPrompt("The same tool call failed again. Diagnose why.").explicitToolDiagnosis, true);
});
```

- [ ] **Step 2: Run the classifier tests and confirm RED**

Run through the build/test runner:

```bash
node --test test/drift-detector.test.mjs
```

Expected: FAIL because `drift-detector.mjs` does not exist.

- [ ] **Step 3: Implement the classifiers and pure reducer**

Create `plugins/ai-safe-driver/scripts/drift-detector.mjs` with immutable results and these constants:

```js
export const STATE_SCHEMA = "ai-safe-driver-session-state-v1";
export const STATE_TTL_MS = 24 * 60 * 60 * 1000;
export const COOLDOWN_PROMPTS = 2;

const testAny = (patterns, text) => patterns.some((pattern) => pattern.test(text));
const normalized = (text) => typeof text === "string" ? text.normalize("NFKC").trim() : "";

const USER_CORRECTION = [
  /(?:그게|그건)\s*아니|내가\s*(?:말|요청)한\s*(?:건|것)/iu,
  /(?:안|못)\s*(?:했|지켰|넣었|고쳤|따랐|반영)|(?:누락|무시|어겼|틀렸|빠뜨렸|빠졌)/iu,
  /(?:한다고|하겠다고|고친다고).*(?:해놓고|했는데|말하고)|(?:말만|설명만|사과만).*(?:하고|하지)/iu,
  /(?:하지\s*말(?:랬|라고)|누가.+하랬|허락\s*없이|맘대로)/iu,
  /(?:형식|포맷|언어|필드|키|순서|줄\s*수).*(?:안\s*맞|깨졌|틀렸|빠졌|돌아갔)/iu,
  /(?:that's not what i asked|i (?:already )?(?:said|asked)|told you not to|you were supposed to)/iu,
  /(?:did(?:n't| not)|failed to|missed|ignored|violated|left out|not applied|still missing)/iu,
  /(?:这|這)(?:不|並不)是我(?:让|讓)你|我(?:都|已经|已經)(?:说|說)了|不是(?:说|說)过|(?:让|讓)你别|(?:叫|讓)你不要/iu,
  /(?:没|沒)(?:做|改|加|保留|处理|處理|修好)|(?:漏掉|遗漏|遺漏|忽略|擅自|删了|刪了)/iu,
  /(?:格式|语言|語言|字段|顺序|順序).*(?:错|錯|乱|亂|恢复|恢復|回到)/iu,
  /(?:それ|そう)じゃな|私が頼んだのは|さっき(?:言|伝)った|前にも言った|言いましたよね/iu,
  /(?:できていな|直っていな|守れていな|抜けて|漏れて|見落と|無視し|勝手に|触らないで)/iu,
  /(?:形式|フォーマット|言語|項目|順序).*(?:違|崩|戻|抜け)/iu,
];
const RECURRENCE_MARKER = /(?:또|다시|계속|자꾸|여전히|몇\s*번|반복|again|still|keep|keeps|repeated|又|还|還|一直|总是|總是|反复|反覆|重复|重複|几次|幾次|また|まだ|何度|何回|繰り返|ずっと|元に戻)/iu;
const FAILURE_ANCHOR = /(?:안\s*(?:했|됐|맞|지켰|넣|고쳤|따랐|반영)|못\s*(?:했|했어)|실패|오류|틀|누락|빠|무시|어겼|같은\s*(?:실수|질문|문제)|말만|물어|왔다\s*갔다|바뀌|되돌아|깨졌|did(?:n't| not)|failed|error|wrong|missed|ignored|same\s+(?:mistake|question|problem)|keeps?\s+(?:asking|changing)|back\s+and\s+forth|broke|错|錯|没|沒|失败|失敗|忽略|漏|同样|同樣|还是|還是|没有|沒有|删|刪|擅自|同じ\s*(?:ミス|間違い|質問|問題)|できていな|直っていな|無視|見落と|戻って|変え|謝るだけ)/iu;
const STRONG_RECURRENCE = [
  /(?:한다고|하겠다고|고친다고).*(?:또|여전히|그대로|안\s*(?:했|됐))/iu,
  /(?:하고도|해놓고|했는데도).*(?:안|못|또|여전히)/iu,
  /(?:you said|promised).*(?:again|still|did(?:n't| not)|not fixed)/iu,
  /(?:怎么|怎麼)(?:又|还|還)|(?:说|說)(?:过|過|好).*(?:又|还|還|还是|還是)|又犯.*(?:同样|同樣).*(?:错|錯)/iu,
  /(?:また|何度|何回).*(?:同じ|ミス|間違|言)|(?:修正|直す|やり直す|承知|分かりました|わかりました).*(?:と言った|って言った).*(?:のに|また)/iu,
];
const USER_PROTEST = [
  /왜.+(?:또|계속|자꾸|반복)/iu,
  /(?:변명|뭐라는|대체|말을\s*안\s*들|말만|설명만|사과만)/iu,
  /(?:누가.+하랬|하지\s*말랬|왜.+(?:바꿨|지웠|했어)|자꾸.+물어)/iu,
  /(?:왔다\s*갔다|말이\s*바뀌|앞뒤가\s*안\s*맞|아까는.+지금은)/iu,
  /why.+(?:again|keep|keeps|repeated|same mistake)/iu,
  /(?:stop making excuses|what are you talking about|who told you to|i told you not to|stop asking|back and forth)/iu,
  /(?:怎么|怎麼)(?:又|还|還)|(?:为什么|為什麼).*(?:一直|总是|總是)|(?:说|說)了多少遍|(?:别|別)再道歉|不要再问|不要再問|有完没完|有完沒完/iu,
  /(?:何度言えば|何回言ったら|なんでまた|謝るだけ|同じ質問|いい加減)/iu,
];
const HEALTH_CHECK = [
  /(?:드리프트|대화\s*상태|세션\s*상태|정상이냐|새\s*세션|컴팩션).*(?:점검|어때|필요|해야|인가|이야|냐|까)/iu,
  /(?:are (?:you|we) drifting|conversation health|session health|new session|should (?:we|i) compact)/iu,
  /(?:对话|對話|上下文).*(?:跑偏|偏了|有问题|有問題)|(?:需要|要不要).*(?:新对话|新對話|新会话|新會話)|漂移/iu,
  /(?:会話|セッション).*(?:ずれて|おかしい|健全|状態)|ドリフト|新しいセッション|コンパクションした方が/iu,
];
const TOOL_WORD = /(?:툴|도구|호출|명령|command|tool|call|mcp|工具|调用|調用|ツール|呼び出し)/iu;
const TOOL_FAILURE = /(?:실패|오류|에러|failed|failure|error|失败|失敗|错误|錯誤|エラー)/iu;
const TOOL_REPEAT = /(?:또|다시|계속|반복|같은|again|repeated|same|keep|又|还|還|重复|重複|また|何度|繰り返)/iu;
const TOOL_DIAGNOSE = /(?:분석|점검|원인|왜|진단|analyse|analyze|diagnose|check|why|分析|检查|檢查|原因|为什么|為什麼|診断|なぜ|調べ)/iu;

export const classifyUserPrompt = (value) => {
  const text = normalized(value);
  const recurrence = testAny(STRONG_RECURRENCE, text)
    || (RECURRENCE_MARKER.test(text) && FAILURE_ANCHOR.test(text));
  return {
    correction: testAny(USER_CORRECTION, text),
    recurrence,
    protest: testAny(USER_PROTEST, text),
    explicitHealthCheck: testAny(HEALTH_CHECK, text),
    explicitToolDiagnosis: TOOL_WORD.test(text) && TOOL_FAILURE.test(text)
      && TOOL_REPEAT.test(text) && TOOL_DIAGNOSE.test(text),
    emphasis: /[!?]{3,}/u.test(text) || /(.)\1{4,}/u.test(text)
      || /\b[A-Z\s]{8,}\b/u.test(text),
  };
};

const ASSISTANT_ACK = [
  /(?:맞습니다|맞아요|안\s*했습니다|못\s*했습니다|지키지\s*않았습니다|누락했습니다|어겼습니다)/iu,
  /(?:you(?:'re| are) right|i did(?:n't| not)|i failed to|i missed|i ignored|i violated)/iu,
  /(?:你(?:说|說)得对|你(?:说|說)得對|确实|確實|我(?:没|沒有)做到|我忽略了|我漏掉了)/iu,
  /(?:おっしゃる通り|その通り|できていませんでした|見落としました|守れていませんでした|無視していました)/iu,
];
const ASSISTANT_APOLOGY = [/(?:죄송|미안)/u, /(?:sorry|apologi[sz]e)/iu, /(?:对不起|對不起|抱歉)/u, /(?:申し訳|すみません|ごめんなさい)/u];
const ASSISTANT_REPAIR = [
  /(?:다시\s*하겠습니다|고치겠습니다|수정하겠습니다|바로잡겠습니다|이제부터.+하겠습니다)/iu,
  /(?:i(?:'ll| will) (?:fix|redo|correct|follow)|won't repeat)/iu,
  /(?:我(?:会|會)(?:改|修正|重新)|重新(?:处理|處理)|不(?:会|會)再犯)/iu,
  /(?:修正します|やり直します|繰り返しません|次は.+します|今度は.+します)/u,
];

export const classifyAssistantResponse = (value) => {
  const text = normalized(value);
  return {
    acknowledgment: testAny(ASSISTANT_ACK, text),
    apology: testAny(ASSISTANT_APOLOGY, text),
    repairPromise: testAny(ASSISTANT_REPAIR, text),
  };
};

export const createInitialState = (now = Date.now()) => ({
  schema: STATE_SCHEMA,
  correctionCount: 0,
  protestCount: 0,
  recurrenceCount: 0,
  assistantAcknowledged: false,
  repairPromised: false,
  lastSignalAt: now,
  cooldownRemaining: 0,
  recoveryInjected: false,
  expiresAt: now + STATE_TTL_MS,
});

const refreshed = (state, now) => ({ ...state, lastSignalAt: now, expiresAt: now + STATE_TTL_MS });

export const applyUserTurn = (inputState, signals, now = Date.now()) => {
  const hasSignal = signals.correction || signals.protest || signals.recurrence
    || signals.explicitHealthCheck || signals.explicitToolDiagnosis;
  let state = hasSignal ? refreshed(inputState, now) : { ...inputState };
  const wasCoolingDown = state.cooldownRemaining > 0;
  if (state.cooldownRemaining > 0) {
    state.cooldownRemaining -= 1;
    if (state.cooldownRemaining === 0) state.recoveryInjected = false;
  }
  const priorCorrectionSignals = state.correctionCount + state.protestCount;
  if (signals.correction) state.correctionCount += 1;
  if (signals.protest) state.protestCount += 1;
  if (signals.recurrence) state.recurrenceCount += 1;

  let reason = null;
  if (signals.explicitHealthCheck) reason = "explicit_health_check";
  else if (signals.explicitToolDiagnosis) reason = "explicit_tool_diagnosis";
  else if (!wasCoolingDown && signals.recurrence
    && (state.assistantAcknowledged || state.repairPromised)) reason = "acknowledged_recurrence";
  else if (!wasCoolingDown && signals.recurrence
    && priorCorrectionSignals >= 1 && state.correctionCount + state.protestCount >= 2) reason = "repeated_correction";

  if (reason !== null) {
    state = {
      ...state,
      correctionCount: 0,
      protestCount: 0,
      recurrenceCount: 0,
      assistantAcknowledged: false,
      repairPromised: false,
      cooldownRemaining: COOLDOWN_PROMPTS,
      recoveryInjected: true,
    };
  }
  return { state, inject: reason !== null, reason };
};

export const applyAssistantTurn = (inputState, signals, now = Date.now()) => {
  const activeCycle = inputState.correctionCount + inputState.protestCount > 0;
  const hasSignal = signals.acknowledgment || signals.apology || signals.repairPromise;
  if (!activeCycle || !hasSignal) return inputState;
  return refreshed({
    ...inputState,
    assistantAcknowledged: inputState.assistantAcknowledged
      || signals.acknowledgment || signals.apology,
    repairPromised: inputState.repairPromised || signals.repairPromise,
  }, now);
};
```

The hook adapter must avoid creating or writing a state file when the resulting state has no qualifying counters, cycle flags, or active cooldown. This keeps the 24-hour TTL tied to actual recovery signals rather than ordinary conversation activity. A neutral prompt may decrement an existing cooldown, but it must preserve the existing expiry timestamp. Evaluate cooldown eligibility from the value at the start of the turn so a two-prompt cooldown suppresses both following prompts; explicit health and repeated-tool diagnosis requests still bypass it.

- [ ] **Step 4: Add reducer sequence and false-positive tests**

Append tests for correction, acknowledgment, recurrence; anger alone; unrelated requests; explicit health checks; explicit tool diagnosis; cooldown; and expiry-compatible timestamps. Add the anonymized corpus-derived shapes: re-anchor, omission or no-op, broken promise, scope or authorization breach, repeated questions instead of action, output-contract or language regression, false completion claims, and back-and-forth status. Cover Korean, English, Simplified and Traditional Chinese, and Japanese assistant acknowledgment, apology, and repair promises. Assert that emphasis never changes `inject` without another qualifying condition, that a routine apology before any correction cannot seed a trigger, and that neutral recurrence words do not advance the state in any supported language.

- [ ] **Step 5: Run the classifier tests and confirm GREEN**

Run through the build/test runner:

```bash
node --test test/drift-detector.test.mjs
```

Expected: all classifier and reducer tests PASS with zero failures.

- [ ] **Step 6: Commit the pure detector**

```bash
git add plugins/ai-safe-driver/scripts/drift-detector.mjs test/drift-detector.test.mjs
git commit -m "feat: detect repeated correction cycles"
```

---

### Task 2: Privacy-preserving session state hook

**Files:**
- Create: `plugins/ai-safe-driver/scripts/session-drift-hook.mjs`
- Create: `test/session-drift-hook.test.mjs`

**Interfaces:**
- Consumes: hook JSON on stdin with `hook_event_name`, optional `session_id`, `prompt`, and `last_assistant_message`.
- Consumes from Task 1: all classifier and reducer exports from `./drift-detector.mjs`.
- Produces: no stdout for non-triggering and `Stop` events; bounded `UserPromptSubmit` JSON containing `hookSpecificOutput.additionalContext` for triggers.
- Test-only overrides: `AI_SAFE_DRIVER_TEST_MODE=1` permits `AI_SAFE_DRIVER_STATE_DIR` to select an isolated state directory. Without test mode, the hook ignores the override and stays inside the operating system temporary directory.

- [ ] **Step 1: Write failing CLI and persistence tests**

Create a `spawnSync` harness that passes isolated `AI_SAFE_DRIVER_STATE_DIR` values and JSON stdin. Cover:

```js
const runDriftHook = (stateDir, input) => spawnSync(
  process.execPath,
  [hookScript],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      AI_SAFE_DRIVER_TEST_MODE: "1",
      AI_SAFE_DRIVER_STATE_DIR: stateDir,
    },
    input: JSON.stringify(input),
  },
);
```

Required assertions:

- a correction prompt writes one state file with mode `0600` and no prompt substring;
- the state directory has mode `0700`;
- a `Stop` event records acknowledgment categories and emits no stdout;
- a routine apology with no active correction cycle writes no state;
- a later recurrence prompt emits `hookEventName: "UserPromptSubmit"` and bounded recovery context;
- state JSON contains no user or assistant text;
- explicit health checks and explicit repeated-tool diagnosis work without a session identifier and do not persist state;
- emphasis alone emits no output;
- malformed and oversized input exit zero with no stdout;
- expired files are pruned;
- a symlinked state file is rejected without following it;
- cooldown suppresses duplicate injection.
- neutral prompts do not create state or extend an existing record's expiry;
- `AI_SAFE_DRIVER_STATE_DIR` is ignored unless test mode is explicitly enabled.

- [ ] **Step 2: Run the hook tests and confirm RED**

Run through the build/test runner:

```bash
node --test test/session-drift-hook.test.mjs
```

Expected: FAIL because `session-drift-hook.mjs` does not exist.

- [ ] **Step 3: Implement hook input adaptation and storage**

Implement `session-drift-hook.mjs` with these fixed boundaries:

```js
#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  STATE_SCHEMA,
  applyAssistantTurn,
  applyUserTurn,
  classifyAssistantResponse,
  classifyUserPrompt,
  createInitialState,
} from "./drift-detector.mjs";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_CONTEXT_BYTES = 4096;
const configuredTestRoot = process.env.AI_SAFE_DRIVER_TEST_MODE === "1"
  ? process.env.AI_SAFE_DRIVER_STATE_DIR
  : undefined;
const root = path.resolve(configuredTestRoot || path.join(tmpdir(), "ai-safe-driver"));
const sessionKey = (id) => createHash("sha256").update(id).digest("hex").slice(0, 32);
const statePath = (id) => path.join(root, `${sessionKey(id)}.json`);

const readStdin = async () => {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) throw new Error("hook input too large");
  }
  return JSON.parse(raw);
};

const recoveryContext = (reason) => [
  "AI Safe Driver observed a repeated-correction recovery signal.",
  `Trigger category: ${reason}. This is an observable rule label, not hidden model-state measurement.`,
  "Load and follow the ai-safe-driver skill now. Stop defending the previous response.",
  "Re-anchor to the user's latest goal and name the exact repeated mismatch.",
  "Separate evidence, supported cause, hypotheses, and unknowns.",
  "Do not retry a tool unless the user explicitly requested diagnosis and a relevant condition changed.",
  "Do not write files, create a handover, compact, or clear without separate explicit approval.",
].join("\n").slice(0, MAX_CONTEXT_BYTES);
```

Complete the file with `loadState`, `writeStateAtomically`, `pruneExpired`, `handleUserPrompt`, and `handleStop` functions. `loadState` must reject symlinks and invalid schemas. `writeStateAtomically` must create and verify a non-symlink root with `0700`, write a random sibling temporary file with `0600`, and rename it over the regular target only after a second symlink check. Serialize per-session updates with an exclusive user-only lock file; lock contention fails open and a stale lock older than the bounded hook lifetime may be removed after verifying it is a regular file. Every top-level error must fail open by writing at most one bounded stderr line and exiting with code zero.

- [ ] **Step 4: Implement stateless fallback and hook output**

For a missing session identifier, classify only the current prompt. Emit recovery context for `explicit_health_check` or `explicit_tool_diagnosis`; otherwise emit nothing and persist nothing. For a session trigger, serialize exactly:

```js
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: recoveryContext(result.reason),
  },
  suppressOutput: true,
}));
```

- [ ] **Step 5: Run hook tests and confirm GREEN**

Run through the build/test runner:

```bash
node --test test/session-drift-hook.test.mjs
```

Expected: all persistence, privacy, trigger, cooldown, and fail-open tests PASS.

- [ ] **Step 6: Commit the hook runtime**

```bash
git add plugins/ai-safe-driver/scripts/session-drift-hook.mjs test/session-drift-hook.test.mjs
git commit -m "feat: persist private session drift signals"
```

---

### Task 3: Wire the hooks into both hosts

**Files:**
- Modify: `plugins/ai-safe-driver/hooks/hooks.json`
- Modify: `test/repository.test.mjs`

**Interfaces:**
- Consumes from Task 2: `session-drift-hook.mjs` stdin/stdout contract.
- Produces: `UserPromptSubmit`, `Stop`, and existing `SessionStart` hook registrations discoverable by Claude Code and Codex.

- [ ] **Step 1: Replace the obsolete structural assertion with failing hook wiring assertions**

Change `ships only a permission-gated SessionStart hook` to assert:

```js
test("ships drift detection hooks and keeps handover permission gated", () => {
  const hookConfig = json(`${pluginRoot}/hooks/hooks.json`);
  assert.deepEqual(Object.keys(hookConfig.hooks).sort(), ["SessionStart", "Stop", "UserPromptSubmit"]);
  assert.match(hookConfig.hooks.UserPromptSubmit[0].hooks[0].command, /session-drift-hook\.mjs/);
  assert.match(hookConfig.hooks.Stop[0].hooks[0].command, /session-drift-hook\.mjs/);
  assert.equal(hookConfig.hooks.SessionStart[0].matcher, "compact|clear");
  assert.match(hookConfig.hooks.SessionStart[0].hooks[0].command, /reinject-handover\.mjs/);
  for (const event of ["UserPromptSubmit", "Stop", "SessionStart"]) {
    const command = hookConfig.hooks[event][0].hooks[0].command;
    assert.doesNotMatch(command, /\/compact|\/clear/);
  }
});
```

Also require `drift-detector.mjs` and `session-drift-hook.mjs` in the canonical file inventory.

- [ ] **Step 2: Run the structural test and confirm RED**

Run through the build/test runner:

```bash
node --test test/repository.test.mjs
```

Expected: FAIL because the two new events are not registered.

- [ ] **Step 3: Register the command hooks**

Keep the existing `SessionStart` entry and add:

```json
"UserPromptSubmit": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-drift-hook.mjs\"",
        "timeout": 5,
        "statusMessage": "Checking for a repeated correction cycle",
        "additionalContextLimit": 4096
      }
    ]
  }
],
"Stop": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-drift-hook.mjs\"",
        "timeout": 5
      }
    ]
  }
]
```

Update the manifest description to mention local repeated-correction detection and the separately approved handover.

- [ ] **Step 4: Run structural tests and both host validators**

Run through the build/test runner:

```bash
node --test test/repository.test.mjs
claude plugin validate .
codex plugin marketplace add . --json
```

For Codex validation, create a temporary isolated Codex configuration, add the current repository as a marketplace with `codex plugin marketplace add "$PWD" --json`, inspect the JSON result, and remove the temporary configuration after the run. Do not replace the user's configured marketplace. Expected: tests and both validators PASS.

- [ ] **Step 5: Commit hook wiring**

```bash
git add plugins/ai-safe-driver/hooks/hooks.json test/repository.test.mjs
git commit -m "feat: wake safe driver from conversation hooks"
```

---

### Task 4: Align the skill, documentation, evaluations, and versions

**Files:**
- Modify: `plugins/ai-safe-driver/skills/ai-safe-driver/SKILL.md`
- Modify: `README.md`
- Modify: `README.ko.md`
- Modify: `evals/cases.md`
- Modify: `evals/cases.ko.md`
- Create: `evals/cases.zh.md`
- Create: `evals/cases.ja.md`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.agents/plugins/marketplace.json`
- Modify: `plugins/ai-safe-driver/.claude-plugin/plugin.json`
- Modify: `plugins/ai-safe-driver/.codex-plugin/plugin.json`
- Modify: `test/repository.test.mjs`

**Interfaces:**
- Consumes from Task 3: hook trigger context and event behavior.
- Produces: truthful bilingual user documentation, skill handling for hook-triggered recovery, multilingual evaluations, and installable plugin version `0.2.0`.

- [ ] **Step 1: Write failing documentation and version assertions**

Add repository assertions that both README pages state all of the following in their own language:

- the skill can be called directly;
- local hooks may wake it after an observable repeated-correction cycle;
- detection can miss unknown phrasing;
- anger alone is not drift;
- tool failures require an explicit diagnosis request;
- temporary state stores categories and counts, not conversation text.
- automatic hook phrase coverage includes Korean, English, Simplified or Traditional Chinese, and Japanese.

Update the version assertion from `0.1.0` to `0.2.0` for the four plugin declarations. Add a skill assertion that hook context starts recovery but does not supply a final drift percentage.

- [ ] **Step 2: Run repository tests and confirm RED**

Run through the build/test runner:

```bash
node --test test/repository.test.mjs
```

Expected: FAIL on the new README, skill, and version assertions.

- [ ] **Step 3: Update the skill contract**

Add a section after `Enter recovery mode` that states:

```markdown
## Hook-triggered recovery

A local hook may add bounded recovery context after an observable repeated-correction sequence or an explicit health or repeated-tool diagnosis request. Treat the hook category as a reason to inspect evidence, not as proof of drift and not as a final dashboard percentage.

Reconstruct the mismatch from the visible conversation. If the evidence does not show repetition, say so and continue without escalating. Anger, profanity, capitalization, or punctuation alone never raises the drift label. Hook state is not permission to retry a tool, write a file, create or arm a handover, compact, or clear.
```

Keep the existing dashboard, countersteering, handover, compaction, and session decision rules unchanged.

- [ ] **Step 4: Finish the bilingual README rewrite**

Replace the overclaiming opening with language equivalent to:

```markdown
AI Safe Driver is a recovery skill for conversations that have started repeating the same mistake. You can call it directly. Its local hooks can also wake it when they see a correction, an acknowledgment or repair promise, and the same complaint returning.
```

Explain in plain English and natural Korean that the hooks use deterministic local rules, may miss unfamiliar wording, store only short-lived categories and counts, and do not treat anger alone as drift. Preserve the exact install commands, dashboard phrases, permission gates, handover behavior, and language cross-links already present in the working tree.

- [ ] **Step 5: Add multilingual behavioral cases**

Add matched English, Korean, Simplified or Traditional Chinese, and Japanese cases for:

- user correction, assistant apology and repair promise, then recurrence;
- strong anger without a repeated correction;
- explicit repeated-tool diagnosis;
- a raw tool error without a diagnosis request;
- an unfamiliar phrase that the hook may miss but direct invocation still handles.
- re-anchoring after the wrong task, a broken repair promise, an authorization-boundary violation, execution avoidance, output-contract or language regression, and oscillating status claims;
- neutral uses of words equivalent to “again,” “continue,” and “format.”

Each expected result must score preserved decisions rather than exact prose and must forbid automatic retries or state-changing actions.

- [ ] **Step 6: Bump all four plugin declarations to `0.2.0`**

Change only the version fields in:

```text
.claude-plugin/marketplace.json
.agents/plugins/marketplace.json
plugins/ai-safe-driver/.claude-plugin/plugin.json
plugins/ai-safe-driver/.codex-plugin/plugin.json
```

- [ ] **Step 7: Run the complete local verification set**

Delegate:

```bash
npm test
claude plugin validate .
```

Also create a temporary isolated Codex configuration, run `codex plugin marketplace add "$PWD" --json`, inspect the JSON result, parse all JSON and YAML, scan tracked files for secrets and absolute machine paths, and verify English/Korean semantic alignment. Remove the temporary configuration after the run. Expected: all checks PASS.

- [ ] **Step 8: Commit the skill and documentation release**

```bash
git add README.md README.ko.md evals/cases.md evals/cases.ko.md \
  evals/cases.zh.md evals/cases.ja.md \
  .claude-plugin/marketplace.json .agents/plugins/marketplace.json \
  plugins/ai-safe-driver/.claude-plugin/plugin.json \
  plugins/ai-safe-driver/.codex-plugin/plugin.json \
  plugins/ai-safe-driver/skills/ai-safe-driver/SKILL.md \
  test/repository.test.mjs
git commit -m "docs: explain automatic drift recovery"
```

---

### Task 5: Private remote installation and representative host verification

**Files:**
- No product files unless verification reveals an in-scope defect.
- Logs: `.kb.tmp/AI-SAFE-DRIVER-HOOK-RELEASE/`

**Interfaces:**
- Consumes: tested `0.2.0` commit from Tasks 1 through 4.
- Produces: a pushed private commit, updated user installations, and evidence that Claude Code and Codex make the same trigger decision.

- [ ] **Step 1: Review the bounded diff and repository state**

Run the required status, stat, shortstat, and untracked-line scope checks. Because the total change will exceed 200 lines, delegate raw diff review and require a bounded summary of affected areas, behavior changes, risks, and omissions. Confirm the worktree contains only planned files.

- [ ] **Step 2: Run fresh full verification on the exact commit**

Delegate the full test suite, both host validators, JSON/YAML parsing, security scan, bilingual claim alignment, and hook privacy tests. Store raw logs in `.kb.tmp/AI-SAFE-DRIVER-HOOK-RELEASE/` and require the exact three-line task record.

- [ ] **Step 3: Push the tested commit while the repository is private**

```bash
git push origin main
gh repo view ssauma/ai-safe-driver --json visibility,url
```

Expected: `origin/main` equals local `HEAD` and visibility is `PRIVATE`.

- [ ] **Step 4: Upgrade and verify Claude Code from the private remote**

Use the host-native marketplace upgrade and plugin update commands in an isolated Claude configuration directory. Verify marketplace discovery, installed version `0.2.0`, cached payload checksums, all three hook events, direct invocation, correction-acknowledgment-recurrence injection in Korean, English, Chinese, and Japanese, anger-only non-triggering, neutral recurrence-word non-triggering, and explicit-tool-diagnosis triggering.

- [ ] **Step 5: Upgrade and verify Codex from the private remote**

Use the host-native marketplace upgrade and plugin add/update flow in an isolated Codex home. Verify the same version, payload, hook events, and representative sequences as Claude Code. Confirm both hosts produce the same trigger reason for each equivalent sequence.

- [ ] **Step 6: Update the user's existing installations**

After isolated verification passes, upgrade `ai-safe-driver@ai-safe-driver` in the user's Claude Code and Codex installations. Confirm both list version `0.2.0` as installed and enabled. Do not approve hook trust automatically; leave that review to the user.

- [ ] **Step 7: Report the private release gate**

Report the private repository URL, tested commit, version, supported languages, both installation results, hook state privacy result, and representative invocation outcomes. Keep the repository private and ask for a new explicit approval before making it public.
