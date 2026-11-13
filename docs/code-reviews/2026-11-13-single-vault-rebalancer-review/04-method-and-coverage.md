# Method, coverage and limits

This was a first-pass adversarial static review. The target was the diff from
`42a4d2e1848ca7c412c4e2197b9d693c1ee371b6` to
`17677089268affa3a5efa3d9192bb4f63b6bb605`. The reviewer read the root PRD,
architecture security guardrails, ADR-0010, the one-vault proposal, the timed
flows plan and draft PRD amendments before grading changed code. The detailed
product goals and scope are in [chapter 00](00-product-goals-and-scope.md).

The review followed the Deploy 4 fund verification from sheet parsing through
`buildFundVerifySheet` into `verify/fund.ts`, and searched the publish-contracts
tree for alternative readback of fee recipient and asset configuration. It
also traced the prototype runtime areas listed in
[chapter 03](03-prototype-runtime.md). Finding evidence was checked against
current source line numbers.

No tests, local deployment, RPC read, fork run, fuzz run, formal verification,
gas measurement or external audit was performed. This review therefore does
not claim that the documented gate results were reproduced, that all code
paths are defect-free, or that the experiment is production-ready. The proposal
itself reports G4 and G8 as failed, G5 as not passed, G6 as not run, and G9 as
passed; those disclosed outcomes remain relevant to the product decision but
are outside this static review's confirmed findings.

## Changed areas not deeply reviewed

- The added prototype test files, adversarial fixtures, mock contracts, harness
  code, simulations and large recorded state fixtures under
  `contracts/test/prototype/`. They were not independently audited for test
  completeness or simulation-model accuracy, and no test was run.
- The frozen comparator implementation and tests under
  `contracts/test/prototype/baseline/`.
- The full Deploy 4 toolchain. The review traced the fund verifier's expected
  sheet, configuration readback and nearby deployment evidence; it was not a
  full security audit of every generic publish stage, script, manifest, or
  operational runbook step.
- The receipt schema, off-chain payload assembly and bucket-audit tooling, and
  full twin-feed/counts reporting semantics. These were read only where needed
  to understand the in-scope verifier and its intended configuration.
- Existing production contracts and client repositories remain outside scope,
  consistent with chapter 00.
