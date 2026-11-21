# Cross-review addendum — second security review, same pin

**Purpose.** A second security review of the same pin (`d4a43e6d2`) reached a
different headline ("no contract security finding survived adversarial
refutation") and promoted one medium `TEST_COVERAGE_GAP` plus four advisories.
This chapter records independent verification of those five items and reconciles
the two reviews' dispositions with the 23 TestMachine findings.

**Sources.** Branch `review/security-release-0.9.0-20261117` at `8eb11543f`;
canonical summary `docs/code-review/20261117-review-security-opencode.{md,json}`;
full evidence `docs/code-reviews/20261117-hy4/` (notably
`07-deep-dive-test-evidence.md`, `06-deep-dive-liveness-registry.md`,
`09-deep-dive-live-deployment.md`, `10-deep-dive-natspec-docs.md`, and lanes 2–4).
All code evidence below was re-read at the pin in this worktree; the working tree
diff against the pin is empty for every cited file.

## Verification results

| Item | Second review | Independent verdict |
| --- | --- | --- |
| Fund timelock Safe-only executor, no CI assertion | MEDIUM `TEST_COVERAGE_GAP`, advisory | **CONFIRMED** (one sub-claim corrected) |
| Same-second receipt liveness | advisory | **CONFIRMED** advisory |
| `VaultRegistry` hook asymmetry | advisory | **CONFIRMED** advisory |
| Stale router comments | advisory / clarity | **CONFIRMED** clarity-only |
| Live `RS-1019-14` role shape | remains Open | **CONFIRMED** must remain Open |

### 1. Fund timelock Safe-only executor — CONFIRMED (sub-claim corrected)

The on-chain assertion exists only in script code: `DeployFundTimelock.s.sol:142-203`
`_check(d)`, called from `run()` at `:94`, with the Safe-only `require`s at
`:146-153` (Safe holds `EXECUTOR_ROLE`, not `address(0)`, not the deployer).

No CI job executes it. `.github/workflows/suite-28-core-stages.yml:142-159` runs
`twin-publish` with `vaults-only: "true"` and `gateway: "true"` only;
`suite-14-smoke-test.yml:482-500` covers the vaults/gateway harness;
`suite-01-02-forge-tests.yml:739-740` explicitly skips the script in coverage and
no test file references it; `suite-13-doc-checks.yml:506-514` only structurally
validates the QA runbook. `publish-contracts/src/ci/twin-publish-fund.ts` performs
`--system fund` but is referenced by no workflow. The script also needs prior fund
stages deployed (`:67-82,103-118`), so a one-shot blank-anvil call is not a faithful
reproduction.

**Correction to the second review:** its claim that "none reads back on-chain
`EXECUTOR_ROLE` holders" is factually wrong. `publish-contracts/src/verify/fund.ts:241-243`
does assert the exact on-chain state through `verifyExclusiveRole`/`hasRole`
(`chain.read`, `:40-59`): executor held exclusively by the Safe, not by zero, not
by the deployer. `:240` additionally checks the manifest string the script writes.
The finding therefore survives in narrower form: the assertion exists both at
deploy time and in the fund verifier, but **neither is wired into a PR CI job**.
This still violates test-coverage-policy invariant 3 ("runtime behaviour needs an
executed-in-CI assertion"). `medium`, advisory, non-blocking is defensible: the
deploy-time `require` and QA/stage readback fail loudly before any artifact ships
(fails-safe downgrade). Local execution was not attempted — `node_modules`, a
frozen-counts file for `d4a43e6d`, a committed fund sheet and a bounded human
rehearsal are absent.

### 2. Same-second receipt liveness — CONFIRMED advisory

`ConsensusRecommendationReceipt.sol:155-183` stamps `recordedAt = uint64(block.timestamp)`
at `:167` and deduplicates only by `receiptId` (`:165`), so two distinct receipts in
one second both succeed with equal `recordedAt`. `RouterGovernance.sol:191-193`
requires strictly `>` with no tie-breaker and no cursor setter; `:195-196` updates
the cursor before release and weight application. Test-pinned by
`RouterGovernanceApplyReceipt.t.sol:379` (`test_applyReceipt_sameRecordedAtRefused`).

The second review's mitigations hold: role-gated creation/application, fail-safe
loser (revert, no wrong vector), and a real tooling pre-check at
`publish-contracts/src/govern.ts:1799-1806` → `apply-receipt.ts:112-118` before
scheduling. Out-of-band replacement exists (re-record under a new session/subject,
or Safe→timelock `setDefaultWeights`/`clearVotedWeights`). **Nuance:** the doc at
`docs/architecture.md:857-865` records the strictly-later rule and tooling
pre-check but not the explicit same-block tie consequence, so "documented" is
slightly overstated — the second review's own recommendation #3 asks for that
line. This is consistent with scan finding #17 (same mechanism, same test, both
agree on availability harm); only the severity framing differs.

### 3. `VaultRegistry` hook asymmetry — CONFIRMED advisory

`registerVault` (`VaultRegistry.sol:239-254`) checks only non-zero/unregistered,
no code length. `retire` (`:280-292`) and `reactivate` (`:300-305`) call the hook
unconditionally (`:290`, `:303`); `setVaultStatus` wraps it in
`if (vault.code.length > 0)` (`:355-361`). The asymmetry is real, and the NatSpec
at `:322-328,348-354` (hook failure "intentionally" propagates) contradicts the
EOA branch. All paths are `ADMIN_ROLE`-only (timelock in production), fail closed,
and `PortfolioRouter._requireRouterEligible` (`:1427-1445`) rejects code-less legs
at both vector-write and deposit time, so no funds, halt flag or router leg can be
wrong. Recommend the NatSpec correction (and optionally a `code.length` guard in
`retire`/`reactivate` for API consistency). This is distinct from scan finding #14
(the feature-flag observation); the older Azimuth `AZ-REG-1` hook-swallowing defect
was fixed at the pin by removing `try/catch`.

### 4. Stale router comments — CONFIRMED clarity-only

`PortfolioRouter.sol:1074-1076` mislabels `msg.sender` as "the gateway", calls the
gateway the `owner`, while the actual owner passed to `vault.redeem` is
`shareHolder` (`:1077`) and any caller with holder allowance may call `redeemFor`
(`:1069-1072`). `contracts/gateway/interfaces/IPortfolioRouter.sol:21-22` claims
shares are pulled via ERC-20 `transferFrom`; no `transferFrom` exists in the router
— the real mechanism is ERC-4626 `redeem` spending the router's allowance. No
operator, runbook or signing-client surface repeats the stale actor model
(`clients/dapp/src/lib/routerRedeem.ts` builds `holder` as both holder and
recipient). Clarity/informational severity is correct. These comments are adjacent
to but distinct from scan finding #13: #13 concerns the *reusable threshold* on the
holder→caller allowance, whereas the stale comments concern actor identity and
mechanism wording, and do not cause or conceal it.

### 5. Live `RS-1019-14` — CONFIRMED must remain Open

`docs/audits.md:656` records RS-1019-14 as Low, `accepted-with-rationale`, **Open**:
`RouterGovernance` holds the receipt `ADMIN_ROLE` instead of a narrow release role.
Target shape (canon `docs/architecture.md:817,838-842,1808`): `RouterGovernance`
holds `RECEIPT_RELEASER_ROLE`, timelock alone holds `ADMIN_ROLE`. New deploys enforce
it (`DeployTimelock.s.sol:557-568`, `DeployFundTimelock.s.sol:167-178`) and a
timelock-only migration function exists (`ConsensusRecommendationReceipt.sol:126-140`,
`migrateToSubmitterRoles`), but every committed Base manifest is rehearsal or Twin
(`deployments/8453/deploy-2/README.md:5`, `timelock.json:33`), the expected-role
fixture is a test expectation rather than a live readback, and no RPC is configured.
Canon explicitly states the deployed v0.5.0 register still grants governance
`ADMIN_ROLE`. Closing requires a live Base role read or the operator's out-of-repo
migration record; it cannot be closed from repository artifacts.

## Reconciliation with the 23 TestMachine findings

The two reviews are not in genuine conflict. The second review applies a stricter
bar — an observable wrong state reachable by an untrusted actor without a
trusted-role precondition and not already covered by an executed assertion — whereas
this reproduction asks whether the described behaviour is present and reachable.
Consequently:

- **#17** is identical in both: mechanism real and test-pinned, admin-triggered,
  availability-only. Here REPRODUCED (low DoS); there advisory. See item 2 above.
- **#19** matches: transient-tick mechanic exists but is documented/accepted, with
  ≤10 ticks/s drag and ORA-4 bounds. Here REPRODUCED mechanic with bounded economics.
- **#13** is a severity dispute, not a code dispute: the second review calls the
  two-allowance redeem intentional defence-in-depth, while this review notes the
  checked holder→caller allowance is never consumed and the spent holder→router
  allowance is not the one checked, under the explicitly discouraged standing
  approval (NatSpec `:948-960`). Keep REPRODUCED with the stated precondition.
- **#1 / #23**: the second review refutes a different claim (funds routed to the
  triggerer; active/configured-inactive assets quarantined). Our #23 REJECTED
  agrees. Our #1 PARTIAL acknowledges the degraded-pool quarantine as the designed
  safety valve. Note a wording discrepancy: the review calls the destination
  "governed"; the `reabsorb` path uses the two-argument `sweep(token, triggeredBy)`
  with the **fixed constant** `QUARANTINE = 0x…deaD11`
  (`ForeignTokenQuarantine.sol:49,75-81`); the governed three-argument overload is
  used by the main vaults' `sweepForeignToken`, not by `reabsorb`.
- **#14** is consistent with the review's observation that `FeatureFlags` has no
  production Solidity importer (off-chain/UI gate).

**No verdict among the 23 changes.** The five folded-in items are additive.

## Additive recommendation

Add a bounded CI job that deploys the fund stages, executes `DeployFundTimelock.run()`,
and reads back `EXECUTOR_ROLE` (Safe true, zero false, deployer false) with a
non-zero executed-test floor. Until then, keep the item on the release owner's
pre-flight checklist. Do not treat CREATE2 prediction, TypeScript parity or the
manifest string alone as closing it — the fund verifier's on-chain readback exists
but is likewise not CI-wired.
