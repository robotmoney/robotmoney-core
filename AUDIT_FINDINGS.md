# Scan findings — robotmoney/robotmoney-core

Critical: 0 · High: 0 · Medium: 0 · Low: 19 · Info: 4 · Total: 23

Finished: 2026-11-17T03:48:00.730421Z

## 1. A stale V4 recorder lets any caller quarantine a protected removed-asset balance

**Severity:** low · logic_error

**Claim:**
For a removed V4 asset, `reabsorbRemovedAsset` treats any failure of the TWAP self-call as a reason to sweep the entire registered-token balance to the fixed quarantine address. The V4 recorder deliberately reverts every `observe` call once it has not been recorded for 1,800 seconds. Because reabsorption is permissionless and an inactive asset is unlikely to receive adapter-driven recorder updates, an unprivileged caller can wait for this ordinary stale state and invoke reabsorption before anyone calls `record`, permanently moving a potentially valuable protected balance out of the vault instead of reverting and preserving it for later recovery.

**Evidence:**
- `contracts/vaults/BasketVault.sol:1195` `function reabsorbRemovedAsset(uint256 index, uint256 minUsdcOut) external nonReentrant { BasketSwaps.reabsorb(_guardAssets(), index, minUsdcOut, address(_USDC), SWAP_ROUTER); }`
- `contracts/lib/BasketSwaps.sol:157` `try self.emergencyTwapUsdcValue(a, bal) returns (uint256 twapValue) { uint256 floor = twapValue * (MAX_BPS - self.maxSlippageBps()) / MAX_BPS; if (floor < minUsdcOut) revert SlippageExceeded(); if (bal != 0 && floor != 0) _swapToUsdc(a, bal, floor, usdc, router); } catch { ForeignTokenQuarantine.sweep(a.token, msg.sender); }`
- `contracts/adapters/UniswapV4PriceRecorder.sol:200` `uint32 lastTs = observations[s.index].blockTimestamp; if (time - lastTs > MAX_STALENESS) revert StaleRecorder(lastTs, time);`
- `contracts/lib/ForeignTokenQuarantine.sol:75` `amount = IERC20(token).balanceOf(address(this)); IERC20(token).safeTransfer(QUARANTINE, amount);`
- `contracts/vaults/BasketVault.sol:1376` `Protected = USDC, the share token, or ANY registered basket asset (active OR configured-but-inactive). Inactive entries are re-absorbed into NAV via reabsorbRemovedAsset, never quarantined.`

## 2. Deposit availability queries the router instead of the share receiver

**Severity:** low · logic_error

**Claim:**
PortfolioRouter determines each leg's availability with vault.maxDeposit(address(this)) even though _executeLeg later calls vault.deposit(legAmount, receiver). For an ERC-4626 vault whose deposit limit is receiver-specific, previewDeposit and _depositTo can therefore skip a leg that the actual receiver may use and silently renormalize funds into other vaults, or classify a leg as available and then revert because the actual receiver's limit is zero or below the leg amount. The user-controlled receiver is never propagated into the availability calculation.

**Evidence:**
- `contracts/PortfolioRouter.sol:855` `function _isDepositable(address vault) internal view returns (bool) { ... try IERC4626(vault).maxDeposit(address(this)) returns (uint256 cap) { return cap != 0; } catch { return false; } }`
- `contracts/PortfolioRouter.sol:914` `depositFor` passes user-controlled `receiver` into `_depositTo`.
- `contracts/PortfolioRouter.sol:1133` `(bool[] memory available, uint256[] memory legAmounts,) = _availabilityAndAmounts(vaultList, bpsList, amount);` — availability computed without receiver.
- `contracts/PortfolioRouter.sol:1270` `try IERC4626(vault).deposit(legAmount, receiver) returns (uint256 shares) { ... } catch { revert UsdcLegTransferFailed(vault); }`
- `contracts/PortfolioRouter.sol:746` doc: "amount split across ONLY the available legs".

## 3. Deposit slippage floors are not bound to the previewed vault vector

**Severity:** low · validation_bypass

**Claim:**
PortfolioRouter.deposit and depositFor accept only a positional minSharesPerLeg array and neither a deadline nor an expected vault/weight-vector commitment. If effective weights are changed or reordered after a user previews but before the transaction executes, _depositTo snapshots the new vector while applying the user's old floor at each array index. The deposit can therefore succeed into different vaults or allocations than the user authorized whenever the new vaults' share outputs satisfy those numeric floors; a normal governance update plus transaction ordering is sufficient, and no stale-quote expiry or vault-identity check exists.

**Evidence:**
- `contracts/PortfolioRouter.sol:888` `deposit(amount, minSharesPerLeg)` — no deadline/vector commitment.
- `contracts/PortfolioRouter.sol:914` `depositFor` — same.
- `contracts/PortfolioRouter.sol:1094` `(address[] memory vaultList, uint256[] memory bpsList) = _effectiveWeightsMemory();`
- `contracts/PortfolioRouter.sol:1211` `_executeLeg(...)` + `if (minSharesPerLeg.length != 0 && sharesReceived < minSharesPerLeg[i]) revert SlippageExceeded();`
- `contracts/PortfolioRouter.sol:939` doc contrasting redeem identity binding.

## 4. Deposits can front-run recovery of an uncounted inactive asset balance

**Severity:** low · accounting_error

**Claim:**
`totalAssets()` excludes every inactive basket token, while deposits remain open and mint against that reduced NAV. If a removed token later has a recoverable balance (for example from a transfer, rebase, or a residual that becomes valuable), an unprivileged account can deposit immediately before permissionlessly calling `reabsorbRemovedAsset`. The successful reabsorption swaps the previously uncounted balance into counted USDC, so the newly minted shares capture a proportional part of the recovery even though the depositor paid nothing for it, diluting the holders who bore the asset before removal.

**Evidence:**
- `contracts/vaults/BasketVault.sol:527` `for (...) { if (!assets[i].active) continue; ... sum += _twapUsdcValue(...); }`
- `contracts/vaults/BasketVault.sol:615` deposit mints against `taBefore = totalAssets()`.
- `contracts/vaults/BasketVault.sol:1195` permissionless `reabsorbRemovedAsset`.
- `contracts/lib/BasketSwaps.sol:157` successful path swaps full omitted balance to USDC.

## 5. Documented zero TVL-cap sentinel disables all deposits

**Severity:** low · logic_error

**Claim:**
RobotMoneyVault documents `_tvlCap == 0` as the uncapped configuration and initialization explicitly accepts it, but both the ERC-4626 limit view and the state-changing deposit check treat zero as a hard cap of zero. A vault deployed with the documented uncapped value therefore returns maxDeposit=0 and rejects every positive deposit/mint, leaving the canonical user entrypoints unusable until an administrator changes the cap.

**Evidence:**
- `contracts/RobotMoneyVault.sol:430` `/// @param _tvlCap Maximum total assets, 6-decimal units (0 = no cap).`
- `contracts/RobotMoneyVault.sol:461` `if (_tvlCap > 0 && _perDepositCap > _tvlCap) revert InvalidParam();` then stores zero.
- `contracts/RobotMoneyVault.sol:716` `if (nav >= tvlCap) return 0; uint256 headroom = tvlCap - nav;`
- `contracts/RobotMoneyVault.sol:621` `if (nav + assets > tvlCap) revert TVLCapExceeded();`
- `contracts/RobotMoneyVault.sol:711` `return tvlCap == type(uint256).max && perDepositCap == type(uint256).max;`

## 6. Exact Morpho pulls can block redemptions despite liquidity in other adapters

**Severity:** low · denial_of_service

**Claim:**
When a counted MorphoAdapter has positive accounting assets but MetaMorpho's currently withdrawable liquidity is below its proportional leg, any user withdrawal that reaches adapters reverts inside MorphoAdapter.withdraw. RobotMoneyVaultOps does not catch that revert or clamp the leg to MetaMorpho.maxWithdraw, so it never reaches its second pass or the other adapters even when their aggregate liquid assets could satisfy the full redemption. Ordinary share holders can therefore be unable to redeem until MetaMorpho liquidity returns or a privileged exclusion/recovery action occurs.

**Evidence:**
- `contracts/adapters/MorphoAdapter.sol:197` `return MORPHO_VAULT.convertToAssets(shares);`
- `contracts/adapters/MorphoAdapter.sol:147` `MORPHO_VAULT.withdraw(amount, VAULT, address(this));`
- `contracts/lib/RobotMoneyVaultOps.sol:927` `actual = adpt.withdraw(pull);`
- `contracts/lib/RobotMoneyVaultOps.sol:442` `uint256 actual = _withdrawFrom(adpt, i, pull, adapterCallGasFloor); ...`
- MetaMorpho `NotEnoughLiquidity` on exact withdraw.

## 7. Idle allocation bypasses the per-call rebalance movement cap

**Severity:** low · validation_bypass

**Claim:**
RobotMoneyVault.rebalance() limits only withdrawals from overweight adapters through maxMovePerCall, then passes the vault's entire idle USDC balance to _routeDeposit without subtracting that allocation from, or bounding it by, the same movement budget. Consequently, a normal keeper rebalance can deploy substantially more than maxRebalanceBpsPerCall of TVL in one call, defeating the configured per-call strategy-exposure throttle.

**Evidence:**
- `contracts/RobotMoneyVault.sol:1011` `uint256 totalMoved = RobotMoneyVaultOps.rebalancePull(_book(), asset(), totalAssetsCached, (totalAssetsCached * maxRebalanceBpsPerCall) / MAX_BPS); uint256 idle = IERC20(asset()).balanceOf(address(this)); if (idle > 0) _routeDeposit(idle);`
- `contracts/lib/RobotMoneyVaultOps.sol:747` movement counter accounts only withdrawals.
- `contracts/lib/RobotMoneyVaultOps.sol:263` `_routePass1/_routePass2` place full amount.
- `contracts/RobotMoneyVault.sol:165` `uint16 public maxRebalanceBpsPerCall;`

## 8. Keeper rebalance targets ignore adapter allocation caps

**Severity:** low · logic_error

**Claim:**
RobotMoneyVaultOps.rebalancePull computes each adapter's withdrawal target solely from the equal-weight partition and never clamps that target to the adapter's capBps ceiling (or optional maxExposure). After governance lowers a venue cap, an adapter holding at or below its equal-weight target but far above its new cap is not pulled at all; if above equal weight, it is pulled only to equal weight, which can still exceed the cap.

**Evidence:**
- `contracts/lib/RobotMoneyVaultOps.sol:747` `uint256 targetBalance = equalWeightBalance(totalAssetsCached, rank, active); ... if (currentBalance <= targetBalance) continue; uint256 excess = currentBalance - targetBalance;`
- `contracts/lib/RobotMoneyVaultOps.sol:306` ceiling = min(capBps, maxExposure), applied only to deposits.
- `contracts/RobotMoneyVault.sol:93` `uint16 capBps; // max allocation % out of MAX_BPS`
- `contracts/lib/RobotMoneyVaultOps.sol:544` `setAdapterCap` only changes storage.

## 9. Morpho withdrawal illiquidity is omitted from the deposit-health gate

**Severity:** low · validation_bypass

**Claim:**
RobotMoneyVault closes deposits only when an adapter's optional `venueWithdrawable()` staticcall successfully returns false. `MorphoAdapter` does not implement that interface, so a failed health probe is treated as healthy even when MetaMorpho cannot withdraw its existing position. During such a period, an unprivileged depositor can still mint shares; socializing the illiquid position onto new/remaining holders.

**Evidence:**
- `contracts/lib/RobotMoneyVaultOps.sol:192` fail-open staticcall.
- `contracts/adapters/MorphoAdapter.sol:25` `contract MorphoAdapter is IStrategyAdapter` (no IVenueHealthAdapter).
- `contracts/adapters/MorphoAdapter.sol:119` refused allocation returns USDC idle.
- MetaMorpho `_maxWithdraw` / `NotEnoughLiquidity`.

## 10. Pause-only venue checks miss liquidity-driven withdrawal failures

**Severity:** low · validation_bypass

**Claim:**
The Aave and Compound adapters report `venueWithdrawable()` solely from pause/configuration flags, while both venues can be active and unpaused yet lack enough underlying cash to honor the adapter's balance. RobotMoneyVault therefore leaves deposits open in a utilization-driven liquidity freeze, socializing stale illiquid positions to new depositors.

**Evidence:**
- `contracts/adapters/AaveV3Adapter.sol:121` checks only active/paused config bits.
- `contracts/adapters/CompoundV3Adapter.sol:115` `return !COMET.isWithdrawPaused();`
- `contracts/lib/RobotMoneyVaultOps.sol:192` relies on these signals.
- Upstream Aave `AToken.burn` / Compound `doTransferOut` need actual reserves.

## 11. Pre-swap TVL check does not cap favorable realized NAV

**Severity:** low · validation_bypass

**Claim:**
`_deposit` enforces `tvlCap` using the nominal USDC input before executing swaps, but mints and accounts using the post-swap `realizedDelta`. When basket tokens execute cheaper at spot than their TWAP mark, the deposited USDC buys tokens whose TWAP NAV exceeds the input; there is no upper bound on `realizedDelta`. A user can deposit nominal headroom and leave `totalAssets()` above `tvlCap`.

**Evidence:**
- `contracts/vaults/BasketVault.sol:625` `if (taBefore + usdcAmount > tvlCap) revert TVLCapExceeded();`
- `contracts/vaults/BasketVault.sol:673` swaps with only minOut floor.
- `contracts/vaults/BasketVault.sol:653` `realizedDelta = totalAssets() - taBefore;` one-sided floor.
- `contracts/lib/TwapTickMath.sol:99` deviation guard optional (threshold 0 disables).

## 12. Pro-rata rounding can permanently lock exclusion recoveries

**Severity:** low · accounting_error

**Claim:**
ExclusionLedger records every credited recovery unit in `heldUsdc`, but each holder's entitlement is rounded down independently and only the rounded claim amount reduces `heldUsdc`. If sum of floor-rounded claims < recoveredUsdc (e.g. 1 USDC base unit for two holders), no holder can claim the remainder and `returnSurplus` cannot release it. Recovery dust is permanently stranded.

**Evidence:**
- `contracts/ExclusionLedger.sol:222` `heldUsdc += amount;`
- `contracts/ExclusionLedger.sol:306` `owed = Math.mulDiv(e.recoveredUsdc, balanceAt(holder, id), supply);`
- `contracts/ExclusionLedger.sol:260` `heldUsdc -= amount;` only floor-claimed.
- `contracts/ExclusionLedger.sol:330` `if (bal <= held) return 0;`

## 13. Redeemer authorization allowance is reusable across redemptions

**Severity:** low · access_control

**Claim:**
In PortfolioRouter._redeemLeg, a non-holder caller is authorized by checking holder's share-token allowance to that caller, but the router never spends that allowance; vault.redeem spends separate holder-to-router allowance. A spender with allowance for a small share amount can repeat redeemFor calls while victim approved router for larger redemption, redirecting up to router-approved shares to attacker-selected recipient.

**Evidence:**
- `contracts/PortfolioRouter.sol:1065` `if (msg.sender != shareHolder && IERC20(vault).allowance(shareHolder, msg.sender) < shares) revert UnauthorizedRedeemer(...);`
- `contracts/PortfolioRouter.sol:1077` `assetsOut = IERC4626(vault).redeem(shares, assetRecipient, shareHolder);`
- `contracts/PortfolioRouter.sol:948` NatSpec confirms holder-to-router approval is consumed.

## 14. Router deposits do not enforce the portfolio-routing feature flag

**Severity:** low · validation_bypass

**Claim:**
`FeatureFlags.PORTFOLIO_ROUTER_ENABLED` is documented as gating the PortfolioRouter deposit path, but neither `deposit` nor `depositFor` accepts or checks a feature bitmap and no use of `FeatureFlags.isEnabled` exists. While the flag is cleared, anyone can bypass gating.

**Evidence:**
- `contracts/FeatureFlags.sol:15` flag registry.
- `contracts/PortfolioRouter.sol:888` `deposit` — no gate.
- `contracts/PortfolioRouter.sol:914` `depositFor` — no gate.
- `contracts/FeatureFlags.sol:42` helper unused.

## 15. Single-unit basket legs can be skipped during full redemption

**Severity:** low · accounting_error

**Claim:**
`BasketVault._sellProportional` prices `sellAmount - 1` and skips the entire leg whenever that quote floors to zero. With no decimals/atomic-value restriction at onboarding, a low-decimal asset can have materially valuable `sellAmount == 1`; a redeemer's shares are burned while that whole asset leg remains in the vault. Attacker can orphan the unit then capture it as next sole depositor.

**Evidence:**
- `contracts/vaults/BasketVault.sol:948` `sellAmount = bal.mulDiv(shares, supplyBefore); if (sellAmount == 0) continue; ... minUsdcOut = _slippageFloor(..., sellAmount - 1); ... if (minUsdcOut == 0) continue;`
- `contracts/vaults/BasketVault.sol:917` burn before `_sellProportional`.
- `contracts/lib/BasketAssetConfigGuard.sol:106` onboarding validates code, not decimals.

## 16. Split in-kind redemptions can avoid per-leg exit fees

**Severity:** low · accounting_error

**Claim:**
`redeemInKind` calculates and rounds down the exit fee independently for every token leg on every call. With low-decimal/high-value assets, a holder can split redemption into calls whose pro-rata token amount is below `ceil(10_000 / exitFeeBps)` atomic units; each pays zero fee, withdrawing a material basket position without fee.

**Evidence:**
- `contracts/lib/BasketAssetConfigGuard.sol:295` `amount = token.balanceOf(this).mulDiv(shares, supplyBefore); fee = amount.mulDiv(exitFeeBps, 10_000); if (fee > 0) transfer(feeRecipient, fee);`
- `contracts/vaults/BasketVault.sol:763` `redeemInKind(...)`, burn then `payInKind`.
- onboarding validation lacks decimals.

## 17. Timestamp ordering makes same-block receipts mutually exclusive

**Severity:** low · denial_of_service

**Claim:**
ConsensusRecommendationReceipt assigns block.timestamp as recordedAt, while RouterGovernance requires every applied receipt's recordedAt to be strictly greater than last applied timestamp. Two valid receipts in the same block share recordedAt; after either is applied, the other is permanently rejected.

**Evidence:**
- `contracts/ConsensusRecommendationReceipt.sol:167` `recordedAt = uint64(block.timestamp);`
- `contracts/RouterGovernance.sol:191` `if (r.recordedAt <= last) revert ReceiptNotNewerThanApplied(...);`
- `contracts/RouterGovernance.sol:195` release + setWeights.
- `contracts/RouterGovernance.sol:123` error, no tie-breaker.

## 18. Token donations can prevent asset deactivation

**Severity:** low · denial_of_service

**Claim:**
`removeAsset` requires active-token balance to have zero slippage-adjusted USDC value, but anyone can transfer the ERC-20 directly to the vault. An attacker can front-run each deactivation with enough tokens for one nonzero USDC atomic unit and force `AssetStillHeld`. Cleanup swaps and deactivation are separate entrypoints and active assets cannot use `reabsorbRemovedAsset`.

**Evidence:**
- `contracts/vaults/BasketVault.sol:1164` `removeAsset` -> `deactivateAsset`.
- `contracts/lib/BasketAssetConfigGuard.sol:227` `bal = balanceOf(this); floor = assetUsdcValue(index,bal)*(10000-maxSlippageBps)/10000; if (floor > 0) revert AssetStillHeld();`
- `contracts/vaults/BasketVault.sol:1195` reabsorb only for inactive.

## 19. V4 recorder commits a transient spot tick to the following time interval

**Severity:** low · oracle_manipulation

**Claim:**
An unprivileged caller can move the hookless Uniswap V4 pool price, call `record()`, and reverse the price in the same transaction. `record()` stores the manipulated (clamped) live tick as `lastTick`, one-write-per-timestamp prevents recording restored tick; observations extrapolate with manipulated tick. Repeating drags TWAP up to 10 ticks/second. Attacker can inflate recorded TWAP while spot within guard, deposit at real spot, overmint shares.

**Evidence:**
- `contracts/adapters/UniswapV4PriceRecorder.sol:151` `if (last.blockTimestamp == ts) return false; ... liveTick = _readSlot0(...); recordedTick = _clamp(s.lastTick, liveTick, delta); ... lastTick: recordedTick`
- `contracts/adapters/UniswapV4PriceRecorder.sol:305` extrapolate using `s.lastTick`.
- `contracts/adapters/UniswapV4PriceRecorder.sol:293` clamp cap.
- `contracts/lib/BasketViews.sol:113` zero threshold disables guard.
- `contracts/vaults/BasketVault.sol:641` `realizedDelta` mints shares.

## 20. Gateway deposit ignores its caller-supplied share floor

**Severity:** info · price_manipulation

**Claim:**
`RobotMoneyGateway.depositTo` accepts `minSharesPerLeg` and binds it into payment ID, but never uses it to validate execution output; `_executeVaultDeposit` calls ERC-4626 `deposit` and accepts any `sharesMinted`. An account holding shares in an allowed public vault can move its assets-per-share before an agent transaction is included (e.g. donating underlying), causing fixed USDC deposit to mint fewer shares than the floor while gateway marks payment used and emits success.

**Evidence:**
- `contracts/gateway/RobotMoneyGateway.sol:575` `depositTo(..., uint256[] calldata minSharesPerLeg)`.
- `contracts/gateway/RobotMoneyGateway.sol:640` paymentId hash includes minSharesPerLeg.
- `contracts/gateway/RobotMoneyGateway.sol:719` `sharesMinted = IERC4626(...).deposit(...)` no min check.

## 21. Permissionless recording can shorten the four-hour sell anchor

**Severity:** info · oracle_manipulation

**Claim:**
The V4 redemption guard labels `SELL_ANCHOR_WINDOW` as four hours but silently uses the age of the recorder's oldest retained observation when shorter. Onboarding only requires cardinality for NAV TWAP (901 slots for 30-min default on Base), and `record()` is permissionless. Attacker can record once per timestamp until ring wraps, reducing effective anchor to ~30 min, poison it, and sandwich a victim's USDC redemption.

**Evidence:**
- `contracts/lib/BasketViews.sol:212` `age = now - oldestObservation(); window = age < SELL_ANCHOR_WINDOW ? age : SELL_ANCHOR_WINDOW;`
- `contracts/lib/BasketViews.sol:158` applies downside anchor.
- `contracts/lib/BasketAssetConfigGuard.sol:136` cardinality sized for NAV TWAP only.
- `contracts/adapters/UniswapV4PriceRecorder.sol:151` `indexUpdated = (s.index + 1) % cardinalityUpdated;`

## 22. Reverting or malformed venue-health probes are treated as withdrawable

**Severity:** info · validation_bypass

**Claim:**
RobotMoneyVaultOps.anyActiveBlocked() marks a venue blocked only when `venueWithdrawable()` staticcall succeeds with exactly 32 bytes decoding to zero. A revert, missing selector, or malformed response falls through as healthy, contrary to IVenueHealthAdapter fail-closed spec.

**Evidence:**
- `contracts/lib/RobotMoneyVaultOps.sol:192` `if (ok && data.length == 32 && abi.decode(data,(uint256)) == 0) return true;`
- `contracts/interfaces/IVenueHealthAdapter.sol:7` doc: missing/reverting view should read as true (blocked).
- `contracts/RobotMoneyVault.sol:691` `_depositsClosed()` uses `_anyActiveAdapterBlocked(true)`.

## 23. User-supplied reabsorption floor can force a removed asset into quarantine

**Severity:** info · logic_error

**Claim:**
The permissionless `reabsorbRemovedAsset(index, minUsdcOut)` path executes both the caller-controlled floor check and the swap inside a `try` intended only to catch unavailable TWAP. An unprivileged caller can choose `minUsdcOut` above computed floor, deliberately trigger `SlippageExceeded` inside that `try`, and have the broad `catch` transfer the vault's entire balance of the registered inactive asset to fixed quarantine.

**Evidence:**
- `contracts/vaults/BasketVault.sol:1195` permissionless `reabsorbRemovedAsset`.
- `contracts/lib/BasketSwaps.sol:157` broad catch sweeps on any revert incl. deliberate floor revert.
- `contracts/lib/ForeignTokenQuarantine.sol:75` full-balance transfer to QUARANTINE.
