# Method, coverage and limits

Source diff: `42a4d2e1848ca7c412c4e2197b9d693c1ee371b6..17677089268affa3a5efa3d9192bb4f63b6bb605`. Product goals, scope, architecture guardrails, ADR-0010 and the experiment plans were read before grading implementation. The second pass challenged the original finding and its caveat dispositions, expanded deployment/authority and experiment-evidence review, and inspected recovery/claim accounting.

## Executed evidence

| Check | Result | What it establishes |
| --- | --- | --- |
| Receipt checker suite | 39 pass, 0 fail; 167 assertions | Existing checker and fixture-vector tests execute. |
| Fund-system, fund evidence, implementation deployment suites | 37 pass, 0 fail; 436 assertions | Three existing deployment test files execute. |
| Actual fund verifier with synthetic ChainReader | Baseline, wrong fee recipient, changed library code and extra proposer all 114 checks green; wrong TVL fails | Specific postcondition omissions; no live-chain exploit claim. |
| Actual scorer provenance prefix with 16 synthetic timed files | Mixed nested parameter accepted; partial=false; exit0 | Cross-file parameter guard can miss a material mismatch. |
| Fee-band integer calculation | Required1010102 > allowed1010000 | The quantified RUN-01 purchase bound is impossible at the stated aligned price, before impact. |

The lead reviewer reran all rows above after recovering the specialists' scripts. Repeated runs are not additional unique test coverage: there are **76 passing existing tests** across four files. Reproduction programs and limitations are in chapter 07. Tests initially lacking dependencies were rerun after frozen package dependencies were installed; the initial load failures are not counted as passes.

## Static coverage

Runtime traces cover settlement bounds/cursors, per-request limits, independent sides, callback controls, claim ownership, receipt/vector admission, queued-share exclusion snapshots, lending-position units, restore/drain reservation, unreadable-lending exits and anchored epoch transitions. Deployment traces cover fund configuration, masked implementation checks, the legacy recursive-library comparison, timelock/Safe role assertions and nearby stage evidence. Experiment traces cover receipt asset checks and scorer provenance.

## Limits

No Solidity test or fork run was executed in this review worktree; its Foundry submodule dependencies were absent. No live RPC reads, deployment, EVM upgrade, full simulation, fuzz campaign, gas measurement or formal verification was performed. Synthetic verifier responses and artifacts isolate the verifier's logic; they are not a proof that a malicious system can be deployed by an outsider. The second-pass SIM-01 reproduction executes only the provenance prefix. The third-pass SIM-02 reproduction executes the complete scorer and gate arithmetic on synthetic complete-manifest inputs; it does not run the Solidity simulation.

The complete prototype test/harness suite and recorded state fixtures, frozen baseline implementation, every generic publication stage, full Twin feed/counts semantics, production contracts and off-chain client journeys were not exhaustively reviewed. Current documented G4 step 3e Pass, G5 not pass, G8 Fail and G9 Pass were not reproduced. The review does not claim production readiness or absence of other runtime defects.

Only Markdown report files changed. No product implementation was modified.

## Third-pass evidence and corrections

On 14 November the lead reviewer reran the full scorer probe in chapter 09: both complete high-cost controls yielded G4 FAIL at 1,000 bps; deleting arrival cost yielded PASS with 35 scored plans, and deleting reference cost yielded PASS with 36. Every run exited 0 and reported partial=false. The real recursive-library helper probe in chapter 08 accepted matching leaf code and rejected changed leaf code. These are focused behavioral probes, not additional existing test-suite counts. The earlier 76 passing tests were not rerun in this pass.

Coverage now includes the supported implementation candidate/storage guards, initial handover versus subsequent authority drift, receipt payload/vector tooling boundaries, disclosed economic-model assumptions, and recovery/queued-share attribution traces (chapter 10). No new Solidity/fork execution occurred.
