<!-- Scout output for issue #699. Do not remove — referenced by open-questions.md. -->

# Architecture Decision Owners and Status

Prepared by dev-scout #699, 2026-06-07.

This document maps each unresolved architecture decision to its GitHub issue, its canonical source in `open-questions.md`, and the current blocking status. Update this file when a decision is reached.

---

## Decision map

| Decision | open-questions ref | GitHub issue | ADR target | Blocks | Status |
|---|---|---|---|---|---|
| AgentTokenVault trading authority & strategy | §1.B (§3.2) | #684 | ADR-0007 or ADR-0008 | Future agent-component work | **Awaiting product-owner decision** |
| Depositor migration on vault retirement | §1.C (§3.5) | #682 | ADR-0007 or ADR-0008 | Production use of `VaultRegistry.Retired` | **Awaiting product-owner decision** |
| Basket-vault drawdown redemption policy | §1.C (§3.7) | #687 | ADR-0007 | `VaultRegistry.setRouterEligible` for basket vaults; impl-plan line 306 | **Awaiting product-owner decision — HIGHEST PRIORITY** |

---

## Decision briefs posted

Decision briefs with binary/ternary options and full context have been posted as comments on each linked issue:

- #684: https://github.com/lucky-tensor/robotmoney-monorepo/issues/684#issuecomment-4643897628
- #682: https://github.com/lucky-tensor/robotmoney-monorepo/issues/682#issuecomment-4643900056
- #687: https://github.com/lucky-tensor/robotmoney-monorepo/issues/687#issuecomment-4643903193

Each brief includes:
- The exact open question from `open-questions.md`
- Binary (or ternary for #687) options with implementation consequences
- Blocking impact statement
- Groundwork already completed by the scout

---

## Priority order

1. **#687 — Basket-vault drawdown redemption policy** (highest urgency): gates router-eligibility for both basket vaults and the full multi-vault routing flow. Option C (NAV haircut via existing `previewRedeem`) requires zero contract changes and can be resolved as a doc-only ADR immediately.

2. **#682 — Depositor migration on vault retirement**: gates production use of `VaultRegistry.Retired`. Option A (no migration) also resolves as a doc-only ADR + NatSpec comment.

3. **#684 — AgentTokenVault trading authority**: no current blocker for active work; MVP is admin-curated equal-weight with no trading agent. Option A (defer indefinitely) is the path of least resistance and closes the question permanently.

---

## Next ADR numbers

`docs/adr/` currently contains ADR-0001 through ADR-0006. Next available: ADR-0007, ADR-0008, ADR-0009.

Recommended assignment (pending decisions):
- ADR-0007: Basket-vault drawdown redemption policy (#687)
- ADR-0008: Depositor migration on vault retirement (#682)
- ADR-0009: AgentTokenVault trading authority (#684)
