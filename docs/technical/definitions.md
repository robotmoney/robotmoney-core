# Robot Money — Definitions

This glossary defines product terms used across the PRD, architecture,
implementation plan, dapp, CLI, and agent skills. When another document
uses one of these terms, this file is the canonical meaning.

## Vaults System

The vaults system is the Robot Money treasury product. It holds the
vaults (rmUSDC, rmPROTO, rmAGENT, rmRWA), their adapters, the vault
registry, the Portfolio Router and `RouterGovernance`. Its rebalancing
signal is the consensus recommendation receipt, recorded on
`ConsensusRecommendationReceipt` by a submitter holding
`RECEIPT_SUBMITTER_ROLE`. The Investment Committee's analysts sign the receipt
off-chain. The Safe multisig, through the TimelockController, governs it.

Human wallets and the receipt submitter call the vaults system directly. The
vaults system never depends on the rmpc gateway system. It is deployed in
its own run and tested on its own.

## rmpc Gateway System

The rmpc gateway system is `rmpc` and the Agent Permissions Gateway it
needs (owner decision, 2026-10-19). `rmpc` is an agentic cryptographic
signer for end users. Its uses are off-chain: signing, keystores, the
committee-identity Ed25519 signer, config export, and reads. Its one
on-chain write is an agent deposit into an allowed vault through the
gateway. The system is a client of the vaults system. It calls the same
public vault deposit surface a human wallet uses. It is deployed after the vaults system, in
its own run, and tested on its own.

## Vault

A Robot Money vault is an individual strategy container. It accepts a
supported asset, deploys or manages that asset according to a specific
mandate, and issues a receipt token for deposits.

A vault is also a normalization layer. On-chain assets and venues have
heterogeneous interfaces: deposit methods, withdrawal methods, receipt
tokens, rebasing behavior, valuation math, liquidity constraints, and
reporting conventions differ across protocols. A well-designed vault
absorbs that heterogeneity and presents a predictable product surface:
deposit, withdraw, receipt, NAV, risk state, and performance.

Examples:

- Stable-yield vault.
- Protocol-asset vault.
- Agent-token vault.
- Future thematic or RWA vaults.

## NAV (Net Asset Value)

Dual-role system valuation:

1. **System-layer role:** NAV = aggregate `totalAssets()` across all active
   counted adapters. Used for protocol guards: NAV growth rate limiter
   (prevents admin inflation per §4.3a), ORA-4 NAV-deviation guard (reverts
   entry-side `deploy()` if market spot > TWAP + 2000 bps), TVL cap
   enforcement, and withdrawal liveness (exempt from NAV growth gate, per
   design rationale #1211). This NAV is on-chain, contract-enforced, and
   atomically consistent.

2. **User-layer role:** User share VALUE = market price of underlying
   assets held (via adapter routing), NOT this on-chain NAV. The protocol
   explicitly separates these: NAV guards the system; users' economic
   outcomes depend on market prices and adapter routing quality. UI must
   disclose this distinction at every point NAV appears (per
   `docs/prd.md` §NAV disclosure and `docs/technical/asset-valuation-hybrid.md`
   hybrid design rationale).

   Mathematical: `user_share_value_market ≠ totalAssets() / supply`,
   though both are derived from the same underlying adapter `totalAssets()`
   calls. Divergence occurs due to: TWAP vs. spot pricing, adapter slippage,
   fee distribution, and market movement between deposit and withdrawal.

Note: `totalAssets()` is the load-bearing C1 denominator for ERC-4626
conformity (share mint/burn), but its value does not equate to user
economic outcome. See `docs/technical/asset-flow-semantics.md` for
implicit vs. explicit asset flow design, and
`docs/technical/asset-valuation-hybrid.md` for the hybrid approach
rationale.

## Underlying Vault

An underlying vault is any individual Robot Money vault used as a
destination by the Portfolio Router.

## Vault Adapter

A vault adapter is an internal module used by one Robot Money vault to
connect that vault to an underlying strategy or venue.

Adapters are not vaults, are not Portfolio Router destinations, and are
not selected directly by users or agents. They sit inside a vault's
implementation and handle venue-specific operations such as deploying
USDC, withdrawing USDC, and reporting the vault's live value in that
venue.

Adapters are the venue-normalization layer inside a vault. They let a
vault speak to heterogeneous protocols without leaking those protocol
differences to users, agents, or the Portfolio Router. Adapters also
expose a rescue path so the owning vault can recover tokens from the
adapter in an emergency; the rescue function may not sweep USDC or
protected vault receipts.

Adding or changing a vault adapter is a privileged vault-management
operation and expands that vault's security and audit surface.

## Vault Receipt

A vault receipt is the token issued by an individual vault to represent
a depositor's claim on that vault.

Vault receipts are held by the depositor (shares from an agent deposit
are minted to the owner). The Portfolio Router does not turn them into a separate
outer share token.

## Portfolio Router

The Portfolio Router is the outermost allocation contract. It accepts a
deposit request and routes it across active underlying vaults according
to the current RM-governed target weights.

The Portfolio Router is not a vault and does not issue shares. Users
receive the underlying vault receipts directly.

## Portfolio Position

A portfolio position is the user's aggregate position across multiple
vault receipts produced by Portfolio Router deposits.

The position is a product and reporting concept, not a separate share
token. It is computed from the user's underlying vault receipt balances,
current vault values, and current router weights.

## Composite View

The composite view is the UI, CLI, and agent-readable presentation of a
portfolio position as one allocation.

It must preserve drill-down into the underlying vaults, receipt
balances, weights, valuations, fees, and any unavailable leg.

## Router Weights

Router weights are the target allocation percentages the Portfolio
Router uses when splitting deposits across active underlying vaults.

Router weights are the only governance surface specified for the
current product scope.

## Router-Weight Governance

Router-weight governance means the Safe multisig, through the
TimelockController, applies the Investment Committee's consensus receipt
to the router weights as one timelock operation. `WEIGHT_SETTER_ROLE`,
held by `RouterGovernance`, is the only authority over router weights.
There is no voting by token holders or anyone else.

Router-weight governance does not control:

- vault onboarding,
- vault retirement,
- per-vault asset selection,
- per-vault strategy selection,
- fees,
- agent permissions,
- or user-specific portfolio positions.

## Agent Policy

An agent policy is the depositor-owned permission set for an autonomous
agent. It bounds the agent's one on-chain action, a deposit into a
vault: spend caps, expiry, share receiver (always the owner), and allowed
vaults.

The depositor who authorizes the agent owns the policy. The Robot Money
team does not manage user agent policies at runtime.

## Agent Permissions Gateway

The Agent Permissions Gateway is the on-chain permission and safety
layer for autonomous-agent writes.

It is not a vault, not the Portfolio Router, and not a vault adapter. It
holds the depositor's authorization and policy
(`commitAuthorization`/`revealAuthorization`, `setPolicy`, `revokeAgent`)
and performs one action: the agent deposit.
It enforces the policy and forwards accepted USDC into an allowed vault,
with vault shares minted to the share receiver (always the owner).

The gateway has no withdrawal path and no Portfolio Router path. The
depositor withdraws or redeems directly on the vault.

Agents cannot use the gateway to choose their own share receiver, raise
caps, expand destinations, change vault mandates, alter router weights,
add adapters, or bypass a disabled vault.

The gateway belongs to the rmpc gateway system. It is not part of the
vaults system. Receipt writes do not go through it.
