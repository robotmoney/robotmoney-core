# Vault Adapter Architecture

This document describes the vault adapter layer implemented by
`RobotMoneyVault`. It is about the current single-vault strategy
adapter system, not the Portfolio Router. Product vocabulary is defined
in `docs/definitions.md`.

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
- `rescueTokens(address token, address to)` lets the vault recover
  accidental non-protected tokens.

All mutating adapter functions are restricted to the owning vault by an
`onlyVault` check in each implementation.

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
  residual allowance.
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
  residual allowance.
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
  then clears any residual allowance.
- The adapter holds Morpho vault shares.
- `totalAssets` converts held Morpho shares to USDC value using
  `MORPHO_VAULT.convertToAssets`.
- `withdraw` calls `MORPHO_VAULT.withdraw(amount, VAULT, address(this))`
  and measures the vault's USDC balance delta.

Protected tokens:

- USDC.
- The configured Morpho vault share token.

### Passthrough

`PassthroughAdapter` is a no-yield adapter for devnet and smoke-test
deployments.

Behavior:

- `deploy` does nothing because USDC is already held by the adapter.
- `totalAssets` returns the adapter's raw USDC balance.
- `withdraw` transfers up to the requested amount back to the vault.

This adapter is not a mainnet yield strategy.

## 5. Vault Controls

Adapters are controlled by `RobotMoneyVault`, not by users or agents.

Admin controls:

- `addAdapter(address adapter, uint16 capBps)`.
- `removeAdapter(uint256 index)` when the adapter holds zero assets.
- `setAdapterCap(uint256 index, uint16 capBps)`.
- `adminRebalance(uint256[] targetBalances)`.

Keeper/admin rebalance:

- `rebalance()` pulls excess from overweight adapters and re-routes idle
  USDC toward equal active-adapter weights.
- Rebalance is throttled by `minRebalanceInterval` and
  `maxRebalanceBpsPerCall`.

Emergency controls:

- `emergencyWithdraw()` pauses the vault and attempts to drain all
  active adapters.
- `emergencyWithdrawAdapter(index)` pauses the vault and attempts to
  drain one adapter.
- `forceRemoveAdapter(index)` marks an adapter inactive without
  withdrawing. Assets left there are treated as lost.
- `shutdownVault()` permanently disables deposits by setting shutdown
  and zeroing the TVL cap.

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
- **Protected-token rescue risk.** Rescue paths must not allow USDC or
  venue receipt tokens to be swept away.
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
- `rescueTokens` rejects protected assets.
- Adapter behavior is covered by unit tests and, where external venue
  behavior matters, fork tests.
- Emergency withdrawal and force-removal behavior is documented.

## 8. Relationship to Portfolio Router

Adapters and the Portfolio Router operate at different layers.

The Portfolio Router is the outer product allocation layer. It splits a
deposit across active vaults according to RM-governed router weights.
Its destinations are vaults.

Adapters are internal to a vault. They split or deploy one vault's
assets into strategies or venues. Their destinations are external
protocols.

Therefore:

- A Portfolio Router weight is a weight across vaults.
- An adapter cap is a cap inside one vault.
- RM-token governance currently controls Portfolio Router weights only.
- RM-token governance does not currently control adapter selection,
  adapter caps, or per-vault strategy internals.
