# Repo conventions

## Git remotes

- `origin` → `robotmoney/robotmoney-skills` (upstream — read only)
- `lucky-tensor` → `lucky-tensor/robotmoney-skills` (our fork — push here)

**Always push branches and open PRs against the `lucky-tensor` fork.** Never push to `origin` and never open PRs targeting `robotmoney/robotmoney-skills` unless explicitly asked.

- `git push` → use `lucky-tensor` as the remote
- `gh pr create` → use `--repo lucky-tensor/robotmoney-skills`
- Default base branch on the fork is `dev` (not `main`)
