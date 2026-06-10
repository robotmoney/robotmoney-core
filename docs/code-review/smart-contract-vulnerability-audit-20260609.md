# Smart-Contract Vulnerability Audit — 2026-06-09

**Scope:** All production Solidity in `contracts/` (excluding `test/`, `script/` helpers, and generated docs):
core vault (`RobotMoneyVault`, `RmToken`), router/governance (`PortfolioRouter`, `RouterGovernance`,
`VaultRegistry`, `FeatureFlags`), gateway (`RobotMoneyGateway`, `AccessRoles`, `MockVault`),
adapters (`AaveV3Adapter`, `CompoundV3Adapter`, `MorphoAdapter`, `PassthroughAdapter`,
`AerodromeSwapAdapter`, `UniswapV4SwapAdapter`, `ChronicleOracleAdapter`, `UniswapV3PoolSlot0Stub`),
and specialty vaults (`BasketVault`, `AgentTokenVault`, `ProtocolAssetVault`, `RwaVault`).

**Method:** Five parallel auditor passes (one per subsystem), each reading every file in scope plus the
relevant tests, followed by manual verification of the headline finding.

**Headline:** No unauthenticated fund-drain exists on the in-protocol path. The strongest defenses
(1e18 decimals offset, TWAP-over-spot NAV, USDC custody invariants, `nonReentrant` everywhere,
allowance zeroing, dual adapter/router eligibility checks, codehash + no-delegatecall guards) are in
place and tested. The findings below are one **high** (BasketVault `mint()` slippage bypass), several
**mediums** clustered around ERC-4626 conformance, oracle value-sanity, governance centralization, and
gateway rate-limiting, plus assorted lows/informational.

---

## Severity summary

| # | Title | Severity | File |
|---|-------|----------|------|
| H-1 | `mint()` bypasses slippage-entry haircut, diluting existing holders | **High** | `vaults/BasketVault.sol` |
| M-1 | ChronicleOracleAdapter does not reject zero / degenerate oracle price | Medium | `adapters/ChronicleOracleAdapter.sol` |
| M-2 | `withdraw(maxWithdraw(owner))` reverts with non-zero exit fee (4626 violation) | Medium | `RobotMoneyVault.sol` |
| M-3 | `forceRemoveAdapter` leaves deposits open → share-price crash arbitrage | Medium | `RobotMoneyVault.sol` |
| M-4 | RWA emergency unwind bypasses Chronicle staleness gate | Medium | `vaults/BasketVault.sol` + `vaults/RwaVault.sol` |
| M-5 | `redeemFor` is permissionless on caller-supplied holder/recipient (confused deputy) | Medium | `PortfolioRouter.sol` |
| M-6 | Gateway per-window cap allows ~2× burst across anchor reset | Medium | `gateway/RobotMoneyGateway.sol` |
| M-7 | Gateway commit/reveal front-run protection bypassable via open `authorizeAgent` | Medium | `gateway/RobotMoneyGateway.sol` |
| M-8 | `BasketVault.withdraw(assets)` violates ERC-4626 exactness; `previewWithdraw` mispredicts | Medium | `vaults/BasketVault.sol` |
| M-9 | Governance execution delay has no minimum — timelock neutralizable | Medium | `RouterGovernance.sol` |
| M-10 | Governance fully admin-controlled / bypassable; no vote snapshot | Medium | `RouterGovernance.sol` + `PortfolioRouter.sol` |
| L-1 | `maxWithdraw`/`maxRedeem` non-zero while withdrawals paused | Low | `RobotMoneyVault.sol` |
| L-2 | `_pullProportional` last-adapter sweep / liquidity-clamp withdrawal DoS | Low | `RobotMoneyVault.sol` |
| L-3 | Irreversible `shutdownVault` held by EMERGENCY_ROLE | Low | `RobotMoneyVault.sol` |
| L-4 | Allowlist revocation of active adapter bricks deposits | Low | `RobotMoneyVault.sol` |
| L-5 | Swap deadline hardcoded to `block.timestamp` (no protection) | Low | `adapters/AerodromeSwapAdapter.sol`, `ChronicleOracleAdapter.sol`, `UniswapV4SwapAdapter.sol` |
| L-6 | UniswapV4 adapter truncates `amountIn`/`minAmountOut` via unchecked `uint128` cast | Low | `adapters/UniswapV4SwapAdapter.sol` |
| L-7 | Unchecked router return-array indexing in Aerodrome-routed swaps | Low | `adapters/AerodromeSwapAdapter.sol`, `ChronicleOracleAdapter.sol` |
| L-8 | `redeemFor` has no slippage floor or deadline | Low | `PortfolioRouter.sol` |
| L-9 | `setWeights`/`setDefaultWeights` accept duplicate vault entries | Low | `PortfolioRouter.sol` |
| L-10 | Self-administered ADMIN_ROLE, no floor → brick risk on last-admin loss | Low | `PortfolioRouter.sol`, `RouterGovernance.sol`, `VaultRegistry.sol` |
| L-11 | `rescueUsdc` unconditional admin sweep to arbitrary recipient | Low | `PortfolioRouter.sol` |
| L-12 | `withdrawFromRouter` payment ID omits op-kind prefix | Low | `gateway/RobotMoneyGateway.sol` |
| L-13 | Gateway `withdraw` pulls shares from agent, not `shareReceiver` (inconsistent) | Low | `gateway/RobotMoneyGateway.sol` |
| L-14 | Role separation override ignores `DEFAULT_ADMIN_ROLE` | Low | `gateway/AccessRoles.sol` |
| L-15 | Removed BasketVault assets become unrescuable if tokens reappear | Low | `vaults/BasketVault.sol` |
| L-16 | `BasketVault.maxDeposit`/`maxMint` ignore caps/shutdown/pause | Low | `vaults/BasketVault.sol` |
| L-17 | `setMaxSlippageBps(0)` bricks deposits/withdrawals | Low | `vaults/BasketVault.sol` |
| I-* | Informational items (gas creep, dust fee, stub deployment, etc.) | Info | various |

---

## High

### H-1. `BasketVault.mint()` bypasses the slippage-entry haircut, diluting existing holders
**Severity:** High &nbsp;|&nbsp; **File:** `contracts/vaults/BasketVault.sol` — `previewDeposit` L457-462, `_deposit` L342-357; **no** `previewMint` override (verified by grep — only `previewDeposit` is overridden at L457).

`previewDeposit` is overridden to discount the incoming assets by `maxSlippageBps` before converting to
shares, so a `deposit()` caller pre-pays for the swap slippage the vault will actually incur:

```solidity
uint256 effectiveAssets = assets_.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);
```

`previewMint` is **not** overridden — it falls back to OZ's NAV-proportional `_convertToAssets(shares, Ceil)`
with no slippage discount. OZ `ERC4626.mint()` computes `assets = previewMint(shares)` and then runs the
same lossy `_deposit`/`_routeDeposit` swap path.

**Impact:** For a target share count `S`, the `deposit()` path costs `convertToAssets(S)/(1-slip)` USDC,
but `mint(S)` costs only `convertToAssets(S)` USDC while the vault acquires `~assets*(1-slip)` of basket
value after swapping. The slippage cost (up to `maxSlippageBps`, 3% for rmAGENT, 5% ceiling) is silently
shifted onto existing holders. **Any depositor can route through `mint()` to skip the protective haircut** —
this is a permissionless, repeatable value leak, not an admin-trust issue. The only ERC-4626 conformance
suite targets `RobotMoneyVault`, not `BasketVault`, so this path is untested.

**Fix:** Override `previewMint` symmetrically (gross the assets up by `MAX_BPS/(MAX_BPS-maxSlippageBps)`),
or disable `mint()` (`revert`) and document `deposit()` as the sole entry path.

---

## Medium

### M-1. ChronicleOracleAdapter does not reject a zero / degenerate oracle price
**Severity:** Medium &nbsp;|&nbsp; **File:** `contracts/adapters/ChronicleOracleAdapter.sol` L189-203.

```solidity
uint256 navPrice = ORACLE.latestAnswer(); // WAD: USDC per RWA
if (baseToken == RWA_TOKEN && quoteToken == USDC) {
    quoteAmount = baseAmount.mulDiv(navPrice, WAD * 1e12);   // navPrice==0 → 0, no revert
} else if (baseToken == USDC && quoteToken == RWA_TOKEN) {
    quoteAmount = (baseAmount * 1e12).mulDiv(WAD, navPrice);  // navPrice==0 → div-by-zero revert
}
```

There is no `navPrice != 0` check or sanity bound. Staleness is checked at `RwaVault._checkOracleFreshness`
(RwaVault.sol:211) but **value sanity is checked nowhere**. A zero/near-zero price prices the RWA leg to ~0
in the RWA→USDC direction (no revert), propagating into share pricing and into emergency-unwind `minUsdcOut`
floors, so a redeem or unwind could execute against a 0-valued floor and lose the entire RWA leg's value.
The two directions also fail inconsistently (silent-zero vs revert).

**Fix:** `if (navPrice == 0) revert ...;` plus configurable min/max NAV bounds, so a garbage price fails
closed in both directions.

### M-2. `withdraw(maxWithdraw(owner))` reverts whenever `exitFeeBps > 0`
**Severity:** Medium &nbsp;|&nbsp; **File:** `contracts/RobotMoneyVault.sol` L439-449, L474-481.

`maxWithdraw` is overridden specifically to satisfy "withdraw(maxWithdraw(owner)) MUST NOT revert", but the
net→gross round trip is asymmetric: `_grossToNet` floors the fee while `_netToGross` ceils, so
`_netToGross(_grossToNet(gross)) > gross` whenever the fee product has a remainder (the common case at
100 bps). `previewWithdraw` then ceil-converts `gross+1` to shares — with the 1e18 offset, ~1e18 raw shares
more than the owner holds — and `_burn` reverts with `ERC20InsufficientBalance`. Breaks routers/zappers that
drain via `maxWithdraw`. Not caught because the conformance suite pins `exitFeeBps == 0`.

**Fix:** Compute `maxWithdraw` as the largest `net` with `previewWithdraw(net) ≤ balanceOf(owner)` (round the
recovered gross down, absorb dust in the fee). Add fee-enabled conformance cases.

### M-3. `forceRemoveAdapter` leaves deposits open → share-price crash arbitrage
**Severity:** Medium &nbsp;|&nbsp; **File:** `contracts/RobotMoneyVault.sol` L791-796.

Unlike `emergencyWithdraw*` (which call `_setDepositsPaused(true)`), `forceRemoveAdapter` deactivates an
adapter — instantly dropping its balance from `totalAssets()` — without pausing deposits. The assets aren't
lost (they remain in the adapter and can be re-recognized by re-adding it), so the share price drops
discontinuously and recovers later. An opportunist (including the emergency-key holder via a second account,
contradicting the stated trust model at L33-37) deposits at the depressed price and redeems ~2× after the
adapter is re-added, extracting value from existing holders.

**Fix:** `_setDepositsPaused(true)` inside `forceRemoveAdapter`, and/or require the adapter's allowlist entry
be revoked first so re-recognition is an explicit governance act.

### M-4. RWA emergency unwind bypasses the Chronicle staleness gate
**Severity:** Medium &nbsp;|&nbsp; **File:** `vaults/RwaVault.sol` L199-217; `vaults/BasketVault.sol` `emergencyUnwind` L754-769, `emergencyUnwindWithOverride` L781-804.

RwaVault enforces fail-closed staleness only inside `totalAssets()`. Both emergency-unwind paths compute
their `minUsdcOut` floor via `_twapUsdcValue` → `ChronicleOracleAdapter.twapPrice` directly, never invoking
`totalAssets()`/`_checkOracleFreshness`. During an incident (when the feed is most likely stale and unwind
most likely needed): stale-high price sets the floor too high and DoS's every router leg exactly during a
crash; stale-low sells the basket below true value. The deliberate fail-closed guarantee is silently dropped
on the emergency path.

**Fix:** Have RwaVault override the emergency-unwind entry points (or a shared pre-hook) to call
`_checkOracleFreshness()` first, with an explicit EMERGENCY_ROLE override flag if a stale-price forced exit
is ever intended.

### M-5. `redeemFor` is permissionless on caller-supplied holder/recipient (confused-deputy footgun)
**Severity:** Medium (High if any party holds a standing share approval to the router) &nbsp;|&nbsp; **File:** `contracts/PortfolioRouter.sol` L470-503.

`redeemFor(shareHolder, assetRecipient, sharesPerLeg)` has no access control and calls
`IERC4626(vault).redeem(shares, assetRecipient, shareHolder)` with both addresses attacker-controlled. To the
vault, `msg.sender` is the router, so the router only needs an ERC-20 allowance from `shareHolder` on the
share token. **Any address that approves the router directly — a mode the NatSpec itself contemplates
(L457-462) — can be drained by anyone** via `redeemFor(victim, attacker, shares)`. The in-protocol gateway
path is safe today (gateway is the holder, approval is granted and cleared inside its own `nonReentrant`
frame, and `redeemFor` is itself `nonReentrant`), so this is a latent footgun gated on the documented
"users approve the router" usage.

**Fix:** Require `msg.sender == shareHolder` (or an authorized-caller allowlist), and/or pull shares from
`msg.sender`. Update NatSpec to forbid direct user approvals to the router.

### M-6. Gateway per-window cap allows ~2× burst across the anchor reset
**Severity:** Medium &nbsp;|&nbsp; **File:** `gateway/RobotMoneyGateway.sol` `_accrueRollingDeposit` L310-322, `_accrueRollingWithdraw` L291-303; invariant claims L177-202.

The comments assert the cumulative cap holds over "any contiguous `WINDOW_SECONDS` interval", but the
implementation is a single anchored bucket that resets at `block.timestamp >= anchor + WINDOW_SECONDS`. The
agent controls the anchor (its first activity), so two maxed bursts straddling the boundary are permitted —
e.g. withdraw `cap` at `anchor+WINDOW-1`, then `cap` again at `anchor+WINDOW` after reset → ≈`2 × cap` in a
1-second span. Bounded at 2×, but it doubles the throttle an owner believes they configured (notably for
withdrawal rate-limiting).

**Fix:** Implement a true sliding window (sub-buckets / timestamps), or document the cap honestly as
"≤ cap per anchored window, up to 2× across a reset."

### M-7. Gateway commit/reveal front-run protection bypassable via the open `authorizeAgent`
**Severity:** Medium &nbsp;|&nbsp; **File:** `gateway/RobotMoneyGateway.sol` `revealAuthorization`/`authorizeAgent`/`_authorizeAgentInternal` L346-406.

Commit/reveal exists to defeat mempool front-running of `authorizeAgent` (L147-149), but `authorizeAgent`
remains directly, permissionlessly callable and `revealAuthorization(agent, salt, …)` exposes `agent` in
plaintext calldata. `_authorizeAgentInternal` only checks `agentOwner[agent] != address(0)` (L392), so an
attacker who sees a victim's reveal can front-run `authorizeAgent(agent, attackerPolicy)` and permanently own
that agent address (controlling its `shareReceiver`/`assetRecipient`); the victim's reveal then reverts
`AgentAlreadyOwned` and they cannot `revokeAgent`. At minimum permanent squatting/DoS; at worst fund
redirection if the victim's automation then deposits from that agent.

**Fix:** Make commit/reveal the only authorization path (remove/gate the direct `authorizeAgent`), or bind
the reveal so the agent address is not learnable before ownership finalizes.

### M-8. `BasketVault.withdraw(assets)` violates ERC-4626 exactness; `previewWithdraw` mispredicts
**Severity:** Medium &nbsp;|&nbsp; **File:** `vaults/BasketVault.sol` `previewWithdraw` L465-470, `_withdraw` L475-504 (requested `assets` explicitly ignored, L479).

`_withdraw` discards the requested `assets` and pays actual proportional swap proceeds minus fee via
`_sellProportional`. `previewWithdraw` derives shares from `assets` with no slippage adjustment (unlike
`previewRedeem`). So `withdraw(100 USDC)` burns shares sized for 100 USDC but can deliver materially less
(`maxSlippageBps` + realized impact) with no on-chain signal, and `previewWithdraw` does not predict the
shortfall. Only `redeem()` behaves correctly. Documented (L472-474) but still a spec violation that composing
contracts can be harmed by.

**Fix:** Either revert in `withdraw`/`previewWithdraw` to force redeem-only exits, or make `withdraw` deliver
at least `assets` (selling extra to cover, reverting if it cannot) and reflect slippage in `previewWithdraw`.

### M-9. Governance execution delay has no minimum — the timelock can be neutralized
**Severity:** Medium (centralization) &nbsp;|&nbsp; **File:** `contracts/RouterGovernance.sol` `setExecutionDelay` L247-251, check at L416-418.

`setExecutionDelay` enforces no minimum (unlike `setVotingPeriod`/`setQuorumThreshold`, which have floors).
ADMIN_ROLE can set `executionDelay = 0`, making a queued proposal immediately executable once voting ends —
the reaction window depositors nominally get is not guaranteed.

**Fix:** Introduce and enforce `MIN_EXECUTION_DELAY` in the setter and constructor.

### M-10. Governance is fully admin-controlled and bypassable; no voting-power snapshot
**Severity:** Medium (centralization; partly acknowledged as MVP) &nbsp;|&nbsp; **File:** `RouterGovernance.sol` L257-263, L303-356, L382-395; `PortfolioRouter.sol` L233-235.

`setVotingPower` lets ADMIN_ROLE assign/revoke voting power at any time, and `vote()` reads **live**
`votingPower[msg.sender]` (L388) with no propose-time snapshot, so an admin can grant power and self-vote to
reach the (admin-set, min-1) quorum. `propose` is ADMIN_ROLE-only. Critically, `PortfolioRouter.setWeights`
is gated by the *router's* ADMIN_ROLE, so whoever else holds it (e.g. the deploying Safe) can change weights
directly, bypassing the propose/vote/delay path. The governance module provides no cryptoeconomic constraint.

**Fix:** Snapshot voting power per proposal at `propose()`; enforce/document that only RouterGovernance
(behind Safe→Timelock) holds the router's ADMIN_ROLE; consider removing or delay-gating the direct
`setWeights` admin path.

---

## Low

- **L-1 — `maxWithdraw`/`maxRedeem` non-zero while withdrawals paused** (`RobotMoneyVault.sol` L447-449, L490; `maxRedeem` not overridden). `_withdraw` reverts `WithdrawalsPaused()` but the max-* views still return positive amounts, unlike the deposit side. Add `if (withdrawalsPaused) return 0;` to both.
- **L-2 — `_pullProportional` last-adapter sweep DoS** (`RobotMoneyVault.sol` L514-559). Leftover `remaining` is dumped on the last active adapter without a balance cap; `MorphoAdapter.withdraw` reverts `WithdrawShortfall` if it can't deliver, DoS-ing a withdrawal other adapters could cover. Also the L536 clamp converts a clear error into a later opaque transfer revert. Iterate remaining adapters capping each pull at `min(remaining, balance)`; revert early with a dedicated error if total deliverable < needed.
- **L-3 — Irreversible `shutdownVault` held by EMERGENCY_ROLE** (`RobotMoneyVault.sol` L800-804). No setter resets `shutdown`; a compromised emergency key permanently bricks deposits (withdrawals stay open), exceeding the documented "can only halt, not restart" trust model. Restrict to ADMIN_ROLE (timelocked) or make it two-step.
- **L-4 — Allowlist revocation of active adapter bricks deposits** (`RobotMoneyVault.sol` L419-426, L585-601). `_allocateTo` re-checks `_requireAdapterEligible` on every allocation, so `setAdapterAllowed(adapter,false)` (or a codehash change / selfdestruct) while the adapter is still active reverts every deposit and `rebalance()`. Skip ineligible adapters in `_routeDeposit` (keep the hard revert in `addAdapter`/`adminRebalance`), or auto-deactivate on revocation.
- **L-5 — Swap deadline hardcoded to `block.timestamp`** (`AerodromeSwapAdapter.sol:99`, `ChronicleOracleAdapter.sol:145`, `UniswapV4SwapAdapter.sol:100` has none). A deadline of `block.timestamp` is always satisfied, giving zero withhold protection; `minAmountOut` is the only guard. Plumb an explicit caller-chosen `deadline`.
- **L-6 — UniswapV4 adapter `uint128` truncation** (`UniswapV4SwapAdapter.sol:110-111`). `uint128(amountIn)`/`uint128(minAmountOut)` wrap silently out of range; a wrapped `minAmountOut` weakens the slippage floor. Use `SafeCast.toUint128`.
- **L-7 — Unchecked router return-array indexing** (`AerodromeSwapAdapter.sol:105`, `ChronicleOracleAdapter.sol:150`). `amounts[amounts.length - 1]` underflows on an empty return; `amountOut` is also trusted without a balance-delta cross-check. Assert `amounts.length >= 1` and optionally verify against measured balance.
- **L-8 — `redeemFor` has no slippage floor or deadline** (`PortfolioRouter.sol` L470-503). Unlike `deposit`/`depositFor`, no `minAssetsOut` or `deadline`; for BasketVault legs the per-vault TWAP floor is the only protection. Add `minAssetsPerLeg[]` (or aggregate) and an optional `deadline`.
- **L-9 — Duplicate vault entries accepted** (`PortfolioRouter.sol` L233-264, L279-307). `setWeights`/`setDefaultWeights` don't reject repeated addresses, skewing allocations and letting `length == routerEligibleCount` pass without spanning the distinct set. Track seen addresses / require strictly increasing.
- **L-10 — Self-administered ADMIN_ROLE, brick risk** (`PortfolioRouter.sol` L221-222, `RouterGovernance.sol` L225-226, `VaultRegistry.sol` L169-170). `_setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE)` with a single admin allows lateral escalation and, if the sole admin renounces/loses keys, permanently bricks config. Require ≥2 admins (Safe) or prevent dropping the last admin.
- **L-11 — `rescueUsdc` unconditional sweep** (`PortfolioRouter.sol` L342-348). Admin sweeps the full USDC balance to an arbitrary recipient; blast radius is limited by the custody invariant (router holds ~0) but it's an unconditional sweep. Consider pinning `to` to a fixed treasury.
- **L-12 — `withdrawFromRouter` payment ID lacks op-kind prefix** (`gateway/RobotMoneyGateway.sol` L1009-1013). The three sibling ops prefix `OP_*` to prevent cross-op replay; this one doesn't. Collision infeasible in practice but it breaks the stated namespacing invariant. Add `OP_WITHDRAW_ROUTER`.
- **L-13 — Gateway `withdraw` pulls shares from agent, not `shareReceiver`** (`gateway/RobotMoneyGateway.sol` L868 vs L1057-1058). Deposits mint to `shareReceiver`, but single-vault `withdraw` requires the agent to hold the shares, so it only works when `agent == shareReceiver`. Functional inconsistency (not theft). Pull from `shareReceiver` to match the router path, or document.
- **L-14 — Role separation ignores `DEFAULT_ADMIN_ROLE`** (`gateway/AccessRoles.sol` L43-58). The disjointness override only considers `{ADMIN, PAUSER, AGENT}`; a `DEFAULT_ADMIN_ROLE` holder can renounce `ADMIN_ROLE` then self-grant `AGENT_ROLE`. Defense-in-depth gap vs the stated invariant. Include `DEFAULT_ADMIN_ROLE` or document the exclusion.
- **L-15 — Removed BasketVault assets unrescuable if they reappear** (`vaults/BasketVault.sol` `removeAsset` L725-730, `rescueTokens` L816-819). Inactive entries are skipped by `totalAssets`/`_sellProportional` but still match the `rescueTokens` `AssetInBasket` guard, stranding any later-acquired balance. Let `rescueTokens` skip inactive entries or fully delete the slot.
- **L-16 — `BasketVault.maxDeposit`/`maxMint` ignore caps/shutdown/pause** (`vaults/BasketVault.sol`; caps only enforced via reverts in `_deposit` L348-352). OZ defaults return `type(uint256).max`; per 4626 they must return 0 when deposits are disabled/capped. Override to reflect `paused()||shutdown` and `tvlCap`/`perDepositCap`.
- **L-17 — `setMaxSlippageBps(0)` bricks deposits/withdrawals** (`vaults/BasketVault.sol` L849-853). Only an upper bound is checked; 0 makes `minOut` the full TWAP value, so any real swap reverts. Admin-timelocked, so a trust note. Add a sane lower floor (≥ pool fee tier).

---

## Informational

- **Unbounded adapter array growth** (`RobotMoneyVault.sol` L566-575). `remove`/`forceRemove` only flip `active=false`; `totalAssets`/`_routeDeposit`/`_pullProportional`/`rebalance` loop the full array, so adapter churn monotonically raises gas. Consider swap-and-pop compaction.
- **Exit fee floors to zero on dust** (`RobotMoneyVault.sol` L475). At 100 bps, `gross < 100` units pays no fee; Base gas dwarfs the savings. No action.
- **`MorphoAdapter` ignores the `withdraw(type(uint256).max)` sentinel** documented in `IStrategyAdapter` L13; the vault never passes `max` today. Implement the sentinel or fix the doc.
- **`RmToken`** — classic `approve` race and infinite-allowance `transferFrom` (gas-saving pattern); `unchecked` block is underflow-safe via the prior `require`. Header already flags it as not mainnet-ready.
- **`UniswapV3PoolSlot0Stub` has no on-chain mainnet guard** (L32-62) — safety rests on a comment. Production NAV uses `observe()` not `slot0`, so a mis-wired stub fails closed (`cardinality=1` → `observe` reverts "OLD"). Gate construction on `block.chainid`.
- **Fee-on-transfer `tokenOut` in the V4 adapter** (`UniswapV4SwapAdapter.sol` L119-123) forwards router-reported `amountOut`, which can over-account or revert; basket assets are admin-curated. Validate at `addAsset` or measure the delta.
- **`VaultRegistry.registerVault` does not validate `metadata.asset`** against the vault's real `asset()` (L180-195). Off-chain consumers trust the field; the router independently re-derives it, so funds are unaffected. Optionally validate at registration.
- **Gateway unbounded policy whitelist arrays** (`RobotMoneyGateway.sol` L439-452) — owner can self-DoS their own agent with huge `allowedDestinations`/`allowedSourceVaults`. Cap lengths.
- **`MockVault` is not production-reachable** — test-only, never deployed by `Deploy.s.sol`, and the gateway pins an immutable vault with an `asset()==usdc` check; arbitrary vaults are never accepted.
- **ChronicleOracleAdapter decimal scaling is hardcoded** to the 6/18-decimal pair (`WAD * 1e12`); correct for the immutable token pair but would misprice if reused for another pair. Add a comment-level guard.

---

## Strong defenses observed (verified)

- **Inflation / first-depositor attack mitigated** across all 4626 vaults via `_decimalsOffset() == 18` on 6-decimal USDC shares; `totalAssets()` includes idle balance so donations don't understate NAV; fork tests assert victim-share fairness against real Aave/Morpho/Compound adapters.
- **TWAP-over-spot NAV** — BasketVault/RwaVault price via Uniswap V3 `observe()` (never `slot0` on hot paths), with `MIN_TWAP_WINDOW`, `MIN_POOL_CARDINALITY`, `MIN_POOL_LIQUIDITY`, pool-pairing checks, and Uniswap-parity negative-tick rounding. Emergency floors are double-bounded by a live TWAP floor even under the legacy override.
- **Adapter invocation is `call`, never `delegatecall`**, with a runtime-codehash allowlist, an `onlyVault` guard, and `AdapterBytecodeGuard` statically rejecting any adapter whose bytecode contains `0xF4` — the delegatecall-storage-collision class is structurally removed.
- **Reentrancy** — `nonReentrant` on every fund-moving entrypoint in the vaults, router, and gateway; CEI ordering in the gateway (payment-id and rolling-window state written before external calls).
- **Approval hygiene** — every adapter and the router/gateway use `forceApprove(target, amount)` followed by `forceApprove(target, 0)`; no standing or infinite approvals to external protocols.
- **Custody invariants** — PortfolioRouter and the gateway revert if any USDC/shares remain after an operation, plus fee-on-transfer balance-delta detection on both the USDC pull and vault redemption output in the gateway.
- **Dual eligibility enforcement** — router/vault eligibility checked both at config time and at runtime; gateway pins immutable vault/router targets and enforces role separation in `_grantRole`. No `payable`/`msg.value` anywhere in the gateway removes the entire ETH-reuse bug class.
- **RWA fail-closed staleness** on the normal `totalAssets()` path (the gap is only the emergency path, M-4).

---

*Generated by a five-agent parallel audit (one pass per subsystem) on 2026-06-09. Findings reference exact
file/line locations; the high finding (H-1) was manually re-verified against source. This is a code review,
not a formal audit or guarantee — treat the medium+ items as prioritized remediation candidates.*
