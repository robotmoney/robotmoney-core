# Findings index

Source: `17677089268affa3a5efa3d9192bb4f63b6bb605`. All findings are P2: concrete verification, configuration or evidence defects in the experimental/rehearsal path. Severity does not imply exploitation of production.

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| DEP-01 | P2 | Fund configuration readback omits fee recipient and per-asset configuration. | [Chapter 02](02-deploy4-verification.md) |
| DEP-02 | P2 | Masked implementation comparison leaves linked library code unattested. | [Chapter 05](05-deployment-and-upgrades.md#dep-02--p2-linked-library-code-is-not-attested) |
| DEP-03 | P2 | Safe role presence is accepted as proof of exclusive timelock authority. | [Chapter 05](05-deployment-and-upgrades.md#dep-03--p2-timelock-role-exclusivity-is-not-checked) |
| RUN-01 | P2 | Asset admission can leave the queue's swap band at or below a newly admitted pool's fee. | [Chapter 03](03-prototype-runtime.md#run-01--p2-asset-admission-can-invalidate-the-queues-swap-band) |
| SIM-02 | P2 | Missing required cost evidence can turn G4 FAIL into PASS while the run remains marked complete. | [Chapter 09](09-receipt-and-economic-challenge.md) |
| SIM-01 | P2 | Simulation scorer ignores most nested flow parameters when checking consistency between files. | [Chapter 06](06-receipts-and-experiment-evidence.md) |

## Changes to the first pass

- Retained DEP-01 after challenging the full verifier; narrowed its consequence to false deployment assurance, conditional on wrong state. Deploy-time assertions are useful controls, not evidence that later readback covers every field.
- Added DEP-02 and DEP-03 after executing the real verifier against controlled ChainReader responses, with a wrong-TVL negative control.
- Promoted the previously disclosed leg-band caveat to RUN-01. Recoverability through governance does not erase a reachable configuration/liveness defect. No deployed-default failure or permissionless attack is claimed.
- Added SIM-01 with an executed provenance-prefix reproduction. This invalidates an assurance of homogeneous inputs, not the published scores themselves.
- Removed the broad statement that no runtime defect was confirmed. The earlier protected-path traces remain, with their static limits.
- Corrected G4 to current step 3e Pass; historical step 3 Fail must not be substituted for it.

## Third-pass dispositions

- DEP-01 retained, limited to independent readback; normal deployment asserts asset indices.
- DEP-02 retained for the fund verifier; removed any implication that the supported implementation-deployment verb lacks recursive library checks. Its existing check was executed with matching and altered leaf code.
- DEP-03 retained for subsequent authority drift; fresh/reused handover already requires a sole Safe proposer. Expanded the same readback issue to Safe modules/guard/fallback configuration, with authorized-change preconditions.
- RUN-01 retained as a governed deposit-liveness configuration defect with static/arithmetic evidence, not a demonstrated default failure.
- SIM-01 retained; SIM-02 added with full-program controls and one-field deletion variants.
- Recovery and queued-share ownership traced more deeply; no additional supported-path defect confirmed. See chapter 10 for a short-fill candidate bounded by adapter guards.
