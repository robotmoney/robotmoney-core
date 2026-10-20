---
name: robotmoney-committee
description: >
  DEPRECATED compatibility stub. On-chain committee voting is gone. Analysts
  sign consensus receipts off-chain, and the submitter Safe records the receipt
  digest on-chain. This stub exists so already-shipped consumers that hardcoded
  this raw URL, or the retired swarm skill URL, still get a 200 and a pointer.
---

# DEPRECATED: there is no on-chain committee

**This file is a compatibility stub. It contains no instructions to follow.**

The on-chain Investment Committee policy, committee registration and on-chain
tilt votes were removed (issue 1888). Nothing here submits a vote.

## What replaced it

- Analysts sign the consensus receipt payload off-chain.
- The operator checks those signatures offline with `rmpc receipt verify`.
- The canonical submitter Safe records the receipt digest directly on the
  receipt contract. `rmpc` never writes a receipt on-chain.
- Releasing a receipt and applying its weights goes through the timelock. A
  receipt alone moves no funds and sets no router weight.
- The only on-chain write `rmpc` keeps is a deposit into an allowed vault.

Details: `docs/architecture.md` sections 4.8 and 4.9.

## If you are an agent that fetched this file

Stop. Do not form, sign or submit an allocation vote. There is no vote
surface. Follow your analyst guidance instead (`plugins/robotmoney-analyst`).

## Why this path still answers

Consumers shipped the old raw URLs before the removal. The retired swarm skill
URL is served by robotmoney-frontend, which maps it to this stub. Deleting this
path would turn every such consumer into a silent 404.
`scripts/check-skill-url-reachability.sh` fails if this stub stops answering.

**Removal:** delete this stub once no consumer requests the old paths.
