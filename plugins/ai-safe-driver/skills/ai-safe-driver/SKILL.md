---
name: ai-safe-driver
description: |
  Use when the agent keeps repeating a mistake, ignores a correction, retries a failed tool unchanged, breaks an output format again, drifts from the latest request, or makes excuses instead of diagnosing recurrence.
  Also use for a conversation health check, compaction decision, or new-session question.
---

# AI Safe Driver

This file is a low-token router. Do not diagnose from a hook label alone.

## Hook-triggered recovery

A local hook may add bounded recovery context after an observable repeated-correction sequence or an explicit health or repeated-tool diagnosis request. Treat it as a reason to inspect evidence, not as proof of drift and not as a final dashboard percentage.

Confirm one observable condition in the visible conversation:

- the same failure twice, including a correction or broken repair promise;
- an explicit drift check or conversation-health check; or
- an explicit request to diagnose a repeated tool failure; or
- an explicit compaction question or new-session question.

If confirmed, read and follow the [recovery procedure](references/recovery.md). Do not read the recovery procedure unless a condition is confirmed. If the evidence does not show repetition and there is no explicit check, continue without escalating.

Anger, profanity, capitalization, punctuation, or repeated characters alone never raises the drift label. Hook state is not permission to retry a tool, write a file, create or arm a handover, compact, or clear.

Black-comedy mnemonic, not a trigger: if the same problem is getting you yelled at again, do not argue that it feels unfair—check the evidence and recover.

## Permission route

Diagnosis is read-only. File writes, handover arming, compaction, and context reset require explicit runtime approval.

When recovery evidence makes a continuity handover relevant, you may read the bundled handover procedure without mutation approval: [handover procedure](references/handover.md). Reading the procedure is not approval to write or arm anything. Follow its separate approval gates for the handover and local-exclude writes, then for the exact `compact` or `clear` action. Countersteering remains discussion-only and never authorizes either gate.
