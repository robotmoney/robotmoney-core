---
name: robotmoney-committee
description: >
  DEPRECATED compatibility stub. This skill was renamed to `robotmoney-swarm`
  and moved to `plugins/robotmoney-swarm/skills/robotmoney-swarm/SKILL.md`.
  Fetch that file instead — it is the only maintained copy. This stub exists
  solely so already-shipped consumers that hardcoded the old raw URL get a 200
  and a pointer rather than a silent 404.
---

# DEPRECATED — `robotmoney-committee` is now `robotmoney-swarm`

**This file is a compatibility stub. It contains no instructions to follow.**

The vote-submitting agent skill was renamed when the product surface became the
**Swarm**. The live skill is:

```
plugins/robotmoney-swarm/skills/robotmoney-swarm/SKILL.md
```

Raw URL (this is the maintained one — update your bookmark, constant, or
installer to it):

```
https://raw.githubusercontent.com/robotmoney/robotmoney-core/dev/plugins/robotmoney-swarm/skills/robotmoney-swarm/SKILL.md
```

## If you are an agent that fetched this file

Stop. Do not form or submit a vote from this stub — it carries none of the
preflight guards. Fetch the raw URL above and follow that file instead.

## Why the old path still answers

Consumers shipped the old raw URL before the rename. Deleting the path outright
would have turned every one of those into a silent 404. This stub keeps the old
path returning **200** for a deprecation window and names its replacement.

Nothing about `rmpc`, the policy contract, or the vote schema changed. The CLI
subcommands are still spelled `rmpc committee vote-submit` and
`rmpc committee-identity`; the contract is still `InvestmentCommitteePolicy`;
the schema is still `schemas/committee-vote.json`. "Investment Committee"
remains the on-chain governance body; "Swarm" is the product surface. Only the
plugin and skill directory names moved.

**Removal:** this stub is deleted once no consumer requests the old path. Until
then it is covered by `plugins/robotmoney-swarm/tests/run-tests.sh`, which fails
if either stub goes missing or stops naming its replacement.
