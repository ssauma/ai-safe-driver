# Contributing

English | [Korean](CONTRIBUTING.ko.md)

Thanks for helping improve AI Safe Driver. Keep changes focused: this repository is a small dual-host plugin, and Claude Code and Codex must continue to use the same canonical skill.

By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not through a public issue.

## Before you start

- Search existing issues before opening a new one.
- Use the bug or feature template and remove secrets and private conversation text.
- For a large behavior or permission change, open an issue before writing the implementation.
- Do not add network access, installers, automatic state changes, or broader permissions without an explicit use case and tests.

## Development

Use Node.js 20 or newer. From the repository root, run the deterministic test suite:

```bash
npm test
```

Validate the Claude marketplace:

```bash
claude plugin validate .
```

Behavior tests should preserve meaning and decisions rather than exact wording. Add or update the relevant multilingual cases when trigger coverage or user-visible guidance changes.

Release evidence has three distinct gates:

1. Deterministic unit tests run locally and in trusted CI without credentials.
2. Real print-mode behavior is manually adjudicated against `evals/cases.json`; fixture or fake-adapter actions are not host evidence.
3. Interactive Claude Code and Codex smoke runs follow [the release matrix](docs/release-smoke-test.md) and require explicit runtime approval.

Credentialed/model-backed tests must never run in untrusted pull-request CI. Keep raw prompts, transcripts, host output, and path-bearing logs under `.kb.tmp/`, never in a commit.

## Pull requests

Keep the diff limited to one problem. Explain the observed failure, the chosen correction, verification evidence, token impact, and any permission change. Update every affected localized README when commands, supported languages, safety claims, or behavior changes.

Keep version `0.3.0` aligned in both plugin manifests and both marketplace entries. Do not change only one declaration.
