# Evidence and closeout — audit record

## Evidence available at this pass

The chapter reviews are source inspections pinned to `3c753ff5b72f828f082673d4c5983418a418c47e`. No new Foundry test completed for this audit pass: a targeted gateway regression began compiling and was stopped before results. No fork reproduction, static-analysis run, deployed-bytecode comparison, or live-chain read has been executed. Findings that depend on venue behavior, deployment configuration, or measurable economic impact remain candidates until reproduced.

The earlier October 15 review says its 68 proposed fixes were compile-checked but had not been exercised by tests, and that its third round ended with one high and four medium findings before their fixes received a fourth review ([`docs/code-review/20261015-review-security-claude.md:15`](../20261015-review-security-claude.md)). The QA plan still lists Phase Q as not started and says the security fixes had no test run at its last recorded status ([`docs/development/qa-plan-v1.md:162`](../../development/qa-plan-v1.md)). This is a historical evidence gap; current CI and local test results still need to be collected for the exact audit target.

The formal-invariant dispatch must be interpreted carefully. `FvInvariantsTest._assertHolds` checks an ID's registry status and remediation issue, not the invariant's behavior ([`contracts/test/fv/FvInvariants.t.sol:156`](../../../contracts/test/fv/FvInvariants.t.sol)); some named `expectedFail` functions call only `_assertHolds` (for example `SUP-5` at line 210). Other dedicated harnesses may exercise the behavior. Each invariant needs a link to its actual behavioral or static proof, and any `vm.skip` or placeholder assertion must be recorded as unverified.

## Closeout status

This is an initial source pass, not an audit sign-off. Before closeout, reconcile duplicate findings across chapter reports, reproduce material candidates, complete the historical finding and invariant matrices, run the required tests and static checks, compare deployed code/configuration, and re-review any fixes made after this pass. The final verdict must separate source correctness, deployment truth, and operational assumptions.
