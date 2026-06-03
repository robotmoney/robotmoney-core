# ADR-0006: deSPXA RWA vault — asset, Chronicle oracle, Aerodrome swap-only entry/exit, freeze risk

- **Status:** Accepted
- **Date:** 2026-06-03
- **Deciders:** Product owner
- **Related:**
  - `docs/prd.md` §11.4 (RWA / Thematic Vault)
  - `config/dex-pools.json`
  - `docs/architecture.md`

## Context

The Robot Money RWA / Thematic Vault (rmRWA) must become a real-asset vault
holding Centrifuge deSPXA — a tokenized S&P 500 exposure issued by Janus
Henderson / Anemoy through the Centrifuge V3 protocol and bridged to Base.

deSPXA carries several constraints that force a specific vault design before
implementation can begin:

1. **ERC-7540 primary NAV redemption is KYC-gated.** deSPXA uses ERC-7540
   async mint/redeem for primary NAV operations, which require the requesting
   address to pass Centrifuge KYC. A permissionless vault cannot satisfy this
   requirement, so the primary redemption path is entirely off-limits.

2. **FreelyTransferable ERC-20 secondary transfer is permissionless.** deSPXA
   implements a `FreelyTransferable` ERC-20 transfer hook that allows secondary
   market trades on DEXes such as Aerodrome (Base) without KYC. This is the only
   available permissionless entry/exit path.

3. **Issuer freeze-control risk.** The Centrifuge / Janus Henderson issuer may
   freeze or restrict deSPXA transfers at any time via on-chain controls. A
   freeze would block the vault's only entry/exit path independently of DEX
   liquidity or oracle health.

4. **NAV pricing requires an on-chain oracle.** Spot prices on Aerodrome can
   deviate from NAV, and no TWAP is available for thinly-traded RWA tokens.
   Chronicle provides a signed, push-updated NAV oracle for deSPXA on Base.

5. **Contract addresses must be pinned at implementation time.** The deSPXA
   ERC-20 address, the Aerodrome pool address and fee tier, and the Chronicle
   feed address are not yet recorded in `config/dex-pools.json` or any canonical
   config file. They must be resolved and pinned by the implementation issue
   before any Solidity code or integration test is written.

These constraints collectively force the hold-and-swap model described below.

## Decision

### 1. Vault model: hold-and-swap via Aerodrome secondary market only

The rmRWA vault uses the **hold-and-swap** model:

- **Entry:** depositor supplies USDC → vault executes an Aerodrome secondary
  swap USDC → deSPXA → vault holds deSPXA.
- **Exit:** depositor requests withdrawal → vault executes an Aerodrome
  secondary swap deSPXA → USDC → depositor receives USDC.
- **Primary ERC-7540 NAV redemption is never used.** The vault does not call
  `requestRedeem`, `redeem`, or any Centrifuge V3 epoch operator. This is an
  explicit, permanent non-goal — not a deferral.

Rationale: ERC-7540 primary redemption requires KYC that a permissionless
smart-contract vault cannot satisfy. The secondary Aerodrome path is the only
viable permissionless route for both entry and exit.

### 2. Oracle: Chronicle NAV oracle for deSPXA (Base)

NAV pricing is supplied exclusively by the **Chronicle on-chain NAV oracle**
for deSPXA on Base.

- The vault reads the latest signed price from the Chronicle feed.
- The vault reverts with a custom error (`StalePriceFeed(uint256 updatedAt,
  uint256 heartbeat)`) if the feed has not been updated within the configured
  heartbeat window (initially 24 hours, configurable by admin up to 48 hours).
- The vault does not fall back to spot price if the Chronicle feed is stale.
  A stale oracle halts deposits and withdrawals (price-dependent operations)
  until the feed is refreshed.
- The implementation issue must pin the exact Chronicle feed address on Base
  before deploying or testing the oracle integration.

No other pricing source (Aerodrome TWAP, Chainlink, Pyth) is used for this
vault. Chronicle is the canonical NAV oracle for Centrifuge RWA tokens on Base.

### 3. Aerodrome pool selection and slippage

- Entry and exit both route through a **single Aerodrome stable or concentrated
  pool** for the deSPXA/USDC pair.
- The pool address, fee tier, and whether it is a stable or concentrated pool
  must be resolved and pinned in `config/dex-pools.json` by the implementation
  issue.
- Maximum swap slippage is enforced by a configurable `maxSlippageBps` parameter
  (admin-settable, initially 50 bps). Swaps that would exceed this threshold
  revert with `SlippageExceeded(uint256 expected, uint256 received, uint256
  maxBps)`.
- Swap execution uses the Chronicle NAV price as the reference price for
  slippage calculation, not the Aerodrome spot price, so NAV-anchored slippage
  protection is preserved even when Aerodrome liquidity is thin.

### 4. Issuer freeze-control risk: documentation and vault behavior

**Risk:** Centrifuge / Janus Henderson may freeze deSPXA transfers at the token
level at any time. A freeze would cause all Aerodrome swaps involving deSPXA to
revert, blocking vault deposits and withdrawals for all users simultaneously.

**Vault behavior under a freeze:**

- Deposits revert (USDC → deSPXA swap fails at the ERC-20 `transferFrom` level).
- Withdrawals revert (deSPXA → USDC swap fails at the ERC-20 `transfer` level).
- Existing rmRWA holders retain their share tokens; the vault does not confiscate
  or redistribute. No automatic exit mechanism is triggered.
- The admin may call `pause()` to halt all vault operations cleanly so that
  error messages are user-facing rather than opaque ERC-20 reverts.

**Disclosure:** The freeze-control risk is disclosed to users in:

1. This ADR (engineering decision record).
2. `docs/prd.md` §11.4 (product specification).
3. The dapp vault detail page for rmRWA, which must display a risk-disclosure
   banner that explicitly names the issuer freeze-control risk.

The freeze-control risk is a known, accepted product risk for this vault
category. It is not a blocker for shipping the vault; it is an inherent property
of tokenized RWA assets.

### 5. Address-pinning requirement

The following addresses **must** be resolved from on-chain data (not guessed or
taken from documentation) and pinned in canonical config before the
implementation issue writes any Solidity code or integration test:

| Item | Where to pin | Status |
| --- | --- | --- |
| deSPXA ERC-20 address on Base | `config/dex-pools.json` and vault constructor | TBD — implementation issue |
| Aerodrome pool address for deSPXA/USDC | `config/dex-pools.json` | TBD — implementation issue |
| Aerodrome pool fee tier (stable or concentrated) | `config/dex-pools.json` | TBD — implementation issue |
| Chronicle NAV feed address for deSPXA on Base | vault constructor / deployment config | TBD — implementation issue |

The implementation issue must verify these addresses against live Base mainnet
state (e.g., Basescan, Aerodrome Factory, Chronicle feed registry) before
pinning. A mismatched address renders the vault non-functional in a way that
tests on a forked devnet would not catch.

## Consequences

**Positive.**

- Permissionless vault — no KYC integration required, no epoch coordination
  with Centrifuge, no async redemption queue.
- Chronicle NAV oracle provides a canonical, issuer-sanctioned price reference
  rather than an Aerodrome spot price that could be manipulated.
- Slippage cap anchored to NAV protects depositors from large deviations between
  Aerodrome spot and NAV.
- Stale-oracle halt is conservative (prefer hard revert over silently using
  a stale NAV price).

**Negative / accepted risks.**

- If the Chronicle feed is stale, all price-dependent operations are blocked.
  Users cannot enter or exit until the oracle is refreshed. This is a live
  dependency on Chronicle's keeper network.
- Aerodrome secondary liquidity may be thin. Large swaps will incur significant
  price impact, which the NAV-anchored slippage cap will reject. The vault is
  not suitable for large single-block redemptions.
- The issuer freeze-control risk is non-mitigatable at the vault level.
  If deSPXA is frozen, neither admin intervention nor protocol upgrade can
  unblock swaps until the issuer reverses the freeze.

**Out of scope of this decision.**

- Implementing the vault in Solidity (Phase F issue, separate from this ADR).
- Integrating ERC-7540 primary NAV mint/redeem (explicit permanent non-goal).
- Resolving and pinning the specific contract addresses (implementation issue
  responsibility — this ADR only records the requirement to pin them).
- Chronicle feed staleness alerting or keeper incentive design.
- Multi-hop routing through Aerodrome if the direct deSPXA/USDC pool has
  insufficient liquidity.

## Implementation checklist (for Phase F implementation issue)

- [ ] Resolve and pin deSPXA ERC-20 address on Base in `config/dex-pools.json`.
- [ ] Resolve and pin Aerodrome deSPXA/USDC pool address and fee tier in
  `config/dex-pools.json`.
- [ ] Resolve and pin Chronicle NAV feed address for deSPXA on Base in vault
  deployment config.
- [ ] Implement `RwaVault` with Aerodrome swap adapter for entry/exit.
- [ ] Implement Chronicle oracle reader with stale-feed revert.
- [ ] Add `maxSlippageBps` parameter and NAV-anchored slippage check.
- [ ] Add `pause()` / `unpause()` admin controls.
- [ ] Add freeze-control risk banner to dapp rmRWA vault detail page.
- [ ] Write fork-based integration test confirming swap entry/exit and stale-feed
  revert (no primary ERC-7540 calls made).
