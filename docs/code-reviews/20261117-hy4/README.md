# Security review — release-0.9.0 system smart contracts (2026-11-17, hy4)

**Branch under review:** `release-0.9.0`
**Work branch / pinned commit:** `review/security-release-0.9.0-20261117` @ `d4a43e6d21efed208816698d2b32f0decea45451`
**Reviewer:** hy4
**Date:** 2026-11-17

---

## Headline verdict

No contract security finding survived adversarial refutation in any of the five lanes at the pinned commit. Merge-blocking findings: **none**. A follow-up deep-dive promoted one **medium, non-blocking** test-coverage finding: the fund timelock's Safe-only executor requirement has no executed-in-CI assertion.

| Severity | Count | Key areas |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 1 | Fund timelock Safe-only executor has no executed-in-CI assertion |
| Low | 0 | — |

The prior 2026-10-15 security review's contract findings are fixed at this commit and are not re-reported. Acceptance-level items remain `accepted-with-rationale` in the canonical ledger and are carried forward, not re-asserted.

## Contents

| # | File | Description |
|---:| --- | --- |
| 00 | [`00-security-review.md`](./00-security-review.md) | Canonical review summary: scope, pinned commit, headline verdict, severity table, methodology and findings index. |
| 01 | [`01-lane-gateway-governance.md`](./01-lane-gateway-governance.md) | Lane 1 — gateway, roles, governance and upgrade authority. |
| 02 | [`02-lane-vaults.md`](./02-lane-vaults.md) | Lane 2 — vault family, custody, share accounting, ERC-4626 and redemption. |
| 03 | [`03-lane-router-adapters.md`](./03-lane-router-adapters.md) | Lane 3 — portfolio router, basket swaps, adapters and oracles. |
| 04 | [`04-lane-receipt-registry.md`](./04-lane-receipt-registry.md) | Lane 4 — consensus receipt, vault registry, feature flags and exclusion ledger. |
| 05 | [`05-lane-deploy-composition.md`](./05-lane-deploy-composition.md) | Lane 5 — deploy/upgrade scripts, prior findings, test evidence and n-order composition. |
| 06 | [`06-deep-dive-liveness-registry.md`](./06-deep-dive-liveness-registry.md) | Deep-dive A — receipt liveness and registry code-check consistency. |
| 07 | [`07-deep-dive-test-evidence.md`](./07-deep-dive-test-evidence.md) | Deep-dive B — test-evidence gaps, including the fund timelock finding. |
| 08 | [`08-deep-dive-pin-adapter.md`](./08-deep-dive-pin-adapter.md) | Deep-dive C — local-only commits, adapter metadata bypass and RB-1022. |
| 09 | [`09-deep-dive-live-deployment.md`](./09-deep-dive-live-deployment.md) | Deep-dive D — live deployment state and RS-1019-14. |
| 10 | [`10-deep-dive-natspec-docs.md`](./10-deep-dive-natspec-docs.md) | Deep-dive E — stale NatSpec and operator-facing documentation consistency. |

## Canonical artifact

The canonical, JSON-backed review artifact is `docs/code-review/20261117-review-security-opencode.{md,json}`. This folder preserves the full markdown evidence set (five lane reports, five deep-dives and the summary) as a readable companion; where the two differ, the canonical artifact governs.
