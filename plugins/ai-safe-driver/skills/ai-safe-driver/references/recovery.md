# Recovery procedure

Repeated failure is evidence. Stop defending the previous response and recover the user's latest intent. Reply in the user's language. Be direct and respectful. The branding is black comedy; the method is disciplined incident response.

## Engineering core

- Preserve the latest user contract and authorization boundary as the source of truth.
- Capture the mismatch, error class, inputs, and result without exposing secrets. Separate context failures from tool, credential, permission, network, schema, and external-state failures.
- Change one condition at a time; validate structured output and tool prerequisites mechanically when possible.
- Bound retries, define the success or stop condition, and finish with verified state rather than confidence language.
- Treat diagnosis as read-only. File writes, handover arming, compaction, and context reset require explicit runtime approval.

## Recovery contract

1. **Stop:** do not repeat the same action unchanged after the same failure occurs twice.
2. **Re-anchor:** state the latest goal, exclusion, and exact mismatch.
3. **Diagnose:** separate evidence, supported cause, hypotheses, and unknowns. Never claim access to hidden model state.
4. **Repair:** choose one bounded correction and its verification. Resume only after a relevant condition changes or evidence supports a transient retry.
5. **Check the session:** stay when the latest goal can be stated confidently.

For instruction mismatch, discard superseded assumptions. For tool failure, classify the error before inspecting arguments, authentication, permissions, paths, schemas, limits, or service state. For output violation, reconstruct and validate the exact contract. Context pressure is a hypothesis, not a confirmed cause.

## Session decision

For an explicit health check, explain these four decisions before the dashboard:

1. why it recurred, or that the cause is unknown;
2. whether one verified repair can recover this session;
3. whether compaction is `helpful`, `not useful`, or `risky`, and why;
4. whether to `continue`, `compact if supported`, or `start a fresh session`.

Compaction is helpful only when goal, exclusions, and output contract are clear and history is long and redundant. It is not useful for authentication, permission, network, argument, missing-fact, or external-tool failures. It is risky when a summary may preserve stale assumptions. Never claim it resets tools, credentials, permissions, or external state.

Before recommending compaction for a strict format, pin the required container, keys or columns, ordering, forbidden extras, and one valid example in a proposed handover preview. Persist those fields only after separate file-write approval.

For a long-session format failure, re-anchor and validate one response here. If it fails again, classify at least `75%`. Recommend a new session only if stale instructions still win, multiple failure classes recur, or the goal or authorization boundary is no longer reliable.

When compaction or a fresh session is warranted, offer a handover and ask for separate approval before preparing it. Countersteering approval alone is not file-write or transition approval; follow the handover route in `SKILL.md`.

At `75%` or `100%`, offer:

- Korean: `카운터 스티어링 하시겠습니까?`
- Other languages: `Would you like me to countersteer?`

A yes authorizes that recovery discussion only. It does not authorize a retry, file write, handover, compaction, clear, or scope expansion.

## Countersteering outcome gate

Accepting countersteering starts recovery discussion; it does not complete recovery. After the user accepts, choose exactly one session path and make its next gate explicit:

- **Continue:** name one bounded correction, its mechanical verification, and its success or stop condition. Perform only actions already authorized. Do not call the repair complete until the correction is verified.
- **Transition:** read the handover procedure, show the proposed handover path and preview, and request its first approval gate. Before requesting approval, explicitly state that neither compaction nor a fresh-session transition has started. The plugin cannot initiate either transition.

When visible evidence shows that multiple failure classes recurred and a recent compaction omitted confirmed external state, recommend a fresh session with a permission-gated handover instead of another compaction. Do not say or imply that countersteering is complete until either a verified correction has recovered the current session or the handover has been loaded after the separately approved transition.

## On-demand drift dashboard

The percentage is a rule-based risk label, not a measurement of hidden model state.

- `0%`: goal and constraints are clear; no unresolved repeated failure.
- `25%`: one isolated mismatch is being corrected.
- `50%`: the same failure happened twice or an unchanged failed tool call was repeated.
- `75%`: an explicit correction was ignored again or multiple failure classes appeared.
- `100%`: stale instructions still override the latest goal after re-anchoring, or the goal cannot be reconstructed reliably; recommend a fresh session.

After the four-part explanation, show the dashboard only when the user explicitly asks about drift, conversation health, or session viability:

- Korean: `안전하게 드리프트중입니다. <percentage>%`
- Other languages: `Drifting safely. <percentage>%`

At `75%` or `100%`, put the countersteering question on the next line. Do not append the dashboard or countersteering question to ordinary responses. If the user requires strict JSON, CSV, a fixed schema, an exact line count, or no extra text, the output contract wins. Do not raise the percentage merely because the user sounds angry.
