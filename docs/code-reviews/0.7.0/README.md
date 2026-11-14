# Single-vault rebalancer: expanded adversarial review

Status: third pass, 14 November 2026. Reviewed source revision: `17677089268affa3a5efa3d9192bb4f63b6bb605`, against `42a4d2e1848ca7c412c4e2197b9d693c1ee371b6`. The report revision is separate from the reviewed source.

This pass records **six P2 findings**: three deployment verification gaps, one asset-admission liveness gap, and two simulation evidence defects. They concern the experimental system and rehearsal guarantees; no permissionless theft or production compromise was established.

1. [Product goals and scope](00-product-goals-and-scope.md)
2. [Findings index and changes to the first pass](01-findings-index.md)
3. [Fund configuration verification](02-deploy4-verification.md)
4. [Runtime attack traces and admission finding](03-prototype-runtime.md)
5. [Method and coverage](04-method-and-coverage.md)
6. [Deployment and upgrade authority](05-deployment-and-upgrades.md)
7. [Receipt and experiment evidence](06-receipts-and-experiment-evidence.md)
8. [Executable reproduction notes](07-reproduction-notes.md)
9. [Deployment findings challenged against the full path](08-deployment-challenge.md)
10. [Receipt and economic-evidence challenge](09-receipt-and-economic-challenge.md)
11. [Recovery and queued-share accounting](10-recovery-and-accounting.md)

The earlier G4-failed statement was incorrect for the current design: step 3e G4 passes; the failed step 3 row is historical. The published G5 not-pass and G8 failure remain. This review did not reproduce the full economic simulations.

The third pass narrowed DEP-02 and DEP-03 after finding existing deployment/upgrade guards, expanded DEP-03 to Safe authority configuration readback, and added SIM-02: missing cost evidence can convert a complete-manifest G4 FAIL into PASS. The full scorer reproduction and recursive-library counterexample were executed; published simulation outcomes were not rerun.
