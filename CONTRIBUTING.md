# Contributing

English | [Korean](CONTRIBUTING.ko.md)

## Checks

Run deterministic repository tests:

```bash
npm test
```

Validate the Claude marketplace from the repository root:

```bash
claude plugin validate .
```

Keep version `0.1.0` aligned in both plugin manifests and both marketplace entries. Behavioral acceptance cases live in `evals/cases.md` and `evals/cases.ko.md`.
