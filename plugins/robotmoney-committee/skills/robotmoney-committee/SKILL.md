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

> **Owner decisions 2026-10-19 and 2026-10-20 (noted 2026-10-20).** The tables below
> document today's binary. These parts of it are deprecated: `committee vote-submit`, `committee check-agent`, `receipt submit` and the Investment Committee policy, in the `robotmoney-swarm` skill this stub points to.
> The only on-chain write `rmpc` keeps is `rmpc deposit` into an allowed vault.
> Consensus receipts go on-chain only through the submitter Safe (the
> publish-contracts `record-receipt` row), never through `rmpc`. Details: `docs/code-review/20261019-code-review-internal-claude-opus-5-5-rmpc-scope.md` and `docs/code-review/20261019-code-review-internal-claude-opus-5-5-ic-policy-removal.md`.

**This file is a compatibility stub. It contains no instructions to follow.**

The allocation-signalling agent skill was renamed when the product surface became the
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

Stop. Do not form or submit an allocation signal from this stub — it carries none of the
preflight guards. Fetch the raw URL above and follow that file instead.

## Why the old path still answers

Consumers shipped the old raw URL before the rename. Deleting the path outright
would have turned every one of those into a silent 404. This stub keeps the old
path returning **200** for a deprecation window and names its replacement.

Nothing about `rmpc`, the policy contract, or the tilt schema changed. The CLI
subcommands are still spelled `rmpc committee vote-submit` and
`rmpc committee-identity`; the contract is still `InvestmentCommitteePolicy`;
the schema is still `schemas/committee-vote.json`. "Investment Committee"
remains the on-chain policy contract (it signals allocation and governs nothing); "Swarm" is the product surface. Only the
plugin and skill directory names moved.

**Removal:** this stub is deleted once no consumer requests the old path. Until
then it is covered by `plugins/robotmoney-swarm/tests/run-tests.sh`, which fails
if either stub goes missing or stops naming its replacement.

`committee vote-submit` submits a signed tilt. It grants no authority over router weights.
