# External Audit Verification — Multi-Contract Lifecycle Review — 2026-06-19

**Scope:** Independent source-level verification of an external smart-contract
audit ("Robot Money 智能合约审计报告", 2026-06-19) whose focus was *multi-contract
linkage* — the gateway ↔ router ↔ registry ↔ vault ↔ adapter ↔ oracle ↔
governance ↔ timelock control flow — rather than single-contract drains. The
external report raised 1 High, 9 Medium, 5 Low, and 4 Info findings (F-01 … F-19).

**HEAD commit:** `e8712ae37e435f5bb82b7017b5079f735817142c` (branch `dev`).

**Prior audits:**
[`smart-contract-holistic-review-20260618.md`](./smart-contract-holistic-review-20260618.md),
[`smart-contract-vulnerability-audit-20260609.md`](./smart-contract-vulnerability-audit-20260609.md),
[`confused-deputy-access-control-audit-20260602.md`](./confused-deputy-access-control-audit-20260602.md).

**Method:** Every substantive finding (F-01 … F-18) was independently re-checked
against HEAD source. For each, the cited file was read at the named symbol (line
numbers in the external report were treated as advisory and re-derived from the
current source), the actual code quoted, and the claim graded
**CONFIRMED / PARTIAL / MITIGATED / REFUTED**. F-19 is a meta-comment on Slither
output and is not separately gradable. Verification was fanned out across four
reviewer passes (access-control/deploy, router/registry lifecycle, gateway,
oracle/adapter/NAV); each finding's verdict cites the symbol it was checked
against.

---

## Headline verdict

**17 of the 18 substantive findings reproduce against HEAD. One (F-04) rests on a
stale premise and is largely already fixed.** The external auditor's core judgment
is sound: there is no unauthenticated EOA fund-drain — the single-contract defenses
(1e18 offset, TWAP-over-spot NAV, custody invariants, dual eligibility checks,
permissionless quarantine/reabsorb) hold. The real surface is **lifecycle state
composed across contracts** and **where privileged roles actually land after
deployment**.

Two corrections to the external report's framing:

1. **F-01 (High) holds, but is narrower than stated.** Only the **Gateway** leaves
   a live `DEFAULT_ADMIN_ROLE` on the deployer EOA; the four `AdminFloor`/vault
   contracts call `_setRoleAdmin(ROLE, ADMIN_ROLE)` and never grant
   `DEFAULT_ADMIN_ROLE` to anyone, so there is no orphaned root there. The
   `EMERGENCY_ROLE`-never-handed-over half is fully correct across all vaults.
   Still a real High; just localized to **Gateway `DEFAULT_ADMIN_ROLE` + vault
   `EMERGENCY_ROLE` handover**.

2. **F-04 (Medium) is mostly mitigated.** The external report's premise — that the
   unified atomic `retire` was "decided but unimplemented (#929)" — is stale. It
   shipped (#933/#958): `VaultRegistry.retire()` sets registry status **and** calls
   `vault.retire()` atomically, and `RobotMoneyVault._deposit` now reverts on
   `retired`. The headline "new money flows into a retired vault" drift is closed.
   The residual is narrower (a `setVaultStatus` back-door + Paused not synced), so
   F-04 should drop in both scope and priority.

Posture is consistent with the 2026-06-18 holistic review: the items below are
in-trust-model hardening and lifecycle-composition gaps, **not** blockers to the
documented trust model — except **F-01**, which is a stated mainnet hard gate.

---

## Severity summary

| ID | Title | Sev | Verdict | Primary location |
|---|-------|-----|---------|------------------|
| F-01 | Timelock handover incomplete; deployer EOA stays Gateway root + holds vault EMERGENCY_ROLE | **High** | ✅ CONFIRMED (sub-claim partial) | `gateway/RobotMoneyGateway.sol`, `gateway/AccessRoles.sol`, `script/DeployTimelock.s.sol`, `script/Deploy.s.sol` |
| F-02 | Router redeem leg requires `Active`, conflicting with Retired="withdraw-only" | Med | ✅ CONFIRMED | `PortfolioRouter.sol` `_redeemLeg` |
| F-03 | Router redeem iterates the live weight vector, not balances → reweighted-out legs unreachable | Med | ✅ CONFIRMED | `PortfolioRouter.sol` `redeemFor` |
| F-04 | registry status ↔ vault flags drift independently | Med | ⚠️ PARTIAL / mostly MITIGATED | `RobotMoneyVault.sol` `_deposit`, `VaultRegistry.sol` |
| F-05 | Governance can write a non-depositable weight vector (`setWeights` no status check) | Med | ✅ CONFIRMED | `PortfolioRouter.sol` `setWeights` |
| F-06 | admin-floor protection inconsistent; vaults/gateway brickable by revoking last admin | Med | ✅ CONFIRMED | `RobotMoneyVault.sol`, `vaults/BasketVault.sol`, `gateway/AccessRoles.sol` |
| F-07 | `BasketVault`/`RwaVault` `shutdownVault` irreversible (no restore) | Med | ✅ CONFIRMED | `vaults/BasketVault.sol` |
| F-08 | `RwaVault` stale-override + unwind under one EMERGENCY_ROLE key | Med | ✅ CONFIRMED | `vaults/RwaVault.sol` |
| F-09 | TWAP quote pool may mismatch execution pool (UniV4 + Aerodrome) | Med | ✅ CONFIRMED | `adapters/UniswapV4SwapAdapter.sol`, `adapters/AerodromeSwapAdapter.sol`, `vaults/BasketVault.sol` `addAsset` |
| F-10 | RWA vault lacks Chronicle-NAV vs market deviation guard | Med | ✅ CONFIRMED | `vaults/RwaVault.sol`, `adapters/ChronicleOracleAdapter.sol` |
| F-11 | Gateway zeroes router per-leg floor + disables deadline for all agent redemptions | Low | ✅ CONFIRMED | `gateway/RobotMoneyGateway.sol` `_executeRouterWithdraw` |
| F-12 | Router cap is per-tx only; splittable; gross-vs-per-leg bases differ | Low | ✅ CONFIRMED | `PortfolioRouter.sol` |
| F-13 | Router deposit all-or-revert; diverges from `previewDeposit`'s skip semantics | Low | ✅ CONFIRMED | `PortfolioRouter.sol` `_executeLegs` / `previewDeposit` |
| F-14 | Revoked-but-active adapter still trusted for NAV + redemption | Low | ✅ CONFIRMED | `RobotMoneyVault.sol` `totalAssets` / `_pullProportional` |
| F-15 | Gateway idempotency hash omits execution-critical fields | Low | ✅ CONFIRMED | `gateway/RobotMoneyGateway.sol` |
| F-16 | NAV trusts subcomponent prices; BasketVault marks by TWAP not fill | Info | ✅ CONFIRMED | `RobotMoneyVault.sol`, `adapters/MorphoAdapter.sol`, `vaults/BasketVault.sol` |
| F-17 | Chronicle adapter hardcodes 18-dec scaling; `reabsorbRemovedAsset` reuses stale pool | Info | ✅ CONFIRMED | `adapters/ChronicleOracleAdapter.sol`, `vaults/BasketVault.sol` |
| F-18 | Upstream health monitor is interface-only stub | Info | ✅ CONFIRMED | `interfaces/IUpstreamMonitor.sol` |
| F-19 | Slither items mostly known/low-risk | Info | — (meta, not graded) | various |

---

## Verification detail

### F-01 (High) — Timelock handover incomplete — **CONFIRMED** (one sub-claim partial)

Verified against `gateway/AccessRoles.sol` (`abstract contract AccessRoles is
AccessControl`), `gateway/RobotMoneyGateway.sol` (`is AccessRoles`; constructor
`_grantRole(DEFAULT_ADMIN_ROLE, admin_)` + `_grantRole(ADMIN_ROLE, admin_)`;
`authorizeAgent` gated `onlyRole(DEFAULT_ADMIN_ROLE)`), `script/DeployTimelock.s.sol`
(`_deployAndWire` only `grantRole(ADMIN_ROLE, timelock)` / `revokeRole(ADMIN_ROLE,
msg.sender)`; every post-handover assertion checks **ADMIN_ROLE only**), and
`script/Deploy.s.sol` (grants vault `EMERGENCY_ROLE` to `d.admin`, never transferred).

- `_setRoleAdmin` is **never called** in the gateway or `AccessRoles` → every role's
  admin defaults to `DEFAULT_ADMIN_ROLE`.
- Consequences hold exactly: deployer EOA keeps Gateway `DEFAULT_ADMIN_ROLE` (→ can
  `grantRole(ADMIN_ROLE,…)` and `authorizeAgent`); the Timelock holds only
  `ADMIN_ROLE` so it **cannot** `authorizeAgent` or rotate roles on the Gateway;
  deployer keeps every vault `EMERGENCY_ROLE` (pause/shutdown/forceRemove, no delay);
  the "no EOA holds admin" assertion only covers `ADMIN_ROLE`.
- **Sub-claim correction (PARTIAL):** the four non-gateway contracts
  (`RobotMoneyVault`, `BasketVault`, `VaultRegistry`, `PortfolioRouter`,
  `RouterGovernance`) call `_setRoleAdmin(ROLE, ADMIN_ROLE)` and never grant
  `DEFAULT_ADMIN_ROLE`, so there is no orphaned root there. The finding is
  materially the **Gateway `DEFAULT_ADMIN_ROLE`** + **all-vault `EMERGENCY_ROLE`**
  handover gap.

**Remediation:** In `DeployTimelock`, also grant `DEFAULT_ADMIN_ROLE` to the timelock
and revoke it from the deployer on the Gateway (or `_setRoleAdmin(*, ADMIN_ROLE)` +
move `authorizeAgent` to `ADMIN_ROLE`); transfer/renounce every vault's
`EMERGENCY_ROLE` to an independent hot key; broaden the assertions to "EOA holds no
privileged role." **Mainnet hard gate.**

### F-02 (Med) — Router redeem requires `Active` — **CONFIRMED**

`PortfolioRouter._redeemLeg` does `if (vaultStatus != VaultStatus.Active) revert
VaultNotActive(...)`; `VaultRegistry` enum comment promises Retired = "withdraw-only
… redeem at any time." Combined with `redeemFor`'s all-or-revert loop, any
Retired/Paused leg fails the whole router/gateway redemption.
**Mitigation present:** `RobotMoneyVault._withdraw` gates only on `withdrawalsPaused`
— a holder of vault receipts can `redeem()` directly at any time, so funds are not
trapped; the router-mediated path is the broken one.
**Remediation:** allow `Active` **or** `Retired` in `_redeemLeg`.

### F-03 (Med) — Redeem iterates live weight vector — **CONFIRMED**

`redeemFor` sources legs from `_effectiveWeightsMemory()` and enforces
`sharesPerLeg.length == n`, not the holder's balances or `registry.listVaults()`.
After governance reweights/removes a vault, its shares are unreachable via the
router (direct `vault.redeem()` still works).
**Remediation:** drive legs from `registry.listVaults()` or an explicit
caller-supplied `vaults[]`.

### F-04 (Med) — registry/vault flag drift — **PARTIAL / mostly MITIGATED**

The external premise is stale: the unified atomic retire shipped (#933/#958).
`RobotMoneyVault._deposit` now reverts on `depositsPaused || shutdown || retired`,
and `VaultRegistry.retire()` sets registry status **and** calls
`IRetirableVault(vault).retire()` atomically — closing "new money into a retired
vault." **Residual drift that still reproduces:**
- `setVaultStatus(vault, Retired)` sets only registry status without flipping the
  vault `retired` flag — a back-door around the atomic path.
- `setVaultStatus(vault, Paused)` does not pause the vault; direct deposits continue.
- registry `Active` + `vault.shutdown==true` → router's all-or-revert deposit reverts
  the whole basket (one vault breaks the basket).
**Remediation:** route all transitions through `retire()` / have `setVaultStatus`
drive the vault flag; skip-and-renormalise non-depositable router legs (see F-13).
Severity arguably Low now.

### F-05 (Med) — `setWeights` writes non-depositable vector — **CONFIRMED**

`setWeights` validates registration + `_requireRouterEligible` (asset==USDC +
eligibility flag) + bps sum, but never `VaultStatus == Active`. Eligibility and
status are independent signals, so an eligible-but-Paused/Retired vault can be
written; subsequent `deposit()` reverts at `_executeLegs` (`VaultNotActive`) — a
self-DoS, made reachable by the ≥2h vote+delay window. **Remediation:** require
`VaultStatus == Active` per weighted vault in `setWeights`/`setDefaultWeights`.

### F-06 (Med) — admin-floor inconsistent — **CONFIRMED**

`AdminFloorAccessControl._revokeRole` enforces the last-admin floor
(`getRoleMemberCount(role) == 1 → revert LastAdminFloor`). Inherited only by
`VaultRegistry`, `PortfolioRouter`, `RouterGovernance`. `RobotMoneyVault`,
`BasketVault` (→ `RwaVault`), and the Gateway (via `AccessRoles`) use plain
`AccessControl`, so revoking/renouncing the last `ADMIN_ROLE` permanently bricks
governance. **Remediation:** have the vaults + gateway inherit
`AdminFloorAccessControl` (gateway must also guard `DEFAULT_ADMIN_ROLE`).

### F-07 (Med) — `shutdownVault` irreversible on basket family — **CONFIRMED**

`BasketVault.shutdownVault()` (`onlyRole(EMERGENCY_ROLE)`, sets `shutdown=true;
tvlCap=0`) has no inverse anywhere in BasketVault/RwaVault, whereas
`RobotMoneyVault` pairs `shutdownVault` with `restoreVault(...)`
(`onlyRole(ADMIN_ROLE)`). A compromised low-trust hot key can permanently disable
deposits. **Remediation:** add an `ADMIN_ROLE`-gated `restoreVault` to BasketVault.

### F-08 (Med) — RwaVault stale-override + unwind one key — **CONFIRMED**

`setEmergencyUnwindStaleOverride` and both `emergencyUnwind` /
`emergencyUnwindWithOverride` are all `onlyRole(EMERGENCY_ROLE)`; when the override
is set, the unwind path skips `_checkOracleFreshness()`. The same single hot key can
enable stale unwinding and execute it, selling RWA at an unverifiable NAV with no
timelock/quorum. **Remediation:** gate the override (or the stale unwind) behind
`ADMIN_ROLE`/timelock so a higher-trust authority enables it.

### F-09 (Med) — TWAP pool ≠ execution pool — **CONFIRMED**

UniV4 `twapPrice` checks only `checkPoolPair(pool, base, quote)` (token pair); `swap`
builds an independent `PoolKey` from `fee`+tokens with `hooks: address(0)` and never
cross-checks the TWAP `pool`. Aerodrome `twapPrice` validates its own pool is
canonical for its tickSpacing, but `swap` resolves the execution pool from
`int24(swapFee_)` and never asserts it equals the registered TWAP `pool`.
`BasketVault.addAsset` validates pair/cardinality/observe/liquidity but **not** that
`swapFee_` matches `pool_`. So a deep-honest TWAP pool can coexist with a thin
execution pool (or vice versa). **Remediation:** add a config-validation interface
asserting execution-pool == TWAP-pool (incl. fee/tickSpacing/hooks), enforced in
`addAsset`, covering both adapters.

### F-10 (Med) — no NAV-vs-market deviation guard — **CONFIRMED**

`RwaVault._checkOracleFreshness` checks only heartbeat staleness; the Chronicle
adapter checks only extreme bounds (`MIN_NAV=1e12 … MAX_NAV=1e24`). Nothing compares
Chronicle NAV to the tradeable Aerodrome price, while swaps execute at market and
shares mint/value at NAV. **Remediation:** add a bounded NAV-vs-market-TWAP deviation
check; over-threshold → pause or emergency-unwind-only.

### F-11 (Low) — Gateway opts out of router floor/deadline — **CONFIRMED**

`_executeRouterWithdraw` calls `redeemFor(..., new uint256[](n),
type(uint256).max)` — all-zero per-leg floor + disabled deadline — for every agent
redemption. The router *does* implement a per-leg `SlippageExceeded` floor + deadline
usable by direct callers; the gateway never forwards them (the agent's own deadline
is enforced upstream, so deadline risk is partly mitigated; slippage is not).
**Remediation:** add `minAssetsPerLeg[]` to the gateway withdraw ABI, forward it, and
fold it into the intent hash (see F-15).

### F-12 (Low) — caps per-tx only — **CONFIRMED**

`routerCap` compares the gross `amount`; `vaultCap` compares per-leg `legAmount`. No
cumulative/windowed accounting → splitting into N txs (same block) bypasses both, and
the comparison bases differ. **Remediation:** add per-vault windowed accounting if
caps are meant as exposure limits; else document as per-tx sanity bounds.

### F-13 (Low) — execute all-or-revert vs preview skip — **CONFIRMED**

`_executeLegs` rechecks Active/cap/eligibility/slippage per leg and reverts the whole
tx on any failure, while `previewDeposit` marks failing legs `unavailable` and
continues. Preview and execute semantics diverge. **Remediation:** make execute
skip-and-renormalise consistent with preview, or make preview flag the whole basket.

### F-14 (Low) — revoked-but-active adapter still trusted — **CONFIRMED**

`totalAssets` and `_pullProportional` iterate solely on the `active` flag; hard
eligibility is enforced only on `addAdapter`/admin-rebalance. `setAdapterAllowed(false)`
/ codehash revoke does not stop an active adapter — its `totalAssets()` still counts
toward NAV and `withdraw()` is still called during the revoke→drain→remove window
(the code comment confirms this is intended). **Remediation:** skip ineligible
adapters in NAV/pull, or atomically pause deposits + exclude-from-NAV on revoke.

### F-15 (Low) — idempotency hash omits fields — **CONFIRMED**

`depositTo` paymentId omits `destination` and `minSharesPerLeg`;
`withdrawFromRouter` paymentId includes only summed `totalShares`, not the per-leg
`sharesPerLeg` vector. Distinct execution intents under one orderId/idempotencyKey
collide. **Remediation:** fold `destination`, `keccak256(minSharesPerLeg)`,
`keccak256(sharesPerLeg)` into the respective hashes.

### F-16 (Info) — NAV trusts subcomponents; TWAP-mark mint — **CONFIRMED**

`RobotMoneyVault.totalAssets` sums `adapter.totalAssets()` with no per-block delta
cap; `MorphoAdapter` reports live `convertToAssets`; `BasketVault.previewDeposit`
mints at a TWAP/NAV mark with a slippage floor (symmetric on redeem). The 1e18 offset
stops first-deposit inflation but not subcomponent value swings. **Remediation
(optional):** per-block NAV-delta bound and a `previewRedeem(previewDeposit(x)) <= x`
invariant test.

### F-17 (Info) — hardcoded decimals + reabsorb pool reuse — **CONFIRMED**

`ChronicleOracleAdapter` hardcodes `1e12 = 10^(18-6)` and never reads
`RWA_TOKEN.decimals()` (safe only while deSPXA=18). `BasketVault.reabsorbRemovedAsset`
reuses `assetInfo.pool` TWAP with no staleness/cardinality/liquidity recheck → a
degraded pool's `observe()` can revert and brick reabsorption. **Remediation:** read
`decimals()` dynamically; wrap the reabsorb TWAP read with a quarantine fallback.

### F-18 (Info) — upstream monitor is a stub — **CONFIRMED**

`interfaces/IUpstreamMonitor.sol` is an interface only (documented stub, #702); no
implementation or wiring into vault/gateway circuit-breaking exists. Upstream anomalies
rely on manual admin/emergency response. **Remediation:** implement and wire into
registry status / gateway pause / adapter eligibility when prioritized.

### F-19 (Info) — Slither triage — not separately graded

Meta-observation that Slither output is mostly known patterns (strict equality,
calls-in-loop, timestamp, unused-return, reentrancy-events on `nonReentrant` paths).
Consistent with the 2026-06-09/06-18 triage; no new action beyond annotate/suppress.

---

## Test-coverage gaps (confirmed zero cross-contract coverage)

The external report's coverage gaps reproduce — these multi-contract lifecycle
combinations have no regression tests:

- Redeem through router/gateway from a `Retired`/`Paused` vault (F-02).
- Redeem after governance reweight removes a held vault (F-03).
- `setWeights` accepting a Paused/Retired-containing vector → deposit DoS (F-05).
- `DeployTimelock.t.sol` asserting the EOA holds **no** `DEFAULT_ADMIN_ROLE` /
  `EMERGENCY_ROLE` after handover (F-01).
- Negative test: registered TWAP pool ≠ execution pool (F-09).

Single-contract boundary coverage (ConfusedDeputyGuards, AdapterDelegatecallGuard,
AccessRoles, CustodyInvariant) remains good.

---

## Suggested remediation order

1. **(High) F-01** — complete the Timelock handover (Gateway `DEFAULT_ADMIN_ROLE` +
   all-vault `EMERGENCY_ROLE`) and broaden the assertions. Mainnet hard gate.
2. **(Med) F-02 + F-03** — fix router exit semantics (allow `Retired`; redeem by
   actual holdings / explicit list).
3. **(Med) F-05 + F-13** + **F-04 residual** — status-validate weight vectors,
   skip-and-renormalise deposits, close the `setVaultStatus`/Paused back-door.
   (F-04 down-prioritized: the headline drift already shipped fixed.)
4. **(Med) F-06 + F-07 + F-08** — unify the vault control plane (admin-floor,
   restore path, stale-override gating).
5. **(Med) F-09 + F-10** — TWAP/execution pool consistency check; RWA
   NAV-vs-market deviation guard.
6. **(Low) F-11 + F-12 + F-15 + F-14** — forward router floor/deadline, cap
   semantics, idempotency-hash fields, revoked-adapter NAV handling.
7. **(Tests)** add the cross-contract regression cases above, prioritizing
   F-01/F-02/F-03/F-05.
