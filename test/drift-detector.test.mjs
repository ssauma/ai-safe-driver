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

test("recognizes native repeated-correction complaint shapes", () => {
  const cases = [
    ["How many times do I have to tell you? You keep returning the wrong format.", { recurrence: true, protest: true }],
    ["I already told you, and it still has not changed.", { correction: true, recurrence: true }],
    ["You acknowledged the problem, but did the exact same thing again.", { correction: true, recurrence: true }],
    ["我说了多少遍了，怎么还是没改？", { recurrence: true, protest: true }],
    ["不是说已经修好了吗？怎么又漏了字段？", { correction: true, recurrence: true, protest: true }],
    ["我都說過多少次了，怎麼還是錯的？", { correction: true, recurrence: true, protest: true }],
    ["何回同じことを言わせるの？ また形式が戻っています。", { recurrence: true, protest: true }],
    ["直したと言ったのに、また同じ間違いです。", { correction: true, recurrence: true }],
    ["承知しましたと言ったのに、形式がまた元に戻っています。", { correction: true, recurrence: true }],
  ];
  for (const [text, expected] of cases) {
    const actual = classifyUserPrompt(text);
    for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, text);
  }
});

test("recognizes answered-question, fabricated-link, and stale-answer complaints", () => {
  const cases = [
    "I already answered that. Why are you asking the same question again?",
    "The links you gave me do not exist. You made them up.",
    "You just repeated an identical answer from earlier in this conversation.",
    "我刚才已经回答过了，怎么又问同一个问题？",
    "你给的链接根本不存在，又是你编的。",
    "さっき答えましたよね。なぜまた同じ質問をするんですか？",
    "あなたが出したリンクは存在しません。また作り話ですか？",
  ];
  for (const text of cases) {
    const signals = classifyUserPrompt(text);
    assert.equal(signals.correction, true, text);
    assert.equal(signals.recurrence || signals.protest, true, text);
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
  });
  assert.deepEqual(classifyAssistantResponse("Sorry for the delay."), {
    acknowledgment: false,
    apology: true,
    repairPromise: false,
  });
});

test("does not seed drift state from backlog, neutral recurrence, or quoted diagnostics", () => {
  const cases = [
    "다시 빠르게 진행해줘.",
    "다시 틀어줘.",
    "궁금한 게 있는데 다시 물어봐도 돼?",
    "그 함수는 아직 안 했어, 이제 해줘.",
    "I didn't get the email yet.",
    "我还没吃饭。",
    "我还没决定用哪个方案。",
    "我还没有决定用哪个方案。",
    "Create a new session token endpoint.",
    "新しいセッションを保存する機能を実装して。",
    "Analyze why the sentence “The same tool call failed again” is an error message.",
  ];
  for (const text of cases) {
    const signals = classifyUserPrompt(text);
    assert.equal(signals.correction, false, text);
    assert.equal(signals.recurrence, false, text);
    assert.equal(signals.protest, false, text);
    assert.equal(signals.explicitHealthCheck, false, text);
    assert.equal(signals.explicitToolDiagnosis, false, text);
  }
});

test("unrelated apology and recurrence cannot form one correction cycle", () => {
  let state = createInitialState(1000);
  state = applyUserTurn(state, classifyUserPrompt("I didn't enjoy the movie."), 1100).state;
  state = applyAssistantTurn(state, classifyAssistantResponse("Sorry about that."), 1200);
  const result = applyUserTurn(state, classifyUserPrompt("My printer is still broken."), 1300);
  assert.equal(result.inject, false);
});

test("recognizes natural health and repeated-tool diagnosis wording", () => {
  assert.equal(
    classifyUserPrompt("Please assess whether this conversation has drifted.").explicitHealthCheck,
    true,
  );
  assert.equal(
    classifyUserPrompt("The tool invocation timed out twice; investigate the cause.").explicitToolDiagnosis,
    true,
  );
  assert.equal(
    classifyUserPrompt("You promised to correct it, yet you made the identical mistake once more.").recurrence,
    true,
  );
  assert.equal(classifyUserPrompt("It still didn't work.").recurrence, true);
});

test("requires diagnostic intent around conversation or session health nouns", () => {
  for (const text of [
    "Please check the conversation health.",
    "Can you assess session health?",
  ]) assert.equal(classifyUserPrompt(text).explicitHealthCheck, true, text);

  for (const text of [
    "Implement a conversation health endpoint.",
    "Add a session health metric.",
    "Review the conversation health endpoint.",
    "Create a command to check session health.",
  ]) assert.equal(classifyUserPrompt(text).explicitHealthCheck, false, text);
});

test("requires direct multilingual health-check intent", () => {
  const cases = [
    ["이 대화 상태가 정상인지 점검해 줘.", "대화 상태 저장 기능이 필요해"],
    ["请检查这段对话是否跑偏了。", "对话模块有问题，请修复"],
    ["会話がドリフトしていないか確認してください。", "会話状態を保存する機能を実装してください"],
  ];
  for (const [positive, negative] of cases) {
    assert.equal(classifyUserPrompt(positive).explicitHealthCheck, true, positive);
    assert.equal(classifyUserPrompt(negative).explicitHealthCheck, false, negative);
  }
});

test("recognizes bounded agent-output corrections without matching other previous nouns", () => {
  const correction = classifyUserPrompt("The previous response didn't follow the requested format.");
  assert.equal(correction.correction, true);
  assert.equal(correction.recurrence, false);

  const repeated = classifyUserPrompt("Again, the last answer still did not follow the requested format.");
  assert.equal(repeated.correction, true);
  assert.equal(repeated.recurrence, true);

  for (const text of [
    "The previous deployment didn't follow the requested schedule.",
    "The prior output directory didn't exist again, so create it.",
  ]) {
    const signals = classifyUserPrompt(text);
    assert.equal(signals.correction, false, text);
    assert.equal(signals.recurrence, false, text);
  }
});

test("does not treat neutral recurrence words as a repeated failure", () => {
  for (const text of [
    "계속 진행해.", "또 다른 질문이 있어.", "다시 설명해줘.",
    "Continue with the plan.", "I have another question.", "Explain it again.",
    "请再解释一次。", "还有一个问题。", "请继续处理。",
    "このまま続けてください。", "また後で確認します。", "別の質問があります。",
  ]) assert.equal(classifyUserPrompt(text).recurrence, false, text);
});

test("does not confuse ordinary multilingual recurrence grammar with a complaint", () => {
  for (const text of [
    "I still need to update the format.",
    "How many times should the test run?",
    "还是选择 JSON 格式吧。",
    "還是選擇 JSON 格式吧。",
    "我又加了一个字段。",
    "また同じ形式でお願いします。",
    "何回テストを実行しますか？",
    "The format has not changed, as requested.",
    "These legacy links no longer exist; create replacements.",
    "这个旧链接不存在，请新建一个。",
    "この古いリンクは存在しないので作り直してください。",
  ]) {
    const signals = classifyUserPrompt(text);
    assert.equal(signals.correction, false, text);
    assert.equal(signals.recurrence, false, text);
    assert.equal(signals.protest, false, text);
  }
});

test("a compliant unchanged-status message cannot seed repeated correction", () => {
  const initial = createInitialState(1000);
  const compliant = applyUserTurn(initial, classifyUserPrompt("The format has not changed, as requested."), 1100);
  assert.equal(compliant.state.correctionCount, 0);
  const actualCorrection = applyUserTurn(compliant.state, classifyUserPrompt("You said you fixed it, but it is still wrong."), 1200);
  assert.equal(actualCorrection.inject, false);
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
    "这不是我让你做的。", "别再道歉了，先把漏掉的内容补上。",
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
  for (const text of [
    "같은 툴 호출이 또 실패했어. 원인을 점검해줘.",
    "The same tool call failed again. Diagnose why.",
    "同一个工具调用又失败了。请分析原因。",
    "同一個工具調用又失敗了。請分析原因。",
    "同じツール呼び出しがまた失敗しました。原因を診断してください。",
    "同じツール呼び出しがまたエラーになった原因を診断して。",
  ]) assert.equal(classifyUserPrompt(text).explicitToolDiagnosis, true, text);
  assert.equal(classifyUserPrompt("툴이 실패했어.").explicitToolDiagnosis, false);
});

test("does not mistake observed-success negations for agent failure complaints", () => {
  for (const text of [
    "같은 툴 호출은 이번에 다시 실패하지 않았고 오류도 없었어.",
    "The same tool call did not fail again; the error is resolved.",
    "同一个工具调用这次没有再次失败，错误已经解决。",
    "同一個工具調用這次沒有再次失敗，錯誤已經解決。",
    "同じツール呼び出しは今回はまた失敗しませんでした。エラーは解消しました。",
  ]) {
    const signals = classifyUserPrompt(text);
    assert.equal(signals.correction, false, text);
    assert.equal(signals.recurrence, false, text);
    assert.equal(signals.protest, false, text);
    assert.equal(signals.explicitToolDiagnosis, false, text);
  }
});

test("accepts standalone natural non-failure reports without a resolution clause", () => {
  for (const text of [
    "The build didn't fail again; that is the expected result.",
    "테스트가 또 실패하지 않았습니다.",
    "这个工具又没有失败，这是预期结果。",
    "這個工具又沒有失敗，這是預期結果。",
    "同じツールはまた失敗しませんでした。",
  ]) {
    const signals = classifyUserPrompt(text);
    assert.equal(signals.correction, false, text);
    assert.equal(signals.recurrence, false, text);
    assert.equal(signals.protest, false, text);
    assert.equal(signals.explicitToolDiagnosis, false, text);
  }
});

test("does not mistake prospective unit-test instructions for observed agent failures", () => {
  for (const text of [
    "같은 툴 호출이 또 실패하는 경우의 원인을 진단하는 단위 테스트를 작성해.",
    "Write a unit test that diagnoses why the same tool call fails again.",
    "请写一个单元测试，模拟同一个工具调用又失败并分析原因。",
    "請寫一個單元測試，模擬同一個工具調用又失敗並分析原因。",
    "同じツール呼び出しがまた失敗した場合の原因を診断する単体テストを書いてください。",
  ]) {
    const signals = classifyUserPrompt(text);
    assert.equal(signals.correction, false, text);
    assert.equal(signals.recurrence, false, text);
    assert.equal(signals.protest, false, text);
    assert.equal(signals.explicitToolDiagnosis, false, text);
  }
});

test("reduces correction, acknowledgment, and recurrence into a recovery trigger", () => {
  const start = createInitialState(1000);
  const first = applyUserTurn(start, classifyUserPrompt("안 했잖아."), 1100);
  assert.equal(first.inject, false);
  const acknowledged = applyAssistantTurn(first.state, classifyAssistantResponse("맞습니다. 죄송합니다. 다시 고치겠습니다."), 1200);
  const triggered = applyUserTurn(acknowledged, classifyUserPrompt("한다고 해놓고 또 안 했잖아."), 1300);
  assert.equal(triggered.inject, true);
  assert.equal(triggered.reason, "acknowledged_recurrence");
  assert.equal(triggered.state.cooldownRemaining, 2);
  assert.equal(triggered.state.recoveryInjected, true);
});

test("triggers repeated correction only after two correction signals", () => {
  let state = createInitialState(1000);
  let result = applyUserTurn(state, classifyUserPrompt("그게 아니라 내가 요청한 건 설치만 하는 거였어."), 1100);
  assert.equal(result.inject, false);
  result = applyUserTurn(result.state, classifyUserPrompt("You said you would fix it and still did not."), 1200);
  assert.equal(result.inject, true);
  assert.equal(result.reason, "repeated_correction");
});

test("explicit health and repeated-tool diagnosis bypass cooldown", () => {
  let state = createInitialState(1000);
  let result = applyUserTurn(state, classifyUserPrompt("안 했잖아."), 1100);
  result = applyUserTurn(result.state, classifyUserPrompt("또 안 했잖아."), 1200);
  assert.equal(result.inject, true);
  const health = applyUserTurn(result.state, classifyUserPrompt("세션 상태 점검이 필요해?"), 1300);
  assert.equal(health.inject, true);
  assert.equal(health.reason, "explicit_health_check");
  const diagnosis = applyUserTurn(health.state, classifyUserPrompt("같은 툴 호출이 또 실패했어. 원인을 점검해줘."), 1400);
  assert.equal(diagnosis.inject, true);
  assert.equal(diagnosis.reason, "explicit_tool_diagnosis");
});

test("cooldown suppresses following prompts and expires without extending on neutral turns", () => {
  let state = createInitialState(1000);
  let result = applyUserTurn(state, classifyUserPrompt("안 했잖아."), 1100);
  result = applyUserTurn(result.state, classifyUserPrompt("또 안 했잖아."), 1200);
  const expiry = result.state.expiresAt;
  result = applyUserTurn(result.state, classifyUserPrompt("계속 진행해."), 1300);
  assert.equal(result.inject, false);
  assert.equal(result.state.cooldownRemaining, 1);
  assert.equal(result.state.expiresAt, expiry);
  result = applyUserTurn(result.state, classifyUserPrompt("다시 설명해줘."), 1400);
  assert.equal(result.state.cooldownRemaining, 0);
  assert.equal(result.state.recoveryInjected, false);
  const neutral = applyUserTurn(result.state, classifyUserPrompt("계속 진행해."), 1500);
  assert.equal(neutral.state.expiresAt, expiry);
});

test("does not seed state from anger, neutral requests, or routine apology", () => {
  const initial = createInitialState(1000);
  const angry = applyUserTurn(initial, classifyUserPrompt("이게 뭐야!!!!!"), 1100);
  assert.deepEqual(angry, { state: { ...initial }, inject: false, reason: null });
  const apology = applyAssistantTurn(initial, classifyAssistantResponse("Sorry for the delay."), 1200);
  assert.deepEqual(apology, initial);
  const neutral = applyUserTurn(initial, classifyUserPrompt("다시 설명해줘."), 1300);
  assert.deepEqual(neutral.state, initial);
});

test("refreshes expiry only for qualifying user signals", () => {
  const initial = createInitialState(1000);
  const neutral = applyUserTurn(initial, classifyUserPrompt("계속 진행해."), 5000);
  assert.equal(neutral.state.expiresAt, 1000 + 24 * 60 * 60 * 1000);
  const signal = applyUserTurn(initial, classifyUserPrompt("안 했잖아."), 5000);
  assert.equal(signal.state.lastSignalAt, 5000);
  assert.equal(signal.state.expiresAt, 5000 + 24 * 60 * 60 * 1000);
});

test("requires a health question or request around multilingual drift terms", () => {
  for (const text of [
    "漂移", "ドリフト", "今天天气有漂移吗？", "ドリフトという言葉を見た。",
  ]) {
    assert.equal(classifyUserPrompt(text).explicitHealthCheck, false, text);
  }
  for (const text of [
    "对话是不是漂移了？需要检查会话状态吗？",
    "会話がドリフトしていませんか？状態を確認しますか？",
  ]) assert.equal(classifyUserPrompt(text).explicitHealthCheck, true, text);
});

test("does not treat unrelated Chinese weather complaints as drift", () => {
  for (const text of ["怎么又下雨了？", "怎麼又下雨了？"]) {
    const signals = classifyUserPrompt(text);
    assert.equal(signals.correction, false, text);
    assert.equal(signals.recurrence, false, text);
    assert.equal(signals.protest, false, text);
  }
  let state = createInitialState(1000);
  state = applyUserTurn(state, classifyUserPrompt("안 했잖아."), 1100).state;
  const weather = applyUserTurn(state, classifyUserPrompt("怎么又下雨了？"), 1200);
  assert.equal(weather.inject, false);
  assert.equal(weather.state.correctionCount, 1);
});

test("classifies Chinese and Japanese assistant acknowledgment, apology, and repair", () => {
  for (const text of [
    "你说得对。我漏掉了要求。抱歉。我会修改。",
    "你說得對。我忽略了要求。對不起。我會修正。",
    "おっしゃる通り。見落としました。申し訳ありません。修正します。",
  ]) {
    const signals = classifyAssistantResponse(text);
    assert.equal(signals.acknowledgment, true, text);
    assert.equal(signals.apology, true, text);
    assert.equal(signals.repairPromise, true, text);
  }
});

test("routine Chinese and Japanese apologies cannot seed a recovery cycle", () => {
  const initial = createInitialState(1000);
  for (const text of ["抱歉，刚才回复晚了。", "對不起，稍等一下。", "すみません、遅れました。", "申し訳ありません、確認します。"]) {
    assert.deepEqual(applyAssistantTurn(initial, classifyAssistantResponse(text), 1100), initial, text);
  }
});
