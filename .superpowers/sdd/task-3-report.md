# Task 3 RED checkpoint

## Planned repository assertions

- The canonical plugin inventory includes both the deterministic classifier and the session drift hook.
- The hook registry contains exactly `SessionStart`, `Stop`, and `UserPromptSubmit`.
- `UserPromptSubmit` invokes the session drift hook through `${CLAUDE_PLUGIN_ROOT}`, has a five-second timeout, displays a plain repeated-correction status, and caps injected context at 4096 characters.
- `Stop` invokes the same hook with a five-second timeout and has no status, context, or autonomous-action configuration.
- The existing handover hook remains limited to `compact|clear`; no registered command invokes `/compact` or `/clear`.

## Self-review

- Only the repository contract test and this report changed for the RED checkpoint.
- The assertions inspect the shipped JSON contract directly and should fail because the current registry contains only `SessionStart`.
- No hook configuration or other production file was modified, and verification remains delegated to the parent build/test runner.
