# Smart-contract audit — 2026-10-15

> Audit in progress; no sign-off. The [October 16 adversarial validation](08-adversarial-validation.md) supersedes the earlier evidence status: six new PoCs reproduce disputed behavior, the baseline suite has 14 failures and 30 skips, and quarantine recoverability is reopened. Production contracts have not been changed by that validation pass.

This audit workspace starts from `qa/test-merge-v1` at `f828eabb`. Pin the exact reviewed commit, deployment configuration, and dirty-tree state before drawing findings. Historical reports remain in the [code-review directory](../README.md); dispositions are in the [audit ledger](../../audits.md).

Read the chapters in order:

1. [Scope and method](01-scope-and-method.md)
2. [Vaults and adapters](02-vaults-and-adapters.md)
3. [Baskets and router](03-baskets-and-router.md)
4. [Gateway and governance](04-gateway-and-governance.md)
5. [Upgrades and deployment](05-upgrades-and-deployment.md)
6. [Prior-review coverage](06-prior-review-coverage.md)
7. [Evidence and closeout](07-evidence-and-closeout.md)
8. [Adversarial validation and corrected dispositions — October 16](08-adversarial-validation.md)

The initial chapter reviews are [scope and method](01-scope-and-method-review.md), [vaults and adapters](02-vaults-and-adapters-review.md), [baskets and router](03-baskets-and-router-review.md), [gateway and governance](04-gateway-and-governance-review.md), [upgrades and deployment](05-upgrades-and-deployment-review.md), [prior-review coverage](06-prior-review-coverage-review.md), and [evidence and closeout](07-evidence-and-closeout-review.md). They inspect source at `3c753ff5`. The October 16 validation targets `aa471faf`, whose contract tree matches QA `f828eabb`, and reproduces VA-01/02/03, GW-GOV-1, and the C-03-02 transfer behavior locally. The review is incomplete against the plan: complete entrypoint and role assessments, historical-finding dispositions, invariant-to-evidence mapping, static-alert triage, and substantial behavioral and deployment checks remain open. No finding has been validated against live deployment state.

## Disposition after design review and adversarial validation

The findings were compared against the canonical design docs and the `qa/test-merge-v1` source. The contract source still matches the audit target, so the changes below concern design interpretation and scope.

| Finding | Disposition | Canonical basis |
| --- | --- | --- |
| C-03-02, fixed quarantine fallback | Reopened custody/recoverability risk. Transfer to the fixed address is reproduced; governance control and recovery remain unproven. Documenting the fallback does not satisfy the PRD recovery promise. | [Adversarial validation](08-adversarial-validation.md), [PRD](../../prd.md) §12 |
| UD-01, rewritten storage snapshots | Review-process dependency. Out of the vulnerability count. A previous-release comparison is optional hardening. | [ADR-0014](../../adr/ADR-0014-governed-uups-upgrades-and-freeze.md) §5 |
| UD-02, missing upgrade and freeze operator rows | Planned tooling. Out of the vulnerability count. Readiness check before any operational upgrade. | [Upgradeability plan](../../technical/contract-upgradeability-plan.md) stage 4, [release runbook](../../operations/contract-release-runbooks.md) |
| VA-01, basket `mint` share count | Confirmed locally; Low interface mismatch. Requested shares and minted shares differ. No dilution demonstrated. | [Adversarial validation](08-adversarial-validation.md) |
| VA-02, rmUSDC max views | Confirmed locally; Low integration defect. Both advertised maxima can revert under venue illiquidity. | [Adversarial validation](08-adversarial-validation.md) |
| VA-03, redeem preview overstatement | Confirmed locally; Low in measured cases. All-dust redemption pays zero; a non-dust redemption also misses its preview by one USDC base unit. | [Adversarial validation](08-adversarial-validation.md), [ADR-0003](../../adr/ADR-0003-slippage-adjusted-basket-vault-preview.md) §1 |
| C-03-01, V3 oracle and execution pool | Retained. Conditional on authorized misconfiguration. | [ORA-3](../../technical/smart-contract-invariants.md) |
| GW-GOV-1, agent consent lifetime | Confirmed locally; Low stale-consent/specification defect under the stated prerequisites. | [Adversarial validation](08-adversarial-validation.md) |
| UD-03, ERC-7201 slot constants | Retained as an unverified checker coverage gap. | ADR-0014 §5 |

The `_restore` short-withdrawal dismissal depends on admitted adapter implementations preserving the assumed withdrawal behavior; this pass has not verified deployed allowlists. The zero-floor emergency override is documented governance authority. `claimAll` gas growth has an individual `claim` alternative. Keep these as explicit assumptions and operational limits. Separately, the historical FS-RTR-2 unconsumed caller allowance needs direct-router revalidation; gateway self-custody alone does not close that public surface.
