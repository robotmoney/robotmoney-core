# Security review — release-0.9.0 — LANE 4

Consensus receipt, vault registry, feature flags, exclusion ledger.

## Scope and pin

| field | value |
|---|---|
| repository | `git@github.com:robotmoney/robotmoney-core.git` |
| tracker backend | `github` |
| issue_number / pr_number | `none` / `none` |
| branch (review) | `review/security-release-0.9.0-20261117` |
| pinned commit | `d4a43e6d21efed208816698d2b32f0decea45451` |
| reviewed_at | `2026-11-17` (UTC) |
| branch under review | `release-0.9.0` |
| `origin/release-0.9.0` | `ffc5e4b0d2f9c09cca9e0f8308898eb3c4adbf92` — 2 commits behind the pin; **no evidence from it was mixed in** |
| worktree | `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/adhoc-20261117-145601` |
| worktree state at pin | clean; HEAD verified as above; principal checkout untouched |

**Scope.** "System smart contracts" means production Solidity under `contracts/`, excluding `contracts/test/**` and `contracts/doc/**`. Lane 4 covers: `ConsensusRecommendationReceipt.sol`, `interfaces/IConsensusRecommendationReceipt.sol`, `VaultRegistry.sol`, `FeatureFlags.sol`, `ExclusionLedger.sol`, `interfaces/IUpstreamMonitor.sol`, plus their consumed seams in `RouterGovernance.sol`, `PortfolioRouter.sol` and `RobotMoneyVault.sol` (read only). Canonical documents read: `docs/architecture.md` §4.8–§4.9 and adjacent receipt material; `tests/fixtures/consensus-receipt.schema.json`; `tests/fixtures/consensus-receipt.canonicalization.json`; `docs/development/false-green-shapes.md`; prior artifact `docs/code-review/20261015-review-security-claude.md`.

**Exclusions.** Off-chain assembler/canonicalizer code in sibling repos, the explorer indexer, the dapp, deploy/broadcast scripts, signing keys and key custody, gateway-specific authorization, and the adapter/strategy implementations. These are separate lanes or separate repositories; their absence here is a limitation, not an assertion that they are safe.

**Repository instructions discovered.** `/drive2/home/lucas/superfield/prompts/AGENTS.md` (session environment check, worktree-only work, test-coverage invariants), `~/.agents/skills/_shared/review-contract.md`, `review-tests/SKILL.md`, `review-security/SKILL.md`, `test-coverage-policy.md`.

## Headline verdict

**No security findings survived adversarial refutation in Lane 4 at the pinned commit (0 findings; cap 8).** The lane's authority boundaries, digest binding, receipt-apply ordering, registry status/eligibility interlocks, exclusion claim accounting and the flag library's lack of on-chain state are each backed by executed assertions. Two residual design limitations are recorded under **Limitations** rather than published as findings because neither is triggerable by an untrusted actor and neither produces a wrong or falsely-verified state.

Observed facts vs inference: contract guards, test names, CI step names and line numbers below are **observed**. Impact statements about a hypothetical trusted-role compromise or an off-chain consumer that ignores the digest are **reviewer inference**, explicitly labelled where used.

## Severity summary

| severity | count | confidence distribution |
|---|---|---|
| critical | 0 | — |
| high | 0 | — |
| medium | 0 | — |
| low | 0 | — |
| info | 0 | — |

Merge-blocking findings: **none**. Nothing was withheld pending a higher-confidence judgement; every candidate below was affirmatively refuted.

## Methodology

1. Pinned the worktree and verified it clean before any analysis; confirmed the two-commit divergence of `origin/release-0.9.0` and excluded it from evidence.
2. Resolved canonical requirements (architecture §4.8/§4.9, receipt schema and canonicalization contract) before reading implementations. Missing documents would have been recorded as evidence, not replaced by assumptions.
3. Mapped trust boundaries: untrusted-ish submitter role → receipt register; timelock/WEIGHT_SETTER → `applyReceipt`; ADMIN/timelock → registry; vault-only writer → ledger; permissionless readers → ledger claims; pure library → flags.
4. For each invariant, located an **executed** assertion. Per the review-tests method, compilation, lint, NatSpec, doc-grep, JSON parsing and skipped tests were not accepted as coverage. Named Foundry tests are cited only where the workflow actually runs them.
5. Ran an explicit **n-order composition check** across lane boundaries (see "Composition checks" below), not just pairwise function reads.
6. Adversarially refuted each candidate; a candidate survived only with observed evidence of a wrong or falsely-verified state reachable without a trusted-role compromise.
7. Evaluated the repository's published false-green catalogue by stable shape name.

## Findings

**No `FINDING L4-NN` entries.** No candidate met the bar of (a) an observable wrong or falsely-verified state, (b) reachable by anyone or an author rather than only a compromised admin/timelock, and (c) not already refused by an executed assertion. The refutations are recorded below so the coordinator can see what was considered.

### Refuted candidates (not findings)

#### R-1 — `computeReceiptId` delimiter ambiguity / receipt-id collision

- **Hypothesis.** `computeReceiptId` uses `abi.encodePacked` with `"\n"` separators; if `sessionId` or `subjectId` could contain `"\n"`, two different (session, subject) pairs could share a preimage and collide on `receiptId`.
- **Refutation (observed).** The domain is `robotmoney:consensus-receipt-id:v1\n` (`contracts/ConsensusRecommendationReceipt.sol:85`) and the hash is `keccak256(abi.encodePacked(RECEIPT_ID_DOMAIN, sessionId, "\n", subjectId))` (`...:236-242`). `session_id` is pinned to a fixed 36-character lowercase UUID pattern (`tests/fixtures/consensus-receipt.schema.json:25-28`) and `subject_id` to `^[a-z0-9][a-z0-9_-]{0,127}$` (`...:30-33`); neither admits a newline, so the delimiters are unambiguous over every accepted input. The derivation is additionally pinned by `tests/fixtures/consensus-receipt.canonicalization.json:6-10` and executed by `testComputeReceiptIdMatchesCanonicalizationContract` (`contracts/test/ConsensusRecommendationReceipt.t.sol:462`), which CI runs in the named Fusion evidence step (`.github/workflows/suite-01-02-forge-tests.yml:194-200`). Separately, `recordReceipt` does not call `computeReceiptId` at all — the submitter supplies `receiptId` directly (`...:155-183`) — so no on-chain path derives identity from attacker-shaped strings.
- **Verdict.** Refuted. No collision reachable through accepted inputs.

#### R-2 — Receipt URI/digest trust: URI could serve bytes that do not match the anchored digest

- **Hypothesis.** A submitter records a digest and a URI independently; the contract never fetches the URI, so a mismatch could make consumers act on substituted payload bytes.
- **Refutation (observed).** `recordReceipt` stores both as an append-only commitment (`contracts/ConsensusRecommendationReceipt.sol:155-183`); the design is explicitly **signalling only** — no treasury spend, no weight mutation, no ERC-20 surface, no call into vault or router (`...:29-32`, `:244-252`), enforced by `testSignallingOnlyBoundary` (`contracts/test/ConsensusRecommendationReceipt.t.sol:398`). The digest is a consumer obligation, stated as such: the canonicalization contract pins bytes rather than a digest constant and says the consumer must compute and assert keccak256 (`consensus-receipt.canonicalization.json:121`). `applyReceipt` compares the caller's `payloadDigest` to the stored one byte-for-byte before any effect (`contracts/RouterGovernance.sol:188-190`).
- **Reviewer inference (impact).** An off-chain consumer that acts on URI content without recomputing the digest could be misled. That is a defect in that consumer, outside Lane 4, and the on-chain record remains correct. No on-chain state is made wrong or falsely verified.
- **Verdict.** Refuted for this lane; carried as a consumer-side limitation below.

#### R-3 — Analyst signatures never verified on-chain

- **Hypothesis.** The register stores no per-analyst signature verification, so a receipt could be recorded without analyst consent.
- **Refutation (observed and documented).** This is the settled design, not an omission: EVM has no Ed25519 precompile, `ADR-0012 §5` closes the seam, and the contract states the chain proves committee production plus one submitter attestation — never that each named analyst signed (`contracts/ConsensusRecommendationReceipt.sol:33-38`). Signatures are payload data verified off-chain under the schema's `verifier_invariants` (`consensus-receipt.canonicalization.json:107-118`), including the low-order Ed25519 point screen at `:112` and the explicit scope note at `:117-118` that `verified` attests to a key, not a person. Golden anchoring paths are executed by `testAnchoringPathSubmitsTheGoldenDigest`, `testAnchoringPathSubmitsTheEscapingGoldenDigest` and `testGoldensAnchorDistinctDigests` (`ConsensusRecommendationReceipt.t.sol:485,531,553`).
- **Verdict.** Refuted; out of scope by canonical decision.

#### R-4 — Same-second `recordedAt` allows out-of-order receipt application

- **Hypothesis.** `recordedAt = uint64(block.timestamp)` has second precision; two receipts in one second share a value, so ordering could be inverted.
- **Refutation (observed).** `applyReceipt` requires strictly `r.recordedAt > lastAppliedRecordedAt` and updates the cursor before both external calls (`contracts/RouterGovernance.sol:191-196`). With equal timestamps, whichever receipt applies first sets the cursor and the other is refused — the guard errs toward applying **at most one** same-second receipt, never two out of order. Executed refutation tests: `test_applyReceipt_outOfOrderOlderReverts` (`:351`), `test_applyReceipt_sameRecordedAtRefused` (`:379`), `test_applyReceipt_inOrderStillApplies` (`:398`) in `contracts/test/RouterGovernanceApplyReceipt.t.sol`, run by the named CI evidence step (`.github/workflows/suite-01-02-forge-tests.yml:194-200`).
- **Reviewer inference (residual).** Safe, but liveness-limiting: one of two same-second receipts can never be applied. Recorded under Limitations as a design property, not a finding.
- **Verdict.** Refuted as a safety issue.

#### R-5 — Timelock executor is open, so two ready applies can be reordered

- **Hypothesis.** With a permissionless timelock `execute`, an attacker can choose which of two queued receipt applies lands first.
- **Refutation (observed).** `WEIGHT_SETTER_ROLE` gates `applyReceipt` (`contracts/RouterGovernance.sol:182`) and the monotonic cursor at `:191-193` makes an older apply revert while leaving it unreleased; the whole call reverts atomically, so "a released receipt whose vector was not set" cannot exist (`...:164-169`). `test_applyReceipt_viaSafeAndTimelock` (`:137`) and the out-of-order tests above execute the path. Narrow role separation is executed too: `test_governanceHoldsOnlyTheReleaseRoleOnTheReceipt` (`:276`), `test_weightSetterRoleIsSelfAdministered` (`:301`).
- **Verdict.** Refuted.

#### R-6 — Stale receipt vector applied after a vault loses eligibility/Active status

- **Hypothesis.** A receipt recorded when a vault was eligible could later be applied after that vault is retired or made ineligible, directing deposits to a dead leg.
- **Refutation (observed).** `applyReceipt` calls `router.setWeights` in the same transaction (`contracts/RouterGovernance.sol:195-196`); `setWeights` re-validates **at execution time** that every leg is nonzero, registered, Active **and** router-eligible, non-repeated, and sums to 10 000 bps (`contracts/PortfolioRouter.sol:497-515`, with `_requireActiveAndEligible` at `:511` and `_requireNotRepeated` at `:512`). Any refusal reverts the whole apply, including the release. Executed: `test_duplicateVault_revertsOnSettersAndReceiptPath` (`RouterGovernanceApplyReceipt.t.sol:420`). The registry independently refuses retiring a still-eligible vault (`contracts/VaultRegistry.sol:288`, `:340-342`) and flips eligibility plus default vector atomically (`:436-460`).
- **Verdict.** Refuted.

#### R-7 — `recordReceipt` / `releaseReceipt` authorization or role-admin escape

- **Hypothesis.** A hot-key or governance account could record, release, or self-grant receipt roles, or burn a receipt with a standalone release.
- **Refutation (observed).** Submitter role check and `msg.sender` attribution (`contracts/ConsensusRecommendationReceipt.sol:160-165`); releaser role check (`:188`); `ADMIN_ROLE` is held by the timelock and is the sole admin of both receipt roles (`:69-79`, `:111-124`), with migration callable only by the upgrade timelock (`:131-140`). Last-admin floor covers `DEFAULT_ADMIN_ROLE` (`:142-150`). Executed: `testRecordWithoutSubmitterRoleReverts`, `testRevokedSubmitterCannotRecord`, `testOnlyAdminRoleAdministersTheReceiptRoles`, `testAdminRoleHeldByTimelock`, `testReleaseRevertsWithoutTheReleaseRole`, `testGrantRevertsUnlessRoutedThroughTimelock`, `testDoubleReleaseReverts`, `test_receipt_lastAdminFloor_revokeAndRenounceRevert` (`ConsensusRecommendationReceipt.t.sol:141,152,168,228,247,264,301,562`). The prior standalone-release finding (`20261015-review-security-claude.md`, `review-security-023` / L-012) is fixed in the tooling and tests at this pin.
- **Verdict.** Refuted; prior finding not re-reported.

#### R-8 — `ExclusionLedger` claim/sweep fund loss or snapshot corruption

- **Hypothesis.** Permissionless `claim`, `claimAll`, `returnSurplus` or `sweepForeignToken` could pay the wrong party, double-pay, or let a caller steal recovery funds.
- **Refutation (observed).** All state writes (`open`, `credit`, `finalize`, `checkpoint`) are `onlyVault` (`contracts/ExclusionLedger.sol:171-174`, `:193-250`). `claim` is permissionless but always transfers to `holder`, updates `claimed`/`claimedUsdc`/`heldUsdc` before the external transfer (checks-effects-interactions), and zeroes out when nothing is owed (`:260-268`). `claimAll` only loops `claim` (`:273-278`); any out-of-gas grief is paid by the caller and each holder can claim individually. `returnSurplus` sends only the balance above `heldUsdc` to the vault (`:330-337`); `sweepForeignToken` protects USDC and the share token and sends elsewhere to the governed quarantine (`:342-349`). Snapshots are written by the vault **before** `super._update` (`contracts/RobotMoneyVault.sol:824-828`), so same-block exits keep their claim; `balanceAt` uses the OZ ERC20Snapshot binary-search pattern (`ExclusionLedger.sol:286-300`). Executed assertions include pro-rata claims, exiter-keeps-claim, later-depositor-has-none, `claimAll`, and surplus behaviour in `contracts/test/RobotMoneyVault.t.sol:970-1104` and `contracts/test/SecurityReviewRecheckVaultPoc.t.sol:101-107,361-436`, all inside the whole-suite run.
- **Verdict.** Refuted.

#### R-9 — `VaultRegistry` status/eligibility interlock bypass

- **Hypothesis.** A vault can be retired while still router-eligible, or its deposit-halt flag can drift from registry status, stranding the default vector or accepting deposits into a "retired" vault.
- **Refutation (observed).** `retire` and `setVaultStatus(_, Retired)` both revert `RetireWhileRouterEligible` (`:288`, `:340-342`); `setVaultStatus` drives the vault hook directly so a failure propagates instead of recording a false Retired state (`:331-364`); `setRouterEligible` enforces `StaleDefaultWeightsLength`, `migrateEligibility` preserves length atomically, and `setRouter` blocks the unlink bypass (`:381-408`, `:436-460`, `:473-482`). All are `ADMIN_ROLE`-only (timelock in production). Executed coverage exists in `contracts/test/VaultRegistry.t.sol` for authority, retire and stale-length paths (file is included in the whole-suite `forge test` at `.github/workflows/suite-01-02-forge-tests.yml:158-161`).
- **Verdict.** Refuted.

#### R-10 — On-chain feature-flag TOCTOU / flag-gated timing surface

- **Hypothesis.** A flag flip mid-transaction could change gateway or registry behaviour and produce a wrong state.
- **Refutation (observed).** `FeatureFlags` is a pure bitmap library with no storage and no production Solidity importer: the only `.sol` references at this pin are the library itself (`contracts/FeatureFlags.sol:17`), its test (`contracts/test/FeatureFlags.t.sol:7-103`), a doc comment in `contracts/interfaces/IUpstreamMonitor.sol:24`, and a path string in `contracts/test/CustodyInvariantGuard.t.sol:31`. No production contract reads a flag, so no on-chain timing surface exists.
- **Verdict.** Refuted; see Limitations for the off-chain-only scope of this component.

## Composition checks (n-order)

These cross more than two components; pairwise reading would not expose them.

1. **Newer receipt + stale vector + registry churn.** `applyReceipt` (digest match, released flag, monotonic timestamp) → `releaseReceipt` → `PortfolioRouter.setWeights` (registered + Active + eligible + unique + sum). If any registry leg changed after recording, the final re-validation reverts the entire transaction, including the release. Evidence: `contracts/RouterGovernance.sol:183-196`; `contracts/PortfolioRouter.sol:497-515`; `contracts/VaultRegistry.sol:288,340-342,436-460`; executed by `RouterGovernanceApplyReceipt.t.sol:351,379,398,420`. **No wrong state survives.**
2. **Two ready applies + permissionless timelock execute.** Only the strictly-newer `recordedAt` can apply; the loser stays unreleased and its vector is never written. Evidence: `contracts/RouterGovernance.sol:191-196`; executed by the out-of-order and same-timestamp tests above.
3. **Retire ordering + default vector length + eligibility count.** Retiring an eligible vault is refused before any status change; the eligibility/count/default-vector triple is preserved by `setRouterEligible`, `migrateEligibility` and `setRouter`. Evidence: `contracts/VaultRegistry.sol:381-408,436-460,473-482`.
4. **Exclusion snapshot + withdrawal + later recovery.** Vault checkpoints both parties before `super._update`; the ledger computes `claimable` from `recoveredUsdc * balanceAt(id) / snapshotSupply` minus already paid. An exit during exclusion neither loses nor duplicates the claim; a later depositor has none. Evidence: `contracts/RobotMoneyVault.sol:824-828`; `contracts/ExclusionLedger.sol:260-268,286-313`; executed in `RobotMoneyVault.t.sol:1001-1104`.
5. **Flags + gateway/registry gating.** No composition exists: no production contract imports `FeatureFlags` (verified by search above), so a flag cannot participate in an on-chain state transition.

## Test-execution evidence

Observed, not inferred: `.github/workflows/suite-01-02-forge-tests.yml` is the primary gate. The whole-suite step at `:148-161` runs `forge test -vvv` over the unit tree, which includes the four lane test files cited here. Fusion evidence files are additionally run one-by-one through `.github/scripts/forge_test_require_executed.sh` at `:194-200` — including `ConsensusRecommendationReceipt`, `RouterGovernanceApplyReceipt` and `AccessRoles` — so a path filter matching nothing reads red rather than green. Other named steps use explicit executed-test floors (`FORGE_TEST_MIN_EXECUTED`, e.g. `:167-189`, `:295-296`), and the invariant job uses the same wrapper (`:392-445`). The wrapper's own empty-match self-test is executed at `:444-445`. Per the review-tests method, none of the cited coverage claims rest on `forge build`, lint, NatSpec, doc-grep or JSON parsing alone. **CI logs and run artifacts were not inspected** — this is workflow-config evidence that the tests are wired to run, not proof of a specific green run at the pin (see Limitations).

## Clean areas

- **Receipt write authority and immutability.** Role-gated one-shot record, zero-value checks, duplicate-ID refusal, append-only storage and non-reentrant writes: `contracts/ConsensusRecommendationReceipt.sol:155-183`; executed by `ConsensusRecommendationReceipt.t.sol:134-228`.
- **Receipt release authority and role narrowness.** Releaser-only release, unknown/released refusal, last-admin floor, timelock-only admin and migration: `...:186-202,131-150`; executed by `ConsensusRecommendationReceipt.t.sol:247-310,562-579` and `RouterGovernanceApplyReceipt.t.sol:276,301`.
- **Receipt-id derivation.** Domain-packed hash with schema-pinned, newline-free inputs: `...:85,236-242` plus `consensus-receipt.schema.json:25-33`; executed by `ConsensusRecommendationReceipt.t.sol:462`.
- **Apply ordering and digest binding.** `contracts/RouterGovernance.sol:177-199`; executed by `RouterGovernanceApplyReceipt.t.sol:200-245,351-398`.
- **Router weight validation at execution.** `contracts/PortfolioRouter.sol:497-530`; executed by the apply-path tests including `:420`.
- **Registry authority and interlocks.** `contracts/VaultRegistry.sol:239-254,280-305,331-364,381-482`; executed by `contracts/test/VaultRegistry.t.sol` in the whole-suite run.
- **Signalling-only receipt boundary.** `contracts/ConsensusRecommendationReceipt.sol:29-32,244-252`; executed by `ConsensusRecommendationReceipt.t.sol:398`.
- **Exclusion accounting and token quarantine.** `contracts/ExclusionLedger.sol:171-174,260-278,330-349`; executed in `RobotMoneyVault.t.sol:970-1104` and `SecurityReviewRecheckVaultPoc.t.sol`.
- **Feature flags.** Pure library, no storage, no production importer; behaviour executed in `contracts/test/FeatureFlags.t.sol:16-103`.
- **`IUpstreamMonitor.sol`.** Stub interface only; no implementation or state in this lane, so no attack surface to report.

## checked_shapes

Catalogue resolved from `docs/development/false-green-shapes.md` (present at the pin, so `none-published` does not apply). Stable names evaluated and ruled out for Lane 4:

| shape | how evaluated | verdict |
|---|---|---|
| `digest-blind-to-attribute` | `applyReceipt` compares the full 32-byte `payloadDigest`, not a partial/type-only digest (`contracts/RouterGovernance.sol:188-190`); canonicalization pins every signed attribute in the canonical bytes (`consensus-receipt.canonicalization.json:28-52,107-118`). The on-chain anchor omits no runtime-relevant attribute. | ruled out |
| `missing-evidence-script` | The named evidence scripts (`.github/scripts/forge_test_require_executed.sh`, `.github/scripts/tests/test_forge_test_require_executed.sh`) exist at the pin and are invoked by `suite-01-02-forge-tests.yml:194-200,444-445`. | ruled out |
| `uninvoked-evidence-script` | `forge_test_require_executed.sh` is invoked by the Fusion evidence step, the upgrade/retire steps and the invariant steps of the same workflow (`:167-189,194-200,392-445`); the lane's test files are reached by the whole-suite step at `:158-161`. | ruled out |
| `optional-fixture-early-return` | Lane tests are Solidity Foundry tests using `assert*`/`vm.expectRevert`, not `Option`/`None`-returning fixtures with early-return guards; no such sentinel was found in the cited lane test files. | ruled out |
| `artifact-guard-runs-before-build` | No `existsSync`/`Path.exists`-style guard over a build artifact was found in the lane tests; the one build-order dependency in the primary workflow is the ABI drift job (separate lane) and the forge steps install and build before testing (`:130-146`). | ruled out |
| `starved-guard-input` | Workflow-level floors are present and the wrapper's own empty-match self-test runs (`:444-445`). The internal parsing of `forge_test_require_executed.sh` was **not** re-audited this pass; see Limitations. | partially evaluated — not claimed as ruled out |

## Limitations

1. **No CI logs or run artifacts inspected.** Execution claims are from workflow configuration and test source at the pin, not from a specific green run. Absence of a red gate for the pinned commit was not independently verified.
2. **Off-chain surfaces unreviewed.** The assembler/canonicalizer, `verifyReceipt` consumers, Ed25519 verification (including small-order point screening), low-order point table, URI hosting/censorship behaviour and the `digest_note` consumer obligation (`consensus-receipt.canonicalization.json:121`) live in other repositories or layers. The on-chain register cannot detect a consumer that ignores the digest.
3. **Prior review findings marked fixed were re-checked by search and targeted tests only.** The `review-security-023` / L-012 standalone-release issue appears fixed in the pinned tooling and tests; a full exploit replay of the govern CLI was outside this lane.
4. **Same-second `recordedAt` is a liveness limitation, not a safety finding.** At most one of two receipts recorded in the same second can ever be applied (`contracts/RouterGovernance.sol:191-193`; executed by `RouterGovernanceApplyReceipt.t.sol:379`). No fix proposed here.
5. **Registration does not check code.** `VaultRegistry.registerVault` accepts any nonzero, unregistered address (`contracts/VaultRegistry.sol:239-254`). `retire`/`reactivate` call the vault hook unconditionally (`:290`, `:303`) while `setVaultStatus` uses an empty-code guard (`:355-361`). Reaching the inconsistency requires the ADMIN/timelock to register a non-contract address; no untrusted path exists, so it is not published as a finding. Flagged for the registry lane owner as a consistency observation.
6. **FeatureFlags is off-chain-only at this pin.** No production Solidity consumer; its security depends entirely on off-chain tooling outside this lane.
7. **Fuzz/invariant depth not re-measured.** Stateful invariant jobs are wired and gated (`.github/workflows/suite-01-02-forge-tests.yml:392-445`), but seed-specific outcomes and coverage percentages were not re-run locally.
8. **`starved-guard-input` residual.** The internals of `forge_test_require_executed.sh` were not re-audited; the workflow floors and self-test were observed but the wrapper's failure modes were not proven red-before here.

## Recommended actions

No code changes are required by this review. The two residual items under Limitations (same-second liveness; registration code check) are candidates for the registry/receipt lane owner to accept explicitly or track separately. Consumers of the on-chain anchor outside this repository should verify the recomputed keccak256 digest before relying on URI content.

## Documentation changes

None required. The design decisions that refuted candidates R-2, R-3 and R-4 are already recorded in `docs/architecture.md` §4.8–§4.9, `ADR-0012 §5`, the contract NatSpec and the canonicalization contract.

## Unresolved decisions

None. No ambiguity required a default during this review.

**Summary:** Zero security findings survived refutation in Lane 4 at the pinned commit; the authority, ordering, registry and exclusion invariants are backed by executed Foundry assertions, with only liveness and off-chain-scope limitations recorded.
