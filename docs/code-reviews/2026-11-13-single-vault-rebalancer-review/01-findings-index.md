# Findings index

Reviewed revision: `17677089268affa3a5efa3d9192bb4f63b6bb605`.

P2 means the issue can admit an incorrect deployment state or leave a material
configuration error undetected, but the reviewed rehearsal is not a production
deployment.

| ID | Priority | Area | Finding | Evidence |
| --- | --- | --- | --- | --- |
| DEP-01 | P2 | Deploy 4 verification | Fund verification checks the asset count and only three fields from `config()`, not the configured fee recipient or any per-asset configuration. | [Deploy 4 verification](02-deploy4-verification.md) |

No actionable prototype runtime defect was confirmed in this pass. See
[prototype runtime review](03-prototype-runtime.md) and
[method, coverage and limits](04-method-and-coverage.md).
