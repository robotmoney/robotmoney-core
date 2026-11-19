# Rejected and partial findings

## Rejected (false premise / not reproducible)

### #21 — Permissionless recording can shorten the four-hour sell anchor

The age-based window is real (`BasketViews.sol:213-215`) and the onboarding guard
sizes cardinality to only 901 slots (`BasketAssetConfigGuard.sol:136-155`), but the
audit conflates that guard minimum with the deployed recorder ring.
`DeployUniswapV4PriceRecorder.s.sol:17,37,124` grows the ring to **7,201 slots**
and asserts `cardinalityNext == 7_201`. At one record per 2 s Base block, wrapping
takes ~4 h, so once warm `oldestObservation()` is ≥ `SELL_ANCHOR_WINDOW`
(14,400 s) and the anchor stays at the full four hours. `grow()` is monotone and
cannot shrink the ring. `RecorderSellAnchor.t.sol::test_sellAnchor_youngRecorderUsesItsWholeHistory`
confirms the short-window case applies only to a deliberately young recorder and
is intentional. No attacker-controlled path shortens the shipped anchor to ~30 min.

### #23 — User-supplied floor can force a removed asset into quarantine

The premise misreads Solidity `try/catch`. `revert SlippageExceeded()` at
`BasketSwaps.sol:170` is inside the **success block** of
`try self.emergencyTwapUsdcValue(...)`, not in the external-call expression.
Solidity catches only reverts from the external call itself, so a caller-chosen
high `minUsdcOut` propagates the revert atomically and never reaches
`catch { ForeignTokenQuarantine.sweep(...) }`. Directly refuted by
`BasketVault.t.sol:634-656`, which calls `reabsorbRemovedAsset(0, twapFloor + 1)`
and expects `SlippageExceeded` (passes). The catch is scoped correctly to oracle
unavailability (e.g. `StaleRecorder`, degraded pool).

## Partial (real observation, but bounded / by-design / premise overstated)

### #1 — Stale V4 recorder quarantines a removed-asset balance

Real and caller-triggerable: `reabsorbRemovedAsset` is permissionless
(`BasketVault.sol:1195`), the stale-oracle revert is caught by the external
self-call `catch` and sweeps the full balance to fixed `QUARANTINE`
(`BasketSwaps.sol:164-174`, `ForeignTokenQuarantine.sol:49,75-81`,
`UniswapV4PriceRecorder.sol:58,211`). However this is the documented/test-pinned
degraded-oracle safety valve (`BasketVault.sol:1200-1206`;
`BasketVault.t.sol::test_LIFE6_reabsorbSurvivesDegradedPool`), the swept balance is
already excluded from NAV, and `record()` is permissionless. Real doc
inconsistencies: `:1204` says "governed" address but it is a fixed constant;
`sweepForeignToken` NatSpec says inactive assets are never quarantined.

### #2 — Deposit availability queries router, not receiver

`_isDepositable` uses `maxDeposit(address(this))` (`PortfolioRouter.sol:855-869`)
while `_executeLeg` deposits to `receiver` (`:1270`). But eligible vaults are the
curated family vaults (`isRouterEligible`, `:1359-1374`), whose `maxDeposit`
ignores the receiver (`RobotMoneyVault.sol:685`, `BasketVault.sol:860`; router
NatSpec `:851-854`). Receiver-specific limits are unrealistic here; the second
claimed outcome is an all-or-revert, not silent misallocation. No PoC.

### #3 — Deposit floors not bound to previewed vault vector

Factual gap confirmed (`deposit`/`depositFor` at `:888`/`:914` take no deadline or
vector commitment; `_depositTo` snapshots live weights at `:1094`; positional floor
at `:1217`; unlike `redeemFor`'s identity binding). Bounded by governance-only
weight changes, `LegSkippedWithFloor` (`:1206-1209`), curated vaults, and
gateway-side deadline/payment-ID binding. A reordering satisfying numeric floors
is conceivable but undemonstrated.

### #4 — Deposits front-run inactive-asset recovery

All premises confirmed and executable atomically (`totalAssets` excludes inactive,
`BasketVault.sol:527-538`; deposit mints at reduced NAV, `:631-659`; permissionless
reabsorption, `:1195`; successful path credits full balance, `BasketSwaps.sol:171`).
But previously documented/accepted-with-rationale
(`docs/code-review/20260623-code-review-testmachine-azimuth.md:764-855`) and
pro-rata: the depositor supplies real capital and captures `D·V/(C+D)`, with
slippage floors/fees/deviation guard possibly outweighing net gain.

### #5 — Documented zero TVL-cap sentinel disables deposits

The stale NatSpec "0 = no cap" (`RobotMoneyVault.sol:430`) and resulting zero-cap
behaviour are real, but 0 is intentionally "deposits disabled" (`shutdownVault`
sets `tvlCap = 0`, `:1234`; `restoreVault` requires `> 0`, `:1247`). The real
unbounded sentinel is `type(uint256).max` (`_capsUnbounded`, `:711-713`). Deploy
tooling forbids zero (`DeployVault.s.sol:278`, `VaultScriptGuards.t.sol:205-209`)
and a `setTvlCap` setter exists (`:1260-1265`). Documentation hygiene only.

### #7 — Idle allocation bypasses rebalance movement cap

Code fact confirmed (`RobotMoneyVault.sol:1015-1023`; `RobotMoneyVaultOps.sol:747-773`)
and previously flagged as SR-M10. The emergency harm was fixed
(`depositsPaused || shutdown` guards at `:1005-1006`); routing idle is intentional
(`RobotMoneyVaultRouteDeposit.t.sol:938-981`) and bounded by capBps/equal-weight
ceilings. Idle is already in NAV, so exposure does not increase. The throttle is
gradualism, not a hard allocation bound.

### #8 — Keeper rebalance targets ignore adapter caps

No cap clamp in `rebalancePull` (`RobotMoneyVaultOps.sol:747-773`, equal-weight
target only); `_ceiling` (`:306-318`) applies to deposits only and `setAdapterCap`
(`:544-550`) only writes storage. But this is a documented equal-weight-by-design
rebalancer (FS-VLT-20 accepted "by design, re-converges"; `docs/audits.md:285`),
with `adminRebalance` for precise cap enforcement and `KEEPER_ROLE` not granted at
launch. A parameter-enforcement gap, not a novel exploit.

### #14 — Router deposits ignore the routing feature flag

"No on-chain consumer" is true (`FeatureFlags` used only in its own file and
tests). But the flag is explicitly off-chain/UI by design (`FeatureFlags.sol:8-11`;
`config/feature-flags.json:14`; ADR-0014 "not deployed, a constants library");
enforcement lives in the Rust indexer/dapp, so there is no on-chain gate to bypass.
Residual issue is a doc ambiguity (`:15` omits "in the dapp").

### #20 — Gateway deposit ignores its share floor

The missing min-shares assertion is real (`RobotMoneyGateway.sol:575-582,638-650,716-739`),
but NatSpec (`:570-574`) states `minSharesPerLeg` is only an idempotency/payment-ID
fingerprint (GW-2), never a slippage promise. The gateway deposits a fixed USDC
amount to its own receiver; receiving fewer shares is not a protected expectation.
Info-severity, documented non-issue.
