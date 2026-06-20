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
- `docs/code-review/external-audit-verification-20260619.md` is the current finding
  register. Invariants marked 🔴 link to the finding that violates them.
- Implementing code is in `contracts/`; current FV lives in `contracts/test/*Invariant*.t.sol`
  (Foundry `StdInvariant` handler-driven) plus the static guard tests
  (`CustodyInvariantGuard`, `AdapterDelegatecallGuard`, `AccessRoles`, `ERC4626PreconditionChecks`).

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
state check).

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
> 🟢 HOLDS · `_decimalsOffset() == 18` on every vault (`RobotMoneyVault`, `BasketVault` and descendants) · fuzz/symbolic recommended.

> **`CUST-6` — Underlying-protocol emissions are always harvested to the vault, never left on the adapter.**
> 🟢 HOLDS · `IStrategyAdapter` INV-2; `MorphoAdapter.t.sol` emission case · stateful-invariant.

---

## 2. Share & supply accounting (SUP)

> **`SUP-1` — The sum of all holders' redeemable assets never exceeds `totalAssets()` (accounting never over-promises).**
> ✅ PROVEN · `CustodyInvariant.t.sol` · stateful-invariant. (Same property as INV-2 redeemability; cross-listed because it is the core solvency check for every vault family, not just RobotMoneyVault — extend the handler to BasketVault/RwaVault/AgentTokenVault/ProtocolAssetVault.)

> **`SUP-2` — `totalSupply` always equals the sum of ERC-20 balances, and shares are never minted without a corresponding asset inflow.**
> 🟢 HOLDS (OZ ERC-4626) · symbolic recommended (zero-asset mint, rounding-to-zero shares).

> **`SUP-3` — A deposit-then-immediate-redeem round trip never returns more than was put in: `previewRedeem(previewDeposit(x)) <= x` for every vault.**
> ✅ HOLDS (fixed #969, NC-6/F-16) · `BasketVault.deposit`/`mint` now mint shares on the REALIZED post-swap NAV delta (capped at the slippage-discounted deposit floor), not a pre-swap TWAP mark, so the mint-vs-haircut asymmetry that let a round trip farm value back out is closed; the NAV-vs-market deviation guard (`ORA-4`) keeps execution inside the band the proof assumes · fuzz (BasketVault.t.sol::test_SUP3_roundTripNeverProfits_fuzz; stateful proof BasketVault.t.sol::test_SUP3_statefulDepositRedeemNeverProfits; FvInvariants.t.sol::test_SUP3_roundTripNeverProfits).

> **`SUP-4` — Rounding always favors the vault (remaining holders), never the transacting account.**
> 🟢 HOLDS (OZ rounding directions) · symbolic recommended; watch the BasketVault `_sellProportional` dust path and cross-asset NAV summation bias.

> **`SUP-5` — A redeem never reverts solely because the vault is paused/retired/shut down when the underlying is already idle USDC (no liveness trap on already-safe funds).**
> ✅ HOLDS (fixed #966, NC-1) · `RwaVault.totalAssets` short-circuits `_checkOracleFreshness` when no priced RWA is held, so idle-USDC redeem survives a stale feed while priced reads still fail closed (ORA-2) · stateful-invariant (StaleOracleRedemption.t.sol::test_SUP5_*; RwaVault.t.sol::test_staleFeed_idleUsdcRedeemSurvives).

> **`SUP-6` — `RmToken` total supply is fixed after deploy (no post-deploy mint).**
> 🟢 HOLDS · dev/testnet only · static-guard. *(Not a mainnet surface; documented for completeness.)*

---

## 3. Oracle & pricing (ORA)

> **`ORA-1` — Spot (`slot0`) is never used for NAV or share pricing; only a TWAP over the configured window is.**
> 🟢 HOLDS · `BasketVault._twapUsdcValue`, PRD §11 · static-guard (assert no `slot0` price read on the NAV path) + symbolic.

> **`ORA-2` — A price-sensitive operation never executes against a Chronicle feed older than the heartbeat (fail-closed).**
> 🟢 HOLDS · `RwaVault._checkOracleFreshness` · stateful-invariant. *Tension:* this is correct for *pricing* but over-applies to user `redeem` — see `SUP-5`/NC-1; the fix must preserve ORA-2 for priced assets while exempting idle-USDC redemption.

> **`ORA-3` — The pool used to derive the pricing TWAP is always the same pool trades execute against (same fee/tickSpacing/hooks).**
> ✅ HOLDS (fixed #966, F-09) · `BasketVault.addAsset` → `BasketAssetConfigGuard.requireExecutionPoolMatchesTwap` reverts `ExecutionPoolMismatch` when the registered TWAP pool's fee tier (V3/V4) or tickSpacing (Aerodrome) does not equal `swapFee_` · deploy-assertion + static-guard (DeployAssertions.t.sol::test_ORA3_addAssetRevertsOnPoolMismatch).

> **`ORA-4` — Deposits/redemptions never settle when the oracle NAV deviates from the executable market price beyond a bounded threshold.**
> ✅ HOLDS (fixed #969, F-10) · `BasketVault` carries a timelock-configured `navDeviationGuardBps` threshold and reverts `NavMarketDeviationExceeded` on the deposit/redeem hot path when the executable market (Aerodrome/Uniswap spot) price diverges from the NAV-pricing TWAP beyond it, halting settlement on a stale/manipulated mark · stateful-invariant (BasketVault.t.sol::test_ORA4_deviationGuardBlocksSettlement; FvInvariants.t.sol::test_ORA4_deviationGuardBlocksSettlement).

> **`ORA-5` — A reported oracle price is always within sane absolute bounds.**
> 🟢 HOLDS (weakly) · `ChronicleOracleAdapter` `MIN_NAV`/`MAX_NAV` (1e12…1e24 — 12 orders wide; catches zero/garbage, not economic deviation) · fuzz.

> **`ORA-6` — The decimals scaling between a priced asset and USDC is always correct for the asset actually configured.**
> 🟡 TRUSTED (deSPXA = 18) · `ChronicleOracleAdapter` hardcodes `1e12`; no `decimals()` read — see **F-17** · deploy-assertion (constructor should assert `decimals()==18 && usdc.decimals()==6`).

> **`ORA-7` — The internal slippage floor on a swap is never derived solely from the same oracle/TWAP that prices the trade (the floor must be an independent backstop).**
> ✅ HOLDS (fixed #966, F-09/F-11/F-16) · with the ORA-3 pool-equality enforced (execution pool == TWAP pool) and the codehash-pinned adapter, realized loss under TWAP manipulation is bounded by the configured, TWAP-independent `maxSlippageBps`/pool-fee floor rather than the co-manipulable NAV TWAP alone · fuzz (TwapManipulation.t.sol::test_ORA7_independentFloorBoundsLossUnderManipulation).

---

## 4. Access control & roles (ACL)

> **`ACL-1` — In production, no EOA ever holds any privileged role (`DEFAULT_ADMIN_ROLE`, `ADMIN_ROLE`, `EMERGENCY_ROLE`, `PAUSER_ROLE`) after deployment handover.**
> ✅ PROVEN · REMEDIATED (#965, **F-01**): `DeployTimelock` now hands the Gateway `DEFAULT_ADMIN_ROLE` (alongside `ADMIN_ROLE`) to the Timelock and moves every vault `EMERGENCY_ROLE` to an independent hot key, revoking all four privileged roles from the deployer EOA; the Gateway constructor redirects `AGENT_ROLE`'s admin to `ADMIN_ROLE` and `authorizeAgent` is now `ADMIN_ROLE`-gated, so the revoke does not brick agent onboarding (fix-interaction warning) · deploy-assertion (`DeployAssertions.t.sol::test_ACL1_*`, `DeployTimelock.t.sol::test_ACL1_*` — EOA holds *no* role; negative test pins the naked-revoke regression).

> **`ACL-2` — No single address ever simultaneously holds two of {ADMIN-tier, PAUSER, AGENT}.**
> ✅ PROVEN · `AccessRoles._grantRole` separation override; `AccessRoles.t.sol` · symbolic recommended. *Watch:* this same override enables a grant-DoS during handover — see **NC-10** (`ACL-7`).

> **`ACL-3` — `ADMIN_ROLE` membership on any fund-holding contract never reaches zero (no permanent governance brick).**
> ✅ HOLDS (fixed #966, F-06) · `BasketVault` (→ `RwaVault`/`AgentTokenVault`/`ProtocolAssetVault`) enforces a manual last-admin floor in its `_grantRole`/`_revokeRole` hooks; the gateway enforces the same floor for both `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE`. (Lightweight counters, not `AccessControlEnumerable`, to respect the vaults' EIP-170 limit and the gateway's storage layout.) · symbolic (BasketVault.t.sol / RobotMoneyGateway.t.sol last-admin-floor tests).

> **`ACL-4` — An agent's owner is never reassigned; no caller can hijack an existing agent.**
> ✅ PROVEN-by-code · `_authorizeAgentInternal` reverts `AgentAlreadyOwned`; `setPolicy`/`revokeAgent` require `agentOwner[agent]==msg.sender` · symbolic recommended.

> **`ACL-5` — An emergency-role action can only de-risk; it never moves value to an external party or settles at an unverifiable price.**
> ✅ HOLDS (fixed #966, F-08) · `RwaVault.setEmergencyUnwindStaleOverride` is now `ADMIN_ROLE` (a higher tier) while `emergencyUnwind` stays `EMERGENCY_ROLE`, so a single emergency hot key can no longer both arm stale pricing and dump the basket against it · static-guard + stateful-invariant (RwaVault.t.sol::test_emergencyUnwindStaleOverride_requiresAdminNotEmergency).

> **`ACL-6` — Depositor principal is only ever moved by the depositor (or her authorized agent on her behalf); no privileged role can move a third party's funds.**
> ✅ PROVEN · every gateway flow pulls USDC from `msg.sender`; this is why F-01 is governance-capture, not theft · stateful-invariant (already implied by GW-1/GW-3).

> **`ACL-7` — Registering an agent never blocks a future intended ADMIN/PAUSER address from being granted its role.**
> 🔴 VIOLATED (handover window) · permissionless `commitAuthorization` + the ACL-2 separation override lets a griefer pre-bind a known multisig address as AGENT — see **NC-10** · deploy-assertion (assert role-target addresses are AGENT-free before granting).

---

## 5. Lifecycle & state machine (LIFE)

> **`LIFE-1` — A retired vault never accepts new deposits, on every entry path (direct and router), with the registry status and the vault flag always in sync.**
> ✅ HOLDS · atomic `VaultRegistry.retire()`/`reactivate()` sync both, `_deposit` reverts on `retired`, and `setVaultStatus(_, Retired/Paused/Active)` now drives the vault deposit-halt flag too — the back-door is closed (F-04 fixed, #968) · stateful-invariant (drive both setters, assert no drift) — `FvInvariants.t.sol::test_LIFE1_retireSyncsRegistryAndVaultFlag`.

> **`LIFE-2` — A registered vault is never removed from `listVaults()`, so existing positions are always re-discoverable and re-redeemable.**
> 🟢 HOLDS · `VaultRegistry._vaults` is append-only (no deregister) · static-guard + stateful-invariant.

> **`LIFE-3` — Vault shutdown never blocks withdrawals (it disables deposits only).**
> ✅ HOLDS (fixed #966, NC-3/F-06) · `BasketVault._withdraw` is no longer `whenNotPaused`; `pause()` is a deposits-only freeze (matching `RobotMoneyVault`'s separate flag), so a low-trust `EMERGENCY_ROLE` key can never freeze withdrawals · stateful-invariant (BasketVault.t.sol::test_pause_doesNotFreezeWithdrawals).

> **`LIFE-4` — Depositor funds are never *permanently* frozen: any state that blocks withdrawal is always reversible by a still-available authority.**
> ✅ HOLDS (fixed #966, F-06 + NC-3) · withdrawals are never paused (LIFE-3) and the last-admin floor (ACL-3) guarantees a still-available `ADMIN_ROLE` authority, so no reachable state freezes withdrawals forever · symbolic. *(`restoreVault`/F-07 is a separate `shutdownVault` reversibility concern, out of this issue's scope.)*

> **`LIFE-5` — A reweight/removal of a vault never makes an existing holder's position unredeemable through the protocol.**
> ✅ HOLDS (fixed #967, F-03) · `redeemFor` (and `gateway.withdrawFromRouter`) drive redeem legs from an explicit caller-supplied `vaults[]`, not the live weight vector, and `_redeemLeg` permits Active OR Retired (only Paused blocks) — a reweighted-out or Retired position stays redeemable through the router · stateful-invariant — `FvInvariants.t.sol::test_LIFE5_expectedFail_reweightKeepsPositionRedeemable`.

> **`LIFE-6` — `reabsorbRemovedAsset` never reverts-and-strands a reappeared balance (INV-2 must survive a degraded pool).**
> 🔴 VIOLATED (risk) · reuses `assetInfo.pool` TWAP with no staleness/liquidity recheck; `observe()` can revert and brick reabsorption — see **F-17 / NC-8** · fuzz (degraded-pool handler).

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
> ✅ HOLDS · `_executeLegs` skip-and-renormalises exactly the legs `previewDeposit` reports `unavailable` (or both report the whole basket unavailable) — preview-available ⇒ execute-deposits, preview-unavailable ⇒ execute-skips. A single `setVaultStatus(_, Paused)` no longer bricks *every* router deposit (F-13 / NC-4 fixed, #968) · fuzz (assert preview-available ⇒ execute-succeeds, or both fail) — `FvInvariants.t.sol::test_RTR5_previewMatchesExecute`.

> **`RTR-6` — A configured cap always bounds cumulative exposure, not just a single transaction.**
> 🔴 VIOLATED (if intended as exposure limit) · `routerCap`/`vaultCap` are per-tx only; splittable — see **F-12** · fuzz. *(Downgrade to "documented as per-tx sanity bound" closes this instead.)*

---

## 7. Gateway / agent / idempotency (GW)

> **`GW-1` — The gateway never custodies `rmUSDC` or vault shares across a call frame.**
> ✅ PROVEN · `ShareCustodyInvariantViolated` post-call checks in `depositTo`/`_executeRouterDeposit`; `GatewayRouter.t.sol` · stateful-invariant.

> **`GW-2` — A single `paymentId`/idempotency key never authorizes two materially different execution intents.**
> 🔴 VIOLATED · `depositTo` paymentId omits `destination`+`minSharesPerLeg`; `withdrawFromRouter` uses summed `totalShares`, not the per-leg vector — see **F-15 / NC-9** · symbolic (two distinct intents → same id).

> **`GW-3` — An agent can only move funds its owner approved, only to its owner's registered receiver, within policy caps.**
> 🟢 HOLDS · `agents[agent]` policy + `safeTransferFrom(msg.sender,…)` · stateful-invariant.

> **`GW-4` — An agent operation never exceeds the per-window rate-limit cap, and the rate-limit bookkeeping can never itself brick the agent.**
> 🟡 PARTIAL · cap enforced (prior M-6 fixed) but `_depositWindowEntries`/`_withdrawWindowEntries` grow unbounded → eventual gas-wall self-DoS — see **NC-7** · stateful-invariant (long-horizon handler) / fuzz.

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

> **`GOV-3` — Vote weight is always taken from a snapshot; the same stake never votes twice.**
> 🟢 HOLDS · snapshot voting (prior M-10 fix) · stateful-invariant.

> **`GOV-4` — A governance proposal that would render router deposits non-executable can never be executed (no self-DoS).**
> ✅ HOLDS · `propose` now rejects any weight vector with a non-eligible-or-non-Active vault (via `router.isRouterEligibleAndActive`), so a self-DoS proposal never enters the voting pipeline (F-05 / RTR-4 fixed, #968) · symbolic — `FvInvariants.t.sol::test_GOV4_proposalCannotSelfDosRouter`.

> **`GOV-5` — The timelock/Safe is never the *sole* unrecoverable point of liveness that the admin-floor masks.**
> 🟡 TRUSTED · admin-floor protects the timelock's membership, not the off-chain Safe quorum — see Layer-2 note in the audit doc · documented assumption (not directly FV-able; track operationally).

---

## 9. Adapters (ADP)

> **`ADP-1` — A strategy adapter never executes a `DELEGATECALL` on the NAV/deposit/withdraw path.**
> ✅ PROVEN · `AdapterDelegatecallGuard.t.sol` / `AdapterBytecodeGuard` · static-guard (bytecode scan).

> **`ADP-2` — Only an eligible adapter (allowlisted + codehash-pinned) ever contributes to `totalAssets` or receives/returns funds.**
> ✅ HOLDS (fixed #966, NC-2) · `BasketVault.addAsset` → `BasketAssetConfigGuard.requireAllowedAdapter` rejects any non-zero adapter whose runtime codehash is not on the ADMIN-approved allowlist (codehash pinning subsumes the no-hot-swap-proxy guarantee; the basket swap adapters legitimately DELEGATECALL the linked `TickMath`, so the deploy-time no-proxy scan stays in `AdapterBytecodeGuard`) · static-guard (BasketVault.t.sol::test_addAsset_revertsForUnvettedAdapter). *(The `RobotMoneyVault` revoked-but-active F-14 strand is tracked separately.)*

> **`ADP-3` — Adapter emissions/yield always reach the vault and are never stranded on the adapter or routed to an admin.**
> 🟢 HOLDS · `IStrategyAdapter` INV-2; `MorphoAdapter.t.sol` · stateful-invariant.

> **`ADP-4` — An adapter never routes assets to a caller-supplied recipient (INV-1 at the adapter boundary).**
> ✅ PROVEN · `CustodyInvariantGuard.t.sol` (adapter `rescueTokens` deleted) · static-guard.

> **`ADP-5` — Any ERC-20 approval granted to an adapter/router for a swap is always reset to zero after the call.**
> 🟡 PARTIAL · BasketVault/gateway/router zero approvals; `AaveV3Adapter`/`MorphoAdapter` use non-zeroing `safeIncreaseAllowance` — see **NC-12** · static-guard (assert `forceApprove(_,0)` convention) + fuzz (post-call allowance == 0).

---

## 10. Fees (FEE)

> **`FEE-1` — A charged fee never exceeds the configured maximum (`MAX_EXIT_FEE`, etc.).**
> 🟢 HOLDS · per-vault `MAX_*_BPS` clamps · fuzz.

> **`FEE-2` — A fee is always charged on realized proceeds, never on a share-implied gross that can socialize loss to remaining holders.**
> 🔴 VIOLATED (risk) · `RobotMoneyVault._withdraw` computes fee on share-implied gross; an over-reporting adapter makes the fee come from others' idle USDC — see **NC-11** · fuzz (over-reporting-adapter handler).

> **`FEE-3` — Fees never reach any address other than the configured `feeRecipient` (INV-1/INV-3).**
> 🟢 HOLDS · single recipient, timelock-gated · static-guard.

---

## Open items for the FV stack

1. **Extend the custody stateful-invariant handler beyond `RobotMoneyVault`** to
   `BasketVault`, `RwaVault`, `AgentTokenVault`, `ProtocolAssetVault` (covers SUP-1,
   CUST-4/5).
2. **Add a stale-oracle handler** for RwaVault to pin `SUP-5`/`ORA-2` (NC-1) once the
   freshness short-circuit lands.
3. **Add a TWAP-manipulation harness** (move spot/observation, assert `ORA-7` floor
   still bounds loss) — the single highest-leverage symbolic property.
4. **Add deploy-assertions** for `ACL-1` (EOA holds no role) and `ORA-3`/`ORA-6`
   (pool-equality, decimals).
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
