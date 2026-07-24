# Retired v1 vault — indefinite maintenance obligation

This runbook assigns the **ongoing operational obligation** that survives after a
v1 vault is retired during the unified-Vault (ADR-0010) environment migration. It
is a **recommendations registry entry** in the sense of
[`manual-admin-actions.md`](manual-admin-actions.md): the actions here are manual,
mainnet-touching, and deliberately out of scope for the automated development
loop. The loop must not carry them as automated acceptance criteria.

## Why this obligation exists

The unified-Vault migration does not move depositor funds. Per
[`ADR-0009`](../adr/ADR-0009-vault-retirement-no-assisted-migration.md) a vault is
retired by setting `VaultRegistry.VaultStatus.Retired`, which:

- halts new deposits at both the vault (deposit-halt flag) and the
  `PortfolioRouter` (`VaultNotActive` / not-router-eligible); and
- leaves **redemption open indefinitely** — both direct ERC-4626 `redeem` and
  `PortfolioRouter.redeemFor` honor a `Retired` vault (only `Paused` blocks exit).

There is **no assisted migration** (ADR-0009): the only path out of a retired v1
vault is a depositor's own signed `redeem`. A depositor may take that step at any
time, days or years later. Therefore **every dependency a retired v1 vault needs
to price and settle a redemption must keep working for as long as any share of
that vault remains outstanding** — i.e. until `totalSupply() == 0`. Retiring the
vault does *not* retire these dependencies.

The migration sequence that reaches this state is the canonical
`register → eligible (+weights, atomic) → weights → retire` ordering codified by
`contracts/test/V2MigrationIntegration.t.sol`; this runbook covers the tail after
the final `retire()`.

## The obligation, per v1 vault composition

### deSPXA RWA / thematic vault (Chronicle-priced) — the load-bearing case

The retired deSPXA v1 vault (`RwaVault`, PRD §11.4, ADR-0006) prices redemptions
from a **Chronicle NAV feed** and settles the RWA→USDC leg through an **Aerodrome
pool**. Both are external, operator-funded dependencies:

1. **Chronicle feed — keep it live and fresh, indefinitely.** Redemption NAV is
   read through the Chronicle `AssetPositionAdapter` with a heartbeat staleness
   check (invariant `ORA-2`). If the feed goes stale or is decommissioned, priced
   reads fail closed and a holder that still owns a *priced* balance cannot
   settle. The zero-balance short-circuit (invariant `SUP-5`) only rescues a vault
   whose RWA balance has already fully drained to idle USDC — it does **not**
   rescue a holder whose position still contains the priced asset. **Obligation:**
   keep the Chronicle deSPXA feed subscribed, funded, and publishing within its
   heartbeat until the retired vault's `totalSupply() == 0`.
2. **Aerodrome pool liquidity — maintain it, indefinitely.** Redemption settles
   the RWA leg by swapping through the registered Aerodrome pool. The
   `AssetPositionAdapter` enforces `ORA-3` (execution pool == TWAP pool) and an
   `ORA-4` deviation band on the *entry* side only — **redemption is never blocked
   by the deviation guard** (exit-liveness, unified-vault-spec §5.3) — but a pool
   with insufficient liquidity still yields poor execution or a slippage-floor
   revert. **Obligation:** keep the deSPXA/USDC Aerodrome pool liquid enough to
   absorb the outstanding retired-vault redemptions until `totalSupply() == 0`.

### Basket vaults with priced-asset legs (rmPROTO / rmAGENT v1)

Any retired v1 basket vault that still holds a priced asset (Uniswap V3/V4 or
Aerodrome TWAP-priced leg) carries the same shape of obligation for **its**
execution pools: keep each registered TWAP/execution pool liquid until the vault's
`totalSupply() == 0`, because redemption swaps the basket leg to USDC. These
vaults have no external price-feed subscription (TWAP is derived on-chain from the
pool itself), so the feed obligation collapses into the pool-liquidity obligation.

### Lending vault (rmUSDC v1)

A retired lending vault (`RobotMoneyVault` + Morpho/Aave/Compound adapters) has
**no external feed or pool obligation**: redemption pulls idle USDC and
proportional adapter balances directly, priced at venue balances, not an oracle or
AMM pool. The only residual obligation is that the underlying lending venues stay
solvent/withdrawable — a property of the venue, not an operator action. No
standing task is assigned here beyond the venue-monitoring already covered by
`suite-18-upstream-monitoring`.

## When the obligation ends

The obligation for a retired vault ends **only** when that vault's ERC-4626
`totalSupply()` reaches zero (no shares outstanding — every depositor has
redeemed). Until then, the feed subscription and pool liquidity are a standing
mainnet cost the operator must budget for. This is the accepted-risk tail called
out in ADR-0009 ("an inactive depositor's funds remain in the retired vault"): the
protocol cannot force those holders out, so it must keep their exit path priced
and liquid.

**Decommission checklist (per retired vault):**

- [ ] Confirm `IERC20(vault).totalSupply() == 0` on-chain (Base `8453`).
- [ ] Confirm `VaultRegistry.getVault(vault).status == Retired` (never
      un-retired).
- [ ] Only then: unsubscribe/defund the Chronicle deSPXA feed (RWA case) and/or
      withdraw the operator-provided Aerodrome/execution-pool liquidity.
- [ ] Record the decommission in the operator log; the vault stays in
      `listVaults()` forever (invariant `LIFE-2`, append-only registry) as a
      zero-supply archive.

Never decommission a feed or drain a pool while `totalSupply() > 0`: doing so
would strand a still-redeemable holder, violating the redeemability guarantees
(`INV-2`, `SUP-5`) that ADR-0009 relies on.

## Monitoring

- **Outstanding-supply watch.** Track `totalSupply()` of every retired vault; a
  non-zero value is the live signal that the maintenance obligation is still in
  force. The indexer already ingests `VaultStatusChanged`; a retired vault with
  non-zero supply should surface on the operator dashboard as an open obligation.
- **Feed freshness watch (RWA).** Alert if the Chronicle deSPXA feed approaches
  its heartbeat while the retired vault still holds a priced balance — a stale
  feed fails priced redemptions closed (`ORA-2`).
- **Pool-liquidity watch.** Alert if the registered execution pool's liquidity
  falls below the depth needed to settle the outstanding retired-vault shares.

## Related

- [`ADR-0009`](../adr/ADR-0009-vault-retirement-no-assisted-migration.md) —
  retirement is withdraw-only; no on-chain/assisted migration.
- [`ADR-0010`](../adr/ADR-0010-unified-vault-architecture.md) — the unified-Vault
  target the v1 vaults are retired into.
- [`docs/technical/unified-vault-spec.md`](../technical/unified-vault-spec.md) §5.3
  (exit-liveness), §6 (invariant-preservation matrix).
- [`docs/technical/smart-contract-invariants.md`](../technical/smart-contract-invariants.md)
  — `INV-2`, `SUP-5`, `ORA-2`, `ORA-3`, `ORA-4`, `LIFE-2`, `LIFE-5`.
- [`manual-admin-actions.md`](manual-admin-actions.md) — sibling registry of
  manual, out-of-automation operator actions.
</content>
</invoke>
