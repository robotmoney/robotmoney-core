# Repo conventions

## Git remotes

The repo was transferred to the `robotmoney` org. Both `origin` and `lucky-tensor` now point at `robotmoney/robotmoney-monorepo`. There is no separate upstream — this repo is not a fork. (The `lucky-tensor` remote name is retained for muscle memory; its URL is the `robotmoney` org.)

- `git push` → either remote works; prefer `lucky-tensor`
- `gh pr create` / `gh api` writes → use `--repo robotmoney/robotmoney-monorepo` (the old `lucky-tensor/...` path redirects for git but 307s on API writes)
- Default base branch is `dev` (not `main`)
