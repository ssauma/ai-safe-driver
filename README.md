# AI Safe Driver

English | [Korean](README.ko.md)

AI Safe Driver is a recovery skill for conversations that have started repeating the same mistake. You can call it directly. Local deterministic hooks may also wake it when they observe a correction, an acknowledgment or repair promise, and the same complaint returning. The hooks provide a reason to inspect the visible conversation, not a final diagnosis.

These rules may miss unfamiliar wording, so direct invocation remains available. Anger alone is not drift. A tool failure needs an explicit diagnosis request before the hook treats it as a diagnostic signal. Temporary state stores only short-lived categories, counts, and timestamps; it never stores conversation text. Automatic phrase coverage includes Korean, English, Simplified and Traditional Chinese, and Japanese.

The dashboard is deliberately a little ridiculous. When you ask for a health check, it may report `Drifting safely. 0%` or `Drifting safely. 100%`. It stays out of ordinary replies. The number is a rule-based label, not a reading of model weights, attention, or some hidden internal drift meter.

At 75% or 100%, it asks `Would you like me to countersteer?` That means stopping the approach that keeps failing and suggesting one limited way to recover. A yes only starts that discussion. It does not give the plugin permission to write files, retry tools, compact the conversation, or clear the session. Those actions still need separate approval.

Claude Code and Codex use the same skill. The plugin also includes local recovery hooks and a handover hook. Recovery hooks never retry tools, write project files, create or arm a handover, compact, or clear. The handover hook normally does nothing and runs only after you approve and prepare a one-time handover. There is no executable installer, MCP server, network code, or automatic update check.

## Install

### Claude Code

```text
/plugin marketplace add ssauma/ai-safe-driver
/plugin install ai-safe-driver@ai-safe-driver
```

Run `/ai-safe-driver:ai-safe-driver`, or just describe what is going wrong: the same mistake, the same failed tool call, an ignored correction, or an output format that keeps breaking.

### Codex

```bash
codex plugin marketplace add ssauma/ai-safe-driver
codex plugin add ai-safe-driver@ai-safe-driver
```

Start a new Codex session and run `$ai-safe-driver`. You can also describe the repeated failure in your own words.

## Automatic recovery hooks

The recovery hooks look for a narrow, observable sequence: a correction, an assistant acknowledgment or repair promise, and a recurring complaint. They may also respond to an explicit conversation-health check or an explicit request to diagnose repeated tool failures. A raw tool error is not enough. Capitalization, profanity, punctuation, repeated characters, and frustration do not raise the label by themselves.

When a hook wakes the skill, its category is only a lead. The skill must reconstruct the mismatch from the visible conversation and continue normally if repetition is not supported. The hook does not calculate a final drift percentage or grant permission for any state-changing action.

## What you can say

The skill can recognize requests like these:

- `Why do you keep making the same mistake?`
- `You ignored my correction again.`
- `Stop making excuses and tell me the cause.`
- `You repeated the same failed tool call.`
- `You broke the output format again.`
- `This long session keeps losing the required format.`
- `Are you drifting?`
- `Are you operating normally?`
- `Should we start a new session?`

## What it does

- Stops retrying the same thing unchanged after it fails repeatedly
- Keeps observed facts, supported causes, hypotheses, and unknowns from getting mixed together
- Goes back to your latest instruction instead of following an older assumption
- Checks tool requirements or the exact output format before trying again
- Stays in the current session when it can recover with confidence
- Tells you whether compaction would help, make no difference, or preserve the wrong context
- Suggests a short handover when compaction or a new session is actually needed
- Reloads that handover after `/compact` or `/clear`, but only when you approved it first

The jokes are self-deprecating. The recovery process is not. It returns to your latest instructions, records what actually failed, separates conversation problems from tool or environment problems, changes one condition at a time, checks the result, limits retries, and leaves a clean handover when the session needs to end.

## On-demand drift check

Ask whether the conversation is drifting and the skill will choose 0%, 25%, 50%, 75%, or 100% from visible failure patterns. Before showing the number, it explains what keeps going wrong, whether the current session can recover, whether compaction would help, and whether a new session makes sense. Ordinary replies do not get a status line.

At 75% or 100%, the diagnosis ends with the dashboard and the countersteering question. At lower levels, it does not add the question just to land the joke.

Compaction is useful when the goal and required output are still clear but the conversation has become long and repetitive. Before recommending it, the skill writes down the format, required keys, exclusions, and one valid example for the handover. Compaction cannot fix authentication, permissions, network trouble, bad tool arguments, or missing facts. It may make things worse if the summary keeps an old assumption or drops your latest correction.

## Permission-gated handover

Diagnosis is read-only. A high-risk result may suggest a handover, but the skill asks separately before it:

1. creates or replaces `.ai-safe-driver/handover.md`; and
2. arms one specific transition: `compact` or `clear`.

Installing the plugin or trusting its hook does not approve either action. You still type `/compact` or `/clear` yourself; the plugin never runs those commands for you. `/compact` summarizes the current conversation and keeps going. `/clear` starts a new chat, so the skill treats it as the more disruptive choice.

The bundled `SessionStart` hook works once per approval. It loads the handover only when the requested transition and file checksum match a short-lived approval record. Afterward, it removes the approval record but leaves the handover file for inspection. Without valid approval, the hook exits quietly and changes nothing. Claude Code and Codex may also ask you to review and trust this third-party hook before running it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and release checks.

## License

MIT
