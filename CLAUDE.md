# Repo conventions

## Git remotes

Both `origin` and `lucky-tensor` point at `lucky-tensor/robotmoney-monorepo`. There is no separate upstream — this repo is not a fork.

- `git push` → either remote works; prefer `lucky-tensor`
- `gh pr create` → use `--repo lucky-tensor/robotmoney-monorepo`
- Default base branch is `dev` (not `main`)
