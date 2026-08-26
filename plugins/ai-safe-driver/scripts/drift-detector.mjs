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
];
const RECURRENCE_MARKER = /(?:또|다시|계속|자꾸|여전히|몇\s*번|반복|again|still|keep|keeps|repeated)/iu;
const FAILURE_ANCHOR = /(?:안\s*(?:했|됐|맞|지켰|넣|고쳤|따랐|반영)|못\s*(?:했|했어)|실패|오류|틀|누락|빠|무시|어겼|같은\s*(?:실수|질문|문제)|말만|물어|왔다\s*갔다|바뀌|되돌아|깨졌|did(?:n't| not)|failed|error|wrong|missed|ignored|same\s+(?:mistake|question|problem)|keeps?\s+(?:asking|changing)|back\s+and\s+forth|broke)/iu;
const STRONG_RECURRENCE = [
  /(?:한다고|하겠다고|고친다고).*(?:또|여전히|그대로|안\s*(?:했|됐))/iu,
  /(?:하고도|해놓고|했는데도).*(?:안|못|또|여전히)/iu,
  /(?:you said|promised).*(?:again|still|did(?:n't| not)|not fixed)/iu,
];
const USER_PROTEST = [
  /왜.+(?:또|계속|자꾸|반복)/iu,
  /(?:변명|뭐라는|대체|말을\s*안\s*들|말만|설명만|사과만)/iu,
  /(?:누가.+하랬|하지\s*말랬|왜.+(?:바꿨|지웠|했어)|자꾸.+물어)/iu,
  /(?:왔다\s*갔다|말이\s*바뀌|앞뒤가\s*안\s*맞|아까는.+지금은)/iu,
  /why.+(?:again|keep|keeps|repeated|same mistake)/iu,
  /(?:stop making excuses|what are you talking about|who told you to|i told you not to|stop asking|back and forth)/iu,
];
const HEALTH_CHECK = [
  /(?:드리프트|대화\s*상태|세션\s*상태|정상이냐|새\s*세션|컴팩션).*(?:점검|어때|필요|해야|인가|이야|냐|까)/iu,
  /(?:are (?:you|we) drifting|conversation health|session health|new session|should (?:we|i) compact)/iu,
];
const TOOL_WORD = /(?:툴|도구|호출|명령|command|tool|call|mcp)/iu;
const TOOL_FAILURE = /(?:실패|오류|에러|failed|failure|error)/iu;
const TOOL_REPEAT = /(?:또|다시|계속|반복|같은|again|repeated|same|keep)/iu;
const TOOL_DIAGNOSE = /(?:분석|점검|원인|왜|진단|analyse|analyze|diagnose|check|why)/iu;

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
];
const ASSISTANT_APOLOGY = [/(?:죄송|미안)/u, /(?:sorry|apologi[sz]e)/iu];
const ASSISTANT_REPAIR = [
  /(?:다시\s*하겠습니다|고치겠습니다|수정하겠습니다|바로잡겠습니다|이제부터.+하겠습니다)/iu,
  /(?:i(?:'ll| will) (?:fix|redo|correct|follow)|won't repeat)/iu,
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
  let state = signals.correction || signals.protest || signals.recurrence
    || signals.explicitHealthCheck || signals.explicitToolDiagnosis
    ? refreshed(inputState, now) : { ...inputState };
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
