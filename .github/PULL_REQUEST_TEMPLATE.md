## Summary

Describe the problem and the smallest behavior change in this pull request.

## Verification

List the checks you ran and their results.

- [ ] `npm test`
- [ ] `claude plugin validate .`
- [ ] The two plugin manifests and two marketplace entries keep all four version declarations aligned.
- [ ] Changed behavior has a regression case or a clear reason why one is unnecessary.
- [ ] User-facing changes are aligned across the relevant localized README pages.
- [ ] No hook, file write, retry, handover, compaction, clear, network access, or permission was added without documenting and testing its boundary.
- [ ] Logs, fixtures, and examples contain no secrets or private conversation text.

## User-visible change

Explain what users will notice. Write `None` for internal-only changes.

## Risks and rollback

Name the main risk and how the change can be reverted safely.
