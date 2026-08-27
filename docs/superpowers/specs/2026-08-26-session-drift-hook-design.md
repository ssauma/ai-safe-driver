# Session drift hook design

## Goal

Wake AI Safe Driver when a conversation shows a repeated correction cycle, even if the model does not select the skill on its own. The hook detects observable conversation patterns. It does not claim to measure hidden model state.

The main pattern is:

1. the user says that an instruction was missed, ignored, or violated;
2. the assistant acknowledges the miss, apologizes, or promises to correct it; and
3. the user reports that the same problem happened again.

Tool failures remain opt-in. The hook wakes the skill for a tool problem only when the user explicitly says that a tool call failed repeatedly or asks for that failure to be diagnosed.

## Non-goals

- Do not infer drift from anger, profanity, capitalization, or repeated punctuation alone.
- Do not monitor tool results automatically.
- Do not retry tools, write project files, create a handover, run `/compact`, or run `/clear`.
- Do not store prompt or response text in hook state.
- Do not send conversation text to a network service or model classifier.
- Do not replace the skill's evidence-based diagnosis with a hook score.

## Components

### User prompt hook

A `UserPromptSubmit` command hook classifies the current user message into zero or more local signal categories:

- correction: the user says something was not done, was done incorrectly, or ignored a stated constraint;
- recurrence: the user says the same problem happened again or continued after correction;
- protest: the user asks why the agent keeps repeating, excusing, or failing;
- explicit health check: the user directly asks whether the conversation is drifting or needs a new session;
- explicit tool diagnosis: the user names a repeated tool failure and asks for analysis;
- emphasis: capitalization, repeated punctuation, repeated characters, or unusually forceful wording.

Emphasis is classified only to enforce the negative rule: it is neither persisted nor emitted and cannot create a trigger on its own.

The correction and protest categories recognize several recurring shapes in Korean, English, Simplified or Traditional Chinese, and Japanese without storing their wording:

- re-anchor: the user says the answer addressed the wrong thing or restates what was actually requested;
- omission or no-op: the user says a requested change is still missing, unchanged, or was claimed but not applied;
- broken repair promise: the user says the agent promised to fix something and then repeated it;
- scope or authorization breach: the user says an excluded action was taken, an instruction not to act was ignored, or permission was assumed;
- execution avoidance: the user says the agent keeps asking, explaining, apologizing, or promising instead of doing the bounded task;
- output-contract regression: the user says a required format, language, field, order, or no-extra-text constraint was lost again;
- oscillation: the user reports that the answer, status, or chosen direction keeps flipping back and forth.

Recurrence markers such as “again,” “still,” `또`, `다시`, and `계속` are too common to classify alone. They count only when the same prompt also contains a failure, mismatch, reversal, or protest anchor, or when a stronger recurrence phrase explicitly refers to the same mistake. Neutral phrases equivalent to “continue,” “another question,” or “explain again” do not count as recurrence.

The same boundary applies across languages. Chinese `又` commonly marks a recurrence that already happened, while `再` often asks for a future repetition; Japanese `また` can mean an ordinary “again.” None of these characters triggers without a failure anchor. The classifier recognizes combinations equivalent to “why did you do it again,” “I already told you,” “the same mistake again,” “you said you fixed it but it is still unchanged,” and “the format returned to the old version.”

### Assistant response hook

A `Stop` command hook examines the host-provided last assistant message and records categories rather than text:

- acknowledgment: the assistant agrees that it missed or violated the request;
- apology: the assistant apologizes for the failure;
- repair promise: the assistant says it will correct, retry differently, or follow the requested format next time.

These phrases do not count as drift by themselves. They matter only when a later user prompt reports recurrence.

An assistant acknowledgment, apology, or repair promise is recorded only when a user correction or protest has already started a recovery cycle. A routine apology in an unrelated exchange cannot seed a later drift trigger.

### Session state

The hooks share a small JSON state record keyed by a one-way hash of the host session identifier. The record contains only:

- schema version;
- counters for correction, recurrence, and protest signals;
- booleans for acknowledgment and repair promise;
- the most recent signal timestamps;
- cooldown and expiry timestamps;
- whether recovery context has already been injected for the current cycle.

No user prompt, assistant response, repository path, tool input, tool output, secret, or handover content is stored.

State lives under the operating system's temporary directory in an `ai-safe-driver` subdirectory. Files are regular files created with user-only permissions. Each hook invocation removes expired records before reading or writing the current one. A record expires no later than 24 hours after its last signal; neutral turns do not extend that lifetime. A fresh session uses a different hashed key.

### Recovery context

When the state machine triggers, the user prompt hook emits bounded additional context that tells the host agent to:

1. load AI Safe Driver;
2. stop defending the previous response;
3. restate the latest user goal and the exact repeated mismatch;
4. separate evidence, supported cause, hypotheses, and unknowns;
5. avoid retrying a tool unless the user explicitly requested tool diagnosis and a condition has changed; and
6. ask for separate permission before any write, handover, compaction, or clear action.

The hook does not display the dashboard itself. The skill decides whether a dashboard is appropriate and assigns the rule-based percentage.

## Trigger rules

Recovery context is injected when any of these conditions is true:

- the user asks for an explicit drift or conversation-health check;
- the user explicitly requests analysis of a repeated tool failure;
- a recurrence signal follows an assistant acknowledgment, apology, or repair promise in the same session; or
- at least two correction or protest signals occur in the same session and the later message contains a recurrence signal.

An emphasis signal changes no decision on its own. It is not retained in session state, and the skill must not raise risk merely because the user sounds angry.

After injection, the record enters a two-prompt cooldown. New evidence is still counted, but the hook does not inject the same recovery reminder on every message. An explicit health check bypasses the cooldown.

## Host behavior

Claude Code and Codex use the same classifier and state machine. Host-specific wrapper scripts may translate hook input and output, but they must produce the same categories and trigger decision for the same user and assistant text.

Hook output contains only `hookSpecificOutput.hookEventName` and `hookSpecificOutput.additionalContext`. Claude Code ignores the retained `SessionStart.additionalContextLimit: 5000` manifest setting, while Codex uses it as the spill threshold. The `UserPromptSubmit` handler has no corresponding limit because its recovery context is already capped at 320 UTF-8 bytes.

If a host omits a session identifier, the hook fails open without persistence and only handles an explicit health check or explicit tool-diagnosis phrase in the current prompt.

## Privacy and safety

- Classification uses local deterministic rules. There is no network request.
- State stores categories and counts, never conversation text.
- Malformed input, missing fields, state corruption, permission errors, and lock contention fail open without blocking the user's prompt.
- State writes use an atomic temporary-file-and-rename sequence.
- Symlinked state files and files outside the dedicated temporary directory are rejected.
- Hook output is capped and contains instructions only, never copied user text.
- Existing handover permission gates remain unchanged.

## Claude-mem corpus use

The user's local Claude-mem history may be inspected during development to find realistic Korean and English correction patterns. Raw prompts, assistant replies, project names, and quoted conversation text remain local. Only anonymized pattern categories and synthetic evaluation cases may be committed.

Examples supplied directly by the user include repeated assistant phrases such as `맞습니다`, `안 했습니다`, `죄송합니다`, and statements equivalent to “you said you would do it and still did not.” These examples inform categories, not exact-match-only rules.

An aggregate-only review of the local corpus also supports the anonymized categories above: re-anchoring, unchanged or missing work, broken promises, unauthorized scope, repeated questions instead of action, output-contract regression, and back-and-forth status claims. Common standalone words such as “again,” “continue,” “format,” `또`, `계속`, and `형식` appeared too broadly to be safe triggers. Tests therefore include both synthetic positive cases and neutral uses of those words.

## Public multilingual signal review

Public reports add two important drift shapes. One Codex report describes obsolete task state resurfacing after correction and answers becoming disconnected from the newest message. Another model issue describes unchanged broken solutions returning after explicit constraints and corrections, followed by apology without a changed approach. Japanese reports describe a required style or format initially being followed and later returning to the default, or an acknowledgment being followed by substantially the same output. Chinese usage references distinguish completed recurrence with `又` from a request to do something again with `再`, and document complaint constructions that combine “how/why again” with a problematic action.

Sources used to derive categories and synthetic cases:

- [Codex stale conversation state issue](https://github.com/openai/codex/issues/32863)
- [Repeated correction and unchanged solution issue](https://github.com/deepseek-ai/DeepSeek-R1/issues/869)
- [Japanese instruction-regression examples](https://note.com/large_harte6380/n/n7baedcd2d2a5)
- [Japanese instruction drift discussion](https://qiita.com/ha-te/items/1c502c80969ce721f1d9)
- [Chinese `又` and `再` usage examples](https://tiffanysmandarin.com/index.php/2023/08/31/again-chinese-grammar/)

Only the signal categories and newly written synthetic examples enter tests. The hook does not fetch these pages, ship a phrase corpus, or send user text anywhere.

## README contract

The README must not say that AI Safe Driver always notices drift by itself. It should say:

- direct skill invocation always requests a check;
- the prompt and response hooks can wake the skill when the observable repeated-correction sequence is detected;
- detection is rule based and may miss phrasing it does not recognize;
- anger alone is not treated as drift;
- tool failures are analyzed only after an explicit user request; and
- the hooks record only short-lived category counters, not conversation text.

## Testing

### Classifier tests

Cover Korean, English, Simplified and Traditional Chinese, and Japanese examples for corrections, recurrence, protest, acknowledgment, apology, repair promises, explicit health checks, explicit tool diagnosis, emphasis, and neutral uses of the same words.

### Sequence tests

Verify at least these state transitions:

- correction, acknowledgment, recurrence triggers recovery;
- correction, apology, unrelated new request does not trigger;
- anger or profanity without a correction does not trigger;
- two corrections without recurrence wording do not trigger prematurely;
- a routine apology before any correction does not seed a trigger;
- neutral uses of recurrence words, such as another question or a request to continue, do not trigger;
- broken promises, unauthorized scope, execution avoidance, output-contract regression, and oscillating status claims are recognized when coupled to recurrence;
- explicit health check triggers immediately;
- explicit repeated-tool diagnosis triggers immediately;
- a raw tool failure without a user request is ignored;
- cooldown suppresses duplicate injection and explicit health checks bypass it;
- expired state is removed;
- missing session identifiers use the stateless fallback.

### Safety tests

Verify that state contains no source text, files use restrictive permissions, writes are atomic, symlinks are rejected, malformed input fails open, output is bounded, and no hook action writes project files or invokes tools, compaction, or clear.

### Host tests

Validate both plugin manifests, install from the private remote in isolated Claude Code and Codex homes, confirm both hooks are discovered, and run equivalent representative sequences on both hosts. The same sequence must produce the same trigger decision.

## Release gate

Keep the repository private while this change is developed. Public release requires passing structural, behavioral, privacy, host-installation, and representative invocation checks on the pushed commit, followed by a new explicit user approval to make the repository public.
