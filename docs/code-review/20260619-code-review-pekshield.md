# External Audit Verification — Multi-Contract Lifecycle Review — 2026-06-19

**Scope:** Independent source-level verification of an external smart-contract
audit ("Robot Money 智能合约审计报告", 2026-06-19) whose focus was *multi-contract
linkage* — the gateway ↔ router ↔ registry ↔ vault ↔ adapter ↔ oracle ↔
governance ↔ timelock control flow — rather than single-contract drains. The
external report raised 1 High, 9 Medium, 5 Low, and 4 Info findings (F-01 … F-19).

**HEAD commit:** `e8712ae37e435f5bb82b7017b5079f735817142c` (branch `dev`).

**Prior audits:**
[`20260618-code-review-internal-claude.md`](./20260618-code-review-internal-claude.md),
[`20260609-code-review-internal-claude.md`](./20260609-code-review-internal-claude.md),
[`20260602-code-review-internal-claude.md`](./20260602-code-review-internal-claude.md).

**Companion spec:** the findings and Layer 2 categories below are mapped to
named, FV-targetable invariants in
[`docs/technical/smart-contract-invariants.md`](../technical/smart-contract-invariants.md)
(each 🔴 invariant there links back to the finding here that violates it).

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

> **Update — Layer 2 added (2026-06-19).** A follow-on adversarial pass drilled
> each finding for n-th-order / cross-finding effects. It re-grades several findings
> (one **down** in interpretation, six **up** by composition) and surfaces ~10
> categories the external report did not open — including two new **High**s
> (NC-1 RwaVault stale-oracle redeem brick, NC-2 unvetted BasketVault adapters).
> See [Layer 2 — N-order composition](#layer-2--n-order-composition-re-grades--new-categories).
> The single load-bearing insight: in BasketVault/RwaVault the internal
> `maxSlippageBps` floor is derived from the **same TWAP that prices NAV**, so it is
> not an independent backstop — which is why a cluster of Mediums composes into Highs.

The severity column below records the **as-verified (Layer 1)** grade; the **Re-grade**
column records the Layer 2 composition-aware grade where it differs.

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

## Layer 2 — N-order composition: re-grades & new categories

The external report explicitly stopped at "each contract is safe alone; the risk is
composition." This layer pushes past that ceiling: each finding was drilled for
cross-finding chains, severity re-graded by **reachable composed impact**, and the
surface swept for categories the report never opened. Claims marked **(✓ verified)**
were re-read against source in this session; the rest carry the supporting pass's
file:line citations.

**Load-bearing insight.** In `BasketVault`/`RwaVault` the internal `maxSlippageBps`
floor is computed from `_slippageFloor → _twapUsdcValue` — the **same TWAP that prices
NAV**. So whenever that TWAP is wrong (pool misconfig, multi-block drag, or a stale
Chronicle feed), the "slippage protection" is wrong in lockstep and provides **no
independent backstop**. This is why F-09/F-11/F-16 are one value-extraction chain, not
three coincidental Mediums.

### Re-grades

| ID | L1 grade | L2 re-grade | Deciding assumption that moves it |
|---|---|---|---|
| **F-01** | High | **High — re-characterized** | NOT a theft path: every gateway flow (`deposit`/`depositTo`/`withdraw`/`withdrawFromRouter`) pulls USDC from `msg.sender`, an attacker-minted agent moves only its own approved funds, and `_authorizeAgentInternal` reverts `AgentAlreadyOwned` so existing agents can't be hijacked. Retained Gateway `DEFAULT_ADMIN_ROLE` = governance-capture / liveness (mint rogue agents, re-acquire ADMIN, block the Timelock from rotating roles). (✓ verified) |
| **F-04** | Med (mostly mitigated) | **Med (residual)** | Headline drift is fixed by atomic `retire()`, but the `setVaultStatus(Paused)` back-door composes with all-or-revert deposits (see F-13) → not "arguably Low". |
| **F-06** | Med | **High (basket family)** | `BasketVault._withdraw` is `whenNotPaused`; `pause()`=EMERGENCY_ROLE, `unpause()`=ADMIN_ROLE; basket vaults use plain `AccessControl` (no last-admin floor) and have no `restoreVault`. Hot-key pause + last-ADMIN renounce = **permanent withdrawal freeze**. (✓ verified) |
| **F-08** | Med | **High (conditional)** | If any RWA token is configured `overrideAllowed && maxLossBps==MAX_BPS`, one EMERGENCY key sets stale-override + override-unwind and dumps the basket at ~0 floor under an unverifiable NAV. Hinges on guard config. |
| **F-09** | Med | **High (misconfig) / Med (honest)** | `addAsset` never asserts execution pool (from `swapFee_`) == TWAP `pool_`. One wrong `swapFee_` write silently decouples NAV-pricing from execution → mint-cheap/redeem-dear. Honest-config degrades to multi-block TWAP drag (cardinality floor is only 2). (✓ verified: `addAsset` has no equality check) |
| **F-11** | Low | **Med** | Gateway hardcodes the per-leg floor to zero, removing the only *independent* USDC-denominated floor on the agent redeem path; the remaining internal floor is TWAP-co-manipulated. |
| **F-13** | Low | **Med** | Amplifier: any single non-Active leg (F-04 residual / F-05) reverts the **whole router's** deposits while `previewDeposit` reports the basket healthy. |
| **F-16** | Info | **Med** | The pricing-model half of the F-09 chain (TWAP-mark mint vs spot fill); not informational once the pool-equality gap exists. |
| **F-17 / F-19** | Info | **Info (urgency lower)** | No wrong price *today*: deSPXA=18-dec, and a real pool's mean tick is within int24, so the hardcoded `1e12` and the `int24` cast cannot misprice now. Latent only. |

F-02/F-03 **hold at Med**: the direct-`redeem()` bypass is genuinely available because
receipt tokens are custodied by the depositor's `shareReceiver`, not the gateway/router
(the `ShareCustodyInvariantViolated` checks enforce the gateway never holds shares).
The one exception is RwaVault — see NC-1.

### New categories (not F-01…F-19)

**High**

- **NC-1 — RwaVault stale oracle bricks *all* user redemptions (✓ verified).**
  `redeem → previewRedeem → totalAssets → _checkOracleFreshness` reverts
  `StalePriceFeed` (`vaults/RwaVault.sol:199-217`). The stale-override only relaxes
  `emergencyUnwind`, **not** user `redeem`, and the freshness check is unconditional —
  so redeem reverts *even after* emergency-unwind to idle USDC. During any heartbeat
  breach, RWA funds are trapped with no permissionless exit. This is "fail-closed by
  design" (ADR-0006 §2) but directly contradicts the report's blanket "funds aren't
  trapped — direct redeem always works." **Fix:** short-circuit freshness when the
  vault holds zero priced RWA tokens.
- **NC-2 — BasketVault adapters are unvetted (✓ verified).** `addAsset(token, pool,
  swapFee, adapter, venue)` (`vaults/BasketVault.sol:753-802`) accepts `adapter` as an
  arbitrary address — **no allowlist, no codehash pin, no DELEGATECALL guard**, unlike
  RobotMoneyVault's `_requireAdapterEligible`. The adapter is *both* the swap executor
  (receives a token approval) *and* the `twapPrice` NAV oracle. ADMIN-gated, so
  trust-bounded, but a strictly weaker, undocumented control surface than the sibling
  vault for the same asset class. **Fix:** mirror RobotMoneyVault's codehash allowlist
  + delegatecall guard.

**Medium**

- **NC-3 — BasketVault `pause()` is a bidirectional freeze (✓ verified).** Low-trust
  EMERGENCY_ROLE freezes *withdrawals* (not just deposits); only ADMIN_ROLE clears it.
  Defeats the direct-redeem bypass for the duration; combines with F-01/F-06.
- **NC-4 — One `setVaultStatus(vault, Paused)` bricks whole-router deposits** while
  `previewDeposit` still reports the other legs available (F-04 residual × F-13).
  Single call, whole-router blast radius, masked from monitors.
- **NC-5 — Router `redeemFor` binds `sharesPerLeg[i]` positionally to the mutable
  weight vector**, not to an explicit vault. A governance reweight between agent-sign
  and execution can redeem the *wrong receipt token* at that vault's exit haircut;
  idempotency won't catch it (F-15 omits the leg vector). **Fix:** bind redemption to
  an explicit hashed `vaults[]`.
- **NC-6 — Deposit/redeem mark-vs-haircut asymmetry is a farmable leak.** Shares mint
  on slippage-discounted NAV but captured tokens are re-marked at full TWAP → every
  deposit transfers value to incumbents (up to **300 bps** on AgentTokenVault). No
  `previewRedeem(previewDeposit(x)) <= x` invariant test exists. **Fix:** mint on
  realized swap proceeds; add the round-trip invariant.
- **NC-7 — Gateway rolling-window arrays grow unbounded.**
  `_depositWindowEntries`/`_withdrawWindowEntries` are append-only, pruned by a head
  pointer and never compacted → a high-frequency agent eventually hits a gas wall and
  is **permanently self-DoS'd**, with no admin reset. **Fix:** ring buffer / coarse
  time-bucket counters.
- **NC-8 — Permissionless `reabsorbRemovedAsset` weaponizable.** Dust-send +
  degraded-pool `observe()` revert can brick reabsorption (stranding the very balance
  it exists to recover); `addAsset` also lets a removed token be re-added as a
  *duplicate* `AssetInfo`. **Fix:** quarantine fallback on TWAP failure; reject/reuse
  existing inactive entry on re-add.
- **NC-9 — `depositTo` paymentId omits `destination`.** Same
  `(orderId, amount, idempotencyKey)` with a different `destination` collides;
  first-to-land forces single-vault vs router routing substitution (sharper than
  F-15's generic note). **Fix:** fold `destination` + `keccak256(minSharesPerLeg)` into
  the hash.
- **NC-10 — Role-separation grant-DoS during handover.** `AccessRoles._grantRole`
  reverts on tier overlap; registering the intended future ADMIN/PAUSER multisig
  address as an AGENT first (commit/reveal is permissionless) blocks that address from
  ever being granted ADMIN/PAUSER. **Fix:** check `agentOwner`/`AGENT_ROLE` is clear
  before granting privileged roles; fix role ordering in deploy.

**Low / Info**

- **NC-11** — exit fee charged on share-implied *gross* (not realized pull) →
  socialized to remaining holders when an adapter over-reports.
- **NC-12** — `AaveV3Adapter`/`MorphoAdapter` use non-zeroing `safeIncreaseAllowance`,
  against the codebase's `forceApprove(…,0)` convention.
- Latent: a fee-on-transfer / rebasing basket token would silently corrupt NAV
  (`addAsset` has no screen); read-only reentrancy on `totalAssets()` (vault itself is
  guarded — integrator note); the Timelock/Safe is a single liveness point the
  admin-floor *masks*; cross-asset rounding bias slightly favors redeemers.

### Fix-interaction warning (F-01 remediation)

The F-01 fix must `_setRoleAdmin(AGENT_ROLE, ADMIN_ROLE)` **and** move `authorizeAgent`
to `ADMIN_ROLE` before/at the same time as revoking the deployer's Gateway
`DEFAULT_ADMIN_ROLE`. A *naked* revoke would make `AGENT_ROLE` ungrantable forever
(no floor on it), trading F-01 for a permanent agent-onboarding brick.

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

Layer 2 chains additionally uncovered:

- User `redeem` on RwaVault reverts while the Chronicle feed is stale, including after
  emergency-unwind to idle USDC (NC-1).
- A single `setVaultStatus(vault, Paused)` reverts every router deposit while
  `previewDeposit` still reports the basket available (NC-4 / F-13).
- Router redemption maps `sharesPerLeg` to the wrong vault after a between-sign
  reweight (NC-5).
- `previewRedeem(previewDeposit(x)) <= x` round-trip invariant on each basket vault
  (NC-6 / F-16).

Single-contract boundary coverage (ConfusedDeputyGuards, AdapterDelegatecallGuard,
AccessRoles, CustodyInvariant) remains good.

---

## Suggested remediation order

Reordered to reflect the Layer 2 re-grades (composition-aware severity).

1. **(High) F-01** — complete the Timelock handover (Gateway `DEFAULT_ADMIN_ROLE` +
   all-vault `EMERGENCY_ROLE`) and broaden the assertions. **Mind the fix-interaction
   warning** (redirect `AGENT_ROLE` admin before revoking). Mainnet hard gate.
2. **(High, Layer 2) NC-1 + NC-2 + F-06 + F-08 + F-09** — RwaVault freshness
   short-circuit on user redeem; vet BasketVault adapters (codehash + delegatecall
   guard); give the basket family an `ADMIN_ROLE` admin-floor + `restoreVault`; move
   the RWA stale-override gating up; assert execution-pool == TWAP-pool in `addAsset`.
3. **(Med) F-02 + F-03 + NC-5** — fix router exit semantics (allow `Retired`; redeem
   by actual holdings / explicit hashed `vaults[]`, closing positional wrong-leg
   redemption).
4. **(Med) F-05 + F-13 + F-04 residual + NC-4** — status-validate weight vectors,
   skip-and-renormalise deposits, close the `setVaultStatus`/Paused back-door (one
   call currently bricks whole-router deposits while preview reports healthy).
5. **(Med) F-10 + F-11 + F-16 + NC-6** — RWA NAV-vs-market deviation guard; forward a
   real per-leg floor through the gateway; mint basket shares on realized proceeds; add
   the `previewRedeem(previewDeposit(x)) <= x` invariant.
6. **(Med) NC-3 + NC-7 + NC-8 + NC-9 + NC-10** — basket withdrawal-pause separation;
   bound the gateway window arrays; reabsorb quarantine fallback + de-dup re-add;
   fold `destination`/leg-vector into idempotency hashes; guard the handover grant-DoS.
7. **(Low) F-12 + F-14 + F-15 + NC-11 + NC-12 + F-07** — cap semantics, revoked-adapter
   NAV handling, idempotency-hash fields, exit-fee-on-realized, approval-zeroing,
   basket `restoreVault` (if not done in step 2).
8. **(Tests)** add the cross-contract regression cases below, prioritizing
   F-01/F-02/F-03/F-05 and the Layer 2 chains (NC-1 stale redeem, NC-4 whole-router
   deposit DoS, F-09 misconfig pool mismatch).
