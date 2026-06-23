# Smart-Contract Security Review — 2026-06-12

Date: 2026-06-12
Branch: `dev`
Commit reviewed: `98795065`
Revalidated against: `345a55ca` (latest `origin/dev` as of 2026-06-12; no relevant Solidity behavior changed)
Scope: all Solidity under `contracts/` — gateway (`RobotMoneyGateway`, `AccessRoles`, `MockVault`), vaults (`RobotMoneyVault`, `BasketVault`, `ProtocolAssetVault`, `AgentTokenVault`, `RwaVault`), router/governance (`PortfolioRouter`, `RouterGovernance`, `RmToken`), registry (`VaultRegistry`, `FeatureFlags`), all seven adapters, and the devnet stubs.
Method: five parallel reviewer agents over logical contract groups, cross-checked against the 2026-06-06 deep-clean report and the 2026-06-09 audit, followed by an orchestrator verification pass that re-read every High-severity claim against the code and git history. All High findings below were independently re-verified line-by-line; severity/dedup judgments on Medium and below were made from the reviewers' quoted code.

---

## Executive summary

**The single most important result of this review is not any one vulnerability — it is audit/remediation drift.** The 2026-06-06 report (`20260606-code-review-internal-claude.md`) states "All actionable findings were fixed in this PR," but the fix commit (`5de13396`, PR #641) only patched `contracts/RobotMoneyVault.sol`. The following fixes that report claims as landed **do not exist on `dev`** and several have no commit anywhere in history:

| Claimed fix (2026-06-06 report) | Actual status on `dev` |
|---|---|
| VAULT-002 — BasketVault split deposits/withdrawals pause | **Never committed** (not on the remediation branch either) — see SR-M18 |
| VAULT-006 — try/catch TWAP fallback in emergencyUnwind | **Never committed** — see SR-H6 |
| ORA-001 / AC-005 — Chronicle zero-price revert | On unmerged branch only (`f211a87f`) — see SR-M8 |
| MEV-001 — swap deadline parameter | On unmerged branch only (`284b3b46`) — see SR-M16 |
| AC-006 — SafeCast for uint128 swap fields | On unmerged branch only (`284b3b46`) — see SR-L10 |
| GOV-001 / AC-002 — MIN_EXECUTION_DELAY floor | On unmerged branch only (`6a5505c2`) — see SR-M4 |
| VaultRegistry asset-matches-`IERC4626.asset()` check | **Never committed** — see SR-L9 |
| #516 `CannotRescueShares` guard | Committed, then **silently reverted** the next day by #517 (rebase clobber) — see SR-L1 |

A remediation branch, `origin/phase/contract-security-remediation` (PRs #748, #751, #756, #757, #763, #782, #785 …), contains useful fixes for roughly a third of the findings below, but it is **not safe to merge unchanged**. Commit `41ce13a3` makes commit/reveal the sole permissionless first-time authorization path while SR-M1 still permits an attacker to overwrite another user's commitment. Commit `75f0b4b6` only partially addresses SR-M3 and does not provide the documented strict sliding-window property. Integrate the branch only with atomic fixes for SR-M1 and SR-M3.

Totals after dedup and revalidation: **4 High, 19 Medium, 14 Low, 10 Informational**, plus 2 process findings.

---

## High

### SR-H1 — Gateway deposit/withdraw paths permanently bricked by a 1-wei vault-share donation
**File:** `contracts/gateway/RobotMoneyGateway.sol:526-528, 561-563, 749-751, 757-759, 884-886, 1073-1077`
**Status:** Open (no fix on any branch). Verified.

Every share-custody invariant compares the gateway's vault-share balance to an **absolute zero**:

```solidity
if (IERC20(address(vaultContract)).balanceOf(address(this)) != 0) {
    revert ShareCustodyInvariantViolated();
}
```

The USDC-side checks are delta-based (`!= balBefore`) and donation-safe; the share-side checks are not. Vault shares (rmUSDC etc.) are freely transferable ERC-20s.

**Exploit:** anyone transfers 1 wei of the pinned vault's shares to the gateway. The pre-call invariant in `deposit` and `_executeVaultDeposit`, and the post-call invariant in `withdraw` and `withdrawFromRouter`, now revert on every call. The gateway has no rescue/sweep function and no admin path to clear the balance — the DoS is permanent short of redeploy. Cost: one dust transfer.

**Fix:** make the share-custody checks delta-based like the USDC checks (snapshot at entry, require post-call balance equals the snapshot), and/or add an admin-gated share sweep.

### SR-H3 — `PortfolioRouter.redeemFor` is a confused deputy: permissionless, caller-chosen `shareHolder` and `assetRecipient`
**File:** `contracts/PortfolioRouter.sol:470-503`
**Status:** Fix on phase branch (`864e4c25`, PR #751), unmerged. Verified open on `dev`.

```solidity
function redeemFor(address shareHolder, address assetRecipient, uint256[] calldata sharesPerLeg)
    external nonReentrant returns (uint256[] memory assetsPerLeg)
{ ...
    uint256 assetsOut = IERC4626(vault).redeem(shares, assetRecipient, shareHolder);
```

No check that `msg.sender` is or is authorized by `shareHolder`. The only gate is the router's ERC-20 allowance from `shareHolder` on the vault share token.

**Exploit:** any address that ever grants the router a standing share-token allowance (a natural integrator/user mistake — "approve the router so it can redeem") can be fully drained by `router.redeemFor(victim, attacker, [allShares])`. The gateway's own flow is safe (it uses `shareHolder = address(this)` and clears allowance in-frame), but the router is a public surface whose safety currently depends on every external party's approval hygiene.

**Fix:** merge the phase-branch fix (restrict to `msg.sender == shareHolder` or an explicit router-level operator approval).

### SR-H4 — A reverting `adapter.totalAssets()` permanently freezes RobotMoneyVault; the last-resort removal path depends on the same failing call
**File:** `contracts/RobotMoneyVault.sol:346-353, 607, 774, 794`
**Status:** Open — **the phase branch keeps the same bug** (its `forceRemoveAdapter` still reads `totalAssets()` before deactivating). Verified.

`totalAssets()` sums `adapters[i].adapter.totalAssets()` over all active adapters, so one reverting adapter view bricks every conversion → `deposit`, `withdraw`, `redeem`, `rebalance` all revert. Adapter views pass through to upgradeable third-party contracts (aToken/Comet proxies, Morpho vault). Critically, every deactivation path also calls the failing view un-guarded:

```solidity
function forceRemoveAdapter(uint256 index) external onlyRole(EMERGENCY_ROLE) {
    ...
    _setDepositsPaused(true);
    uint256 lossAmount = adapters[index].adapter.totalAssets();  // ← reverts too
    adapters[index].active = false;
```

**Failure scenario:** Comet (or an aToken proxy) is upgraded/paused such that `balanceOf` reverts. All user funds — including idle USDC and the healthy adapters — are frozen, and EMERGENCY_ROLE's `forceRemoveAdapter` reverts at the `lossAmount` read. No other deactivation path exists; the freeze is permanent.

**Fix:** set `active = false` first, then compute `lossAmount` inside `try/catch` (default 0). Apply the same guard in `removeAdapter`/`emergencyWithdrawAdapter` balance reads.

### SR-H6 — TWAP `observe()` failure bricks all BasketVault operations including both emergency-unwind paths; `MIN_POOL_CARDINALITY = 2` does not guarantee window coverage
**File:** `contracts/vaults/BasketVault.sol:331-342 (totalAssets), 624-629, 662, 719-722, 781-783, 815-817`
**Status:** Open — this is the VAULT-006 "fixed" claim (try/catch + slot0 fallback) that never landed; no `try/catch` exists in BasketVault on any branch. Verified that both unwind paths call `_twapUsdcValue` unconditionally.

`observe(window)` reverts `"OLD"` whenever the pool's oldest stored observation is younger than the TWAP window (default 1800 s). With cardinality 2 — which passes the `addAsset` gate — the buffer holds only the last two swap-blocks: two dust swaps in nearby blocks make every `observe(1800)` revert. `totalAssets()` then reverts → `deposit`, `mint`, `redeem`, `previewRedeem`, **and both `emergencyUnwind` paths** all revert. There is no oracle-independent escape hatch (`rescueTokens` rejects basket assets).

**Exploit/failure:** an attacker (or organic traders) executes two dust swaps on a low-cardinality pool — the entire vault, including all exits, freezes for free and repeatably until someone provisions cardinality and a full window of trading elapses. For RwaVault, an unkissed/halted Chronicle feed produces the same total freeze.

**Fix:** cardinality alone is insufficient because initialized observations are activity-driven and can be overwritten. At registration, verify that the oldest initialized observation actually covers the configured TWAP window; monitor that coverage at runtime. Independently, give the emergency path an oracle-failure branch that falls back to an admin-set, loss-bounded `emergencyUnwindGuard[token].minUsdcOut` floor so exits remain possible when the oracle is dead.

---

## Medium

### SR-M1 — Commit/reveal authorization grief-able via unconditional commitment overwrite
**File:** `contracts/gateway/RobotMoneyGateway.sol:335-343, 363` · **Status:** Open

`commitAuthorization` unconditionally overwrites any existing commitment for a hash with `msg.sender` as committer. An attacker who sees a depositor's `commitHash` (mempool or on-chain) re-commits it, so the depositor's `revealAuthorization` reverts `CommitmentOwnerMismatch`; repeatable on every retry. Pure griefing (the attacker cannot reveal either), but it fully defeats the anti-front-running mechanism — and once the phase-branch commit `41ce13a3` makes commit/reveal the **sole** permissionless first-time authorization path, this becomes a complete authorization DoS. **Fix:** key commitments by `keccak256(commitHash, msg.sender)` (or a nested mapping) so committers cannot clobber each other. This fix and `41ce13a3` must land atomically; do not merge `41ce13a3` first.

### SR-M2 — Direct `authorizeAgent` is front-runnable to hijack agent ownership and redirect deposited shares
**File:** `contracts/gateway/RobotMoneyGateway.sol:383-406` · **Status:** Fix on phase branch (`41ce13a3` makes commit/reveal the sole first-time path), unmerged

`authorizeAgent` claims ownership first-come-first-served; the deposit path mints shares to the policy's `shareReceiver`, controlled by whoever won the race. An attacker front-runs the depositor's authorization with their own `shareReceiver`; if the depositor's rmpc daemon proceeds to deposit without re-verifying on-chain `agentOwner`/policy, USDC is pulled from the agent and shares are minted to the attacker. Same squat applies after any `revokeAgent`. **Fix:** integrate `41ce13a3` only in the same change that fixes SR-M1; until then document the daemon's on-chain ownership check as a hard precondition.

### SR-M3 — Rolling-window cap allows ~2× burst across anchor reset; documented invariant violated
**File:** `contracts/gateway/RobotMoneyGateway.sol:291-322` · **Status:** Open. Phase commit `75f0b4b6` is partial and does not establish a strict sliding window.

On `dev`, the window is anchored at first use and fully resets after `WINDOW_SECONDS`, so deposits or withdrawals of `M−ε` immediately before reset and `M` immediately after reset put approximately `2M` inside one contiguous `W`-wide interval.

Phase commit `75f0b4b6` changes only withdrawal accounting; deposits remain unchanged. Its withdrawal carry-forward also resets at `2W` from the original anchor without tracking later withdrawals. For example, withdrawals of `0.5M` at `t=0` and `0.5M` at `t=1.5W` are followed by a reset permitting `M` at `t=2W`; the trailing interval `(W, 2W]` then contains `1.5M`. **Fix:** use timestamped sub-window buckets or another genuine sliding-window accumulator for both deposits and withdrawals, with property tests over arbitrary event timing.

### SR-M4 — No `MIN_EXECUTION_DELAY` floor: zero-delay timelock bypass (GOV-001/AC-002 regression vs report)
**File:** `contracts/RouterGovernance.sol:209-227, 248-251` · **Status:** Fix on phase branch (`6a5505c2`), unmerged

Constructor and `setExecutionDelay` accept any value including 0, in which case weights can be applied in the same block voting closes — eliminating the reaction window the delay exists to guarantee. The 2026-06-06 report records this as fixed; the floor exists only on the unmerged branch. **Fix:** merge `6a5505c2`.

### SR-M5 — `vote()` reads live `votingPower`, not a per-proposal snapshot (M-10 re-regression on dev)
**File:** `contracts/RouterGovernance.sol:257-263, 382-395` · **Status:** Fix on phase branch (`5e70248d`/`753b61f8`/`7fc48c99`), unmerged

While a proposal is Active, ADMIN_ROLE can mint fresh voting power to swing the tally; revoking power after a vote does not decrement it. The snapshot mechanism was built (PR #756), reverted by the stale-branch incident (PR #770), restored on the phase branch (PR #782) — but `dev` still has the live-read version. Keep `activeProposal()`'s flat 10-field tuple intact when merging (rmpc ABI constraint). **Fix:** merge the phase branch.

### SR-M6 — PortfolioRouter deposit custody invariant checks absolute zero balance → 1-wei USDC donation DoS
**File:** `contracts/PortfolioRouter.sol:601-603` · **Status:** Open

```solidity
if (usdc.balanceOf(address(this)) != 0) revert UsdcCustodyInvariantViolated();
```

An attacker transfers 1 wei USDC to the router; every subsequent `deposit`/`depositFor` reverts until ADMIN calls `rescueUsdc`, and the attacker re-donates. Same root pattern as SR-H1. **Fix:** delta-based check (snapshot at entry) or refund residual instead of reverting.

### SR-M7 — Stale voted-weight vector + per-leg Active check: one paused/retired/reverting vault bricks all router deposits
**File:** `contracts/PortfolioRouter.sol:233-264, 567-570` · **Status:** Open (design)

Routing is all-or-revert over the voted vector and weights do not auto-sync to registry lifecycle changes; pausing one vault halts every router deposit until a full new proposal cycle. **Fix:** skip non-Active legs with weight redistribution (floor-bounded), or an admin fast-path to drop one leg without a proposal cycle.

### SR-M8 — Chronicle `latestAnswer()` not validated for zero/out-of-range price (ORA-001/AC-005 regression vs report)
**File:** `contracts/adapters/ChronicleOracleAdapter.sol:189-199`; `contracts/vaults/RwaVault.sol` freshness check · **Status:** Fix on phase branch (`f211a87f`), unmerged

A fresh zero push passes the timestamp-only freshness check. Consequences: RWA legs valued at 0 → share-price collapse and mint-for-dust capture; `minUsdcOut = 0` → unwind swaps with no slippage floor; USDC→RWA direction hits division-by-zero panic. **Fix:** merge `f211a87f` (fail closed both directions).

### SR-M9 — `withdraw(maxWithdraw(owner))` reverts whenever `exitFeeBps > 0` (inconsistent fee rounding; VAULT-001 fix incomplete)
**File:** `contracts/RobotMoneyVault.sol:439-449, 474-481` · **Status:** Fix on phase branch (`c5d83d39`, PR #748), unmerged

`_grossToNet` rounds the fee down while `_netToGross` rounds gross up, so the round-trip overshoots by ≥1 share for almost all balances and `_burn` reverts — an ERC-4626 violation. **Fix:** merge `c5d83d39`; add a `previewWithdraw(previewRedeem(s)) ≤ s` property test.

### SR-M10 — `rebalance()` redeploys unbounded idle USDC, bypassing `maxRebalanceBpsPerCall` and silently undoing `emergencyWithdraw()`
**File:** `contracts/RobotMoneyVault.sol:628-663` · **Status:** Open

The throttle bounds only the pull side; the redeploy side routes the entire idle balance and checks neither `depositsPaused` nor `shutdown`. After EMERGENCY pulls 100% of TVL to idle, a scheduled KEEPER `rebalance()` pushes the rescued TVL straight back into the suspect adapter set in one call, defeating the documented "keeper can never move more than 50% of TVL" invariant. **Fix:** revert/no-op when `depositsPaused || shutdown`; cap the redeploy at the per-call budget.

### SR-M11 — One unswappable basket token blocks all redemptions; no forced-removal escape hatch exists
**File:** `contracts/vaults/BasketVault.sol:537-561, 744-749, 833-843` · **Status:** Open

Every redeem swaps a slice of every active asset; a transfer-frozen token or rugged pool reverts the whole basket redemption. Unlike RobotMoneyVault's `forceRemoveAdapter`, BasketVault has no forced deactivation: `removeAsset` requires zero balance, the override unwind still swaps, `rescueTokens` refuses basket tokens. One frozen token in AgentTokenVault's shortlist permanently traps the healthy 90%+ of NAV. **Fix:** add EMERGENCY `forceRemoveAsset(index)` (active=false regardless of balance) and let `rescueTokens` release inactive-entry balances (SR-L8).

### SR-M12 — `addAsset` counts inactive entries toward `maxAssets()`: RwaVault can never replace its single asset
**File:** `contracts/vaults/BasketVault.sol:707`; `contracts/vaults/RwaVault.sol:97` (`_MAX_ASSETS = 1`) · **Status:** Open

`removeAsset` only deactivates (never pops), and the gate is `assets.length >= maxAssets()`. After RwaVault removes its one asset (pool migration, oracle replacement), `addAsset` reverts `MaxAssetsReached` forever — the vault is permanently stuck at zero active assets and must be redeployed. AgentTokenVault burns a shortlist slot per rotation. **Fix:** gate on active count, or swap-and-pop.

### SR-M13 — BasketVault ERC-4626 max-view violations: `maxWithdraw` non-zero though `withdraw()` always reverts; `maxDeposit`/`maxMint` ignore pause/shutdown/caps
**File:** `contracts/vaults/BasketVault.sol:486-488` + missing overrides · **Status:** Partial fix on phase branch (`284b3b46` adds `maxDeposit`/`maxMint`); `maxWithdraw`/`maxRedeem` open everywhere

Since the redeem-only change (`previewWithdraw` reverts `RedeemOnly`), `maxWithdraw` MUST return 0 but returns the OZ default; any standard integrator doing `withdraw(maxWithdraw(user))` reverts. `maxDeposit`/`maxMint` return `uint256.max` while paused/shutdown/capped. **Fix:** merge the phase sweep, plus override `maxWithdraw → 0` and `maxRedeem → 0` when paused/shutdown.

### SR-M14 — `BasketVault.redeem()` returns the preview floor, not the assets actually transferred
**File:** `contracts/vaults/BasketVault.sol:441-447, 494-523` · **Status:** Open

OZ `redeem` returns `previewRedeem(shares)` (worst-case floor) while the overridden `_withdraw` transfers the real swap proceeds — typically higher by up to `maxSlippageBps`. The function's return value disagrees with its own `Withdraw` event; integrators keying off the return value systematically under-account user proceeds (stranding up to ~3–5% per redemption in wrapper contracts). **Fix:** return the realized net (transient slot written by `_withdraw`), or document the return as a floor.

### SR-M15 — Duplicate entries not rejected: same token twice in `addAsset`, same adapter twice in `addAdapter` → NAV double-counting
**File:** `contracts/vaults/BasketVault.sol:699-741`; `contracts/RobotMoneyVault.sol:566-575` · **Status:** Open

Two active entries for one token make `totalAssets()` count the same balance twice (and `_sellProportional` over-sell); inflated NAV lets aware redeemers extract real USDC, leaving the vault insolvent. The duplicate-add is the *natural* venue-migration path because `removeAsset` reverts `AssetStillHeld` while the token is held. Admin-gated, but the failure mode is silent insolvency from a one-line operational mistake. **Fix:** membership mapping + revert on duplicates; explicit `updateAssetVenue` admin path for migrations.

### SR-M16 — Every BasketVault deposit/redeem sandwichable up to `maxSlippageBps`; no user min-out and no real swap deadline (MEV-001 regression vs report)
**File:** `contracts/vaults/BasketVault.sol:393-395, 546-548, 1099-1130`; `contracts/interfaces/IBasketSwapAdapter.sol:25-32`; `AerodromeSwapAdapter.sol:98-99` · **Status:** Deadline fix on phase branch (`284b3b46`); user min-out open

Per-leg floors are `TWAP × (1 − maxSlippageBps)` with no caller-supplied bound, and adapter deadlines are `block.timestamp` (a no-op) or absent — searchers can capture up to `maxSlippageBps` (cap 5%) of every deposit/redeem leg, and stuck transactions execute hours later at the then-current floor. The TWAP-floor model itself is settled (ADR-0007); the gap is the absence of a per-transaction user bound on top of it. **Fix:** merge the deadline sweep; add `redeemWithMinAssets(shares, receiver, owner, minAssetsOut, deadline)` (and optionally a deposit twin); keep operational `maxSlippageBps` well below the ceiling.

### SR-M17 — `emergencyUnwindWithOverride` cannot actually override the TWAP floor; during a fast crash no exit path exists
**File:** `contracts/vaults/BasketVault.sol:814-818, 1072-1090` · **Status:** Open

The override floor is `max(twapFloor, appliedFloor)` — never below the standard path's TWAP floor, making the "explicit high-risk override" strictly redundant whenever TWAP dominates. In a fast depeg the lagging TWAP floor is unfillable at any venue, both unwind paths revert, and EMERGENCY_ROLE can do nothing until the TWAP converges. **Fix:** on the override path use the admin-configured loss-bounded `appliedFloor` alone (it already requires the explicit `EmergencyUnwindOverrideUsed` opt-in), or allow a TWAP-window override on this path only.

### SR-M18 — BasketVault `emergencyUnwind()` fully pauses the vault, blocking user redemptions until ADMIN intervention
**File:** `contracts/vaults/BasketVault.sol:503, 764-766, 773-774` (inherited by ProtocolAssetVault, AgentTokenVault, RwaVault)
**Status:** Open — this is the VAULT-002 "fixed" claim that never landed; **not fixed on the phase branch either**.

`emergencyUnwind()` calls `_pauseIfNotPaused()` and `_withdraw` is gated `whenNotPaused`. After EMERGENCY_ROLE unwinds the basket to idle USDC, every user `redeem()` reverts `EnforcedPause` until ADMIN calls `unpause()`.

This is an incident-response liveness defect, but it requires an authorized emergency action and has an ADMIN recovery path; Medium is more consistent than High absent an operational requirement that ADMIN recovery cannot occur within the incident window. **Fix:** port RobotMoneyVault's split-pause pattern so unwind pauses deposits while leaving redemptions open.

### SR-M19 — AerodromeSwapAdapter mixes classic-router execution with Slipstream CL pricing
**File:** `contracts/adapters/AerodromeSwapAdapter.sol:94-99` (swap) vs `:143-153` (TWAP); `config/dex-pools.json`; `config/agent-token-shortlist.json`
**Status:** Open. Confirmed adapter design defect and production deployment blocker; no currently configured mainnet AgentTokenVault route demonstrates an active GIZA exploit.

The adapter executes through `swapExactTokensForTokens(Route{from,to,stable,factory})`, the classic Aerodrome V2-style router surface, while `twapPrice()` requires a Slipstream CL pool exposing `observe()`. A CL route must use the Slipstream swap router; a classic route cannot use a CL pool as proof that execution and pricing occur on the same venue.

The original GIZA scenario came from `config/dex-pools.json`, but the active `config/agent-token-shortlist.json` instead names BNKR/JUNO/ROBOTMONEY and leaves the mainnet Aerodrome pool/adapter unresolved. This configuration drift lowers confidence in any claim about a currently deployed GIZA route, but it does not remove the adapter incompatibility.

**Failure scenario:** if governance wires a Slipstream pool and CL factory into this adapter, swaps revert because the classic router cannot resolve that CL pair. If it wires a classic factory while retaining a CL pool for pricing, execution and oracle venues diverge, allowing systematic floor mismatch or swap failure. Because BasketVault routes every active leg atomically, one such leg blocks deposits, redemptions, and emergency unwind.

**Fix:** route Slipstream assets through the CL SwapRouter and verify that the priced pool is the executed pool, or restrict this adapter to classic pools and implement a pricing source for that same classic venue. Reconcile `config/dex-pools.json`, `config/agent-token-shortlist.json`, and the deployment script before mainnet deployment.

---

## Low

### SR-L1 — `rescueTokens` self-rescue guard (`CannotRescueShares`, PR #516) silently reverted by PR #517 — confirmed regression
**File:** `contracts/vaults/BasketVault.sol:833-843` · **Status:** Open. Admin can rescue vault shares sent to the vault itself and redeem their underlying value, which would otherwise accrue to remaining holders. Re-apply the guard; record the rebase-clobber in `.agents/agent-warnings.md`.

### SR-L2 — `withdraw` and `withdrawFromRouter` pull shares from different owners (`msg.sender` vs `p.shareReceiver`)
**File:** `contracts/gateway/RobotMoneyGateway.sol:868` vs `:1001, 1058` · **Status:** Open. Deposits mint to `shareReceiver`, but single-vault `withdraw` pulls from the agent — whenever `shareReceiver != agent` one of the two withdrawal paths is unusable. Align both on `p.shareReceiver` or document the required holder per path.

### SR-L3 — `maxWithdraw`/`maxRedeem` non-zero while withdrawals are paused (RobotMoneyVault)
**File:** `contracts/RobotMoneyVault.sol:447-449` · **Status:** Fix on phase branch (`284b3b46`). Return 0 when `withdrawalsPaused`; add the missing `maxRedeem` override.

### SR-L4 — `_pullProportional` dumps the rounding remainder on the last active adapter without a balance cap → `WithdrawShortfall` DoS
**File:** `contracts/RobotMoneyVault.sol:536, 554-558` · **Status:** Fix on phase branch (`284b3b46`). Sweep the remainder across adapters capped at each balance.

### SR-L5 — Irreversible `shutdownVault()` held by the lower-trust EMERGENCY hot key (both vault families)
**File:** `contracts/RobotMoneyVault.sol:801-805`; `contracts/vaults/BasketVault.sol:826-830` · **Status:** Open. Role docs promise the emergency key can only cause reversible DoS; `shutdown` has no reset. Move to ADMIN or make two-step.

### SR-L6 — Revoking the allowlist/codehash of a still-active adapter bricks all deposits and `rebalance()`
**File:** `contracts/RobotMoneyVault.sol:419-426, 585-601` · **Status:** Fix on phase branch (`284b3b46`). Skip ineligible adapters in routing; keep the hard revert in `addAdapter`.

### SR-L7 — `setMaxSlippageBps(0)` (or constructor 0) bricks all swaps — vault-wide DoS of entries and exits from one admin write
**File:** `contracts/vaults/BasketVault.sol:278, 869-873` · **Status:** Fix on phase branch (`284b3b46`, `minSlippageFloorBps`).

### SR-L8 — `rescueTokens` permanently strands balances of inactive (removed) basket assets
**File:** `contracts/vaults/BasketVault.sol:837-839` · **Status:** Fix on phase branch (`284b3b46`). Skip inactive entries in the guard.

### SR-L9 — `VaultRegistry.registerVault` performs no `metadata.asset` vs `IERC4626.asset()` verification — the 2026-06-06 report claims a check that was never committed
**File:** `contracts/VaultRegistry.sol:180-195` · **Status:** Open (no commit in history). A typoed asset propagates to rmpc/dapp/indexer denomination display and user approvals. The router independently re-derives `asset()`, so no direct fund loss. Add `if (IERC4626(vault).asset() != metadata.asset) revert AssetMismatch();`.

### SR-L10 — Unchecked `uint128` truncation of `amountIn`/`minAmountOut` in UniswapV4SwapAdapter (AC-006 regression vs report)
**File:** `contracts/adapters/UniswapV4SwapAdapter.sol:110-111` · **Status:** Fix on phase branch (`284b3b46`, SafeCast). Implausible magnitudes today; silent-wrap trap for high-supply tokens.

### SR-L11 — `MorphoAdapter.withdraw(type(uint256).max)` reverts, violating the documented withdraw-all contract
**File:** `contracts/adapters/MorphoAdapter.sol:62-78`; `contracts/interfaces/IStrategyAdapter.sol:13` · **Status:** Open (latent — current vault never passes max). Translate max to `redeem(balanceOf(...))`.

### SR-L12 — 1-wei donation permanently blocks `removeAsset` (griefing)
**File:** `contracts/vaults/BasketVault.sol:744-749` · **Status:** Open. After an unwind, anyone donates 1 wei of the token; `removeAsset` reverts `AssetStillHeld` forever and the only clearance path is a full-pause emergency unwind (SR-M18). Allow removal below a dust threshold or sweep residual via the swap path.

### SR-L13 — `redeemFor` has no slippage / minimum-assets-out protection
**File:** `contracts/PortfolioRouter.sol:470-503` · **Status:** Open. Add `minAssetsPerLeg[]` or aggregate `minTotalAssets`.

### SR-L14 — `execute()` does not re-validate vault eligibility; a stuck Queued proposal blocks all new proposals (GOV-003, still deferred)
**File:** `contracts/RouterGovernance.sol:329-334, 402-428` · **Status:** Open/deferred. Escapable via ADMIN `cancel()` — liveness nuisance, not deadlock. Re-run the eligibility loop in `execute()` or document the cancel runbook.

---

## Informational

- **SR-I1** — `withdrawFromRouter` paymentId omits the op-kind prefix every other operation uses (`RobotMoneyGateway.sol:1009-1013`). No collision today (different encoding length), but it breaks the stated cross-op namespacing invariant. Add `OP_WITHDRAW_ROUTER`.
- **SR-I2** — `withdrawFromRouter` performs no vault allowlist check when `allowedSourceVaults` is empty, fully trusting the pinned router's `getEffectiveWeights()` (`RobotMoneyGateway.sol:974-985`). Safe while the immutable router is honest; the empty-list default is the most permissive configuration. Consider requiring a non-empty allowlist.
- **SR-I3** — Vault lifecycle status and router eligibility are independent; revoking eligibility is order-blocked by the stale-weights guard during incidents (`VaultRegistry.sol:200-248`). Document the runbook ordering (clear weights → revoke eligibility → set status).
- **SR-I4** — RwaVault's emergency-unwind staleness gate is toggleable by the same role it restricts (`RwaVault.sol:233-260`). Move the setter to ADMIN if the gate is meant to bind the emergency key.
- **SR-I5** — Swap adapters (UniswapV4, Aerodrome, ChronicleOracle) have no token-rescue path; over-delivery/fee-on-transfer residue is locked forever, and `amounts[amounts.length-1]` would panic on an empty router return (`EmptyRouterAmounts` guard is in the unmerged `284b3b46`).
- **SR-I6** — USDC sent directly to Aave/Compound adapters is invisible to `totalAssets()` and unrecoverable (`AaveV3Adapter.sol:78-90`, `CompoundV3Adapter.sol:88-98`); upside: this closes donation NAV-inflation there. PassthroughAdapter takes the opposite trade-off (donation-inflatable `totalAssets`, devnet-only) and its `rescueTokens` lacks the `to != 0` check.
- **SR-I7** — ChronicleOracleAdapter hardcodes 18-dec RWA / 6-dec USDC scaling (`1e12`) with no `decimals()` verification in the constructor (`ChronicleOracleAdapter.sol:99-117, 195, 199`). Assert decimals or derive scale dynamically before reusing the adapter.
- **SR-I8** — `UniswapV3PoolSlot0Stub.slot0()` returns `tick = 0` inconsistent with the configured `sqrtPriceX96` (`UniswapV3PoolSlot0Stub.sol:48-62`). Devnet-only; correctly rejected by `addAsset` gates (no `observe()`); keep out of mainnet deploy scripts.
- **SR-I9** — Mid-swap NAV undercount observable by external integrators: `totalAssets()`/`convertToShares()` are unguarded views readable while a swap is in flight (`BasketVault.sol:331-342, 1099-1130`). Not exploitable against the vault itself; document that hook-bearing tokens/pools must not be added, or gate the views with `_reentrancyGuardEntered()`.
- **SR-I10** — RmToken is sound (fixed supply, no mint/burn authority) and is *not* the governance vote source today; it has no checkpoints, so wiring it directly to live `balanceOf` for the stated future token-holder voting would be flash-loan-votable. Add ERC20Votes-style snapshots before any such wiring.

---

## Process findings

### SR-P1 — Audit reports record fixes that were never committed
The 2026-06-06 report marks VAULT-002, VAULT-006, ORA-001/AC-005, MEV-001, AC-006, GOV-001/AC-002, and the VaultRegistry asset check as fixed; `git log -S` finds no corresponding commits on `dev` for the first two and the registry check (the rest live only on unmerged branches). An audit report that overstates remediation is itself a security liability — downstream reviews (including the 2026-06-09 one) deprioritized "already fixed" areas. Recommend: annotate the 2026-06-06 report with actual landing status, and require that "fixed in this PR" claims be verifiable from the PR's own diff.

### SR-P2 — The remediation phase branch requires a guarded integration, not a direct merge
`origin/phase/contract-security-remediation` (through PR #785) fixes SR-H3, SR-M4, SR-M5, SR-M8, SR-M9, parts of SR-M13/M16, SR-L3, SR-L4, SR-L6, SR-L7, SR-L8, SR-L10, and the SR-I5 guard. Its SR-M2 change (`41ce13a3`) must be combined atomically with an SR-M1 fix, and its claimed SR-M3 fix (`75f0b4b6`) remains incomplete for both withdrawal semantics and the untouched deposit path. Per the stale-branch incident note (PR #770/#782), verify after integration that the voting-power snapshot and all predecessor fixes survive on the merged tip. The branch does **not** fix SR-H1, SR-H4, SR-H6, SR-M18, or SR-M19.

---

## Recommended remediation order

1. **Fix the gateway authorization pair atomically:** close SR-M1 and integrate `41ce13a3` for SR-M2 in one change. Do not make commit/reveal mandatory before commitment ownership is fixed.
2. **Replace the rolling-window implementation:** close SR-M3 for both deposits and withdrawals with a genuine sliding-window design and adversarial timing/property tests; do not treat `75f0b4b6` as sufficient.
3. **Integrate the remaining verified phase-branch fixes:** SR-H3, SR-M4, SR-M5, SR-M8, SR-M9, parts of SR-M13/M16, SR-L3, SR-L4, SR-L6, SR-L7, SR-L8, SR-L10, and SR-I5. Verify predecessor fixes and ABI compatibility on the merged result.
4. **Address the remaining High liveness failures:** SR-H1 (gateway delta custody checks), SR-H4 (deactivate-first adapter removal with guarded reads), and SR-H6 (verified observation-age coverage plus oracle-independent emergency fallback).
5. **Resolve BasketVault incident escape paths:** SR-M11 (`forceRemoveAsset`), SR-M12 (active-count gate), SR-M17 (real override floor), SR-M18 (deposits-only emergency pause), and SR-L8/L12 should share one design review.
6. **Correct Aerodrome routing and configuration drift:** close SR-M19 before any mainnet AgentTokenVault deployment.
7. **Run a donation-DoS sweep:** SR-H1, SR-M6, and SR-L12 share the absolute-balance-check anti-pattern; fix them with a consistent delta-check or controlled-sweep design.
8. Annotate the 2026-06-06 report per SR-P1.
