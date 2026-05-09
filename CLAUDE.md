# Agent preflight — read before developing

Before writing or planning any code:

1. **Check deprecated patterns:** read `docs/agent-warnings.md`. If your plan uses any deprecated item, replace it with the listed current approach first.
2. **Check feature regressions:** read `docs/agent-ensure-feature.md`. Run every `Verify` command whose `Touches` paths overlap your diff. A failure is a regression — fix it before opening a PR.
3. **After a successful feature merge:** add an entry to `docs/agent-ensure-feature.md` before closing the issue.

---

# Repo conventions

## Git remotes

- `origin` → `robotmoney/robotmoney-skills` (upstream — read only)
- `lucky-tensor` → `lucky-tensor/robotmoney-skills` (our fork — push here)

**Always push branches and open PRs against the `lucky-tensor` fork.** Never push to `origin` and never open PRs targeting `robotmoney/robotmoney-skills` unless explicitly asked.

- `git push` → use `lucky-tensor` as the remote
- `gh pr create` → use `--repo lucky-tensor/robotmoney-skills`
- Default base branch on the fork is `dev` (not `main`)
