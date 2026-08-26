# AI Safe Driver

English | [Korean](README.ko.md)

AI Safe Driver helps an agent stop repeating the same failure, identify the evidence-backed cause, recover the current task, and recommend a fresh session only when the conversation can no longer be repaired reliably.

Its intentionally unreliable dashboard reports a metaphorical drift state only when asked, such as `Drifting safely. 0%` or `Drifting safely. 100%`. It does not add a footer to every answer, and it does not measure model weights, attention, or an actual internal drift percentage.

At 75% or 100%, it asks `Would you like me to countersteer?` Countersteering means stopping the failing path and proposing one bounded recovery. Saying yes does not silently authorize file writes, tool retries, compaction, or clearing; consequential actions still require their own explicit approval.

The plugin contains one shared skill and one dormant, permission-gated handover hook for Claude Code and Codex. It has no executable installer, MCP server, network code, or automatic update check. The hook does nothing unless the user has explicitly approved and armed a one-shot handover.

## Install

### Claude Code

```text
/plugin marketplace add ssauma/ai-safe-driver
/plugin install ai-safe-driver@ai-safe-driver
```

Invoke `/ai-safe-driver:ai-safe-driver`, or report a repeated mistake, unchanged failed tool call, ignored correction, or recurring output-format violation.

### Codex

```bash
codex plugin marketplace add ssauma/ai-safe-driver
codex plugin add ai-safe-driver@ai-safe-driver
```

Start a new Codex session and invoke `$ai-safe-driver`, or describe the repeated failure in ordinary language.

## Automatic invocation

Typical signals include:

- `Why do you keep making the same mistake?`
- `You ignored my correction again.`
- `Stop making excuses and tell me the cause.`
- `You repeated the same failed tool call.`
- `You broke the output format again.`
- `This long session keeps losing the required format.`
- `Are you drifting?`
- `Are you operating normally?`
- `Should we start a new session?`

## What it changes

- Stops an unchanged retry after the same failure repeats
- Separates observed facts, direct causes, hypotheses, and unknowns
- Reconstructs the latest instruction and discards superseded assumptions
- Validates tool prerequisites or output contracts before trying again
- Keeps the current session when recovery is reliable
- Explains whether compaction would help, do nothing, or risk preserving the wrong state
- Offers a concise handoff when compaction or a fresh session is genuinely warranted
- Reloads an explicitly approved handover after `/compact` or `/clear`

The surface is self-deprecating black comedy. Underneath, the workflow follows disciplined AI engineering: preserve the latest contract, capture reproducible evidence, separate model-context failures from tool or environment failures, change one condition at a time, validate mechanically, bound retries, and escalate with a clean handoff.

## On-demand drift check

When explicitly asked whether the conversation is operating normally or drifting, the skill returns a rule-based 0%, 25%, 50%, 75%, or 100% assessment. It also explains the recurring cause supported by evidence, whether the current session can recover, whether compaction is useful, and why a fresh session is or is not recommended. It does not display this status on ordinary responses.

For a 75% or 100% result, the diagnosis ends with the dashboard and then asks whether to countersteer. Lower-risk checks do not add the question just for the joke.

Compaction can help when the current goal and exact output contract are clear but a long, redundant history is competing for attention. Before compacting, the skill pins the required format, keys, exclusions, and one valid example in the handoff. It does not repair authentication, permissions, network state, invalid tool arguments, or a missing fact. It can make drift worse when a summary preserves a stale assumption or omits the user's latest correction.

## Permission-gated handover

Diagnosis is read-only. A high-risk result may offer a handover, but the skill must obtain separate runtime approval before it:

1. creates or replaces `.ai-safe-driver/handover.md`; and
2. arms one specific transition: `compact` or `clear`.

Installation and hook trust do not count as either approval. The user still enters `/compact` or `/clear`; the plugin never invokes those commands on its own. `/compact` keeps the conversation but summarizes its context. `/clear` starts a fresh chat and is therefore presented as the more disruptive option.

The bundled `SessionStart` hook is one-shot. It loads the handover only when a short-lived approval record matches the transition and the handover checksum. It then removes the approval record while keeping the handover for inspection. If no valid approval is present, the hook exits without output or changes. Claude Code and Codex both require users to review and trust non-managed plugin hooks before they run.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and release checks.

## License

MIT
