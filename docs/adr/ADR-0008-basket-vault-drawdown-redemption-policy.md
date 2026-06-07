# ADR-0008: Basket-vault drawdown redemption policy — NAV haircut at TWAP

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Product owner
- **Related:**
  - `docs/development/open-questions.md` §1.C (basket-vault drawdown redemption policy, §3.7)
  - `docs/adr/ADR-0003-basketvault-rebalancing-model.md` (out-of-scope note at line 136)
  - `docs/architecture.md` §4.1, §8
  - `contracts/vaults/BasketVault.sol` — `previewRedeem`, `_withdraw`, `_sellProportional`
  - `contracts/VaultRegistry.sol` — `setRouterEligible`

## Context

`docs/development/open-questions.md` §1.C records:

> *"Basket-vault drawdown redemption policy (§3.7). Specify the redemption policy when
> a basket vault is in drawdown — forced sale vs. queued withdrawal vs. NAV haircut —
> before ADMIN_ROLE marks any basket vault router-eligible."*

`ADR-0003` explicitly excludes this decision from its scope (line 136). No subsequent
ADR addresses it. Zero contract code references a drawdown path. Until this policy is
decided, `VaultRegistry.setRouterEligible` must not be called for `ProtocolAssetVault`
or `AgentTokenVault`, because depositors would have no guaranteed exit during a drawdown
event.

Three options were considered:

**Option A — Forced sale:** When drawdown is detected, the vault automatically sells
assets to meet redemption. Requires: an oracle feed defining "drawdown", an
executor/keeper mechanism, gas/MEV analysis. Adds a new attack surface and imposes
socialized swap costs on all shareholders.

**Option B — Queued withdrawal:** Redemptions are queued and filled as liquidity
permits. Requires: a queue data structure in `BasketVault.sol`, a processing mechanism,
and clear depositor messaging on wait times. Significant contract complexity; deferral
risk if queue processing stalls.

**Option C — NAV haircut:** Redeem at current TWAP NAV (which may be below deposit
value) with no forced sale or queue. `previewRedeem` already reflects both the
slippage floor and the exit fee. A depositor in a drawdown event redeems at the
current TWAP-priced NAV, accepting whatever loss that implies. No new contract
machinery is needed.

## Decision

**Option C — NAV haircut at TWAP is adopted as the MVP drawdown redemption policy.**

Depositors in a basket vault (`ProtocolAssetVault`, `AgentTokenVault`) who redeem during
a drawdown period receive the current TWAP-based NAV, minus the configured slippage
bound and exit fee. There is no forced sale, no withdrawal queue, and no gating on
redemption during drawdown.

### Rationale

**Consistency with ADR-0003 philosophy.** ADR-0003 rejects socialized costs and
complex keeper mechanisms for the MVP. The same reasoning applies here: forced sale
(Option A) opens a MEV attack surface and requires a keeper; queued withdrawal (Option B)
introduces a new data structure, processing complexity, and a potential stall vector.

**Mechanism already in place.** `BasketVault.previewRedeem` already computes the
worst-case floor as:

```
floor = TWAP_NAV × (1 − maxSlippageBps) × (1 − exitFeeBps)
```

This floor is manipulation-resistant because `totalAssets()` uses the per-asset TWAP
oracle (minimum 10-minute window, configurable up to 24 hours) rather than spot price.
A flash-loan sandwich cannot materially move the TWAP-derived NAV within a single block.
`_withdraw` → `_sellProportional` executes market sales at or above this floor, or
reverts. Depositors receive at least `previewRedeem(shares)` USDC, denominated at
TWAP NAV minus slippage.

**Depositor transparency.** The existing `previewRedeem` view gives depositors a
worst-case floor before they submit the transaction. During drawdown, when basket asset
prices are depressed, `previewRedeem` returns a lower value, giving depositors full
visibility into their expected exit price before committing.

**No contract changes required.** The current `BasketVault` implementation already
supports instantaneous, synchronous redemption at TWAP-derived NAV with the configured
slippage tolerance. No new storage, no new roles, no new functions.

**Emergency path.** If a drawdown becomes severe enough to threaten synchronous
redemption (e.g., pool liquidity collapses below the slippage bound), `EMERGENCY_ROLE`
can invoke `emergencyUnwind()` to convert all basket assets to USDC, after which
redemptions settle directly in idle USDC with zero slippage. `shutdownVault()` is
available as a final gate if necessary.

### Constraints and disclosures

1. **No guaranteed floor relative to deposit value.** A depositor who deposits when
   basket assets are at a high and redeems during a drawdown may receive less USDC than
   deposited. This is disclosed in NatSpec on `previewRedeem` and is consistent with
   ERC-4626 semantics (the vault only guarantees `redeem ≥ previewRedeem`, not that
   `previewRedeem ≥ deposit`).

2. **Minimum haircut cap not imposed.** No on-chain cap is placed on the magnitude of
   the NAV haircut. Extreme drawdowns (e.g., a basket asset going to near-zero) will
   result in proportionally low redemption proceeds. This is accepted in the MVP.
   A cap can be introduced in a future phase via an `minNavBps` parameter.

3. **Pool liquidity floor enforced at asset registration.** `BasketVault.addAsset`
   already enforces `MIN_POOL_LIQUIDITY = 1e6` at the time of asset registration
   (gap-report §1). Production operators are expected to maintain pool depth well above
   this floor; governance is responsible for removing assets whose liquidity collapses
   below a safe threshold.

## Consequences

**Positive.**

- Zero new contract code. No new storage slots, roles, or functions.
- Depositors can always exit synchronously (no queue, no gating) at the TWAP-derived
  NAV floor.
- Consistent with the ADR-0003 philosophy: no socialized costs, no keeper trust.
- Unblocks `VaultRegistry.setRouterEligible` for `ProtocolAssetVault` and
  `AgentTokenVault` once audits and oracle hardening are complete.
- Clears `docs/development/open-questions.md` §1.C drawdown policy entry.

**Negative / accepted risks.**

- Depositors bear full NAV risk during drawdown. There is no protocol-level protection
  against holding-period losses beyond the TWAP manipulation resistance.
- A mass redemption event during a severe drawdown could create a self-reinforcing
  sell spiral (each redemption drives basket asset prices lower, worsening NAV for
  remaining depositors). This is a well-known ERC-4626 risk and is mitigated by
  the TWAP window (prevents single-block manipulation) and the `emergencyUnwind`
  escape hatch.

**Out of scope of this decision.**

- Minimum NAV floor relative to deposit value (Phase B enhancement).
- Queued or gated withdrawals (Phase B, requires separate ADR).
- Forced-sale automation / keeper mechanism (Phase B, requires MEV analysis ADR).
- Depositor migration on vault retirement (open-questions §3.5; separate decision).

## NatSpec disclosure (added to `BasketVault.sol`)

See the `previewRedeem` and `_withdraw` NatSpec blocks in
`contracts/vaults/BasketVault.sol`. The following disclosure is added to
`previewRedeem`:

```solidity
/// @notice Drawdown policy (ADR-0008): this vault uses a NAV-haircut redemption
///         model. During a drawdown event basket asset prices may be below deposit
///         value; `previewRedeem` returns the TWAP-priced NAV floor (after
///         maxSlippageBps and exitFeeBps). The protocol does not queue, gate, or
///         force-sell assets to protect depositor principal — depositors accept
///         current NAV on exit. See docs/adr/ADR-0008-basket-vault-drawdown-
///         redemption-policy.md.
```
