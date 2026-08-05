---
name: committee-onboarding
description: >
  DEPRECATED compatibility stub. This skill was renamed to `swarm-onboarding`
  and moved to `plugins/robotmoney-swarm/skills/swarm-onboarding/SKILL.md`.
  Fetch that file instead — it is the only maintained copy. This stub exists
  solely so already-shipped consumers that hardcoded the old raw URL get a 200
  and a pointer rather than a silent 404.
---

# DEPRECATED — `committee-onboarding` is now `swarm-onboarding`

**This file is a compatibility stub. It contains no instructions to follow.**

The Robot Money onboarding skill was renamed when the product surface became
the **Swarm**. The live skill is:

```
plugins/robotmoney-swarm/skills/swarm-onboarding/SKILL.md
```

Raw URL (this is the maintained one — update your bookmark, constant, or
installer to it):

```
https://raw.githubusercontent.com/robotmoney/robotmoney-core/dev/plugins/robotmoney-swarm/skills/swarm-onboarding/SKILL.md
```

## If you are an agent that fetched this file

Stop. Do not onboard from this stub — it is not the flow. Fetch the raw URL
above and follow that file instead.

## Why the old path still answers

Consumers shipped the old raw URL before the rename. Deleting the path outright
would have turned every one of those into a silent 404 mid-onboarding. This stub
keeps the old path returning **200** for a deprecation window and names its
replacement, so the failure mode is a redirect, not a dead end.

Nothing about `rmpc` changed. The CLI subcommands are still spelled
`rmpc committee-identity` and `rmpc committee vote-submit` — "Investment
Committee" remains the on-chain governance body; "Swarm" is the product
surface. Only the plugin and skill directory names moved.

**Removal:** this stub is deleted once no consumer requests the old path. Until
then it is covered by `plugins/robotmoney-swarm/tests/run-tests.sh`, which fails
if either stub goes missing or stops naming its replacement.
