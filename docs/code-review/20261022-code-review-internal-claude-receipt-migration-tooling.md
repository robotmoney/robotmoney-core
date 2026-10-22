# Typed receipt migration for the governed upgrade row: the gaps (core issue 1910)

Date: 2026-10-22. The merged `ConsensusRecommendationReceipt` needs `migrateToSubmitterRoles(releaser)` in the same `upgradeToAndCall` as the implementation swap for the live v0.5.0 receipt proxy. `govern --row upgrade-proxy` takes `--migration receipt-submitter-roles` for it: the tool builds the data from the build ABI of `--upgrade-build` and the RouterGovernance address of the governance manifest, previews it decoded, records it in `proxy_upgrades`, and `evidence-check` reads the scheduled data back from the chain. The generic `--call-data` row stays Twin-only. The Twin upgrade-lifecycle harness runs the row against a populated v0.5.0-shaped receipt proxy.

## What the tooling proves

- The scheduled call is `upgradeToAndCall(impl, migrateToSubmitterRoles(governance))` and nothing else, built by the tool, never from operator hex.
- An unknown name, a proxy with no such migration, a build ABI without the function (or with another selector) and a missing or zero governance address are refused before anything is scheduled.
- The evidence entry records the name, the function, the selector, the releaser, the data and its hash. `evidence-check --governed-upgrades --rpc` fails an entry whose chain data differs from the typed migration, and an entry that hides the migration.
- The Twin harness asserts `RECEIPT_RELEASER_ROLE` on RouterGovernance only, `ADMIN_ROLE` on the timelock only, the receipts and retired slots unchanged, and a second `migrateToSubmitterRoles` reverting with `InvalidInitialization`.

## Findings

### 1. The migration registry has one entry

Every further proxy migration is a code change to `UPGRADE_MIGRATIONS` with its own review, tests and Twin proof. This is the point of the design (no free hex on 8453), so the cost is accepted. No other proxy has a pending migration.

### 2. The row does not read the live proxy's initialized version or roles before it schedules

The row checks the frozen flag, the layout, the implementation code and the migration inputs. It does not read the live receipt's initialized version or who holds `ADMIN_ROLE`. A proxy already at version 2 reverts at the timelock execute with `InvalidInitialization`. The whole `upgradeToAndCall` reverts together, so no half-migrated state exists. The signers learn it at the execute, after the delay. The pre-state of the live proxy is read from the chain by the operator before the schedule (runbook, "Typed migrations").

### 3. The Twin fixture is a source-level copy of the v0.5.0 receipt

The populated proxy in the Twin harness is built from `LegacyConsensusRecommendationReceipt` (same state, same write surface, same storage layout, ConsensusReceiptMigration.t.sol is the Solidity proof). It is not the byte-identical deployed v0.5.0 code. The live receipt implementation is compared with the DEPLOY_SHA build by verify, so a divergence of the deployed code from the fixture's source shows there.
