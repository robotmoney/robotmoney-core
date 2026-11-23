# Adversarial Meta-Review: Robot Money `release-0.9.0` Smart Contract Safety Review

- **Reviewed Deliverable:** `docs/code-reviews/20261121-214700-agy/*.md` (6 files: `README.md`, `00-executive-summary.md`, `01-governance-and-access-control.md`, `02-economic-manipulation-and-asset-safety.md`, `03-reentrancy-flows-and-accounting.md`, `04-product-alignment-and-upgrade-posture.md`)
- **Worktree Under Evaluation:** `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/adhoc-20261122-233507-safety-review-090`
- **Target Codebase Revision:** `release-0.9.0` (`86747f24534a39cf19a75d4370d3f91466dcc24f`, tag `contracts-0.9.0`) / `dev` (`6c25fd8ce291a88ed088f71e0e015296a561ea24`, PR `#2019`)
- **Meta-Review Date:** `2026-11-22`

---

## 1. Executive Scorecard & Verdict

### Direct Answer: Is It Correct? Is It Complete? Is It Coherent?

| Question | Grade | Summary Verdict |
|---|---|---|
| **Is it correct?** | **`PARTIAL / NEEDS FIXES`** | All 13 non-info findings (`AGY-01`–`AGY-13`) point to real underlying issues in the code (zero pure hallucinations), and `AGY-02`'s patch plus Chapter 01 Section 3's positive governance verifications are sound. **However, 9 remediation patches/recommendations (`AGY-01`, `AGY-03`, `AGY-04`, `AGY-05`, `AGY-06`, `AGY-07`, `AGY-08`, `AGY-09`, `AGY-11`) contain serious bugs, security regressions, or invariant violations**, and the prose contains **~18 concrete factual, constant, and line-citation errors** (e.g., `MATCH_SCALE = 1e18` instead of `1e30`, `ACC_SCALE = 1e27` instead of `1e36`, wrong `CompoundV3Adapter` approval mechanics, wrong ERC-7201 member counts, nonexistent `DEFAULT_EPOCH_LENGTH = 24h`, misattributed `BasketSwaps.unwindAll`). |
| **Is it complete?** | **`INCOMPLETE`** | Missed **9 major verified issue classes (`MISSED-01`–`MISSED-09`)**, including **1 Critical** permissionless permanent `FlowQueue.settle()`/`withdrawCredit()` `O(N²)` gas DoS via 1-wei whole-balance `requestRedeem` spam, **2 High** accounting/custody bugs (multiplicative `totalScaled` precision collapse confiscating 100% of delisting/lending claim proceeds on 18-decimal assets like WETH; `shutdown()` → `restore()` `ownerRedStates.matchCycle` phantom shares in `FundExclusionLedger`), **1 High/Medium** USDC-blacklisted `feeRecipient` DoS that bricks even emergency `redeemInKind()`, **2 Medium** contract liveness bugs (`Rebalancer._decide` missing `isAssetInSale` mask; `_considerDeposit` sub-minimum remainder infinite keeper loop), **3 production-breaking bugs** in `scripts/ops/onevault-*.sh`, and **zero Foundry PoC execution, `Invariants.t.sol` gap audit, or CI `--skip` coverage synthesis**. |
| **Is it coherent?** | **`MOSTLY COHERENT WITH DIRECT CONTRADICTIONS`** | The 6-document layout, cross-chapter linking, and repo-relative citations are well organized, but the report is undermined by **4 direct cross-chapter contradictions** (`04:52` vs `01 AGY-09` on `FundAdapterGuard.vet`; `00:27` vs `02:63` on `BasketSwaps.unwindAll` vs `FundFlowsLib._emergencyUnwind`; `04:53` vs `01:12,17` on rehearsal `900s` vs `48h` upgrade delay; `00:56` vs `02:323` on `A6`), an operational framing mismatch (`01:19` vs `deploy-4.env:25`), minor line-citation drift, and severity over-rating of `AGY-08` (`Medium` → `Low`). |

### Overall Meta-Review Verdict

> **`NOT PUBLICATION-READY` — Substantively valuable core discoveries, but unsafe to ship or act on remediation code as written.**
>
> The review earns genuine credit for finding real, high-value defects (`AGY-01`, `AGY-02`, `AGY-03`, `AGY-05`, `AGY-07`, `AGY-10`, `AGY-11`, `AGY-12`, `AGY-13`) with zero hallucinated findings and accurate verification of `ProposerFloorTimelock`'s `PROPOSER_ROLE` floor, `AdminFloorAccessControl`, `GovernedUUPS`, and Check 10's 256-bit overflow safety. **However, shipping this review to engineering without revision would be actively harmful**: an engineer implementing the report's proposed Solidity patches verbatim would introduce an unauthenticated `KeeperAccount` takeover (`AGY-04`), a cross-slot active-position liquidation bug (`AGY-07`), a permanent brick on crashed-asset emergency unwinds (`AGY-01`), double-selling healthy assets during delisting (`AGY-05`), looser price bounds (`AGY-06`), an `RB-1`/`E1` invariant breach (`AGY-08`), and a `totalAssets()` DoS (`AGY-09`) — all while leaving a <$1 permissionless Critical DoS (`MISSED-01`) and two High fund-confiscation/theft bugs (`MISSED-02`, `MISSED-03`) completely unreported.

### What the Review Got Right (Retain in Revision)

- **Zero pure hallucinations:** Every single one of `AGY-01` through `AGY-13` maps to an actual code defect or edge case in `release-0.9.0`.
- **Sound `AGY-02` discovery and patch:** Correctly identified that `ProposerFloorTimelock` enforces `LastProposerFloor` only on `PROPOSER_ROLE` while `D4-10` leaves the Safe as sole `EXECUTOR_ROLE`, and proposed a sound `executorCount` / `LastExecutorFloor` / `NoExecutor` fix.
- **Accurate positive governance & accounting verifications:** Chapter 01 Section 3 (`ConsensusRecommendationReceipt`, `RebalanceGovernance` `ADMIN_ROLE` floor, `GovernedUUPS` `upgradeTimelock` immutability and one-way `freezeUpgrades`) and `AGY-14`'s Check 10 checked 256-bit cross-multiplication verification are solid.
- **Strong root-cause framing and document ergonomics:** The 5-pattern root-cause synthesis in `00-executive-summary.md` and clean 6-file structure are worth preserving once the technical defects below are corrected.

---

## 2. Correctness Audit — Broken Remediation Patches & Factual Errors

### 2.1 Dangerous / Broken Remediation Patches (Must Rewrite Before Publication)

Nine of the review's proposed fixes contain critical implementation bugs, design regressions, or architectural invariant violations. None of them were compiled or tested against Foundry.

#### 1. `AGY-01` (`02-economic-manipulation-and-asset-safety.md:73-101`) — `max(stalePrice, minUsdcOut)` Permanently Bricks Unwinding Crashed Assets
- **Defect in Proposed Patch:** The patch computes `floor = max(oracleFloor, minUsdcOut)`, where `oracleFloor` falls back to stale `saleFallbackPrice` or `lastGoodAssetPrice` whenever `feedOk == false`.
- **Why It Breaks Production:** When an asset crashes sharply (e.g., `-60%` depeg or exploit) *and* its Chainlink feed halts or goes stale (`feedOk == false`), `oracleFloor` remains pinned near `97%` of the pre-crash valuation. Even if governance passes a realistic `minUsdcOut` reflecting the `40%` post-crash market price, `max(oracleFloor, minUsdcOut)` enforces the unreachable `97%` pre-crash floor and **permanently reverts `emergencyUnwind(index)`** — turning a slippage guard into a permanent custody trap at the exact moment emergency liquidation is needed.
- **Required Fix:**
  - When `feedOk == false`, do **not** take `max(stalePrice, minUsdcOut)`. Require an explicit, governance-supplied `minUsdcOut > 0` directly (reverting `EmergencyFloorUnavailable` if `minUsdcOut == 0`), optionally bounded by a configurable sanity cap/slippage parameter rather than a stale price floor.
  - When `feedOk == true`, add an explicit governed override path (e.g., `ignoreOracleFloor` or explicit `minUsdcOut` override flag) to handle stale-within-heartbeat depegs where the feed is technically fresh (`feedOk == true`) yet lags an instantaneous `-40%` market crash.

#### 2. `AGY-04` (`01-governance-and-access-control.md:286-323`) — Proposed `KeeperAccount.execOwnerCall` Introduces 4 New Vulnerabilities
- **Defects in Proposed Patch:**
  1. **Unauthenticated takeover when `threshold == 0`:** The signature verification loop runs `for (uint256 i = 0; i < threshold; ++i)` (or iterates `sigs.length` checked against `threshold`). If `threshold == 0` is permitted or reached during initialization/configuration, the loop runs `0` times and **any arbitrary caller** can execute `execOwnerCall` to seize `KeeperAccount`.
  2. **Self-brick via `removeOwner` (`contracts/KeeperAccount.sol:94`):** The patch leaves `removeOwner` checking only `_owners.length == 1`, allowing owners to remove co-owners until `_owners.length < threshold`, permanently bricking quorum.
  3. **Broken EIP-1271 promise (`01:284`):** The prose explicitly promises smart-contract signer support (EIP-1271, e.g., for Safe co-owners), but the Solidity snippet uses `ECDSA.recover`, which works **only for EOAs** and always fails for contract signers.
  4. **Unrestricted self-call & missing EIP-712 domain:** Calling `address(this).call(data)` without a strict selector allowlist opens arbitrary self-call surfaces (including future upgrades/external hooks), and the snippet uses `_hashTypedDataV4` without declaring an `EIP712("KeeperAccount", "1")` constructor / initializer.
- **Required Fix:** Enforce `threshold >= 1` (and `>= 2` when `owners.length >= 2`, or deploy `KeeperAccount` with the multisig Safe as the sole owner so Safe quorum governs directly); enforce `_owners.length - 1 >= threshold` in `removeOwner`; use `SignatureChecker.isValidSignatureNow` for EIP-1271 compatibility; restrict `execOwnerCall` to an explicit selector allowlist (`addOwner`, `removeOwner`, `addBot`, `removeBot`, `setThreshold`); initialize EIP-712 properly.

#### 3. `AGY-05` (`02-economic-manipulation-and-asset-safety.md:254-267`) — Setting `endIdleTargetBps` During `inSale` Triggers Destructive Double-Selling
- **Defect in Proposed Patch:** Plugging `endIdleTargetBps = BPS - sum(p.endBps)` directly into `PlanMath.pathTargetValue(p, IDLE_INDEX, ...)` while the delisted asset `j` is still `inSale` (`values[j] ≈ w`, `idle ≈ 0`) causes `Rebalancer`'s `pickLegs` to see `IDLE_INDEX` as underweight by `w`.
- **Why It Breaks Production:** While `stepDelisted` is concurrently selling asset `j` (`w`) into USDC cash, `Rebalancer` simultaneously **sells healthy non-delisted basket/lending assets into USDC cash** to fill the perceived `IDLE_INDEX` deficit. Once `stepDelisted` finishes, the vault holds up to **`2w` idle cash** and must pay a second round of swap fees/slippage to buy back the healthy assets it just sold.
- **Additional Omissions:** The patch also fails to update `PlanMath.pathTargetsBps` (`contracts/PlanMath.sol:223`) and `Rebalancer._legPathBps` (`contracts/Rebalancer.sol:399,402`), leaving path-target helpers inconsistent.
- **Required Fix:** Distinguish *realized* cash from *pending delist liquidation value*: either exclude `inSale` residual value from the `IDLE_INDEX` deficit (treat `effectiveIdle = idle + sum(inSaleValues)` when computing idle underweight, or exclude `IDLE_INDEX` as a buy target while any asset is `inSale`) and consistently update `PlanMath.pathTargetsBps` (`:223`), `PlanMath.pathTargetValue`, `PlanMath.withinTolerance`, and `Rebalancer._legPathBps` (`:399,402`).

#### 4. `AGY-06` (`02-economic-manipulation-and-asset-safety.md:330-332`) — `LEG_PRICE_FEED_ONLY` Recommendation Is Mathematically Backwards
- **Defect in Proposed Remediation:** Recommends switching from default `LEG_PRICE_STRICTER` to `LEG_PRICE_FEED_ONLY` to mitigate `A10`/`A2` net-flow extraction, and suggests matching at `navFeed`.
- **Why It Is Backwards / Already Rejected:**
  - `LEG_PRICE_STRICTER` computes `min(feed, twap)` for buys (fewer shares minted / higher buy price) and `max(feed, twap)` for sells (more conservative sell bound). Therefore **`LEG_PRICE_FEED_ONLY` is strictly looser**, not tighter, whenever TWAP moves against the attacker.
  - `LEG_PRICE_FEED_ONLY` was already benchmarked as scenarios `L4`/`L9` in `contracts/test/prototype/Attacks.t.sol:3927-3952` (`_lever`) and explicitly rejected in `OwnerDefaults.t.sol:31` (`test_defaults_queueStartsWithTheFiveBpsCallCap`).
  - Matching at `navFeed` was already explicitly rejected by the product owner in `docs/technical/one-vault-rebalancer-proposal.md:3218-3222`.
- **Required Fix:** Remove both `LEG_PRICE_FEED_ONLY` and `navFeed` matching suggestions. Frame `AGY-06` accurately around the actual open Gate G8 trade-off documented in `one-vault-rebalancer-proposal.md`: tightening `refBandBps` vs liveness/availability (or adding an explicit fee/spread floor on net-flow imbalance).

#### 5. `AGY-07` (`02-economic-manipulation-and-asset-safety.md:379`) — Proposed `reabsorbRemovedAsset` Liquidates Active Re-Listed Positions
- **Defect in Proposed Patch:** The proposed `reabsorbRemovedAsset(uint256 index)` checks only:
  `!s.assets[index].active && s.delistClaimedTokens[index] == 0 && s.deferredTotal[index] == 0`
  and then sweeps/quarantines or reabsorbs `IERC20(a.token).balanceOf(address(this))`.
- **Why It Is Catastrophic:** Because `FundAdminLib.addAsset` (`contracts/lib/FundAdminLib.sol:128-142`) allows re-listing a previously deactivated token by **appending a new active slot `j`**, two slots now share the same `a.token` address (`oldIndex` inactive, `j` active). Calling `reabsorbRemovedAsset(oldIndex)` passes every check on `oldIndex`, reads the vault's **entire** `IERC20(a.token).balanceOf(address(this))`, and **liquidates or quarantines 100% of active slot `j`'s live position!**
- **Required Fix:** Either (a) check across all slots `k != index` that no other slot with `s.assets[k].token == a.token` is `active`, `inSale`, or holds non-zero `delistClaimedTokens[k]` / `deferredTotal[k]`, or (b) implement in-place inactive-slot reuse first (mirroring `BasketAssetConfigGuard.reuseOrRejectDuplicate`) so each token maps to at most one slot in `s.assets`.

#### 6. `AGY-08` (`01-governance-and-access-control.md:402`) — Suggested `rebind*Role` Violates `RB-1`/`E1` Security Invariants
- **Defect in Proposed Remediation:** Suggests adding `ADMIN_ROLE`-gated `rebindFlowRole` / `rebindRebalanceRoles` functions on `RobotMoneyFund` to recover if bound proxies are frozen or roles are lost.
- **Why It Violates Core Architecture:** `RobotMoneyFund.sol:53-54` explicitly enforces invariants **`RB-1`** and **`E1`**: once `FlowQueue`, `Rebalancer`, and `RebalanceGovernance` are wired and their UUPS proxies are frozen via `GovernedUUPS.freezeUpgrades`, **`ADMIN_ROLE` must NOT be able to rebind those roles** to a malicious contract and bypass `FlowQueue`/`Rebalancer` user-protection guards. Adding `ADMIN_ROLE`-gated rebinding destroys the entire frozen-proxy trust guarantee.
- **Required Fix:** Remove the `rebind*Role` recommendation completely. Limit remediation to preventing accidental zero-holder self-renunciation on `TARGET_SETTER_ROLE` (e.g., last-holder floor) while keeping one-shot immutable bindings (`FLOW_ROLE`, `REBALANCER_ROLE`, `GOVERNANCE_ROLE`) intact under `RB-1`/`E1`.

#### 7. `AGY-09` (`01-governance-and-access-control.md:490-507`) — Patch Misses Own Sub-Finding, Breaks Parity, DoS's `totalAssets()`, and Doesn't Compile Cleanly
- **Four Defects in Proposed Patch:**
  1. **Fails to fix its own sub-finding (`01:440` vs `01:492-493`):** The prose flags `setAdapterProxyCodeHash(proxyHash, false)` leaving stale adapters vetted, yet the proposed code still returns early whenever `codeHashAllowed[h]` remains `true`, leaving the exact sub-finding unfixed.
  2. **Breaks intentional `BasketVault` parity & DoS's exits (`RobotMoneyFund.sol:754`):** Unconditionally enforcing `codeHashAllowed[h]` inside `FundAdapterGuard.vet()` breaks intentional parity with `BasketVault` and causes `totalAssets()`, `emergencyUnwind()`, and `executeDelistStep()` to **revert (DoS)** if a direct adapter's code hash is revoked while the vault still holds balance through it.
  3. **Incompatible `StepFeedLib` signature & error folding:** `StepFeedLib.check` does not accept `address fund` (needed to read fund adapter vetting state), and wrapping a `vet()` call inside the existing `try` block would silently fold `AdapterCodeHashNotAllowed` into a generic `TwapRead` failure rather than propagating an adapter-vetting error.
  4. **Ignores EIP-170 headroom:** `RobotMoneyFund` sits only **~382 bytes** below the 24,576-byte EIP-170 limit; adding cross-contract vetting hooks without bytecode accounting risks exceeding the deployment ceiling.
- **Required Fix:** Separate **new-exposure / write-path vetting** (strictly enforcing `codeHashAllowed` + proxy implementation check on `addAsset`, swaps, and deposits) from **read/exit paths** (`totalAssets`, `emergencyUnwind`, `executeDelistStep`) so revoking an adapter code hash blocks new routing without bricking valuation or exits. Pass explicit vetting state or vet outside `StepFeedLib`'s `try` block, and verify bytecode size with `forge build --sizes`.

#### 8. `AGY-11` (`03-reentrancy-flows-and-accounting.md:117`) — Seeding `lastAssetPerShare` at Migration Corrupts Check 6
- **Defect in Proposed Patch:** Proposes seeding `s.lastAssetPerShare[i]` during `migrateV090` from `fund.assetValue(i)`.
- **Three Reasons This Breaks:**
  1. **Oracle basis mismatch:** `fund.assetValue(i)` uses **AMM TWAP** pricing, whereas `lastSharePrice` and Check 6 (`SettleCheck.SharePrice`) compare against **Chainlink feed prices** — introducing an immediate cross-oracle skew.
  2. **Calls un-migrated adapters:** During `FlowMigrateLib.sol:144-145`, the ADR-0019 adapter proxy swap has not yet completed; invoking `fund.assetValue(i)` inside migration calls pre-migration adapters.
  3. **Timestamp/holdings mismatch:** `lastAssetPerShare[i]` would reflect migration-time holdings while `lastSettleAt` and `lastSharePrice` reflect `v0.8.0`'s historical last settlement, corrupting the Check 6 baseline.
- **Required Fix:** Do not seed from `fund.assetValue(i)` in `migrateV090`. Either enforce the operational rule (run one `v0.9.0` settlement before any `delistAsset`, or guard `delistAsset` with a `require(lastAssetPerShareSeeded)` check) or adjust Check 6 in `FlowCheckLib.sol:188-227` to skip the ex-sale subtraction when `s.lastAssetPerShare[i] == 0` (falling back to full NAV comparison for the single transitional settlement).

#### 9. `AGY-03` (`02-economic-manipulation-and-asset-safety.md:163-173`) — Incomplete Patch Misses Early Return & Lending Equivalent
- **Four Defects in Proposed Patch:**
  1. **Misses early-return branch (`contracts/lib/FundFlowsLib.sol:685-688`):** When `totalTok == 0 && !inSaleNow`, `_emergencyUnwindAsset` returns early *before* reaching the patch's deactivation logic, leaving a zero-balance dead-feed asset still `active = true` and still bricking `totalAssets()`/`settle()`/`step()`.
  2. **Unnecessary `s.deferredTotal[index] == 0` guard:** Requiring `s.deferredTotal[index] == 0` before deactivation blocks emergency recovery unnecessarily because `_claimDeferred` continues to operate cleanly after `s.assets[index].active = false`.
  3. **Omits the Lending-asset equivalent deadlock:** Check 5 (`_lendRates`) exhibits the analogous deadlock when a lending asset is unwound/empty with an unhealthy rate/venue adapter while a live plan blocks `deactivateAsset`.
  4. **Extraneous prose reference:** Mentions `lastStateStopEndedAt` in prose without applicability to the `_emergencyUnwindAsset` code path.
- **Required Fix:** Move deactivation/state-transition logic so it covers **both** the `totalTok == 0 && !inSaleNow` early-return path and the post-swap path; drop the `s.deferredTotal[index] == 0` restriction (guard only on `delistClaimedTokens[index] == 0` and remaining token balance); address the symmetric lending-asset Check 5 (`_lendRates`) deadlock; remove the spurious `lastStateStopEndedAt` mention.

---

### 2.2 Concrete Factual, Constant, & Line-Citation Errors (Exhaustive Table)

| # | Review Location | Claim Made in Review | Verified Ground Truth in Codebase / Docs | Impact |
|---|---|---|---|---|
| 1 | `03:198, 203` | `MATCH_SCALE = 1e18` and `ACC_SCALE = 1e27` | `MATCH_SCALE = 1e30` (`contracts/lib/FlowMatchLib.sol:40`); `ACC_SCALE = 1e36` (`contracts/lib/FlowMatchLib.sol:42`). | High factual error in core accounting verification (`AGY-14`); casts doubt on precision claims. |
| 2 | `02:416-417`; `03:190, 194` | `CompoundV3Adapter` uses `forceApprove(..., amount)` with unconditional reset to 0; mentions `withdrawAll` on lending adapters; describes allowance handling in `MorphoAdapter.withdraw`; omits external sweep/harvest hooks. | `contracts/adapters/CompoundV3Adapter.sol:79,103` uses `safeIncreaseAllowance` + conditional `_clearAllowance` (`if (remaining > 0)`). **`withdrawAll` does not exist** on any lending adapter. `MorphoAdapter.withdraw` touches **no allowances**. Permissionless `sweepForeignToken` and `harvestRewards` on lending adapters were completely omitted. | Multiple false claims about audited adapter code; missed attack surface (`sweepForeignToken`/`harvestRewards`). |
| 3 | `04:33-37` | ERC-7201 member counts: `FundState` `25` (+23), `FlowState` `35` (+22). | All 4 member counts are wrong: `FundState` is **`32 → 60 (+28)`**; `FlowState` is **`51 → 82 (+31)`**. (Only the slot/byte totals are accurate.) | Incorrect storage-upgrade verification table. |
| 4 | `04:18` | Cites `DEFAULT_EPOCH_LENGTH = 24h` and `DEFAULT_MIN_HOLD = 1h` as Solidity constants; omits Step 3f quote change. | Neither constant exists in Solidity. Default epoch is **`6 hours`** (`contracts/FlowTypes.sol:127`, `deploy-4.env:62`), and the hold constant is **`MIN_HOLD = 1 hours`** (`contracts/FlowTypes.sol:33`). Also misses that Step 3f quotes removed worst-case price (`E31`). | Misstates core protocol timing parameters by 4× (`24h` vs `6h`). |
| 5 | `00:27`; `02:64` | Claims full-fund `RobotMoneyFund.emergencyUnwind()` uses `BasketSwaps.unwindAll` (`EmergencyFloorUnavailable`) and claims One-Vault proposal `§4.5`/`§5.11.4` forbids oracle-less swaps. | `RobotMoneyFund.emergencyUnwind()` calls **`FundFlowsLib._emergencyUnwind`** (`contracts/lib/FundFlowsLib.sol:545-604`, which skips on failure), **not** `BasketSwaps.unwindAll`. One-Vault proposal `§4.5`/`§5.11.4` (`lines 345-347, 1365-1368`) does **not** forbid oracle-less swaps (that rule belonged to legacy `BasketSwaps.sol`). | Confuses legacy `BasketVault` with One-Vault; creates direct contradiction between Ch. 00 and Ch. 02. |
| 6 | `01:483` (`AGY-09`) | Claims `Rebalancer.step()` and lending-to-lending `executeStep` **never** hit `FundAdapterGuard.vet()`. | False: both call `portfolioValues()` / `portfolio()` → `assetValue()` → `vet()` for every basket asset with **`bal > 0`**. The `StepFeedLib` vetting gap is strictly narrower: it applies only when **`bal == 0`**. | Overstates `AGY-09` reachability and mischaracterizes `Rebalancer.step()` call graph. |
| 7 | `02:246` (`AGY-05`) | Claims `Rebalancer` burns step budget trying to over-allocate healthy assets above `endBps`. | False: `RB-7` (`StepExceedsPath`) prevents over-allocation above `endBps`; `Rebalancer` actually **stalls** with `SkipReason.NothingToTrade`. Additionally, the post-delist non-convergence bound is tighter: $w > n \cdot \text{toleranceBps}$ (once delisted asset is gone, `n` active assets remain) rather than only $(n+1)\cdot\text{toleranceBps}$. | Misstates runtime failure mode (stall vs budget burn). |
| 8 | `02:273, 315, 327` (`AGY-06`) | Attributes `A10` and `A2` profits to `MatchSkipped` (match-band skips). | `docs/technical/one-vault-rebalancer-proposal.md:2345` explicitly shows `A10` and `A2` numbers are **unchanged from Step 3e (pre-match)** — they are not caused by `MatchSkipped`. | Misdiagnoses root cause of Gate G8 finding. |
| 9 | `02:370` (`AGY-07`) | Claims there is "zero recovery path" for deactivated basket assets. | Overstated: `_rejectDuplicate` (`contracts/lib/FundAdminLib.sol:128-142`) permits **re-listing** a healthy deactivated token into a new slot (recovering custody at the cost of burning 1 of the 12 `MAX_FUND_ASSETS` slots). Stranding is permanent only once slots are exhausted or the token cannot be re-listed (e.g., dead pool/feed). | Overstates severity/unrecoverability without noting the slot-burning workaround. |
| 10 | `02:412` (`AGY-13`) | Implies `addAsset` can admit arbitrary fake pools without token/fee verification. | Overstated: `BasketAssetConfigGuard.requirePoolUsable` and `requireExecutionPoolMatchesTwap` already validate `token0`, `token1`, and `fee`. The actual gap is narrower: the **`poolFee == 0` sentinel bypass** and **non-canonical V3 fork pools** that pass `token0`/`token1`/`fee` checks without matching `IUniswapV3Factory.getPool`. | Overstates scope of `AGY-13`. |
| 11 | `03:13, 65, 71` (`AGY-10`) | Treats `maxDepositMinHold` inflation as affecting match-only settlements and cites Deploy 4 `D4-11` (`v0.8.0`) as an example. | Also affects **combined match + net-deposit settlements** (`contracts/lib/FlowSettleLib.sol:706`). The Deploy 4 `D4-11` example is anachronistic (`D4-11` predates `v0.9.0` One-Vault). | Understates trigger paths while using an invalid historical citation. |
| 12 | `03:142, 144` (`AGY-12`) | Claims empty `activeDepBuckets` arise from wind-down `delete` or partial consumption; relies on `TimedSimBase.sol:362` comment. | Empty buckets arise from **cancellation** or **full consumption** (not wind-down `delete` or partial consumption). The comment at `TimedSimBase.sol:362` is stale relative to `contracts/lib/FlowMatchLib.sol:95`. | Incorrect trigger analysis in `AGY-12`. |
| 13 | `03:164, 175, 187` (`AGY-14`) | Claims `FlowSettleLib.settle` uses `try this.settle*Side`; cites `_burn` at `RobotMoneyFund.sol:326,375`; misstates gas-floor/63-64ths details; omits inherited functions in matrix. | `FlowSettleLib.settle` uses inline assembly **`call(budget, address(), ...)`** (`FlowSettleLib.sol:468-476`), not `try/catch`; `_burn` is at **`RobotMoneyFund.sol:378`** (not `326,375`); `STEP_GAS_FLOOR = 6_000_000` (`Rebalancer.sol:107,298`) and check is `gasleft() <= gasBefore / 63` (`Rebalancer.sol:317`); reentrancy matrix omits inherited ERC-20 / AccessControl / UUPS functions and `KeeperAccount` admin mutators. | Undercuts "exhaustive verification" claim in `AGY-14`. |
| 14 | `00:22` | Claims a compromised `KeeperAccount` owner "can add itself". | Calling `addOwner(msg.sender)` reverts with **`InvalidAccount()`** (already an owner). The attacker adds an attacker-controlled address, not itself. | Minor factual error in Executive Summary. |
| 15 | `01:100` | Cites `lib/openzeppelin-contracts/...` directly. | That submodule path is **uninitialized** in this checkout; citations should reference the vendored/installed OpenZeppelin path actually compiled by `foundry.toml`. | Broken local file link / unverifiable citation. |
| 16 | `04:21` | Cites `FundAdminLib.sol#L144-L160` as basket asset checks. | `L144-L160` is **`_checkLending`**; `_checkBasket` is at **`L169-L197`**. | Wrong line citation. |
| 17 | `04:17, 19` | Cites `docs/prd.md L512-545` for all 4 vaults and `docs/prd.md §12 L710-712`. | `L512-545` covers only 2 of 4 vaults (all 4 span **`L512-715`**); `§12` is at **`L759-760`**. | Wrong PRD line citations. |
| 18 | `04:64`; `03:82` | Cites `docs/audits.md#L129-L162` and `FlowSettleLib.sol#L483-L505`. | Should be **`audits.md#L129-L161`** (matching `00:65`) and **`FlowSettleLib.sol#L480-L502`** (matching `00:61`). | Cross-chapter line citation drift. |

---

## 3. Completeness Audit — High-Impact Missed Findings & Scope Gaps

### 3.1 Verified Missed Findings (`MISSED-01` through `MISSED-09`)

The review missed **1 Critical** and **2–3 High** smart-contract vulnerabilities, **2 Medium** contract liveness defects, **3 production-breaking off-chain keeper bugs**, and major prior-audit / CI coverage blind spots.

#### `MISSED-01` [CRITICAL] — Permanent `FlowQueue.settle()` & `withdrawCredit()` Gas DoS via 1-Wei Whole-Balance `requestRedeem` Spam
- **Code Locations:**
  - `contracts/lib/FlowClaimLib.sol:80-98, 186`
  - `contracts/lib/FlowMatchLib.sol:174-209, 592-652, 896-913`
  - `contracts/lib/FlowSettleLib.sol:217-219`
- **Root Cause & Exploit Mechanism:**
  1. **Zero-cost dust bypass of `minRequestUsdc`:** In `FlowClaimLib.requestRedeem`, the minimum request size (`minRequestUsdc`) is bypassed whenever `shares == fund.balanceOf(msg.sender)` (the "whole-balance" escape hatch). An attacker holding `1 wei` of shares per Sybil/helper address (or transferring `1 wei` across fresh addresses) can enqueue arbitrary numbers of `1-wei` redeem requests into the same epoch for `< $1` in Base L2 gas.
  2. **Unvalidated `owner` + `O(N²)` unbounded `enrollEpochs`:** `requestRedeem` accepts an unvalidated `owner` parameter, and `FlowMatchLib.enrollEpochs` (invoked unconditionally during `FlowSettleLib.settle()` at `:217-219`) has **no per-epoch pagination cap** and calls `syncOwnerRedeems` inside the enrollment loop. Enrolling $N$ 1-wei redeem entries triggers $O(N^2)$ storage/loop work, exceeding the Base block gas limit and **permanently bricking `FlowQueue.settle()` for the entire vault** — no deposits or redemptions can ever settle again without an emergency contract upgrade or `shutdown()`.
  3. **Global `withdrawCredit()` brick:** `withdrawCredit()` executes unbounded `finalizeEndedNotices` (`FlowMatchLib.sol:592-652`), allowing accumulated ended notice entries to push `withdrawCredit()` past block gas limits, freezing already-settled USDC credit withdrawals globally.
- **Why Missing This Is Severe:** This is a **permissionless, <$1, permanent protocol-wide liveness DoS** — strictly more severe than any finding reported in the review (which reported `0 Critical`).

#### `MISSED-02` [HIGH] — Multiplicative `totalScaled` Inflation & `DELIST_ACC_SCALE` / `LENDING_ACC_SCALE` Precision Collapse Confiscates 100% of Claim Proceeds
- **Code Locations:**
  - `contracts/lib/FundStorage.sol:182-185`
  - `contracts/lib/FundDelistLib.sol:161-183, 289-297, 344-354`
  - `contracts/lib/FundPositionLib.sol:284-287, 537-554, 608-619`
- **Root Cause & Exploit/Failure Mechanism:**
  - Both delisting claims (`DELIST_ACC_SCALE = 1e30` or `1e30`-scaled accumulator) and lending position claims (`LENDING_ACC_SCALE`) track pro-rata shares via `totalScaled` scaled up by `1e12` / token units so that even **`1 WETH` (`1e18` wei) initializes `delistTotalScaled = 1e30 == DELIST_ACC_SCALE`**.
  - When partial sales (`executeDelistStep` / lending harvests) reduce `delistClaimedTokens` / `positionClaimTotal` **without proportionally shrinking `delistTotalScaled` / `positionTotalScaled`**, subsequent redemptions or claims during the same sale compute:
    $$\Delta \text{scaled} = \text{tokens} \times \frac{\text{totalScaled}}{\text{remainingClaimedTokens}}$$
    Because the denominator shrinks with each partial sale while `totalScaled` stays fixed, `totalScaled` **inflates multiplicatively** across interleaved partial sales and redemptions.
  - Once `totalScaled` exceeds `usdcProceeds * ACC_SCALE`, integer division **`(usdc * ACC_SCALE) / totalScaled` truncates to `0`**.
  - **Impact:**
    - On **delisting claims (`FundDelistLib.sol:344-354`)**, `0` is credited to the accumulator and the unallocated USDC pot is **swept back into the fund**, **confiscating 100% of delisting claim proceeds** from exiting redeemers.
    - On **lending position claims (`FundPositionLib.sol:608-619`)**, the lending claim USDC pot is **permanently locked** inside the contract with `0` claimable per user.

#### `MISSED-03` [HIGH] — `shutdown()` → `restore()` Overwrites `ownerRedStates.matchCycle` Without Resetting `normBasis`, Creating Permanent Phantom Shares in `FundExclusionLedger`
- **Code Locations:**
  - `contracts/lib/FundAdminLib.sol:530-544`
  - `contracts/lib/FlowMatchLib.sol:298-300, 950-962, 1003-1023, 1058-1066`
- **Root Cause & Impact:**
  1. During a `shutdown()` → `restore()` cycle, `ownerRedStates[user].matchCycle` is overwritten/synced to the post-restore cycle **without zeroing `normBasis`** for redeemers who had queued redemptions before `shutdown()` (and whose shares were returned to their wallet on shutdown).
  2. When a subsequent lending exclusion occurs, `FundExclusionLedger` computes a holder's claim entitlement using wallet balance **plus** `FlowQueue.queuedSharesOfAt(...)`, which reads the stale non-zero `normBasis` under the updated `matchCycle`.
  3. **Impact:** Pre-shutdown redeemers are **double-counted** (real wallet shares + permanent phantom queued shares), enabling them to **steal recovery USDC** from legitimate shareholders during any future lending exclusion recovery.
  4. **Secondary `restore()` bypass:** `FundAdminLib.restore(newTvlCap)` (`:530-544`) updates the TVL cap without enforcing `requirePoolShare` (`§4.5` rule 3), allowing a restored vault to violate pool-depth TVL bounds immediately upon resumption.

#### `MISSED-04` [HIGH / MEDIUM] — Blacklisted `feeRecipient` on USDC Bricks ALL Settlements, Claims, AND Emergency `redeemInKind()` Exits
- **Code Locations:**
  - `contracts/lib/FlowMatchLib.sol:467`
  - `contracts/lib/FlowSettleLib.sol:596`
  - `contracts/lib/FundFlowsLib.sol:221, 371, 722, 761`
  - `contracts/lib/FundPositionLib.sol:757`
  - `contracts/FundExclusionLedger.sol:194`
- **Root Cause & Impact:**
  - Every fee-bearing path — `FlowQueue.settle()`, `FlowMatchLib` fee payouts, `FundPositionLib` lending claims, and crucially **emergency `redeemInKind()`** (`FundFlowsLib.sol:371`) — pushes USDC directly via `safeTransfer(feeRecipient, fee)`.
  - Unlike `_inKindBasket` (`FundFlowsLib.sol:425-427`), which defensively uses `_tryTransfer` + `_defer` so a single blacklisted/reverting basket token cannot block a user's exit, the USDC fee push has **no `_tryTransfer`/deferral fallback**.
  - If Circle blacklists `feeRecipient` (or `feeRecipient` is a contract that reverts), **all settlements, claims, and even emergency `shutdown()` → `redeemInKind()` exits revert unconditionally** until governance survives a `48h` timelock delay to rotate `feeRecipient` (and if timelock is bricked or delayed during an incident, user exits are trapped).
  - Additionally, `FundExclusionLedger.claim` (`contracts/FundExclusionLedger.sol:194`) transfers strictly to `msg.sender` with no `recipient` redirect parameter, permanently locking exclusion recoveries for blacklisted users or non-receiving contracts.

#### `MISSED-05` [MEDIUM] — `Rebalancer._decide` Fails to Mask `isAssetInSale(i)` Before `StepFeedLib.check`
- **Code Locations:**
  - `contracts/Rebalancer.sol:451-457` vs `contracts/lib/FundStepLib.sol:139-142`
- **Root Cause & Impact:**
  - `FundStepLib._stepFeeds` (`:139-142`) masks out `inSale` assets before running Chainlink/TWAP health checks so delisting an asset with a dead feed does not block healthy-asset rebalancing.
  - However, `Rebalancer._decide` (`:451-457`) passes the raw, unmasked `f.assetConfigs()` directly into `StepFeedLib.check`.
  - **Impact:** Even when governance uses the **intended** `delistAsset(index)` workflow (avoiding `AGY-01` and `AGY-03`), delisting any asset whose feed has died **bricks `Rebalancer.step()` with `SkipReason.FeedCheck` for the entire multi-day delisting duration**, preventing any rebalancing of healthy portfolio assets. (Notice this directly intersects `AGY-03` and `AGY-05`, yet the review completely missed it.)

#### `MISSED-06` [MEDIUM] — `_considerDeposit` Skips Sub-Minimum Partially-Matched Remainders, Causing Infinite Keeper `settle()` Gas Burn & Delayed Redemption Notices
- **Code Locations:**
  - `contracts/lib/FlowSettleLib.sol:149-153, 405-416`
  - `contracts/lib/FlowMatchLib.sol:121-135, 888-893`
- **Root Cause & Impact:**
  - When a deposit is partially matched so its unfilled remainder falls below `minDepositUsdc` (or the minimum settlement threshold), `_considerDeposit` (`FlowSettleLib.sol:149-153, 405-416`) skips settling the remainder without retiring or draining it from the active pool (`FlowMatchLib.sol:121-135, 888-893`).
  - Because the pool remains non-empty, `checkSettle()` continues reporting work available on every block/poll, causing the keeper to **repeatedly submit no-op `settle()` transactions in an infinite gas-burning loop** and delaying redemption-notice progression until fresh deposits push the pool back above the threshold.

#### `MISSED-07` [MEDIUM / HIGH Ops] — Three Production-Breaking Bugs in Off-Chain Keeper Scripts (`scripts/ops/onevault-*.sh`)
- **Code Locations:**
  - `scripts/ops/onevault-share-delivery-keeper.sh:98, 102, 105-120`
  - `scripts/ops/onevault-keeper.sh:204, 211`
- **Three Concrete Production Bugs:**
  1. **Double `[0]` JSON/string-slicing breaks at claim `#10` (`onevault-share-delivery-keeper.sh:98, 102`):** Extracting index `[0]` twice slices the string representation of the claim ID — so claim ID `"10"` becomes `"1"`, `"11"` becomes `"1"`, etc., **breaking share delivery permanently once the 10th deposit claim is reached**.
  2. **Whole-matched lazy deposit claims are never discovered or delivered (`onevault-share-delivery-keeper.sh:105-120`):** The keeper only scans for net-settled deposit claim events/records and misses deposits fulfilled via whole-match lazy claims, leaving matched depositors without automatic share delivery.
  3. **`SkipReason.Concluded == 7` ignored (`onevault-keeper.sh:204, 211`):** `onevault-keeper.sh` does not handle `SkipReason.Concluded` (enum value `7`), so rebalance plans that have reached tolerance **never get concluded by the keeper**, leaving `PlanLive` active indefinitely (which in turn blocks `deactivateAsset`, compounding `AGY-03` and `AGY-05`).

#### `MISSED-08` [MEDIUM / LOW] — Delisting Lifecycle Edge Cases
- **Code Locations:**
  - `contracts/lib/FundDelistLib.sol:124-129, 202, 275-278`
  - `contracts/lib/FundAdminLib.sol:574-585`
  - `contracts/lib/FundFlowsLib.sol:601`
- **Three Missed Edge Cases:**
  1. **No permissionless exit for `delistClaimedTokens` during `shutdown()`:** If the fund enters `shutdown()` while a delisting sale holds `delistClaimedTokens`, claimants lack a permissionless in-kind exit path for those tokens (`FundAdminLib.sol:574-585`, `FundFlowsLib.sol:601`).
  2. **`saleStartValue == 0` permanently bricks `executeDelistStep`:** If a delisting sale is initiated when the asset's valuation/fallback starts at `0` (`FundDelistLib.sol:124-129, 202`), the per-step budget check reverts permanently with `DelistBudgetExceeded`.
  3. **`inSale` dust deactivation asymmetry:** Dust left below minimum swap thresholds (`FundDelistLib.sol:275-278`) exhibits inconsistent deactivation behavior across `closeDelistSale` vs `deactivateAsset`.

#### `MISSED-09` [MEDIUM / LOW] — Unsynthesized Prior-Audit Findings & CI Coverage Blind Spots
- **CI & Verification Blind Spots:**
  - **All 33 One-Vault contracts are `--skip`ped from `forge coverage`:** `.github/workflows/suite-01-02-forge-tests.yml:536-544` explicitly passes `--skip` patterns excluding all 33 `v0.9.0` One-Vault contracts from coverage measurement — meaning CI reports green coverage with **0% coverage enforcement** on the entire new release.
  - **Unwired `DeployFundTimelock` / `verify/fund.ts` CI checks:** Deployment/handover verification for the One-Vault timelock policy is not enforced as a required CI gate.
- **Unsynthesized Prior-Audit & Upgrade Findings:**
  - **Reproduced TestMachine issues still present in `release-0.9.0`:** TestMachine **#16** (fee-avoidance via split `redeemInKind` rounding), **#17** (same-second recommendation receipts collision/ordering), and **#18** (1-wei token donation blocking asset deactivation) remain live and unmentioned.
  - **Open live finding `RS-1019-14`:** Still open and omitted from the audit-posture ledger in Chapter 04.
  - **`DeployFund.s.sol:143` violates `ADR-0019`:** Deploys **non-proxied** swap adapters directly, contradicting `ADR-0019`'s mandate that fund swap adapters be governed UUPS proxies.
  - **Live upgrade front-run (`LegacyEscrowOpen`) before `P2.81`:** A user can open a legacy escrow right before step `P2.81` of `v0.9.0-onevault-upgrade.yaml`, reverting the scheduled timelock upgrade transaction.
  - **Synthetic-only `UpgradeMigration.t.sol`:** Migration tests do not fork live mainnet/Base state (`v0.8.0` storage layout + live adapters), leaving real-world migration assumptions untested.
  - **`FundStepLib.sol:227` missing `availableLiquidity` clamp:** Rebalance withdrawals from lending venues do not clamp step size to `availableLiquidity`, causing avoidable reverts under high venue utilization.

---

### 3.2 Methodology & Scope Completeness Gaps

1. **Zero Foundry execution (`forge test` / PoCs):** The review is 100% static reading. Not a single finding was backed by a Foundry PoC, and none of the 9 proposed Solidity patches were even syntax-checked with `forge build` (which would have immediately caught `StepFeedLib.check`'s missing `address fund` argument in `AGY-09` and missing `EIP712` inheritance in `AGY-04`).
2. **No `Invariants.t.sol` coverage-gap analysis:** The review never checked which claimed invariants (`INV-1`, `INV-2`, `RB-1`, `RB-7`, Check 10, cycle-factor conservation, delist claim scaling) are actually fuzz-tested in `Invariants.t.sol` vs asserted only by prose.
3. **No gas/complexity modeling:** Static inspection focused on reentrancy and single-call authorization while omitting loop-bound / algorithmic-complexity analysis — directly causing the miss of `MISSED-01` (`O(N²)` `enrollEpochs` and unbounded `finalizeEndedNotices`).
4. **No external-token / blacklist threat model:** Failed to model USDC `blacklist()` / pausing on `feeRecipient`, `FundExclusionLedger` claimants, and lending venues — directly causing the miss of `MISSED-04`.
5. **Off-chain keeper blind spot:** Despite auditing `contracts/script/*.s.sol` and commenting on keeper liveness (`AGY-04`, `D20`/`E34`), the review never inspected `scripts/ops/onevault-*.sh` (`MISSED-07`), missing three bugs that break mainnet operation by claim `#10`.

---

## 4. Coherence & Severity Calibration Audit

### 4.1 Direct Cross-Chapter Contradictions

| # | Contradicting Locations | Statement A | Statement B | Resolution Required |
|---|---|---|---|---|
| 1 | `04:52` vs `01` (`AGY-09`) | Ch. 04 line 52 asserts `FundAdapterGuard.vet` / `ADR-0019` adapter vetting is **complete / verified**. | Ch. 01 `AGY-09` reports `FundAdapterGuard.vet` is **incomplete** (skips `codeHashAllowed` on direct adapters, bypassed in `StepFeedLib` and `FlowCheckLib`). | Update `04:52` to explicitly cross-reference `AGY-09` (with its corrected `bal == 0` / direct-adapter scope) and flag `DeployFund.s.sol:143`. |
| 2 | `00:27` vs `02:63-64` | Ch. 00 line 27 claims full-fund emergency unwind uses `BasketSwaps.unwindAll` (`EmergencyFloorUnavailable`). | Ch. 02 line 63 correctly shows `RobotMoneyFund.emergencyUnwind()` calls `FundFlowsLib._emergencyUnwind` (skip-on-fail), while line 64 erroneously cites `§4.5`/`§5.11.4` against oracle-less swaps. | Align both chapters on `FundFlowsLib._emergencyUnwind` (`FundFlowsLib.sol:545-604`) and clearly distinguish legacy `BasketSwaps.unwindAll`. |
| 3 | `04:53` vs `01:12, 17` | Ch. 04 line 53 cites the Deploy 4 rehearsal **`900s`** (15-minute) upgrade/timelock delay. | Ch. 01 lines 12 & 17 (and `00:22`) state a **`48h`** timelock delay as if it applies uniformly to the current rehearsal topology. | Explicitly separate **rehearsal (`900s` in `deploy-4.env`)** from **production (`48h` `FundTimelockPolicy`)** across Ch. 00, Ch. 01, and Ch. 04. |
| 4 | `00:56` vs `02:323` | Ch. 00 line 56 lists `A6` (`+467.55` USDC) inside the `AGY-06` finding summary as an open Gate G8 `refBandBps` ramp/TWAP extraction failure. | Ch. 02 line 323 treats `A6` differently (separate attack class / mitigation context from `A10`/`A2`). | Reconcile `A6` treatment identically between the Executive Summary table and Chapter 02 body. |
| 5 | `01:19` vs `deploy-4.env:25` | Ch. 01 line 19 models `KeeperAccount` as the active sole `KEEPER_ROLE` holder. | Live rehearsal config `deploy-4.env:25` configures an **EOA keeper** directly rather than `KeeperAccount`. | Clarify that `KeeperAccount` (`AGY-04`) applies to the target production topology (`DeployKeeperAccount.s.sol`), while current Deploy 4 rehearsal uses an EOA. |
| 6 | `04:64` vs `00:65`; `03:82` vs `00:61` | `04:64` cites `audits.md#L129-L162`; `03:82` cites `FlowSettleLib.sol#L483-L505`. | `00:65` cites `audits.md#L129-L161`; `00:61` cites `FlowSettleLib.sol#L480-L502`. | Standardize on the accurate ranges (`audits.md#L129-L161` and `FlowSettleLib.sol#L480-L502`). |

---

### 4.2 Severity Recalibration Table

Integrating the missed findings and correcting severity inflation yields a materially different risk profile (`1 Critical, 5–6 High, 7 Medium` instead of the review's `0 Critical, 3 High, 5 Medium`):

| ID | Original Rating | Recalibrated Rating | Calibration Rationale |
|---|---|---|---|
| **`MISSED-01`** | *Not reported* | **`CRITICAL`** | Permissionless, <$1 Base gas attack permanently bricks `FlowQueue.settle()` (`O(N²)` `enrollEpochs`) and `withdrawCredit()` (unbounded `finalizeEndedNotices`). |
| **`MISSED-02`** | *Not reported* | **`HIGH`** | Multiplicative `totalScaled` inflation causes `usdc * ACC_SCALE / totalScaled == 0` on 18-decimal assets (e.g., WETH), confiscating 100% of delist claim proceeds and permanently locking lending claim pots. |
| **`MISSED-03`** | *Not reported* | **`HIGH`** | `shutdown()` → `restore()` leaves stale `normBasis` under updated `matchCycle`, minting phantom queued shares in `FundExclusionLedger` to steal future exclusion recoveries (+ `restore` TVL-cap bypass). |
| **`AGY-01`** | `HIGH` | **`HIGH`** | Confirmed High: `minOut = 0` on unhealthy feed enables 100% MEV sandwich loss during single-asset emergency unwind. (Patch must be rewritten.) |
| **`AGY-02`** | `HIGH` | **`HIGH` (qualified)** | Retain High due to irreversible total protocol bricking (including `shutdown()`/`redeemInKind()`), **but explicitly qualify** that exploitation requires a **2-of-3 Safe quorum** operational error or compromise (not an unprivileged or single-key exploit). |
| **`AGY-03`** | `HIGH` | **`HIGH`** | Confirmed High: dead-feed unwound asset remains `active = true` while `PlanLive` blocks `deactivateAsset`, bricking NAV/settlement/rebalance. (Expand to early-return branch & lending Check 5.) |
| **`MISSED-04`** | *Not reported* | **`HIGH / MEDIUM`** | External-dependency (Circle USDC blacklist on `feeRecipient`) bricks **every** settlement, claim, and emergency `redeemInKind()` exit with zero fallback; `FundExclusionLedger.claim` lacks recipient redirect. |
| **`AGY-04`** | `MEDIUM` | **`MEDIUM`** | Confirmed Medium (1-of-N owner EOA can hijack `KeeperAccount` and halt `KEEPER_ROLE` for 48h in production topology). Patch must be rewritten. |
| **`AGY-05`** | `MEDIUM` | **`MEDIUM`** | Confirmed Medium: `withinTolerance` mathematically unreachable after delist/unwind (`w > n * toleranceBps`). Fix failure mode (`NothingToTrade` stall) and rewrite patch. |
| **`AGY-06`** | `MEDIUM` | **`MEDIUM`** | Confirmed Medium open Gate G8 risk (`refBandBps = 90` bps), but remove backwards `LEG_PRICE_FEED_ONLY` / rejected `navFeed` fixes and stop blaming `MatchSkipped`. |
| **`AGY-07`** | `MEDIUM` | **`MEDIUM`** | Confirmed Medium (`INV-2` residual custody + non-reusable 12 slots), noting re-listing workaround exists until slots fill; rewrite dangerous `reabsorbRemovedAsset` patch. |
| **`MISSED-05`** | *Not reported* | **`MEDIUM`** | `Rebalancer._decide` omits `isAssetInSale(i)` mask before `StepFeedLib.check`, bricking rebalancing for the entire delisting period of any dead-feed asset. |
| **`MISSED-06`** | *Not reported* | **`MEDIUM`** | `_considerDeposit` skips sub-minimum partially-matched remainders, causing infinite keeper `settle()` gas burn and delayed redemption notices. |
| **`MISSED-07`** | *Not reported* | **`MEDIUM / HIGH (Ops)`** | Three production-breaking keeper script bugs (`[0]` string slice breaking at claim `#10`, missed whole-matched lazy deposit claims, ignored `SkipReason.Concluded == 7`). |
| **`AGY-08`** | `MEDIUM` | **`LOW` (Downgrade)** | **Over-rated as Medium:** Requires deliberate/compromised governance renunciation of self-administered roles (`TARGET_SETTER_ROLE`, one-shot bindings). Proposed `rebind*Role` violates `RB-1`/`E1`. Appropriate severity is **Low** (operational guard rail for `TARGET_SETTER_ROLE` only). |
| **`MISSED-08`** | *Not reported* | **`MEDIUM / LOW`** | Delisting edge cases (`shutdown()` with `delistClaimedTokens`, `saleStartValue == 0` `DelistBudgetExceeded`, `inSale` dust asymmetry). |
| **`MISSED-09`** | *Not reported* | **`MEDIUM / LOW`** | CI `--skip`ping all 33 One-Vault contracts from coverage, unwired `DeployFundTimelock`/`verify/fund.ts`, reproduced TestMachine `#16`/`#17`/`#18`, open `RS-1019-14`, `DeployFund.s.sol:143` non-proxied adapters, `LegacyEscrowOpen` upgrade front-run, `FundStepLib.sol:227` liquidity clamp. |
| **`AGY-09`–`AGY-13`** | `LOW` | **`LOW`** | Confirmed Low findings; narrow `AGY-09` (`bal == 0`), `AGY-13` (`poolFee == 0` / V3 forks), expand `AGY-10` (combined settlements), fix `AGY-12` trigger analysis, and rewrite `AGY-09`/`AGY-11` patches. |
| **`AGY-14`, `AGY-15`** | `INFO` | **`INFO`** | Retain Info, but fix `AGY-14`'s constants (`MATCH_SCALE`/`ACC_SCALE`), adapter mechanics, assembly call citation, and expand `AGY-15` with `MISSED-09` CI/prior-audit items. |

---

## 5. Prioritized Actionable Improvement Plan

### P0 — Fix Broken Remediation Code & Add Critical/High Omissions (Blocking Publication)

- [ ] **Add `MISSED-01` [CRITICAL]:** Document the 1-wei whole-balance `requestRedeem` → `O(N²)` `enrollEpochs` / unbounded `finalizeEndedNotices` permanent DoS on `FlowQueue.settle()` and `withdrawCredit()`, with bounded pagination / epoch caps and dust-griefing remediation.
- [ ] **Add `MISSED-02` [HIGH]:** Document multiplicative `totalScaled` inflation and `DELIST_ACC_SCALE` / `LENDING_ACC_SCALE` precision collapse confiscating 100% of delisting proceeds and locking lending pots on 18-decimal assets (WETH).
- [ ] **Add `MISSED-03` [HIGH]:** Document `shutdown()` → `restore()` `ownerRedStates.matchCycle` overwrite without clearing `normBasis` (phantom shares stealing `FundExclusionLedger` recoveries) plus `restore(newTvlCap)` bypassing `requirePoolShare`.
- [ ] **Add `MISSED-04` [HIGH/MEDIUM]:** Document USDC-blacklisted `feeRecipient` DoS bricking all settlements, claims, and emergency `redeemInKind()` exits, plus missing recipient redirect in `FundExclusionLedger.claim`.
- [ ] **Add `MISSED-05` [MEDIUM]:** Document `Rebalancer._decide` failing to mask `isAssetInSale(i)` before `StepFeedLib.check` (bricking rebalancing during dead-feed delistings).
- [ ] **Add `MISSED-06` [MEDIUM]:** Document `_considerDeposit` skipping sub-minimum partially-matched remainders (infinite keeper `settle()` loop + delayed notices).
- [ ] **Rewrite `AGY-01` patch:** Remove `max(stalePrice, minUsdcOut)` when `feedOk == false` (require governed `minUsdcOut > 0` directly); add governed override for stale-within-heartbeat depegs when `feedOk == true`.
- [ ] **Rewrite `AGY-04` patch:** Enforce `threshold >= 1` (`>= 2` for multi-owner), enforce `_owners.length - 1 >= threshold` in `removeOwner`, use `SignatureChecker` (EIP-1271), restrict `execOwnerCall` to an explicit selector allowlist, and initialize `EIP712("KeeperAccount", "1")`.
- [ ] **Rewrite `AGY-05` patch:** Do not treat `inSale` residual value as an `IDLE_INDEX` buy deficit; update `PlanMath.pathTargetsBps` (`:223`) and `Rebalancer._legPathBps` (`:399,402`); correct `NothingToTrade` stall behavior and `w > n * toleranceBps` bound.
- [ ] **Rewrite `AGY-06` remediation:** Delete `LEG_PRICE_FEED_ONLY` (strictly looser, already rejected in `Attacks.t.sol` / `OwnerDefaults.t.sol`) and `navFeed` matching (rejected in `one-vault-rebalancer-proposal.md:3218-3222`); remove false `MatchSkipped` attribution.
- [ ] **Rewrite `AGY-07` patch:** Guard `reabsorbRemovedAsset` across **all** slots sharing `a.token` (or implement in-place inactive-slot reuse first) so an old slot cannot liquidate a re-listed active slot; document the existing slot-burning re-list workaround.
- [ ] **Rewrite `AGY-08` & downgrade to `LOW`:** Delete `rebindFlowRole`/`rebindRebalanceRoles` (violates `RB-1`/`E1` at `RobotMoneyFund.sol:53-54`); scope fix to a last-holder floor on `TARGET_SETTER_ROLE`.
- [ ] **Rewrite `AGY-09` patch:** Fix `setAdapterProxyCodeHash(proxyHash, false)` revocation; keep read/exit paths (`totalAssets`, `emergencyUnwind`, `executeDelistStep`) free of `codeHashAllowed` DoS while tightening write paths; fix `StepFeedLib.check` signature & `try` error folding; narrow claim to `bal == 0`; account for `RobotMoneyFund`'s ~382-byte EIP-170 headroom.
- [ ] **Rewrite `AGY-11` patch:** Remove `fund.assetValue(i)` seeding in `migrateV090` (TWAP-vs-feed mismatch, pre-ADR-0019 adapters, timestamp skew); handle `lastAssetPerShare[i] == 0` cleanly in Check 6 or enforce one-settlement pre-delist gate.
- [ ] **Rewrite `AGY-03` patch:** Cover the `totalTok == 0 && !inSaleNow` early return (`FundFlowsLib.sol:685-688`), drop unnecessary `deferredTotal[index] == 0` guard, add lending-asset Check 5 (`_lendRates`) deadlock, and remove irrelevant `lastStateStopEndedAt` prose.

### P1 — Resolve Cross-Chapter Contradictions & Factual/Constant Errors

- [ ] **Resolve all 4 direct cross-chapter contradictions:** Align `04:52` with `AGY-09`; align `00:27` and `02:63-64` on `FundFlowsLib._emergencyUnwind` vs legacy `BasketSwaps.unwindAll`; separate rehearsal `900s` (`04:53`) from production `48h` (`01:12,17`); reconcile `A6` between `00:56` and `02:323`; note `deploy-4.env:25` EOA keeper vs `KeeperAccount` (`01:19`).
- [ ] **Fix accounting & protocol constants:** `MATCH_SCALE = 1e30` (`FlowMatchLib.sol:40`), `ACC_SCALE = 1e36` (`FlowMatchLib.sol:42`); default epoch = `6 hours` (`FlowTypes.sol:127`, `deploy-4.env:62`) and `MIN_HOLD = 1 hours` (`FlowTypes.sol:33`) + Step 3f `E31` quote update; ERC-7201 member counts (`FundState` `32 → 60 (+28)`, `FlowState` `51 → 82 (+31)`).
- [ ] **Fix adapter & call-graph inaccuracies:** Correct `CompoundV3Adapter` (`safeIncreaseAllowance` + conditional `_clearAllowance`), delete nonexistent `withdrawAll` claim, correct `MorphoAdapter.withdraw` (no allowances), audit permissionless `sweepForeignToken` and `harvestRewards`; fix `FlowSettleLib.settle` assembly `call(budget, address(), ...)` (`:468-476`), `_burn` (`RobotMoneyFund.sol:378`), `STEP_GAS_FLOOR = 6_000_000` (`Rebalancer.sol:107,298`) and `gasleft() <= gasBefore / 63` (`:317`), and add inherited ERC-20/AccessControl/UUPS + `KeeperAccount` mutators to `AGY-14`.
- [ ] **Fix secondary finding inaccuracies & line citations:** Update `AGY-10` (combined match + net-deposit settlements at `FlowSettleLib.sol:706`; remove anachronistic `D4-11` example); update `AGY-12` (cancellation/full-consumption triggers; stale `TimedSimBase.sol:362` comment); narrow `AGY-13` (`poolFee == 0` sentinel + non-canonical V3 forks); fix `00:22` ("add itself" reverts `InvalidAccount()`); fix `01:100` uninitialized submodule link; correct line citations (`FundAdminLib.sol#L169-L197`, `prd.md#L512-L715`, `prd.md#L759-L760`, `audits.md#L129-L161`, `FlowSettleLib.sol#L480-L502`).
- [ ] **Qualify `AGY-02` threat model:** Explicitly frame `AGY-02` as a 2-of-3 Safe operational-brick risk rather than an unprivileged/single-key exploit.

### P2 — Expand Scope & Verification Rigor

- [ ] **Add `MISSED-07` (Off-Chain Keeper Ops):** Include all 3 production-breaking bugs in `scripts/ops/onevault-share-delivery-keeper.sh` (`[0]` string slice breaking at claim `#10`, missed whole-matched lazy deposit claims) and `scripts/ops/onevault-keeper.sh` (`SkipReason.Concluded == 7` ignored).
- [ ] **Add `MISSED-08` (Delisting Lifecycle Edge Cases):** Document `shutdown()` + `delistClaimedTokens` exit gap, `saleStartValue == 0` `DelistBudgetExceeded` brick, and `inSale` dust deactivation asymmetry.
- [ ] **Add `MISSED-09` (Prior-Audit & CI Coverage Synthesis):** Document `.github/workflows/suite-01-02-forge-tests.yml:536-544` `--skip`ping all 33 One-Vault contracts from coverage, unwired `DeployFundTimelock`/`verify/fund.ts` CI check, live TestMachine `#16`/`#17`/`#18`, open `RS-1019-14`, `DeployFund.s.sol:143` non-proxied swap adapters vs `ADR-0019`, `LegacyEscrowOpen` upgrade front-run before `P2.81`, synthetic-only `UpgradeMigration.t.sol`, and `FundStepLib.sol:227` missing `availableLiquidity` clamp.
- [ ] **Execute Foundry PoCs & compile-verify every patch:** Add runnable Foundry PoC tests for all Critical/High findings (`MISSED-01`–`MISSED-04`, `AGY-01`–`AGY-03`) and verify every proposed Solidity patch compiles, passes existing tests, and respects EIP-170 contract-size limits (`forge build --sizes`).
- [ ] **Add Threat-Model & Invariant-Coverage Matrices:** Add dedicated subsections for (1) algorithmic/gas complexity bounds across all queue/notice/claim loops, (2) external-token blacklist/pause resilience across all transfer sinks, and (3) `Invariants.t.sol` coverage mapping against `smart-contract-invariants.md`.

---

*Summary: The `release-0.9.0` safety review uncovers genuine governance and economic defects with zero hallucinated findings, but it is not publication-ready because nine of its remediation patches introduce severe bugs or invariant regressions, it misses a Critical <$1 permanent settlement DoS plus multiple High accounting/custody and keeper bugs, and its chapters contain four direct contradictions alongside ~18 factual errors.*
