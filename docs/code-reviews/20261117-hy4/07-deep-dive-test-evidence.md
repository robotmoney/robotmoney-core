# Deep-dive B — test-evidence gaps (follow-up security review, release-0.9.0)

Pinned scope: repository `git@github.com:robotmoney/robotmoney-core.git`, branch under review
`release-0.9.0`, commit `d4a43e6d21efed208816698d2b32f0decea45451`, reviewed_at 2026-11-17.
Worktree: `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/adhoc-20261117-145601`
(verified `git rev-parse HEAD` = pin). Principal checkout left read-only. No production code,
canonical docs, prior review artifacts, `scripts/check-audit-ledger.sh`, or sibling scratch files
were modified. Only this output file was written.

Reference contracts read in full: `/drive2/home/lucas/.agents/skills/_shared/test-coverage-policy.md`
(four invariants) and `/drive2/home/lucas/.agents/skills/_shared/review-contract.md` (severity rubric,
`TEST_*` handling). False-green catalogue: `docs/development/false-green-shapes.md`.

---

## B1 — read the two test bodies in full

VERDICT: closed with evidence

EVIDENCE:

- `contracts/test/RobotMoneyGateway.t.sol` — all 2025 lines read: three test contracts
  (`RobotMoneyGatewayTest` :113, `GatewayRollingDepositWindowTest` :1157,
  `GatewayCommitRevealTest` :1607), 63 `test_*`/`testFuzz_*` functions. Exact grep output:
  `grep -nE 'function test_|vm\.skip|vm\.assume|skip\(|assume\(' contracts/test/RobotMoneyGateway.t.sol`
  returned **only** `function test_*` lines — zero `vm.skip`, `vm.assume`, `skip(`, `assume(` matches.
  The only non-pure input bounding is `bound(...)` inside `testFuzz_deposit_rollingWindow_neverExceedsCapInAnyInterval`
  (:1344-1351), which shrinks fuzz inputs, not a subject skip.
- `contracts/test/RouterGovernance.t.sol` — all 282 lines read: 9 `test_*` functions (:139-281), all on a
  real `RouterGovernance` and real `PortfolioRouter` deployed via `CoreProxies` (:96-121). No skip/assume.
  The header itself states the governed path is proved elsewhere (:2-3, :77-80), so the mocks here
  (`MockUsdc` :21, `MockGovVault` :34) are stub *counterparties*; the subject is not mocked.
- `contracts/test/helpers/CoreProxies.sol:236-245` — `robotMoneyGateway(...)` deploys
  `type(RobotMoneyGateway).creationCode` and wraps it in a real `proxy(impl, initialize(...))`. Same
  pattern for `consensusRecommendationReceipt` (:247-258) and the other `CoreProxies` builders. The
  subjects are real ERC-1967 proxies + real implementations, not mocks.
- Gateway test adversarial mocks are deliberately the *thing varied to test the subject's own guard*:
  `FeeOnTransferUSDC` :18-33 (tests `FeeOnTransferDetected`, asserted :897-922),
  `ShareLeakVault` :35-49 (asserted :1044-1069), `UnderPullVault` :51-64 (asserted :1071-1096),
  `ReentrantVault` :66-111 (asserted :1102-1143). Each `vm.expectRevert` is followed by real assertions
  on balances/state, e.g. :634-649, :1041, :1411-1416.
- `contracts/test/RouterGovernanceApplyReceipt.t.sol` (the companion named in the file header and in the
  prior synthesized report line 77/86) executes the governed path with real Safe/timelock
  (`setUp` :53-74, `test_applyReceipt_viaSafeAndTimelock` :137, digest/record/release/order cases
  :200, :213, :224, :351, :379, :398). It has exactly one `vm.assume` (:246,
  `caller != address(timelock)`), a standard fuzz bound in `test_applyReceipt_revertsForNonWeightSetter`,
  not a skip of the subject; no `vm.skip`.
- Canonical §8 invariants (`docs/architecture.md:1715-1785`) were enumerated. The gateway/governance
  test files cover the ones in their scope (role separation :340-356/:973-995, last-admin floor
  :206-237/:267-280, commit/reveal consent :302-338/:1678-1959, rolling-window caps :793-843/:1247-1602,
  post-call custody :1024-1096, reentrancy :1102-1143, receipt-stranger gate :174-185).
  §8 items INV-1/2/3, caps-before-deposit, adapter/venue and upgradeTimelock authority are canonically
  owned by other test files (vault/adapter/upgrade suites), not by these two.

ANALYSIS: The decisive question ("would this test still execute and assert in a clean CI runner with no
external dependency?") is answered yes for every security-relevant assertion in both bodies. There is no
`#[ignore]`-equivalent, no `Option`-style early return, no `existsSync` guard, no doc-grep-only claim,
and no test that mocks out the contract it claims to test. The prior report's limitation that these two
bodies were "assessed by executed-test name and CI wiring rather than line-by-line" is now closed by
this full read. One cosmetic note (not a finding): `test_deposit_revertsOnPostCallUsdcCustodyInvariant`
(:1071) expects the same `ShareCustodyInvariantViolated` selector as the share-leak case (:1060); the
under-pull path still executes and asserts a revert, so the guard is exercised, only the error-name
comment is imprecise. No §8 or lane-report invariant was found to be asserted *only* by a skipping,
mocking-away, or non-executing test.

SEVERITY IF PROMOTED: N/A — no finding promoted.

RECOMMENDATION: Close the "two test bodies not read line-by-line" limitation. Optionally rename the
expected-error comment at `RobotMoneyGateway.t.sol:1071-1073` for accuracy (docs-only, `info`).

---

## B2 — audit the evidence wrapper internals

VERDICT: closed with evidence

EVIDENCE:

- `.github/scripts/forge_test_require_executed.sh` — all 54 lines read:
  - :19-22 missing args → `exit 2`.
  - :24 `MIN_EXECUTED="${FORGE_TEST_MIN_EXECUTED:-1}"`; :25 rejects empty/non-digit → `exit 2`;
    :26 `[ "$MIN_EXECUTED" -ge 1 ] || MIN_EXECUTED=1`. **The floor is env-derived but clamped upward
    to >= 1** — it cannot be starved to 0 by an env override; a non-numeric value is a loud error.
  - :31-34 `set +e; forge test "$@" 2>&1 | tee "$LOG"; FORGE_STATUS="${PIPESTATUS[0]}"; set -e` —
    `PIPESTATUS[0]` is forge's own status, read immediately, so a forge failure is **not** swallowed by
    the `tee` pipeline or by `set -e`.
  - :36-39 non-zero forge status → `exit "$FORGE_STATUS"`.
  - :41-45 sums only `Suite result: <alpha>. <N> passed` lines via sed+awk; a zero-match run emits
    no such line → `PASSED_TOTAL=0`.
  - :49-54 `PASSED_TOTAL < MIN_EXECUTED` → `exit 1`. With the floor >= 1, a zero-test run cannot pass.
- `.github/scripts/tests/test_forge_test_require_executed.sh` — all 59 lines read. Plants six stub cases
  plus one real-forge case: zero-match (:41-42), passing (:43-44), forge failure (:45-46), floor 3 vs 2
  passed (:48), floor met (:49), no args (:50), and `planted empty match-path on real forge` (:52-56).
- Exact command output (executed in the worktree):
  ```
  $ bash .github/scripts/tests/test_forge_test_require_executed.sh 2>&1; echo "EXIT=$?"
  ok   zero-match run is red
  ok   passing run is green
  ok   forge failure is red
  ok   floor above passed count is red
  ok   floor met is green
  ok   no args is red
  ok   planted empty match-path on real forge is red
  test_forge_test_require_executed: all cases passed
  EXIT=0
  ```
  (forge and foundry.toml are present, so the real-forge planted case actually ran.)

ANALYSIS: All four hypothesized false-green routes are closed. A zero-test run and an empty match both
yield `PASSED_TOTAL=0 < floor>=1` → red (self-test cases 1 and 7). A swallowed command failure is
impossible because `PIPESTATUS[0]` captures forge independent of `tee` (case 3). A starved floor cannot
produce exit 0: the value is env-derived but validated as a non-negative integer and clamped to >= 1
(cases 4/5 plus :25-26). There are self-tests that fail on a planted false green — the zero-match case
and the real-forge planted empty `--match-path` — and they pass (i.e. they correctly go red). This closes
the first pass's partial `starved-guard-input` evaluation for this wrapper. Note the wrapper's counts are
"passed tests," so an all-skipped forge suite prints `0 passed` and is red — the `optional-fixture-early-
return` shape cannot hide here (forge has no silent-skip return that still prints a passing count).

SEVERITY IF PROMOTED: N/A — no finding promoted.

RECOMMENDATION: None. Record `starved-guard-input` as evaluated-and-ruled-out for this wrapper.

---

## B3 — DeployFundTimelock.run() CI execution

VERDICT: TEST_* finding (genuine CI test-coverage gap; advisory, does not block)

EVIDENCE:

- The live on-chain assertion exists but is script-side: `contracts/script/DeployFundTimelock.s.sol:141-203`
  `_check(d)`, with the Safe-only-executor requires at :146-149
  (`hasRole(EXECUTOR_ROLE, d.safe)`, `!hasRole(EXECUTOR_ROLE, address(0))`) and :150-153
  (`!hasRole(EXECUTOR_ROLE, msg.sender)`). It runs only when `DeployFundTimelock.run()` executes against
  a chain whose prior fund stages are present.
- **No CI workflow executes it.** Exhaustive search of `.github/workflows/**`, `docs/runbooks/**`,
  `scripts/**`, `contracts/test/**`, `publish-contracts/**` for `DeployFundTimelock|FundTimelock|fund-timelock`:
  - `.github/workflows/suite-28-core-stages.yml:142-159` — the only Twin rehearsal that publishes;
    `twin-publish` is invoked with `vaults-only: "true"` and `gateway: "true"`, and the required markers
    are `vaultsOnly,receiptPath,gatewayRefusals,gatewayRun` (:159). No fund-system stage, no
    `fund-timelock` marker. `publish-contracts/src/ci/twin-publish.ts:109-115,204-253` confirms the run
    covers the vaults system then the gateway system only.
  - `.github/workflows/suite-01-02-forge-tests.yml:736-746` — `forge coverage` **skips** the script:
    `--skip ... contracts/script/DeployFundTimelock.s.sol ...`. Coverage skip, not an execution.
  - `.github/workflows/suite-13-doc-checks.yml:506-514` — validates the contract QA runbook *structurally*
    (`validate-contract-qa.ts` + bun unit tests). It never executes a runbook step against a chain.
  - Exact search output for workflows executing the runbook runner / fund publish:
    `grep -rniE 'scripts/runbook/run|runbook/run\.ts|--system fund|contract-qa|qa-runbook|FundTimelock' .github/workflows`
    → only the suite-13 validation lines and the suite-01-02 skip line; **no execution job**.
- The three "other assertions" do **not** cover the require. `contracts/test/UpgradeAuthorityPrediction.t.sol:28-72`
  writes only CREATE2 address/init-code prediction vectors (and asserts fund vs open executor moves the
  predicted address at :46-49); `scripts/ci/check-timelock-prediction-parity.ts:27-45` recomputes those
  in TypeScript; `publish-contracts/src/verify/fund.ts:240` checks the *manifest string*
  `executorPolicy == "safe-only"`, which is a constant written by the script itself
  (`DeployFundTimelock.s.sol:232` ← `FundTimelockPolicy.sol:15 FUND_EXECUTOR_POLICY = "safe-only"`).
  None reads back on-chain `EXECUTOR_ROLE` holders. This is the `digest-blind-to-attribute` shape: the
  checks are orthogonal to the actual role-grant state the require guards.
- Executed where it matters, but outside PR CI: `docs/runbooks/contract-qa/releases/v0.7.0-onevault.yaml:548-562`
  step `P0.74-fund-dry-run` (`publish --dry-run --system fund ...`, `onlyFor: rehearsal`, `maxMinutes: 60`)
  and :622-636 step `P1.61-fund-publish` (real `--system fund` publish). `publish-contracts/src/runner.ts:717-729`
  confirms dry-run applies each simulated stage to a local anvil with `--broadcast --unlocked`, so the
  script's `run()` and its `require` do execute in that human-run rehearsal. QA steps P0.94/P3.83
  (`v0.9.0-onevault-upgrade.yaml:528-534`) read the live Safe-only executor back on-chain. The pinned
  `v0.9.0-onevault-upgrade.yaml` is an *upgrade* runbook: its only dry-run step (:303-309) has no
  `--system fund`, so it does not exercise the fund deploy script at this pin.
- Network/credentials: available (no secrets printed). `gh auth status` → logged in as `lucky-tensor`;
  `gh run list --limit 15` succeeded and listed recent `dev` runs (e.g. `nightly-twin-fork` 44106392397,
  `core-stack-selftest` 44063952463). No listed run is a fund-system publish, consistent with the static
  finding; the workflows above prove no such CI job exists in-tree.
- Attempted local run — precise blocker. The documented bounded command is P0.74's `publish --dry-run
  --system fund`. Prerequisites observed in the worktree: `anvil` and `cast` present
  (`/drive2/home/lucas/.foundry/bin/`), but `publish-contracts/node_modules: MISSING`; there is no
  frozen-counts file for the pin sha `d4a43e6d` (`deployments/frozen-counts/` holds only other shas);
  the fund sheet is a rehearsal artifact (`deployments/base-8453-rehearsal/deploy-4.env`), not a
  committed CI fixture; and the step is human/rehearsal-scoped with a 60-minute bound. A fresh
  `DeployFundTimelock.run()` cannot be exercised against a blank anvil without first deploying the whole
  fund system (its own requires at :104-118 demand real code at fund/rebalancer/governance/queue/receipt/
  safe), so a cheap one-shot forge-script call is not a faithful reproduction. Under "report the precise
  blocker rather than repeat the claim," the command was not run; the blocker is the missing deps/counts/
  committed fund sheet plus the human-only, 60-minute rehearsal scope.

ANALYSIS: Against test-coverage-policy invariant 3, the Safe-only-executor property has **no
executed-in-CI assertion of the on-chain role state**: the runtime `require` is never run by a PR job,
and the three CI checks that do run prove address prediction, TypeScript parity, and a manifest string
the script writes itself. A regression in `_handOver`/`_check` could leave CI green while the deploy-time
backstop is the only thing that catches it. This is a genuine, if bounded, test-coverage gap. Mitigating
facts that cap severity: the property is asserted at deploy time with a loud `require` and re-read by the
QA runbook on the live/rehearsal chain, so a wrong artifact does not ship (it fails before/at deploy);
the prior synthesized report already recorded exactly this as its single limitation (line 140) and
recommendation 1 (line 119). Harm axis: assertion integrity (not release integrity — no wrong artifact
was observed and the deploy gate fails loudly). Trigger: an author (write access to change the deploy
script). Fails safe at the deploy/QA layer, so the rubric's fails-safe downgrade applies and no
documented-prohibition or operator-corruption escalator cancels it → `medium`, advisory, non-blocking.
This does not overturn the prior review's clean headline; it promotes its documented limitation into a
tracked, low-priority TEST_* item.

SEVERITY IF PROMOTED: `medium` (classification `TEST_COVERAGE_GAP`; confidence `high`; owner `tests`).
Rationale per rubric: assertion-integrity harm + author-triggerable would be `high`, downgraded one band
because the invariant is enforced at deploy time and in QA before any artifact ships. Related prior
item: synthesized report recommendation #1 / limitation line 140.

RECOMMENDATION: Add one CI job (in the suite-28 Twin rehearsal family, or a bounded blank-anvil job) that
deploys the fund stages and executes `DeployFundTimelock.run()`, then reads back
`EXECUTOR_ROLE` on the fund timelock (`Safe == true`, `address(0) == false`, deployer `== false`) with a
non-zero executed-test floor so a starved run goes red. Until then, keep the item as an advisory
limitation on the release owner's pre-flight checklist. Do not treat the prediction/parity/verifier
checks as closing this specific gap.

---

## B4 — reproduce the 54-test claim

VERDICT: closed with evidence

EVIDENCE: Exact command, run from the worktree (forge present at `/drive2/home/lucas/.foundry/bin/forge`):
```
FORGE_TEST_MIN_EXECUTED=1 bash .github/scripts/forge_test_require_executed.sh -vv \
  --match-path "contracts/test/{GovernedUpgrade,UpgradeCeilings,DeployScriptChainGuards,DeployScriptChainGuardsTwin,UpgradeAuthorityStages}.t.sol"
```
Result (abridged per-suite headers, exact totals and guard line):
```
No files changed, compilation skipped
Ran 2 tests for contracts/test/UpgradeCeilings.t.sol:UpgradeCeilingsTest      -> 2 passed; 0 failed; 0 skipped
Ran 12 tests for contracts/test/DeployScriptChainGuardsTwin.t.sol:...          -> 12 passed; 0 failed; 0 skipped
Ran 12 tests for contracts/test/DeployScriptChainGuards.t.sol:...              -> 12 passed; 0 failed; 0 skipped
Ran 5 tests for contracts/test/UpgradeAuthorityStages.t.sol:...                -> 5 passed; 0 failed; 0 skipped
Ran 23 tests for contracts/test/GovernedUpgrade.t.sol:GovernedUpgradeTest      -> 23 passed; 0 failed; 0 skipped

Ran 5 test suites in 21.22ms (54.91ms CPU time): 54 tests passed, 0 failed, 0 skipped (54 total tests)
executed-test-guard: 54 forge test(s) passed (floor 1)
WRAPPER_EXIT=0
```
(2+12+12+5+23 = 54, matching the guard's computed total; 0 skipped.)

ANALYSIS: The prior report's 54-test execution claim is reproduced exactly at the pinned commit: five
real forge suites executed 54 tests, zero skipped, and the wrapper's own executed-count guard printed a
matching total and returned 0. This is an executed behavioural assertion, not a compile/lint/doc-grep
claim. No finding.

SEVERITY IF PROMOTED: N/A — no finding promoted.

RECOMMENDATION: Replace the "one worker recorded 54 passed" limitation wording with this reproduced
command + output as execution evidence.

---

## Limitations

- Static review plus the two executions recorded above; no PR-time CI log was inspected end-to-end.
  `gh run list` showed recent runs and gh is authenticated, but no workflow run for the pinned
  `release-0.9.0` commit was replayed to confirm the fund stages did/did not execute in a real run —
  the "no CI job" conclusion rests on the in-tree workflow definitions, which is definitive for code
  that exists in the repo.
- The fund dry-run command was not executed: prerequisites (installed publish-contracts deps, frozen
  counts for sha `d4a43e6d`, a committed fund sheet, plus a ~60-minute human rehearsal) are absent in a
  review worktree. A faithful execution would require the full fund deploy sequence, not a one-shot
  forge call.
- B1 read both named test bodies in full but did not re-read every other suite in `contracts/test/**`;
  the §8 invariants owned by those other suites were located by name/reference, not re-executed here.
- The `RobotMoneyGatewayApplyReceipt`/`RouterGovernanceApplyReceipt` companion was read for skip/assume
  shape and test names, not line-by-line across all 535 lines.
- Severity for B3 is a reviewer judgement applying the shared rubric to a deploy-time-only backstop;
  a coordinator that treats "no executed-in-CI assertion" as inherently `high` could raise it, but the
  deploy/QA gate keeps it non-blocking.

## checked_shapes

Catalogue: `docs/development/false-green-shapes.md` (present at pin). Evaluated this pass:
`starved-guard-input` (B2 — closed: wrapper floor clamped >=1, `PIPESTATUS[0]` prevents swallowed
failure, self-tests plant zero-match/real-forge-empty and fail loudly), `optional-fixture-early-return`
(B1/B2 — no `Option`/fallible fixture or early return in either test body; forge all-skipped prints
`0 passed` and is red), `artifact-guard-runs-before-build` (B1 — no `existsSync`/existence guard found),
`trigger-scoped-dead-code` (B3 — fund deploy is human/runbook-scoped, not a PR job; this is the promoted
gap), `uninvoked-evidence-script` / `missing-evidence-script` (B3 — the require is invoked by real deploy
and dry-run, so not these shapes), `digest-blind-to-attribute` (B3 — prediction/parity/verifier check
address/policy/manifest, not on-chain role grants: the mechanism behind the promoted gap),
`fixture-shape-blind-selftest` (B2 — self-test covers zero-match, forge-failure, floor-above, floor-met,
no-args, and a real-forge planted empty match), `doc-contradicts-guard-invariant` (B3 — v0.9.0 upgrade
runbook has no fund deploy dry-run step; no contradictory canonical claim found), and
`selftest-env-splice` / `matrix-tool-absent-step-skipped` / `quoted-path-evasion` /
`stale-cache-embedded-artefact` (not applicable to the two Solidity test bodies, the forge wrapper, or
the fund stage search — ruled out).
