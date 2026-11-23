# Robot Money `release-0.9.0` — Comprehensive Security and Economic Safety Review

**Base:** `dev` (`6c25fd8ce291a88ed088f71e0e015296a561ea24`), merged from `release-0.9.0` (`86747f24534a39cf19a75d4370d3f91466dcc24f`, tag `contracts-0.9.0`) via PR `#2019` (`contracts/` tree is byte-identical across both commits)
**Worktree:** `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/adhoc-20261122-233507-safety-review-090` (`adhoc/20261122-233507-safety-review-090`)
**Timestamp:** `2026-11-21T21:47:00Z`
**Reviewer:** Antigravity (`agy`)
**Deliverable Scope:** Complete 7-document analysis-only review covering governance/access control, economic manipulation/asset safety, reentrancy/accounting, and product/upgrade alignment. No Solidity source files, tests, or canonical documents were modified.

---

## Navigation

| Chapter | Scope | Link |
|---|---|---|
| **00 — Executive Summary** | Headline verdict, direct answers to the 5 core risk questions, master findings register (`AGY-01`–`AGY-15`), root-cause synthesis, and prioritized remediation roadmap | [00-executive-summary.md](./00-executive-summary.md) |
| **01 — Governance and Access Control** | Role & proxy topology diagram, role-floor matrix, deep-dive analyses and concrete Solidity patches for `AGY-02`, `AGY-04`, `AGY-08`, `AGY-09`, and verification of `ConsensusRecommendationReceipt`, `RebalanceGovernance`, and `GovernedUUPS` | [01-governance-and-access-control.md](./01-governance-and-access-control.md) |
| **02 — Economic Manipulation, Slippage Guards, and Asset Safety** | Uncapped single-asset unwinds, feed liveness deadlocks, delist convergence math, net-flow ramp/TWAP extraction, `INV-2` custody / slot reuse, and Uniswap V3 / lending adapter checks (`AGY-01`, `AGY-03`, `AGY-05`, `AGY-06`, `AGY-07`, `AGY-13`) | [02-economic-manipulation-and-asset-safety.md](./02-economic-manipulation-and-asset-safety.md) |
| **03 — Reentrancy, Flow State Machines, and Accounting Verification** | Settlement freeze hold-mark (`AGY-10`), post-upgrade delisting Check 6 (`AGY-11`), unpruned `activeDepBuckets` (`AGY-12`), and exhaustive reentrancy, CEI, approval hygiene, ray-index conservation, and Check 10 verification (`AGY-14`) | [03-reentrancy-flows-and-accounting.md](./03-reentrancy-flows-and-accounting.md) |
| **04 — Product Alignment, In-Place Upgrade Posture, and Audit/Gate Readiness** | Product-vs-contract alignment (`AGY-15`), ERC-7201 storage layout baselines, `migrateV090` one-time migrations, upgrade runbook (`v0.9.0-onevault-upgrade.yaml`), `docs/audits.md` ledger posture, and Gates G8/G9 | [04-product-alignment-and-upgrade-posture.md](./04-product-alignment-and-upgrade-posture.md) |
| **05 — Meta-Review and Missed Findings** | Independent adversarial meta-review of Chapters 00–04: patch correctness audit, factual/citation corrections, cross-chapter contradictions, and 9 verified missed findings (`MISSED-01`–`MISSED-09`) | [05-meta-review-and-missed-findings.md](./05-meta-review-and-missed-findings.md) |
| **06 — Remediation Status** | What this branch fixed for each finding, with the proof test, the findings left open and why, and the behaviour changes operators must know | [06-remediation-status.md](./06-remediation-status.md) |
| **Verification Notes** | Independent GPT static verification notes (evaluated and incorporated into Chapters 00–04) | [gpt-review-notes.md](./gpt-review-notes.md) |

---

## Severity Summary

| Severity | Count | Findings |
|---|---:|---|
| **Critical** | 0 | — |
| **High** | 3 | `AGY-01`, `AGY-02`, `AGY-03` |
| **Medium** | 5 | `AGY-04`, `AGY-05`, `AGY-06`, `AGY-07`, `AGY-08` |
| **Low** | 5 | `AGY-09`, `AGY-10`, `AGY-11`, `AGY-12`, `AGY-13` |
| **Info** | 2 | `AGY-14`, `AGY-15` |
| **Total** | **15** | `AGY-01` through `AGY-15` |

---

## Audit Methodology & Scope

The review proceeded product-first and source-verified every claim directly against commit `86747f24534a39cf19a75d4370d3f91466dcc24f` (`contracts-0.9.0`), verified byte-identical under `contracts/` on `dev` commit `6c25fd8ce291a88ed088f71e0e015296a561ea24` (PR `#2019`):

1. **Product, Invariants, and Operational Canon First:** Reviewed `docs/prd.md`, `docs/technical/one-vault-prd-amendments.md`, `docs/technical/one-vault-rebalancer-proposal.md`, `docs/technical/one-vault-timed-flows-eng-plan.md`, `docs/technical/smart-contract-invariants.md`, `docs/technical/security-model.md`, `docs/technical/v0.9.0-in-place-upgrade-audit.md`, `docs/adr/ADR-0019-fund-swap-adapters-governed-uups-proxies.md`, `docs/runbooks/contract-qa/releases/v0.9.0-onevault-upgrade.yaml`, `docs/code-reviews/20261117-163636-testmachine/`, and `docs/audits.md`.
2. **Full 69-File Contract & Interface Inventory:** Audited the complete production and interface Solidity tree under `contracts/` (excluding `contracts/test/` and `contracts/script/`), totaling **69 `.sol` files** (`12` root contracts/type files, `11` adapters, `28` libraries, `18` interfaces), cross-checked against the deployment/handover scripts in `contracts/script/` (`DeployFundTimelock.s.sol`, `CoreTimelockHandover.sol`, `FundTimelockPolicy.sol`, `UpgradeAuthority.sol`, `DeployKeeperAccount.s.sol`, `DeployFund.s.sol`, `DeployFlowQueue.s.sol`, `DeployRebalancer.s.sol`, `DeployRebalanceGovernance.s.sol`, `DeployFundReceipt.s.sol`, `DeployFundWiring.s.sol`, `FundSystemBase.sol`).
3. **Adversarial & Invariant Trace:** Manually traced role administration (`_grantRole`/`_revokeRole`), ERC-1967/UUPS proxy upgradeability and freeze paths, single-asset/full-fund emergency unwinds, delisting sales, `FlowMatchLib` cycle-factor and prefix-sum accounting, Check 10 checked 256-bit cross-multiplication conservation, reentrancy locks, and `v0.8.0 -> v0.9.0` storage migrations.

### In-Scope Contract Surface (69 Files)

#### A. The 33 `v0.9.0` One-Vault Contracts & Libraries (`Not separately audited` in `docs/audits.md:129-161`)

| Category | Files (`33`) |
|---|---|
| **Core, Governance & Math (`9`)** | `contracts/RobotMoneyFund.sol`, `contracts/RebalanceGovernance.sol`, `contracts/Rebalancer.sol`, `contracts/FlowQueue.sol`, `contracts/FlowTypes.sol`, `contracts/FundTypes.sol`, `contracts/FundExclusionLedger.sol`, `contracts/KeeperAccount.sol`, `contracts/PlanMath.sol` |
| **Adapters (`6`)** | `contracts/adapters/AaveV3RateAdapter.sol`, `contracts/adapters/CompoundV3RateAdapter.sol`, `contracts/adapters/MorphoRateAdapter.sol`, `contracts/adapters/AerodromeExactOutSwapAdapter.sol`, `contracts/adapters/UniswapV3ExactOutSwapAdapter.sol`, `contracts/adapters/UniswapV3ExactOutSwapAdapterUpgradeable.sol` |
| **Linked & Inlined Libraries (`18`)** | `contracts/lib/FeedLib.sol`, `contracts/lib/FlowCheckLib.sol`, `contracts/lib/FlowClaimLib.sol`, `contracts/lib/FlowMatchLib.sol`, `contracts/lib/FlowMigrateLib.sol`, `contracts/lib/FlowSettleLib.sol`, `contracts/lib/FlowStorage.sol`, `contracts/lib/FundAdminLib.sol`, `contracts/lib/FundDelistLib.sol`, `contracts/lib/FundAdapterGuard.sol`, `contracts/lib/FundFlowsLib.sol`, `contracts/lib/FundMigrateLib.sol`, `contracts/lib/FundPositionLib.sol`, `contracts/lib/FundStepLib.sol`, `contracts/lib/FundStorage.sol`, `contracts/lib/FundValuationLib.sol`, `contracts/lib/StepFeedLib.sol`, `contracts/lib/TwapSlicesLib.sol` |

#### B. Shared Governance, Core, Adapter, Library & Interface Surface (`36` Files)

| Category | Files (`36`) |
|---|---|
| **Governance & Legacy Core (`3`)** | `contracts/ProposerFloorTimelock.sol` *(not separately audited)*, `contracts/ConsensusRecommendationReceipt.sol` *(not separately audited)*, `contracts/ExclusionLedger.sol` *(not separately audited)* |
| **Base Adapters (`5`)** | `contracts/adapters/AaveV3Adapter.sol`, `contracts/adapters/AerodromeSwapAdapter.sol`, `contracts/adapters/CompoundV3Adapter.sol`, `contracts/adapters/MorphoAdapter.sol`, `contracts/adapters/UniswapV3SwapAdapter.sol` *(not separately audited)* |
| **Shared Libraries (`10`)** | `contracts/lib/AdminFloorAccessControl.sol`, `contracts/lib/AdminFloorAccessControlCounter.sol`, `contracts/lib/BasketAssetConfigGuard.sol`, `contracts/lib/BasketSwaps.sol`, `contracts/lib/BpsMath.sol`, `contracts/lib/ForeignTokenQuarantine.sol`, `contracts/lib/GovernedUUPS.sol` *(not separately audited)*, `contracts/lib/RobotMoneyVaultOps.sol`, `contracts/lib/TickMath.sol`, `contracts/lib/TwapTickMath.sol` |
| **Interfaces (`18`)** | `contracts/interfaces/IAavePool.sol`, `contracts/interfaces/IAerodromeCLFactory.sol`, `contracts/interfaces/IAerodromePool.sol`, `contracts/interfaces/IAerodromeSlipstreamRouter.sol`, `contracts/interfaces/IBasketSwapAdapter.sol`, `contracts/interfaces/IComet.sol`, `contracts/interfaces/IConsensusRecommendationReceipt.sol`, `contracts/interfaces/IExposureCappedAdapter.sol`, `contracts/interfaces/IFlowAdapters.sol`, `contracts/interfaces/IFlowQueue.sol`, `contracts/interfaces/IObservablePool.sol`, `contracts/interfaces/IRebalanceGovernance.sol`, `contracts/interfaces/IRebalancer.sol`, `contracts/interfaces/IRobotMoneyFund.sol`, `contracts/interfaces/IStrategyAdapter.sol`, `contracts/interfaces/ISwapRouter.sol`, `contracts/interfaces/IUniswapV3Pool.sol`, `contracts/interfaces/IVenueHealthAdapter.sol` |
