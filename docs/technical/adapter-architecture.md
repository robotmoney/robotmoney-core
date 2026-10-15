# Vault Adapter Architecture

This document describes the vault adapter layer implemented by
`RobotMoneyVault`. It is about the current single-vault strategy
adapter system, not the Portfolio Router. Product vocabulary is defined
in `docs/technical/definitions.md`.

## 1. Purpose

`RobotMoneyVault` is an ERC-4626 vault. ERC-4626 standardizes the
public vault surface: deposit, mint, withdraw, redeem, previews,
conversions, `asset()`, and `totalAssets()`.

ERC-4626 does not specify how a vault invests internally. Robot Money
uses vault adapters for that internal strategy layer. An adapter
connects one vault to one external venue or strategy and normalizes
that venue behind a small interface.

The reason this layer exists is that assets on Ethereum are
operationally heterogeneous. A position might be a plain ERC-20
balance, a rebasing token, an ERC-4626 share, a lending-account
balance, or a venue-specific receipt. Deposit, withdrawal, valuation,
holding, and reporting semantics vary by venue. Vaults homogenize those
differences when they are designed correctly: they expose one product
surface while internal adapters absorb the venue-specific mechanics.

In product terms:

- Portfolio Router allocates across vaults.
- Vaults allocate internally through adapters.
- Users and agents interact with vaults or the Portfolio Router.
- Users and agents do not select or call adapters directly.
- The Portfolio Router consumes normalized vault surfaces, not raw
  DeFi venue integrations.

Design principle:

> A vault is successful when its external interface is boring and
> predictable, even if its internal assets are not.

## 2. Interface

All adapters implement `IStrategyAdapter`:

- `deploy(uint256 amount)` receives USDC already transferred from the
  vault and deploys it into the venue.
- `withdraw(uint256 amount) returns (uint256 actual)` pulls USDC from
  the venue and returns it to the vault.
- `totalAssets() returns (uint256)` reports live USDC-denominated value
  held by the adapter.
- `sweepForeignToken(address token)` is the permissionless foreign-token
  quarantine sweep (custody invariants INV-1/INV-2): anyone may call it,
  but it moves only NON-protected tokens to a single hardcoded quarantine
  address — never a caller-supplied recipient. The old arbitrary-recipient
  `rescueTokens(token,to)` is deleted (INV-1).

The value-moving adapter functions (`deploy`, `withdraw`) are restricted to
the owning vault by an `onlyVault` check in each implementation;
`sweepForeignToken` is intentionally permissionless (its destination is a
compile-time constant, so it cannot route value to an arbitrary recipient).

## 3. Vault Flow

### Deposit

On ERC-4626 deposit:

1. The depositor transfers USDC to `RobotMoneyVault`.
2. The vault mints rmUSDC shares to the receiver.
3. The vault calls `_routeDeposit(assets)`.
4. `_routeDeposit` tries to place the new USDC across active adapters.
5. For each placement, the vault transfers USDC to the adapter and
   calls `adapter.deploy(amount)`.

Routing is two-pass:

1. Fill active adapters toward equal target weight, capped by each
   adapter's `capBps`.
2. Put leftovers into active adapters with remaining cap headroom.

If all caps are full, unallocated USDC remains idle in the vault and
`UnroutedDeposit` is emitted.

### Withdraw / Redeem

On ERC-4626 withdraw or redeem:

1. The vault computes the gross USDC value needed.
2. `_pullProportional` computes current active-adapter balances using
   `adapter.totalAssets()`.
3. The vault asks adapters to withdraw roughly proportional amounts.
4. Adapters return USDC to the vault.
5. The vault burns shares and transfers net USDC to the receiver.

Withdrawals are synchronous. Adapter liquidity or venue failure can
therefore block or reduce the withdrawal path unless handled by
emergency procedures.

## 4. Implemented Adapters

### Aave V3

`AaveV3Adapter` supplies USDC to the Aave V3 Pool on Base.

Behavior:

- `deploy` approves the Aave Pool, calls `POOL.supply`, then clears any
  residual allowance. A supply the pool refuses for capacity (the
  reserve's supply cap is reached, or the reserve is frozen) does not
  revert: the adapter sends the USDC back to the vault and emits
  `DeployRefused(amount, reason)` (security round 2, see "A venue that
  refuses a supply" below). A refusal while the reserve is paused or
  inactive, so Aave refuses withdrawals too, reverts
  `VenueWithdrawalsClosed(reason)` (security round 3).
- `venueWithdrawable()` reads the reserve's configuration bitmap
  (`POOL.getConfiguration`): false while the reserve is paused (bit 60)
  or inactive (bit 56 clear).
- The adapter holds aBasUSDC / aToken exposure.
- `totalAssets` returns `A_TOKEN.balanceOf(address(this))`, which is
  expected to include accrued interest.
- `withdraw` calls `POOL.withdraw(asset, amount, VAULT)`, so Aave sends
  USDC directly to the vault.

Protected tokens:

- USDC.
- The configured aToken.

### Compound V3

`CompoundV3Adapter` supplies USDC to Compound V3 Comet on Base.

Behavior:

- `deploy` approves Comet, calls `COMET.supply`, then clears any
  residual allowance. A supply Comet refuses (supply paused) is sent back
  to the vault with `DeployRefused(amount, reason)` (security round 2),
  unless Comet's `isWithdrawPaused` is set too: then it reverts
  `VenueWithdrawalsClosed(reason)` (security round 3).
- `venueWithdrawable()` is `!COMET.isWithdrawPaused()`.
- The adapter holds the Comet account balance.
- `totalAssets` returns `COMET.balanceOf(address(this))`, which is
  expected to represent live USDC value with interest.
- `withdraw` calls `COMET.withdraw`, measures the adapter's USDC
  balance delta, then forwards any received USDC to the vault.

Protected tokens:

- USDC.
- The configured Comet token/contract.

### Morpho

`MorphoAdapter` deposits USDC into the Morpho Gauntlet USDC Prime
ERC-4626 vault on Base.

Behavior:

- `deploy` approves the Morpho vault, calls `MORPHO_VAULT.deposit`,
  then clears any residual allowance. A deposit the Morpho vault refuses
  (`AllCapsReached` once every market cap in its supply queue is full) is
  sent back to the vault with `DeployRefused(amount, reason)` (security
  round 2). The adapter's own exposure cap below still reverts.
- The adapter holds Morpho vault shares.
- `totalAssets` converts held Morpho shares to USDC value using
  `MORPHO_VAULT.convertToAssets`.
- `withdraw` calls `MORPHO_VAULT.withdraw(amount, VAULT, address(this))`
  and measures the vault's USDC balance delta.

Protected tokens:

- USDC.
- The configured Morpho vault share token.

Exposure cap:

- `MorphoAdapter` exposes a governance-configurable per-adapter
  `maxExposure` cap (`uint256 public maxExposure`) that bounds the USDC
  which may be deployed into the Morpho venue.
- The cap is set via `setMaxExposure(uint256 cap)`, restricted to the
  owning vault by the `onlyVault` modifier — the same authority gate as
  `deploy` and `withdraw`.
- Governance reaches it through the vault:
  `RobotMoneyVault.setAdapterMaxExposure(uint256 index, uint256 cap)`
  (`ADMIN_ROLE`, the timelock in production) forwards the call to the active
  entry at `index` and emits `AdapterMaxExposureSet(index, adapter, cap)`.
  Read the live value back with the adapter's `maxExposure()` (FS-VLT-10, QA
  plan D8).
- A cap of `0` means uncapped (the default), so a deployment keeps its
  prior behavior until a vault sets a non-zero cap.
- When the cap is non-zero, `deploy(amount)` reads the adapter's live
  Morpho-denominated balance with
  `MORPHO_VAULT.convertToAssets(MORPHO_VAULT.balanceOf(address(this)))`
  and reverts `ExposureCapExceeded(current, amount, cap)` when
  `current + amount` would exceed the cap. The check uses the live
  converted balance rather than a stored counter, so accrued yield is
  reflected in the exposure measurement.
- The vault's allocator respects the cap, so it bounds Morpho only and
  never stops vault deposits (security round 1). Both routing passes read
  `maxExposure()` (a `staticcall`; an adapter without it counts as
  uncapped) and fill Morpho at most to the cap. The rest goes to the other
  adapters up to their `capBps`, and what none can take stays idle in NAV
  with `UnroutedDeposit`. Before this, a cap below Morpho's equal-weight
  slice, or yield accrual alone pushing Morpho near the cap, made every
  vault deposit, keeper `rebalance` and router deposit with an rmUSDC leg
  revert. `adminRebalance` still reverts on an explicit target above the
  cap.

A venue that refuses a supply (security round 2):

- The exposure cap is the adapter's own limit. The venue has limits of
  its own: an Aave reserve's supply cap and its frozen or paused flags,
  MetaMorpho's market caps (`AllCapsReached`), Comet's supply pause. Any
  of them used to revert `deploy`, and with it every rmUSDC deposit,
  every router deposit with an rmUSDC leg and keeper `rebalance`. Anyone
  with enough USDC could fill an Aave reserve's remaining cap room to
  cause that on purpose.
- The single-argument `deploy` of all three lending adapters now catches
  the venue's revert, sends the USDC back to the vault and emits
  `DeployRefused(amount, reason)`. The vault measures what each adapter
  kept by its own USDC balance (`VaultAdapterOps._allocate`), reports only
  that with `Allocated`, does not ask a refusing adapter again in the
  same routing call, and leaves what no adapter takes idle in NAV with
  `UnroutedDeposit`. The next deposit or `rebalance` routes it once the
  venue accepts again. `adminRebalance` leaves a refused slice idle too.
- The min-out `deploy(usdcIn, minValueOut)` overload still reverts on a
  refusal.

A venue that shuts withdrawals too (security round 3):

- An Aave reserve that is paused or inactive, or a Comet whose
  `isWithdrawPaused` is set, refuses the supply AND the withdrawal, while
  the vault still counts the position at face in NAV. Handing the slice
  back there let a deposit mint at that NAV and left its slice idle, and
  a redeem no larger than idle was paid at full NAV while any later
  haircut fell on the holders who stayed (the FS-VLT-8 outcome).
- The Aave and Compound adapters implement
  `IVenueHealthAdapter.venueWithdrawable()`. While any active adapter
  reports false, `RobotMoneyVault.maxDeposit` and `maxMint` read 0
  (`VaultAdapterOps.anyActiveBlocked`), so a deposit reverts and the
  router skips the rmUSDC leg. A missing or reverting view reads as
  open. Deposits reopen with the venue, or once the adapter leaves the
  active set.
- The adapter's own `deploy` does not hand a slice back while its venue
  is shut: it reverts `VenueWithdrawalsClosed(reason)`. So a keeper
  `rebalance` cannot pull a healthy venue's excess into idle and leave
  it there either.
- MetaMorpho has no pause, so `MorphoAdapter` has no such view; its
  `AllCapsReached` refusal still hands back.
- The operator response stays exclude first: `EMERGENCY_ROLE` runs
  `emergencyExcludeAdapter` before any drain.

## 5. Vault Controls

Adapters are controlled by `RobotMoneyVault`, not by users or agents.

Admin controls:

- `addAdapter(address adapter, uint16 capBps)`.
- `removeAdapter(uint256 index)` when the adapter holds zero assets.
- `setAdapterCap(uint256 index, uint16 capBps)`.
- `setAdapterMaxExposure(uint256 index, uint256 cap)` for an adapter with an
  exposure cap (Morpho). Other adapters revert the call.
- `adminRebalance(uint256[] targetBalances)`.

Keeper/admin rebalance:

- `rebalance()` pulls excess from overweight adapters and re-routes idle
  USDC toward equal active-adapter weights.
- Rebalance is throttled by `minRebalanceInterval` and
  `maxRebalanceBpsPerCall`.

Emergency controls:

- `emergencyWithdraw()` pauses deposits and attempts to drain all
  active adapters. Withdrawals stay open (core 1494).
- `emergencyWithdrawAdapter(index)` pauses deposits and attempts to
  drain one adapter. Withdrawals stay open.
- `emergencyExcludeAdapter(index)` revokes one active adapter's allowance
  and opens its exclusion record (a snapshot of the share supply) in one
  call. It is exclude-only: `setAdapterAllowed(adapter, true)` (ADMIN_ROLE)
  restores the entry and drains it into the record first. For an illiquid
  adapter, exclude first and then run `emergencyWithdraw`, so the holders
  who redeem from idle and the holders who stay bear the haircut alike
  (security round 1).
- `forceRemoveAdapter(index)` marks an adapter inactive without
  withdrawing. Its balance leaves NAV but stays owed to the holders of the
  moment: a funded entry keeps an open exclusion record, and a later
  `addAdapter` of the same address pays the balance into that record
  before the new entry counts (security round 1).
- `recoverRemovedAdapter(index, amount)` withdraws up to `amount` from a
  force-removed adapter straight into its open exclusion record, and
  closes the record once the adapter reports an empty balance. Use it when
  the venue can repay only part of the position: the re-add asks for the
  whole balance in one call and reverts `AdapterNotEmpty` until the venue
  can pay all of it (security round 2).
- `shutdownVault()` disables deposits by setting shutdown and zeroing
  the TVL cap. It is recoverable: `restoreVault(newTvlCap)` (ADMIN_ROLE)
  clears the shutdown flag and re-opens deposits under a fresh cap.

## 6. Risk Model

Adapters are a high-trust strategy layer. Adding an adapter expands the
vault's security and audit surface.

Primary risks:

- **External protocol risk.** The venue can be hacked, paused,
  upgraded, misconfigured, illiquid, or economically impaired.
- **Accounting risk.** `totalAssets()` may misstate value if the
  adapter relies on a bad exchange-rate function, incorrect share
  conversion, rebasing behavior, stale accounting, or unexpected venue
  semantics.
- **Withdrawal risk.** `withdraw(amount)` can revert, return less than
  requested, or fail to deliver USDC to the vault.
- **Allowance risk.** Adapters grant approvals to venues. Residual
  allowances must be cleared where possible.
- **Permission risk.** Mutating adapter functions must only be callable
  by the owning vault.
- **Protected-token sweep risk (INV-1/INV-2).** The permissionless
  `sweepForeignToken` path must reject USDC and venue receipt tokens, and
  may move tokens only to the fixed quarantine address — never to a
  caller-supplied recipient (the deleted `rescueTokens` was the source of
  this finding, audit L-11/L-15).
- **Integration drift.** Venue APIs, token implementations, proxy
  upgrades, and chain deployments can change after adapter deployment.
- **Composability risk.** ERC-4626 venue adapters, such as Morpho,
  inherit the underlying vault's accounting, liquidity, and share-price
  assumptions.

## 7. Required Adapter Properties

Any production adapter must satisfy these properties before activation:

- Mutating functions are restricted to the configured vault.
- Constructor pins the venue, USDC, receipt/share token where relevant,
  and owning vault.
- `deploy` handles approvals narrowly and clears residual allowances.
- `withdraw` measures or verifies actual USDC delivered.
- `totalAssets` returns live USDC-denominated value.
- `sweepForeignToken` rejects protected assets (USDC, receipt/share token)
  and quarantines only to the fixed `ForeignTokenQuarantine.QUARANTINE`
  address; there is no arbitrary-recipient rescue path (INV-1).
- Adapter behavior is covered by unit tests and, where external venue
  behavior matters, fork tests.
- Emergency withdrawal and force-removal behavior is documented.

## 8. Relationship to Portfolio Router

Adapters and the Portfolio Router operate at different layers.

The Portfolio Router is the outer product allocation layer. It splits a
deposit across active vaults according to RouterGovernance-voted router weights.
Its destinations are vaults.

Adapters are internal to a vault. They split or deploy one vault's
assets into strategies or venues. Their destinations are external
protocols.

Therefore:

- A Portfolio Router weight is a weight across vaults.
- An adapter cap is a cap inside one vault.
- RouterGovernance currently controls active Portfolio Router weights only.
  The timelock sets default weights directly. It changes active weights
  only through `RouterGovernance.applyReceipt`: only RouterGovernance holds
  `WEIGHT_SETTER_ROLE`, so a direct `setWeights` from the timelock reverts
  (core #1522).
- RouterGovernance does not currently control adapter selection,
  adapter caps, or per-vault strategy internals.

## 9. History: the unified vault proposal

ADR-0010 proposed generalizing this layer into a single `Vault` with position
adapters. It was Rejected and its code is deleted (see
`docs/adr/ADR-0010-unified-vault-architecture.md`). The adapter layer in this document
(`IStrategyAdapter` for lending, `IBasketSwapAdapter` for basket swaps) is the shipped
design. The basket swap adapters on this branch are `UniswapV3SwapAdapter`,
`UniswapV4SwapAdapter` and `AerodromeSwapAdapter`. The deploy scripts wire venues `UniswapV3`
and `UniswapV4` (rmAGENT's RM leg); no deploy script registers `AerodromeSwapAdapter`. The
first Uniswap V4 adapters were deleted on core PR 1505. Core 1676 restored a rewritten
`UniswapV4SwapAdapter` for RM's venue (ADR-0005 amendment of 2026-10-08).
