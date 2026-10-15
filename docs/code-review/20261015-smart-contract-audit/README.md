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
