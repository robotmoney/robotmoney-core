# Smart-contract audit — 2026-10-15

> Initial source audit in progress. The plan chapters define coverage; the companion review files record current source observations and open verification. This is not an audit sign-off.

This audit workspace starts from `qa/test-merge-v1` at `f828eabb`. Pin the exact reviewed commit, deployment configuration, and dirty-tree state before drawing findings. Historical reports remain in the [code-review directory](../README.md); dispositions are in the [audit ledger](../../audits.md).

Read the chapters in order:

1. [Scope and method](01-scope-and-method.md)
2. [Vaults and adapters](02-vaults-and-adapters.md)
3. [Baskets and router](03-baskets-and-router.md)
4. [Gateway and governance](04-gateway-and-governance.md)
5. [Upgrades and deployment](05-upgrades-and-deployment.md)
6. [Prior-review coverage](06-prior-review-coverage.md)
7. [Evidence and closeout](07-evidence-and-closeout.md)

The initial chapter reviews are [scope and method](01-scope-and-method-review.md), [vaults and adapters](02-vaults-and-adapters-review.md), [baskets and router](03-baskets-and-router-review.md), [gateway and governance](04-gateway-and-governance-review.md), [upgrades and deployment](05-upgrades-and-deployment-review.md), [prior-review coverage](06-prior-review-coverage-review.md), and [evidence and closeout](07-evidence-and-closeout-review.md). They inspect source at `3c753ff5` and identify candidate findings requiring reproduction and deployment checks. The review is incomplete against the plan: entrypoint and role inventories, a complete prior-finding matrix, invariant-to-evidence mapping, and substantial behavioral and deployment checks remain open. Additional candidates recorded during report review are in chapters 02, 03, and 05; none has been validated against live deployment state.

## Disposition after design review

The findings were compared against the canonical design docs and the `qa/test-merge-v1` source. The contract source still matches the audit target, so the changes below concern design interpretation and scope.

| Finding | Disposition | Canonical basis |
| --- | --- | --- |
| C-03-02, fixed quarantine fallback | Documented behavior. Out of the vulnerability count. Verify that governance controls the destination and can recover funds. | [Security model](../../technical/security-model.md) §3 |
| UD-01, rewritten storage snapshots | Review-process dependency. Out of the vulnerability count. A previous-release comparison is optional hardening. | [ADR-0014](../../adr/ADR-0014-governed-uups-upgrades-and-freeze.md) §5 |
| UD-02, missing upgrade and freeze operator rows | Planned tooling. Out of the vulnerability count. Readiness check before any operational upgrade. | [Upgradeability plan](../../technical/contract-upgradeability-plan.md) stage 4, [release runbook](../../operations/contract-release-runbooks.md) |
| VA-01, basket `mint` share count | Narrowed to an interface mismatch. Downgraded from Medium to Low. | [PRD](../../prd.md) NAV disclosure |
| VA-02, rmUSDC max views | Illiquidity is a known gap. The max-view overstatement stays open. | [Asset valuation](../../technical/asset-valuation.md) |
| VA-03, dust-skipped redeem | Narrowed to a positive preview followed by a smaller payout. Needs reproduction. | [ADR-0003](../../adr/ADR-0003-slippage-adjusted-basket-vault-preview.md) §1 |
| C-03-01, V3 oracle and execution pool | Retained. Conditional on authorized misconfiguration. | [ORA-3](../../technical/smart-contract-invariants.md) |
| GW-GOV-1, agent consent lifetime | Retained as a specification inconsistency. | [Upgradeability plan](../../technical/contract-upgradeability-plan.md) |
| UD-03, ERC-7201 slot constants | Retained as an unverified checker coverage gap. | ADR-0014 §5 |

The `_restore` short-withdrawal concern has no reachable failure today because all three supported adapters revert on a short withdrawal. The zero-floor emergency override is documented governance authority. `claimAll` gas growth has an individual `claim` alternative. These three items belong in assumptions and operational limits, not the vulnerability count.
