# Security review: system smart contracts, release-0.9.0 (2026-11-17)

## Scope and pinned commit

- **Repository:** `git@github.com:robotmoney/robotmoney-core.git` (API writes use `robotmoney/robotmoney-monorepo` per `CLAUDE.md`).
- **Branch under review:** `release-0.9.0`.
- **Reviewed commit:** `d4a43e6d21efed208816698d2b32f0decea45451` ("Verify prior Deploy 4 upgrade builds").
- **Stated default on divergence:** local `release-0.9.0` is two commits ahead of `origin/release-0.9.0` (`ffc5e4b0d2f9c09cca9e0f8308898eb3c4adbf92`); the local head is the review pin and no evidence from the origin-only or later commits was mixed in. The two extra commits are `f25f77faf` and `d4a43e6d2`.
- **Work branch / worktree:** `review/security-release-0.9.0-20261117` at `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/adhoc-20261117-145601`; principal checkout left clean and on `dev`.
- **Reviewed at:** 2026-11-17 (UTC). **Tracker backend:** `github`; adhoc review, no issue or PR, no plan work.
- **Scope:** production Solidity under `contracts/` — core contracts, `gateway/`, `vaults/`, `adapters/`, `lib/`, `interfaces/` and `script/` — plus the tests, CI wiring, prior review artifacts and canonical documents those files implicate. `contracts/test/**` and `contracts/doc/**` were read as evidence, not as implementation scope.
- **Canonical references:** `docs/architecture.md` (§2, §4, §5.2, §6, §8), `docs/prd.md` custody and receipt material via architecture §8, accepted ADRs (ADR-0004, ADR-0012, ADR-0014), `docs/audits.md` disposition ledger, `docs/development/false-green-shapes.md`, `docs/development/test-coverage-policy` via the shared review contract, `tests/fixtures/consensus-receipt.*`, and prior snapshots under `docs/code-review/`, chiefly `20261015-review-security-claude.{md,json}`.
- **Repository instructions applied:** global Superfield agent contract (worktree isolation, read-only principal checkout, mandatory delegation), `CLAUDE.md`, the shared review contract and severity rubric, and the `review-security` skill's adversarial method.
- **Exclusions:** off-chain dapp, `rmpc`, explorer indexer/API and watchdog, the off-chain receipt assembler and verifier, third-party protocols, the devops repository, GitHub settings, signing-key custody and live chain state.

## Headline verdict

**No contract security finding survived adversarial refutation in any of the five lanes at the pinned commit. Merge-blocking findings: none.** A follow-up deep-dive promoted one medium, non-blocking test-coverage finding: the fund timelock's Safe-only executor requirement has no executed-in-CI assertion. Every contract candidate was traced to a concrete guard, tested state transition, fail-closed path or deployment constraint, or was bounded to a trusted-role prerequisite and left as an advisory.

The prior 2026-10-15 security review's findings were re-checked by disposition and targeted code search: the contract findings are fixed at this commit and are not re-reported. The acceptance-level items (`RB-1022-*`, `SR-1012-V4`, `RS-1019-14`) remain `accepted-with-rationale` in the canonical ledger and are carried forward, not re-asserted. The deep-dive confirmed `RS-1019-14` is still Open in the deployed v0.5.0 register; the new deploy scripts only enforce the target shape for new deployments.

Evidence discipline: guards, test names, CI steps and line numbers are **observed facts**. Impact statements about hypothetical trusted-role compromise, pool-depth economics or late receipt application are **reviewer inference** and are labelled as such. This review executed 54 upgrade/deploy tests, 12 receipt-ordering tests, 44 registry tests and the evidence wrapper's seven self-tests, all with zero skips; no PR-time CI log was replayed.

## Severity Summary

| Severity | Count | Key areas |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 1 | Fund timelock Safe-only executor has no executed-in-CI assertion |
| Low | 0 | — |

## Methodology

1. Pinned the worktree to the local release head, verified `HEAD` and that the principal checkout stayed clean, and excluded origin-only commits from all evidence.
2. Resolved canonical requirements before reading implementations: architecture guardrails and trust boundaries, the audit ledger's dispositions, the false-green catalogue and the receipt canonicalization contract. Missing documents would have been recorded as evidence rather than invented.
3. Dispatched five independent workers in one concurrent batch, each with an explicit absolute worktree path and a disjoint lane: (1) gateway, roles, governance and upgrade authority; (2) vault family, custody, accounting and redemption; (3) router, basket swaps, adapters and oracles; (4) consensus receipt, registry, feature flags and exclusion ledger; (5) deploy/upgrade scripts, prior findings, test evidence and cross-lane composition.
4. Each worker mapped assets, authoritative state, trust boundaries, entry points, identities, roles, custody, recipients and allowances; enumerated authority transitions; traced cross-seam data and asset flows; and tested replay, reentrancy, ordering, timing, stale-state, privilege composition, oracle, accounting, lifecycle, denial-of-service and griefing hypotheses.
5. Every candidate was adversarially refuted against the actual guards, modifiers, state transitions, tests and deployment constraints. Workers defaulted to refuted where a path could not be confirmed from code. Unreachable prerequisites and speculative hardening were not promoted to findings.
6. Each lane ran at least one n-order pass combining two or more individually-safe seams; lane 5 ran four. Lane 5 additionally executed the embedded `review-tests` method.
7. The coordinator collected the lane reports, checked their pins and evidence, and validated the paired artifacts with the repository's own checkers.

## Findings

The first pass promoted no finding. A follow-up deep-dive, run over the residual advisories and evidence limitations, promoted one test-coverage finding. It is advisory and does not block the release. The refuted candidates are retained below so a second reviewer can reproduce the reasoning rather than treating a partial verdict as an absence of work.

Heading `### N.` is finding `review-security-NNN` in the JSON summary and row `SR-1117-N` in the `docs/audits.md` finding register. The medium finding also carries the index used in the Severity Summary.

### 1. Medium — The fund timelock's Safe-only executor requirement has no executed-in-CI assertion

#### SEC-M-001 (review-security-001)

- **Where:** `contracts/script/DeployFundTimelock.s.sol:141-203` — `_check(d)` contains the Safe-only-executor `require`s at `:146-153`.
- **Class / confidence:** `TEST_COVERAGE_GAP` / high.
- **Severity / owner:** medium, advisory and non-blocking / tests.
- **Ledger row:** SR-1117-1.

**Scenario.** `DeployFundTimelock.run()` executes the on-chain assertion that the fund timelock's `EXECUTOR_ROLE` is held by the configured Safe, is not held by `address(0)`, and is not held by the deployer. No CI job executes that path. `.github/workflows/suite-28-core-stages.yml:142-159` publishes the Twin rehearsal with `vaults-only: "true"` and `gateway: "true"` only; `.github/workflows/suite-01-02-forge-tests.yml:736-746` explicitly skips `contracts/script/DeployFundTimelock.s.sol` in coverage; and `.github/workflows/suite-13-doc-checks.yml:506-514` validates the QA runbook structurally without executing a step against a chain. The three checks that do run are orthogonal to the on-chain role state: `contracts/test/UpgradeAuthorityPrediction.t.sol:28-72` checks CREATE2 address prediction, `scripts/ci/check-timelock-prediction-parity.ts:27-45` recomputes that prediction in TypeScript, and `publish-contracts/src/verify/fund.ts:240` reads the manifest string that the deploy script itself writes. A regression in the fund handover could therefore leave CI green with only the deploy-time `require` and human QA runbook to catch it.

**Impact and mitigation.** Assertion integrity: the property is not proven by an executed CI assertion. No wrong artifact was observed and the deploy-time `require` plus the QA runbook's on-chain readback fail loudly before or at deploy, so release integrity is not harmed and the finding stays below the merge-blocking line. Trigger is an author with write access; the failure is safe at the deploy/QA layer, so the fails-safe downgrade applies with no cancelling escalator.

**Recommendation.** Add a bounded CI job (in the suite-28 Twin family or on a blank anvil) that deploys the fund stages, executes `DeployFundTimelock.run()`, and reads back `EXECUTOR_ROLE` with a non-zero executed-test floor so a starved run goes red. Until then, carry the item on the release owner's pre-flight checklist. Do not treat prediction, parity or manifest-string checks as closing this specific gap.

**Related.** First-pass recommendation 1 and the limitation on fund deploy runtime checking; `docs/audits.md` release-tooling items are separate.



## Low-Severity Findings

None. No low-severity rows were promoted at this pin.

### Refuted candidates by lane

#### Lane 1 — gateway, roles, governance, upgrade authority

- Commit/reveal front-running and consent reuse: commitments are committer-keyed and single-use with a one-block delay and 256-block expiry (`contracts/gateway/RobotMoneyGateway.sol:416-443`); agent consent binds `msg.sender` plus `keccak256(msg.data)` and is single-use and expiring (`:452-461`).
- Rolling-window boundary burst: a single in-memory policy snapshot feeds `_accrueRollingDeposit` (`:593-661`), and `GatewayWindows.accrue` uses strict `(t-WINDOW_SECONDS, t]` expiry (`contracts/lib/GatewayWindows.sol:48-89`).
- Role-separation escalation: all public role paths deny `AGENT_ROLE` and cross-tier overlap is rejected (`contracts/gateway/AccessRoles.sol:57-115`); last-admin and last-proposer floors cover revoke and renounce (`RobotMoneyGateway.sol:316-326`, `AdminFloorAccessControl.sol:50-55`, `ProposerFloorTimelock.sol:77-83`).
- Receipt replay/out-of-order, frozen reinitializer and wrong-target freeze: monotonic watermark and digest binding (`contracts/RouterGovernance.sol:177-199`); one-way freeze, maxed initializer version and implementation-plus-codehash binding (`contracts/lib/GovernedUUPS.sol:123-158`).

#### Lane 2 — vault custody, accounting, redemption

- Share inflation and first-depositor attack: 18-decimal virtual-share offset on both vault families and `+1` denominators make donation cost scale with `10^18` (`contracts/RobotMoneyVault.sol:502-528,584-585`, `contracts/vaults/BasketVault.sol:513-518`).
- Fee underflow and `withdraw(maxWithdraw)` revert: net/gross conversions use opposed rounding and realised proceeds are clamped (`RobotMoneyVault.sol:655-678,732-739,773-819`); asserted by `contracts/test/ERC4626PreconditionChecks.t.sol:77-150`.
- Refusing venue, shortfall and silent under-pay: balance-delta arithmetic cannot underflow and under-delivery reverts (`contracts/lib/RobotMoneyVaultOps.sol:910-924,421-466`).
- Quarantine bypass: governed destinations only, with active and configured-inactive basket assets protected (`RobotMoneyVault.sol:1294-1324`, `BasketVault.sol:1360-1390`, `ForeignTokenQuarantine.sol:75-101`).
- Exclusion recovery, reabsorb of deactivated assets, in-kind payout and redeem gas floors: each traced to snapshot-before-update accounting, permissionless reabsorption with TWAP bounds, burn-first nonReentrant payment and pre-state gas floors (`ExclusionLedger.sol:217-313`, `BasketAssetConfigGuard.sol:227-308`, `RobotMoneyVault.sol:420-428`, `BasketVault.sol:378-385`).
- UUPS storage drift: CI compares per-variable label, slot, offset, type, libraries and namespaces against committed and released layouts with a mutation self-test (`.github/workflows/suite-01-02-forge-tests.yml:215-264`).

#### Lane 3 — router, basket swaps, adapters, oracles

- The initially suspicious two-allowance redeem in `_redeemLeg` is intentional defense in depth: the caller-allowance gate blocks stranger redemptions before any vault call, while ERC-4626 enforces the router's standing allowance (`contracts/PortfolioRouter.sol:1069-1077`; executed by `contracts/test/PortfolioRouter.t.sol:1672-1708`).
- Recorder manipulation: one snapshot per block, per-second tick clamp, one-window staleness fail-closed, and a four-hour sell anchor compose with ORA-4 (`contracts/adapters/UniswapV4PriceRecorder.sol:34-38,107,149-162,211`, `contracts/lib/BasketViews.sol:55-60,113-217`). This mitigation is `accepted-with-rationale` in the ledger and is not re-reported.
- Quarantine catch in `reabsorb`: `msg.sender` is an event parameter only; the destination is the governed quarantine (`contracts/lib/BasketSwaps.sol:172-173`, `ForeignTokenQuarantine.sol:75-101`).
- Stale/unavailable legs are loud: zero-floor legs skip with `LegSkippedWithFloor`, non-zero-floor legs revert; no silent repacking (`contracts/test/PortfolioRouterLegAvailability.t.sol`).
- V4 callback abuse, pool pinning and rounding: PoolManager-only open-state callback with `minAmountOut` and uint128 bounds (`UniswapV4SwapAdapter.sol:144-204`), full PoolKey and hook rejection (`UniswapV4PriceRecorder.sol:112-129`), and direction-aware TWAP rounding used as floors.

#### Lane 4 — receipt, registry, flags, exclusion ledger

- Receipt-id delimiter ambiguity: schema fixes session and subject to newline-free patterns, and `recordReceipt` takes the id from the submitter rather than deriving it (`contracts/ConsensusRecommendationReceipt.sol:85,155-183,236-242`; `tests/fixtures/consensus-receipt.schema.json:25-33`).
- URI/digest divergence and unsigned analyst signatures: the register is signalling-only and append-only, and off-chain verifier obligations are canonicalized (`ConsensusRecommendationReceipt.sol:29-38,244-252`, `consensus-receipt.canonicalization.json:107-121`).
- Receipt authorization, out-of-order application and stale vector application: role-gated record/release, digest binding, monotonic watermark and execution-time router revalidation of Active/eligible/unique legs (`RouterGovernance.sol:177-199`, `PortfolioRouter.sol:497-530`, `VaultRegistry.sol:288,340-342,436-460`).
- Exclusion claims and registry interlocks: vault-only state writes, claims that always pay the holder, checkpoints before `_update`, and retirement refused while router-eligible (`ExclusionLedger.sol:171-174,260-313,330-349`, `RobotMoneyVault.sol:824-828`, `VaultRegistry.sol:280-364`).
- Feature flags are a pure bitmap library with no production Solidity importer, so there is no on-chain timing surface (`contracts/FeatureFlags.sol:17`).

#### Lane 5 — deploy authority, prior findings, test evidence

- Post-broadcast script `_check` ordering: the concrete misconfiguration it guards is rejected before broadcast by the driver (`publish-contracts/src/sheet.ts:601`), and the script-side check is a deliberate named dry-run guard (`contracts/script/DeployTimelock.s.sol:540-552`).
- Adapter metadata length bypass: production adapter bytecode is compiled locally and codehash-pinned, so adversarial bytecode never reaches the guard (`contracts/script/DeployVault.s.sol`).
- Chain-guard read order, rehearsal delay floor and layout-reset labels: the guard primitive has four executed tests, rehearsal kind is sheet-injected, and released-layout comparisons still run (`DeployMainnetInputs.t.sol`, `publish-contracts/src/runner.ts`, `.github/workflows/suite-01-02-forge-tests.yml:251-263`).
- Fund Safe-only executor: prediction vectors, cross-language parity, verifier assertion and on-chain `require` agree; the missing CI execution of the runtime `require` is a limitation, not a demonstrated false green (`contracts/test/UpgradeAuthorityPrediction.t.sol:28-72`, `scripts/ci/check-timelock-prediction-parity.ts:27-45`, `contracts/script/DeployFundTimelock.s.sol:145-153`).

### Composition results

Every composition pass across and within lanes was UNBLOCKED:

1. Agent registration composes owner commit/reveal, calldata-bound agent consent, pairwise role separation and `super`-chained access-control overrides (`RobotMoneyGateway.sol:416-487`, `AccessRoles.sol:95-131`).
2. Upgrade/freeze authority composes timelock-only authorization, write-once `upgradeTimelock`, one-way freeze and the timelock's last-proposer floor (`GovernedUUPS.sol:78-158`).
3. Lifecycle, fee math and router floors compose so retirement/pause/shutdown gate deposits only, withdrawals stay reachable, and real redeemed proceeds feed per-leg floors (`RobotMoneyVault.sol:691-722,787-791`, `BasketVault.sol:719-746`, `contracts/test/WithdrawalsNeverFrozen.t.sol`).
4. Stale recorder, router availability and ORA-4/sell anchor compose fail-closed: a stale leg with a non-zero floor reverts rather than being silently renormalised (lane 3 evidence above).
5. Receipt staleness, registry churn and governance releaser role compose so a vector changed after recording reverts the whole apply, including release (`RouterGovernance.sol:183-196`, `PortfolioRouter.sol:497-515`).
6. Deploy wiring, role grants and deployer clean-out compose to leave the timelock sole admin and the deployer with no standing role (`DeployFundTimelock.s.sol:121-202`, `DeployTimelock.s.sol:540-583,810-831`).
7. CREATE2 authority prediction, on-chain `upgradeTimelock()` read-back and runtime authorization compose into a single upgrade path (`CoreTimelockHandover.sol:156-200`, `UpgradeAuthority.sol:35,77-81`).
8. Fund versus vaults executor modes compose through distinct CREATE2 init code, preventing cross-system authority confusion (`UpgradeAuthority.sol:68-74`, `CoreTimelockHandover.sol:183-195`).

## Clean areas

- Gateway commit/reveal, calldata-bound consent, exact rolling-window accounting and full-intent idempotency keys.
- Role separation, last-admin and last-proposer floors, and pause asymmetry (deposits only; no withdrawal path through the gateway).
- Vault share accounting with virtual-share offsets, realised-NAV minting, conservative round directions and bounded exit fees.
- Custody invariants: no arbitrary-recipient rescue, governed quarantine destinations with protected asset sets, and exclusion claims that always pay the holder.
- Oracle and venue integrity: per-block recorder snapshots, tick clamp, staleness fail-closed, ORA-3 pool equality, ORA-4 deviation gate, four-hour sell anchor, and codehash and pool pinning.
- Router redeem authorization, loud leg skipping with floors, shortfall reversion, nonReentrant execution and V4 callback state machine.
- Receipt write/release authority, digest binding, monotonic apply watermark, signalling-only boundary and execution-time leg revalidation.
- Registry status/eligibility interlocks and exclusive vault writes to the exclusion ledger.
- Governed UUPS upgrade/freeze authority, one-way freeze with implementation and codehash binding, and CI storage-layout anchoring.
- Deploy-chain guards, expected-chain primitive, CREATE2 authority read-back, Safe configuration checks and cross-language timelock prediction parity.
- CI execution honesty: executed-test floors, loud named fork skips with zero-execution red, and mutation self-tests on layout and evidence guards.

## Recommended actions

One medium advisory finding and six documentation or operational follow-ups; none blocks the release at this pin.

1. Address `review-security-001` by adding an executed CI assertion that calls `DeployFundTimelock.run()` on a local or Twin chain and reads back the fund timelock's executor-role holder set with a non-zero executed-test floor (owner: tests).
2. Correct the stale NatSpec at `contracts/PortfolioRouter.sol:1074-1076` and the `transferFrom` wording at `contracts/gateway/interfaces/IPortfolioRouter.sol:21-22`; the code and tests are correct (owner: code, docs-only).
3. Add one line to `docs/architecture.md` §4.9 "Apply order" recording that equal `recordedAt` values make at most one of the tied receipts applicable, and that re-proposal under a new session and subject is required if the other vector is still wanted (owner: docs or decision).
4. Resolve the `VaultRegistry` hook-call asymmetry at `contracts/VaultRegistry.sol:280-305,322-361` either by adding a code-length guard to `retire` and `reactivate`, or by documenting the fail-loudly intent and correcting the `setVaultStatus` NatSpec (owner: code or decision).
5. Keep `RS-1019-14` Open until a live read or migration record proves the deployed register was migrated; distinguish the enforced new-deploy shape from the live-register state (owner: security/docs).
6. Carry the `accepted-with-rationale` release-tooling items into the release owner's pre-flight checklist; the two local-only commits in the pin partially closed the branch-binding and QA-trigger items (owner: operations).
7. Add a regression test that a forged metadata trailer cannot hide a delegatecall from `AdapterBytecodeGuard`, or document the scanner's locally-compiled-adapter trust model (owner: tests, advisory hardening only).

## Deep-dive addendum (same pinned commit)

A second batch of five workers re-investigated the residual advisories and evidence limitations. Verdicts:

- **Receipt liveness:** advisory. The cap is exact but intentional and documented in `docs/architecture.md:857-865` (issue 1831); only the submitter Safe and timelock can create or apply tied receipts, the apply tooling refuses non-newer receipts before scheduling (`publish-contracts/src/govern.ts:1799-1806`), and the path fails safe. Executed: 12 receipt-ordering tests passed, zero skipped.
- **Registry code-check consistency:** advisory. `retire` and `reactivate` call the hook unconditionally while `setVaultStatus` skips it for code-less addresses (`contracts/VaultRegistry.sol:280-305,355-361`), but registration is timelock-only, every reachable path fails closed, and `PortfolioRouter._requireRouterEligible` rejects code-less legs (`contracts/PortfolioRouter.sol:1427-1445`). Executed: 44 registry tests passed, zero skipped.
- **Test evidence:** the two large test bodies were read in full with no skips, assumptions or subject-mocking; the evidence wrapper clamps its floor to at least one, captures forge's own exit status and has seven passing self-tests; the 54-test run was reproduced exactly. The one promoted item is the finding above.
- **Pin divergence, adapter guard and release tooling:** both local-only commits were read in full and only strengthen gates (`publish-contracts/src/release-gate.ts:359-360`, `publish-contracts/src/evidence-check.ts:1026-1032`); the adapter metadata-length bypass is real in isolation but unreachable because the sole production caller scans freshly compiled on-chain bytecode and pins the codehash after the guard (`contracts/script/DeployVault.s.sol:266-268`); all nine release-tooling items remain accepted advisory conventions.
- **Live state:** every committed Base manifest is rehearsal or Twin, not live; no RPC endpoint is configured. Canon explicitly states the deployed v0.5.0 register grants `RouterGovernance` the receipt admin role (`docs/architecture.md:817,838-842,1808`), so `RS-1019-14` stays Open. No live-state limitation could be closed from repository artifacts.
- **Documentation:** two stale comment lines confirmed at `contracts/PortfolioRouter.sol:1074-1076` and `contracts/gateway/interfaces/IPortfolioRouter.sol:21-22`; neither reaches an operator, runbook or signing-client decision path, so both stay at clarity level. The exclusion of `deadline` from the gateway idempotency key is accurate and still enforced (`contracts/gateway/RobotMoneyGateway.sol:599-601,624-651`).

## Documentation changes

No canonical document change is required by the finding. Recommendations 2, 3 and 5 are documentation-only follow-ups. This review adds its own paired artifact under `docs/code-review/`, keys it in `scripts/check-audit-ledger.sh` and adds one register row in `docs/audits.md`; the temporary exemption used while the review had no findings was removed once the deep-dive promoted a finding and the review could be keyed normally.

## Unresolved decisions

None. The local-head pin is recorded above as a stated default, not an open question.

## Limitations

- Static review at the pinned commit. No fork, devnet or PR-time CI log was replayed; execution evidence is the locally reproduced forge runs (54 plus 12 plus 44 tests, zero skipped) and the evidence wrapper's seven self-tests.
- No CI run for the pinned commit was inspected end-to-end; the no-fund-CI-job conclusion rests on in-tree workflow definitions, which are definitive for code that exists in the repository.
- Live deployment state was not verified: deployed proxy implementations, the live Safe/timelock configuration, whether the deployed receipt register was migrated for `RS-1019-14`, implementation bytecode versus the pin, and freeze state. No RPC endpoint was configured, and the live manifests are operator-machine state outside the checkout.
- No `FORK_RPC_URL` was available. Live pool behaviour, the pool-depth manipulation bound, gas-floor headroom and TWAP window headroom are not proven under future venue or asset-list changes.
- The fund dry-run command was not executed: dependencies, frozen counts for the pin, a committed fund sheet and a bounded human rehearsal are absent. The precise blocker is recorded in the deep-dive report.
- The large 2026-10-15 review and ledger were grepped by finding ID and disposition, not read in full.
- The adapter metadata-length bypass remains theoretical; production adapters are locally compiled and codehash-pinned, but a forged-trailer regression test is not present.
- No formal verification or symbolic execution was performed. Reviewer inference is labelled where used.

## Unreviewed surfaces

- Off-chain `rmpc` signing, client policy and dapp transaction decoding.
- Explorer indexer, explorer API and mint/burn watchdog.
- Off-chain receipt assembler, canonicalizer, Ed25519 verifier, URI hosting and small-order point screening.
- Adapter internal economics and third-party protocol behaviour (Aave, Compound, Morpho, Uniswap, Aerodrome).
- The devops repository, GitHub repository settings and release credentials.
- Runtime reorg and migration behaviour against a live chain.

## checked_shapes

Catalogue: `docs/development/false-green-shapes.md` (present at the pin). Across the lanes and deep-dives, the following were evaluated and ruled out: `digest-blind-to-attribute`, `missing-evidence-script`, `uninvoked-evidence-script`, `optional-fixture-early-return`, `artifact-guard-runs-before-build`, `starved-guard-input` (closed for the forge wrapper: floor clamped to at least one, `PIPESTATUS[0]` captures forge's own status, and seven self-tests include planted zero-match and real-forge empty-match false greens), `trigger-scoped-dead-code` (except the promoted fund-deploy gap), `matrix-tool-absent-step-skipped`, `quoted-path-evasion`, `selftest-env-splice`, `fixture-shape-blind-selftest`, `doc-contradicts-guard-invariant` and `stale-cache-embedded-artefact`. Loud named `vm.skip` in fork tests was checked: skips carry a reason and zero-execution runs are red, so they cannot mask a green guarantee.
