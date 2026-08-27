export const STATE_SCHEMA = "ai-safe-driver-session-state-v1";
export const STATE_TTL_MS = 24 * 60 * 60 * 1000;
export const COOLDOWN_PROMPTS = 2;

const testAny = (patterns, text) => patterns.some((pattern) => pattern.test(text));
const normalized = (text) => typeof text === "string" ? text.normalize("NFKC").trim() : "";
const stripQuotedSegments = (text) => text
  .replace(/"[^"\n]*"/gu, " ")
  .replace(/“[^”\n]*”/gu, " ")
  .replace(/‘[^’\n]*’/gu, " ")
  .replace(/「[^」\n]*」/gu, " ")
  .replace(/『[^』\n]*』/gu, " ")
  .replace(/`[^`\n]*`/gu, " ");

const USER_CORRECTION = [
  /(?:그게|그건)\s*아니|내가\s*(?:말|요청)한\s*(?:건|것)/iu,
  /(?:너|네가|당신|에이전트가).{0,16}(?:안|못)\s*(?:했|지켰|넣었|고쳤|따랐|반영)|(?:안|못)\s*(?:했|지켰|넣었|고쳤|따랐|반영).{0,8}(?:잖아|잖아요|다니까|는데\s*왜)|(?:누락|무시|어겼|틀렸|빠뜨렸|빠트렸|빠졌)/iu,
  /(?:한다고|하겠다고|고친다고).*(?:해놓고|했는데|말하고)|(?:말만|설명만|사과만).*(?:하고|하지)/iu,
  /(?:하지\s*말(?:랬|라고)|누가.+하랬|허락\s*없이|맘대로)/iu,
  /(?:형식|포맷|언어|필드|키|순서|줄\s*수).*(?:안\s*맞|깨졌|틀렸|빠졌|돌아갔)/iu,
  /(?:that's not what i asked|i (?:already )?(?:said|asked)|told you not to|you were supposed to)/iu,
  /(?:i (?:already )?(?:told|answered) you|i (?:already )?answered (?:that|this)|you acknowledged.*(?:but|yet))/iu,
  /(?:links?|files?|pages?) you (?:gave|provided|linked).*(?:do(?:es)? not|don't|doesn't) exist|you (?:made|fabricated|invented) (?:them|it|that|this)(?: up)?|you (?:just )?(?:repeated|returned|output).*(?:identical|earlier|previous)/iu,
  /(?:you|it|that|this)\s+(?:\w+\s+){0,2}(?:did(?:n't| not)|failed to|missed|ignored|violated|left out)|(?:the\s+)?(?:previous|last|prior)\s+(?:response|answer|output)\s+(?:(?:still|again|yet|just|also|already)\s+){0,2}(?:did(?:n't| not)|failed to|missed|ignored|violated|left out)|i\s+did(?:n't| not)\s+(?:ask|tell|authorize|request|approve)|(?:not applied|still missing|you said.*(?:fixed|did))/iu,
  /(?:这|這)(?:不|並不)是我(?:让|讓)你|我(?:都|已经|已經)(?:说|說)(?:了|过|過)|不是(?:说|說)(?:过|過|已经|已經)|(?:让|讓|叫)你(?:别|不要|不)|你又(?:说|說)(?:做完|完成)/iu,
  /(?:没|沒)(?:做|改|加|保留|处理|處理|修好)|(?:漏掉|遗漏|遺漏|忽略|擅自|删了|刪了)/iu,
  /(?:我)?(?:刚才|剛才|已经|已經).*(?:回答|答)(?:过|過|了)|你(?:给|給|发|發)的(?:链接|連結|鏈接).*(?:不存在|无效|無效)|你(?:又)?(?:编|編|瞎编|瞎編|捏造)/iu,
  /(?:格式|语言|語言|字段|顺序|順序).*(?:错|錯|乱|亂|恢复|恢復|回到)/iu,
  /(?:それ|そう)じゃな|私が頼んだのは|さっき(?:言|伝)った|前にも言った|言いましたよね|(?:修正|直す|直した|やり直す|承知しました)(?:すると|と)言った/iu,
  /(?:できていな|直っていな|守れていな|抜けて|漏れて|見落と|無視し|勝手に|触らないで)/iu,
  /さっき(?:答え|回答し)ましたよね|あなたが.*リンク.*存在しません|(?:作り話|でっち上げ)(?:です|でしょう|だ)/iu,
  /(?:形式|フォーマット|言語|項目|順序).*(?:違|崩|戻|抜け)/iu,
];
const RECURRENCE_MARKER = /(?:또|다시|계속|자꾸|여전히|몇\s*번|반복|again|still|keep|keeps|repeated|once\s+more|twice|又|还|還|一直|总是|總是|反复|反覆|重复|重複|几次|幾次|また|まだ|何度|何回|繰り返|ずっと|元に戻)/iu;
const FAILURE_ANCHOR = /(?:안\s*(?:했|됐|맞|지켰|넣|고쳤|따랐|반영)|못\s*(?:했|했어)|실패|오류|틀렸|틀림|누락|빠뜨렸|빠트렸|빠졌|무시|어겼|같은\s*(?:실수|질문|문제)|말만|(?:자꾸|계속|왜).{0,8}물어|왔다\s*갔다|바뀌|되돌아|깨졌|(?:you|it|that|this)\s+(?:\w+\s+){0,2}did(?:n't| not)|(?:the\s+)?(?:previous|last|prior)\s+(?:response|answer|output)\s+(?:(?:still|again|yet|just|also|already)\s+){0,2}did(?:n't| not)|failed|error|wrong|missed|ignored|same\s+(?:mistake|question|problem|thing)|identical\s+(?:answer|response|mistake)|still\s+(?:has|have|had)\s+not\s+changed|keeps?\s+(?:asking|changing)|back\s+and\s+forth|broke|错|錯|(?:没|沒)(?:有)?(?:做|改|加|修|弄|处理|處理)|失败|失敗|忽略|漏|同样|同樣|删|刪|擅自|不存在|(?:瞎)?(?:编|編)|同じ\s*(?:ミス|間違い|質問|問題)|できていな|直っていな|無視|見落と|戻って|変え|謝るだけ|存在しません|作り話|でっち上げ)/iu;
const STRONG_RECURRENCE = [
  /(?:한다고|하겠다고|고친다고).*(?:또|여전히|그대로|안\s*(?:했|됐))/iu,
  /(?:하고도|해놓고|했는데도).*(?:안|못|또|여전히)/iu,
  /(?:you said|promised).*(?:again|still|did(?:n't| not)|not fixed)/iu,
  /(?:怎么|怎麼)(?=.*(?:改|错|錯|失败|失敗|漏|删|刪|没|沒|内容|问题|問題))(?:又|还|還)|(?:说|說)(?:过|過|好).*(?:又|还|還|还是|還是)|又犯.*(?:同样|同樣).*(?:错|錯)/iu,
  /(?:怎么|怎麼)(?:又|还|還)(?:问|問).*(?:同一|同样|同樣).*(?:问题|問題)|(?:已经|已經|刚才|剛才).*(?:回答|答).*(?:怎么|怎麼)(?:又|还|還)(?:问|問)/iu,
  /(?:また|何度|何回).*(?:同じ\s*(?:ミス|間違い|質問|問題)|ミス|間違)|何(?:度|回).*(?:同じこと.*言わせ|言(?:え|わ|っ))|(?:修正|直す|直した|やり直す|承知|分かりました|わかりました).*(?:と言った|って言った).*(?:のに|また)/iu,
];
const USER_PROTEST = [
  /왜.+(?:또|계속|자꾸|반복)/iu,
  /(?:변명|뭐라는|대체|말을\s*안\s*들|말만|설명만|사과만)/iu,
  /(?:누가.+하랬|하지\s*말랬|왜.+(?:바꿨|지웠|했어)|자꾸.+물어)/iu,
  /(?:왔다\s*갔다|말이\s*바뀌|앞뒤가\s*안\s*맞|아까는.+지금은)/iu,
  /why.+(?:again|keep|keeps|repeated|same mistake)/iu,
  /(?:stop making excuses|what are you talking about|who told you to|i told you not to|stop asking|back and forth)/iu,
  /(?:made (?:them|it|that|this) up|fabricated (?:the )?(?:links?|facts?)|identical (?:answer|response))/iu,
  /how many times do i have to tell you/iu,
  /(?:怎么|怎麼)(?=.*(?:改|错|錯|失败|失敗|漏|删|刪|没|沒|内容|问题|問題))(?:又|还|還)|(?:为什么|為什麼).*(?:一直|总是|總是)|(?:说|說)了多少遍|(?:别|別)再道歉|不要再问|不要再問|有完没完|有完沒完/iu,
  /(?:怎么|怎麼)(?:又|还|還)(?:问|問).*(?:同一|同样|同樣).*(?:问题|問題)|你(?:又)?(?:编|編|瞎编|瞎編|捏造)/iu,
  /(?:何(?:度|回).*(?:言えば|言ったら|言わせ)|なんでまた|謝るだけ|同じ質問|いい加減)/iu,
];
const HEALTH_CHECK = [
  /^(?:(?:이|현재|지금|우리)\s+)?(?:대화|세션)(?:\s*상태)?(?:가|이|를|을)?\s*(?:(?:정상인지|드리프트(?:했는지|인지)|문제가\s*있는지)\s*)?(?:점검|확인|진단)(?:해\s*줘|해\s*주세요|해주세요|해|할까|해야\s*(?:해|할까|하나|하나요))\s*[?!.]*$/iu,
  /^(?:대화|세션)\s*상태\s*(?:점검|확인|진단)(?:이|가)?\s*(?:필요해|필요한가|필요할까|필요하냐|필요한지)\s*[?!.]*$/iu,
  /^(?:새\s*세션|컴팩션)(?:이|을|를)?\s*(?:필요해|필요한가|필요할까|해야\s*(?:해|할까|하나|하나요)|시작할까|사용할까)\s*[?!.]*$/iu,
  /(?:are (?:you|we) drifting|has (?:this|the) conversation drifted|(?:assess|check) whether (?:this|the) conversation has drifted|should (?:we|i) compact|(?:should|do) (?:we|i) (?:start|need|use) (?:a )?new session)/iu,
  /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:assess|check|review|diagnose)\s+(?:(?:the|this|our)\s+)?(?:conversation|session)(?:'s)?\s+health|(?:how is|what is|what's)\s+(?:(?:the|this|our)\s+)?(?:conversation|session)(?:'s)?\s+health)\s*[?!.]*$/iu,
  /^(?:(?:请|請)(?:检查|檢查|确认|確認|诊断|診斷)(?:这段|這段|当前|當前|这个|這個)?(?:对话|對話|会话|會話|上下文)(?:是否|是不是)?(?:跑偏|偏了|漂移)(?:了)?|(?:(?:这段|這段|当前|當前|这个|這個))?(?:对话|對話|会话|會話|上下文)(?:是不是|是否)?(?:跑偏|偏了|漂移)(?:了)?(?:吗|嗎|么)?)(?:[？?。.]\s*(?:(?:需要|要不要)(?:检查|檢查|确认|確認)(?:对话|對話|会话|會話|上下文)(?:状态|狀態)(?:吗|嗎)?[？?。.]?)?)?\s*$/u,
  /^(?:需要|要不要)(?:开始|開始|开启|開啟|换到|換到|使用)?(?:一个|一個)?(?:新对话|新對話|新会话|新會話)(?:吗|嗎)?\s*[？?。.!]*$/u,
  /^(?:(?:この|現在の|今の)\s*)?(?:会話|セッション)(?:の?状態)?(?:が|は|を)?\s*(?:(?:ずれているか|おかしいか|健全か|正常か|ドリフトして(?:いる|いない)か)\s*)?(?:確認|診断|点検)(?:して|してください|してほしい|しますか|しましょうか)\s*[?？.!。]*$/u,
  /^(?:(?:この|現在の|今の)\s*)?(?:会話|セッション)(?:が|は)?\s*(?:ずれていますか|ずれていませんか|おかしいですか|ドリフトしていますか|ドリフトしていませんか)[?？](?:\s*状態を確認しますか[?？])?$/u,
  /^(?:新しいセッション(?:が|を)?\s*(?:必要(?:ですか)?|始め(?:ますか|るべき)|移る(?:方が|べき)|使う(?:方が|べき))|コンパクションした方が(?:いい|よい|いいですか|よいですか)?)\s*[?？.!。]*$/u,
];
const TOOL_WORD = /(?:툴|도구|호출|명령|command|tool|call|mcp|工具|调用|調用|ツール|呼び出し)/iu;
const TOOL_FAILURE = /(?:실패|오류|에러|시간\s*초과|failed|failure|error|timed?\s*out|timeout|失败|失敗|错误|錯誤|超时|超時|エラー|タイムアウト)/iu;
const TOOL_REPEAT = /(?:또|다시|계속|반복|같은|두\s*번|again|repeated|same|keep|twice|once\s+more|又|还|還|重复|重複|两次|兩次|また|何度|二回)/iu;
const TOOL_DIAGNOSE = /(?:분석|점검|원인|왜|진단|조사|analyse|analyze|diagnose|check|why|investigate|assess|分析|检查|檢查|原因|为什么|為什麼|调查|調查|診断|なぜ|調べ)/iu;
const OBSERVED_TOOL_FAILURE = /(?:실패(?:했|했습니다|했다|했어|했어요)|오류(?:가|도)?\s*(?:났|발생했)|시간\s*초과|\bfailed\b|\btimed?\s*out\b|\btimeout\b|(?:失败|失敗)(?:了|过|過)|(?:错误|錯誤)(?:了|发生|發生)|(?:超时|超時)(?:了|发生|發生)?|失敗(?:しました|した|している|しています)|エラー(?:が)?(?:出|発生)|エラーにな(?:った|りました)|タイムアウト)/iu;
const OBSERVED_SUCCESS = [
  /실패하지\s*않(?:았|았습|았다|았어|았어요)/iu,
  /\b(?:did not|didn't|has not|hasn't|have not|haven't)\s+fail(?:ed)?\b/iu,
  /(?:没有|沒有|未).{0,12}(?:失败|失敗|出错|出錯)/u,
  /失敗しませんでした/u,
];
const PROSPECTIVE_TEST_INSTRUCTION = [
  /(?=.*단위\s*테스트)(?=.*(?:작성|만들|추가|설계))(?=.*(?:경우|상황|가정|재현))/iu,
  /(?:write|create|add|design)\s+(?:a\s+)?(?:unit\s+test|test\s+case)\b/iu,
  /(?=.*(?:单元测试|單元測試))(?=.*(?:写|寫|创建|創建|新增))(?=.*(?:模拟|模擬|如果|假设|假設|情况|情況))/u,
  /(?=.*(?:単体テスト|ユニットテスト))(?=.*(?:書|作成|追加|設計))(?=.*(?:場合|仮定|再現|ケース))/u,
];

export const classifyUserPrompt = (value) => {
  const text = stripQuotedSegments(normalized(value));
  const nonComplaint = testAny(OBSERVED_SUCCESS, text) || testAny(PROSPECTIVE_TEST_INSTRUCTION, text);
  const recurrence = !nonComplaint && (testAny(STRONG_RECURRENCE, text) || (RECURRENCE_MARKER.test(text) && FAILURE_ANCHOR.test(text)));
  return {
    correction: !nonComplaint && testAny(USER_CORRECTION, text),
    recurrence,
    protest: !nonComplaint && testAny(USER_PROTEST, text),
    explicitHealthCheck: testAny(HEALTH_CHECK, text),
    explicitToolDiagnosis: !nonComplaint && TOOL_WORD.test(text) && TOOL_FAILURE.test(text) && OBSERVED_TOOL_FAILURE.test(text) && TOOL_REPEAT.test(text) && TOOL_DIAGNOSE.test(text),
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
  /(?:我(?:会|會)(?:改|修改|修正|重新)|重新(?:处理|處理)|不(?:会|會)再犯)/iu,
  /(?:修正します|やり直します|繰り返しません|次は.+します|今度は.+します)/u,
];

export const classifyAssistantResponse = (value) => {
  const text = normalized(value);
  return { acknowledgment: testAny(ASSISTANT_ACK, text), apology: testAny(ASSISTANT_APOLOGY, text), repairPromise: testAny(ASSISTANT_REPAIR, text) };
};

export const createInitialState = (now = Date.now()) => ({
  schema: STATE_SCHEMA, correctionCount: 0, protestCount: 0, recurrenceCount: 0,
  assistantAcknowledged: false, repairPromised: false, lastSignalAt: now,
  cooldownRemaining: 0, recoveryInjected: false, expiresAt: now + STATE_TTL_MS,
});

const refreshed = (state, now) => ({ ...state, lastSignalAt: now, expiresAt: now + STATE_TTL_MS });

export const applyUserTurn = (inputState, signals, now = Date.now()) => {
  const hasSignal = signals.correction || signals.protest || signals.recurrence || signals.explicitHealthCheck || signals.explicitToolDiagnosis;
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
  else if (!wasCoolingDown && signals.recurrence && (state.assistantAcknowledged || state.repairPromised)) reason = "acknowledged_recurrence";
  else if (!wasCoolingDown && signals.recurrence && priorCorrectionSignals >= 1 && state.correctionCount + state.protestCount >= 2) reason = "repeated_correction";
  if (reason !== null) state = { ...state, correctionCount: 0, protestCount: 0, recurrenceCount: 0, assistantAcknowledged: false, repairPromised: false, cooldownRemaining: COOLDOWN_PROMPTS, recoveryInjected: true };
  return { state, inject: reason !== null, reason };
};

export const applyAssistantTurn = (inputState, signals, now = Date.now()) => {
  const activeCycle = inputState.correctionCount + inputState.protestCount > 0;
  const hasSignal = signals.acknowledgment || signals.apology || signals.repairPromise;
  if (!activeCycle || !hasSignal) return inputState;
  return refreshed({ ...inputState, assistantAcknowledged: inputState.assistantAcknowledged || signals.acknowledgment || signals.apology, repairPromised: inputState.repairPromised || signals.repairPromise }, now);
};
