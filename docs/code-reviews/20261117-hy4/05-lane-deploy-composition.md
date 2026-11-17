# LANE 5 — Deploy/Upgrade Security & N-order Composition — `release-0.9.0` review pin

## Scope and pinned commit

- **repository**: `git@github.com:robotmoney/robotmoney-core.git`
- **branch**: `review/security-release-0.9.0-20261117`
- **commit**: `d4a43e6d21efed208816698d2b32f0decea45451` (verified `git rev-parse HEAD`)
- **reviewed_at**: 2026-11-17
- **tracker**: github; **mode**: adhoc review (no issue/PR); **worktree**: `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/adhoc-20261117-145601` (clean at pin)
- **lane files**: `contracts/script/*.sol` (deploy/upgrade/handover), prior review artifacts under `docs/code-review/` and `docs/audits.md`, CI/test execution evidence in `.github/workflows/*.yml`, `foundry.toml`, `contracts/test/**`, and the false-green catalogue `docs/development/false-green-shapes.md`.
- **exclusions**: no evidence from `origin/release-0.9.0` (`ffc5e4b0d`) or any later commit was used. Non-lane surfaces (dapp, rmpc, explorer-indexer/watchdog, adapter economics) were not reviewed except where they consume a deploy artifact.

## Headline verdict

**No new finding survived adversarial refutation.** The three assigned jobs were completed: (A) deploy/upgrade authority, (B) open prior findings + embedded `review-tests` evidence, and (C) four n-order composition passes. Every candidate I raised was refuted by an on-chain guard, an executed test, or a cross-language parity gate; the refutations are recorded below with `path:line` evidence so a second reviewer can re-run them. Prior findings that remain open are all `accepted-with-rationale` in the canonical ledger and are reported, not re-asserted as new. The merge-blocking line is not crossed by anything in this lane.

A note on evidence discipline: all claims below are **observed facts** unless explicitly labelled *reviewer inference*. A green CI check was never treated as execution evidence; the only "tests ran" claim in this report is backed by an actually-executed command (see `## Test execution evidence`).

---

## Findings

**None survive refutation.** No `### FINDING L5-NN` block is emitted because no candidate met the bar of an observed correctness/assertion gap that is triggerable and fails unsafe (or fails safe with a downgrade-cancelling escalator) at medium-or-higher severity with medium-or-higher confidence. The candidates that were investigated and refuted are documented in `## Refuted candidates` below, which is provided for reproducibility rather than as findings.

### Refuted candidates (did not survive — for reproducibility, not findings)

- **Candidate C5-1 — post-broadcast `_check` cannot prevent bad state from landing on-chain.** `DeployTimelock._check()` and `DeployFundTimelock._check()` run *after* `vm.stopBroadcast()`, so a failing `require` reverts the forge process after the grant/revoke transactions have already been broadcast. *Refuted:* the one concrete trigger this protects against — a wrong `RECEIPT_ADMIN_ADDRESS` that leaves the deployer holding the receipt roles — is guarded **before** broadcast by the driver (`publish-contracts/src/sheet.ts:601`, `RECEIPT_ADMIN_ADDRESS must equal ADMIN_ADDRESS`), and the script-side check was added deliberately for the raw-script/dry-run path with a named reason (`contracts/script/DeployTimelock.s.sol:540-552`, devops finding R-02). Trigger requires the deployer/admin to misconfigure env; it fails safe at the process level (visible red) and the driver pre-check covers the normal path. Not an unprivileged or false-green path; at most an operator hazard already documented.
- **Candidate C5-2 — fake metadata length defeats `AdapterBytecodeGuard._codeLengthWithoutMetadata`.** A crafted adapter whose metadata trailer declares a misleading length could in principle hide a `DELEGATECALL`. *Refuted for this pin:* production adapter bytecode is compiled locally in `DeployVault.s.sol` and its codehash is pinned into the manifest and verifier; no external/adversarial adapter bytecode is accepted by the deploy path. Recorded as a limitation, not a finding.
- **Candidate C5-3 — chain guard read ordering in `DeployTimelock._runFrom`.** Env vars are read before `_requireExpectedChain`, and `test_deployTimelock_run_requiresExpectedChainOnBase` uses a generic `vm.expectRevert()`. *Refuted:* the `_requireExpectedChain` primitive itself has four dedicated executed tests (wrong chain, unset on 8453, matching 8453, unset off 8453) in `DeployMainnetInputs.t.sol`; the generic matcher is a test-precision nit, not a proof gap in the guard, and no wrong-chain state can be committed because the guard still precedes all broadcasts.
- **Candidate C5-4 — rehearsal delay floor on Base (8453) is a bypass.** Rehearsal deployments use a lower timelock floor. *Refuted:* intentional and tested (`test_rehearsalKind_boundariesOnBase`), and the rehearsal kind is injected from the deployment sheet by the driver (`publish-contracts/src/runner.ts` strips caller `DEPLOYMENT_KIND`), so a caller cannot select the rehearsal floor on a production run.
- **Candidate C5-5 — `storage-layout-reset` label waives the base-commit layout compare.** *Refuted:* the label waives only the base-commit comparison; the released-layout baseline comparisons still run (`suite-01-02-forge-tests.yml:251-263`, plus `--release-anchor` mode from SR-1015-4).
- **Candidate C5-6 — fund Safe-only executor invariant lacks an executed runtime assertion.** There is no dedicated `DeployFundTimelock*.t.sol` and the prototype harness deploys with `executors[0] = address(this)` (`contracts/test/prototype/PrototypeHarness.sol:286`), not the production Safe shape. *Refuted as a finding:* the invariant is covered by (a) executed Solidity vectors that assert the fund prediction differs from the open-executor prediction (`contracts/test/UpgradeAuthorityPrediction.t.sol:28-72`), (b) a cross-language parity gate recomputing both executor modes in TypeScript (`scripts/ci/check-timelock-prediction-parity.ts:27-45`), (c) on-chain `require`s in `DeployFundTimelock._check` (`contracts/script/DeployFundTimelock.s.sol:145-153`) and the shared CREATE2 handover (`contracts/script/CoreTimelockHandover.sol:183-195`), and (d) the fund verifier's manifest assertion (`publish-contracts/src/verify/fund.ts:240`). Whether (c) is *executed in CI* is a limitation, recorded below — not a demonstrated false green, because the code is correct and independently pinned by (a)+(b).

---

## Open prior findings at this commit

Source of truth: `docs/audits.md` (disposition ledger). Only findings whose failure mode intersects this lane (deploy/upgrade scripts, release tooling, timelock/roles) are listed. "Open" here means the ledger disposition is `accepted-with-rationale`/`Open` at this commit; these are **not** re-reported as new findings.

| Prior ID(s) | Severity | Disposition at this commit | Lane relevance |
|---|---|---|---|
| `RB-1022-1` | Medium | accepted-with-rationale / Open | Release gate binds rc tag → sha but not branch, rc grammar, or QA-passed tree (`docs/audits.md:678`). |
| `RB-1022-2` | Medium | accepted-with-rationale / Open | counts-checkout proves reachability from `origin/dev` only; release-line counts refused (`:679`). |
| `RB-1022-3` | Medium | accepted-with-rationale / Open | No workflow runs on `qa/**`; only six name `releases-*` (`:680`). |
| `RB-1022-4` | Low | accepted-with-rationale / Open | `--releases` layout baseline includes undeployed rc tags (`:681`). |
| `RB-1022-5` | Medium | accepted-with-rationale / Open | No tool cuts rc / checks squash / keeps QA journal with tree hash (`:682`). |
| `RB-1022-6` | Low | accepted-with-rationale / Open | QA validator does not bind a target to its ref (`:683`). |
| `RB-1022-7` | Low | accepted-with-rationale / Open | Branch/tag immutability are conventions; ruleset is an owner setting (`:684`). |
| `RB-1022-8` | Low | accepted-with-rationale / Open | QA scope list checked for shape, not against commits (`:685`). |
| `RB-1022-9` | Low | accepted-with-rationale / Open | Stale `releases-0.4.x` doc reference and four legacy branches (`:686`). |
| `SR-1012-V4` | Unassessed | accepted-with-rationale / Open | V4 price source; mitigation `BasketViews.checkSellAnchor` present, stronger source deferred (`:505`, `:754`). Out of script scope; noted for completeness. |
| `SR-1015-14` | Low | accepted-with-rationale / deferred | rmpc swarm preflight checks wrong policy/role (`:530`). Out of lane. |
| `SR-1015-34/35/36/37/41/43/44/45/46/48/50/52` | various | accepted-with-rationale / **superseded** | QA upgrade implementation rows dropped at the 2026-10-15 merge; replaced by `GovernedUUPS`/ADR-0014 (`:550-568`). The replacement is in-scope and assessed as clean below. |
| `SR-1015-4/30/31/33/38/39/40/42/49` | various | fixed (ledger) | Layout anchor, build provenance, owner-signer precheck, govern resume, release-tag `refs/replace`, installer attestation, etc. (`:520`, `:546-556`, `:565`). Fixed in code at this commit; no re-report. |
| `RS-1019-14` | Low | accepted-with-rationale / Open in ledger | "RouterGovernance holds the receipt's ADMIN_ROLE instead of a narrow release role" (`:656`). **Verified at pin:** the deploy-time guard now enforces the intended shape — `DeployTimelock.s.sol:565-568` requires governance **not** to hold the receipt `ADMIN_ROLE`, and requires governance to hold `RECEIPT_RELEASER_ROLE` (granted by `DeployRouterGovernance.s.sol`). So the *new-deploy script* is clean; the ledger's "Open" disposition concerns the already-live receipt register and is not contradicted by this lane. Remediation of the live deployment was not verifiable from scripts alone (see Limitations). |

Retired audit rows (`FS-*`, `MC-*`, `HR-*`, `AZ-*`) and the SR-0612/DC-0606 inventories are dominated by `fixed`/`accepted-with-rationale` dispositions in the same ledger and were not re-litigated; none names a currently-unfixed deploy/upgrade authority gap in the code reviewed here.

---

## Composition results

Four n-order composition passes were run (requirement: at least two). Each asks whether independently-correct components remain correct when combined. Verdicts are "UNBLOCKED" (composition holds, with evidence) or "BLOCKED" (a composition gap). All four are UNBLOCKED.

### Pass 1 — Governance timelock + proxy upgrade authority (order/composition)

- The timelock stage deploys a `ProposerFloorTimelock` LAST at the CREATE2 address every proxy already named (`contracts/script/CoreTimelockHandover.sol:156-200`; `contracts/script/UpgradeAuthority.sol:35,77-81`). CREATE2 binds the init code (Safe proposer/canceller, executor in init code, `minDelay`, no admin), so no interim or deployer-controlled address can ever hold upgrade authority.
- Before any admin role moves, `_requireUpgradeAuthority` asserts every vault, registry, router, governance, and receipt proxy reports `upgradeTimelock() == timelock` (`contracts/script/DeployTimelock.s.sol:572-583`).
- At runtime, `GovernedUUPS` accepts an upgrade only from `upgradeTimelock` and refuses when frozen (`contracts/lib/GovernedUUPS.sol:156-157`); initialization is one-way and cannot rebind the timelock or clear the freeze (`:81-89`, `:130`).
- **Verdict: UNBLOCKED.** Predicted address, on-chain `upgradeTimelock()`, and runtime authorization compose into a single authority; no second path to an upgrade exists in the reviewed code.

### Pass 2 — Deploy wiring + role grants + deployer clean-out

- Handover is grant-then-renounce so no contract is left without an admin (`contracts/script/DeployFundTimelock.s.sol:121-139`).
- Post-broadcast checks assert the timelock holds `ADMIN_ROLE` and the deployer holds neither `ADMIN_ROLE` nor `DEFAULT_ADMIN_ROLE` on fund/queue/rebalancer/governance/receipt register (`DeployFundTimelock.s.sol:154-175`); the vaults path does the equivalent plus the R-02 receipt-admin check (`DeployTimelock.s.sol:540-552,810-831`).
- Emergency and keeper keys are read back from chain and asserted distinct from the deployer (`DeployFundTimelock.s.sol:179-202`, `:115-116`).
- **Verdict: UNBLOCKED.** The union of grants, revocations, and read-backs leaves the deployer with no standing role and the timelock with sole admin across both systems.

### Pass 3 — Receipt staleness + router config + governance release role

- `RouterGovernance.applyReceipt` refuses any receipt whose `recordedAt` is not strictly greater than `lastAppliedRecordedAt`, then advances the watermark (`contracts/RouterGovernance.sol:93,191-193`); a released-but-unapplied receipt carries no weights and is refused forever (`RouterGovernance.sol:36-45`).
- Deploy wiring binds `RouterGovernance.receipts()` to the deployed register and grants governance the narrow `RECEIPT_RELEASER_ROLE` — never the register `ADMIN_ROLE` — while the timelock is the sole register admin (`DeployTimelock.s.sol:553-568`; `DeployFundTimelock.s.sol:167-178`).
- "No contract expiry" on the receipt (`ConsensusRecommendationReceipt.sol`) is a documented design choice; freshness is enforced by the monotonic watermark above, so an old-but-never-applied receipt cannot supersede a newer one. *Reviewer inference:* a still-unapplied old receipt could be applied late, but it cannot regress the active weight vector, which is the security-relevant property.
- **Verdict: UNBLOCKED.** Staleness rejection, single-admin register, and narrow releaser role compose without giving governance an arbitrary call or submitter-grant path.

### Pass 4 — Fund deploy wiring + Safe-only executor across the two systems

- Vaults system uses ADR-0004's open executor; fund system overrides to Safe-only (`contracts/script/UpgradeAuthority.sol:68-74`; `FundTimelockPolicy.sol:15`). Because the executor is part of CREATE2 init code, the two systems derive different timelock addresses, preventing cross-system authority confusion.
- The shared CREATE2 handover asserts the executor role matches each system's policy and that `address(0)` does not hold it for the fund system (`CoreTimelockHandover.sol:183-195`); the fund `_check` re-asserts Safe = executor and deployer ≠ executor (`DeployFundTimelock.s.sol:145-153`).
- Executed Solidity vectors assert the fund prediction differs from the open prediction (`UpgradeAuthorityPrediction.t.sol:45-50`), and the TS parity gate recomputes both modes from the same build (`check-timelock-prediction-parity.ts:38-44`).
- **Verdict: UNBLOCKED.** Role prediction, on-chain assertion, and cross-language parity agree on the executor for both systems.

---

## Test execution evidence (embedded `review-tests` method)

- **Executed command (this review):** `FORGE_TEST_MIN_EXECUTED=1 bash .github/scripts/forge_test_require_executed.sh -vv --match-path "contracts/test/{GovernedUpgrade,UpgradeCeilings,DeployScriptChainGuards,DeployScriptChainGuardsTwin,UpgradeAuthorityStages}.t.sol"` → **54 tests passed, 0 failed, 0 skipped**, with `executed-test-guard: 54 forge test(s) passed (floor 1)`. This is positive evidence that these tests ran, not a claim inferred from workflow YAML.
- **Guard coverage for the four test-evidence invariants:** loud-skip (external-resource tests fail in CI when the resource is absent), exit-0≠tested (`forge_test_require_executed.sh` floor + per-target `grep '^ *[1-9][0-9]* pass'` in `suite-28-core-stages.yml:60,83,92-94`), runtime-vs-static (Solidity execution in the forge job, plus the real-chain rehearsal job), and language coverage (Solidity forge suites, Bun/TS `publish-contracts` suites with positive pass floors).
- **Lane-specific executed assertions confirmed present:** `GovernedUpgrade.t.sol` (`test_implementationTakeover_isImpossible`, `test_roleChanges_doNotMoveUpgradeAuthority`, `test_safeDirectUpgrade_isRefused`, `test_interveningUpgrade_beforeAQueuedFreeze_blocksTheFreeze`, `test_pendingUpgrade_afterTheFreeze_fails`); `DeployMainnetInputs.t.sol` (four `_requireExpectedChain` cases); `DeployTimelock.t.sol` (stale signer hypotheses, delay floor, rehearsal boundaries, wrong receipt admin); `AdapterDelegatecallGuard.t.sol` (PUSH-immediate false positives + bare opcode).
- **No coverage claim is made** from compilation, lint, type-check, NatSpec, doc-grep, skipped tests, or zero-test runs. The `superseded` SR-1015 rows' "compile-checked only; its tests have not run (Phase Q)" notes were read as a limitation of those historical rows, not as current coverage claims.

---

## Clean areas

- **CREATE2 upgrade-authority prediction and handover** — init-code binding, correct-chain enforcement, proxy `upgradeTimelock()` read-back, and one-way freeze compose as designed (`UpgradeAuthority.sol`, `CoreTimelockHandover.sol`, `GovernedUUPS.sol`).
- **Receipt admin / releaser separation** — deploy scripts enforce narrow releaser role and timelock-only register admin; the previously-flagged governance-holds-admin shape is guarded at deploy time (`DeployTimelock.s.sol:553-568`, `DeployFundTimelock.s.sol:167-178`).
- **Safe configuration checks** — owner list (nonzero, unique, actual owners), no module, no transaction guard, canonical fallback handler, threshold and delay floor (`CoreTimelockHandover.sol:130-149`, `:117-119` of `DeployFundTimelock`).
- **Adapter bytecode guard** — delegatecall detection via bare-opcode scan with PUSH-immediate false-positive handling, tested (`AdapterBytecodeGuard.sol`, `AdapterDelegatecallGuard.t.sol`).
- **Chain guards and rehearsal kind** — strict expected-chain primitive, rehearsal delay floor, and sheet-injected `DEPLOYMENT_KIND` (`ExpectedChainGuard.sol`, `runner.ts`, `DeployTimelock.t.sol`).
- **Storage-layout and reproducible-build gates** — anchored/tagged layout comparisons and non-zero compared-artifact counts with metadata path scrub (`suite-01-02-forge-tests.yml:251-273`).
- **Timelock prediction TS↔Solidity parity** — cross-language equality for both executor modes (`check-timelock-prediction-parity.ts`, `UpgradeAuthorityPrediction.t.sol`).

---

## checked_shapes

Evaluated against `docs/development/false-green-shapes.md` and ruled out for this lane:

- `missing-evidence-script` — named CI scripts (`forge_test_require_executed.sh`, `check-timelock-prediction-parity.ts`, `rehearsal-counts.ts`, `validate-contract-qa.ts`) all exist on disk.
- `uninvoked-evidence-script` — the forge guard script is invoked by the executed command above; parity/counts/validator scripts are wired into `suite-28-core-stages.yml` and `suite-13-doc-checks.yml`.
- `starved-guard-input` — layout-gate steps fetch tags with explicit `fetch-depth`/tag fetch (`suite-01-02-forge-tests.yml:256-257`); counts baseline uses `fetch-depth: 0` (`suite-28-core-stages.yml:72-73`).
- `quoted-path-evasion` — lane guards use fixed repo-relative paths and JSON keys, not anchored regexes over free-form paths.
- `selftest-env-splice` — sandbox/extraction harnesses (`install-rmpc-selftest.sh` fixtures per catalogue) are outside this lane; no deploy-script guard was found that reads its own guarded file's `env:`.
- `doc-contradicts-guard-invariant` — canonical docs (`architecture.md` §4.5/§4.7, `audits.md`) agree with the shipped open-executor/role invariants; the one stale disposition (RS-1019-14) is reported in Open prior findings, with the deploy script on the enforcing side.
- `trigger-scoped-dead-code` — the rehearsal/upgrade jobs that carry the guards have non-draft, push/nightly triggers (`suite-28-core-stages.yml:20-34,126,226`); no guard was found that only runs on a branch that never fires.
- `matrix-tool-absent-step-skipped` — forge/Bun run in Linux jobs with setup actions; no macOS `sha256sum` shape in the deploy lane.
- `optional-fixture-early-return` — fund deploy inputs are all required env vars with `vm.env*Required` and a `_validate` that reverts on zero/absent (`DeployFundTimelock.s.sol:67-80,98-119`); no `Option`/nil early-return fixture in this path.
- `fixture-shape-blind-selftest` — prototype harnesses use a different executor shape than production (`address(this)` vs Safe); this was examined as Candidate C5-6 and the production shape is instead pinned by executed prediction vectors + parity, so it is a documented limitation rather than a false green.
- `artifact-guard-runs-before-build` — the reproducibility/layout steps run after `forge build` in their jobs (`suite-01-02-forge-tests.yml`); no compared-before-built shape in this lane.
- `digest-blind-to-attribute` — manifest code hashes are read from chain (`address.codehash` / implementation slot), not from a digest that ignores the binding attribute (`DeployTimelock.s.sol:604-611`; `DeployFundTimelock.s.sol:205-226`).
- `stale-cache-embedded-artefact` — the Twin baseline is rebuilt in a second checkout path and strict-loaded (`suite-28-core-stages.yml:167-185`); no stale-cache acceptance path found in this lane.

---

## Limitations

- **Pin discipline:** all evidence is from commit `d4a43e6d21efed208816698d2b32f0decea45451`. `origin/release-0.9.0` (`ffc5e4b0d`) was not consulted; findings about that commit are out of scope.
- **Chain/network tests not executed locally:** fork/devnet suites (`suite-05`, `suite-28` rehearsal, `suite-29`) depend on `BASE_UPSTREAM_RPC`/Twin credentials and were assessed from workflow structure and committed evidence, not re-run. Only the local forge command above was executed during this review.
- **Fund deploy on-chain `_check` execution not proven in CI:** the QA runbook `docs/runbooks/contract-qa/releases/v0.7.0-onevault.yaml` (which runs the fund stages including `fund-timelock` on anvil) is validated *statically* in CI via `validate-contract-qa.ts` + tests (`suite-13-doc-checks.yml`), not executed on-chain as a merge gate; `core-stages-twin` rehearses the vaults+gateway systems (`vaults-only: "true"`), not the fund system. The fund executor invariant is therefore covered by executed prediction vectors, TS parity, verifier, and the (script-side) `require`, but I could not confirm a CI job executes `DeployFundTimelock.run()` with that `require` live. Recorded as a limitation, not a finding, because no incorrect behavior was demonstrated.
- **RS-1019-14 live remediation:** the deploy script enforces the correct receipt role shape for new deployments, but whether the already-deployed receipt register was migrated is a deployment-state question not answerable from script source; the ledger's "Open" disposition is left intact.
- **Adapter metadata-length bypass:** theoretical only; production adapters are locally compiled and codehash-pinned, so no adversarial bytecode reaches the guard on this deploy path (Candidate C5-2).
- **Static analysis only** for several invariants; no formal verification or symbolic execution was performed, and reviewer inference is labelled as such where used (Pass 3).
- **Unreviewed surfaces:** dapp, rmpc, explorer-indexer/watchdog, adapter internal economics, and migration/reorg behavior were outside this lane's assignment.

## Recommended actions (advisory; no code changed)

1. Add an executed CI assertion that runs `DeployFundTimelock.run()` on a local/Twin chain and reads back the fund timelock's `EXECUTOR_ROLE` holder set, closing the limitation above (owner: tests).
2. Reconcile the `RS-1019-14` ledger disposition with the now-present deploy guard, distinguishing "new deploys enforced" from "live register migrated" (owner: security/docs).
3. Carry the `accepted-with-rationale` RB-1022 release-tooling items into the release owner's pre-flight checklist; none blocks this pin but they remain live conventions (owner: operations).

No production code, canonical documents, issues, or external state were modified during this review.
