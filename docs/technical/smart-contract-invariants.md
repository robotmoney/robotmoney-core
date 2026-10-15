# Smart-Contract System Invariants

**Status:** living document. This is the textual source of truth for the properties
that must *never* be violated by the Robot Money on-chain system. It seeds formal
verification: each invariant below is something the FV stack should be made to prove
(or, where marked 🔴, should currently be able to *break* — those are the active
bugs FV must pin once fixed).

**Relationship to other docs.**
- `docs/prd.md` §12 defines the three **custody** invariants INV-1/INV-2/INV-3. Those
  are reproduced verbatim in the [Custody](#1-custody--solvency-inv-123) section below
  and remain canonical; this document is their superset.
- `docs/audits.md` is the finding register: every finding ID, its disposition and the
  fix that closed it. Its newest block, SR-1012, records the 2026-10-12 review
  (`docs/code-review/20261012-security-review.md`). The F-* and NC-* IDs below come from
  the 2026-06-19 audit (`docs/code-review/20260619-code-review-pekshield.md`, register
  block MC-0619). Invariants marked 🔴 link to the finding that violates them.
- Implementing code is in `contracts/`; current FV lives in `contracts/test/*Invariant*.t.sol`
  (Foundry `StdInvariant` handler-driven) plus the static guard tests
  (`CustodyInvariantGuard`, `AdapterDelegatecallGuard`, `AccessRoles`, `ERC4626PreconditionChecks`).
- The unified-vault re-homing proposed by ADR-0010 was Rejected and its code is deleted. The
  Chronicle oracle adapter is deleted too (core 1492): rmRWA prices from its pool TWAP like
  every basket. Every "Enforced at" entry below names shipped code: `RobotMoneyVault`
  (rmUSDC), or `BasketVault` with its `AgentTokenVault`, `ProtocolAssetVault` and
  `RwaBasketVault` subclasses, plus the libraries and adapters they link. A finding ID keeps
  the name its register gave it, so a fix note may describe code that is gone;
  `docs/audits.md` keeps that history.

## How to read an entry

Each invariant has a **stable ID** (never renumber — append only; retire with a
tombstone). Format:

> **`ID` — one-sentence "never" statement.**
> *Status* · *Enforced at* `file:symbol` · *FV strategy*

**Status legend**
- ✅ **PROVEN** — a named test currently asserts it.
- 🟢 **HOLDS** — believed true from code reading; no dedicated test yet.
- 🟡 **TRUSTED** — holds only under a stated trust assumption (honest timelock/admin, honest oracle, honest config). The assumption is named.
- 🔴 **VIOLATED** — currently breakable; links to a finding. FV should fail here today.
- ⚪ **ASPIRATIONAL** — desired property the current design does not yet provide.

**FV strategy** is one of: `stateful-invariant` (Foundry handler), `fuzz`
(stateless property), `symbolic` (Halmos/Kontrol/Certora — exhaustive over inputs),
`static-guard` (source/bytecode assertion test), `deploy-assertion` (post-deploy
state check), `behavioural` (concrete unit or fork tests over chosen inputs; not
exhaustive, so never tag such tests `symbolic`).

---

## 1. Custody & solvency (INV-1/2/3)

These three are canonical in `docs/prd.md` §12 and pinned by
`contracts/test/CustodyInvariant.t.sol` + `CustodyInvariantGuard.t.sol`. Reproduced
here as the root of the catalog.

> **`INV-1` — No admin-, role-, or vault-gated function ever routes a protocol or depositor asset to a caller-supplied recipient.**
> ✅ PROVEN · `CustodyInvariantGuard.t.sol` (asserts no `rescue*` arbitrary-recipient selector survives in production source); quarantine destination is a compile-time constant · static-guard.

> **`INV-2` — No protocol or depositor asset is ever stranded: every asset is redeemable by holders or absorbed into NAV; rounding/dust always favors holders; the router holds zero USDC after operations.**
> ✅ PROVEN (partial) · `CustodyInvariant.t.sol` (redeemability: Σ holder-redeemable ≤ `totalAssets`; donation → `totalAssets` non-decreasing), `PortfolioRouter.t.sol` (router zero-USDC) · stateful-invariant. *Gap:* the "reabsorb never bricks" leg is unproven — see `LIFE-6`.

> **`INV-3` — Fee recipient, fee parameters, and quarantine address change only through the `TimelockController`; direct non-timelock calls revert.**
> ✅ PROVEN · `DeployTimelock.t.sol` (setFeeRecipient/setExitFeeBps revert off the timelock path) · deploy-assertion.

Sub-invariants that decompose the above and are individually worth proving:

> **`CUST-4` — Idle USDC and active basket-asset balances are always counted in `totalAssets` (donations accrue pro-rata, never to an admin).**
> ✅ PROVEN · `CustodyInvariant.t.sol` donation case · stateful-invariant.

> **`CUST-5` — The first depositor can never manipulate share price to steal later deposits (ERC-4626 inflation).**
> ✅ HOLDS · `RobotMoneyVault._decimalsOffset()` and `BasketVault._decimalsOffset()` both return 18, so OZ ERC-4626 adds `10^18` virtual shares. `BasketVault._deposit` mints on the realized NAV delta with the same offset over the full pre-deposit NAV (`supplyBefore + 10 ** _decimalsOffset()` over `taBefore + 1`, AZ-BSK-3), so idle USDC donated before the first deposit cannot be farmed by the first depositor · fuzz/symbolic recommended (`RobotMoneyVault.t.sol::test_decimalsOffset_is18`, `::test_inflationAttack_victimReceivesFairShares`, `::test_inflationAttack_previewDepositNonZero`; `BasketVault.t.sol::test_AZBSK3_firstDepositWithDonatedIdleCannotOverMint`).

> **`CUST-6` — Underlying-protocol emissions are always harvested to the vault, never left on the adapter.**
> 🟢 HOLDS · `IStrategyAdapter` INV-2; `MorphoAdapter.t.sol` emission case · stateful-invariant.

---

## 2. Share & supply accounting (SUP)

> **`SUP-1` — The sum of all holders' redeemable assets never exceeds `totalAssets()` (accounting never over-promises).**
> ✅ PROVEN · `CustodyInvariant.t.sol::invariant_holdersNeverExceedTotalAssets` (stateful handler on `RobotMoneyVault`); `fv/CustodyMultiVault.t.sol::test_SUP1_robotMoneyVault_redeemableLeqTotalAssets`, `::test_SUP1_basketFamily_redeemableLeqTotalAssets`, `::test_SUP1_rwaVault_redeemableLeqTotalAssets` (one shared predicate per vault family; `::test_SUP1_predicateRejectsOverpromisingVault` is its negative test) · stateful-invariant. (Same property as INV-2 redeemability; cross-listed because it is the core solvency check for every vault, not just rmUSDC. The stateful handler drives `RobotMoneyVault` only; the `BasketVault` family has the point tests above, see Open items 1.)

> **`SUP-2` — `totalSupply` always equals the sum of ERC-20 balances, and shares are never minted without a corresponding asset inflow.**
> 🟢 HOLDS (OZ ERC-4626) · symbolic recommended (zero-asset mint, rounding-to-zero shares).

> **`SUP-3` — A deposit-then-immediate-redeem round trip never returns more than was put in: `previewRedeem(previewDeposit(x)) <= x` for every vault.**
> ✅ HOLDS (fixed #969, NC-6/F-16) · `BasketVault._deposit` swaps first and mints shares on the REALIZED post-swap NAV delta over the full pre-deposit NAV, idle USDC included (`taBefore + 1`, AZ-BSK-3), not a pre-swap TWAP mark. The slippage-discounted floor only reverts a short fill (`DepositBelowSlippageFloor`, AZ-BSK-1). `previewDeposit` returns that floor and `previewRedeem` discounts by slippage and the exit fee again, so the mint-vs-haircut asymmetry that let a round trip farm value back out is closed. The NAV-vs-market deviation guard (`ORA-4`) keeps execution inside the band the proof assumes. `RobotMoneyVault` swaps nothing: OZ ERC-4626 rounds shares down on deposit and assets down on redeem, and the exit fee comes off the redeem · fuzz (`BasketVault.t.sol::test_SUP3_roundTripNeverProfits_fuzz` + stateful proof `BasketVault.t.sol::test_SUP3_statefulDepositRedeemNeverProfits`, `::test_AZBSK3_idleDepositRoundTripNoProfit`; `FvInvariants.t.sol::test_SUP3_roundTripNeverProfits`).

> **`SUP-4` — Rounding always favors the vault (remaining holders), never the transacting account.**
> 🟢 HOLDS (OZ rounding directions) · symbolic recommended; watch the basket redeem dust path (`BasketSwapOps.sellProportional`/`_sellLeg`, which `BasketVault._sellProportional` calls: a leg whose floor rounds to zero is skipped, QA plan D6) and cross-asset NAV summation bias.

> **`SUP-5` — A redeem never reverts solely because the vault has deposits paused, is retired or is shut down when the underlying is already idle USDC (no liveness trap on already-safe funds).**
> ✅ HOLDS (fixed #966, NC-1; core 1494) · neither vault reads `depositsPaused`, `retired` or `shutdown` on the redeem path (`BasketVault.redeem`/`_withdraw`, `RobotMoneyVault.redeem`/`_withdraw`; LIFE-3). A basket vault that holds only idle USDC needs no price: `BasketVault.totalAssets` and `_sellProportional` skip every leg with a zero balance, and `BasketViews.checkSellAnchor` skips it too, so no TWAP is read. `RobotMoneyVault` has no price feed: NAV is idle USDC plus the counted adapters' reported balances. NC-1's vehicle, the Chronicle feed, is deleted (core 1492) · stateful-invariant (`WithdrawalsNeverFrozen.t.sol::test_rmPROTO_noLeverFreezesExit`, `::test_rmAGENT_noLeverFreezesExit`, `::test_rmRWA_noLeverFreezesExit` redeem after an unwind with deposits paused, shut down and retired; `::test_rmUSDC_noLeverFreezesExit_afterEmergencyDrain`; `BasketVault.t.sol::test_emergencyUnwind_blocksDepositsButAllowsRedemption`).

> **`SUP-6` — ~~The RM test token's total supply is fixed after deploy (no post-deploy mint).~~ Retired 2026-10-05, see core 1489.**
> Tombstone · no surface. The RM test token contract is deleted (core 1489). RM is the live ROBOTMONEY token `0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3` on Base, which nothing in this repo deploys, so no repo contract carries this invariant. The ID stays because IDs are append-only; its `InvariantRegistry` entry stays in step with the spec.

---

## 3. Oracle & pricing (ORA)

> **`ORA-1` — Spot (`slot0`) is never used for NAV or share pricing; only a TWAP over the configured window is.**
> ✅ HOLDS · `BasketVault.totalAssets` prices every held leg through `_twapUsdcValue`. The built-in Uniswap V3 path (`adapter == address(0)`) reads `TwapTickMath.meanTick` over `effectiveTwapWindow(token)` (at least `MIN_TWAP_WINDOW` 600 s, default 1800 s). An adapter leg calls `IBasketSwapAdapter.twapPrice` on `UniswapV3SwapAdapter`, `AerodromeSwapAdapter` or `UniswapV4SwapAdapter` with the same window. Spot is read only by the ORA-4 deposit guard and the core 1793 sell anchor, never to price shares. `RobotMoneyVault` reads no pool price: NAV is idle USDC plus adapter balances. PRD §11 · static-guard (assert no `slot0` price read on the NAV path) + symbolic (`BasketVault.t.sol::test_totalAssets_usesTwapTickNotSlot0`, `::test_totalAssets_revertsOnSpotPriceManipulationUsingSlot0`; `UniswapV4SwapAdapter.t.sol::test_twapPrice_ignoresLiveSpot`). **Core 1676 (V4):** the recorder's `observe()` reads recorded snapshots only, never live spot (`UniswapV4PriceRecorder.t.sol::test_observe_zeroAfterSpotMovesWithoutAPokeReturnsTheLastRecordedTickNotSpot`). `slot0().tick` of the recorder is live spot for the ORA-4 deposit guard only. The recorded tick moves by at most 10 ticks per second (capped elapsed 60 s) and weights only the time after its record (lagged tick). If the recorder is older than 1800 s, `observe` reverts (stale fails closed) and `redeemInKind` still works. Sufficient for the Base mainnet test, not the final deployment; the bound is the pool depth, so `perDepositCap` and `tvlCap` stay below it.

> **`ORA-2` — A price-sensitive operation never executes against a stale price (fail-closed).** *(Was: "against a Chronicle feed older than the heartbeat". The Chronicle oracle is deleted, core 1492.)*
> ✅ HOLDS (core 1492; V4 core 1676) · every basket price is a pool TWAP. A V3 or Aerodrome pool whose observations do not reach the window reverts `observe()` ("OLD"), and `BasketAssetConfigGuard.requireObservationHistory` refuses such a window in `addAsset` and `setTwapWindow`. A `UniswapV4PriceRecorder` whose last record is older than 1800 s reverts `observe`, so `UniswapV4SwapAdapter.twapPrice` fails closed. Each failure reverts `totalAssets`, deposit and the USDC `redeem`, while `BasketVault.redeemInKind` reads no price and still pays · stateful-invariant (`UniswapV4PriceRecorder.t.sol::test_stale_observeRevertsBeyondOneWindowAndRecoversOnRecord`; `BasketVaultV4Venue.t.sol::test_stale_depositAndUsdcRedeemRevertAndRedeemInKindStillPays`; `BasketVault.t.sol::test_redeemInKind_succeedsWhenObserveReverts`, `::test_setTwapWindow_rejectsWindowBeyondPoolHistory_redeemStillWorks`). *Tension:* this is correct for *pricing* but must not over-apply to user `redeem` — see `SUP-5`/NC-1. A zero-balance leg is never priced, and `redeemInKind` is the exit while a held leg cannot be priced.

> **`ORA-3` — The pool used to derive the pricing TWAP is always the same pool trades execute against (same fee/tickSpacing/hooks).**
> ✅ HOLDS (fixed #966, F-09; V4 core 1676: the V4 adapter is built with the full PoolKey and the recorder of that key, requires `keccak256(abi.encode(key))` to equal the recorder's pool id, and `swap` accepts only the configured pair and fee, so the pool priced is the pool traded) · `BasketVault.addAsset` → `BasketAssetConfigGuard.requireExecutionPoolMatchesTwap` reverts `ExecutionPoolMismatch` when the registered TWAP pool's fee tier (V3, or the V4 recorder's `fee`) or tick spacing (Aerodrome) does not equal `swapFee_`, and every later swap of that leg executes with the stored `swapFee`. `swapFee == 0` is exempt, and the basket deploy script refuses a zero `poolFee` (`BasketVaultDeployBase.sol`) · deploy-assertion + static-guard (`DeployAssertions.t.sol::test_ORA3_addAssetRevertsOnPoolMismatch`; `BasketVault.t.sol::test_addAsset_revertsOnExecutionPoolMismatch`; `BasketVaultV4Venue.t.sol::test_addAsset_revertsWhenTheRegisteredFeeIsNotThePoolFee`; `UniswapV4SwapAdapter.t.sol::test_constructor_refusesAKeyWhoseHashIsNotTheRecordersPoolId`, `::test_swap_refusesAFeeThatIsNotThePoolFee`).

> **`ORA-4` — Deposits/redemptions never settle when the oracle NAV deviates from the executable market price beyond a bounded threshold.**
> ✅ HOLDS (fixed #969, F-10; core 1793) · `BasketVault._deposit` runs `_checkMarket(false)` → linked `BasketViews.checkNavDeviation` → `TwapTickMath.requireWithinDeviation`, which reverts `NavMarketDeviationExceeded` when any active asset's executable (Aerodrome/Uniswap spot) price diverges from its NAV-pricing TWAP beyond the timelock-configured `navDeviationGuardBps` (`setNavDeviationGuardBps`, at most `MAX_NAV_DEVIATION_BPS` 2000; `0` disables it), halting a deposit against a stale/manipulated mark. The deviation guard is deliberately NOT on `redeem`, so redemption stays live. Since core 1793 `BasketVault.redeem` runs `_checkMarket(true)` → `BasketViews.checkSellAnchor` instead, which refuses only a USDC redeem that would sell a held Uniswap V4 leg more than `navDeviationGuardBps` below its 4 h mean (`SpotBelowSellAnchor`). `redeemInKind` runs neither check. `RobotMoneyVault` has no market price to compare · stateful-invariant (`BasketVault.t.sol::test_ORA4_deviationGuardBlocksSettlement`, `::test_ORA4_guardNeverBlocksRedeem`, `::test_ORA4_withinBandSettles`; `BasketVaultV4Venue.t.sol::test_manipulation_flashSwapPokeDepositRevertsOnTheDeviationGuard`; `RecorderSellAnchor.t.sol::test_sellAnchor_heldDisplacementUnderKeeperCadenceRefusesUsdcRedeem`; `FvInvariants.t.sol::test_ORA4_deviationGuardBlocksSettlement`).

> **`ORA-5` — ~~A reported oracle price is always within sane absolute bounds.~~ Retired 2026-10-15, see core 1492.**
> Tombstone · no surface. The `ChronicleOracleAdapter` and its `MIN_NAV`/`MAX_NAV` bounds are deleted (core 1492). No vault reads a reported oracle price: every basket leg is priced from its own pool TWAP (ORA-1), whose gap to spot ORA-4 bounds at deposit, and `RobotMoneyVault` reads adapter balances. The ID stays because IDs are append-only; its `InvariantRegistry` entry stays in step with the spec.

> **`ORA-6` — ~~The decimals scaling between a priced asset and USDC is always correct for the asset actually configured.~~ Retired 2026-10-15, see core 1492.**
> Tombstone · no surface. The `ChronicleOracleAdapter` and its hardcoded `1e12` scale are deleted (core 1492; the latent half of **F-17**, register row MC-F-17). A TWAP price is a tick ratio of raw token units (`TwapTickMath.priceFromTick`), so it carries both tokens' decimals and no scale constant exists. rmRWA's deSPXA prices through `UniswapV3SwapAdapter` like every basket leg. The ID stays because IDs are append-only; its `InvariantRegistry` entry stays in step with the spec.

> **`ORA-7` — The internal slippage floor on a swap is never derived solely from the same oracle/TWAP that prices the trade (the floor must be an independent backstop).**
> 🟡 TRUSTED (pool depth; fixed #966, F-09/F-11/F-16; V4 sell anchor core 1793) · every basket swap floor is `BasketSwapOps._applySlippage` over the vault's `assetUsdcValue`/`assetTokenValue` TWAP views: the leg's TWAP value less `maxSlippageBps`, which `setMaxSlippageBps` bounds below by the highest active pool fee (`minSlippageFloorBps`) and above by `MAX_SLIPPAGE_BPS` (500). The floor amount is therefore TWAP-derived. A one-block spot move cannot reach it, because the TWAP spans at least `MIN_TWAP_WINDOW` (600 s, default 1800 s) and ORA-3 makes the priced pool the traded pool. A price held for a whole window drags the TWAP and the floor with it, so the bound is the cost of holding the pool there: the trust assumption is pool depth, with `perDepositCap` and `tvlCap` kept below it (ORA-1). On Uniswap V4 legs, where that cost is lowest, `BasketViews.checkSellAnchor` refuses a USDC `redeem` while spot sits more than `navDeviationGuardBps` below the 4 h mean, and the holder exits through `redeemInKind` (core 1793, QA plan decision D2). `emergencyUnwind` sells at the higher of the TWAP floor and the ADMIN-set `minUsdcOut`. The unified-`Vault` NAV-growth cap (`DEFAULT_MAX_NAV_GROWTH_RATE_BPS`) this entry used to cite went with ADR-0010, and neither shipped vault has one · fuzz (`TwapManipulation.t.sol::test_ORA7_independentFloorBoundsLossUnderManipulation` models the floor; `RecorderSellAnchor.t.sol::testFuzz_sellAnchor_usdcRedeemWithin30MinutesOfAHoldLosesUnderFivePercent`, `::test_sellAnchor_heldDisplacementUnderKeeperCadenceRefusesUsdcRedeem`; `RecorderManipulationFork.t.sol::test_recorder_heldDisplacementDragsSellFloorUnderKeeperCadence` shows the drag the anchor answers; `BasketVault.t.sol::test_emergencyUnwind_configuredFloorAboveTwap_configuredFloorWins`).

---

## 4. Access control & roles (ACL)

> **`ACL-1` — In production, no EOA ever holds any privileged role (`DEFAULT_ADMIN_ROLE`, `ADMIN_ROLE`, `EMERGENCY_ROLE`, `DEPOSIT_PAUSER_ROLE`) after deployment handover.**
> ✅ PROVEN · REMEDIATED (#965, **F-01**): `DeployTimelock` now hands the Gateway `DEFAULT_ADMIN_ROLE` (alongside `ADMIN_ROLE`) to the Timelock and moves every vault `EMERGENCY_ROLE` to an independent hot key, revoking all four privileged roles from the deployer EOA; the Gateway constructor redirects `AGENT_ROLE`'s admin to `ADMIN_ROLE` and `authorizeAgent` is now `ADMIN_ROLE`-gated, so the revoke does not brick agent onboarding (fix-interaction warning) · deploy-assertion (`DeployAssertions.t.sol::test_ACL1_*`, `DeployTimelock.t.sol::test_ACL1_*` — EOA holds *no* role; negative test pins the naked-revoke regression).

> **`ACL-2` — No single address ever simultaneously holds two of {ADMIN-tier, PAUSER, AGENT}.**
> ✅ PROVEN · `AccessRoles._grantRole` separation override; `AccessRoles.t.sol` · symbolic recommended. *Watch:* this same override enables a grant-DoS during handover — see **NC-10** (`ACL-7`).

> **`ACL-3` — `ADMIN_ROLE` membership on any fund-holding contract never reaches zero (no permanent governance brick).**
> ✅ HOLDS (fixed #966, F-06; consolidated #1284) · a manual last-admin floor (`adminCount`, `LastAdminFloor`) lives in one shared base, `lib/AdminFloorAccessControlCounter.sol`, inherited by `RobotMoneyVault` (which had no such protection before #1284) and by `BasketVault`, so `AgentTokenVault`, `ProtocolAssetVault` and `RwaBasketVault` carry it too; `RobotMoneyGateway._revokeRole` enforces the same floor for both `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE`. (Lightweight counters, not `AccessControlEnumerable`, to respect the vault family's EIP-170 limit and the gateway's storage layout.) · symbolic (`VaultFamilyInvariants.t.sol::test_lastAdminFloor_holdsAcrossVaultFamily` deploys every vault type, with `::test_lastAdminFloor_negativeSelfTest_unprotectedStubHasNoFloor`; `BasketVault.t.sol::test_lastAdminFloor_*`; `RobotMoneyVault.t.sol::test_lastAdminFloor_*`; `RobotMoneyGateway.t.sol::test_lastAdminFloor_*`).

> **`ACL-4` — An agent's owner is reassigned only by that owner, and only to an `ADMIN_ROLE` holder; no other caller can take an existing agent.**
> ✅ PROVEN-by-code · `_authorizeAgentInternal` reverts `AgentAlreadyOwned`; `setPolicy`/`revokeAgent`/`transferAgentOwnership` require `agentOwner[agent]==msg.sender`; `transferAgentOwnership` reverts `NewAgentOwnerNotAdmin` for a destination without `ADMIN_ROLE`, so governance can be given an agent but cannot take one (issue #1476). A caller without `ADMIN_ROLE` cannot claim an unowned address either: binding an agent other than itself needs the agent's EIP-712 `AgentConsent` signature for that owner, receiver and `agentConsentNonce` (`InvalidAgentConsent`), and an address bound without consent by an `ADMIN_ROLE` caller can free itself with `releaseAgent` (issue #1791) · behavioural (`GatewayAgentPolicyAuthorization.t.sol::test_nonOwner_setPolicy_revokeAgent_transfer_revertNotAgentOwner`, `::test_transferAgentOwnership_*`, `GatewayAgentConsentTest::test_squattedAgentDeposit_revertsWithoutConsent`, `::test_revealAuthorization_revertsOnReplayAfterSuccess`, `::test_releaseAgent_*`) · symbolic recommended.

> **`ACL-5` — An emergency-role action can only de-risk; it never moves value to an external party or settles at an unverifiable price.**
> ✅ HOLDS (fixed #966, F-08; M-S5) · every `EMERGENCY_ROLE` lever keeps value inside the protocol. `BasketVault.emergencyUnwind` sells each active leg to USDC held by the vault, at the higher of the TWAP floor and the ADMIN-set `minUsdcOut`, and reverts `EmergencyFloorUnavailable` when the TWAP cannot be read and no floor is set. `BasketVault.emergencyUnwindWithOverride` skips the TWAP only for a token whose guard has `overrideAllowed`, and refuses a fill below `minUsdcOut * (MAX_BPS - maxLossBps) / MAX_BPS` (`EmergencyUnwindLossCapExceeded`). That guard is written only by `setEmergencyUnwindGuard`, which is `ADMIN_ROLE` (the timelock), so the hot key can de-risk but cannot choose its own price. `RobotMoneyVault.emergencyWithdraw`/`emergencyWithdrawAdapter` pull adapter balances into the vault, or into the entry's open exclusion record, which pays the holders at the moment of exclusion (core 1820). `forceRemoveAdapter`, `pauseDeposits` and `shutdownVault` move no value. The Chronicle stale-price override this entry used to cite is deleted (core 1492) · static-guard + stateful-invariant (`BasketVault.t.sol::test_setEmergencyUnwindGuard_requiresAdminRole`, `::test_emergencyUnwindWithOverride_requiresEmergencyRole`, `::test_emergencyUnwindWithOverride_revertsWhenBelowUpperLossCap`, `::test_emergencyUnwind_usesConfiguredFloorWhenOracleUnavailable`; `RobotMoneyVault.t.sol::test_exclusionRecoveryPaidProRataToSnapshot`).

> **`ACL-6` — Depositor principal is only ever moved by the depositor (or her authorized agent on her behalf); no privileged role can move a third party's funds.**
> ✅ PROVEN · every gateway flow pulls USDC from `msg.sender`; this is why F-01 is governance-capture, not theft · stateful-invariant (already implied by GW-1/GW-3).

> **`ACL-8` — After the deployment handover, no gateway agent listed in `AGENT_ADDRESSES` is owned by the deployer EOA.**
> ✅ PROVEN (issue #1476) for the listed agents · agent ownership carries `setPolicy`/`revokeAgent` authority, so `DeployTimelock` hands every agent listed in `AGENT_ADDRESSES` to the TimelockController with `transferAgentOwnership` (after the timelock's gateway `ADMIN_ROLE` grant, before the deployer's revoke) and requires afterwards that none is still deployer-owned. The transfer does not change `AGENT_ROLE`: a listed agent that held it still holds it, and a listed agent without it (renounced, or revoked by `ADMIN_ROLE`) is handed over without it. Ownership of such an agent still carries `setPolicy`/`revokeAgent` authority over its stored policy, which applies again if the agent is later granted `AGENT_ROLE`, so it is handed over too. The gateway cannot enumerate an owner's agents, so the guarantee is only as complete as the list: the broadcast run requires `AGENT_ADDRESSES` to be set (a comma-separated list, or `none`; unset or empty reverts before any broadcast), and the manifest records `roles.gateway_agents_listed_count` so a reader can compare the list's length with the deployer-owned agents the gateway logs name. The stage ceremony derives the list from the gateway's `AgentAuthorized`/`AgentOwnershipTransferred` logs, and the publish contracts verifier fails when any agent those logs give the deployer is still deployer-owned, so on stage the claim covers every agent the deployer ever owned. A direct `DeployTimelock` run (`docs/operations/manual-admin-actions.md`) must list every deployer-owned agent the same way · deploy-assertion (`DeployTimelock.t.sol::DeployTimelockAgentHandoverTest`, `DeployTimelock.t.sol::DeployTimelockRunEntrypointTest`, `SafeIntegration.t.sol::test_handover_noDeployerOwnedAgentRemains`) + ceremony check (the publish contracts verifier and govern matrix (core `publish-contracts/`, `docs/development/stage-deployment.md`)).
> *Mainnet plan (2026-10-05):* the deploy authorizes no agent, so `AGENT_ADDRESSES=none` at the handover and no agent is deployer-owned. Agents belong to depositors, who authorize them through `commitAuthorization`/`revealAuthorization`. `DeployGateway.s.sol` reads no `AGENT_*` input and authorizes no agent at stage 5, and the stage 12 verifier fails a run with any gateway agent log up to the handover or any `AGENT_ROLE` holder when it runs (core 1527).

> **`ACL-7` — Registering an agent never blocks a future intended ADMIN/PAUSER address from being granted its role.**
> ✅ PROVEN · the DeployTimelock handover asserts every intended ADMIN/PAUSER address is AGENT-free **before** any gateway grant, so the permissionless-registration grant-DoS becomes an explicit, typed deploy-time precondition rather than a late-stage `RoleSeparationViolated` brick — fixed by **NC-10 (#970)** · `DeployAssertions.t.sol::test_ACL7_agentRegistrationCannotBlockRoleGrant` · deploy-assertion.

---

## 5. Lifecycle & state machine (LIFE)

> **`LIFE-1` — A retired vault never accepts new deposits, on every entry path (direct and router), with the registry status and the vault flag always in sync.**
> ✅ HOLDS · atomic `VaultRegistry.retire()`/`reactivate()` sync both, `_deposit` reverts on `retired`, and `setVaultStatus(_, Retired/DepositsPaused/Active)` now drives the vault deposit-halt flag too — the back-door is closed (F-04 fixed, #968) · stateful-invariant (drive both setters, assert no drift) — `FvInvariants.t.sol::test_LIFE1_retireSyncsRegistryAndVaultFlag`.

> **`LIFE-2` — A registered vault is never removed from `listVaults()`, so existing positions are always re-discoverable and re-redeemable.**
> 🟢 HOLDS · `VaultRegistry._vaults` is append-only (no deregister) · static-guard + stateful-invariant.

> **`LIFE-3` — Vault shutdown never blocks withdrawals (it disables deposits only).**
> ✅ HOLDS (fixed #966, NC-3/F-06; core 1494) · withdrawals are never frozen, by anyone (owner decision 2026-10-05). No current vault has a withdrawal-pause flag: core 1494 deleted `withdrawalsPaused`, its error, event and setter. `pauseDeposits()`, `emergencyWithdraw`, `emergencyWithdrawAdapter`, `forceRemoveAdapter`, `shutdownVault` and `emergencyUnwind` halt deposits only, and `maxRedeem`/`maxWithdraw` are never lowered by a pause. `unpauseDeposits()` (ADMIN_ROLE) also clears the emergency deposit halt. Gateway `withdraw`/`withdrawFromRouter` do not read the gateway pause, and `PortfolioRouter.redeemFor` redeems from a vault in every registry status. `setTwapWindow` refuses a window the pool's observation history does not reach, so governance cannot make NAV reads revert and block a redeem. `addAsset` and `setTwapWindow` also refuse a pool whose observation cardinality is below `window / 2 s + 1` (901 for the 1800 s default), so griefing swaps cannot churn the ring below the window (core 1665). `BasketVault.redeemInKind` is the oracle-free exit: it reads no TWAP, sells nothing, pays the pro-rata idle USDC and active basket tokens less `exitFeeBps` per leg, and no pause, shutdown, retire or role blocks it, so a failed TWAP read cannot freeze a holder (`BasketVault.t.sol::test_redeemInKind_succeedsWhenObserveReverts`, `test_redeemInKind_neverBlocked`, `testFuzz_redeemInKind_proRataExact`). The USDC `redeem` slippage revert stays as accepted in ADR-0007. The deployed v1 vault predates this: its v1 `pause()` still freezes withdrawals, so never call it · unit + fork (`WithdrawalsNeverFrozen.t.sol`: every emergency, pauser and status lever on rmUSDC, rmPROTO, rmAGENT, rmRWA, the router and the gateway; `RobotMoneyVault.t.sol::test_pauseDeposits_blocksDepositsOnly_withdrawalsStayOpen`; `BasketVault.t.sol::test_pauseDeposits_doesNotFreezeWithdrawals`). This is test evidence for the contract code. It is not proof that the production Safe or governance works.

> **`LIFE-4` — Depositor funds are never *permanently* frozen: any state that blocks withdrawal is always reversible by a still-available authority.**
> ✅ HOLDS (fixed #966, F-06 + NC-3) · withdrawals are never paused (LIFE-3) and the last-admin floor (ACL-3) guarantees a still-available `ADMIN_ROLE` authority, so no reachable state freezes withdrawals forever · symbolic. *(`shutdownVault` reversibility, F-07: `BasketVault.restoreVault(newTvlCap)` and `RobotMoneyVault.restoreVault(newTvlCap)` — ADMIN_ROLE only, the strictly higher-trust tier than the EMERGENCY hot key that can `shutdownVault` — clear `shutdown` and re-open deposits under a fresh cap, fixed #971; the three basket subclasses inherit the `BasketVault` one. `BasketVault.t.sol::test_F07_restoreVaultReopensDeposits`, `::test_F07_restoreVault_emergencyCannotRestore`; `RobotMoneyVault.t.sol::test_shutdownVault_isRecoverableByAdminNotEmergency`.)*

> **`LIFE-5` — A reweight/removal of a vault never makes an existing holder's position unredeemable through the protocol.**
> ✅ HOLDS (fixed #967, F-03) · `redeemFor` (and `gateway.withdrawFromRouter`) drive redeem legs from an explicit caller-supplied `vaults[]`, not the live weight vector, and `_redeemLeg` permits every registry status, `DepositsPaused` included (core 1494) — a reweighted-out, deposit-paused or Retired position stays redeemable through the router · stateful-invariant — `FvInvariants.t.sol::test_LIFE5_expectedFail_reweightKeepsPositionRedeemable`.

> **`LIFE-6` — `reabsorbRemovedAsset` never reverts-and-strands a reappeared balance (INV-2 must survive a degraded pool).**
> ✅ PROVEN · `BasketVault.reabsorbRemovedAsset` runs the linked `BasketSwapOps.reabsorbRemovedAsset`, which wraps the TWAP floor read (the self-call `assetUsdcValue(index, balance)`) in a try/catch: on a degraded pool whose `observe()` reverts, the reappeared balance is permissionlessly swept to the fixed quarantine address (`ForeignTokenQuarantine.sweep`) instead of being stranded, so the call can never revert-and-strand. A balance whose floor rounds to zero is dust and stays in place (QA plan D6). The no-duplicate-slot rule differs by family. Basket family: `BasketVault.addAsset` rejects an ACTIVE duplicate and reuses an inactive entry on re-add (`BasketAssetConfigGuard.reuseOrRejectDuplicate`) — fixed by **NC-8 (#970)**. Stable family: `RobotMoneyVault.addAdapter` rejects an address that any ACTIVE entry already holds (`AdapterAlreadyActive`, #1789), so one adapter balance is never counted twice in NAV. A re-add after `removeAdapter` or `forceRemoveAdapter` is legal and appends a NEW entry (no inactive reuse in this family); inactive entries are never counted · `BasketVault.t.sol::test_LIFE6_reabsorbSurvivesDegradedPool`, `::test_LIFE6_reabsorbZeroBalanceIsNoOp`, `::test_NC8_addAsset_rejectsActiveDuplicate`, `::test_NC8_addAsset_reusesInactiveSlotOnReAdd`; `RobotMoneyVault.t.sol::test_addAdapter_revertsWhenAdapterAlreadyActive`, `test_addAdapter_afterForceRemoveSucceeds` · fuzz/behavioural.

---

## 6. Router / portfolio (RTR)

> **`RTR-1` — The router holds zero USDC and zero vault shares after every operation.**
> ✅ PROVEN · `PortfolioRouter.t.sol` (INV-2) · stateful-invariant.

> **`RTR-2` — A multi-leg redemption always targets the holder's actual positions, not merely the current weight vector.**
> ✅ HOLDS (fixed #967, F-03) · `redeemFor` takes an explicit `vaults[]` argument and redeems each leg from the named vault, so the redemption targets the caller's actual positions regardless of the current weight vector · stateful-invariant — `FvInvariants.t.sol::test_RTR2_expectedFail_redeemTargetsActualPositions`.

> **`RTR-3` — Each `sharesPerLeg[i]` is always applied to the vault the caller intended (identity-bound), never to whichever vault occupies index `i` after a reweight.**
> ✅ HOLDS (fixed #967, NC-5) · `sharesPerLeg[i]` binds to `vaults[i]` (the caller-named address, committed to the gateway intent hash), never to `_effectiveWeightsMemory()` — a between-sign reweight can never redirect a leg to an unnamed vault · symbolic (reorder weights between sign and execute) — `FvInvariants.t.sol::test_RTR3_expectedFail_legsAreIdentityBound`.

> **`RTR-4` — A weight vector is never executable unless every weighted vault is simultaneously router-eligible AND `Active` (deposit-able) and the bps sum equals `MAX_BPS`.**
> ✅ HOLDS · `setWeights`/`setDefaultWeights`/`propose` now require `VaultStatus==Active` per weighted vault — a non-depositable vector can never be written (F-05 fixed, #968) · symbolic — `FvInvariants.t.sol::test_RTR4_weightsRequireActiveStatus`.

> **`RTR-5` — `previewDeposit` and the executed deposit never disagree on which legs are available (no preview/execute divergence).**
> ✅ HOLDS · `_executeLegs` skip-and-renormalises exactly the legs `previewDeposit` reports `unavailable` (or both report the whole basket unavailable) — preview-available ⇒ execute-deposits, preview-unavailable ⇒ execute-skips. A single `setVaultStatus(_, DepositsPaused)` no longer bricks *every* router deposit (F-13 / NC-4 fixed, #968). The skip set also drops a leg whose own `maxDeposit` is 0 or reverts, or whose `previewDeposit` of its renormalised amount reverts (a stale price recorder), and re-splits over the survivors until every funded leg quotes (QA plan D4, CS-4) · fuzz (assert preview-available ⇒ execute-succeeds, or both fail) — `FvInvariants.t.sol::test_RTR5_previewMatchesExecute`; `PortfolioRouterLegAvailability.t.sol::test_RTR5_staleRecorderLegIsSkippedNotReverted`, `::test_RTR5_vaultOwnDepositPauseLegIsSkippedNotReverted`, `::test_RTR5_quoteRevertDropsLegAndResplitsUntilStable`.

> **Routing eligibility, stated plainly (context for RTR-4 and RTR-5).** A vault is eligible for routing only when its registry status is `Active` AND its registry router-eligible flag is set AND its `asset()` is the router's USDC (`PortfolioRouter.isRouterEligibleAndActive`). `setWeights` and `_setDefaultWeights` run `_requireActiveAndEligible` on every listed vault, so an ineligible or non-Active vault cannot be listed even at 0 bps and receives 0. At deposit time `_availabilityAndAmounts` skips non-depositable legs and renormalises the full amount pro rata across the remaining legs, so no USDC is left with the router or returned to the user. When no leg is depositable, `_depositTo` reverts `NoWeightsSet` and the revert undoes the USDC pull. Per-vault caps do not renormalise: `_executeLeg` reverts `VaultCapExceeded` for an over-cap leg, and the whole deposit reverts.

> **CLOSED GAP — a vault's own deposit gate is inside the availability check (QA plan D4, CS-4).** ✅ FIXED · `_isDepositable` now also reads the vault's own `maxDeposit` (with the router as receiver), so a deposit pause (`BasketVault.depositsPaused`, the `EMERGENCY_ROLE` `pauseDeposits()`), `shutdown`, retirement, an empty basket, a full TVL cap or an open rmUSDC exclusion reads 0 and the leg is skipped. A reverting `maxDeposit` counts as 0. `_availabilityAndAmounts` then quotes each funded leg with `previewDeposit` at its renormalised amount: a revert (a stale `UniswapV4PriceRecorder`, a reverting adapter read) drops the leg, and the split reruns over the survivors. `previewDeposit` reports these legs `unavailable` and the deposit skips exactly them. What still reverts the whole routed deposit `UsdcLegTransferFailed(vault)`: a leg whose views pass but whose `deposit` reverts, notably the ORA-4 spot-versus-TWAP guard, which `previewDeposit` does not run. The rmAGENT guard is therefore set above the RM pool fee band (400 bps against a 291 bps fee, decision D10), and the basket deploy script refuses `NAV_DEVIATION_BPS * 100 <= poolFee` for any configured pool (E6) · behavioural — `PortfolioRouterLegAvailability.t.sol::test_RTR5_staleRecorderLegIsSkippedNotReverted`, `::test_RTR5_vaultOwnDepositPauseLegIsSkippedNotReverted`, `::test_ORA4_idlePoolDriftInsideFeeBandDoesNotRevertRoutedDeposit`; `DeployAgentTokenVault.t.sol::test_reverts_whenNavDeviationBpsIsNotAboveThePoolFee`.

> **`RTR-6` — A configured cap always bounds the size of a single transaction (per-tx sanity bound), not cumulative exposure.**
> ✅ HOLDS (resolved #971, F-12) · DECISION: `routerCap`/`vaultCap` are DOCUMENTED as per-transaction sanity bounds, not cumulative/windowed exposure limits — a single over-cap `deposit()`/leg reverts, but deposits that *sum* over the cap across calls are allowed by design. Cumulative inflow throttling is the gateway's rolling-window job (GW-4); the router cap deliberately does not duplicate that state (see the `routerCap`/`vaultCap` NatSpec) · fuzz — `FvInvariants.t.sol::test_RTR6_expectedFail_capBoundsCumulativeExposure` (single over-cap reverts; two under-cap deposits summing over the cap both land).

---

## 7. Gateway / agent / idempotency (GW)

> **`GW-1` — The gateway never custodies `rmUSDC` or vault shares across a call frame.**
> ✅ PROVEN · `ShareCustodyInvariantViolated` post-call checks in `depositTo`/`_executeRouterDeposit`; `GatewayRouter.t.sol` · stateful-invariant.

> **`GW-2` — A single `paymentId`/idempotency key never authorizes two materially different execution intents.**
> ✅ PROVEN · the `depositTo` paymentId now folds in `destination` and the per-leg `minSharesPerLeg` vector, so two calls sharing `(orderId, amount, idempotencyKey)` but routing to a different destination — or carrying a different per-leg floor — yield distinct ids and never collide — fixed by **NC-9 (#970)** · `GatewayRouter.t.sol::test_GW2_depositTo_paymentIdBindsDestination` / `test_GW2_depositTo_paymentIdBindsMinSharesPerLeg` · symbolic/behavioural. *Withdraw side (F-15, verified #971):* `withdrawFromRouter`'s paymentId (`GatewayWithdrawOps.routerWithdrawPaymentId`, the linked library that holds the `withdrawFromRouter` body since ADR-0014 §9) binds the full per-leg `sharesPerLeg` vector (plus `vaults`, `totalShares`, and `keccak256(minAssetsPerLeg)`) into the hash, so two withdrawals with equal `totalShares` but different per-leg vectors yield distinct paymentIds — `FvInvariants.t.sol::test_GW2_expectedFail_idempotencyKeyBindsFullIntent`.

> **`GW-3` — An agent can only move funds its owner approved, only to its owner's registered receiver, within policy caps.**
> 🟢 HOLDS · `agents[agent]` policy + `safeTransferFrom(msg.sender,…)` · stateful-invariant.

> **`GW-7` — Every policy an agent owner can set through `setPolicy` is one that owner could also have obtained through authorization.**
> ✅ PROVEN (issue #1476) · one internal validator, `_validatePolicy(caller, p)`, carries the caller-independent shape checks and the caller-dependent rule, and every writer of `agents[...]` calls it (`_authorizeAgentInternal` behind `authorizeAgent`/`revealAuthorization`, and `setPolicy`); `revokeAgent` only deletes. The rule is judged on the caller's role at call time: a caller without `ADMIN_ROLE` must name itself as `shareReceiver` (`ShareReceiverNotAuthorized`), including an owner that held `ADMIN_ROLE` when it authorized and has since lost it. `transferAgentOwnership` writes no policy: its destination must hold `ADMIN_ROLE`, which the caller-dependent rule does not bind, so the stored policy is not checked again · fuzz (`GatewayAgentPolicyAuthorization.t.sol::testFuzz_setPolicy_matchesFreshAuthorization`: setPolicy and a fresh authorization by the same caller agree on success and revert selector) + behavioural.

> **`GW-4` — An agent operation never exceeds the per-window rate-limit cap, and the rate-limit bookkeeping can never itself brick the agent.**
> ✅ HOLDS (prior M-6 fixed; NC-7 fixed #970) · the cap is enforced by `GatewayWindows.accrue` (`WindowCapExceeded` / `WithdrawWindowCapExceeded`), and each side's window is a `GatewayWindows.RollingWindow` ring buffer (`RobotMoneyGateway._depositWindow` / `_withdrawWindow`) bounded by `MAX_WINDOW_ENTRIES` (= `WINDOW_SECONDS`): same-second entries coalesce, expired entries are pruned before every append and their slots are reused, so storage plateaus and the bookkeeping cannot grow into a gas wall. The `WindowBufferFull` guard is unreachable through the public API · behavioural (`RobotMoneyGateway.t.sol::test_rollingWindow_liveCountBoundedAcrossDistinctSeconds`); a long-horizon stateful-invariant handler is still recommended.

> **`GW-5` — Every agent redemption through the gateway always carries a real, caller-meaningful per-leg slippage floor.**
> ✅ HOLDS (fixed #969, F-11) · `RobotMoneyGateway.withdrawFromRouter` takes a `minAssetsPerLeg` vector and forwards it verbatim to `PortfolioRouter.redeemFor` (no more `new uint256[](n)` zero literal) and forwards the real agent deadline (no more `type(uint256).max`); the floor vector is folded into `paymentId` so a replay cannot weaken it · static-guard + behavioural (GatewayRouter.t.sol::test_withdrawFromRouter_realFloor_revertsBelowMinimum, ::test_withdrawFromRouter_floorIsBoundIntoPaymentId; FvInvariants.t.sol::test_GW5_agentRedeemCarriesRealFloor).

> **`GW-6` — A revealed authorization or executed payment is never replayable.**
> 🟢 HOLDS · commit/reveal + `paymentId` consumption · symbolic recommended (tie to GW-2: the replay guard is only as strong as the hash coverage).

---

## 8. Governance / timelock (GOV)

> **`GOV-1` — Fee, quarantine, and other value/lifecycle setters execute only via the timelock (INV-3), never a direct hot-key call.**
> ✅ PROVEN · `DeployTimelock.t.sol` · deploy-assertion.

> **`GOV-2` — A governance action never executes before the minimum execution delay has elapsed.**
> 🟢 HOLDS · `RouterGovernance` min-delay (prior M-9 fix) · symbolic.

> **`GOV-3` — Router weights change only through the timelock.**
> 🟢 HOLDS · `WEIGHT_SETTER_ROLE` is held by `RouterGovernance` alone and the timelock holds its `ADMIN_ROLE`; a weight change is one timelock operation (`apply-receipt`), the one `RouterGovernance.applyReceipt` call that releases the receipt and calls `setWeights` in the same transaction. Issue 1698 deleted the contract's proposal, vote and execute functions with the voter set · deploy-assertion.

> **`GOV-4` — A weight vector that would render router deposits non-executable can never be applied (no self-DoS).**
> ✅ HOLDS · the router rejects any weight vector with a non-eligible-or-non-Active vault (via `router.isRouterEligibleAndActive`), and `apply-receipt` refuses a vector whose vault set differs from the registry's eligible list before anything is sent (F-05 / RTR-4 fixed, #968) · symbolic — `FvInvariants.t.sol::test_GOV4_appliedVectorCannotSelfDosRouter`.

> **`GOV-5` — The timelock/Safe is never the *sole* unrecoverable point of liveness that the admin-floor masks.**
> 🟡 TRUSTED · admin-floor protects the timelock's membership, not the off-chain Safe quorum — see Layer-2 note in the audit doc · documented assumption (not directly FV-able; track operationally).

---

## 9. Adapters (ADP)

> **`ADP-1` — A strategy adapter never executes a `DELEGATECALL` on the NAV/deposit/withdraw path.**
> ✅ PROVEN · `AdapterDelegatecallGuard.t.sol` / `AdapterBytecodeGuard` · static-guard (bytecode scan).

> **`ADP-2` — Only an eligible adapter (allowlisted + codehash-pinned) ever contributes to `totalAssets` or receives/returns funds.**
> ✅ HOLDS (fixed #966, NC-2; NAV side fixed #971, F-14; recovery core 1820) · onboarding, basket family: `BasketVault.addAsset` → `BasketAssetConfigGuard.requireAllowedAdapter` rejects any non-zero adapter whose runtime codehash is not in the ADMIN-approved `adapterCodeHashAllowed` set. The codehash pins the adapter's immutables and its linked `TickMath`, so it subsumes the no-hot-swap-proxy guarantee. The basket swap adapters legitimately DELEGATECALL `TickMath`, so no bytecode scan applies to them. The built-in V3 path (`adapter == address(0)`) routes through the immutable `SWAP_ROUTER` and needs no entry. Onboarding, stable family: `RobotMoneyVault.addAdapter` → `VaultAdapterOps.requireEligible` requires the exact address (`adapterAllowed`), the codehash (`adapterCodeHashAllowed`), and the adapter's own `USDC()`/`VAULT()` to name this vault, and `DeployVault.s.sol` runs the `AdapterBytecodeGuard.requireNoDelegatecall` scan (ADP-1). NAV/withdrawal side (F-14), stable family: `RobotMoneyVault.totalAssets` and `_pullProportional` (through `VaultAdapterOps.pullFromAdapters`) count an entry only when `VaultAdapterOps.isCounted` holds (active AND currently eligible AND no open exclusion record), so an adapter whose eligibility was revoked while still registered-active no longer contributes to NAV nor receives/returns withdrawal flow. What is later recovered from it goes to the exclusion record and is paid to the holders at the moment of exclusion (core 1820), so this is exclusion-not-confiscation. Basket family: revoking a codehash blocks only later `addAsset` calls (`BasketVault.setAdapterCodeHashAllowed`), and a listed asset leaves NAV through `emergencyUnwind` then `removeAsset` · static-guard (`BasketVault.t.sol::test_addAsset_revertsForUnvettedAdapter`, `::test_addAsset_acceptsVettedAdapterAfterApproval`; `BasketVaultV4Venue.t.sol::test_addAsset_revertsUntilTheAdapterCodehashIsAllowed`; `RobotMoneyVault.t.sol::test_addAdapter_revertsWhenAdapterAddressNotAllowed`, `::test_addAdapter_revertsWhenAdapterCodeHashNotAllowed`) + behavioural (`RobotMoneyVault.t.sol::test_ADP2_revokedAdapterExcludedFromNavAndPulls`, `::test_exclusionRecoveryPaidProRataToSnapshot`).

> **`ADP-3` — Adapter emissions/yield always reach the vault and are never stranded on the adapter or routed to an admin.**
> 🟢 HOLDS · `IStrategyAdapter` INV-2; `MorphoAdapter.t.sol` · stateful-invariant.

> **`ADP-4` — An adapter never routes assets to a caller-supplied recipient (INV-1 at the adapter boundary).**
> ✅ PROVEN · `CustodyInvariantGuard.t.sol` (adapter `rescueTokens` deleted) · static-guard.

> **`ADP-5` — Any ERC-20 approval granted to an adapter/router for a swap is always reset to zero after the call.**
> ✅ HOLDS (fixed #971, NC-12) · every basket swap runs through `BasketSwapOps._executeSwap` (the linked library that holds the basket swap code since ADR-0014 §9), which sets `forceApprove(adapter or SWAP_ROUTER, amountIn)` and then an unconditional `forceApprove(_, 0)` on every deposit, sell and unwind swap. `UniswapV3SwapAdapter` and `AerodromeSwapAdapter` do the same to their routers, and `UniswapV4SwapAdapter` grants no allowance: it pulls `amountIn` and settles by transfer. The lending adapters `AaveV3Adapter` and `MorphoAdapter` use `forceApprove(_, amount)` (exact, zeroing) then `forceApprove(_, 0)`; `CompoundV3Adapter` uses `safeIncreaseAllowance` and then zeroes any allowance `supply` left. `RobotMoneyVault` funds an adapter by transfer and then `deploy` (`VaultAdapterOps`), with no allowance. `RobotMoneyGateway` zeroes each router and destination allowance after the call. `PortfolioRouter._executeLeg` approves exactly `legAmount`, which the vault's `deposit` pulls in full, and any failed leg reverts the whole deposit. So no residual allowance can linger across calls · static-guard (assert `forceApprove(_,0)` convention) + fuzz (post-call allowance == 0) — `AaveV3Adapter.t.sol::test_ADP5_deployZeroesAllowance`, `MorphoAdapter.t.sol::test_ADP5_deployZeroesAllowance`; `BasketVault.t.sol::test_routeDeposit_zeroResidualAllowanceAfterSwap`, `::test_sellProportional_zeroResidualAllowanceAfterSwap`, `::test_emergencyUnwindAsset_zeroResidualAllowanceAfterSwap`, `::test_emergencyUnwindAssetWithCap_zeroResidualAllowanceAfterSwap`; `UniswapV4SwapAdapter.t.sol::test_swap_pullsOnlyFromTheCallerAndOnlyTheExactAmount`.

---

## 10. Fees (FEE)

> **`FEE-1` — A charged fee never exceeds the configured maximum (`MAX_EXIT_FEE_BPS`, etc.).**
> 🟢 HOLDS · `RobotMoneyVault.MAX_EXIT_FEE_BPS` and `BasketVault.MAX_EXIT_FEE_BPS` (both 100, 1%) are constants. Each vault reverts `InvalidFee` above its ceiling when it is set up and in `setExitFeeBps`. Every exit computes its fee from `exitFeeBps`: `RobotMoneyVault._withdraw` on the gross, `BasketVault._withdraw` on the realized USDC, and `redeemInKind` on each paid leg (`BasketAssetConfigGuard.payInKind`) · fuzz.

> **`FEE-2` — A fee is always charged on realized proceeds, never on a share-implied gross that can socialize loss to remaining holders.**
> ✅ HOLDS (fixed #971, NC-11) · the two vault families charge the fee two ways. **`RobotMoneyVault._withdraw` (exact):** `_pullProportional` returns the realised USDC (idle applied + genuinely pulled) and reverts (`InsufficientAdapterLiquidity`) if it cannot source the full share-implied gross; `_withdraw` then requires `realizedGross >= grossAssets` before it pays the fee on gross, so the fee can never be funded from other holders' idle USDC by an over-reporting adapter. NAV (hence `grossAssets`) already excludes revoked adapters (ADP-2 / F-14), closing the inflated-share-count vector; ERC-4626 payout parity (`receiver` gets exactly `assets`) is preserved. **`BasketVault._withdraw` (inexact):** the fee is `exitFeeBps` of the USDC `_sellProportional` actually returned (the redeemer's idle share plus the swap proceeds), with no shortfall-revert; `redeemInKind` takes the fee from each paid leg · fuzz (over-reporting-adapter handler) — `FvInvariants.t.sol::test_FEE2_expectedFail_feeChargedOnRealizedProceeds`; `RobotMoneyVault.t.sol::test_FEE2_exitFeeOnRealizedProceeds`, `::test_FEE2_overReportingAdapterCannotSocializeLoss`; `BasketVault.t.sol::test_AZBSK2_redeemReturnsActualWithdrawnAssets`, `::test_redeemInKind_succeedsWhenObserveReverts`.

> **`FEE-3` — Fees never reach any address other than the configured `feeRecipient` (INV-1/INV-3).**
> 🟢 HOLDS · single recipient, timelock-gated · static-guard.

---

## 11. Upgrades & freeze (UPG)

The governed-upgrade and freeze invariants of ADR-0014
(`docs/adr/ADR-0014-governed-upgrades-and-freeze.md`), landed by QA plan v1 task P1 (#1808).
They cover the nine proxied contracts of ADR-0014 §1: `RobotMoneyVault`, `ProtocolAssetVault`,
`AgentTokenVault`, `RwaBasketVault`, `PortfolioRouter`, `VaultRegistry`, `RobotMoneyGateway`,
`InvestmentCommitteePolicy` and `ConsensusRecommendationReceipt`. Each runs behind its own
`ERC1967Proxy` and inherits `contracts/lib/GovernedUpgrade.sol`. The lifecycle tests run once per
contract kind (`GovernedUpgradeLifecycle.t.sol`, one test contract per kind on a shared base).

> **`UPG-1` — A proxied contract is never reachable uninitialized, is never initialized twice, and its implementation is never initializable.**
> ✅ HOLDS (P1, #1808) · every deploy path (`contracts/script/GovernedProxyDeploy.sol::_deployProxy`, `contracts/test/helpers/Proxied.sol`) deploys an `ERC1967Proxy` whose constructor calls `initialize` in the same transaction, so no public call can reach the proxy before it is initialized. `initialize` carries OZ `initializer`, and every implementation's constructor calls `_disableInitializers()`. `_deployProxy` reads the proxy back: implementation slot, zero ERC-1967 admin and beacon slots, authority, frozen bit · deploy-assertion, run for every kind — `GovernedUpgradeLifecycle.t.sol::test_deploy_proxyBornGoverned`, `::test_initialize_cannotReplay`, `::test_implementation_initializersLocked`, `::test_upgradeToAndCall_onImplementationReverts`.

> **`UPG-2` — No address but the upgrade authority (the deployment's timelock) ever upgrades or freezes a proxy: no role holder, the deployer, the Safe acting directly, or `RouterGovernance`.**
> ✅ HOLDS (P1, #1808) · `GovernedUpgrade._authorizeUpgrade` and `freezeUpgrades` revert `UpgradeNotAuthorized(caller)` unless `msg.sender` is the stored authority. No role confers upgrade power: holding `ADMIN_ROLE`, `DEFAULT_ADMIN_ROLE`, `EMERGENCY_ROLE`, `DEPOSIT_PAUSER_ROLE`, `AGENT_ROLE`, `WEIGHT_SETTER_ROLE` or any other role grants none. The only path is Safe → timelock `schedule` → delay → `execute` (`EXECUTOR_ROLE` open), cancellable by the Safe during the delay · symbolic, run for every kind — `GovernedUpgradeLifecycle.t.sol::test_upgrade_onlyTimelock`, `::test_freeze_onlyAuthority`, `::test_governedUpgrade_throughTimelock_keepsState`.

> **`UPG-3` — The upgrade authority is never an EOA and never changes after initialization; a role change never moves it.**
> ✅ HOLDS (P1, #1808) · `__GovernedUpgrade_init` refuses a mode of `Unset` (`UpgradeModeUnset`) and an authority with no code (`UpgradeAuthorityNotContract`), stores the authority once in the ERC-7201 namespace `robotmoney.storage.GovernedUpgrade` (slot `0x5f8c…7600`), and no setter exists. The store is write-once: `__GovernedUpgrade_init` reverts `InvalidInitialization` when an authority is already stored, so a later implementation's `reinitializer(n)` that calls it cannot rotate the authority, and every reinitializer carries `onlyUpgradeAuthority` so only the timelock can run one left pending by an upgrade without `data` (the layout gate fails a production `reinitializer(` without it). `DeployTimelock.runAuthority` deploys the timelock before every proxy, and the handover (`DeployTimelock._requireAuthorityTimelock`, `TIMELOCK_ADDRESS` required on every chain) checks every proxy names it · static-guard, run for every kind — `GovernedUpgradeLifecycle.t.sol::test_initialize_refusesEoaAuthority`, `::test_initialize_refusesUnsetMode`, `::test_governedUpgradeSlot_isPinned`, `::test_freeze_survivesRoleChangesAndReinitializers`; rmUSDC: `::test_reinitializer_cannotRotateUpgradeAuthority`, `::test_reinitializer_pendingAfterEmptyUpgrade_refusesEveryoneButTheTimelock`; `DeployTimelock.t.sol::DeployTimelockForeignTimelockTest`; `scripts/ci/check-storage-layout.sh --selftest` (the reinitializer rule).

> **`UPG-4` — A frozen proxy never upgrades again: the freeze is one-way, and no function, initializer, reinitializer, role change or queued operation clears it or slips past it.**
> ✅ HOLDS (P1, #1808) · `freezeUpgrades` (authority only, through a proxy) sets one bit that nothing unsets; once set, `_authorizeUpgrade` always reverts `UpgradesAreFrozen`, so no later code that could clear it can ever be installed. `UpgradeMode.FrozenAtDeploy` sets the bit inside the deployment transaction. An upgrade queued before the freeze reverts when executed after it. A second freeze reverts · symbolic, run for every kind — `GovernedUpgradeLifecycle.t.sol::test_freeze_throughTimelock_rejectsLaterUpgrade`, `::test_freezeAtDeploy_rejectsUpgrade`, `::test_freeze_queuedUpgradeFailsAfterFreeze`, `::test_freeze_survivesRoleChangesAndReinitializers`.

> **`UPG-5` — A freeze never locks in an implementation other than the one it was reviewed against.**
> ✅ HOLDS (P1, #1808) · `freezeUpgrades(expectedImplementation, expectedCodeHash)` reverts `FreezeTargetMismatch(live, liveCodeHash)` unless the live ERC-1967 implementation and its runtime code hash equal the arguments, so a freeze scheduled for implementation A reverts if an upgrade to B executed between scheduling and executing it · fuzz, run for every kind — `GovernedUpgradeLifecycle.t.sol::test_freeze_wrongTargetReverts`.

> **`UPG-6` — An upgrade or a freeze never pauses, gates or narrows a withdrawal: `redeem`, `withdraw` and `redeemInKind` stay open on a frozen proxy (core 1494).**
> ✅ HOLDS (P1, #1808) · `GovernedUpgrade` adds no pause, no `whenNotFrozen`/`whenFrozen` modifier and no hook on transfers or redemptions; no business function reads the frozen bit. `upgradeToAndCall` swaps the implementation and runs any reinitializer in one transaction, so there is no in-between state that could block a redeem. Every future implementation is bound by the policy of ADR-0014 §6: it may not remove, gate or narrow `redeem`, `withdraw` or `redeemInKind`, nor lower `maxRedeem`/`maxWithdraw` through a pause, status or role (LIFE-3) · stateful-invariant — `GovernedUpgradeLifecycle.t.sol::test_frozenProxyKeepsRedeemAndRedeemInKindOpen`, run for rmUSDC (after a governed upgrade with a reinitializer and a freeze, the holder exits in full through `withdraw` and `redeem`) and for each basket kind (`redeemInKind` and the USDC `redeem` after an upgrade and a freeze). `WithdrawalsNeverFrozen.t.sol` pulls every lever against the proxied vaults.

> **`UPG-7` — An upgrade never moves, retypes or drops existing proxy storage, never changes a storage struct, linked library or OpenZeppelin release unseen, and never loosens a fixed ceiling.**
> ✅ HOLDS (P1, #1808) · `scripts/ci/check-storage-layout.sh` (step "Upgradeable storage-layout gate (ADR-0014)" of `forge-unit-tests`) compares each proxied contract's `forge inspect` layout, struct members, inheritance linearization, linked-library code hashes and OpenZeppelin submodule commits with `contracts/test/fixtures/storage-layout/<Contract>.json`; state may only be appended or taken from a `__gap` (`AdminFloorAccessControlCounter`, `BasketVault`), and `proxied.txt`, the sources and the ADR-0014 §1 table must agree. A struct passed to a linked library is declared once (`BasketAssetConfigGuard.AssetInfo`, `VaultAdapterOps.Book`, `GatewayWindows.RollingWindow`). The ceilings of ADR-0014 §7 are `constant`s, checked by the initializer exactly as by the setters · static-guard — `scripts/ci/check-storage-layout.sh --selftest` (every rule fires on a mutated record); `UpgradeCeilings.t.sol::test_ceilingsNeverLoosened`, `::test_initializerHonoursTheCeiling`.

> **`UPG-8` — An agent consent signed for one gateway implementation version never authorizes a binding on an implementation whose version differs, and an upgrade never rebinds a consent to another address than the proxy.**
> ✅ HOLDS (P3, #1810, QA plan Decisions D5 "bind") · the EIP-712 domain of `AgentConsent` is (`RobotMoneyGateway`, `implementationVersion()`, `block.chainid`, `address(this)`): `_domainSeparator` hashes the same `implementationVersion()` clients read, and `address(this)` is the proxy. An implementation that changes what a consent means returns a new version (ADR-0014 §10), so every consent signed before that upgrade reverts `InvalidAgentConsent` after it; a pure fix keeps the version and its consents. rmpc (`agent-consent`) and the dapp consent check read the live version and never assume `"1"`. A transaction already in flight runs against whatever implementation is live when it lands; rmpc refuses to sign against an implementation whose code hash is not pinned (`gateway_implementation_hashes`) · behavioural (three concrete forge unit tests; a symbolic proof over all versions and consents is not written) — `GatewayImplementationVersion.t.sol::test_implementationVersion_isTheConsentDomainVersion`, `::test_versionBump_invalidatesOutstandingConsent`, `::test_pureFix_keepsOutstandingConsentAndProxyDomain`.

---

## Open items for the FV stack

1. **Extend the custody stateful-invariant handler to the `BasketVault` family**
   (`AgentTokenVault`, `ProtocolAssetVault`, `RwaBasketVault`; covers SUP-1, CUST-4/5).
   `CustodyInvariant.t.sol` drives `RobotMoneyVault` only, and
   `fv/CustodyMultiVault.t.sol` covers the basket family with point tests.
2. **Add a stale-price handler for the basket family** to pin `SUP-5`/`ORA-2`: make
   `observe()` revert on a V3 or Aerodrome pool, or let a `UniswapV4PriceRecorder` go
   stale, and assert that `redeemInKind` and an idle-only `redeem` still pay.
3. **Add a TWAP-manipulation harness** (move spot/observation, assert `ORA-7` floor
   still bounds loss) — the single highest-leverage symbolic property.
   `TwapManipulation.t.sol` models it on a mock source; `RecorderSellAnchor.t.sol`
   drives the V4 leg only.
4. **Deploy-assertions** for `ACL-1` (EOA holds no role) and `ORA-3` (pool equality)
   live in `fv/DeployAssertions.t.sol`. `ORA-6` is retired.
5. **Promote the 🔴 invariants into failing tests first** (red), then fix the code,
   so each remediation is pinned by the invariant it restores.

### Symbolic-tool recommendation (issue #964)

Many entries above carry a `symbolic` strategy (ACL-2/3/4, SUP-2/4, ORA-1/7,
RTR-3/4, GW-2/6, GOV-2/4, CUST-5). Those are exhaustive-over-inputs properties
that Foundry fuzzing only samples. The scout pass (issue #964) lands the
executable spec + 1:1 coverage gate + handler/static scaffolding entirely in
**Foundry** (no new toolchain), so the gate works in CI today.

**Recommendation: adopt [Halmos](https://github.com/a16z/halmos) for the
`symbolic` invariants, deferred to the remediation that first needs an exhaustive
proof (the ORA-7 floor decoupling in #966 is the natural first target).**
Rationale:
- Halmos reuses Foundry test syntax (`check_*` / `test_*` functions, same
  `forge-std` cheatcodes), so a symbolic property sits next to its fuzz sibling in
  `contracts/test/fv/**` with no rewrite — lowest adoption cost of the three.
- Kontrol (KEVM) and Certora are heavier (separate spec language / proof harness,
  longer run times) and are better reserved for a dedicated audit engagement than
  a per-PR CI gate.
- CI placement: run Halmos in the **nightly** sweep (suite-21), not on every PR —
  symbolic runs are minutes-to-hours and would blow the LIGHT-tier budget of
  suite-22. Per-PR keeps the fast fuzz/invariant/coverage gate; nightly adds the
  exhaustive pass.

This is a recommendation only; no symbolic tool is wired in the scout PR.

## Maintenance

- IDs are append-only and stable; never renumber. To retire one, leave a tombstone
  (`~~ID~~ — retired <date>, see <replacement>`).
- When a finding in the audit register is fixed, flip the linked invariant from 🔴 to
  ✅ and name the test that now proves it.
- When a new capability merges, add its invariants here in the same PR, mirroring the
  `agent-ensure-feature.md` discipline.
