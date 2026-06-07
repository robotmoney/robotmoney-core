# ADR-0007: Vault retirement — no assisted migration; withdraw-only behavior is acceptable for production

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Engineering lead
- **Related:**
  - `docs/development/open-questions.md` §1.C (depositor migration on vault retirement, §3.5)
  - `docs/adr/ADR-0003-basketvault-rebalancing-model.md` — explicitly deferred this question (line 145)
  - `contracts/VaultRegistry.sol` — `VaultStatus` enum, `setVaultStatus`
  - `docs/prd.md` §6 (Entity Lifecycle — Vault), §9 (Constraints)
  - GitHub issue #682

## Context

`VaultRegistry.sol` exposes a one-way `Retired` enum value in `VaultStatus`.
Once a vault is marked `Retired` via `setVaultStatus`, existing depositors can
still call `redeem` on the ERC-4626 vault directly, but:

- `PortfolioRouter` rejects any new deposit routing into a non-Active vault
  (`VaultNotActive` revert path at lines 388 and 509 of `PortfolioRouter.sol`).
- There is no on-chain or off-chain path to atomically move a depositor's
  position from a retired vault to a successor vault.
- There is no gateway-routed redeem-and-redeposit helper.

`docs/development/open-questions.md §1.C` lists this as an open decision:
*"Decide whether one is needed."*

`ADR-0003` (line 145) explicitly deferred this question. No ADR, GitHub issue,
or implementation-plan entry exists that closes the question.

The dev-scout brief (issue #699, comment on issue #682, 2026-06-07) presented
two options:

- **Option A** — declare the current withdraw-only behavior acceptable for
  production use of `VaultRegistry.Retired`.
- **Option B** — specify and implement a gateway-routed redeem-and-redeposit
  flow.

### ERC-4626 baseline guarantee

Every Robot Money vault implements ERC-4626. The standard requires that
`redeem(shares, receiver, owner)` is always callable by the share owner (or
an approved operator). The `Retired` registry status does not modify vault
contract code — it is registry *state* only, consumed by `PortfolioRouter`
to gate *new deposits*. Withdrawals are unaffected: a depositor in a retired
vault retains full, unconditional redemption rights at any time.

### PRD §6 lifecycle language

`docs/prd.md §6` describes the vault lifecycle as:

> active → retired; retired → redeemable archive when redemptions remain available.

The PRD models a retired vault as a *redeemable archive* — a state where
existing holders can exit, not a state where protocol machinery must move funds
on their behalf. No PRD requirement mandates an assisted migration path.

### Why assisted migration is complex and risky

A gateway-routed redeem-and-redeposit flow would need to:

1. **Pull shares from the depositor into the gateway** (or obtain an approval)
   before calling `vault.redeem`.
2. **Choose a successor vault** — either hard-coded per-vault at retirement time
   (centralised decision) or left to the depositor (requiring an off-chain UI
   step that defeats the purpose of an assisted flow).
3. **Execute a cross-vault atomic swap** — redeem from the retiring vault,
   hold USDC transiently in the gateway, deposit into the successor vault. This
   sequence creates a transient USDC balance in the gateway, expanding the MEV
   and re-entrancy surface.
4. **Handle partial failures** — if the successor vault reverts (cap reached,
   paused, oracle stale), the depositor's position is in USDC at the gateway
   with no automatic fallback.
5. **Maintain an approved-successor registry** — the protocol must track which
   vault(s) are acceptable migration targets for a given retired vault. This
   registry itself becomes a governance surface.
6. **Require depositor trust** — any gateway-routed migration requires the
   depositor to approve the gateway to spend their shares before the migration
   executes, or the gateway must be pre-authorised at deposit time. The current
   gateway design (`authorizeAgent`) does not pre-authorise vault-to-vault moves.

These concerns mirror the rationale in ADR-0003 for rejecting a global
`rebalance()`: trusting an executing party to choose a fair moment, plus
socialized costs and new attack surfaces, is not justified in the MVP when the
depositor can self-serve.

## Decision

**Option A is adopted: the current withdraw-only behavior is acceptable for
production use of `VaultRegistry.Retired`.**

No assisted migration path is implemented. Depositors in a retired vault retain
full, unconditional ERC-4626 redemption rights and may exit at any time via
`redeem`. The protocol does not route new deposits into a retired vault
(`PortfolioRouter` rejects non-Active destinations). No gateway-routed
redeem-and-redeposit mechanism is introduced.

### Rationale

1. **ERC-4626 guarantees self-service exit.** Depositors can always redeem
   directly without protocol assistance. No depositor funds are ever trapped.

2. **The PRD does not require migration.** `docs/prd.md §6` frames retired
   vaults as redeemable archives, not as sources of protocol-managed migrations.
   `docs/prd.md §9` constrains the protocol to preserve withdrawal rights during
   shutdown/retirement — it does not require cross-vault fund movement.

3. **Assisted migration adds unjustified complexity and risk.** A
   redeem-and-redeposit flow introduces a transient USDC balance in the gateway,
   a successor-vault registry governance surface, partial-failure edge cases, and
   an expanded MEV surface. The risk-to-benefit ratio is not justified in the
   MVP.

4. **Operator communication is the appropriate migration UX.** When a vault is
   retired, the operator announces the retirement and recommended successor vault
   via dapp UI, rmpc CLI notices, and/or `VaultStatusChanged` event indexing.
   Depositors self-select into the successor vault using the standard deposit
   flow. This is simpler, more transparent, and less risky than an on-chain
   migration helper.

5. **Consistency with the rebalancing model.** ADR-0003 adopted the same
   philosophy (no forced global action; operators communicate intent; depositors
   act on their own behalf) for vault rebalancing. The retirement decision
   follows the same principle.

### What retirement does guarantee

- `VaultStatusChanged` event is emitted when status changes to `Retired`,
  allowing the indexer and dapp to surface a clear retirement notice to
  depositors.
- `PortfolioRouter` will not route new deposits into a Retired vault
  (`VaultNotActive` revert).
- `redeem` on the ERC-4626 vault remains callable by any depositor until the
  vault's USDC balance is exhausted.
- `rmpc` and the dapp should surface a retirement warning to any depositor
  holding shares in a retired vault (off-chain UI concern; not gated on this ADR).

## Consequences

**Positive.**

- Zero new on-chain complexity. No successor-vault registry, no gateway
  migration path, no new attack surface.
- Depositor self-sovereignty is preserved — no protocol action moves funds
  without an explicit depositor transaction.
- `VaultRegistry.Retired` is safe to use in production immediately upon
  merging this ADR.
- Consistent philosophy with ADR-0003 (new-deposits-only rebalancing model).

**Negative / accepted risks.**

- Depositors must take an active step (redeem + redeposit) to migrate. If a
  depositor is inactive and the vault has no redemption-blocking conditions,
  their funds sit in the retired vault earning whatever yield the retired vault
  still produces (which may be zero or declining). This is accepted: the
  depositor's inaction is their choice.
- Off-chain notification quality determines how quickly depositors become aware
  of a retirement. A depositor who misses the dapp notice and holds a retired
  vault with declining yield bears that opportunity cost. This is mitigated by
  the `VaultStatusChanged` event and indexer-driven dapp notices.
- A future phase may introduce an assisted migration helper (Phase B). When that
  happens, a new ADR superseding this one must address the successor-registry
  governance, partial-failure handling, and MEV concerns listed in the Context
  section above.

**Out of scope of this decision.**

- dapp and rmpc UI for retirement notices (off-chain, tracked separately).
- Indexer handling of `VaultStatusChanged` for retirement (off-chain, tracked separately).
- Phase B global `rebalance()` (separately tracked per ADR-0003).
- Basket-vault drawdown redemption policy (`open-questions.md §1.C §3.7` — a
  separate open question; see ADR to be written for that decision).

## Implementation checklist (closes issue #682)

- [x] Write this ADR.
- [x] Update `docs/development/open-questions.md §1.C` to mark depositor
      migration on vault retirement `Resolved` with a link to this ADR.
- [x] Add NatSpec comment on `VaultRegistry.VaultStatus.Retired` referencing
      this ADR and recording the explicit no-migration decision.
- [ ] `forge build` exits 0 with no new compiler warnings (verified in CI).
