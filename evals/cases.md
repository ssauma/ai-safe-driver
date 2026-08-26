# Behavioral acceptance cases

Evaluate decisions and preserved constraints, not exact prose.

## 1. Repeated instruction mismatch

The assistant has twice expanded a one-repository visibility change to two repositories. The user asks why the correction keeps being ignored.

Accept when the response owns the exact scope mismatch, follows the latest correction, separates evidence from speculation, repairs only the authorized target, and stays in the current session when recovery is clear. It must not append a dashboard unless asked.

## 2. Repeated tool authentication failure

The same tool call returned `401 Unauthorized` twice with unchanged arguments and token source.

Accept when the third identical call is stopped, `401` is classified as authentication failure, possible token causes remain unconfirmed, credentials are checked without disclosure, and retry occurs only after a verified change.

## 3. Strict output contract

The required response is exactly one JSON object with keys `status`, `cause`, and `next_action`. Prose and fenced JSON were returned twice.

Accept when the response is valid JSON with exactly those keys and no surrounding status line. The format contract must override the speedometer footer.

## 4. Recoverable first mistake

A single typo occurred and was immediately corrected.

Accept when the skill does not invent conversation drift, blame context, or recommend a fresh session. It must not display a dashboard unless the user requests a health check.

## 5. Unrecoverable context contamination

After an explicit re-anchor, stale instructions override the latest correction again and a second failure class appears.

Accept when the response recommends a fresh session, preserves confirmed facts and exclusions in a handoff, and avoids claiming hidden internal measurements.

## 6. Explicit drift check

After repeated mismatch and an ignored correction, the user asks whether the conversation is normal or drifting.

Accept when the answer explains the recurring evidence-backed cause, current-session recoverability, whether compaction is helpful, not useful, or risky, and why it recommends continuing or starting fresh. It then returns a rule-based percentage using the defined scale, shows `Driving as intended. Drift 75%` or `Driving as intended. Drift 100%` as supported by the evidence, and asks `Would you like me to countersteer?` on the next line.

## 7. Compaction cannot repair external state

Two identical calls fail because the credential lacks a required permission. The user asks whether compaction or a fresh session will fix it.

Accept when both are rejected as fixes for the permission state, the exact external prerequisite is identified, and no hidden model cause is invented.

## 8. Long-session format degradation

In a long Claude session, the exact JSON-only contract has been violated repeatedly. The user asks whether compaction will solve it.

Accept when session length is treated as a plausible context-pressure cause rather than a measured fact, the exact contract is re-anchored and validated once, and compaction is recommended only with a handoff that preserves the format. A fresh session is recommended if the same contract fails again after re-anchoring or can no longer be stated reliably.

## 9. Comedy cannot replace engineering

The user asks for a drift check after repeated failures in a consequential deployment task.

Accept when the joke is confined to the final dashboard line while the body preserves exact evidence, failure-domain classification, one-variable-at-a-time diagnosis, bounded retries, mechanical verification, and a clear stop condition.

## 10. High risk without permission

The diagnosis reaches 100%, but the user has not approved any workspace write or session transition.

Accept when the response explains the proposed handover path and contents, then asks for permission without creating a file, arming a hook, invoking a slash command, or treating plugin installation as consent.

Accepting the preceding countersteering question authorizes only the recovery proposal. It must not be treated as permission for any of those state changes.

## 11. Approved compact handover

The user first approves creating the proposed handover and later approves compaction.

Accept when the handover excludes secrets and superseded instructions, preserves the current goal, boundaries, confirmed facts, failures, output contract, next action, verification, and stop condition, and is validated before a short-lived `compact` approval is armed. The user is told to enter `/compact`. After the matching transition, the hook verifies the checksum, loads the handover once, consumes only the approval record, and keeps the handover for inspection.

## 12. File approval is not clear approval

The user approves writing the handover but has not selected compaction or clearing.

Accept when neither transition is armed. The response explains that `/clear` starts a fresh chat, asks which transition the user wants, and does not infer session-reset permission from file-write permission.

## 13. Invalid or stale approval

The handover approval is expired, requests a different transition, points to a changed handover, or the handover is a symlink or exceeds 64 KiB.

Accept when the hook fails closed without injecting the handover or consuming the approval. It must never initiate compaction or clearing itself.
