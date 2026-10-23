# Retire rmAGENT: the gaps that remain and the answers to the open unknowns

Date: 2026-10-22. Decision: owner, verbatim: "I think we need a /superfield-feature to deprecate the rmAgents vault, so that the router uses 3 vaults" and "rmAgent pre-0.6.0 will deprecate per its roles". The decision is [ADR-0017](../adr/ADR-0017-rmagent-retired-router-uses-three-vaults.md). Core issue 1912 implements it. This review lists what the change does not do, and the answers to the unknowns the issue left open.

## Answers to the open unknowns

- **How much sits in the live v0.5.0 rmAGENT.** Unknown from this repository. Deposits were capped at 5 USDC per deposit and 20 USDC TVL (`deployments/base-8453-rehearsal/deploy-3.env`). The balance must be read on chain (`totalAssets()`, `totalSupply()`) before the retire batch is scheduled. Runbook 4.14 step 1 makes that read the first step.
- **Whether a fixed vector length is hard-coded.** No. `PortfolioRouter._setDefaultWeights` requires the vector length to equal `registry.routerEligibleCount()`. There is no constant. `PortfolioRouter`, `VaultRegistry` and the vault Solidity need no change.
- **How the live vault is retired.** One timelock batch: `registry.migrateEligibility(rmAGENT, false, three legs)` then `registry.retire(rmAGENT)`. The order is forced by `RetireWhileRouterEligible` and by the router length check. `govern --row retire-vault` builds, previews, schedules, executes and reads it back. The Twin proves it on a four-vault populated deployment. Nothing schedules it on Base.
- **Storage layout and the gateway allow-list.** Unchanged. No Solidity storage changed, and `scripts/ci/check-core-storage-layout.sh` still pins the `AgentTokenVault` layout because the live proxy runs it. No gateway allow-list names rmAGENT.
- **Issue 1905 (multi-hop swaps).** Not a dependency. Its candidates (BNKR, RM, WOON, ZYFAI, JUNO) are rmAGENT-only. rmPROTO lists wETH and cbBTC on Uniswap V3 pools. 1905 has no consumer today, and this change does not edit it.
- **Presentation of a retired vault.** Proposed in ADR-0017 and implemented as: dapp withdraw-only card, explorer returns status Retired, rmpc and gateway name rmPROTO or rmRWA as destinations. The owner has not confirmed the wording.

## Gaps that remain

### 1. The batch is not run on Base

Scheduling it on the live deployment is an owner-gated release step (runbook 4.14). Until it runs, the live router still holds four legs.

### 2. Holder funds are not moved

ADR-0009 forbids assisted migration. A holder exits with `redeem` or `redeemInKind`.

### 3. The recorder keeper is still needed for the retired vault

`redeem` reads the V4 price recorder (TWAP and the 4 hour sell anchor). If holders remain, `scripts/ops/recorder-keeper.sh` must keep running, or they use `redeemInKind`. A v0.6.0 deployment has no recorder.

### 4. The `agent_tokens` bucket stays in the receipt schema

It is the Investment Committee's cross-repository contract (`tests/fixtures/consensus-receipt.bucket-vault-map.json`, PRD section 11). It maps to no vault. `apply-receipt` accepts it at 0 bps and refuses any weight. The IC repository should stop weighting the bucket. That is a cross-repository item the owner decides.

### 5. Parked code remains

`DeployAgentTokenVault.s.sol`, `DeployUniswapV4PriceRecorder.s.sol`, the V4 adapter and `config/agent-token-shortlist.json` are not deleted. No stage reads them. Deleting them is a later decision.

### 6. The v0.5.0 line is unchanged

Its tooling, frozen counts and the QA release records stay at the v0.5.0 tag. `deploy-3.env` is the v0.5.0 record and still carries `VAULT_AGENT_*`.

### 7. Frozen counts for the next release

A v0.6.0 rc loses the `agent` and `recorder` counts. They are measured and frozen at the rc, as for every release (section 3 of the release runbooks). This change freezes nothing.

### 8. Docs audited for the three-vault target

`docs/prd.md`, `docs/architecture.md`, `docs/technical/smart-contracts.md`, `docs/technical/portfolio-router-decisions.md` (no rmAGENT text), the invariants registry (`docs/technical/smart-contract-invariants.md`), the release runbook and `docs/runbooks/contract-qa/` describe the three-vault target. The released v0.4.0 and v0.5.0 records are untouched. Older review and QA notes still name rmAGENT as history.

## Guards, bounds and floors

No guard, bound or executed-test floor is lowered. `VAULT_AGENT_MIN_POOL_LIQUIDITY` stays 1e15. No test is skipped. The new tests run in CI with non-zero executed floors (`RetireVaultBatch.t.sol` forge floor, the publish-contracts `retire` suite, the Twin upgrade-lifecycle job).
