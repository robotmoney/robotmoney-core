# Repo conventions

## Git remotes

The repo was transferred to the `robotmoney` org. Both `origin` and `lucky-tensor` now point at `robotmoney/robotmoney-monorepo`. There is no separate upstream — this repo is not a fork. (The `lucky-tensor` remote name is retained for muscle memory; its URL is the `robotmoney` org.)

- `git push` → either remote works; prefer `lucky-tensor`
- `gh pr create` / `gh api` writes → use `--repo robotmoney/robotmoney-monorepo` (the old `lucky-tensor/...` path redirects for git but 307s on API writes)
- Default base branch is `dev` (not `main`)

## Filenames

**Every tracked path uses printable ASCII: bytes `0x20`–`0x7e`, and never `"` or `\`.**
No accents, no emoji, no tabs or newlines in a filename.

This is enforced, not just preferred — `scripts/check-tracked-path-charset.sh`
runs on every PR in the `tracked-path-charset` job of
`.github/workflows/suite-13-doc-checks.yml`, and a violating filename fails the
build. Run it locally with:

```bash
bash scripts/check-tracked-path-charset.sh
```

The reason is mechanical rather than aesthetic. Outside that byte set git
C-quotes the whole path in `ls-files`, `diff --name-only` and `status` output:

```
$ git ls-files
"contracts/caf\303\251.sol"
```

The leading `"` silently defeats every `^`-anchored path regex in the repo — CI
guards, coupling checks, migration-placement invariants. Issue #1252 reproduced
that against a real guard. The repo has always been ASCII-only in practice; the
check just makes the assumption explicit so no tool has to survive a filename we
would reject in review anyway.
