# Scope and method — audit record

> **October 16 update:** [Adversarial validation](08-adversarial-validation.md) pins HEAD `aa471faf` and the unchanged QA contract tree, records commit authorship, executes six local PoCs and a baseline suite, and runs static analysis. The inventory below remains a source inventory, not proof of complete function/role/deployment coverage.

## Target and initial inventory

This source pass is pinned to `3c753ff5b72f828f082673d4c5983418a418c47e` on `review/contracts-security-20261015`. That commit contains only audit-plan changes relative to `qa/test-merge-v1` at `f828eabb`; the contract source is the QA branch's source at that commit. No deployed address, implementation bytecode, or chain state has been verified in this pass.

The production Solidity inventory contains 34 files after excluding `contracts/test`, `contracts/script`, and `contracts/interfaces`: seven core contracts or libraries (`ExclusionLedger`, `FeatureFlags`, `PortfolioRouter`, `ProposerFloorTimelock`, `RobotMoneyVault`, `RouterGovernance`, `VaultRegistry`), seven adapters/recorders, four gateway and committee contracts, twelve shared libraries or abstract controls, and four basket-vault family contracts. The scripts, interfaces, and linked libraries remain in scope where they determine deployed behavior. A file inventory is not yet a complete inventory of external entrypoints or deployed instances.

The current source materially differs from the October 15 security report's reviewed state: that report pins a dirty tree based on `9d9bb854` ([`docs/code-review/20261015-review-security-claude.md:3`](../20261015-review-security-claude.md)), while 30 production Solidity files changed between the report's landed `6e2b153d` commit and this branch's contract tree at `f828eabb`. The later changes include governed UUPS upgrades and reconciliation with `dev`. The earlier report's dispositions therefore require a new check against this target.

## Trust boundaries under review

- Depositor and share-owner calls into the vaults, router, and gateway; direct calls bypassing the expected client or gateway.
- Vault-controlled adapters and third-party venue contracts; adapter-reported value and actual USDC delivered.
- ADMIN and EMERGENCY powers, Safe and timelock scheduling, open execution, committee receipt application, and upgrade/freeze authority.
- Oracle pools and price recorder state feeding basket NAV and swap execution.
- Contract events and on-chain state consumed by clients, indexers, and release tooling only where they affect an on-chain safety decision.

## Evidence standard and remaining scope work

Chapter reports distinguish source inspection from reproduced behavior and live deployment evidence. Historical findings are rechecked against current code; a prior `fixed` label does not close a finding here. The next scope pass must enumerate every public/external entrypoint and actual deployed address, compare the QA deployment manifests to current source, map each `docs/architecture.md` §8 and `docs/technical/smart-contract-invariants.md` invariant to behavioral evidence, and test cross-contract attack sequences before a release verdict. Third-party protocol internals and live chain state have not been audited in this pass.

The seven review chapters are not complete against their outlines. No complete external-entrypoint inventory, role-to-deployment matrix, invariant traceability matrix, systematic static-analysis results, or complete historical-finding disposition table is included. Treat findings as initial source candidates and every unrecorded outline item as open; chapter presence alone is not evidence of coverage.
