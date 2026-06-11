# ADR-0007: Basket-vault drawdown redemption policy — NAV haircut at current per-share NAV

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** Product owner
- **Related:**
  - `docs/development/open-questions.md` §1.C (basket-vault drawdown redemption policy, §3.7)
  - `docs/adr/ADR-0003-slippage-adjusted-basket-vault-preview.md` (slippage-adjusted `previewRedeem` floor)
  - `docs/adr/ADR-0003-basketvault-rebalancing-model.md` (out-of-scope note; new-deposits-only philosophy)
  - `docs/adr/ADR-0001-mvp-agent-token-shortlist.md` (admin-curated, equal-weighted scope)
  - `docs/prd.md` §11.2 (Protocol Asset Vault), §11.3 (Agent Token Vault)
  - `contracts/vaults/BasketVault.sol` — `previewRedeem`, `_withdraw`
  - `contracts/VaultRegistry.sol` — `setRouterEligible`

## Context

`docs/development/open-questions.md` §1.C records:

> *"Basket-vault drawdown redemption policy (§3.7). Specify the redemption policy
> when a basket vault is in drawdown — forced sale vs. queued withdrawal vs. NAV
> haircut — before ADMIN_ROLE marks any basket vault router-eligible."*

`ADR-0003` (rebalancing model) explicitly excludes this decision from its scope.
No subsequent ADR addresses it. Until this policy is decided, a basket vault
(`ProtocolAssetVault`, `AgentTokenVault`) cannot be marked router-eligible,
because depositors would have no agreed exit semantics during a drawdown event.

A "drawdown" here means any period in which the per-share NAV of the basket has
fallen below a depositor's entry value — typically because the underlying basket
assets (wETH, cbBTC, wSOL for rmPROTO; the agent-token shortlist for rmAGENT)
have dropped in price. The question is what a depositor receives when they
redeem during such a period.

### Existing redemption mechanism

`BasketVault.previewRedeem` (see ADR-0003-slippage-adjusted-basket-vault-preview)
already returns a worst-case floor:

```
floor = TWAP_NAV × (1 − maxSlippageBps) × (1 − exitFeeBps)
```

`totalAssets()` is TWAP-priced (not `slot0`), so the per-share NAV is
manipulation-resistant within a single block. `_withdraw` executes the
proportional asset sales at or above this floor, or reverts. Redemption is
therefore already synchronous, pro-rata, and priced at current NAV minus the
configured slippage bound and exit fee. No drawdown-specific code path exists.

### Options considered

- **Option A — Forced sale.** On detecting a drawdown, the vault automatically
  liquidates assets to meet redemptions. Requires an oracle-defined drawdown
  trigger, a keeper/executor, and MEV analysis. Crystallizes fire-sale losses
  for all holders and adds a new attack surface.
- **Option B — Queued withdrawal.** Redemptions are queued and filled as
  liquidity permits. Requires a queue data structure, processing mechanism, and
  wait-time messaging. Removes the guaranteed-instant-exit property and adds a
  stall vector.
- **Option C — NAV haircut.** Redeem at current per-share NAV (already reflecting
  drawdown via the slippage-adjusted `previewRedeem`), with no forced sale and no
  queue, bounded by a minimum-haircut / bounded-slippage cap so a thin-liquidity
  redemption cannot be sandwiched into catastrophic loss.

## Decision

**Option C — NAV haircut at current per-share NAV is adopted as the drawdown
redemption policy.**

Depositors in a basket vault always redeem at the current per-share NAV, which
already reflects any drawdown through the slippage-adjusted `previewRedeem` floor
(ADR-0003-slippage-adjusted-basket-vault-preview). There is **no forced sale**
and **no withdrawal queue**. Drawdown losses are borne pro-rata by the redeeming
depositor at the moment of exit, exactly as ERC-4626 semantics imply.

A **bounded-slippage / minimum-haircut cap** is enforced so that a redemption
into thin liquidity cannot be sandwiched into a catastrophic loss: the swap legs
are executed with `amountOutMinimum` anchored to the TWAP NAV minus
`maxSlippageBps`, and a redemption that cannot clear within that bound reverts
rather than settling at an attacker-chosen price. This is the same
`maxSlippageBps` floor already used by `previewRedeem`/`_withdraw`; this ADR
formalises it as the depositor-protection cap for the drawdown case and requires
that the cap remain conservative for any router-eligible basket vault.

### Rationale

- **Preserves the core ERC-4626 safety property.** Permissionless, instant,
  pro-rata exit at current NAV is the main structural defense against
  bank-run / contagion dynamics: every holder can always leave on equal terms in
  a single transaction. Forced sale and queued withdrawal both weaken this.
- **Forced sale crystallizes fire-sale losses for all holders** and adds keeper,
  oracle-trigger, and MEV surface (Option A rejected).
- **Queued withdrawal removes the guaranteed-exit property** and introduces a
  stall vector and new contract complexity (Option B rejected).
- **Minimal new mechanism.** The existing slippage-adjusted redemption math
  already implements the haircut; this decision adds only the requirement that
  the slippage cap be treated as a depositor-protection bound and documented as
  such. No new storage, roles, or functions.
- **Consistency with ADR-0003 philosophy.** No socialized costs, no keeper
  trust, no protocol action that moves funds on a depositor's behalf.

### What the policy guarantees

- A depositor can always redeem synchronously at current per-share NAV; the
  vault never gates or queues redemptions during drawdown.
- The amount received is at least `previewRedeem(shares)`, i.e. the TWAP NAV
  floor after `maxSlippageBps` and `exitFeeBps`. A redemption that cannot meet
  that floor reverts rather than settling at an unbounded loss.
- `previewRedeem` gives the depositor a worst-case quote before they sign,
  giving full visibility into the exit price even in a drawdown.

## Alternatives considered

- **Forced sale (Option A)** — rejected: crystallizes fire-sale losses across
  all holders, requires a drawdown oracle and keeper, and expands the MEV /
  re-entrancy surface for no depositor benefit over self-service redemption.
- **Queued withdrawal (Option B)** — rejected: removes the guaranteed-instant
  exit that is the protocol's primary contagion defense, adds a queue data
  structure and processing path, and introduces a stall vector if processing
  halts.
- **NAV haircut with no slippage cap** — rejected: leaves a thin-liquidity
  redemption open to sandwich attacks that could settle at a catastrophic price.
  The final decision retains the bounded-slippage / minimum-haircut cap.

## Consequences

**Positive.**

- Zero new contract machinery beyond documenting the existing slippage cap as a
  depositor-protection bound.
- Depositors can always exit synchronously and pro-rata at current NAV.
- Preserves the ERC-4626 guaranteed-exit property — the main defense against
  bank-run / contagion dynamics.
- **Unblocks router eligibility** for `ProtocolAssetVault` and `AgentTokenVault`:
  the drawdown redemption policy required by open-questions §1.C is now resolved
  (see `Plan tracking issue #109`, router-eligibility item). Any remaining
  audit gate is unaffected.

**Negative / accepted risks.**

- Depositors bear full NAV risk during a drawdown; there is no protocol-level
  principal protection beyond TWAP manipulation resistance and the slippage cap.
- A mass redemption during a severe drawdown can drive basket asset prices lower
  (a self-reinforcing sell pressure shared with all ERC-4626 vaults), mitigated
  by the TWAP window (no single-block manipulation) and, if liquidity collapses
  below the slippage bound, redemptions revert rather than settling at a
  catastrophic price.

**Out of scope of this decision.**

- A minimum NAV floor relative to *deposit* value (not provided; ERC-4626 only
  guarantees `redeem ≥ previewRedeem`).
- Queued or gated withdrawals (rejected here; any future change requires a new
  ADR superseding this one).
- Forced-sale automation / keeper mechanism (rejected here).
- Depositor migration on vault retirement — see ADR-0009 (open-questions §1.C,
  §3.5).
- In-vault agent trading authority — see ADR-0008 (open-questions §1.B, §3.2).

## NatSpec disclosure

A NatSpec block on `contracts/vaults/BasketVault.sol` documents the NAV-haircut
drawdown redemption policy and references this ADR.
