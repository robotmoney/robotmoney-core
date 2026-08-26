# Security Code Review

**Reviewer:** Kimi (opencode internal agent)
**Date:** 2026-07-28
**Commit:** 43694310dff645a7bdf473de82dd340c41a86e34
**Branch:** dev (worktree `adhoc/20260728-201344`)
**Repository:** robotmoney/robotmoney-core (Base mainnet USDC treasury protocol)
**Scope:** contracts/, services/, clients/, config/, .github/workflows, plugins/, docs/ (docs/prd.md §12, docs/architecture.md §8, ADRs, docs/technical/security-model.md, docs/technical/smart-contract-invariants.md, prior docs/code-review/)
**Exclusions:** External dependencies (OpenZeppelin, Forge stubs), upstream venue contracts (Aave, Compound, Morpho), production JSON-RPC provider choice, Circle USDC freeze risk.

---

## Headline Verdict

The codebase demonstrates a strong security architecture with well-enforced custody invariants (INV-1..4), thorough role separation with graduated authority, and a disciplined single-production-codebase principle. **Two findings block mainnet deployment of specific vault components; seven findings violate documented invariants or create exploitable gaps at the authority and oracle boundaries.** The audit ledger (`docs/audits.md`) has not been updated to reflect that 8 critical/high findings from recent external scans are already fixed, which misleads future readers. The unified Vault v2 (ADR-0010) faithfully addresses the known v1 gaps (pause-only-deposits, last-admin-floor) but introduces new adapter-boundary issues.

---

## Severity Summary

| Severity | Count | Key areas |
|----------|-------|-----------|
| Critical | 0 | — |
| High | 7 | Withdrawals blocked by pause (v1), ISwapRouter/SwapRouter02 V3 ABI mismatch (deploy blocker), ORA-7 same-source TWAP floor, RWA stale-oracle blocks redemptions, missing last-admin-floor (v1), RouterGovernance loses `setWeights` authority after deploy, audits.md stale for 8 fixed Critical/High findings |
| Medium | 12 | Timelock dual-ADMIN router vote-bypass, missing `custodiedTokens()` INV-2 risk, emergency floor unimpl, V4 adapter arch incompatibility, V4 fork test mock-only, empty-code vault skip, navDeviationGuard disabled, no admin single-asset sell, CI vm.skip() in formal verification, no BasketVault TWAP fork test, slither `fail_on: high` only, MorphoAdapter theoretical NAV overstated |
| Low | 13 | CompoundV3 allowance pattern, no duplicate-adapter guard, removeAdapter lying-adapter, exit-fee rounding, no MAX governance params, deploy-script EOA admin, TwapTickMath boundary test, agent-token-shortlist placeholders, watchdog pause-tx receipt, deferred cross-endpoint RPC consensus, dapp keygen fail-closed, revealAuthorization admin-race, BasketVault no caller-specified min-out |
| Informational | 6 | sweepForeignToken docs, harvest gap, maxRedeem 0, quarantine burn default, RmToken devnet-only, watchdog key config example |

---

## Methodology

1. **Scope pinning** — repository, branch, commit, date recorded; worktree-isolated analysis.
2. **Canonical-document resolution** — PRD (§12 INV-1..4), architecture (§4.5/§4.7/§8), ADRs (0010, 0009, 0005, 0006, 0004, 0003), security-model.md, smart-contract-invariants.md, governance-decisions.md.
3. **Prior-review reconciliation** — all 34+ prior snapshots under `docs/code-review/` reviewed; open findings from external (PekShield 20260619, TestMachine Azimuth 20260623) and internal scans verified at pinned commit.
4. **Concurrent adversarial analysis** — 7 domain workers examined: (A) v1 vault custody, (B) unified Vault v2, (C) gateway+watchdog, (D) router+governance+registry, (E) basket vaults+oracles, (F) off-chain surfaces, (G) prior-reviews+tests.
5. **Adversarial refutation** — each candidate finding tested against guards, state transitions, tests, and deployment constraints before inclusion. Findings that survived are reported; refuted hypotheses appear under Clean Areas.
6. **Test-honesty audit** — every security invariant mapped to behavior-executing tests; silent skips and CI gaps identified.

---

## Findings

### HIGH

#### SEC-H-001 — RobotMoneyVault `pause()` blocks withdrawals, violating INV-3 "withdrawals never blocked" (v1 only)

- **Classification:** SECURITY_INVARIANT_VIOLATION
- **Confidence:** High
- **Requirement:** `docs/prd.md §12` INV-3; `docs/technical/smart-contract-invariants.md` LIFE-3; `docs/architecture.md §4.7` authority table
- **Evidence:** `contracts/RobotMoneyVault.sol:890-893` — `pause()` sets `withdrawalsPaused = true`. The unified `Vault.sol` (ADR-0010) fixes this by making pause deposits-only. The test `test_fullPause_blocksDepositsAndWithdrawals` confirms the behavior. PekShield F-06 and multiple code reviews identify this; the fix exists in Vault.sol but is **not backported to the deployed v1 RobotMoneyVault**.
- **Exploitability:** A compromised EMERGENCY_ROLE hot key can block all user withdrawals. ADMIN_ROLE (timelocked) is needed to unpause.
- **Prerequisites:** EMERGENCY_ROLE key compromised or rogue holder.
- **Impact:** Denial of service — all redemptions blocked until ADMIN_ROLE acts (timelock delay up to 48h).
- **Recommendation:** Backport the fix: make `pause()` deposits-only in RobotMoneyVault; make `withdrawalsPaused` ADMIN_ROLE-only.
- **Missing test:** No test asserts that EMERGENCY_ROLE cannot block withdrawals. `test_emergencyWithdraw_userCanRedeem_newDepositBlocked` only covers the emergencyWithdraw path, not `pause()`.
- **Owner:** code
- **Related findings:** PekShield F-06, SEC-H-007 (same root cause on pause authority excess)

#### SEC-H-002 — Default V3 swap path (ISwapRouter) ABI-incompatible with real SwapRouter02 on Base

- **Classification:** SECURITY_DEPLOY_BLOCKER
- **Confidence:** High
- **Requirement:** `docs/prd.md §11.2` (swap routing); `docs/architecture.md §4.3` (SwapRouter02 integration)
- **Evidence:** `contracts/interfaces/ISwapRouter.sol:8-16` defines `ExactInputSingleParams` with **7 fields (no `deadline`)**. The real SwapRouter02 at Base mainnet (`0x2626664c2603336E57B271c5C0b26F421741e481`) uses an **8-field struct including `uint256 deadline`**. The vault's `_executeSwap` (`BasketVault.sol:1666-1679`) calls `SWAP_ROUTER.exactInputSingle(params)` with the truncated struct. When the ABI-encoded 7-field calldata reaches the 8-field decoder, `amountIn` is read from a shifted offset, making every default-V3-path call either revert (at decode) or pass corrupted amounts to the pool. This affects all ProtocolAssetVault assets (wETH, cbBTC, wSOL) and the BNKR leg of AgentTokenVault.
- **Exploitability:** Every default-V3-path call mainnet would fail. Basket vaults are router-INELIGIBLE at HEAD, but direct deposits would also fail — deploying ProtocolAssetVault on mainnet is blocked.
- **Prerequisites:** Attempting to execute any swap through the default V3 path on mainnet Base.
- **Impact:** Default V3 swap path is dead-on-arrival for mainnet. Asset-position-adapters using `UniswapV3SwapAdapter` (the new V3 AssetPositionAdapter) are unaffected — only the built-in `SWAP_ROUTER` path via `adapter == address(0)` in BasketVault is broken.
- **Refutation note:** If Base's SwapRouter02 has been verified to use the 7-field variant, this is a false positive. The canonical Uniswap `swap-router-contracts` `SwapRouter02` uses 8 fields. No fork test exercises the default path against the real router to confirm either way.
- **Recommendation:** (a) Add `deadline` to `ISwapRouter.ExactInputSingleParams` and pass `block.timestamp`. (b) Add a fork test that routes a swap through the real SwapRouter02 address. (c) Pin the verified router ABI in `config/dex-pools.json`.
- **Missing test:** No fork test exercises `BasketVault._executeSwap` with `adapter == address(0)` against the real Base SwapRouter02.
- **Owner:** code
- **Related findings:** SEC-M-010 (no BasketVault TWAP fork test)

#### SEC-H-003 — ORA-7: slippage floor derived from same TWAP that prices NAV (no independent backstop)

- **Classification:** SECURITY_ORACLE_MANIPULATION
- **Confidence:** High
- **Requirement:** `docs/prd.md §11.2` (manipulation-resistant on-chain price); `docs/technical/smart-contract-invariants.md` ORA-7
- **Evidence:** `BasketVault._slippageFloor` (line 1174) calls `_twapUsdcValue` — the exact same TWAP that `totalAssets()` uses for NAV. `_executeSwap` passes this TWAP-derived value as `amountOutMinimum`. An attacker who manipulates the TWAP within the observation window moves both the NAV mark AND the protective floor in lockstep — the floor offers zero independent protection. Documented as RED/ORA-7 in `contracts/test/fv/TwapManipulation.t.sol:11-16`. The scout stub test at line 91 has **no live vault assertion** — it is a scaffolding placeholder.
- **Exploitability:** Requires sustaining a skewed price across ≥600s (Base: ≥300 consecutive blocks). Feasible for thin pools (agent tokens, RWA) with large capital. Flash loans cannot move TWAP within a single block (cardinality > 1). MIN_TWAP_WINDOW = 600s is a partial mitigation; the navDeviationGuard is disabled by default (SEC-M-007).
- **Prerequisites:** A pool where attacker can dominate in-range liquidity across ≥600s.
- **Impact:** Depositors can receive shares at inflated NAV or redeem at depressed NAV while the floor tracks the manipulated price, extracting value from other holders. Basket vaults are router-INELIGIBLE at HEAD, limiting exposure to direct depositors.
- **Recommendation:** Implement an independent floor (e.g., pool fee tier as minimum absolute floor, or secondary Chronicle oracle). Tracked as #966.
- **Missing test:** `TwapManipulation.t.sol` is a stub without a live vault assertion.
- **Owner:** code (#966)
- **Related findings:** SEC-M-007 (navDeviationGuard disabled), SEC-M-010 (no BasketVault TWAP fork test), SEC-H-004 (Chronicle stale oracle in RWA)

#### SEC-H-004 — RwaVault redemptions blocked when Chronicle feed is stale (INV-3 contradiction)

- **Classification:** SECURITY_INVARIANT_VIOLATION
- **Confidence:** High
- **Requirement:** `docs/prd.md §12` INV-3 ("withdrawals are never blocked"); `docs/architecture.md §4.1` ("withdrawals are never revoked"); `docs/adr/ADR-0006 §2` ("A stale oracle halts deposits AND withdrawals")
- **Evidence:** `RwaVault.totalAssets()` (line 209-214) calls `_checkOracleFreshness()` which reverts `StalePriceFeed` when `block.timestamp > updatedAt + heartbeat`. `redeem()` → `_withdraw()` → `_sellProportional()` → `_slippageFloor()` → `_twapUsdcValue()` → `ChronicleOracleAdapter.twapPrice()`. The vault freshness check gates the entire `totalAssets()` call, which OZ `redeem()` uses for share conversion. The `_holdsPricedRwa()` short-circuit (line 210-211) only exempts the idle-USDC state (after full emergency unwind). While any deSPXA balance exists, a stale feed bricks ALL exits. ADR-0006 §2 explicitly documents this — directly contradicting PRD INV-3's "withdrawals are never blocked." The emergency stale-override path (set by ADMIN, executed by EMERGENCY) requires two non-colluding parties.
- **Exploitability:** If Chronicle attestor network halts for >24h while vault holds deSPXA, all holder redemptions are blocked until feed refresh or stale-override is armed and executed.
- **Prerequisites:** Chronicle feed stale for >heartbeat period (default 24h) while vault holds any deSPXA.
- **Impact:** Temporary illiquidity — all rmRWA redemptions blocked. RWA is documented as Router-eligible per `docs/prd.md §11.4`, compounding impact (Portfolio Router depositors also blocked).
- **Recommendation:** (a) Resolve the documentation conflict in PRD §12 INV-3 to match ADR-0006. (b) Consider a partial-redemption path that returns idle USDC without an oracle read. (c) Document the stale-override two-step recovery in the runbook.
- **Missing test:** No test for partial redemption from mixed idle-USDC + deSPXA state when feed is stale.
- **Owner:** architecture/prd/operations
- **Related findings:** SEC-H-003 (ORA-7), SEC-M-009 (RWA stale-feed SUP-1 test is vm.skip)

#### SEC-H-005 — RobotMoneyVault lacks last-admin-floor protection (v1 only)

- **Classification:** SECURITY_PRIVILEGE_ESCALATION
- **Confidence:** High
- **Requirement:** `docs/technical/smart-contract-invariants.md` ACL-3 ("ADMIN_ROLE membership on any fund-holding contract never reaches zero"); `AdminFloorAccessControl` pattern (used by PortfolioRouter)
- **Evidence:** `RobotMoneyVault.sol:26` imports `AccessControl` directly. `PortfolioRouter.sol:41` correctly uses `AdminFloorAccessControl`. `Vault.sol` (v2) also enforces a last-admin floor. The sole ADMIN_ROLE holder on `RobotMoneyVault` can call `renounceRole(ADMIN_ROLE, self)`, permanently bricking all ADMIN-gated setters (`setTvlCap`, `setFeeRecipient`, `addAdapter`, `unpause`, `restoreVault`).
- **Exploitability:** ADMIN_ROLE membership reaches exactly 1 holder, who acts to drop themselves.
- **Prerequisites:** ADMIN_ROLE held by a single address that renounces it.
- **Impact:** Permanent denial of governance — all admin functions bricked. Withdrawals remain open but no admin action (adapter addition, cap changes, fee changes, unpause) can ever execute.
- **Recommendation:** Backport `AdminFloorAccessControl` to `RobotMoneyVault` by replacing `AccessControl` with `AccessControlEnumerable` and overriding `_revokeRole`.
- **Missing test:** No test asserts that the last ADMIN_ROLE on RobotMoneyVault cannot be revoked.
- **Owner:** code
- **Related findings:** ACL-3

#### SEC-H-006 — DeployTimelock never grants ADMIN_ROLE to RouterGovernance on PortfolioRouter — `setWeights` always reverts after handover

- **Classification:** SECURITY_OPERATIONS_FAILURE
- **Confidence:** High
- **Requirement:** `docs/architecture.md §3.6` governance-decisions.md ("RouterGovernance is the only permitted caller of setWeights"); §4.5 (ADMIN_ROLE held by TimelockController)
- **Evidence:** `DeployTimelock._deployAndWire()` (`DeployTimelock.s.sol:311-321`) grants ADMIN_ROLE on PortfolioRouter to the TimelockController and revokes it from `msg.sender` (deployer). It **never grants ADMIN_ROLE to RouterGovernance**. After handover, `RouterGovernance.execute()` calls `router.setWeights()` which reverts with `AccessControlUnauthorizedAccount`. RouterGovernance proposals pass through voting → queued → execution delay → then permanently revert on `execute()`.
- **Exploitability:** Deterministic on any deployment using DeployTimelock as the step without an intermediate ADMIN_ROLE grant to RouterGovernance on the router.
- **Prerequisites:** DeployTimelock runs as the last step on a freshly deployed PortfolioRouter with no prior ADMIN grant to RouterGovernance.
- **Impact:** All governance weight updates are bricked. The only weight-update path remaining is direct TimelockController calls (bypassing all governance voting).
- **Recommendation:** Add `router.grantRole(ADMIN_ROLE, address(governance))` inside `_deployAndWire()` before revoking the deployer.
- **Missing test:** `DeployTimelockTest` does not assert `router.hasRole(ADMIN_ROLE, address(governance))` after handover.
- **Owner:** code
- **Related findings:** SEC-M-001 (timelock dual ADMIN bypass on router)

#### SEC-H-007 — Audits.md ledger lists 8 Critical/High findings as "accepted-with-rationale" when they are code-fixed at HEAD

- **Classification:** SECURITY_PROCESS_GAP
- **Confidence:** High
- **Requirement:** `docs/audits.md` §9 ("revisited before a major change"); repo convention for immutable review snapshots
- **Evidence:** The ledger (`docs/audits.md:386-402`) records AZ-GW-1 (Critical), AZ-BSK-1 (High), AZ-RTR-2 (High), AZ-BSK-2 (Med→High), AZ-BSK-3 (Med), AZ-BSK-5 (Med), AZ-REG-1 (Med), FS-RTR-1 (Med→High) as `accepted-with-rationale` / `—` (no remediation PR). **All 8 are code-fixed at HEAD** — remediating PRs #1084, #1093, #1098, #1099, #1092 landed after the ledger's snapshot and were never back-linked. A future reader of `docs/audits.md` will believe Critical/High findings are open when they are fixed.
- **Impact:** Misleading audit trail. Security reviewers waste time re-verifying already-fixed items. The `—` in "Remediated by (PR)" is incorrect.
- **Recommendation:** Update `docs/audits.md` for AZ-0623 and FS-0619 findings whose remediations landed: change disposition to `fixed`, populate "Remediated by (PR)" with the PR number.
- **Owner:** operations/security
- **Related findings:** AZ-GW-1, AZ-BSK-1, AZ-RTR-2, AZ-BSK-2, AZ-BSK-3, AZ-BSK-5, AZ-REG-1, FS-RTR-1, FS-VLT-19

### MEDIUM

#### SEC-M-001 — Timelock holds ADMIN_ROLE on PortfolioRouter, enabling vote-bypass weight changes (undocumented escape hatch)

- **Classification:** SECURITY_PRIVILEGE_ESCALATION
- **Confidence:** High
- **Requirement:** `docs/architecture.md §2.3` (Governance controls router target weights); governance-decisions.md §3.6 ("RouterGovernance is the only permitted caller of setWeights in production")
- **Evidence:** `DeployTimelock._deployAndWire()` grants ADMIN_ROLE on PortfolioRouter to the TimelockController. The Safe (PROPOSER_ROLE + EXECUTOR_ROLE) can schedule a timelock operation calling `router.setWeights(...)` with zero vote, bypassing RouterGovernance's vote period and execution delay. This is a conscious escalation path contemplated in governance-decisions.md §6.5, but the invariant "RouterGovernance is sole setWeights caller" is not enforced architecturally.
- **Exploitability:** Requires 2-of-N Safe approval + timelock delay.
- **Prerequisites:** Multisig signs a timelock operation targeting `router.setWeights`.
- **Impact:** RouterGovernance's vote period and execution delay can be bypassed.
- **Recommendation:** Either (a) document as a deliberate governance-escalation path in architecture.md, or (b) revoke ADMIN_ROLE from the timelock on the router and grant it solely to RouterGovernance.
- **Missing test:** No test asserts `router.getRoleMemberCount(ADMIN_ROLE) == 1` with RouterGovernance as sole member.
- **Owner:** architecture/decision
- **Related findings:** SEC-H-006 (RouterGovernance loses setWeights)

#### SEC-M-002 — Missing `custodiedTokens()` on IPositionAdapter creates INV-2 risk window during adapter onboarding

- **Classification:** SECURITY_INVARIANT_VIOLATION
- **Confidence:** High
- **Requirement:** `docs/prd.md §12` INV-2 (no stranded assets); `docs/architecture.md §8` (sweepForeignToken moves only non-protected tokens)
- **Evidence:** `IPositionAdapter.sol` (126 lines) has **no `custodiedTokens()` view**. `Vault.sweepForeignToken` (line 1584-1589) checks `protectedToken[token]` — an ADMIN-maintained mapping. `Vault.addAdapter` never automatically adds the adapter's custodied token to `protectedToken`. `PerThemeDeployTest` and all adapter tests never call `setProtectedToken`. `DeployVaultThemes.s.sol` never calls `setProtectedToken`. Between `addAdapter` and the follow-up `setProtectedToken` call, any caller can sweep the adapter's basket token to quarantine — removing it from NAV.
- **Exploitability:** Any caller can call `sweepForeignToken` on the vault. If a basket token appears in vault balance (donation, mistake) before ADMIN sets `protectedToken`, it can be swept.
- **Prerequisites:** Basket token lands in vault balance between `addAdapter` and `setProtectedToken`.
- **Impact:** Temporary but complete — basket token removed from NAV, depositor-asset confiscation (INV-2 violation) during the window.
- **Recommendation:** Add `custodiedTokens() → address[]` to `IPositionAdapter` and call it inside `addAdapter` to auto-protect each token.
- **Missing test:** No test asserts that after `addAdapter`, the adapter's custodied token is automatically protected.
- **Owner:** code (#1116)
- **Related findings:** None

#### SEC-M-003 — Vault-side emergency floor (M-S2) not implemented on `_emergencyDrainToIdle`

- **Classification:** SECURITY_ARCHITECTURE_GAP
- **Confidence:** High
- **Requirement:** `docs/adr/ADR-0010-unified-vault-architecture.md §4.4` (M-S2 vault-side emergency floor)
- **Evidence:** `Vault._emergencyDrainToIdle` (line 1295) passes hardcoded `0` as `minUsdcOut`: `try adpt.withdraw(balance, 0)`. `emergencyDrainAndExclude` (line 1340) also passes `0`. No vault-stored emergency floor parameter exists. The adapter enforces its own internal floor (`max(0, adapterInternalFloor)` per spec §2.2), but the vault never supplies its own override. Spec §4.4 assigns a vault-stored `emergencyFloorBps` to the emergency-model refinements issue (#1121).
- **Exploitability:** Low — adapter bytecode is codehash-pinned, so internal floor is predictable. Requires a compromised adapter allowlist (ADMIN) combined with EMERGENCY_ROLE drain — two independent keys.
- **Prerequisites:** Compromised adapter on allowlist with too-low floor; EMERGENCY_ROLE keyholder calls drain.
- **Impact:** Emergency drain may execute at or near spot price with no vault-enforced safety margin. On a compromised adapter, floor could be zero.
- **Recommendation:** Implement vault-stored `emergencyFloorBps` (timelock-set) and pass `balance.mulDiv(emergencyFloorBps, MAX_BPS)` as `minUsdcOut`.
- **Missing test:** No test asserts vault passes non-zero `minUsdcOut` on emergency drain path.
- **Owner:** code (#1121)
- **Related findings:** None

#### SEC-M-004 — V4 adapter architecture incompatible with real Uniswap V4 (mock pool only)

- **Classification:** SECURITY_ARCHITECTURE_GAP
- **Confidence:** High
- **Requirement:** `docs/architecture.md §4.3` (V4 integration via `IUniswapV4Pool`); ADR-0010 §4
- **Evidence:** `IUniswapV4Pool.sol` defines `token0()`, `slot0()`, `observe()`, `liquidity()` as standalone-contract methods. Real Uniswap V4 pools are entries inside the singleton `PoolManager` (keyed by `PoolId`/`PoolKey`), **not standalone contracts**. The fork test (`UniswapV4AssetPositionAdapter.t.sol:17-35`) documents: *"official uniswap v4-core keeps all pools as entries inside the singleton PoolManager [...] — a documented architecture gap."* The fork test deploys a **mock** V4 pool harness, not a real PoolManager-backed pool.
- **Exploitability:** N/A — not a runtime exploit, a deployability blocker. The V4 adapter cannot route swaps or read TWAP from a real V4 pool on Base. AgentTokenVault's JUNO leg (which depends on a V4 adapter) is undeployable.
- **Prerequisites:** Attempting to operate against a real Uniswap V4 pool on Base mainnet.
- **Impact:** The V4 adapter as implemented **cannot** function against genuine V4. All V4 TWAP reads would revert against real `PoolManager`.
- **Resolution path:** Deploy a thin wrapper contract that reads `PoolManager` and exposes the standalone interface, or restrict V4 adapters to a Base-chain-compatible V4 fork with standalone pools.
- **Missing test:** No test deploys a genuine V4 `PoolManager` and proves the adapter can read `observe()` from it.
- **Owner:** code (#1124)
- **Related findings:** SEC-M-005 (V4 fork test is mock-only)

#### SEC-M-005 — V4 asset-position-adapter fork test uses mock pool, not real V4 — CI gap

- **Classification:** TEST_CI_GAP
- **Confidence:** High
- **Requirement:** Test-coverage policy (behavior executed in CI, not mocked away)
- **Evidence:** `UniswapV4AssetPositionAdapter.t.sol:25-34`: *"this fork test deploys the SAME mock V4 router/pool harness as the demo four-vault suite [...] the DEX mechanics are necessarily still a harness."* The V4 fork test tests SafeERC20 against real Base USDC but swaps through a **mock** V4 pool. The adapter's core functionality (TWAP reads, swap execution against real V4) is never exercised against a genuine V4 pool in any CI job.
- **Impact:** V4 adapter's core functionality is never verified against genuine V4. A real V4 pool may have different ABI, error semantics, or access patterns.
- **Recommendation:** Deploy a minimal V4 `PoolManager`-based test harness, or defer V4 adapter until a production V4 pool exists on Base with verifiable integration.
- **Missing test:** No `forge test` path connects the adapter to a `PoolManager`-backed pool.
- **Owner:** code
- **Related findings:** SEC-M-004 (V4 architectural incompatibility)

#### SEC-M-006 — VaultRegistry `setVaultStatus` silent skip on empty-code addresses masks uninitialized vaults

- **Classification:** SECURITY_GRIEFING
- **Confidence:** High
- **Requirement:** `docs/architecture.md §4.7` (dual-layer retire sync); LIFE-1/AZ-REG-1
- **Evidence:** `VaultRegistry.setVaultStatus()` (line 349-355): `if (vault.code.length > 0) { ... IRetirableVault(vault).retire()/unretire() ... }`. An EOA or selfdestructed address registered as a vault would pass the code-length check as false — the vault hook is silently skipped. `registerVault` does **not** check code length. Azimuth finding AZ-REG-1 was fixed by adding try/catch for revert paths, but the empty-code skip means a registered non-contract address would never halt deposits.
- **Exploitability:** ADMIN_ROLE (timelock) would need to register an EOA or empty address as a vault.
- **Prerequisites:** A registrant who adds an EOA address (previously possible, currently gated only by admin trust).
- **Impact:** Registry status says Retired/Paused but vault deposits are not halted. Depositors can still deposit into a supposed "retired" vault.
- **Recommendation:** Add `require(vault.code.length > 0)` to `registerVault()`. Document the selfdestruct edge case.
- **Missing test:** No test asserts that registering an EOA vault reverts.
- **Owner:** code
- **Related findings:** AZ-REG-1

#### SEC-M-007 — `navDeviationGuardBps` defaults to 0 (disabled) on all basket vaults

- **Classification:** SECURITY_ORACLE_MANIPULATION
- **Confidence:** High
- **Requirement:** ORA-4 (spot-vs-TWAP deviation guard on deposits)
- **Evidence:** `BasketVault.sol:207-213` — `navDeviationGuardBps` is not set in the constructor and defaults to 0. At `BasketView.checkNavDeviation` (called in `_deposit`), a threshold of 0 means "guard disabled" — deposits proceed regardless of spot-vs-TWAP divergence. `maxSlippageBps` floor is derived from pool fee tiers only. The doc at line 209 explicitly says "`0` DISABLES the guard."
- **Exploitability:** An attacker who manipulates spot price in the deposit block (e.g., flash loan on a thin pool) can inflate the TWAP-NAV conversion before the TWAP has converged. The minimum 10-minute TWAP window limits single-block manipulation but does not prevent multi-block sandwich.
- **Prerequisites:** A pool thin enough that flash loan can meaningfully move spot price.
- **Impact:** Deposits proceed at a TWAP mark that may diverge from executable spot price, allowing the depositor's swap to capture more/less value than TWAP implied. Only applies at deposit time (redeem has no spot-vs-TWAP check).
- **Recommendation:** Set `navDeviationGuardBps` to a non-zero value in deploy scripts for each basket vault. Add a deploy-script assert that the guard is non-zero on mainnet.
- **Missing test:** No deploy-time assertion that `navDeviationGuardBps > 0` for mainnet.
- **Owner:** code/operations
- **Related findings:** SEC-H-003 (ORA-7)

#### SEC-M-008 — No admin path to sell a single basket asset — `removeAsset` requires zero balance

- **Classification:** SECURITY_OPERATIONS
- **Confidence:** High
- **Requirement:** `docs/adr/ADR-0004` (shortlist governance)
- **Evidence:** `removeAsset` at `BasketVault.sol:1097-1102` reverts `AssetStillHeld` if `balanceOf(address(this)) > 0`. No public or admin function can sell a specific basket asset. `emergencyUnwind` sells ALL active assets. If an asset must be removed (compromised token, frozen pool), the only paths are (a) wait for organic redemptions to drain to zero, or (b) `emergencyUnwind` which liquidates the entire vault.
- **Exploitability:** This is a governance limitation. A compromised/frozen basket asset cannot be quickly removed. The asset continues to be counted in NAV — if the pool degrades (observe reverts), `totalAssets()` bricks ALL entry/exit for the vault.
- **Impact:** Cannot remove a single unwell asset without unwinding the entire vault.
- **Recommendation:** Add a governance-gated `adminSellAsset(index, minUsdcOut)` that sells one active basket asset and leaves proceeds as idle USDC, gated behind ADMIN_ROLE + timelock.
- **Missing test:** No test for removing an asset with non-zero balance via any mechanism.
- **Owner:** code
- **Related findings:** None

#### SEC-M-009 — Formal verification CI includes `vm.skip()` — 2 of 3 SUP-1 sub-invariants permanently skipped

- **Classification:** TEST_CI_GAP
- **Confidence:** High
- **Requirement:** Test-coverage policy (loud-skip, never silent-skip; >0 tests must run)
- **Evidence:** `suite-22-formal-verification.yml` runs `forge test --match-path 'contracts/test/fv/**'` which includes `CustodyMultiVault.t.sol`. Lines 96, 108 use `vm.skip(true, ...)` with the message: *"basket-family custody handler needs vetted-adapter rig - remediation #966"* and *"RwaVault custody handler needs stale-feed short-circuit - remediation #966 (NC-1/SUP-5)"*. CI reports green despite zero behavior execution for these properties.
- **Impact:** Overstated formal verification coverage. Two critical custody invariants (SUP-1 for basket family and RWA) are not tested at HEAD, relying on remediation #966.
- **Recommendation:** Either (a) close the skipped paths (#966), or (b) use loud-fail (`revert`) or `vm.assume(false)` so CI is provably red until the handler is wired.
- **Owner:** code
- **Related findings:** #966

#### SEC-M-010 — No fork test exercises BasketVault TWAP-manipulation path with live pool

- **Classification:** TEST_CI_GAP
- **Confidence:** High
- **Requirement:** Test-coverage policy (behavior executed in CI for all invariant surfaces)
- **Evidence:** Fork tests (`suite-01-02`: for UniV3/V4/Aerodrome `AssetPositionAdapter`) exercise the ADR-0010 seam, NOT `BasketVault`'s `_executeSwap`, `_routeDeposit`, `_sellProportional`, or `_twapQuote` with real pools. `BasketVault.t.sol` uses mock pools exclusively. `TwapManipulation.t.sol` has no live pool — it is a scout stub. The CI `unit` step excludes fork tests via `--no-match-contract`.
- **Impact:** A regression that reintroduces slot0 reads or breaks the observe-based TWAP path in BasketVault would pass CI if mocks align with the regression.
- **Recommendation:** Add a `BasketVaultForkTest` that deploys a ProtocolAssetVault on forked Base, seeds a real USDC-paired pool, and asserts `deposit()`/`redeem()` clear at TWAP-bounded prices.
- **Missing test:** `BasketVaultForkTest` does not exist.
- **Owner:** code
- **Related findings:** SEC-H-003 (ORA-7), SEC-M-005 (V4 fork mock-only)

#### SEC-M-011 — Slither configured with `fail_on: high` only — medium findings pass silently

- **Classification:** TEST_CI_GAP
- **Confidence:** High
- **Requirement:** Test-coverage policy (required checks cover all languages; static analysis gates)
- **Evidence:** `suite-03-solidity-quality.yml:124` — `slither . --config-file slither.config.json --filter-paths 'lib/,contracts/test/,contracts/script/'`. `slither.config.json` has `"fail_on": "high"` only; medium findings are reported but do not fail CI.
- **Impact:** A medium-severity static-analysis finding (e.g., divide-before-multiply that may mask a real rounding bug) passes CI silently.
- **Recommendation:** Add `--fail-on medium` to slither config. Suppress each medium finding with a dated comment where accepted.
- **Owner:** operations
- **Related findings:** None

#### SEC-M-012 — MorphoAdapter `totalAssets()` returns theoretical NAV — `isExact()=true` overstates lendable value under market stress (FS-VLT-10)

- **Classification:** SECURITY_ORACLE_MANIPULATION
- **Confidence:** High
- **Requirement:** `docs/technical/unified-vault-spec.md §2.2` (exactness attestation); INV-1 (NAV integrity)
- **Evidence:** `MorphoAdapter.totalAssets()` (line 170-171) returns `MORPHO_VAULT.convertToAssets(shares)` — the theoretical share-of-totalAssets NAV. `isExact()` (line 177) returns `true`, telling the vault to trust this NAV without margin. `MORPHO_VAULT.withdraw()` (line 144-145) also uses `convertToAssets` to determine redeemable amount. When the Morpho vault holds bad debt (e.g., a defaulted lending market), `totalAssets()` includes the unrecoverable amount, inflating NAV. The `maxExposure` cap (line 86-91) limits the total at risk but does not correct the NAV. This affects vault share price, deposit/redeem fairness, and PortfolioRouter weight calculations.
- **Exploitability:** Requires a Morpho market default or manipulation of the Morpho vault's `totalAssets` — upstream venue risk outside protocol control.
- **Prerequisites:** Morpho Gauntlet USDC Prime vault holds assets that become unrecoverable.
- **Impact:** Overstated NAV — existing holders overpay for redemptions while new depositors overpay for shares. Router weight misallocation to this adapter.
- **Recommendation:** (a) Document in architecture.md that lending adapters with `isExact()=true` assume upstream-venue solvency. (b) Consider a per-adapter NAV discount parameter applied in `totalAssets()` for non-instant venues. (c) Monitor Morpho vault health off-chain and set `maxExposure` to 0 to disable the adapter if health degrades.
- **Missing test:** No test asserts `totalAssets() ≈ vault.USDC.balanceOf(adapter) + adapter.withdraw(shares, 0)` under simulated market stress (e.g., forked Morpho vault with frozen market).
- **Owner:** architecture/code
- **Related findings:** None

---

## Clean Areas (Adequately Covered)

- **Custody invariants INV-1..4** are well-tested and hardened — `CustodyInvariantGuard` static scan, `CustodyInvariant` fuzz, `PortfolioRouter` delta-balance check. No arbitrary-recipient path exists at HEAD.
- **Pause asymmetry (v2 Vault.sol):** `Paused` splits deposit/withdrawal; correct authority separation. Key v1 fix exists in v2 but not backported.
- **Gateway role separation:** Pairwise disjoint ADMIN/PAUSER/AGENT roles; last-admin floor on all five protocol contracts (PortfolioRouter, VaultRegistry, RouterGovernance, RobotMoneyGateway, InvestmentCommitteePolicy).
- **Gateway window accounting:** Rolling-window ring buffer (deposit and withdrawal); `nonReentrant` protected; fuzz-tested for deposits. Withdrawal window accounting also correct but un-fuzzed.
- **Gateway idempotency:** Op-kind discriminators namespace paymentIds across deposit/withdraw/router; cross-chain replay impossible.
- **Governance parameter isolation:** `snapshotQuorum` captured at `propose()`; `setQuorumThreshold` does not retroactively affect in-flight proposals.
- **Router preview consistency:** `_availabilityAndAmounts()` is the single shared predicate for both `previewDeposit` and `_executeLegs` — cannot diverge.
- **Router ALL-OR-REVERT:** `_executeLegs` checks `usdc.balanceOf(address(this))` delta after each leg; donation-DoS tested.
- **Retire/reactivate atomicity:** `VaultRegistry.retire()` enforces `!_routerEligible` before permitting Retired state; `setVaultStatus` drives IRetirableVault hooks (fixes AZ-REG-1).
- **TWAP arithmetic (TwapTickMath):** Uses OZ `Math.mulDiv` for sqrt-price conversion — safe at boundary ticks. Extracted from adapter inline code as byte-identical per CI gate.
- **First-deposit inflation protection:** `_decimalsOffset() == 18` on all vaults; donation-based inflation attack economically infeasible.
- **Approval hygiene:** `forceApprove(_, amount)` followed by `forceApprove(_, 0)` on all adapters (except CompoundV3 — see L-001). No infinite approvals.
- **Codehash pinning:** `addAsset`/`addAdapter` verifies allowlist + codehash + USDC/VAULT identity.
- **Watchdog SOS:** SLA > 0 enforced at startup; zero threshold rejected; pause path key is PAUSER_ROLE-only (cannot unpause).
- **SECURITY.md:** Exists at repo root — satisfies disclosure-handling requirement.
- **CI loud-skip discipline:** Fork tests revert loudly when RPC is absent (`setUp` reverts); CI jobs document skipped test paths explicitly.

---

## Low-Severity Findings (Summary)

| ID | Area | Issue | Current status |
|----|------|-------|---------------|
| L-001 | CompoundV3Adapter | `safeIncreaseAllowance` instead of `forceApprove` — residual allowance grows on revert | Not exploitable (vault is sole caller) |
| L-002 | Vault.addAdapter | No duplicate-address guard — same adapter can be registered twice | ADMIN_ROLE only; double-counts NAV |
| L-003 | RobotMoneyVault.removeAdapter | Trusts adapter's `totalAssets()` — lying adapter prevents removal | ADP-2 codehash pinning mitigates |
| L-004 | RobotMoneyVault.grossToNet | Exit fee rounds down (favors exiting user over remaining holders) | De minimis (1 wei) |
| L-005 | RouterGovernance | No MAX bound on `votingPeriod`/`executionDelay` — ADMIN could set to uint64.max | Timelock can undo; managed risk |
| L-006 | DeployPortfolioRouter | Deploy script sets admin to deployer EOA (devnet) | DeployTimelock required for prod |
| L-007 | TwapTickMath | No boundary test for min/max ticks (arithmetic safe via mulDiv) | Test coverage gap |
| L-008 | agent-token-shortlist.json | All addresses are `0x0` placeholders with TODOs | Blocks mainnet AgentTokenVault deploy |
| L-009 | Watchdog | No receipt polling after pause-tx submission | Wasted gas on revert; no SLA monitoring |
| L-010 | rmpc | Deferred cross-endpoint RPC consensus; code-hash vault/router not checked | Documented risk |
| L-011 | Dapp browser keygen | Chain-ID classifier + build-time key absent = fail-closed | Verified |
| L-012 | revealAuthorization | Admin can front-run user's reveal in same block | Admin is trusted |
| L-013 | BasketVault | `deposit()` and `redeem()` lack caller-specified min-out params — all users share admin-configured `maxSlippageBps`. Router path has per-leg min via `minAssetsPerLeg`. | Admin floor bounds worst case; per-caller tightening is a UX gap |

---

## Documentation Changes Required

1. **PRD §12 INV-3** vs **ADR-0006 §2**: The PRD says "withdrawals are never blocked"; ADR-0006 documents that stale-oracle halts withdrawals. Align the PRD to match ADR-0006, or implement partial-redemption path that bypasses oracle for idle USDC.
2. **architecture.md §2.3**: Document that the Safe+Timelock retains `setWeights` override as a deliberate governance-escalation path (SEC-M-001).
3. **docs/audits.md**: Update dispositions for 8 AZ-0623/FS-0619 findings that are code-fixed at HEAD (SEC-H-007). Cross-reference remediating PRs.
4. **docs/architecture.md §4.3**: Document that the V4 adapter architecture is incompatible with real Uniswap V4 until wrapper is implemented (SEC-M-004).
5. **RobotMoneyVault sweepForeignToken NatSpec**: Clarify that adapter receipt tokens are excluded from protected set because they are never held by the vault.
6. **Watchdog pause.rs**: Document pre-flight checks and receipt polling limitations.

---

## Unresolved Decisions

| Decision | Status | Impact |
|----------|--------|--------|
| V4 adapter wrapper or PoolManager integration | TBD (#1124) | AgentTokenVault JUNO leg blocked |
| Independent slippage floor (ORA-7 fix) | TBD (#966) | TWAP-derived floor provides no independent guard |
| vault-stored emergencyFloorBps | TBD (#1121) | Emergency drain defers entirely to adapter floor |
| MAX cap on governance votingPeriod/executionDelay | Not decided | ADMIN could freeze governance |
| RouterGovernance as sole setWeights caller | Not enforced | Timelock retains override (documented? not yet) |
| Max on erc20-approve for catch_token_tokens | Not implemented | Edge cleanup gap only |

---

## Limitations

1. **Static/source-only review** — no fuzz, symbolic verification, or deployment CI logs analyzed. `FvInvariants.t.sol` (22+ stateful invariants) was source-read but not executed.
2. **Fork-test CI state unknown** — nightly fork tests were red as of commits 5f8d8cd and 2c581122 ("nightly Base fork drift detected," "nightly-red since July 1"). Current pass/fail state at HEAD could not be verified without an RPC endpoint.
3. **Principal checkout lag** — the principal checkout (7231816b) was 20 commits behind origin/dev (43694310). The review was performed against the worktree pinned at origin/dev HEAD. `docs/prd.md` and `docs/architecture.md` were read from the principal checkout; key content was verified for drift against the worktree version.
4. **Investment Committee contract** — not shipped at HEAD (not in deployed contracts). Only policy contract design was reviewed from docs.
5. **Production deployment manifest** — `deployments/full-stack.json` is devnet/harness only. Mainnet deployment configuration was not reviewed.
6. **No EIP-1559 support in watchdog** — pause tx uses legacy envelope; gas market efficiency gap only.
7. **Upstream venue risk** — Aave V3, Compound V3, Morpho Gauntlet, Aerodrome, and Uniswap V3/V4 are third-party contracts. Upstream protocol risk is accepted per docs.

---

## Unreviewed Surfaces

- Lending adapter retrofit implementations (Morpho/Aave/Compound for ADR-0010 — #1117)
- `UniswapV3SwapAdapter`, `UniswapV4SwapAdapter`, `AerodromeSwapAdapter`, `ChronicleOracleAdapter` venue executors in full (path analysis was performed, not full bytecode review)
- `BasketViews.sol` pricing library (partially reviewed via caller)
- `ForeignTokenQuarantine.sol` (assumed correct from v1 audit)
- Rust `rmpc` replay cache (`clients/rust-payment-client/src/replay_cache/`)
- Dapp source (`clients/dapp/src/`) beyond CSP and credential boundary
- Indexer SQL queries beyond parameterization check
- `lib/forge-std` — vendored dependency, assumed audited

---

## Summary

The Robot Money codebase shows careful enforcement of its core custody invariants. The highest-priority issues are: (1) the v1 RobotMoneyVault pause blocking withdrawals (needs backport), (2) the ISwapRouter ABI mismatch blocking ProtocolAssetVault mainnet deployment, (3) DeployTimelock missing the RouterGovernance ADMIN grant that would brick governance post-handover, and (4) the stale `docs/audits.md` ledger. The new V2 unified vault faithfully addresses the known v1 gaps but introduces adapter-boundary issues (V4 architecture, missing `custodiedTokens()`, emergency floor). The off-chain surfaces (rmpc, dapp, explorer, watchdog) are solid with well-contained risk, though cross-endpoint RPC consensus deferral remains a documented gap for high-value reads.
