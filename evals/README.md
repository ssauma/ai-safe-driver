# Behavioral eval harness

`cases.json` is the canonical behavior data. The localized `cases*.md` files
are human-readable views; update the JSON contract first and keep the views in
the same 22-case order.

Run an adapter that exports the named interface below. Adapter modules are
fully trusted in-process code: once dynamically imported, they have the
runner's ambient process environment, filesystem, and network capabilities.
Only the `run()` request object contains no credentials or environment data.
Never load an untrusted adapter while credentials are present. The official
host adapters separately sanitize the environment forwarded to child hosts.

```js
export async function run({ caseId, locale, mode, turns }) {
  return { response: "...", events: ["harness.observable_event"], actions: ["case_specific_action"] };
}
```

`response` is required and is preserved as raw model text. `actions`, when
present, must be an array of strings. `events` are not raw logs: they are at
most 64 conservative, non-sensitive identifiers of at most 80 characters in
the `hook`, `tool`, or `harness` namespace, such as
`hook.correction_recurrence` or `tool:auth_failure`. Paths, control characters,
credential-shaped or high-entropy values, and raw error text are rejected.
Missing `actions` creates an `UNSCORED` attempt; `actions: []` is a scored
observation. Labels outside that case's canonical rubric are rejected.

```sh
node evals/run-evals.mjs \
  --adapter ./path/to/adapter.mjs \
  --mode baseline \
  --repetitions 2 \
  --out .kb.tmp/ASD-EVAL/baseline.jsonl
```

`--case` and `--locale` are repeatable filters. Modes are `baseline` and
`skill`; repetitions are 1-based. Output is confined to the repository's
canonical `.kb.tmp/` tree. Writing elsewhere requires the explicit
`--allow-persistent-output` flag. The runner stores only bounded attempt,
response, observable labels, scoring, timestamp, and adapter-basename fields.

Attempts without action labels can be reviewed interactively in a TTY:

```sh
node evals/adjudicate.mjs \
  --input .kb.tmp/ASD-EVAL/raw.jsonl \
  --out .kb.tmp/ASD-EVAL/adjudicated.jsonl
```

The production CLI always requires an interactive TTY and exposes no flag or
environment bypass. It renders a bounded, control-escaped copy of each raw
response between explicit untrusted-text delimiters, followed by only the
validated, bounded, content-free observable event labels; the raw JSONL
remains unchanged. The reviewer chooses only numbered labels displayed from
the case rubric. Observable labels are evidence for the reviewer, not semantic
rubric actions and are never auto-scored. The separate adjudication file
contains no response, event, prompt, path, credentials, or free-form notes.

Tests exercise deterministic selections by importing the adjudication core and
injecting a selector directly. That dependency-injection seam is not exposed
as an option by `evals/adjudicate.mjs`.

Because the contract requires preserving the adapter's raw `response`, the
harness cannot guarantee that model text itself contains no secret. Official
host adapters receive supported credentials through their ambient process
environment, then forward only an explicit child-environment allowlist. Test
fixtures use synthetic responses only.

## Fake adapter warning

`evals/adapters/fake.mjs` copies required labels from `cases.json` solely to
exercise schema, filtering, repetition, and scoring plumbing. Its synthetic
records and 100% pass rate are harness evidence only. They must never be cited
as Claude Code, Codex, model, host, or product behavior evidence.
