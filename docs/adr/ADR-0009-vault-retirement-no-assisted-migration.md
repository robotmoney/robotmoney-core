# ADR-0009: Vault retirement — no on-chain migration; withdraw-only is the production behavior

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** Product owner
- **Related:**
  - `docs/development/open-questions.md` §1.C (depositor migration on vault retirement, §3.5)
  - `docs/adr/ADR-0003-basketvault-rebalancing-model.md` (deferred this question; new-deposits-only philosophy)
  - `docs/adr/ADR-0007-basket-vault-drawdown-redemption-policy.md` (redemption policy)
  - `contracts/VaultRegistry.sol` — `VaultStatus.Retired`, `setVaultStatus`
  - `docs/prd.md` §6 (Entity Lifecycle — Vault), §11 (Vault Catalog)

## Context

`contracts/VaultRegistry.sol` exposes a `Retired` value in the `VaultStatus`
enum. Once a vault is marked `Retired` via `setVaultStatus`:

- existing depositors can still call `redeem` directly on the ERC-4626 vault;
- `PortfolioRouter` rejects routing new deposits into a non-Active vault;
- there is no on-chain path to move a depositor's position from a retired vault
  to a successor vault, and no gateway-routed redeem-and-redeposit helper.

`docs/development/open-questions.md` §1.C lists this as open: *"Retirement is a
one-way status and existing depositors can still withdraw, but there is no forced
or assisted migration path out of a retiring vault. Decide whether one is
needed."* `ADR-0003` explicitly deferred it. No ADR or implementation-plan entry
closes it.

### ERC-4626 baseline guarantee

Every Robot Money vault implements ERC-4626, which requires `redeem` to remain
callable by the share owner (or an approved operator) at any time. The `Retired`
registry status is registry *state* only — consumed by `PortfolioRouter` to gate
*new deposits* — and does not alter vault contract code. A depositor in a retired
vault retains full, unconditional redemption rights.

### PRD lifecycle language

`docs/prd.md` §6 models the vault lifecycle as `active -> retired; retired ->
redeemable archive when redemptions remain available`. A retired vault is a
*redeemable archive* — a state where holders can exit, not a state where protocol
machinery moves funds on their behalf. No PRD requirement mandates an assisted
migration path.

## Decision

**There is deliberately no on-chain migration. The withdraw-only behavior of
`VaultRegistry.VaultStatus.Retired` is the production behavior.**

Retired vaults keep standard ERC-4626 `redeem`. There is no admin-driven forced
migration and no gateway-routed redeem-and-redeposit mechanism. Depositors in a
retired vault retain full, unconditional redemption rights and may exit at any
time. `PortfolioRouter` does not route new deposits into a retired vault.

Any "assisted migration" must be a **user-initiated, user-signed
redeem-then-deposit flow at the dapp/app layer** — no contract changes, no admin
power over user funds.

### Rationale

- **Never move user funds without explicit per-user consent.** Admin-driven
  redeem-and-redeposit is a custodial anti-pattern: it gives an admin power over
  depositor funds and creates new attack surface. The protocol must never move a
  user's position without that user's own signed transaction.
- **ERC-4626 already guarantees self-service exit.** No depositor funds are ever
  trapped; a depositor can always redeem directly.
- **The PRD does not require migration.** §6 frames retired vaults as redeemable
  archives.
- **Assisted migration adds unjustified complexity and risk.** A redeem-and-
  redeposit flow would introduce a transient USDC balance in the gateway, a
  successor-vault registry (a governance surface), partial-failure edge cases,
  and expanded MEV / re-entrancy surface — none justified when the depositor can
  self-serve.
- **Operator communication is the appropriate migration UX.** On retirement the
  operator announces the recommended successor via dapp/rmpc notices and the
  `VaultStatusChanged` event; depositors self-select using the standard deposit
  flow.
- **Consistency with ADR-0003.** Same philosophy: no forced global action; the
  protocol never moves funds on a depositor's behalf.

## Alternatives considered

- **Admin-driven forced migration (redeem-and-redeposit on behalf of users)** —
  rejected: custodial anti-pattern; grants admin power over user funds; transient
  gateway USDC balance, partial-failure handling, and a successor-vault
  governance registry all expand attack surface for no benefit over self-service.
- **Gateway-routed assisted migration helper (user pre-authorises gateway to
  move shares)** — rejected for the MVP: still requires a successor-vault
  registry and partial-failure handling, and expands the MEV surface; the same
  outcome is achievable as a user-initiated redeem-then-deposit at the app layer
  with no contract changes.
- **Keep §1.C open** — rejected: leaves a blocking lifecycle question unresolved
  when the withdraw-only behavior is already correct and safe for production.

## Consequences

**Positive.**

- Zero new on-chain complexity: no successor-vault registry, no gateway migration
  path, no new attack surface.
- Depositor self-sovereignty preserved — no protocol action moves funds without a
  user's signed transaction.
- `VaultRegistry.Retired` is safe for production use as-is.
- Consistent with ADR-0003.

**Negative / accepted risks.**

- Depositors must take an active redeem (+ optional redeposit) step to migrate. An
  inactive depositor's funds remain in the retired vault earning whatever it still
  produces; this is accepted (the depositor's inaction is their choice).
- Off-chain notification quality determines how quickly depositors learn of a
  retirement; mitigated by the `VaultStatusChanged` event and indexer-driven dapp
  notices.

**Out of scope of this decision.**

- dapp/rmpc retirement-notice UI and any app-layer assisted-migration convenience
  flow (off-chain; user-initiated and user-signed only).
- Indexer handling of `VaultStatusChanged` for retirement.
- Basket-vault drawdown redemption policy — see ADR-0007.
- In-vault agent trading authority — see ADR-0008.

## NatSpec disclosure

A NatSpec comment on `VaultRegistry.VaultStatus.Retired` records the explicit
no-on-chain-migration decision and references this ADR.
