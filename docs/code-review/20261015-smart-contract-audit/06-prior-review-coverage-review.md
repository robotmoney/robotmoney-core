# Prior-review coverage — audit record

## Recheck basis

The [October 12 contract review](../20261012-security-review.md), [October 14 V4 economics assessment](../20261014-code-review-internal-claude-v4-sampling-economics.md), and [October 15 branch security review](../20261015-review-security-claude.md) are the immediate leads. The October 15 report reviewed an uncommitted working tree based on `9d9bb854`, while this audit targets the later QA contract tree at `f828eabb`; a previous `fixed` verdict is not inherited. The June 12 and June 18 reports supply older regression cases, including findings that earlier remediation reports had marked fixed without a landed or complete fix.

## Highest-priority historical checks

| Prior finding | Current review chapter | Initial source observation | Evidence still needed |
| --- | --- | --- | --- |
| October 12 findings 1 and 5; October 15 SEC-M-009/010/012: exclusion, force removal, and recovery ownership | [Vaults and adapters](02-vaults-and-adapters-review.md), [gateway and governance](04-gateway-and-governance-review.md) | Current source has exclusion records, snapshot claims, and an emergency removal path that can tolerate a reverting `totalAssets` read. | Adverse venue behavior, prior-holder exits, partial recovery, live role holders. |
| October 12 finding 2; June SR-M15: duplicate adapter or basket-asset registration | [Vaults and adapters](02-vaults-and-adapters-review.md), [baskets and router](03-baskets-and-router-review.md) | Current source guards adapter eligibility and active basket-token duplicates; adverse-state behavior remains untested. | Reproduction at target commit for both families. |
| October 12 findings 3, 4, 7, 8: committee identity, voting retirement, agent consent, unique weights | [Gateway and governance](04-gateway-and-governance-review.md) | Source recheck finds caller binding, receipt application, and vector uniqueness; it also identifies a narrower stale-consent candidate. | On-chain governance execution and end-to-end off-chain aggregation. |
| October 12 V4 sampling; October 14 economic assessment; June SR-H6/ORA-7 | [Baskets and router](03-baskets-and-router-review.md) | Current source clamps recorder ticks and adds a sell anchor; earlier economic results used an older deployment. | Production-equivalent pool, keeper cadence, and sustained manipulation reproduction. |
| October 15 SEC-M-011 and L-013/L-015: paused or capped lending venue | [Vaults and adapters](02-vaults-and-adapters-review.md) | Supply refusal and exposure handling are being rechecked in the current adapters and vault route. | Venue-failure mocks and deployed caps. |
| October 15 L-010/L-011: failed or skipped router leg with floor | [Baskets and router](03-baskets-and-router-review.md) | Preview and execution share leg availability logic; a skipped leg with a caller floor reverts. | Targeted transaction sequence through the current router. |
| June SR-H1/H3/H4, SR-M1/M3/M6/M9/M10 and June 18 L-3/L-8/L-10 | Topical chapter reports | These are specific regression cases in the scope of gateway, vault, router, and governance reviews. | Verify each against the current code and record a behavioral test or counterexample. |

## Coverage still open

The complete checklist in [chapter 06](06-prior-review-coverage.md) is not yet a disposition table. The earlier May through July review snapshots and the audit-ledger groups named there have not been exhaustively revalidated at this target. Before closeout, assign every contract-relevant historical ID to a current source location, a reproducible test or an explicit not-applicable reason, then reconcile `docs/audits.md`. No ledger disposition is changed by this initial pass.
