# Security review: QA test-merge branch, three rounds (2026-10-15)

## Scope and pinned commit

- **Repository:** `git@github.com:robotmoney/robotmoney-core.git`
- **Branch:** `qa/test-merge-v1`
- **Commit (HEAD, the pinned base):** `9d9bb854b1f0b7ca5a572242c715ada0fe27ed77`. It is `origin/dev` at `b64464ad` plus QA plan v1 workstreams WF1 to WF3 (`docs/development/qa-plan-v1.md`).
- **Reviewed state:** the working tree, not the commit. Rounds 2 and 3 reviewed the uncommitted fixes of the rounds before them. At report time the tree differs from HEAD by 199 files changed, 15671 insertions(+), 1445 deletions(-), plus 19 untracked paths, counted before this report added its own files and ledger rows. None of it is committed.
- **Reviewed at:** 2026-10-15.
- **Scope:** round 1 covered the whole branch through seven lenses (contracts, upgrade, economics, tooling, indexer, clients, ci). Rounds 2 and 3 covered the files the previous round's fixes changed, plus one whole-system composition pass per lens that combined at least two seams.
- **Assets and trust boundaries in scope:** depositor USDC and vault shares in rmUSDC and the three basket vaults; the exclusion ledger's pro-rata recovery claims; the UUPS proxies, their single timelock upgrade authority and the one-way freeze (ADR-0014); the `ProposerFloorTimelock` and Safe; the EMERGENCY hot key; agent consent on authorize; `applyReceipt` weight provenance; the 8453 release gate and the evidence trail in `publish-contracts`; the indexer, explorer API and watchdog; the dapp and rmpc signing surfaces; CI and the rmpc release supply chain.
- **Out of scope:** third-party protocols (Aave, Compound, Morpho, Uniswap, Aerodrome), the devops repository, GitHub repository settings and live chain state.
- **Instructions applied:** the review contract (`~/.agents/skills/_shared/review-contract.md`) and its severity rubric; the security preamble for this branch (no test runners, compile checks only, no git or GitHub writes); `CLAUDE.md` (default base `dev`).

## Headline verdict

**Do not merge on this review alone.** Three rounds confirmed 78 candidate findings. This report folds 9 cross-lens duplicates into the finding they repeat, which leaves 69: 4 high, 26 medium, 37 low and 2 info.

The working tree carries a fix for 68 of them. One low finding is deferred (review-security-014). No fix has been run by a test: each round ended with a compile sweep only, so every fix needs Phase Q.

The loop did not converge. Round 3 still confirmed 1 high and 4 medium findings, and most of them were gaps in the round 1 and round 2 fixes. The loop stopped at its three-round cap, so the round 3 fixes have had no review round of their own.

Under the severity rubric, the four high findings would block a merge if they were open. All four are fixed in the working tree, so the merge now turns on Phase Q passing and on a fourth review of the round 3 diff.

## Severity Summary

Each phrase names one finding. The phrases follow the finding order below.

| Severity | Count | Key areas |
|---|---|---|
| Critical | 0 | — |
| High | 4 | Actions cache poisoning of the attesting rmpc build, Committed layout snapshot never proven equal to the code, Any writer could mint the rmpc attestation, Per-hour mint query grew quadratically with history |
| Medium | 26 | Attesting release jobs ran actions at mutable refs, aarch64 rmpc leg linked in a mutable cross image, Layout --base anchored to the parent commit, Dapp vault and router pins hashed only the proxy runtime, Dapp router deposits skipped leg implementation checks, Dapp writes never checked the logic behind proxies, rmpc router deposits sent no per-leg floors, rmpc withdraw skipped the router implementation check, Illiquid adapter exclusion needed the 48 h timelock, EMERGENCY force-remove of a healthy adapter repriced exits (SR-1012-5), Paused lending venue no longer stopped rmUSDC deposits, Force-removed excluded adapter re-add sent its balance to NAV, Build proof bound HEAD but not the ignored out/ artifacts, Evidence secret scan missed prefixed secret names, govern resume on a fresh manifest dropped the pause interlock, upgrade-proxy trusted any build directory and skipped the layout compare, No release gate covered upgrade and freeze builds, Upgrade-time layout compare had no enum rule, refs/replace ref passed the 8453 release-tag gate, Layout gate recorded enums by type label only, Layout gate compared against a snapshot the change rewrites, IC policy proxy not watched by the 8453 indexer config, Indexer derived the exclusion ledger address wrongly, Batched gateway deposit hid a direct vault mint, Per-hour volume window had no upper bound in catch-up, Held watchdog cursor starved the stuck-pause replacement |
| Low | 37 | Withdraw tab hid the revoke for an unverified router, Dapp blocked router deposits on any unavailable leg, Config export told operators to pin the live implementation, Dapp exits disabled when gateway verification failed, /health stayed ok after the indexer stopped, /v1/vault/snapshots not bound to the served chain, Swarm preflight checked the wrong IC policy and one role, Committee identity written with umask permissions, rmpc did not name LegSkippedWithFloor, Router reverted when a basket leg failed ORA-4, Router skipped a leg that carried a non-zero floor, RouterGovernance claimed a released receipt is always applied, Lending venue refusing a supply reverted every deposit, Force-removed adapter record could only recover all at once, Morpho exposure cap turned into a deposit kill switch, Owner-signer pre-check counted specs only, Retired rmPROTO proxy missed freeze-proxy all, Build gate ran the gated checkout's own CI check, Release gate asked check-sha-green about the caller repository, Proxy read-back error left no proxy_gate record, Refused safe-stage confirm broke --resume, upgrade-proxy rounds had no round number, Upgrade and freeze history keyed by proxy name, Verify with a moved build dir auto-paused all vaults, 8453 dapp builder pinned only deploy-time implementations, Implementation pins never retired after an upgrade, Snapshot pass skipped a same-block exiter, Indexer cached the exclusion ledger across upgrades, Ledger reads at the safe head missed older ledgers, Ledger move by a later reinitializer went unseen, Exclusion opening read every historic depositor in the tick, Inline receipt fetches had no tick budget, Vote memo fetches ran inline with no budget, Receipt and memo fetches had no host or size limit, Same-block share changes lost in wallet_positions, Direct router deposit counted twice in mint volume, Stage stack never watched the IC policy proxy |
| Info | 2 | Watchdog runbook misdescribed the pause re-send, Snapshot filter skipped saturated-zero holders |

Outcomes: 68 fixed in the uncommitted working tree (compile-checked only), 1 deferred, 0 not reproducible.

## Results by round

| Round | Scope | Candidates | Refuted | Confirmed | After merging duplicates | High | Medium | Low | Info | Fixed | Deferred |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Whole branch | 42 | 5 | 37 | 36 | 1 | 16 | 19 | 0 | 35 | 1 |
| 2 | Round 1 fix diff plus a composition pass | 29 | 3 | 26 | 19 | 2 | 6 | 11 | 0 | 19 | 0 |
| 3 | Round 2 fix diff plus a composition pass | 18 | 3 | 15 | 14 | 1 | 4 | 7 | 2 | 14 | 0 |
| All | — | 89 | 11 | 78 | 69 | 4 | 26 | 37 | 2 | 68 | 1 |

Every round confirmed at least one medium or high finding, which is the condition for another round. Round 3 was the last one the loop allows.

Compile sweep after each round (observed in the sweep reports):

- **Round 1** (status `done`): every check passed after fixes to three format failures (forge fmt, cargo fmt, prettier) and a forge-doc freshness failure (18 pages regenerated). Smallest size margin: RobotMoneyGateway, 1,229 B.
- **Round 2** (status `done`): every check passed after a prettier fix, nine stale source cites in docs/audits.md and a test string that named the devops repository. Smallest size margin: RobotMoneyVault, 1,213 B.
- **Round 3** (status `done`): every check passed after a forge-doc regeneration (three new pages), a re-snapshot of the RobotMoneyVault storage layout (library code hash only), a pause-semantics wording fix and three stale audit cites. Smallest size margin: RobotMoneyVault, 1,177 B.

Each sweep ran `forge build`, the production size check (every production contract stayed under 24,576 B), `bun x tsc --noEmit` for publish-contracts and the dapp, `cargo check --workspace --tests`, the formatters and linters, and the static gates (forge-doc freshness, ABI drift, storage layout, governance docs, set-registry owner, no production addresses, no test-only code, audit ledger). Sweeps fixed format, forge-doc, stale audit cites and one pause-wording failure. Round 3 re-snapshotted `RobotMoneyVault`'s storage layout because the `VaultAdapterOps` library code hash changed.

## Methodology

1. **Find.** Seven lens finders ran in parallel each round: contracts, upgrade (ADR-0014 proxies and freeze), economics, tooling (`publish-contracts`), indexer (explorer indexer, explorer API, watchdog), clients (dapp, rmpc, plugins) and ci. Each one mapped assets, authority and trust boundaries as they stand on the branch, tried to refute its own candidates, and returned at most 12 with `path:line` evidence. Each finder was read-only.
2. **De-duplicate.** A candidate was dropped when an earlier one in any round had the same file, classification and 25-line bucket. Rounds 2 and 3 were told which findings were already confirmed and to re-report one only when its fix was wrong or incomplete.
3. **Refute.** Three independent skeptics read each candidate. One traced the scenario step by step, one searched for a guard (modifier, role, deploy constraint, verifier label or test) that blocks it, and one calibrated severity under the rubric. Each defaulted to refuted when it could not confirm from code. A candidate was confirmed when at least two of three did not refute it. Its severity is the median of the confirming votes, and the higher of the two when only two confirmed.
4. **Fix.** Confirmed findings went to one fixer per lane (contracts, tooling, indexer, clients, ci). Each fixer fixed every critical, high and medium finding with a regression test written as code, and fixed low and info findings when the change was local and safe. Fixers ran compile checks only.
5. **Sweep.** One agent ran the compile and static-gate sweep listed above and repaired what failed.
6. **Repeat.** The loop ran up to three rounds and stops early only when a round confirms no medium or higher finding.
7. **Report.** This writer rebuilt every round from the workflow's subagent transcripts. The digest handed to it was cut at 180,000 characters partway through round 2, and a replay of the dedup, vote and median rules reproduced the uncut round 1 data exactly (42 candidates, 37 confirmed, 5 refuted). This writer then folded nine duplicates that the fixers themselves marked as the same defect with the same fix, and checked that every regression test a fixer named exists by name in the working tree (130 names matched; none was run). IDs follow the primary location's path and line, then classification.

**Evidence labels.** Evidence bullets, scenarios and fix notes are observed by the finder or the fixer in code and were re-checked by the skeptics. Severity reasoning and impact chains are reviewer inference. A line number is the one the finder saw in its round, and later fixes moved many lines. Classifications are normalized to the `SECURITY_` prefix the review schema requires; the lens's own class is kept beside it.

## Findings at a glance

| ID | Index | Severity | Round | Lane | Outcome | Finding |
|---|---|---|---|---|---|---|
| review-security-001 | SEC-H-001 | high | 2 | ci | fixed | Actions cache poisoning of the attesting rmpc build |
| review-security-047 | SEC-H-002 | high | 3 | ci | fixed | Committed layout snapshot never proven equal to the code |
| review-security-049 | SEC-H-003 | high | 1 | ci | fixed | Any writer could mint the rmpc attestation |
| review-security-064 | SEC-H-004 | high | 2 | indexer | fixed | Per-hour mint query grew quadratically with history |
| review-security-002 | SEC-M-001 | medium | 1 | ci | fixed | Attesting release jobs ran actions at mutable refs |
| review-security-003 | SEC-M-002 | medium | 2 | ci | fixed | aarch64 rmpc leg linked in a mutable cross image |
| review-security-004 | SEC-M-003 | medium | 2 | ci | fixed | Layout --base anchored to the parent commit |
| review-security-007 | SEC-M-004 | medium | 1 | clients | fixed | Dapp vault and router pins hashed only the proxy runtime |
| review-security-008 | SEC-M-005 | medium | 2 | clients | fixed | Dapp router deposits skipped leg implementation checks |
| review-security-010 | SEC-M-006 | medium | 1 | clients | fixed | Dapp writes never checked the logic behind proxies |
| review-security-015 | SEC-M-007 | medium | 3 | clients | fixed | rmpc router deposits sent no per-leg floors |
| review-security-016 | SEC-M-008 | medium | 1 | clients | fixed | rmpc withdraw skipped the router implementation check |
| review-security-021 | SEC-M-009 | medium | 1 | contracts | fixed | Illiquid adapter exclusion needed the 48 h timelock |
| review-security-022 | SEC-M-010 | medium | 1 | contracts | fixed | EMERGENCY force-remove of a healthy adapter repriced exits (SR-1012-5) |
| review-security-024 | SEC-M-011 | medium | 3 | contracts | fixed | Paused lending venue no longer stopped rmUSDC deposits |
| review-security-026 | SEC-M-012 | medium | 1 | contracts | fixed | Force-removed excluded adapter re-add sent its balance to NAV |
| review-security-030 | SEC-M-013 | medium | 2 | tooling | fixed | Build proof bound HEAD but not the ignored out/ artifacts |
| review-security-032 | SEC-M-014 | medium | 1 | tooling | fixed | Evidence secret scan missed prefixed secret names |
| review-security-033 | SEC-M-015 | medium | 1 | tooling | fixed | govern resume on a fresh manifest dropped the pause interlock |
| review-security-034 | SEC-M-016 | medium | 1 | tooling | fixed | upgrade-proxy trusted any build directory and skipped the layout compare |
| review-security-035 | SEC-M-017 | medium | 1 | tooling | fixed | No release gate covered upgrade and freeze builds |
| review-security-037 | SEC-M-018 | medium | 2 | tooling | fixed | Upgrade-time layout compare had no enum rule |
| review-security-040 | SEC-M-019 | medium | 3 | tooling | fixed | refs/replace ref passed the 8453 release-tag gate |
| review-security-046 | SEC-M-020 | medium | 1 | ci | fixed | Layout gate recorded enums by type label only |
| review-security-048 | SEC-M-021 | medium | 1 | ci | fixed | Layout gate compared against a snapshot the change rewrites |
| review-security-051 | SEC-M-022 | medium | 1 | tooling | fixed | IC policy proxy not watched by the 8453 indexer config |
| review-security-055 | SEC-M-023 | medium | 1 | indexer | fixed | Indexer derived the exclusion ledger address wrongly |
| review-security-066 | SEC-M-024 | medium | 2 | indexer | fixed | Batched gateway deposit hid a direct vault mint |
| review-security-067 | SEC-M-025 | medium | 3 | indexer | fixed | Per-hour volume window had no upper bound in catch-up |
| review-security-068 | SEC-M-026 | medium | 1 | indexer | fixed | Held watchdog cursor starved the stuck-pause replacement |
| review-security-005 | L-001 | low | 2 | clients | fixed | Withdraw tab hid the revoke for an unverified router |
| review-security-006 | L-002 | low | 1 | clients | fixed | Dapp blocked router deposits on any unavailable leg |
| review-security-009 | L-003 | low | 1 | clients | fixed | Config export told operators to pin the live implementation |
| review-security-011 | L-004 | low | 1 | clients | fixed | Dapp exits disabled when gateway verification failed |
| review-security-012 | L-005 | low | 1 | indexer | fixed | /health stayed ok after the indexer stopped |
| review-security-013 | L-006 | low | 1 | indexer | fixed | /v1/vault/snapshots not bound to the served chain |
| review-security-014 | L-007 | low | 1 | clients | deferred | Swarm preflight checked the wrong IC policy and one role |
| review-security-017 | L-008 | low | 1 | clients | fixed | Committee identity written with umask permissions |
| review-security-018 | L-009 | low | 3 | clients | fixed | rmpc did not name LegSkippedWithFloor |
| review-security-019 | L-010 | low | 1 | contracts | fixed | Router reverted when a basket leg failed ORA-4 |
| review-security-020 | L-011 | low | 2 | contracts | fixed | Router skipped a leg that carried a non-zero floor |
| review-security-023 | L-012 | low | 1 | contracts | fixed | RouterGovernance claimed a released receipt is always applied |
| review-security-025 | L-013 | low | 2 | contracts | fixed | Lending venue refusing a supply reverted every deposit |
| review-security-027 | L-014 | low | 2 | contracts | fixed | Force-removed adapter record could only recover all at once |
| review-security-028 | L-015 | low | 1 | contracts | fixed | Morpho exposure cap turned into a deposit kill switch |
| review-security-031 | L-016 | low | 1 | tooling | fixed | Owner-signer pre-check counted specs only |
| review-security-036 | L-017 | low | 1 | tooling | fixed | Retired rmPROTO proxy missed freeze-proxy all |
| review-security-038 | L-018 | low | 2 | tooling | fixed | Build gate ran the gated checkout's own CI check |
| review-security-039 | L-019 | low | 1 | tooling | fixed | Release gate asked check-sha-green about the caller repository |
| review-security-041 | L-020 | low | 1 | tooling | fixed | Proxy read-back error left no proxy_gate record |
| review-security-042 | L-021 | low | 1 | tooling | fixed | Refused safe-stage confirm broke --resume |
| review-security-043 | L-022 | low | 1 | tooling | fixed | upgrade-proxy rounds had no round number |
| review-security-044 | L-023 | low | 2 | tooling | fixed | Upgrade and freeze history keyed by proxy name |
| review-security-045 | L-024 | low | 3 | tooling | fixed | Verify with a moved build dir auto-paused all vaults |
| review-security-050 | L-025 | low | 2 | tooling | fixed | 8453 dapp builder pinned only deploy-time implementations |
| review-security-052 | L-026 | low | 3 | tooling | fixed | Implementation pins never retired after an upgrade |
| review-security-053 | L-027 | low | 3 | indexer | fixed | Snapshot pass skipped a same-block exiter |
| review-security-056 | L-028 | low | 2 | indexer | fixed | Indexer cached the exclusion ledger across upgrades |
| review-security-057 | L-029 | low | 3 | indexer | fixed | Ledger reads at the safe head missed older ledgers |
| review-security-058 | L-030 | low | 3 | indexer | fixed | Ledger move by a later reinitializer went unseen |
| review-security-059 | L-031 | low | 2 | indexer | fixed | Exclusion opening read every historic depositor in the tick |
| review-security-060 | L-032 | low | 2 | indexer | fixed | Inline receipt fetches had no tick budget |
| review-security-061 | L-033 | low | 3 | indexer | fixed | Vote memo fetches ran inline with no budget |
| review-security-062 | L-034 | low | 1 | indexer | fixed | Receipt and memo fetches had no host or size limit |
| review-security-063 | L-035 | low | 1 | indexer | fixed | Same-block share changes lost in wallet_positions |
| review-security-065 | L-036 | low | 1 | indexer | fixed | Direct router deposit counted twice in mint volume |
| review-security-069 | L-037 | low | 2 | indexer | fixed | Stage stack never watched the IC policy proxy |
| review-security-029 | — | info | 3 | indexer | fixed | Watchdog runbook misdescribed the pause re-send |
| review-security-054 | — | info | 3 | indexer | fixed | Snapshot filter skipped saturated-zero holders |

## Low-Severity Findings

| Index | ID | Finding | Round | Outcome |
|---|---|---|---|---|
| L-001 | review-security-005 | Withdraw tab hid the revoke for an unverified router | 2 | fixed |
| L-002 | review-security-006 | Dapp blocked router deposits on any unavailable leg | 1 | fixed |
| L-003 | review-security-009 | Config export told operators to pin the live implementation | 1 | fixed |
| L-004 | review-security-011 | Dapp exits disabled when gateway verification failed | 1 | fixed |
| L-005 | review-security-012 | /health stayed ok after the indexer stopped | 1 | fixed |
| L-006 | review-security-013 | /v1/vault/snapshots not bound to the served chain | 1 | fixed |
| L-007 | review-security-014 | Swarm preflight checked the wrong IC policy and one role | 1 | deferred |
| L-008 | review-security-017 | Committee identity written with umask permissions | 1 | fixed |
| L-009 | review-security-018 | rmpc did not name LegSkippedWithFloor | 3 | fixed |
| L-010 | review-security-019 | Router reverted when a basket leg failed ORA-4 | 1 | fixed |
| L-011 | review-security-020 | Router skipped a leg that carried a non-zero floor | 2 | fixed |
| L-012 | review-security-023 | RouterGovernance claimed a released receipt is always applied | 1 | fixed |
| L-013 | review-security-025 | Lending venue refusing a supply reverted every deposit | 2 | fixed |
| L-014 | review-security-027 | Force-removed adapter record could only recover all at once | 2 | fixed |
| L-015 | review-security-028 | Morpho exposure cap turned into a deposit kill switch | 1 | fixed |
| L-016 | review-security-031 | Owner-signer pre-check counted specs only | 1 | fixed |
| L-017 | review-security-036 | Retired rmPROTO proxy missed freeze-proxy all | 1 | fixed |
| L-018 | review-security-038 | Build gate ran the gated checkout's own CI check | 2 | fixed |
| L-019 | review-security-039 | Release gate asked check-sha-green about the caller repository | 1 | fixed |
| L-020 | review-security-041 | Proxy read-back error left no proxy_gate record | 1 | fixed |
| L-021 | review-security-042 | Refused safe-stage confirm broke --resume | 1 | fixed |
| L-022 | review-security-043 | upgrade-proxy rounds had no round number | 1 | fixed |
| L-023 | review-security-044 | Upgrade and freeze history keyed by proxy name | 2 | fixed |
| L-024 | review-security-045 | Verify with a moved build dir auto-paused all vaults | 3 | fixed |
| L-025 | review-security-050 | 8453 dapp builder pinned only deploy-time implementations | 2 | fixed |
| L-026 | review-security-052 | Implementation pins never retired after an upgrade | 3 | fixed |
| L-027 | review-security-053 | Snapshot pass skipped a same-block exiter | 3 | fixed |
| L-028 | review-security-056 | Indexer cached the exclusion ledger across upgrades | 2 | fixed |
| L-029 | review-security-057 | Ledger reads at the safe head missed older ledgers | 3 | fixed |
| L-030 | review-security-058 | Ledger move by a later reinitializer went unseen | 3 | fixed |
| L-031 | review-security-059 | Exclusion opening read every historic depositor in the tick | 2 | fixed |
| L-032 | review-security-060 | Inline receipt fetches had no tick budget | 2 | fixed |
| L-033 | review-security-061 | Vote memo fetches ran inline with no budget | 3 | fixed |
| L-034 | review-security-062 | Receipt and memo fetches had no host or size limit | 1 | fixed |
| L-035 | review-security-063 | Same-block share changes lost in wallet_positions | 1 | fixed |
| L-036 | review-security-065 | Direct router deposit counted twice in mint volume | 1 | fixed |
| L-037 | review-security-069 | Stage stack never watched the IC policy proxy | 2 | fixed |

## Findings

Heading `### N.` is finding `review-security-NNN` in the JSON summary and row `SR-1015-N` in the `docs/audits.md` finding register. High and medium findings also carry a `SEC-H-NNN` or `SEC-M-NNN` index, and low findings an `L-NNN` index.

### 1. High — A writer can poison the Actions cache that the attesting rmpc build restores, so a genuine tag-push attestation covers trojan bytes

#### SEC-H-001 (review-security-001)

- **Where:** `.github/workflows/release-rmpc.yml:404` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / ci / code
- **Class / confidence:** `SECURITY_PROVENANCE_BYPASS` (lens class: `SECURITY_PROVENANCE_BYPASS (CI cache poisoning)`) / medium
- **Skeptics:** 3 of 3 confirmed. Votes: high, high, high. The finder said high.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-1

**Scenario.** A writer pushes a branch commit with the same Cargo.toml and Cargo.lock as dev. The commit adds a build.rs that rewrites a dependency rlib in target/<triple>/release/deps. The writer deletes any v0-rust-build-* entry in the dev scope. Then they dispatch release-rmpc on ref dev with dry_run=true and commit_hash set to that commit. The rust-cache post step saves the poisoned target/ in the dev scope under the exact key the next release computes. An admin later pushes rmpc-vX.Y.Z. The build restores that entry, cargo treats the dependency as fresh, and the trojan gets linked. attest-build-provenance then signs it as a push of refs/tags/rmpc-vX.Y.Z, and install-rmpc.sh installs it. A second variant works after a release, within 30 days: dispatch the dry run on the tag ref after deleting the tag-scope entry, re-run the tag-push run, then swap the asset.

**Evidence.**

- .github/workflows/release-rmpc.yml:404-405 the build job runs Swatinem/rust-cache@6323deb (v2.9.2) with default restore and save on every trigger, in the same job as the attest step (546-549) that holds id-token: write and attestations: write.
- .github/workflows/release-rmpc.yml:96-104 dispatch still takes commit_hash. A dry run builds that commit (checkout ref needs.resolve.outputs.sha) in a job whose cache scope is the dispatched ref, which can be dev or an existing rmpc-v* tag.
- rust-cache v2.9.2 src/config.ts (read via gh api at the pinned sha): key = v0-rust-<GITHUB_JOB>-<os>-<arch>-<rustc+CARGO*/RUST* env hash>-<Cargo.toml/Cargo.lock hash>. No ref or trigger is in the key. Restore falls back to the prefix. Paths are CARGO_HOME/{bin,registry,git} and target/.
- gh api: default branch is dev. Tag-triggered runs restore caches from their own ref and the default branch. A writer (actions: write) can dispatch, delete cache entries and re-run any run, and a re-run keeps event=push and ref=refs/tags/<tag>.
- scripts/release/install-rmpc.sh:314-331 pins repo, signer workflow, --source-ref refs/tags/<TAG> and buildTrigger push. Every one of these holds for a poisoned tag-push run or its re-run.
- gh api repos/robotmoney/robotmoney-core/immutable-releases: enabled=false, so a writer can still replace release assets.
- docs/development/releasing.md (this diff) now states 'Repository write alone cannot either'. The cache path contradicts that claim.

**Recommended fix (reviewer).** Restore and save no shared Actions cache in the run that attests. Gate the Cargo cache step off the tag-push path, or remove it from the build job. Make dispatch runs save-if false. Drop commit_hash from dispatch, or move dry runs to a job without id-token: write. Extend audit_workflow_run_splice_and_perms.py to refuse any cache step (rust-cache, actions/cache, cache-from type=gha) in a job that runs attest-build-provenance. Owner action: turn on immutable releases.

**Regression test the reviewer asked for.** In test_audit_workflow_run_splice_and_perms.sh, add a mutated release-rmpc.yml whose attesting job keeps Swatinem/rust-cache on the push path. It must yield a finding. In install-rmpc-selftest.sh, assert that the build job's cache step is absent or carries a condition that excludes push.

**What the fixer changed.**

- Removed the Swatinem/rust-cache step from the build job entirely, so no run of the attesting job restores or saves a cache. Dropped the commit_hash dispatch input: a dry run now builds the dispatched ref's HEAD, and the resolve job no longer checks out. New audit rule 8 (attest-cache) refuses any cache step in a job that runs attest-build-provenance, whatever its if:. That covers rust-cache, actions/cache and its restore/save halves, sccache GHA, a truthy cache: input, setup-go's default cache and cache-from/to type=gha. releasing.md now states the condition behind 'Repository write alone cannot either'.

**Regression tests the fixer wrote (not run).**

- .github/scripts/tests/test_audit_workflow_run_splice_and_perms.sh::'Swatinem/rust-cache back in the attesting build job, on the push path, is caught' + '::a rust-cache step gated to dispatch runs with save-if: false is still refused' + '::actions/cache/restore in the attesting build job is caught'; scripts/release/install-rmpc-selftest.sh::'attesting build job restores and saves no Actions cache, on any trigger' + '::a hostile copy with Swatinem/rust-cache back in the build job is read as a cache step'

**Files changed:** `.github/workflows/release-rmpc.yml`, `.github/scripts/audit_workflow_run_splice_and_perms.py`, `.github/scripts/tests/test_audit_workflow_run_splice_and_perms.sh`, `scripts/release/install-rmpc-selftest.sh`, `docs/development/releasing.md`

**Residual.** Owner action: turn on immutable releases.

**Related.** related findings review-security-002, review-security-049; finder note: Incomplete fix of the confirmed high 'Any repo writer can mint the rmpc build attestation that install-rmpc.sh trusts' (scripts/release/install-rmpc.sh:276). Composition of two seams: CI cache scope and the installer's certificate pins.

### 2. Medium — The rmpc release build job runs third-party actions at mutable refs while it holds id-token and attestations write

#### SEC-M-001 (review-security-002)

- **Where:** `.github/workflows/release-rmpc.yml:404` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / ci / code
- **Class / confidence:** `SECURITY_SUPPLY_CHAIN_UNPINNED` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-2

**Scenario.** An upstream compromise moves the rust-toolchain stable branch or the rust-cache v2 tag. The step code runs inside the build job and swaps target/<triple>/release/rmpc. attest-build-provenance then signs the tampered archive as release-rmpc.yml, and install-rmpc.sh accepts it.

**Evidence.**

- .github/workflows/release-rmpc.yml:370-371 the build job has id-token: write and attestations: write.
- .github/workflows/release-rmpc.yml:404 uses dtolnay/rust-toolchain@stable, which is a branch. :410 uses taiki-e/install-action@v2. :415 uses Swatinem/rust-cache@v2. All three run before the attest step at :546.
- .github/workflows/release-rmpc.yml:631 uses softprops/action-gh-release@v2 in the publish job, which has contents: write. release-dapp.yml build-and-push has contents: write and packages: write and uses docker/*@v3/v5.
- No uses: line anywhere under .github is pinned to a 40-hex commit (grep count by ref).
- scripts/release/install-rmpc.sh:44-49 lists the threats provenance defeats and leaves out a compromised action inside the attesting job.

**Recommended fix (reviewer).** Pin every third-party action in release-rmpc.yml and release-dapp.yml to a full commit SHA with a version comment. Pin the Rust toolchain with rust-toolchain.toml. Extend audit_workflow_run_splice_and_perms.py so it refuses a uses: that is not a SHA in any job that holds a write or id-token scope.

**Regression test the reviewer asked for.** Add an audit selftest: a hostile copy of release-rmpc.yml with uses: x/y@v2 in the build job must produce a finding.

**What the fixer changed.**

- Every uses: in both release workflows is pinned to a full commit SHA with a version comment. SHAs were resolved with git ls-remote: checkout v4.4.0, attest-build-provenance v4.2.2, upload-artifact v4.6.2, download-artifact v4.3.0, taiki-e/install-action v2.87.28, Swatinem/rust-cache v2.9.2, softprops/action-gh-release v2.6.2, docker setup-buildx v3.12.0, login v3.7.0, metadata v5.10.0, build-push v5.4.0. dtolnay/rust-toolchain is pinned to a master commit with `toolchain: stable`. The auditor's new uses-unpinned finding refuses a non-SHA uses: (local ./ and docker digest allowed) in any job holding any write scope, not only contents. Both real release workflows audit clean. rust-toolchain.toml was NOT added (see notes).

**Regression tests the fixer wrote (not run).**

- .github/scripts/tests/test_audit_workflow_run_splice_and_perms.sh::'release-rmpc.yml: uses: x/y@v2 in the build job (id-token: write, attestations: write) is caught', '<release-dapp.yml|release-rmpc.yml>: an action at a mutable tag (x/y@v2) in writer job ... is caught' (MIN_EXPECTED_ASSERTIONS 26 -> 31)

**Files changed:** `.github/workflows/release-rmpc.yml`, `.github/workflows/release-dapp.yml`, `.github/scripts/audit_workflow_run_splice_and_perms.py`, `.github/scripts/tests/test_audit_workflow_run_splice_and_perms.sh`

**Residual.** rust-toolchain.toml was not added. release-dapp.yml still uses a type=gha build cache in a job with packages: write.

**Related.** related findings review-security-001, review-security-003, review-security-049; finder note: issue 1236 trust model

### 3. Medium — The aarch64 rmpc leg links inside a cross-rs Docker image pulled by mutable tag, in the job that attests the archive

#### SEC-M-002 (review-security-003)

- **Where:** `.github/workflows/release-rmpc.yml:417` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / ci / code
- **Class / confidence:** `SECURITY_SUPPLY_CHAIN_MUTABLE_REF` / medium
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-3

**Scenario.** An upstream compromise moves that GHCR tag to an image with a trojan linker or sysroot. The next tag-push run links rmpc-<ver>-linux-arm64 with it. The run then attests the archive genuinely, and install-rmpc.sh accepts it.

**Evidence.**

- .github/workflows/release-rmpc.yml:398-402 installs cross and 414-419 runs cross build for aarch64-unknown-linux-gnu.
- The repo has no Cross.toml (ls at the root and in clients/rust-payment-client found none). cross therefore runs its default image ghcr.io/cross-rs/aarch64-unknown-linux-gnu:<cross version>, which is a tag, not a digest. The linker and sysroot inside that image produce the binary.
- The job holds id-token: write and attestations: write. The attest step at 546-549 signs whatever that leg built.
- The file's GOTCHAS block and audit rule 6 in audit_workflow_run_splice_and_perms.py claim that third-party code in the attesting job is pinned. The audit parses only uses: lines.

**Recommended fix (reviewer).** Add a Cross.toml that pins the aarch64 image by @sha256 digest, or build aarch64 natively on an arm64 GitHub-hosted runner. Make the authority audit refuse a cross step when Cross.toml has no digest-pinned image.

**Regression test the reviewer asked for.** In install-rmpc-selftest.sh, assert that every cross target used by release-rmpc.yml has a Cross.toml image of the form ...@sha256:<64 hex>.

**What the fixer changed.**

- The repo is public, so linux-arm64 now builds natively on the free GitHub-hosted ubuntu-24.04-arm runner. The install-cross, cross build and aarch64-linux-gnu-strip steps are gone, and the cross matrix key is removed. One Build step and one Linux strip step now serve every leg. New audit rule 9 (cross-image) refuses a cross build in an attesting job unless Cross.toml pins each resolved target by @sha256 digest. It resolves the target from --target or from the matrix's cross: true entries. It also refuses a tag-pinned CROSS_TARGET_<T>_IMAGE override or any CROSS_CONFIG. Takes --cross-toml, defaulting to <repo>/Cross.toml.

**Regression tests the fixer wrote (not run).**

- scripts/release/install-rmpc-selftest.sh::'attesting build job runs no cross' (or every cross target has a Cross.toml @sha256 image) + '::hostile copy with the pre-fix cross leg is read as exactly aarch64-unknown-linux-gnu' + '::tag-pinned or missing Cross.toml reported unpinned' + '::digest-pinned Cross.toml accepted'; .github/scripts/tests/test_audit_workflow_run_splice_and_perms.sh::cross-image cases (no Cross.toml, only the cross: true target named, tag image, digest image passes, CROSS_TARGET_<T>_IMAGE tag override)

**Files changed:** `.github/workflows/release-rmpc.yml`, `.github/scripts/audit_workflow_run_splice_and_perms.py`, `.github/scripts/tests/test_audit_workflow_run_splice_and_perms.sh`, `scripts/release/install-rmpc-selftest.sh`

**Residual.** Native arm64 builds raise the arm64 glibc floor, so Debian 11 and Ubuntu 20.04 arm64 lose prebuilt binaries. Dispatch one dry run on the new arm64 runner before the next rmpc-v tag.

**Related.** related findings review-security-002; finder note: Residual of the confirmed medium 'The rmpc release build job runs third-party actions at mutable refs while it holds id-token and attestations write' (.github/workflows/release-rmpc.yml:404).

### 4. Medium — The storage-layout --base compare is anchored to the parent commit, so a merged red layout change becomes the base and the release sha passes

#### SEC-M-003 (review-security-004)

- **Where:** `.github/workflows/suite-01-02-forge-tests.yml:185` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / ci / code
- **Class / confidence:** `SECURITY_GATE_BYPASS` (lens class: `SECURITY_GATE_BYPASS (author-controlled reference)`) / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, low. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-4

**Scenario.** A writer merges PR A. PR A inserts a VaultRegistry.VaultStatus member before Retired and reruns --write. A's PR check and its dev push run are red. Any later merge B runs --base against A's tip, whose snapshot already holds the reorder, so B passes. The release is cut at B or later, and check-sha-green reports green. A single green PR can do the same by renaming a proxied contract in the sources, proxied.txt and the ADR table, because the old snapshot is never compared.

**Evidence.**

- .github/workflows/suite-01-02-forge-tests.yml:185-195 sets BASE_SHA to the PR base or github.event.before (the previous dev tip), then runs check-storage-layout.sh --base FETCH_HEAD.
- scripts/ci/storage_layout_gate.py:516-535 cmd_base compares the committed snapshot with the snapshot at that ref only. It loops over names from the current proxied.txt, so a base snapshot whose contract was renamed or delisted is skipped as 'a new proxied contract' (line 533).
- gh api rules/branches/dev returns only deletion, non_fast_forward and pull_request with required_approving_review_count 0. There is no required_status_checks rule, so a red PR merges.
- publish-contracts/src/release-gate.ts:187 check-sha-green judges only the release sha, never its ancestors.
- storage_layout_gate.py:20-21 says a snapshot is 'the layout of the implementation live on the release chain', but nothing anchors --base to that layout.

**Also reported by another lens and folded in here.**

- `.github/workflows/suite-01-02-forge-tests.yml:185` (3 of 3 confirmed): CI --base compares the committed snapshot with the previous push tip or PR base, so one red push launders a non-append snapshot for every later green commit

**Recommended fix (reviewer).** Anchor --base to the layout live on the release chain. Use the snapshots at the newest release/* tag of the sheet kind, or the deploy manifests' layout ids, instead of the parent. Fail when a base snapshot's contract is missing from the current list. Owner action: add required status checks on dev.

**Regression test the reviewer asked for.** Add a storage_layout_gate.py selftest with three commits: the base, a break plus --write rewrite, and a trivial commit. Anchored to the release tag, the third commit must fail. A base snapshot whose contract was renamed must also fail.

**What the fixer changed.**

- New --release-anchor mode runs the same storage compare against every annotated production release/<version> tag in the clone. It mirrors release-tag.ts, so -rehearsal and lightweight tags never anchor. The shared base_compare now fails when a contract proxied at the anchor (listed there or snapshotted there) is missing from the current proxied.txt. It also never treats a contract listed at the anchor without a snapshot as new. The forge-unit-tests step fetches refs/tags/release/* at depth 1 after the parent compare and runs --release-anchor. forge-unit-tests is in required-checks.json, so check-sha-green at a release sha now implies the layout is append-only against prior releases. Smoke run against the real tags passes. release/v0.4.0-base holds only the pre-ADR gateway snapshot, so the anchor compares nothing until the first ADR-0014 production tag exists.
- Same fix as the medium finding. The selftest builds a throwaway git repo with system and global git config disabled and GIT_* env stripped, plus real annotated, rehearsal and lightweight tags. Its cases go through the same base_compare and release_anchors that CI runs.

**Regression tests the fixer wrote (not run).**

- scripts/ci/storage_layout_gate.py::_selftest_history (run by check-storage-layout.sh --selftest): 'rename: a contract proxied at the release that proxied.txt no longer lists fails --release-anchor', 'history: --release-anchor passes a snapshot that only appends to the released one', 'history: only the annotated production tag anchors'
- scripts/ci/storage_layout_gate.py::_selftest_history: 'history S -> S' (moved slot, red) -> S' unchanged: the parent compare passes at the third commit' + '--release-anchor still fails at the third commit'; 'delete then re-add: the parent compare fails' + '--release-anchor fails'; 'delist then re-add: the parent compare sees a new contract and passes' + '--release-anchor fails'

**Files changed:** `scripts/ci/storage_layout_gate.py`, `scripts/ci/check-storage-layout.sh`, `.github/workflows/suite-01-02-forge-tests.yml`, `docs/adr/ADR-0014-governed-upgrades-and-freeze.md`, `docs/technical/smart-contract-invariants.md`

**Residual.** Owner actions: protect refs/tags/release/* with an admin-only ruleset, because the anchor trusts those tags, and add required status checks on dev.

**Related.** related findings review-security-037, review-security-047, review-security-048; finder note: Incomplete fix of the confirmed medium 'The storage-layout gate compares against a snapshot the same change can rewrite' (scripts/ci/storage_layout_gate.py:375). Prior T10 (no ruleset required checks). On 8453 this composes with the layout-compare.ts enum gap below.

### 5. Low — When the router fails its pins, the Withdraw tab stops reading and offering a revoke of the holder's standing share allowance to that router

**Index:** L-001 (review-security-005)

- **Where:** `clients/dapp/src/components/DepositWithdrawTab.tsx:244` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / clients / code
- **Class / confidence:** `SECURITY_STALE_ALLOWANCE_HIDDEN` / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-5

**Scenario.** A holder approves N shares to the router and the redeem never lands (simulation fails or the tab closes). The timelock later upgrades the router to logic the build does not pin. The badge read marks the router refused, the tab redeems directly, and the N-share allowance to the now-unreviewed router is neither shown nor revocable from the dapp, while that router can transferFrom those shares.

**Evidence.**

- clients/dapp/src/components/DepositWithdrawTab.tsx:242 routerUnverified (round 1) sends chooseRedeemRoute to direct (clients/dapp/src/lib/routerRedeem.ts:207)
- DepositWithdrawTab.tsx:244 redeemRouter is undefined on the direct route, so the routerShareAllowance read is disabled
- DepositWithdrawTab.tsx:307 routerAllowanceLeftover requires redeemRouter, and the revoke block at :779 renders only then
- codePins.ts pinnedWriteTarget (round 1) exempts approve(spender, 0) so a revoke needs no pin, but no UI path reaches it on the direct route

**Recommended fix (reviewer).** Read allowance(holder, props.routerAddress) whenever a router is configured, not only on the router route. Render the revoke (approve(router, 0), already exempt from the pin) on the direct route too, saying the router failed verification.

**Regression test the reviewer asked for.** withdraw-routes-through-router.test.tsx: refusedTargets holds the router and allowance(holder, router) is 5 shares; the route is direct, withdraw-revoke renders, and clicking it sends approve(router, 0) through the guard.

**What the fixer changed.**

- allowance(holder, props.routerAddress) is now read whenever a non-zero router is configured, not only on the router route. On the direct route the whole allowance counts as leftover, because the direct redeem spends none of it. On the pending route nothing is shown. The revoke simulation and handler target the configured router with approve(router, 0), which pinnedWriteTarget already exempts. The text comes from the new pure helper leftoverRouterAllowanceText. For router-unverified it says the router failed verification and can still spend the allowance. The new test runs the real guard on the mainnet class through a mocked wallet provider and asserts approve(router, 0) is sent pinned to chain 8453.

**Regression tests the fixer wrote (not run).**

- withdraw-routes-through-router.test.tsx::shows and revokes the share allowance to a router that failed its pins, on the direct route, through the guard; withdraw-routes-through-router.test.tsx::says why a leftover router allowance is shown, by route

**Files changed:** `clients/dapp/src/components/DepositWithdrawTab.tsx`, `clients/dapp/src/lib/routerRedeem.ts`, `clients/dapp/tests/unit/withdraw-routes-through-router.test.tsx`, `clients/dapp/tests/unit/deposit-target-threading.test.tsx`

**Related.** related findings review-security-010; finder note: Composes two round-1 changes: the router-unverified direct fallback and the approve-zero pin exemption

### 6. Low — The dapp disables every router deposit when any leg, even a 0 bps leg, is unavailable, and says the tx would revert; the router now skips such legs

**Index:** L-002 (review-security-006)

- **Where:** `clients/dapp/src/components/RouterDepositTab.tsx:342` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / clients / code
- **Class / confidence:** `SECURITY_ECONOMICS_LEG_SKIP_CLIENT_DRIFT` (lens class: `ECONOMICS_LEG_SKIP_CLIENT_DRIFT`) / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-6

**Scenario.** The recorder keeper misses 30 minutes, so rmAGENT.maxDeposit reverts. rmAGENT carries 0 bps and would never be funded, but previewDeposit flags it unavailable. The dapp then hides the submit button and shows a false revert warning for the whole portfolio until someone calls record(). The same happens whenever a zero-weight vault is paused, or when rmUSDC has an open exclusion while other legs could still take the deposit.

**Evidence.**

- clients/dapp/src/components/RouterDepositTab.tsx:204-211 and :336-345 - simulation and submit are both gated on !hasUnavailable.
- clients/dapp/src/components/RouterDepositTab.tsx:311-317 and clients/dapp/src/lib/routerPreview.ts:174-188 - the UI tells the user 'The router deposit will revert if you sign' and tags legs '[UNAVAILABLE - tx will revert]'.
- contracts/PortfolioRouter.sol:1066-1176 (_depositTo) - after QA D4 it skips unavailable legs and renormalizes. _availabilityAndAmounts (:757-793) runs _isDepositable on every leg, including 0 bps legs.
- Stage sheets set ROUTER_WEIGHTS=...AGENT:0,RWA:0. A stale rmAGENT recorder (StaleRecorder after 1800 s without a record, UniswapV4PriceRecorder.sol:211) makes maxDeposit revert. A paused rmAGENT or rmRWA returns 0.

**Recommended fix (reviewer).** Remove hasUnavailable from canSimDeposit and from the submit gate, and let the simulation be the revert gate. Replace the warning with 'unavailable legs are skipped; the amounts below are renormalized', and show each leg's renormalized legAmount (ProportionPreview already has it).

**Regression test the reviewer asked for.** RouterDepositTab.test.tsx: a preview with one 0 bps unavailable leg and one weighted unavailable leg keeps submit enabled when the simulation succeeds, and the effect text lists the renormalized leg amounts.

**What the fixer changed.**

- hasUnavailable removed from canSimDeposit and the submit gate. The simulation is the revert gate. Effect and warning now say legs are skipped and renormalized, with each leg's legAmount. A 0 bps leg's deposit state (paused, stale price) no longer closes the router deposit. A weighted closed leg still does (issue 1731 fail-closed rule kept). docs/architecture.md §4.2 already says skip and renormalise.

**Regression tests the fixer wrote (not run).**

- clients/dapp/tests/unit/router-deposit-tab.test.tsx::a preview with one 0 bps unavailable leg and one weighted unavailable leg keeps submit enabled when the simulation succeeds, and the effect text lists the renormalized leg amounts; ::the simulation still gates submit: no simulated request, no submit; destination-selector.test.tsx::an unavailable 0 bps leg changes nothing, so it is not high risk

**Files changed:** `clients/dapp/src/components/RouterDepositTab.tsx`, `clients/dapp/src/lib/routerPreview.ts`, `clients/dapp/tests/unit/router-deposit-tab.test.tsx`, `clients/dapp/tests/unit/destination-selector.test.tsx`

**Residual.** docs/technical/portfolio-router-decisions.md sections 3.1 and 3.4 still say any unavailable leg reverts (stale scout doc, docs lane).

**Related.** related findings review-security-019; finder note: QA D4, RTR-5, CS-4

### 7. Medium — Dapp vault and router code pins now hash the shared ERC1967Proxy runtime, so deposits, approvals and the [bytecode verified] badge pass for any implementation the timelock installs

#### SEC-M-004 (review-security-007)

- **Where:** `clients/dapp/src/lib/codePins.ts:115` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / clients / code
- **Class / confidence:** `SECURITY_VERIFICATION_BYPASS` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-7

**Scenario.** After a governed upgrade of rmUSDC, a basket vault or the router to an implementation nobody pinned (buggy, unreviewed or malicious), a mainnet dapp user's approve and deposit pass the QA U5 write guard and the preview badges the target [bytecode verified], because the proxy bytecode at the pinned address is unchanged. rmpc refuses the same deposit through proxy_implementation_hashes; the dapp does not.

**Evidence.**

- clients/dapp/src/lib/codePins.ts:115-125 checkCodePin compares keccak256(eth_getCode(target)) with the pin and nothing else
- scripts/stage/mainnet-dapp.ts:270-277 takes VITE_ROUTER_EXPECTED_CODE_HASH and VITE_VAULT_EXPECTED_CODE_HASH from the timelock manifest code_hashes.router and vault_handover.vault_i.code_hash
- contracts/script/DeployTimelock.s.sol:1232 (d.router.codehash) and :1248 (vault_.codehash) hash the proxy address, i.e. the ERC1967Proxy runtime that ADR-0014 §3 says is identical for every proxy and never changes on upgrade
- clients/dapp/src/lib/useGuardedWriteContract.ts:92-98 assertTargetPinned uses only these pins; no ERC-1967 slot or implementation read exists for vaults or the router
- clients/dapp/src/lib/gatewayVerifier.ts:17-23 itself states proxy code alone would let the dapp act against any implementation the timelock installs, and adds an implementation pin for the gateway only

**Recommended fix (reviewer).** Add build-time implementation pins for vaults and the router (address -> reviewed implementation hashes) generated by mainnet-dapp.ts from the stage manifests' implementation runtime hashes; in assertTargetPinned and useVerifiedCodeTargets read the ERC-1967 slot and the implementation code at one block and refuse a proxied target whose implementation hash is unpinned; do not reuse pinsMatched across an implementation change. Redeem stays unpinned.

**Regression test the reviewer asked for.** clients/dapp/tests/unit: a proxied vault or router whose proxy code matches its pin but whose implementation hash is not pinned is refused for deposit and approve and is not badged verified; a redeem is still allowed.

**What the fixer changed.**

- New build-time pins VITE_VAULT_EXPECTED_IMPLEMENTATION_HASH (JSON map) and VITE_ROUTER_EXPECTED_IMPLEMENTATION_HASH. The guard reads code, ERC-1967 slot and implementation code at one block via verifyPinnedTarget. A proxy with no pin, an unlisted or codeless implementation, and a pin for a direct contract each refuse. The badge hook uses the same check and re-reads every 60 s. DeployTimelock now records vault_handover.vault_<i>.implementation_code_hash and code_hashes.router_implementation. mainnet-dapp.ts requires them when the stage manifest names an implementation. Redeem stays unpinned.

**Regression tests the fixer wrote (not run).**

- clients/dapp/tests/unit/code-pin.test.tsx::refuses a deposit and an approve to a router whose proxy code matches but whose implementation is unpinned, never badges it, and still sends a redeem; plus ::refuses a deposit to a proxied vault whose build carries no implementation pin, ::lets a deposit through to a proxied vault whose implementation is reviewed, and badges it, ::names one cause per failure, and passes a direct contract with no implementation pin; scripts/stage/tests/mainnet-dapp.test.ts::emits the implementation pins of proxied vaults and the router, and refuses a proxy without one; contracts/test/DeployTimelock.t.sol::test_manifestRecordsImplementationCodeHashes

**Files changed:** `clients/dapp/src/lib/codePins.ts`, `clients/dapp/src/lib/useGuardedWriteContract.ts`, `clients/dapp/src/lib/useVerifiedCodeTargets.ts`, `clients/dapp/src/lib/runtimeConfig.ts`, `clients/dapp/Dockerfile`, `clients/dapp/README.md`, `scripts/stage/mainnet-dapp.ts`, `scripts/stage/tests/mainnet-dapp.test.ts`, `contracts/script/DeployTimelock.s.sol`, `contracts/test/DeployTimelock.t.sol`, `testing/ethereum-testnet/config/docker-compose.dapp.yaml`, `clients/dapp/tests/unit/code-pin.test.tsx`, `clients/dapp/tests/unit/guarded-write-contract.test.tsx`, `clients/dapp/tests/unit/deposit-tab-shows-write-refusal.test.tsx`

**Related.** related findings review-security-008, review-security-010, review-security-050; finder note: QA plan U5 (issue 1737 item 1); ADR-0014 §10 implementation pins

### 8. Medium — Dapp router deposits send USDC into leg vaults whose implementation is never checked, while a direct deposit into the same vault is refused

#### SEC-M-005 (review-security-008)

- **Where:** `clients/dapp/src/lib/codePins.ts:184` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / clients / code
- **Class / confidence:** `SECURITY_UNVERIFIED_DOWNSTREAM_TARGET` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-8

**Scenario.** The timelock upgrades a weighted leg (for example rmPROTO) to an implementation not in VITE_VAULT_EXPECTED_IMPLEMENTATION_HASH. On the mainnet dapp a direct rmPROTO deposit refuses with implementation-mismatch. A Portfolio Router deposit passes the guard because only the router is read, the preview badges the router verified, and the router forwards the leg's USDC into the unreviewed logic, which can return any share count and keep the USDC. rmpc refuses the same deposit.

**Evidence.**

- clients/dapp/src/lib/codePins.ts:184-205 pinnedWriteTarget returns only variables.address for deposit/mint, so a router.deposit pins the router alone
- clients/dapp/src/components/RouterDepositTab.tsx:282 sends router.deposit; no leg vault is passed to verifyPinnedTarget and refusedTargets is never consulted
- clients/dapp/src/lib/routerPreview.ts:203 the [bytecode verified] badge is targetCodeHashPinned(ctx, ctx.router) only
- contracts/PortfolioRouter.sol:1246 the router takes the leg vault's deposit() return value as the minted shares, so per-leg floors do not catch a leg that returns a fake count
- clients/rust-payment-client/src/upgrade.rs:270 verify_router_and_legs refuses the same router deposit unless every leg's implementation is pinned (ADR-0014 P3 record: a router deposit checks the router and every leg)
- useCodeTargetVerification already reads all four vault pins, so the refused leg is known to the page but RouterDepositTab ignores it

**Recommended fix (reviewer).** For a deposit whose target is the router, read getEffectiveWeights() at the guard's block and run verifyPinnedTarget on every leg vault (as rmpc does), refusing with a WriteTargetPinError that names the leg. Make the router preview badge require every leg in verifiedTargets, and disable the router deposit when any weighted leg is in refusedTargets.

**Regression test the reviewer asked for.** guarded-write-contract.test.tsx: mainnet class, router code and implementation pinned and matching, one leg vault's ERC-1967 slot pointing at an unpinned implementation, router.deposit is refused naming that leg and nothing reaches the wallet. router-deposit-tab.test.tsx: a leg in refusedTargets shows UNVERIFIED and disables submit.

**What the fixer changed.**

- The guard now treats a deposit into the configured router, or any deposit(amount, uint256[]) call, as a router deposit. It reads getEffectiveWeights() by eth_call at the same block as the router's own pin reads. It then runs verifyPinnedTarget on every leg vault, 0 bps legs included as rmpc does. A failure throws WriteTargetPinError with target set to the leg and a new router field; the message names the leg and the router. A failed weights read refuses with the new cause router-legs-unreadable. buildRouterPreview badges [bytecode verified] only when the router and every leg are in verifiedTargets, and it adds a warning naming any leg in refusedTargets. RouterDepositTab disables the approve, the deposit simulation and submit when any leg (from live weights or the preview) is in refusedTargets, and it shows router-leg-unverified naming the leg. The existing code-pin test for the router pin now serves getEffectiveWeights with a pinned leg so it still passes.

**Regression tests the fixer wrote (not run).**

- guarded-write-contract.test.tsx::refuses router.deposit naming the leg whose ERC-1967 slot points at an unpinned implementation, and nothing reaches the wallet; router-deposit-tab.test.tsx::a leg in refusedTargets shows UNVERIFIED, names the leg and disables submit (plus: a refused leg disables the USDC approval too; the router and every leg verified badge the deposit verified and keep submit enabled; the router verified alone is not enough for the badge); code-pin.test.tsx::a router deposit checks every leg vault (security round 2) (isRouterDeposit shape and address; leg with no code-hash pin refused naming the leg; leg code hash mismatch refused; getEffectiveWeights unreadable refused while approve still goes; badge needs router and every leg and the warning names a refused leg)

**Files changed:** `clients/dapp/src/lib/codePins.ts`, `clients/dapp/src/lib/useGuardedWriteContract.ts`, `clients/dapp/src/lib/routerPreview.ts`, `clients/dapp/src/components/RouterDepositTab.tsx`, `clients/dapp/src/lib/useVerifiedCodeTargets.ts`, `clients/dapp/README.md`, `docs/technical/dapp-topology.md`, `docs/adr/ADR-0014-governed-upgrades-and-freeze.md`, `clients/dapp/tests/unit/guarded-write-contract.test.tsx`, `clients/dapp/tests/unit/router-deposit-tab.test.tsx`, `clients/dapp/tests/unit/code-pin.test.tsx`

**Residual.** pinnedWriteTarget does not cover router.depositFor. The dapp never calls it today.

**Related.** related findings review-security-007, review-security-010; finder note: Round-1 findings 'Dapp vault and router code-hash pins only prove the target is an ERC1967Proxy' (useGuardedWriteContract.ts:93) and codePins.ts:115: the fix covers the direct target, not the proxies a router deposit reaches

### 9. Low — The dapp's rmpc config export tells operators to pin the live vault implementation hash, which defeats the reviewed-hash check

**Index:** L-003 (review-security-009)

- **Where:** `clients/dapp/src/lib/configExport.ts:138` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / clients / code
- **Class / confidence:** `SECURITY_TRUST_ON_FIRST_USE` / medium
- **Skeptics:** 2 of 3 confirmed. Votes: refuted, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-9

**Scenario.** An operator onboards with the exported TOML after the vault proxy was upgraded to unreviewed logic, and runs the suggested command. The unreviewed hash goes into proxy_implementation_hashes. rmpc check 5c then approves the very implementation it exists to refuse.

**Evidence.**

- clients/dapp/src/lib/configExport.ts:134-140 writes '#   cast keccak $(cast code $(cast implementation <vault>))' as the way to fill proxy_implementation_hashes. That command hashes whatever implementation is live.
- clients/dapp/src/lib/configExport.ts:39-42 says the export writes the key 'instead of copying the live hash'.
- The comment names only the vault. rmpc router deposits and withdraw-router also need the router's implementation hash in the same list (upgrade.rs verify_router_and_legs and verify_gateway_router).

**Recommended fix (reviewer).** Have the 8453 builder pass the reviewed vault and router implementation hashes from the release manifests, and export them as values. Otherwise, print the release-record field to copy and drop the live-read command. Name the router in the comment.

**Regression test the reviewer asked for.** Extend clients/dapp/tests/unit/configExport.test.ts: for vault_is_proxy true, assert the output contains no 'cast implementation' live-read command and contains either the reviewed hash passed in or the release-record instruction for both the vault and the router.

**What the fixer changed.**

- The export writes proxy_implementation_hashes as values from the build's vault and router implementation pins (never live reads). Without pins it writes the key commented out with the timelock.json fields for the vault and the router. The cast live-read command is gone. The runbook G4 step now names the same fields.

**Regression tests the fixer wrote (not run).**

- clients/dapp/tests/unit/configExport.test.ts::names proxy_implementation_hashes for a proxied vault without a live-read command; ::exports the reviewed vault and router implementation hashes the build pins as values

**Files changed:** `clients/dapp/src/lib/configExport.ts`, `clients/dapp/src/components/ConfigExportPanel.tsx`, `clients/dapp/src/components/buildAdminTabs.tsx`, `clients/dapp/src/components/AdminFlow.tsx`, `clients/dapp/tests/unit/configExport.test.ts`

**Residual.** The export still writes one flat cross-address pin list (round 3 left the dapp-lane half of the pin retirement fix undone).

**Related.** related findings review-security-052; finder note: P3 (issue 1810) export pin. The gateway half verifies against the build pin; the vault half does not.

### 10. Medium — Dapp vault and router code-hash pins only prove the target is an ERC1967Proxy, so mainnet deposits and approvals are never checked against the logic behind the proxy

#### SEC-M-006 (review-security-010)

- **Where:** `clients/dapp/src/lib/useGuardedWriteContract.ts:93` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / clients / code
- **Class / confidence:** `SECURITY_AUTHORITY_SUBSTITUTION` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-10

**Scenario.** The timelock executes an upgrade that swaps the PortfolioRouter or rmUSDC vault implementation for code no one reviewed. The runbook treats this as an incident, and rmpc refuses it with ErrImplementationNotApproved. The 8453 dapp still finds the unchanged ERC1967Proxy hash, so the pin passes. It badges the target '[bytecode verified]' and lets a holder approve USDC to the router and call router.deposit or vault.deposit. On the Withdraw tab it also lets the holder approve shares to the router for redeemFor. The unreviewed logic then receives the USDC or the share allowance. A tab left open across a gateway upgrade has the same gap for commit/reveal, revoke and pause, because the gateway implementation is verified only once.

**Evidence.**

- clients/dapp/src/lib/useGuardedWriteContract.ts:93-112 assertTargetPinned compares keccak256(eth_getCode(target)) with the pin. It never reads the ERC-1967 slot. pinsMatched (:64) caches a match for the whole session.
- clients/dapp/src/lib/codePins.ts:13-21 says the router pin is 'keccak256 of the PortfolioRouter runtime code' and 'A pin is the trust anchor'.
- scripts/stage/mainnet-dapp.ts:358-359 fills VITE_VAULT_EXPECTED_CODE_HASH and VITE_ROUTER_EXPECTED_CODE_HASH from the timelock manifest.
- contracts/script/DeployTimelock.s.sol:1232 and :1248 record router.codehash and vault_.codehash. Both are proxy addresses: GovernedProxyDeploy.sol:94 deploys ERC1967Proxy, and DeployVault/BasketVaultDeployBase/DeployPortfolioRouter use it.
- docs/adr/ADR-0014-governed-upgrades-and-freeze.md:110 says every proxy has the same runtime code. So every vault pin and the router pin are the same generic hash.
- clients/dapp/src/lib/gatewayVerifier.ts:17-25 states that a proxy code pin alone 'would let the dapp sign against any implementation the timelock installs'. The implementation pin was built for the gateway only.
- clients/rust-payment-client/src/upgrade.rs:33-40 makes rmpc check vault and router implementations. The dapp has no equivalent check (grep finds no vault or router IMPLEMENTATION key in clients/dapp/src).
- clients/dapp/src/lib/useVerifiedCodeTargets.ts:44 (staleTime Infinity) badges the router and vaults '[bytecode verified]' from the proxy hash. clients/dapp/src/lib/useGatewayVerifier.ts:166-175 re-verifies the gateway implementation only on connect, chain change or manual refresh. It never re-checks before a send.

**Recommended fix (reviewer).** Add build-time implementation pins for the router and for each vault, taken from the release record or manifests (the same values rmpc uses in proxy_implementation_hashes). In assertTargetPinned, read the ERC-1967 slot and the implementation code at send time, refuse an unlisted hash, and drop the session cache for proxies. Set verifiedTargets only when the implementation matches. Re-verify the gateway implementation inside the guard before each gateway write.

**Regression test the reviewer asked for.** Add a dapp unit test in tests/unit/code-pin.test.tsx. Mock eth_getCode(router) to return the pinned proxy code and eth_getStorageAt(router, ERC1967 slot) to name an implementation whose code hash is not pinned. Assert that approve(router, x) and router.deposit are refused with WriteTargetPinError and that the router preview badge reads UNVERIFIED.

**What the fixer changed.**

- pinsMatched session cache removed. Every write to VITE_GATEWAY_ADDRESS is now a pinned target, so the gateway implementation is re-read before commit/reveal, revoke and pause. useCodeTargetVerification also returns refusedTargets. The Withdraw tab then redeems from the vault directly (reason router-unverified) instead of offering a share approval the guard would refuse. approve(spender, 0) needs no pin, so a revoke always works.

**Regression tests the fixer wrote (not run).**

- clients/dapp/tests/unit/code-pin.test.tsx::refuses a deposit and an approve to a router whose proxy code matches but whose implementation is unpinned, never badges it, and still sends a redeem; ::reads the implementation again before every send: an upgrade between two deposits refuses the second; ::re-verifies the gateway implementation before every gateway write; ::pins every write to the gateway, and never an approve of zero; clients/dapp/tests/unit/withdraw-routes-through-router.test.tsx::redeems directly on a mainnet build when the chain showed the router does not match its pins

**Files changed:** `clients/dapp/src/lib/useGuardedWriteContract.ts`, `clients/dapp/src/lib/codePins.ts`, `clients/dapp/src/lib/preview.ts`, `clients/dapp/src/components/AdminFlow.tsx`, `clients/dapp/src/components/DepositWithdrawTab.tsx`, `clients/dapp/src/lib/routerRedeem.ts`, `docs/adr/ADR-0014-governed-upgrades-and-freeze.md`, `docs/technical/dapp-topology.md`, `docs/development/environments.md`, `docs/development/stage-deployment.md`, `docs/operations/contract-release-runbooks.md`

**Related.** related findings review-security-005, review-security-007, review-security-008, review-security-011, review-security-016; finder note: Same class as issue 1810 (ADR-0014 §10) and issue 1737 item 1. rmpc already covers this case. The dapp side was not addressed.

### 11. Low — Every dapp exit (direct vault.redeem and the one-leg router redeem) is disabled whenever gateway verification fails, including after an unpinned gateway upgrade

**Index:** L-004 (review-security-011)

- **Where:** `clients/dapp/src/lib/vaultPreview.ts:56` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / clients / code
- **Class / confidence:** `SECURITY_EXIT_DENIAL` / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-11

**Scenario.** The timelock executes a reviewed gateway upgrade (even a pure fix) before the 8453 dapp is rebuilt with the new hash added to VITE_GATEWAY_EXPECTED_IMPLEMENTATION_HASH. A build that carries no implementation pin hits the same path. Gateway verification turns to refused, so every vault redeem preview and every router redeem preview returns ok:false. The Withdraw button is disabled for every dapp user, although neither redeem touches the gateway. Exits through the dapp stay frozen until an operator rebuilds and redeploys it.

**Evidence.**

- clients/dapp/src/lib/vaultPreview.ts:56-62 refuses every vault preview, redeem included, when !ctx.gatewayCodeHashVerified.
- clients/dapp/src/lib/routerRedeem.ts:99-105 does the same for the router redeem preview.
- clients/dapp/src/components/DepositWithdrawTab.tsx:518 and :769: onWithdraw returns early and withdraw-submit is disabled unless redeemPreview.ok.
- clients/dapp/src/components/AdminFlow.tsx: gatewayCodeHashVerified is verification.status === 'verified'. clients/dapp/src/lib/gatewayVerifier.ts computeImplementationVerification refuses with 'implementation-mismatch' or 'implementation-pin-missing'.
- scripts/stage/mainnet-dapp.ts:356 pins exactly one implementation hash, gateway.json gateway_implementation_runtime_hash.
- clients/dapp/src/lib/codePins.ts:33-34 says 'an exit must never depend on a build setting'. DepositWithdrawTab.tsx:48 and routerRedeem.ts:22 say an exit never depends on the router (core 1494). docs/operations/contract-release-runbooks.md step 5 says 'no role can freeze them (core 1494)'.
- At base cb1d9cc5 the gateway was a direct contract, so the redeem gate could fail only through misconfiguration. On this branch, a routine timelock upgrade of the gateway is enough to trigger it.

**Recommended fix (reviewer).** Stop gating redeem previews (vaultRedeem and routerRedeem) on gatewayCodeHashVerified. Build them with ok:true, an UNVERIFIED badge and the gateway cause as a warning line. Keep deposits, approvals and gateway admin writes gated. Update codePins.ts and topology docs to match.

**Regression test the reviewer asked for.** Add a dapp unit test in tests/unit/withdraw-routes-through-router.test.tsx. Set the gateway verification state to refused with cause implementation-mismatch. Assert that withdraw-submit is enabled for a registered vault on the router route, and for an unregistered runtime-config vault on the direct route.

**What the fixer changed.**

- vaultRedeem and routerRedeem previews are built with ok:true, an UNVERIFIED badge and a new PreviewSuccess.warning carrying the gateway cause. TxPreview renders it as tx-preview-warning. Deposits and gateway writes stay refused. The vault redeem risk label stays 'unsafe' (classifyVaultRisk unchanged).

**Regression tests the fixer wrote (not run).**

- clients/dapp/tests/unit/withdraw-routes-through-router.test.tsx::keeps withdraw-submit enabled on the router route while the gateway verification is refused; ::keeps withdraw-submit enabled on the direct route for an unregistered runtime-config vault while the gateway verification is refused; gatewayVerifier.test.ts::vault redeem is built, not refused, and carries the cause as a warning

**Files changed:** `clients/dapp/src/lib/vaultPreview.ts`, `clients/dapp/src/lib/routerRedeem.ts`, `clients/dapp/src/lib/preview.ts`, `clients/dapp/src/components/TxPreview.tsx`, `clients/dapp/tests/unit/withdraw-routes-through-router.test.tsx`, `clients/dapp/tests/unit/gatewayVerifier.test.ts`

**Related.** related findings review-security-010; finder note: Core 1494 (withdrawals never frozen). Gateway verification causes from DR-9. Introduced in the dapp by the P3 implementation pin.

### 12. Low — /health still reports ok with a frozen 5-block lag when the indexer process has stopped

**Index:** L-005 (review-security-012)

- **Where:** `clients/explorer-api/src/routes.rs:302` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / indexer / code
- **Class / confidence:** `SECURITY_OPS_SILENT_HALT` (lens class: `OPS_SILENT_HALT`) / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-12

**Scenario.** The explorer-indexer container exits or is OOM-killed and is not restarted. /health keeps returning status ok, lag_blocks 5 and the old cursor indefinitely. scripts/stage/measure-catch-up.ts and any external probe on /health read a healthy index while the dapp serves stale registry status and TVL.

**Evidence.**

- clients/explorer-api/src/routes.rs:279-312: status is degraded only when the newest finished run has an error. lag_blocks uses the newest recorded chain_head_block, which stops moving when no run happens.
- indexer_progress (routes.rs:1778-1795) returns the last good run's time, but health ignores it.
- The watchdog covers this case with max_silence_secs (services/watchdog/src/liveness.rs:248-255), so /health is the only surface left blind. The QA plan X5 row claims /health halt visibility.

**Recommended fix (reviewer).** Add since_success_secs to Health and return degraded when it exceeds a budget (reuse 300 s, matching the watchdog's DEFAULT_MAX_INDEXER_SILENCE_SECS).

**Regression test the reviewer asked for.** explorer-api progress_and_admin test: the only run finished 10 minutes ago without error. Assert /health status is degraded and since_success_secs > 300.

**What the fixer changed.**

- Health now has since_success_secs, read on the DB clock from the newest successful run that has a cursor, the same row the watchdog uses. Status is degraded when that age is over HEALTH_MAX_SILENCE_SECS = 300, which matches the watchdog's DEFAULT_MAX_INDEXER_SILENCE_SECS. HTTP stays 200. I changed the test fixture indexer_runs and the progress_and_admin run() helper to finish at Utc::now(), so the existing tests that expect ok keep passing.

**Regression tests the fixer wrote (not run).**

- progress_and_admin::health_degrades_when_the_last_good_run_is_older_than_the_silence_budget (the only good run finished 600 s ago: degraded with since_success_secs > 300 and lag 5; a fresh run makes it ok again)

**Files changed:** `clients/explorer-api/src/routes.rs`, `clients/explorer-api/src/model.rs`, `clients/explorer-api/tests/progress_and_admin.rs`, `clients/explorer-api/tests/common/mod.rs`, `docs/explorer-api.md`

**Related.** finder note: DI-5 (partially fixed by X5)

### 13. Low — /v1/vault/snapshots is still not bound to the served chain

**Index:** L-006 (review-security-013)

- **Where:** `clients/explorer-api/src/routes.rs:443` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / indexer / code
- **Class / confidence:** `SECURITY_DATA_SCOPE` (lens class: `DATA_SCOPE`) / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-13

**Scenario.** With two chains indexed into one database (the shared-DB case X7 fixed for two other routes), GET /v1/vault/snapshots with no chain_id returns both chains' TVL rows mixed. The freshness block comes from the last row, which may belong to the other chain.

**Evidence.**

- clients/explorer-api/src/routes.rs:439-450: WHERE ... AND ($3::BIGINT IS NULL OR chain_id = $3) binds the caller's query chain_id, not state.chain_id.
- routes.rs:39-45 header says state.chain_id is the sole chain filter for every query. X7 fixed only /v1/vault/snapshot/latest and /v1/chains/:id/contracts (routes.rs:318-330, 362-390).

**Recommended fix (reviewer).** Bind state.chain_id and return 404 or 400 when the query chain_id differs, as list_contracts does.

**Regression test the reviewer asked for.** endpoints test: seed snapshots for chain_id 1 and the served chain. Assert /v1/vault/snapshots returns only the served chain's rows, and ?chain_id=1 is refused.

**What the fixer changed.**

- The query binds state.chain_id. A query chain_id for any other chain gets a 404, as list_contracts does.

**Regression tests the fixer wrote (not run).**

- endpoints::vault_snapshots_are_scoped_to_the_served_chain (a shadow-chain row at block 1001 is not served, freshness block is 1000, ?chain_id=8453 returns 200, ?chain_id=1 returns 404)

**Files changed:** `clients/explorer-api/src/routes.rs`, `clients/explorer-api/tests/endpoints.rs`, `docs/explorer-api.md`

**Related.** finder note: DI-9 (partially fixed by X7)

### 14. Low — The swarm preflight role guard reads COMMITTEE_AGENT_ROLE on the config's IC address, not the gateway's live icPolicy, and skips the gateway AGENT_ROLE that vote-submit also needs

**Index:** L-007 (review-security-014)

- **Where:** `clients/rust-payment-client/src/commands/committee.rs:552` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / clients / code
- **Class / confidence:** `SECURITY_GUARD_INCOMPLETE` / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **deferred** by the lane fixer. Nothing changed.
- **Ledger row:** SR-1015-14

**Scenario.** The Safe repoints the gateway at a redeployed IC policy while an operator's TOML still names the old one, where the agent holds the role. Or the agent holds COMMITTEE_AGENT_ROLE but not AGENT_ROLE on the gateway. In both cases check-agent prints has_role:true and the preflight passes. vote-submit then reverts on chain and burns gas. When the node rejects it at broadcast, the error is reported as ErrNotAllowlisted, which contradicts the preflight's own answer. The write fails safe, but the guard does not deliver the 'fails closed before any on-chain write' promise the swarm skill makes.

**Evidence.**

- clients/rust-payment-client/src/commands/committee.rs:552 run_check_agent reads hasRole on cfg.ic_policy_address only.
- contracts/gateway/RobotMoneyGateway.sol:1310 lets ADMIN change icPolicy with setICPolicy. :1353 makes committeeVoteSubmit onlyRole(AGENT_ROLE), and the call forwards to the gateway's own icPolicy.
- plugins/robotmoney-swarm/scripts/check-preflight.sh:137-150 treats has_role:true as passing guard 3.
- clients/rust-payment-client/src/commands/committee.rs:388-400: vote-submit labels any broadcast error containing 'revert' as ErrNotAllowlisted, whatever the real selector.

**Recommended fix (reviewer).** In check-agent, read gateway.icPolicy() and refuse with a named error when it differs from ic_policy_address. Also read gateway.hasRole(AGENT_ROLE, agent). In vote-submit, run the existing pre-sign eth_call simulation and decode the revert selector (AgentNotAllowlisted, CommitteeAgentNotCaller, AccessControlUnauthorizedAccount, ICPolicyNotSet) instead of matching the substring 'revert'.

**Regression test the reviewer asked for.** Extend plugins/robotmoney-swarm/tests/ic-policy-rpc-stub.py and run-tests.sh. Set gateway.icPolicy() to a different address than the config, and in a second case set hasRole(AGENT_ROLE) to false. Expect check-preflight.sh to exit non-zero (4 or 5).

**Fixer's note.**

- Not local. It needs new gateway ABI bindings (icPolicy, AGENT_ROLE, hasRole) in rmpc, a change to the check-agent JSON contract, new mocks in tests/committee.rs, new hard-coded selectors in plugins/robotmoney-swarm/tests/ic-policy-rpc-stub.py, and a vote-submit simulation decode. The finding itself says the write fails safe. Evidence still open at clients/rust-payment-client/src/commands/committee.rs:552 and :388-400.

**Residual.** Deferred. It needs new rmpc gateway ABI bindings, a change to the check-agent JSON contract, new stub selectors and a vote-submit simulation decode. The write fails safe meanwhile.

**Related.** finder note: A residual of DR-1 (fixed in U1). Guard 3 is real now but checks the wrong contract and only one of the two roles.

### 15. Medium — rmpc sends router deposits with no per-leg floors, so the round-2 LegSkippedWithFloor guard never protects agents; anyone who fills rmUSDC's TVL cap sends every agent router deposit into the basket legs

#### SEC-M-007 (review-security-015)

- **Where:** `clients/rust-payment-client/src/commands/deposit.rs:314` (line as the round 3 finder saw it)
- **Round / lane / owner:** 3 / clients / code
- **Class / confidence:** `SECURITY_ECONOMICS_ALLOCATION_DIVERSION` (lens class: `ECONOMICS_ALLOCATION_DIVERSION`) / medium
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-15

**Scenario.** The default vector routes about 9500 bps to rmUSDC and 500 bps to rmPROTO. An account deposits rmUSDC up to tvlCap; its capital earns yield, so holding the cap full costs only gas. From then on every `rmpc deposit --destination <router>` sent without floors executes 100% into the basket legs: about 20x the governed basket share, buying thin-pool tokens and paying the pool fee plus up to maxSlippageBps on the whole amount. The same follows from any rmUSDC deposit pause or exclusion the hot key opens. The account can also front-run those basket buys inside the ORA-4 band. The dapp is protected (deriveMinSharesPerLeg plus the high-risk warning); agents are not.

**Evidence.**

- clients/rust-payment-client/src/commands/deposit.rs:173-183 builds floors only from --min-shares-per-leg, and line 314 sends them; rmpc never calls router.previewDeposit (grep of src is empty)
- plugins/robotmoney-user/skills/robotmoney-user/references/write.md:73-74: 'Empty skips the per-leg slippage floor.'
- contracts/PortfolioRouter.sol:1211-1215 LegSkippedWithFloor fires only when minSharesPerLeg.length != 0
- contracts/PortfolioRouter.sol:860 _isDepositable drops a leg whose maxDeposit is 0; RobotMoneyVault._maxDepositAt returns 0 once nav >= tvlCap, and accrued yield keeps it there
- publish-contracts/src/sheet.ts:299 requires a finite, non-zero TVL cap for every vault
- No client maps the LegSkippedWithFloor error (grep of clients and plugins is empty)

**Recommended fix (reviewer).** In rmpc, derive default floors from router.previewDeposit the way the dapp's deriveMinSharesPerLeg does. Refuse, unless an explicit flag is passed, when a leg with weight above 0 is unavailable. Map LegSkippedWithFloor to a named refusal.

**Regression test the reviewer asked for.** rmpc cli_deposit test with a router mock: when previewDeposit reports a weighted leg unavailable, rmpc refuses without the opt-in flag; when every leg is available, the signed calldata carries floors equal to estShares*(1 - tolerance).

**What the fixer changed.**

- The router path now reads router.previewDeposit(amount) after the router and leg pin check. A leg with weight above 0 marked unavailable is refused as ErrLegUnavailable (the message names each vault and its bps) unless the new --allow-unavailable-legs flag is passed. With --min-shares-per-leg omitted, each available leg's floor is estShares less 50 bps. This reuses withdraw::floor_from_preview and DEFAULT_FLOOR_TOLERANCE_BPS, which match the dapp's deriveMinSharesPerLeg. A skipped or unfunded leg gets 0. A single `0` is the explicit no-floor opt-out, mirroring withdraw-router. Otherwise the flag needs one value per leg. A wrong count exits 3 before signing, the same exit code as a non-decimal value. A previewDeposit leg count that differs from the getEffectiveWeights count is refused as ErrLegUnavailable ('weight vector changed, run again'). A vault-destination depositTo keeps the vector exactly as given, so its paymentId is unchanged. The router success JSON adds min_shares_per_leg, the floors that were signed. The existing router tests' mock helper now also mocks previewDeposit with every leg available.

**Regression tests the fixer wrote (not run).**

- clients/rust-payment-client/tests/deposit_router.rs::deposit_router_refuses_weighted_unavailable_leg_without_opt_in; clients/rust-payment-client/tests/deposit_router.rs::deposit_router_signs_floors_derived_from_preview_deposit; clients/rust-payment-client/tests/deposit_router.rs::deposit_router_allow_unavailable_legs_signs_zero_floor_on_skipped_leg; clients/rust-payment-client/tests/deposit_router.rs::deposit_router_min_shares_length_mismatch_exits_before_signing; clients/rust-payment-client/src/commands/deposit.rs::tests::derived_floors_are_est_shares_less_the_tolerance; ::weighted_unavailable_leg_is_refused_without_the_opt_in; ::explicit_floors_need_one_value_per_leg_and_the_leg_counts_must_agree; ::min_shares_flag_parses_omitted_zero_and_explicit

**Files changed:** `clients/rust-payment-client/src/commands/deposit.rs`, `clients/rust-payment-client/src/cli.rs`, `clients/rust-payment-client/src/main.rs`, `clients/rust-payment-client/tests/deposit_router.rs`, `plugins/robotmoney-user/skills/robotmoney-user/references/write.md`, `plugins/robotmoney-user/skills/robotmoney-user/references/safety.md`, `plugins/robotmoney-user/skills/robotmoney-user/SKILL.md`, `plugins/robotmoney-cli/skills/robotmoney-cli/references/commands.md`, `docs/technical/rmpc-read-output-contract.md`

**Residual.** Derived floors change the on-chain paymentId, so a retry after a lost local replay cache can land twice. The fork test deposit_router_default_gas_clears_gateway_floor has not run.

**Related.** related findings review-security-018, review-security-020; finder note: Known '[low] The router silently skips a leg the caller set a non-zero minSharesPerLeg floor on' (PortfolioRouter.sol:1183): the round-2 fix only covers callers that send floors

### 16. Medium — rmpc withdraw sends gateway.withdrawFromRouter without checking the router's implementation

#### SEC-M-008 (review-security-016)

- **Where:** `clients/rust-payment-client/src/commands/withdraw.rs:419` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / clients / code
- **Class / confidence:** `SECURITY_AUTHORITY_SUBSTITUTION` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-16

**Scenario.** The router proxy is upgraded to an implementation that is not in the operator's proxy_implementation_hashes. rmpc deposit --destination <router> and rmpc withdraw-router both refuse. A plain `rmpc withdraw --source-vault V` still signs withdrawFromRouter. The unreviewed router's redeemFor can transferFrom the shares the gateway just approved to itself. The gateway's custody check still passes and no USDC is paid. rmpc decodes AgentWithdrawalRouted and reports success. Up to maxWithdrawPerPayment of the depositor's shares is lost per call.

**Evidence.**

- clients/rust-payment-client/src/commands/withdraw.rs:404-459 reads gateway.router(). When it is non-zero (the default route since U9), the command signs withdrawFromRouter. The only implementation check is run_withdraw_vault (policy/mod.rs:428, source vault only). grep finds no verify_gateway_router or verify_reached_proxy(router) in withdraw.rs.
- clients/rust-payment-client/src/commands/withdraw_router.rs:396-410 does call upgrade::verify_gateway_router for the same router.
- clients/rust-payment-client/src/upgrade.rs:33-40 states the invariant: 'a write also reads each reached vault's and the router's implementation ... and refuses unless its code hash is in proxy_implementation_hashes'.
- contracts/lib/GatewayWithdrawOps.sol:206-229 shows the gateway pulls the share receiver's shares, forceApproves the router and calls router.redeemFor. Afterwards it checks only that its own share balance is unchanged. It never checks that USDC reached assetRecipient.
- docs/adr/ADR-0014-governed-upgrades-and-freeze.md:731 lists only 'a withdraw every vault it redeems from', so the doc misses the router as well.

**Recommended fix (reviewer).** On the router route in withdraw.rs, call crate::upgrade::verify_reached_proxy(&rpc, &cfg, "router", router) (or verify_gateway_router) after reading the router and before session.submit. Refuse with ErrImplementationNotApproved, as withdraw-router does. Update ADR-0014 line 731.

**Regression test the reviewer asked for.** Add a case to tests/cli_withdraw.rs. Mock gateway.router() to return a non-zero address, and return an unpinned implementation and code from the router's ERC-1967 slot. Assert exit 2 with error ErrImplementationNotApproved and proxy 'router 0x…'. Assert that no eth_sendRawTransaction request was made.

**What the fixer changed.**

- After reading gateway.router(), a non-zero router goes through upgrade::verify_reached_proxy(rpc, cfg, "router", router) before the vault preflight, floor, simulation and signing. Refusal is ErrImplementationNotApproved with proxy 'router 0x..', exit 2. The test asserts no withdrawFromRouter simulation and no eth_sendRawTransaction. ADR-0014 line 731 now names the router.

**Regression tests the fixer wrote (not run).**

- clients/rust-payment-client/tests/cli_withdraw.rs::withdraw_refuses_a_router_whose_implementation_is_not_pinned

**Files changed:** `clients/rust-payment-client/src/commands/withdraw.rs`, `clients/rust-payment-client/tests/cli_withdraw.rs`, `docs/adr/ADR-0014-governed-upgrades-and-freeze.md`

**Related.** related findings review-security-010; finder note: A gap U9 created: withdraw started routing through the router, and P3's check of every reached proxy was never added to it.

### 17. Low — rmpc committee-identity create writes the encrypted Ed25519 identity with umask permissions (usually 0644)

**Index:** L-008 (review-security-017)

- **Where:** `clients/rust-payment-client/src/committee_identity.rs:224` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / clients / code
- **Class / confidence:** `SECURITY_KEYSTORE_HYGIENE` / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-17

**Scenario.** A swarm member runs `rmpc committee-identity create` on a shared host with umask 022. The argon2id-encrypted identity is world-readable. Another local user copies it and brute-forces a weak passphrase offline, then signs canonical swarm submissions as that member.

**Evidence.**

- clients/rust-payment-client/src/committee_identity.rs:224 uses std::fs::write(path, json), which takes the process umask.
- clients/rust-payment-client/src/signer/software.rs:443-462 write_owner_only is the 0600 helper U7 added for the EVM keystore. It is not used here.
- U7 implementer notes record this as left open: 'committee_identity.rs:224 still writes its keystore with std::fs::write ... same defect'.

**Recommended fix (reviewer).** Write the identity through the same owner-only helper: create_new with mode 0600, set the permissions before writing, then fsync. Keep the existing refusal to overwrite a file.

**Regression test the reviewer asked for.** Add a unit test in committee_identity.rs: under umask 022, CommitteeIdentity::create produces a file whose mode & 0o777 == 0o600.

**What the fixer changed.**

- New write_new_owner_only: create_new, mode 0600, set_permissions 0600 before writing, then sync_all. AlreadyExists maps to ErrIdentityExists, so the no-overwrite refusal also holds under a race.

**Regression tests the fixer wrote (not run).**

- clients/rust-payment-client/src/committee_identity.rs::tests::create_writes_owner_only_file_under_umask_022

**Files changed:** `clients/rust-payment-client/src/committee_identity.rs`

**Related.** finder note: DR-11 (2026-10-14 review, keystore hygiene). Fixed for the EVM keystore in U7. Still open for the committee identity.

### 18. Low — rmpc does not name the round-2 router revert LegSkippedWithFloor, so its pre-sign simulation calls it inconclusive and rmpc signs and broadcasts a router deposit that is certain to revert

**Index:** L-009 (review-security-018)

- **Where:** `clients/rust-payment-client/src/policy/revert.rs:168` (line as the round 3 finder saw it)
- **Round / lane / owner:** 3 / clients / code
- **Class / confidence:** `SECURITY_REFUSAL_NAME_GAP` / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-18

**Scenario.** An agent previews the router and runs `rmpc deposit --destination <router> --min-shares-per-leg a,b,c,d` with non-zero floors on every leg. Before the call a basket leg leaves its ORA-4 band (previewDeposit now reverts) or its cap fills, so the router marks that leg unavailable. The eth_call reverts LegSkippedWithFloor(leg). rmpc has no name for it, logs 'inconclusive, continuing', signs with the derived router gas limit (7.95M for 4 legs) and broadcasts. The transaction reverts on chain and burns gas. The agent sees a generic reverted write instead of ErrLegUnavailable, contrary to the skill's documented contract.

**Evidence.**

- contracts/PortfolioRouter.sol:241 and :1213 (working tree, round 2): a non-zero minSharesPerLeg floor on a skipped leg now reverts LegSkippedWithFloor(vault) instead of being silently skipped
- clients/rust-payment-client/src/policy/revert.rs:140-170: the router table maps VaultNotRegistered, VaultNotActive, VaultNotRouterEligible, VaultCapExceeded, NoWeightsSet and SlippageExceeded only; grep finds LegSkippedWithFloor in rmpc only in abi/PortfolioRouter.json (ABI was refreshed, mapping was not)
- clients/rust-payment-client/src/policy/revert.rs:72-79: an unmatched revert becomes Simulation::Inconclusive
- clients/rust-payment-client/src/write_path.rs:631-633: Inconclusive logs a warning and continues to sign and broadcast
- clients/rust-payment-client/src/commands/deposit.rs:173-183 and 300-315: --min-shares-per-leg is passed through unchanged; there is no per-leg availability preflight, so the simulation is the only gate
- plugins/robotmoney-user/skills/robotmoney-user/SKILL.md:118-120 promises that a router leg that is unavailable is refused as ErrLegUnavailable before signing; references/safety.md:70-75 has no row for LegSkippedWithFloor and says any other revert is sent

**Recommended fix (reviewer).** Map PortfolioRouter::LegSkippedWithFloor (and NoFundedLeg) to RmpcError::ErrLegUnavailable in refusal_from_revert, add both selectors to mapped_selectors_match_the_canonical_signatures, and add a LegSkippedWithFloor row to plugins/robotmoney-user/skills/robotmoney-user/references/safety.md.

**Regression test the reviewer asked for.** revert.rs unit test: LegSkippedWithFloor(address) revert data maps to ("LegSkippedWithFloor", ErrLegUnavailable). cli_deposit integration test: eth_call for depositTo returns LegSkippedWithFloor data; expect status refused, error ErrLegUnavailable, exit 2, and eth_sendRawTransaction expected 0 times.

**What the fixer changed.**

- refusal_from_revert now maps PortfolioRouter::LegSkippedWithFloor and NoFundedLeg to ErrLegUnavailable. The CLI test serves LegSkippedWithFloor revert data for the depositTo eth_call. It asserts exit 2, status refused, error ErrLegUnavailable, a message naming LegSkippedWithFloor, and eth_sendRawTransaction expected 0 times. safety.md's simulation table gains a LegSkippedWithFloor row and adds NoFundedLeg to the ErrLegUnavailable row.

**Regression tests the fixer wrote (not run).**

- clients/rust-payment-client/src/policy/revert.rs::tests::leg_skipped_with_floor_maps_to_leg_unavailable; clients/rust-payment-client/src/policy/revert.rs::tests::mapped_selectors_match_the_canonical_signatures (adds LegSkippedWithFloor(address) and NoFundedLeg()); clients/rust-payment-client/src/policy/revert.rs::tests::documented_reverts_map_to_their_reason_codes (adds NoFundedLeg); clients/rust-payment-client/tests/deposit_router.rs::deposit_router_simulated_leg_skipped_with_floor_is_refused_before_signing

**Files changed:** `clients/rust-payment-client/src/policy/revert.rs`, `clients/rust-payment-client/tests/deposit_router.rs`, `plugins/robotmoney-user/skills/robotmoney-user/references/safety.md`, `docs/technical/rmpc-read-output-contract.md`

**Residual.** The dapp has no revert-name table, so it still shows LegSkippedWithFloor unnamed.

**Related.** related findings review-security-015, review-security-020; finder note: Fix of the known finding 'The router silently skips a leg the caller set a non-zero minSharesPerLeg floor on' (contracts/PortfolioRouter.sol:1183): the contract half landed, the rmpc and plugin half did not.

### 19. Low — The router still reverts the whole deposit when a weighted basket leg fails its own market checks (ORA-4 or slippage floor); the live default vector routes 500 bps to rmPROTO behind a 100 bps guard

**Index:** L-010 (review-security-019)

- **Where:** `contracts/PortfolioRouter.sol:757` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / contracts / code
- **Class / confidence:** `SECURITY_ECONOMICS_LIVENESS_ALL_OR_REVERT` (lens class: `ECONOMICS_LIVENESS_ALL_OR_REVERT`) / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-19

**Scenario.** wETH moves 1.2% within 30 minutes, so spot sits about 1.2% from the 1800 s TWAP and rmPROTO.deposit reverts NavMarketDeviationExceeded. _availabilityAndAmounts still marks rmPROTO available. Every router deposit (dapp RouterDepositTab, gateway depositTo(router)) then reverts UsdcLegTransferFailed, including the 95% rmUSDC part, until the TWAP catches up. Once a receipt gives rmAGENT weight, any RM move past 400 bps does the same, and a griefer can force that cheaply on the thin V4 pool.

**Evidence.**

- contracts/vaults/BasketVault.sol:604 - _checkMarket(false), the ORA-4 guard, runs only inside _deposit. previewDeposit (:771) and maxDeposit (:798) do not run it.
- contracts/vaults/BasketVault.sol:636-640 - DepositBelowSlippageFloor is equally invisible to the views (rmPROTO maxSlippageBps 100, contracts/vaults/ProtocolAssetVault.sol:29).
- contracts/PortfolioRouter.sol:745-756 - the NatSpec states that a leg whose views pass but whose deposit reverts (the ORA-4 guard) still reverts. :1239-1242 rethrows UsdcLegTransferFailed.
- deployments/twin-918453/stage-sheet.env:32,55 and base-8453-rehearsal/stage-sheet.example.env:42,67 - ROUTER_WEIGHTS=USDC:9500,PROTO:500 and VAULT_PROTO_NAV_DEVIATION_BPS=100. rmPROTO holds wETH and cbBTC on 0.05% V3 pools (config/protocol-assets.json).

**Recommended fix (reviewer).** Make the router's D4 availability pass see the market check. BasketVault.maxDeposit could return 0, or previewDeposit could revert, whenever BasketViews.checkNavDeviation would revert, so the leg is skipped and the amount renormalized. Document the remaining slippage-floor residual or add a per-leg skip for it.

**Regression test the reviewer asked for.** PortfolioRouter.t.sol::test_ORA4_outsideBandBasketLegIsSkippedNotReverted: push one rmPROTO pool's spot 150 bps from its TWAP. The router deposit succeeds with rmPROTO legAmount 0 and rmUSDC taking the full amount, and previewDeposit marks rmPROTO unavailable.

**What the fixer changed.**

- BasketVault.previewDeposit now runs _checkMarket(false), so the router's quote pass drops the leg and renormalises. mint() runs the check too. The check left _deposit, so each entrypoint runs it once. maxMint uses the new non-reverting _previewDepositFloor (ERC-4626 forbids a reverting max view). Revert selectors are unchanged (NavMarketDeviationExceeded). The leftover DepositBelowSlippageFloor residual is documented in the router NatSpec and the docs. The test lives in PortfolioRouterLegAvailability.t.sol, where the real rmAGENT V4 fixture is, not in PortfolioRouter.t.sol.

**Regression tests the fixer wrote (not run).**

- contracts/test/PortfolioRouterLegAvailability.t.sol::test_ORA4_outsideBandBasketLegIsSkippedNotReverted; contracts/test/BasketVault.t.sol::test_ORA4_previewDepositRunsTheGuard_maxViewsDoNot; ::test_ORA4_idlePoolDriftInsideFeeBandDoesNotRevertRoutedDeposit rewritten (its old 'ORA-4 is not an availability signal' half moved into the new test)

**Files changed:** `contracts/vaults/BasketVault.sol`, `contracts/PortfolioRouter.sol`, `contracts/test/PortfolioRouterLegAvailability.t.sol`, `contracts/test/BasketVault.t.sol`, `docs/architecture.md`, `docs/technical/smart-contracts.md`, `docs/technical/smart-contract-invariants.md`

**Residual.** The basket DepositBelowSlippageFloor case can still revert a routed deposit. It is documented in the router NatSpec.

**Related.** related findings review-security-006, review-security-020; finder note: CS-4 and E6 (2026-10-14 pre-work, partially fixed by QA D4), RTR-5

### 20. Low — The router silently skips a leg the caller set a non-zero minSharesPerLeg floor on, so a deposit signed against an all-available preview can execute 100% into a basket

**Index:** L-011 (review-security-020)

- **Where:** `contracts/PortfolioRouter.sol:1183` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / contracts / code
- **Class / confidence:** `SECURITY_ECON_SLIPPAGE_GUARD_BYPASS` / medium
- **Skeptics:** 2 of 3 confirmed. Votes: low, refuted, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-20

**Scenario.** At launch rmUSDC's tvlCap is small (1 000 USDC in the example sheet). A user previews a 50 USDC router deposit: rmUSDC 47.5, rmPROTO 2.5, floors set on both. Before it lands, another deposit (or yield) brings rmUSDC to its cap, so maxDeposit reads 0. The router skips rmUSDC without reverting and puts all 50 USDC into rmPROTO. The user's rmUSDC floor is waived and the rmPROTO floor, sized for 2.5 USDC, no longer bounds slippage on 20x the amount; only the vault's maxSlippageBps does.

**Evidence.**

- contracts/PortfolioRouter.sol:1183 `if (!available[i]) continue;` runs before the slippage guard, so minSharesPerLeg[i] > 0 is ignored for a leg that flipped to unavailable; NatSpec 874/897 says the floor is not enforced on a skipped leg
- contracts/PortfolioRouter.sol:849-858 a vault whose own maxDeposit reads 0 is skipped: rmUSDC reads 0 once nav >= tvlCap (RobotMoneyVault.sol:715-722), which any depositor or plain yield accrual can reach; also on pause or an open exclusion
- contracts/PortfolioRouter.sol:790 round 1 added the ORA-4 spot band (a price anyone can move in the thin V4 RM pool) as another skip trigger
- clients/dapp/src/lib/routerPreview.ts:72-80 the dapp sets non-zero floors on every leg the preview showed available, and a 0 floor only on legs shown unavailable
- docs/architecture.md:296-298 requires the preview to surface skipped legs before signing 'so the user can decide whether to proceed or wait'; a leg that flips after signing bypasses that decision

**Recommended fix (reviewer).** Treat a non-zero minSharesPerLeg[i] as 'this leg must be funded': revert (for example LegUnavailable(vault)) when an unavailable leg carries a non-zero floor. Clients already pass 0 for legs the preview showed unavailable, so the round-1 skip of persistently out-of-band legs still works.

**Regression test the reviewer asked for.** PortfolioRouterLegAvailability.t.sol: preview with both legs available, derive floors, fill rmUSDC to tvlCap, call deposit with those floors; expect a revert (today it succeeds with sharesPerLeg[rmUSDC] == 0).

**What the fixer changed.**

- New error LegSkippedWithFloor(address vault). _executeLegs reverts with it when a skipped leg carries a non-zero floor. A skipped leg is either unavailable or has a computed amount of 0. A 0 floor still lets the router skip and renormalise, and that is what the dapp's deriveMinSharesPerLeg already sends. The rule also covers zero-amount legs, because a weight change between preview and execute can zero a leg the same way. So the existing test_minSharesOnSkippedLeg_isNotEnforced was inverted and renamed test_minSharesOnSkippedLeg_revertsUnlessZero. The deposit and depositFor NatSpec are updated.

**Regression tests the fixer wrote (not run).**

- contracts/test/PortfolioRouterLegAvailability.t.sol::test_RTR5_flooredLegThatTurnsUnavailableReverts; contracts/test/PortfolioRouterZeroLeg.t.sol::test_minSharesOnSkippedLeg_revertsUnlessZero

**Files changed:** `contracts/PortfolioRouter.sol`, `contracts/test/PortfolioRouterLegAvailability.t.sol`, `contracts/test/PortfolioRouterZeroLeg.t.sol`, `docs/technical/smart-contracts.md`, `docs/technical/smart-contract-invariants.md`, `docs/architecture.md`

**Related.** related findings review-security-015, review-security-018, review-security-019; finder note: Round-1 change to BasketVault.previewDeposit (ORA-4 skip) and QA plan D4 skip-and-renormalise; not the confirmed 'router reverts on ORA-4' low, which round 1 fixed.

### 21. Medium — An illiquid adapter can only be excluded through the 48-hour timelock, and in that window the EMERGENCY drain lets early redeemers take full NAV from idle

#### SEC-M-009 (review-security-021)

- **Where:** `contracts/RobotMoneyVault.sol:844` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / contracts / code
- **Class / confidence:** `SECURITY_ECONOMICS_LOSS_SOCIALIZATION_ORDER` (lens class: `ECONOMICS_LOSS_SOCIALIZATION_ORDER`) / medium
- **Skeptics:** 2 of 3 confirmed. Votes: medium, refuted, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-21

**Scenario.** rmUSDC has 900k NAV split across Aave, Compound and Moonwell at 300k each. Moonwell reaches 100% utilization or takes bad debt. Its withdraw now reverts, but totalAssets still reports 300k, so every adapter-funded redeem reverts. EMERGENCY runs emergencyWithdraw, its documented de-risk lever: 600k lands idle and Moonwell stays counted. Informed holders redeem 600k of shares at full NAV straight from idle. The Safe schedules setAdapterAllowed(moonwell,false), and 48 h later the record opens with only the remaining third of supply. If Moonwell recovers 50%, the stayers get 150k against 300k of NAV-claimed value, while the early exiters were paid 100%. Every holder should have borne the haircut pro rata; instead about 1/2 of the loss per remaining share falls on the stayers.

**Evidence.**

- contracts/lib/VaultAdapterOps.sol:320-331 - pass 1 of pullFromAdapters calls every counted adapter's withdraw with no try/catch. One illiquid counted adapter (MorphoAdapter.withdraw -> MORPHO_VAULT.withdraw reverts, contracts/adapters/MorphoAdapter.sol:129) therefore reverts every redeem that needs adapter funds.
- contracts/adapters/MorphoAdapter.sol:171-174 - totalAssets keeps reporting convertToAssets(shares) for illiquid shares (FS-VLT-10 is still open), so the adapter stays counted in NAV.
- contracts/RobotMoneyVault.sol:1073-1079 with VaultAdapterOps.sol:470-484 - emergencyWithdraw drains the healthy adapters to idle and catches the failed illiquid drain.
- contracts/RobotMoneyVault.sol:844-847 - _pullProportional pays any redeem from idle first, at a grossAssets taken from a NAV that still counts the illiquid adapter's reported value.
- contracts/RobotMoneyVault.sol:912-920 - setAdapterAllowed (ADMIN_ROLE, the timelock, 172800 s minimum delay on 8453 per stage-sheet.example.env:61) is the only lever that opens an ExclusionLedger record. syncExclusions (:943) only mirrors an eligibility change. The USDC emergencyLevers in scripts/deploy/stage-table.json have no exclude lever.
- docs/audits.md:267 - FS-VLT-8 accepted idle-first withdrawals as 'benign'. The ExclusionLedger.sol:20-33 NatSpec promises that recovery and loss belong pro rata to the holders at the moment of exclusion (core 1820).

**Recommended fix (reviewer).** Give EMERGENCY_ROLE an exclude-only lever on RobotMoneyVault, for example emergencyExcludeAdapter(index). It opens the ExclusionLedger record with totalSupply() and marks the entry uncounted, while restoring stays ADMIN-only through setAdapterAllowed and syncExclusions. Alternatively, have emergencyWithdraw and emergencyWithdrawAdapter open a record for any entry whose drain fails. Put 'exclude, then drain' in the runbook and re-disposition FS-VLT-8.

**Regression test the reviewer asked for.** RobotMoneyVault.t.sol::test_illiquidAdapterEmergencyDrainKeepsExitersAndStayersAtParity: three adapters, the Moonwell mock's withdraw reverts while totalAssets reports full value, EMERGENCY excludes then drains, holder A redeems half the supply, and the record later recovers 50%. Assert that A's (payout + claim) per share equals B's within 1 wei.

**What the fixer changed.**

- New EMERGENCY_ROLE lever emergencyExcludeAdapter(index), exclude-only and nonReentrant. It sets allowed[adapter]=false, emits AdapterAllowedSet and runs syncExclusions open-only, so the record opens with totalSupply in the same call. It does not pause; the exclusion closes deposits. Only ADMIN setAdapterAllowed(adapter,true) restores, and it drains into the record first. Permissionless syncExclusions cannot restore because the address is no longer allowed. The 'exclude, then drain' runbook rule is in security-model.md, smart-contracts.md and adapter-architecture.md. FS-VLT-8 is re-dispositioned with the corrected rationale.

**Regression tests the fixer wrote (not run).**

- contracts/test/RobotMoneyVault.t.sol::test_illiquidAdapterEmergencyDrainKeepsExitersAndStayersAtParity and ::test_emergencyExcludeAdapter_excludeOnlyAndAdminRestores; WithdrawalsNeverFrozen.t.sol::test_rmUSDC_noLeverFreezesExit_afterEmergencyDrain now pulls the new lever too

**Files changed:** `contracts/lib/VaultAdapterOps.sol`, `contracts/RobotMoneyVault.sol`, `contracts/test/RobotMoneyVault.t.sol`, `contracts/test/WithdrawalsNeverFrozen.t.sol`, `scripts/deploy/stage-table.json`, `docs/technical/smart-contracts.md`, `docs/technical/adapter-architecture.md`, `docs/technical/security-model.md`, `docs/architecture.md`, `docs/audits.md`

**Residual.** The fix gives the EMERGENCY hot key a new exclude-only lever. Issue 1705 (Q2/C6) still owns the decision on EMERGENCY authority.

**Related.** related findings review-security-022, review-security-024; finder note: SR-1012-5, FS-VLT-8, FS-VLT-10, #1705 Q2/C6, core 1820 (QA D3)

### 22. Medium — Still open (20261012 finding 5, issue 1705): the EMERGENCY hot key can write off a healthy adapter and reprice every exit, while the invariant catalogue marks this HOLDS

#### SEC-M-010 (review-security-022)

- **Where:** `contracts/RobotMoneyVault.sol:1104` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / contracts / code
- **Class / confidence:** `SECURITY_PRIVILEGE_ESCALATION` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-22

**Scenario.** A compromised or mistaken emergency key calls forceRemoveAdapter on a healthy adapter holding 50% of NAV. NAV halves at once. Every holder who redeems before ADMIN re-adds the adapter (one 48 h timelock cycle at least) is paid half. Remaining holders gain that value when it is re-added. Nothing reverts.

**Evidence.**

- contracts/RobotMoneyVault.sol:1104-1107 forceRemoveAdapter is EMERGENCY_ROLE (hot key, no timelock). For an entry with no record it opens none (contracts/lib/VaultAdapterOps.sol:502-513).
- contracts/RobotMoneyVault.sol:784-786 the ZeroPayoutDuringExclusion guard only applies while an active ineligible adapter exists, so after a force-remove a redeem burns shares for 0 USDC.
- contracts/test/SecurityReviewRecheckVaultPoc.t.sol:339-371 test_O1a: shares redeemed for 0 while the USDC stays in the adapter. Lines 374-400 test_O1b: exits are underpaid and stayers are overpaid after ADMIN re-adds.
- docs/code-review/20261012-security-review.md:37,105-115 records finding 5 as Medium, open under 1705.
- docs/technical/smart-contract-invariants.md:142 marks the EMERGENCY-lever invariant HOLDS and states 'forceRemoveAdapter, pauseDeposits and shutdownVault move no value', which test_O1b contradicts.

**Recommended fix (reviewer).** Resolve issue 1705: on forceRemoveAdapter of a funded entry, open an exclusion record (snapshot) so exiters keep their claim, and route any later recovery of that adapter into it (see the previous finding). Then correct smart-contract-invariants.md:142 so it does not claim HOLDS until the PoCs flip.

**Regression test the reviewer asked for.** Flip SecurityReviewRecheckVaultPoc.t.sol::test_O1a_forceRemoveAllFunded_redeemBurnsSharesForZero and ::test_O1b_forceRemovePartial_exitsUnderpaidStayersOverpaid to assert the exiter's ExclusionLedger claim equals its pro-rata share of the recovered balance.

**What the fixer changed.**

- A funded entry (or one whose totalAssets reverts) with no record gets one at force-remove with a totalSupply snapshot, and the vault sets _exclusionSnapshots. ACL-5 in smart-contract-invariants.md:142 now states the fixed behaviour with the new tests. audits.md SR-1012-5 is re-dispositioned fixed, and the disposition-log row and GAP-BACKLOG cite the renamed test. Decision: the ZeroPayoutDuringExclusion guard was not widened to inactive records. A zero-payout redeem after a force-remove still burns, but the claim is kept by the checkpoint.

**Regression tests the fixer wrote (not run).**

- contracts/test/SecurityReviewRecheckVaultPoc.t.sol::test_O1a_forceRemoveAllFunded_exiterKeepsFullRecoveryClaim and ::test_O1b_forceRemovePartial_exiterAndStayerShareRecoveryProRata (flipped and renamed from the redeemBurnsSharesForZero / exitsUnderpaidStayersOverpaid PoCs); ::test_O4 also asserts the kept claim

**Files changed:** `contracts/lib/VaultAdapterOps.sol`, `contracts/RobotMoneyVault.sol`, `contracts/test/SecurityReviewRecheckVaultPoc.t.sol`, `docs/technical/smart-contract-invariants.md`, `docs/audits.md`

**Related.** related findings review-security-021, review-security-026, review-security-027; finder note: 20261012 finding 5 (SR-1012-5), issue 1705, FORCEREMOVE-001; previous finding

### 23. Low — RouterGovernance and governance-decisions claim a released-but-unapplied receipt cannot exist, but the timelock can release directly and the release-receipt row then makes the receipt unappliable

**Index:** L-012 (review-security-023)

- **Where:** `contracts/RouterGovernance.sol:27` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / contracts / architecture
- **Class / confidence:** `SECURITY_ASSERTION_DRIFT` / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-23

**Scenario.** An operator follows architecture §4.9 and runs govern --row release-receipt for a committee receipt. After the 48 h delay it is released with no weights. A later apply-receipt for the same receipt is scheduled, waits another 48 h, and reverts at execute. The committee must produce a new session. Readers of RouterGovernance and governance-decisions would wrongly treat 'released' as 'applied'.

**Evidence.**

- contracts/RouterGovernance.sol:25-28 NatSpec: 'A released receipt whose weights were not applied ... cannot exist (governance-decisions.md §3.2)'.
- docs/technical/governance-decisions.md:94-95 and :208-209 repeat the claim.
- contracts/script/DeployTimelock.s.sol:1045 grants the timelock ADMIN_ROLE on ConsensusRecommendationReceipt. contracts/gateway/ConsensusRecommendationReceipt.sol:192 releaseReceipt is onlyRole(ADMIN_ROLE).
- publish-contracts/src/govern.ts:35 and docs/architecture.md:787-801 define a standalone release-receipt row for 8453 that releases without applying weights.
- contracts/RouterGovernance.sol:174 applyReceipt reverts ReceiptAlreadyReleased, so a receipt released by that row can never be applied.

**Recommended fix (reviewer).** Pick one model. Either drop the timelock's direct receipt ADMIN_ROLE grant and the standalone release-receipt row, so release only happens inside applyReceipt. Or fix the RouterGovernance NatSpec and governance-decisions.md §3.2/§3.7 to say a receipt can be released without weights and then can never be applied.

**Regression test the reviewer asked for.** RouterGovernance.t.sol::test_applyReceipt_revertsAfterStandaloneTimelockRelease (pins the chosen behavior), plus a check_governance_docs.py rule that governance-decisions.md and architecture.md agree on whether a standalone release exists.

**What the fixer changed.**

- Decision: keep the standalone release-receipt row (architecture.md, issue 1611) and fix the claim. The NatSpec, governance-decisions.md §3.2 and §3.7, and architecture.md now say such a receipt carries no weights and can never be applied (ReceiptAlreadyReleased). The new check_governance_docs.py rule 7 bans the old claim in the model docs. When architecture.md documents release-receipt, it requires governance-decisions.md to say the receipt 'can never be applied'.

**Regression tests the fixer wrote (not run).**

- contracts/test/RouterGovernance.t.sol::test_applyReceipt_revertsAfterStandaloneTimelockRelease; check_governance_docs.py rule 7 with self-test cases

**Files changed:** `contracts/RouterGovernance.sol`, `contracts/test/RouterGovernance.t.sol`, `docs/technical/governance-decisions.md`, `docs/architecture.md`, `.github/scripts/check_governance_docs.py`

**Related.** finder note: issue 1698 (C1a), issue 1611 (standalone release-receipt), C1c docs gate

### 24. Medium — A paused lending venue no longer stops rmUSDC deposits: new deposits mint at a NAV that counts the paused venue at face, and their idle slice funds par exits

#### SEC-M-011 (review-security-024)

- **Where:** `contracts/adapters/AaveV3Adapter.sol:92` (line as the round 3 finder saw it)
- **Round / lane / owner:** 3 / contracts / code
- **Class / confidence:** `SECURITY_ECONOMICS_NAV_OVERSTATEMENT_VALUE_TRANSFER` (lens class: `ECONOMICS_NAV_OVERSTATEMENT_VALUE_TRANSFER`) / medium
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-24

**Scenario.** rmUSDC holds Aave, Compound and Morpho at equal weight: N = $10M, Aave A = $3.33M. Aave's guardian pauses the Base USDC reserve (supply and withdraw revert, aToken balanceOf still reads). Before round 2 every rmUSDC and router deposit reverted. Now every deposit D mints at a NAV that counts A at par. Aave's slice of D stays idle (with capBps 3334/3333/3333 pass 2 cannot spill it). An informed holder redeems in chunks no larger than idle at par. If Aave later haircuts by h = 20%, each new depositor loses D*A*h/(N+D), about 0.67% of the deposit, and each dollar exited from idle avoids A*h/N, about 6.7%. Nothing pages the EMERGENCY key to run emergencyExcludeAdapter, so the window lasts until someone notices the Aave pause off-chain. Composition: adapter refusal hand-back (round 2) + idle-first exits + deposit gate that ignores venue health + router availability + no watchdog signal.

**Evidence.**

- contracts/adapters/AaveV3Adapter.sol:92-100 deploy(uint256) catches every POOL.supply revert, including RESERVE_PAUSED and RESERVE_INACTIVE where Aave also blocks withdraw, and sends the USDC back to the vault
- contracts/adapters/CompoundV3Adapter.sol:92 does the same for any Comet revert, including a full pause guardian pause where withdraw is paused too
- contracts/lib/VaultAdapterOps.sol:835-848 _allocate counts only what the adapter kept; the refused slice stays idle and the deposit succeeds
- contracts/RobotMoneyVault.sol:696-699 _depositsClosed only looks at allowlist, codehash, USDC() and VAULT() eligibility, never at whether a venue can be withdrawn; totalAssets (line 557) still counts the paused aToken balance at face
- contracts/RobotMoneyVault.sol:853 idle-first: a redeem no larger than idle is paid at full NAV, a larger one reverts in pullFromAdapters on the paused withdraw
- contracts/PortfolioRouter.sol:860 _isDepositable sees rmUSDC maxDeposit != 0, so the router keeps sending the rmUSDC weight in
- No service watches DeployRefused or UnroutedDeposit (grep of services/ is empty), while docs/technical/unified-vault-spec.md:933 says UnroutedDeposit is monitored
- docs/technical/security-model.md:94 and docs/audits.md:267 (FS-VLT-8) name this exact outcome, early redeemers taking full NAV from idle while the haircut falls on those who stay, as what the exclude-first order must prevent
- Tests cover only supply-paused-with-withdraw-open (RobotMoneyVaultRouteDeposit.t.sol:902,956)

**Recommended fix (reviewer).** Hand a refused supply back only for capacity refusals (Aave supply cap or frozen reserve, MetaMorpho AllCapsReached, Comet supply-only pause) and keep reverting, or expose a venueWithdrawable() view that _depositsClosed folds in, when the venue also blocks withdrawals (Aave paused or inactive reserve, Comet withdraw paused). Also alert on DeployRefused in the watchdog so EMERGENCY excludes the adapter first.

**Regression test the reviewer asked for.** RobotMoneyVaultRouteDeposit.t.sol: a mock Aave pool whose reserve is paused (supply and withdraw revert, aToken balanceOf works). Assert rmUSDC.maxDeposit() == 0 or deposit reverts, and assert no redeem is paid from idle created after the pause at a NAV that counts the paused balance.

**What the fixer changed.**

- Both of the finding's options are in. (1) Deposit gate: the new IVenueHealthAdapter.venueWithdrawable() is implemented by AaveV3Adapter (reads POOL.getConfiguration(USDC); false when bit 56 'active' is clear or bit 60 'paused' is set) and by CompoundV3Adapter (!COMET.isWithdrawPaused()). RobotMoneyVault._depositsClosed now calls VaultAdapterOps.anyActiveBlocked(_book, usdc, true). That function runs the old ineligible/exclusion loop and also staticcalls venueWithdrawable on each usable active adapter. A missing or reverting view reads as open, the same way _ceiling reads maxExposure. So maxDeposit and maxMint read 0, a deposit reverts ERC4626ExceededMaxDeposit, and the router skips the rmUSDC leg instead of reverting. The _withdraw zero-payout check calls the same library function with venues=false, so its meaning is unchanged. (2) Adapter: deploy(uint256) on Aave and Compound now hands a refused supply back only while venueWithdrawable() is true. Otherwise it reverts VenueWithdrawalsClosed(reason). This also covers keeper rebalance, which bypasses the deposit gate: it could pull a healthy venue's excess into idle and the paused venue would hand that slice back. Capacity refusals still hand back as in round 2: an Aave supply cap or frozen reserve, a Comet supply-only pause, MetaMorpho AllCapsReached. MorphoAdapter is unchanged because MetaMorpho has no pause. Vault runtime grew 36 bytes (23,363 to 23,399), leaving 1,177 bytes of margin, still above the 1,024 floor in ADR-0014 section 9. I lowered the pinned floor in VaultCodeSizeGuard.t.sol::test_vaultFamily_keepsItsMeasuredHeadroom from 1,213 to 1,177 and added a comment.

**Regression tests the fixer wrote (not run).**

- contracts/test/RobotMoneyVaultRouteDeposit.t.sol::test_venueShutsWithdrawals_depositsCloseAndNoIdleFundsParExit; contracts/test/RobotMoneyVaultRouteDeposit.t.sol::test_venueShutsWithdrawals_adapterRevertsSoRebalanceIdlesNothing; contracts/test/PortfolioRouterLegAvailability.t.sol::test_RTR5_rmUsdcLegWithPausedLendingVenueIsSkipped; contracts/test/VaultForkRegressions.t.sol::test_fork_venueHealth_pausedAaveReserveClosesDeposits

**Files changed:** `contracts/interfaces/IVenueHealthAdapter.sol`, `contracts/interfaces/IAavePool.sol`, `contracts/interfaces/IComet.sol`, `contracts/interfaces/IStrategyAdapter.sol`, `contracts/adapters/AaveV3Adapter.sol`, `contracts/adapters/CompoundV3Adapter.sol`, `contracts/lib/VaultAdapterOps.sol`, `contracts/RobotMoneyVault.sol`, `contracts/test/helpers/RefusingVenues.sol`, `contracts/test/RobotMoneyVaultRouteDeposit.t.sol`, `contracts/test/PortfolioRouterLegAvailability.t.sol`, `contracts/test/VaultForkRegressions.t.sol`, `contracts/test/VaultCodeSizeGuard.t.sol`, `docs/technical/adapter-architecture.md`, `docs/technical/smart-contracts.md`, `docs/technical/smart-contract-invariants.md`, `docs/technical/security-model.md`, `docs/architecture.md`

**Residual.** No watchdog alert exists for DeployRefused or UnroutedDeposit. docs/technical/unified-vault-spec.md still says UnroutedDeposit is monitored. The fork test that pauses the real Aave reserve has not run.

**Related.** related findings review-security-021, review-security-025; finder note: FS-VLT-8 (docs/audits.md:267), FS-VLT-10 (Morpho illiquid shares), round-2 venue-refusal fix, known finding on the 48-hour exclusion window and EMERGENCY drain

### 25. Low — A venue that refuses a supply (Aave supply cap or frozen reserve, MetaMorpho AllCapsReached, Comet supply pause) still reverts every rmUSDC deposit and every router deposit with an rmUSDC leg

**Index:** L-013 (review-security-025)

**Statement.** A venue that refuses a supply (Aave supply cap or frozen reserve, MetaMorpho AllCapsReached, Comet supply pause) still reverts every rmUSDC deposit and every router deposit with an rmUSDC leg. Round 1's _ceiling only reads the adapter's own maxExposure, yet the router NatSpec and RTR-5 now say only the basket slippage floor can still revert a routed deposit.

- **Where:** `contracts/lib/VaultAdapterOps.sol:221` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / contracts / code
- **Class / confidence:** `SECURITY_AVAILABILITY_DOS` (lens class: `SECURITY_AVAILABILITY_DOS (incomplete round-1 fix)`) / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-25

**Scenario.** Aave V3 USDC on Base reaches its supply cap, or the Moonwell Flagship curators' caps fill up. Pass 1 of `routeDeposit` gives Aave (or Moonwell) its equal-weight slice, and `deploy` reverts. Every direct rmUSDC deposit reverts. Every router deposit reverts too, because the default vector puts about 95% in rmUSDC and the router sees rmUSDC as available. Keeper `rebalance` also reverts. Withdrawals keep working. Deposits recover only when the venue frees room, after a 48 h timelock `setAdapterCap`, or when the hot key excludes the adapter (which closes rmUSDC deposits and sends every router deposit into the baskets). Anyone with enough USDC can also fill the remaining Aave cap headroom to cause this on purpose; that capital is not lost.

**Evidence.**

- contracts/lib/VaultAdapterOps.sol:221-233 `_ceiling` lowers the fill target only to `IExposureCappedAdapter.maxExposure()`. Nothing reads how much the venue will accept.
- contracts/lib/VaultAdapterOps.sol:760-769 `_allocate` does `safeTransfer` and then `adpt.deploy(amount)` with no try/catch, so a venue revert reverts the whole deposit, keeper `rebalance` and `adminRebalance`.
- contracts/adapters/AaveV3Adapter.sol:72-76 `POOL.supply` reverts at the reserve supply cap or when the reserve is frozen or paused. contracts/adapters/MorphoAdapter.sol:85-95 `MORPHO_VAULT.deposit` reverts `AllCapsReached` once every curator cap is full. contracts/adapters/CompoundV3Adapter.sol:64-71 `COMET.supply` reverts while supply is paused.
- deployments/8453/deploy-2/vault.json:2-13: production rmUSDC routes to Aave V3 USDC and Moonwell Flagship USDC (a MetaMorpho vault).
- contracts/RobotMoneyVault.sol:685-723: `maxDeposit` and `previewDeposit` do not see venue capacity. PortfolioRouter.sol:847-861 therefore marks the rmUSDC leg available, and PortfolioRouter.sol:1245-1249 turns the leg's revert into `UsdcLegTransferFailed`, which reverts the whole routed deposit.
- contracts/PortfolioRouter.sol:752-762 and docs/technical/smart-contract-invariants.md:197 (RTR-5 'CLOSED GAP') now say the only remaining revert is the basket's `DepositBelowSlippageFloor`. That is false for these venue states.

**Also reported by another lens and folded in here.**

- `contracts/lib/VaultAdapterOps.sol:767` (3 of 3 confirmed): A lending venue that refuses a supply (Aave supply cap or frozen reserve, MetaMorpho AllCapsReached, Comet supply pause) still reverts every rmUSDC deposit and every router deposit, while the round-1 docs say only the basket slippage floor remains

**Recommended fix (reviewer).** Give lending adapters a non-reverting `maxDeploy()` view: MetaMorpho `maxDeposit(address(this))`, Aave supply cap minus current supply (0 when the reserve is frozen or paused), Comet 0 while `isSupplyPaused()`. Fold it into `_ceiling` the same way `maxExposure` is folded in, so routing leaves the excess idle and emits `UnroutedDeposit`. Then correct the PortfolioRouter NatSpec and RTR-5.

**Regression test the reviewer asked for.** RobotMoneyVaultRouteDeposit.t.sol: a mock Aave pool whose `supply` reverts SUPPLY_CAP_EXCEEDED above a headroom, and a mock MetaMorpho whose `deposit` reverts AllCapsReached with `maxDeposit` reporting headroom. Assert that `vault.deposit` succeeds with the remainder placed in other adapters or idle. PortfolioRouterLegAvailability.t.sol: the same setup, asserting a router deposit with an rmUSDC leg succeeds.

**What the fixer changed.**

- I chose an adapter-side refund instead of the suggested maxDeploy() view. The single-argument deploy() of Aave, Morpho and Compound now try/catches the venue call. On a refusal it sends the USDC back to VAULT and emits DeployRefused(amount, reason). VaultAdapterOps._allocate measures what the adapter kept by the vault's USDC balance and returns `placed`. Allocated reports only that amount. Pass 1 marks a refusing entry in a bitmask so pass 2 does not ask it again, and the pass-2 cache is disabled after a refusal. adminRebalanceAllocate counts only the placed amount. Why a refund instead of a view: it covers every refusal reason, including ones no view can predict (Aave accruedToTreasury drift, a broken market). It also adds no MetaMorpho maxDeposit read, which costs about as much as totalAssets (201k gas) on every deposit. Tradeoff: a slice above the venue's remaining room is refused whole, not placed partially. That slice goes to other adapters with capBps headroom or stays idle with UnroutedDeposit. The min-out deploy(uint256,uint256) overload and Morpho's own ExposureCapExceeded check still revert. I corrected the router NatSpec (_availabilityAndAmounts, _executeLegs), the RTR-5 CLOSED GAP entry and the docs/architecture.md, smart-contracts.md and adapter-architecture.md statements.
- Same fix as above. Mocks covered: an Aave pool that reverts "51" above its headroom and "28" while frozen, a MetaMorpho that reverts AllCapsReached with maxDeposit reporting headroom, and a Comet that reverts Paused. The 'case left is the basket slippage floor' statements are now true, and the docs say why.

**Regression tests the fixer wrote (not run).**

- contracts/test/RobotMoneyVaultRouteDeposit.t.sol::test_venueRefusesSupply_depositSucceedsAndRefusedSlicesStayIdle; contracts/test/RobotMoneyVaultRouteDeposit.t.sol::test_venueRefusesSupply_keeperRebalanceDoesNotRevert; contracts/test/PortfolioRouterLegAvailability.t.sol::test_RTR5_rmUsdcLegWithFullLendingVenuesStillDeposits
- contracts/test/RobotMoneyVaultRouteDeposit.t.sol::test_venueRefusesSupply_depositSucceedsAndRefusedSlicesStayIdle; contracts/test/PortfolioRouterLegAvailability.t.sol::test_RTR5_rmUsdcLegWithFullLendingVenuesStillDeposits

**Files changed:** `contracts/adapters/AaveV3Adapter.sol`, `contracts/adapters/MorphoAdapter.sol`, `contracts/adapters/CompoundV3Adapter.sol`, `contracts/interfaces/IStrategyAdapter.sol`, `contracts/lib/VaultAdapterOps.sol`, `contracts/RobotMoneyVault.sol`, `contracts/PortfolioRouter.sol`, `contracts/test/helpers/RefusingVenues.sol`, `contracts/test/RobotMoneyVaultRouteDeposit.t.sol`, `contracts/test/PortfolioRouterLegAvailability.t.sol`, `docs/technical/smart-contract-invariants.md`, `docs/architecture.md`, `docs/technical/smart-contracts.md`, `docs/technical/adapter-architecture.md`

**Residual.** Deployed deploy-2 adapters lack the refund until they are redeployed. Deposit gas after the extra balance reads was not re-measured.

**Related.** related findings review-security-024, review-security-028; finder note: Fix is incomplete for known [low] 'Setting a Morpho exposure cap makes rmUSDC deposits and every router deposit revert' (VaultAdapterOps.sol:614) and [low] 'setAdapterMaxExposure makes the Moonwell cap a deposit kill switch' (VaultAdapterOps.sol:246): same root cause, an unguarded adapter.deploy revert.

### 26. Medium — A force-removed excluded adapter that is re-added later puts its balance into NAV for today's holders instead of the exclusion record

#### SEC-M-012 (review-security-026)

- **Where:** `contracts/lib/VaultAdapterOps.sol:502` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / contracts / code
- **Class / confidence:** `SECURITY_LIFECYCLE_VIOLATION` / high
- **Skeptics:** 2 of 3 confirmed. Votes: medium, refuted, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-26

**Scenario.** Alice and Bob each hold 50% of rmUSDC. ADMIN revokes adapter A (record 1 opens). A's venue is frozen, so restore reverts AdapterNotEmpty. Deposits stay closed, so EMERGENCY calls forceRemoveAdapter(i), which finalizes record 1 with 0 recovered. Alice redeems at the reduced NAV and keeps a claim worth 0. The venue recovers. ADMIN calls setAdapterAllowed(A,true) and addAdapter(A). A's full balance now counts in NAV, so Bob and any later depositors get all of it. Alice's pro-rata share of the recovery is gone. It fails silently: no revert and no event ties the re-added value to record 1.

**Evidence.**

- contracts/lib/VaultAdapterOps.sol:502-513 forceRemoveAdapter sets the entry inactive and _finalize closes its open record (FinalizeReason.ForceRemoved). The adapter keeps its balance.
- contracts/lib/VaultAdapterOps.sol:781-791 _finalize deletes openExclusionOf[i]. No path ever credits a closed record again.
- contracts/lib/VaultAdapterOps.sol:357-375 addAdapter scans ACTIVE entries only, so re-adding the same address appends a new, unrecorded entry.
- contracts/lib/VaultAdapterOps.sol:439-460 syncExclusions skips inactive entries, so setAdapterAllowed(adapter,true) restores nothing for the force-removed index.
- contracts/RobotMoneyVault.sol:550-560 totalAssets counts the new entry's adapter.totalAssets(), i.e. the residual the snapshot holders were owed.
- contracts/RobotMoneyVault.sol:697-704 deposits stay closed while an excluded entry is active, so ops must forceRemove to reopen deposits when the adapter cannot pay out. That makes this the normal incident path.
- contracts/test/RobotMoneyVault.t.sol:1110-1130 test_restoreRevertsWhenExcludedAdapterCannotPayOut stops at forceRemove. contracts/test/RobotMoneyVault.t.sol:414-431 proves a re-add counts the stranded balance in NAV again.
- Contradicts contracts/RobotMoneyVault.sol:546-549 ('whatever is recovered from the adapter goes to exclusionLedger, never to idle') and contracts/ExclusionLedger.sol:63-66 (ForceRemoved = loss borne by snapshot holders only).

**Recommended fix (reviewer).** Keep an exclusion record for a force-removed funded entry and key it by adapter address, not only by index. addAdapter of an address with an unsettled force-removed record must first drain the adapter into that record (reuse the restore drain in syncExclusions) or revert. Alternatively, never finalize on forceRemoveAdapter while the adapter still reports a balance.

**Regression test the reviewer asked for.** RobotMoneyVault.t.sol::test_forceRemovedExcludedAdapter_reAddCreditsSnapshotRecord: two holders, exclude A, make A unpayable, forceRemove, holder 1 redeems, make A payable, re-allow and re-add A. Assert A's balance lands in ExclusionLedger record 1, holder 1's claimable equals half of it, and totalAssets() does not rise.

**What the fixer changed.**

- forceRemoveAdapter now closes a record (ForceRemoved) only when the adapter reads an empty balance. Otherwise the record stays open on the inactive index. addAdapter scans inactive entries of the same address and runs the shared restore drain (_restore, also used by syncExclusions) into the open record before pushing the new entry, or reverts AdapterNotEmpty. vault.addAdapter is now nonReentrant because it calls the adapter. No storage change: the lookup is by address over the existing registry.

**Regression tests the fixer wrote (not run).**

- contracts/test/RobotMoneyVault.t.sol::test_forceRemovedExcludedAdapter_reAddCreditsSnapshotRecord (also updated ::test_restoreRevertsWhenExcludedAdapterCannotPayOut and ::test_addAdapter_afterForceRemoveSucceeds)

**Files changed:** `contracts/lib/VaultAdapterOps.sol`, `contracts/RobotMoneyVault.sol`, `contracts/test/RobotMoneyVault.t.sol`

**Related.** related findings review-security-022, review-security-027; finder note: 20261012 finding 5 / issue 1705 (next finding); core 1820 (D3); 20261012 review status line 25 says 1820 'narrows' finding 5, which this path defeats

### 27. Low — A force-removed funded adapter's exclusion record can only be recovered all at once by re-adding the address

**Index:** L-014 (review-security-027)

**Statement.** A force-removed funded adapter's exclusion record can only be recovered all at once by re-adding the address. The partial-recovery path the record had while the entry was active is lost, so a partly liquid or impaired venue strands even its liquid part.

- **Where:** `contracts/lib/VaultAdapterOps.sol:591` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / contracts / code
- **Class / confidence:** `SECURITY_LIFECYCLE_RECOVERY_GAP` (lens class: `SECURITY_LIFECYCLE_RECOVERY_GAP (round-1 fix side effect)`) / medium
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-27

**Scenario.** Moonwell Flagship holds 1M of rmUSDC's assets. One of its Morpho markets takes bad debt, and the MetaMorpho vault can pay out only about 70% for a long time. EMERGENCY runs `emergencyExcludeAdapter` (record R). Because the exclusion keeps rmUSDC deposits closed, EMERGENCY then force-removes the entry to reopen them, as the round-1 test shows. From then on, the 700k that is liquid cannot be credited to R. `addAdapter(moonwell)` asks for the full 1M and reverts `AdapterNotEmpty`, and no lever drains an inactive entry. Had the entry stayed active, `adminRebalance` with target 300k would have moved 700k into R. After the planned permanent freeze, no upgrade can add a lever either.

**Evidence.**

- contracts/lib/VaultAdapterOps.sol:589-594 `forceRemoveAdapter` now leaves the record open on an INACTIVE index whenever the adapter reports a balance.
- contracts/lib/VaultAdapterOps.sol:409-413 and 851-861: the only path that credits an inactive record is `addAdapter` -> `_restore`. `_restore` withdraws the WHOLE reported balance and reverts `AdapterNotEmpty` on any failure.
- Every partial drain skips inactive entries: `emergencyWithdrawOne` `_requireActive` (531), `emergencyWithdrawAll` (515-518), `adminRebalancePull` (652-653), `syncExclusions` (488). While the entry was active and excluded, `adminRebalance` could pull `current - target` into the record.
- contracts/adapters/MorphoAdapter.sol:121-136 (and the Aave and Compound v1 `withdraw`) revert on any shortfall, so `withdraw(totalAssets())` never succeeds while venue liquidity is below the position.
- contracts/RobotMoneyVault.sol:691-707: an active excluded entry keeps rmUSDC deposits closed. contracts/test/RobotMoneyVault.t.sol `test_forceRemovedExcludedAdapter_reAddCreditsSnapshotRecord` documents force-remove as the way to reopen deposits. That pushes operators, or the EMERGENCY hot key alone, onto this path.

**Also reported by another lens and folded in here.**

- `contracts/lib/VaultAdapterOps.sol:851` (3 of 3 confirmed): A force-removed adapter's balance can reach its open exclusion record only all at once through addAdapter; no lever can drain it partially

**Recommended fix (reviewer).** Add an ADMIN (or EMERGENCY) lever that withdraws up to `amount` from an inactive index with an open record and credits it through `_credit`. Or, when `addAdapter`'s full restore fails, move the open record onto the new entry instead of reverting, so the existing partial drains apply. Align ExclusionLedger and smart-contracts.md §3.4 so the listed recovery paths match what works for an inactive record.

**Regression test the reviewer asked for.** RobotMoneyVault.t.sol: an IlliquidMockAdapter variant whose `withdraw` pays at most a liquid amount L below its balance and reverts above it. Run exclude, then forceRemove, then assert that L can be credited to the open record and that holders can claim it pro rata. Today the only path, `addAdapter`, reverts `AdapterNotEmpty`.

**What the fixer changed.**

- New EMERGENCY_ROLE lever recoverRemovedAdapter(index, amount), nonReentrant, with body VaultAdapterOps.recoverRemoved. It requires an inactive index with an open record. It reverts AdapterNotFound for an active entry and NoOpenExclusion(index) for an entry with no record. The amount is clamped to the adapter's reported balance, so type(uint256).max asks for everything. It calls the plain withdraw(amount) and credits the balance delta to the record through _credit. The RecoverySource is EmergencyWithdrawAdapter, so the ledger enum and indexer decoding stay unchanged. It emits EmergencyWithdrawAdapterCalled. It finalizes the record (ForceRemoved) once the adapter reports 0. It does not pause deposits. The test shows addAdapter reverting AdapterNotEmpty at 40% liquidity, then a 40% tranche, then the rest, with claims split pro rata and NAV and share price unchanged. Vault runtime grew 174 bytes. Headroom is now 1,213 bytes, above the 1,024 ADR-0014 floor, and the VaultCodeSizeGuard floor is updated. The VaultAdapterOps code hash changed, so I rewrote the layout snapshot with check-storage-layout.sh --write RobotMoneyVault. Only the library hash moved. smart-contracts.md §3.4 and §3.8 and the ExclusionLedger NatSpec now list the paths that work for an inactive record.
- Same lever. It uses the plain withdraw(amount) with an operator-chosen tranche, not the v2 clamping withdraw(usdcWanted, 0). The v2 Morpho and Aave variants clamp only to the position, not to venue liquidity, so they would revert on partial liquidity as well. The test asserts that asking above the liquid amount reverts VenueIlliquid and moves nothing.

**Regression tests the fixer wrote (not run).**

- contracts/test/RobotMoneyVault.t.sol::test_forceRemovedPartlyLiquidAdapter_recoversTrancheByTranche
- contracts/test/RobotMoneyVault.t.sol::test_forceRemovedPartlyLiquidAdapter_recoversTrancheByTranche

**Files changed:** `contracts/lib/VaultAdapterOps.sol`, `contracts/RobotMoneyVault.sol`, `contracts/ExclusionLedger.sol`, `contracts/test/RobotMoneyVault.t.sol`, `contracts/test/VaultCodeSizeGuard.t.sol`, `contracts/test/fixtures/storage-layout/RobotMoneyVault.json`, `scripts/deploy/stage-table.json`, `docs/technical/smart-contracts.md`, `docs/technical/smart-contract-invariants.md`, `docs/architecture.md`, `docs/technical/adapter-architecture.md`

**Residual.** The new recoverRemovedAdapter lever is EMERGENCY_ROLE. Issue 1705 owns the authority decision. The illiquid-adapter runbook does not name the lever yet.

**Related.** related findings review-security-022, review-security-026; finder note: Side effect of the fix for known [medium] 'A force-removed excluded adapter that is re-added later puts its balance into NAV for today's holders' (VaultAdapterOps.sol:502). Related to the still-open 20261012 finding 5 / issue 1705 (RobotMoneyVault.sol:1104).

### 28. Low — Setting a Morpho exposure cap (new D8 lever) makes rmUSDC deposits and every router deposit revert once Morpho reaches the cap

**Index:** L-015 (review-security-028)

- **Where:** `contracts/lib/VaultAdapterOps.sol:614` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / contracts / code
- **Class / confidence:** `SECURITY_DENIAL_OF_SERVICE` / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-28

**Scenario.** Governance sets a Morpho cap C. When Morpho's live balance, or its yield alone, gets near C while Morpho is under its equal-weight target, every deposit whose pass-1 leg reaches Morpho reverts. Gateway deposit(), depositTo(vault) and depositTo(router) all revert for every agent, and so do direct router deposits for all legs. rebalance() and adminRebalance allocations revert too. Withdrawals are unaffected. It ends only when ADMIN raises the cap or lowers capBps, which takes one timelock cycle.

**Evidence.**

- contracts/RobotMoneyVault.sol:969-971 and contracts/lib/VaultAdapterOps.sol:421-426 setAdapterMaxExposure (D8) makes MorphoAdapter.maxExposure settable for the first time (it was dead control CS-8).
- contracts/adapters/MorphoAdapter.sol:85-97 _deposit reverts ExposureCapExceeded when current + amount > cap.
- contracts/lib/VaultAdapterOps.sol:230-247 pass 1 allocates min(equal-weight deficit, remaining) without reading maxExposure. contracts/lib/VaultAdapterOps.sol:607-617 _allocate calls adpt.deploy with no try/catch, so the whole vault.deposit reverts.
- contracts/PortfolioRouter.sol:841-855 _isDepositable (maxDeposit != 0) and :784 previewDeposit both pass, then :1239-1243 the leg reverts UsdcLegTransferFailed. The D4 skip-and-renormalise does not catch it, so the whole router deposit reverts.
- docs/technical/adapter-architecture.md:159-181 documents the cap as a bound on Morpho only, not as a vault-wide deposit stop.

**Also reported by another lens and folded in here.**

- `contracts/lib/VaultAdapterOps.sol:246` (3 of 3 confirmed): setAdapterMaxExposure makes the Moonwell cap a deposit kill switch: routing ignores the cap and the adapter reverts

**Recommended fix (reviewer).** Make the allocator respect the exposure cap. In _pass1Leg and _routePass2, clamp each allocation to maxExposure - current when the adapter exposes maxExposure() (staticcall, 0 = uncapped), and leave the rest for other adapters or idle. Or skip a capped leg instead of reverting.

**Regression test the reviewer asked for.** RobotMoneyVault.t.sol::test_deposit_routesAroundMorphoExposureCap: two adapters, Morpho cap below its equal-weight target. Assert vault.deposit succeeds, Morpho ends at most at cap, and the rest goes to the other adapter or idle. Add a PortfolioRouter test showing a router deposit with an rmUSDC leg still succeeds.

**What the fixer changed.**

- Covers both duplicate findings (security and economics). The new _ceiling helper is used by both routing passes. It is min(capBps slice, maxExposure()), read with a non-reverting staticcall where 0 or a missing view means uncapped. maxExposure() was added to IExposureCappedAdapter. adminRebalance still reverts on an explicit target above the cap, by design.

**Regression tests the fixer wrote (not run).**

- contracts/test/RobotMoneyVault.t.sol::test_deposit_routesAroundMorphoExposureCap; contracts/test/RobotMoneyVaultRouteDeposit.t.sol::test_maxExposureBelowTargetRoutesAroundMorpho; contracts/test/PortfolioRouterLegAvailability.t.sol::test_RTR5_rmUsdcLegWithCappedMorphoStillDeposits; MorphoAdapter.t.sol::test_maxExposure_settableThroughVault updated (one unit past the cap now stays idle with UnroutedDeposit instead of reverting)

**Files changed:** `contracts/lib/VaultAdapterOps.sol`, `contracts/interfaces/IExposureCappedAdapter.sol`, `contracts/test/RobotMoneyVault.t.sol`, `contracts/test/RobotMoneyVaultRouteDeposit.t.sol`, `contracts/test/PortfolioRouterLegAvailability.t.sol`, `contracts/test/MorphoAdapter.t.sol`, `docs/technical/adapter-architecture.md`

**Related.** related findings review-security-025; finder note: QA plan D8, prior review CS-8 (FS-VLT-10)

### 29. Info — watchdog-liveness runbook still says a held block's retry does not send the pause again

**Index:** review-security-029

- **Where:** `docs/operations/watchdog-liveness.md:41` (line as the round 3 finder saw it)
- **Round / lane / owner:** 3 / indexer / operations
- **Class / confidence:** `SECURITY_DOCS_STALE_OPERATOR_GUIDANCE` (lens class: `DOCS_STALE_OPERATOR_GUIDANCE`) / high
- **Skeptics:** 3 of 3 confirmed. Votes: info, info, info. The finder said info.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-29

**Scenario.** An operator unpauses deposits while the alert webhook is still refusing. Per the runbook they expect no further pause. The watchdog re-pauses on the next poll.

**Evidence.**

- docs/operations/watchdog-liveness.md:39-42 'sends the undelivered alert again ... and does not send the pause again'
- services/watchdog/src/watchdog.rs:335-390 since round 1 the retry re-sends pauseDeposits unless gateway.depositsPaused() reads true

**Recommended fix (reviewer).** State that a retry re-sends the pause unless depositsPaused() reads true, and that an unpause during a held cursor is undone until the alert is delivered.

**Regression test the reviewer asked for.** None needed beyond the existing check_governance_docs-style doc lint; add the sentence to the doc test if one covers this page.

**What the fixer changed.**

- The runbook now says a retry re-sends the pause unless depositsPaused() reads true, and an unpause during a held cursor is undone on the next poll until the alert is delivered. I also added one sentence: a catch-up does not trip per-hour limits on the backlog.

**Regression tests the fixer wrote (not run).**

- none; no doc lint covers this page (checked .github/scripts)

**Files changed:** `docs/operations/watchdog-liveness.md`

**Related.** related findings review-security-068; finder note: Round-1 fix for 'DI-7 held cursor plus the pause-once record stops WD-5's stuck-pause replacement'

### 30. Medium — The 8453 build proof binds the checkout HEAD, not the out/ artifacts the installed code is compared with, so an unreviewed implementation gets a release-tagged build_sha

#### SEC-M-013 (review-security-030)

- **Where:** `publish-contracts/src/build-provenance.ts:80` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / tooling / code
- **Class / confidence:** `SECURITY_PROVENANCE_BYPASS` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-30

**Scenario.** An operator with the Safe proposer role deploys implementation X built from unreviewed source. They put X's forge artifacts in the ignored out/ of a clean checkout at a real release/vN tag, or in the core checkout's out/ for the deploy-checkout path. They then run govern --row upgrade-proxy implementation=X build=<checkout>/out on 8453. git status is clean, the tag is real and CI at that sha is green. The masked code compare matches X against the planted artifact. The layout gate compares the release sha's committed snapshot, not X's real layout. The round records build_sha and build_tag of the release, and evidence-check and verify both pass afterwards. The same happens without any malice when out/ is stale from another commit. A variant needs no real tag at all: point the checkout's origin at a fork that carries a release/* tag, at a sha that has check runs in the core repo.

**Evidence.**

- publish-contracts/src/build-provenance.ts:53-58 gitDirtyLines runs `git status --porcelain --untracked-files=all`. Its own comment says ignored files such as a forge out/ do not count as changes. .gitignore ignores out/, cache/, broadcast/, node_modules/, dist/ and target/ anywhere in the tree.
- publish-contracts/src/build-provenance.ts:76 returns proof 'deploy-checkout' for any DIR inside the core checkout at coreSha without looking at DIR's contents. Line 80 calls the release gate on the checkout's HEAD sha only.
- publish-contracts/src/govern.ts:1450-1451 againstBuild calls loadArtifact(dir, artifact) on the raw out/ JSON. Nothing rebuilds DIR or compares each artifact's metadata.sources keccak256 with the files at build_sha. A grep for build-info, metadata.sources and rawMetadata in publish-contracts/src finds nothing.
- publish-contracts/src/verify/codehash.ts:93-101 masks the CBOR metadata trailer of every contract that links libraries (RobotMoneyVault, the basket vaults, the gateway). So on-chain code is not tied to source hashes even through metadata.
- publish-contracts/src/govern.ts:1441 takes the layout snapshot from the build checkout's committed fixture, not from the storageLayout of the artifact actually compared. A layout-breaking out/ therefore also passes upgradeLayoutRefusals.
- publish-contracts/src/release-tag.ts:54-60 verifyRemoteTag runs `git ls-remote --tags origin` on whatever URL the build checkout's origin names. release-gate.ts:38 spawns check-sha-green with cwd set to the build checkout. scripts/ci/check-sha-green.ts:178 then reads required-checks.json from that checkout, so the definition of 'green' comes from the commit under test.
- publish-contracts/src/verify/index.ts:246-251 re-checks only checkoutShaOfDir(dir) === build_sha. evidence-check.ts:705 (proxyRowProvenanceProblems) requires only a 40-hex string. verify/sources.ts:35 source-verifies the deploy-time implementation from the stage manifest, never the one an upgrade-proxy round installed.
- docs/development/releasing.md (round-1 text) tells the operator to deploy the new implementation by hand from the reviewed checkout, then pass build=<out/ of that checkout>. No tool step deploys or rebuilds it.

**Also reported by another lens and folded in here.**

- `publish-contracts/src/build-provenance.ts:55` (3 of 3 confirmed): The 8453 build gate proves only the checkout's HEAD and tracked files: the compared forge out/ is git-ignored, so any artifact set passes as a release-gated build

**Recommended fix (reviewer).** In proveBuild on 8453, prove the artifacts as well as the HEAD. Either rebuild DIR's contracts into a fresh temporary out/ from `git worktree add <sha>` and compare against that, or check every artifact the round loads (the proxied contract and each linked library) by matching its metadata.sources[*].keccak256 against `git show <sha>:<path>`. Pin the remote tag check to the canonical core URL instead of `origin`. Run check-sha-green with the deploy checkout's reviewed required-checks.json rather than the build checkout's. Add the upgraded implementations from proxy_upgrades to verifySources. Apply the same checks to the deploy-checkout path, because out/ is ignored there too.

**Regression test the reviewer asked for.** publish-contracts/tests/build-provenance.test.ts: make a temp git repo with a release/v1 annotated tag at HEAD and a clean tree. Write out/RobotMoneyVault.sol/RobotMoneyVault.json whose metadata.sources hash differs from the committed contracts/RobotMoneyVault.sol. Assert that proveBuild (or the new artifact check) on chain 8453 throws GOVERN. Add a second case where the checkout's origin URL is not the canonical repo and assert RELEASE_TAG_REMOTE_MISMATCH.

**What the fixer changed.**

- On 8453 proveBuild now requires DIR to be exactly <checkout>/out on both the release-gate and deploy-checkout paths. Each compared artifact and every linked library (recursively) must carry forge metadata whose compilationTarget names that contract and whose every sources[*].keccak256 equals keccak256 of the file at the build sha, read from git objects (cat-file --batch, submodule gitlinks followed), never the working tree. govern passes the proxy artifact to the proof for upgrade and freeze and memoizes the gate per checkout and sha. verify holds an upgrade round's build to the same rule on 8453. verifySources now covers the implementation of each executed upgrade (bound to the current address). Residual by design: a hand-forged artifact that copies the reviewed metadata next to other bytecode still passes; only a forge rebuild at the sha closes that, and it is deferred. The verify of deploy-time contracts against <coreDir>/out is not source-checked yet.
- Same fix as the finding above. The stale feature-branch scenario and the <coreDir>/build/out scenario both refuse with GOVERN before connectSafe. The layout snapshot still comes from the build checkout's committed fixture. The artifact is now bound to that same commit's sources, so both refer to one commit.

**Regression tests the fixer wrote (not run).**

- publish-contracts/tests/build-provenance.test.ts::a clean checkout at a real release tag whose ignored out/RobotMoneyVault.sol/RobotMoneyVault.json was compiled from other sources is refused with GOVERN; ::a checkout whose origin is not the canonical repository is refused with RELEASE_TAG_REMOTE_MISMATCH, before CI is asked, though the remote holds the same tag; ::every linked library is followed; ::sources are read from the commit, never from the working tree, and a submodule's from the commit its gitlink pins; publish-contracts/tests/verify/proxies.test.ts::an executed upgrade-proxy round (now a real checkout, stale metadata and deeper out/ fail); publish-contracts/tests/verify-stage.test.ts::security round 2: a proxy an executed upgrade-proxy round moved has the round's implementation source-verified
- publish-contracts/tests/upgrade-rows.test.ts::a clean, tagged checkout whose ignored out/ holds a stale feature build of the gateway is refused with GOVERN before the Safe is read; nothing is scheduled; ::the deployment checkout is held to the same rule: an out/ deeper in it, or its own out/ without the deploy sha's metadata, is refused; publish-contracts/tests/build-provenance.test.ts::the build must be the checkout's own out/: an ignored directory deeper in the checkout is refused, on the deployment-checkout path too

**Files changed:** `publish-contracts/src/build-provenance.ts`, `publish-contracts/src/govern.ts`, `publish-contracts/src/verify/codehash.ts`, `publish-contracts/src/verify/index.ts`, `publish-contracts/src/verify-stage.ts`, `publish-contracts/src/release-tag.ts`, `publish-contracts/src/release-gate.ts`, `publish-contracts/src/cli.ts`, `docs/operations/contract-release-runbooks.md`, `docs/adr/ADR-0014-governed-upgrades-and-freeze.md`

**Residual.** A real 8453 upgrade needs out/ rebuilt at the release sha. Operators whose origin still names robotmoney-monorepo are refused until it names robotmoney-core.

**Related.** related findings review-security-034, review-security-035, review-security-040; finder note: Fix is incomplete for the round-1 findings 'upgrade-proxy and freeze-proxy bind the installed code to an arbitrary build directory' and 'upgrade-proxy accepts any build=DIR as the reviewed build' (govern.ts:1378).

### 31. Low — The owner-signer pre-check before stage 1 counts specs only: duplicate or non-owner specs still pass, and prove-control refuses after stages 1-10 broadcast

**Index:** L-016 (review-security-031)

- **Where:** `publish-contracts/src/cli.ts:389` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / tooling / code
- **Class / confidence:** `SECURITY_RELIABILITY_PRECHECK_GAP` (lens class: `RELIABILITY_PRECHECK_GAP`) / high
- **Skeptics:** 2 of 3 confirmed. Votes: low, low, refuted. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-31

**Scenario.** An 8453 publish passes three --owner-signer specs for a 3-owner sheet. Two point at the same keystore, or one is a stale non-owner device. Stages 1-10 broadcast. prove-control then exits CONTROL_NOT_PROVEN. The run needs a --resume with corrected specs while the deployer still holds every role.

**Evidence.**

- cli.ts:384-392 ownerSignerShortfall compares i.specs.length with sheet.safeOwners.length only.
- prove-control.ts:238-246 duplicates and missing owners are detected only at stage 11 time, after stages 1-10.
- A hardware spec carries its owner (@0xOWNER, signers.ts:145). A keystore JSON carries its address unencrypted. Both can be matched to the sheet before stage 1 with no passphrase.
- cli.ts:159 USAGE promises the shortfall is caught before stage 1, never after stages 1-10 have broadcast.

**Recommended fix (reviewer).** Before stage 1 on 8453, resolve each spec's claimed owner (hardware @0xOWNER, keystore JSON address field). Refuse unless they cover the sheet's SAFE_OWNERS exactly once each.

**Regression test the reviewer asked for.** cli test: 8453 publish with three specs where two name the same owner (or one names a non-owner) exits before any forge call.

**What the fixer changed.**

- claimedOwnerOf reads a hardware spec's @0xOWNER or a keystore JSON's unencrypted address. The pre-check refuses an identical spec twice, two claims of one owner, or a claim outside SAFE_OWNERS. A claim that cannot be read before the passphrase is left to prove-control, so existing fixtures with nonexistent keystore paths still pass.

**Regression tests the fixer wrote (not run).**

- publish-contracts/tests/floors.test.ts::ownerSignerShortfall: the same spec twice, two specs that claim one owner, or a claim outside SAFE_OWNERS is refused; an unreadable claim is left to prove-control; publish-contracts/tests/floors.test.ts::main(): an 8453 publish whose specs name one owner twice, or a non-owner, exits CONTROL_NOT_PROVEN before any signer or forge call

**Files changed:** `publish-contracts/src/owner-signers.ts`, `publish-contracts/src/cli.ts`, `publish-contracts/tests/floors.test.ts`

**Related.** finder note: DT-1, qa-plan B1

### 32. Medium — The evidence secret scan misses prefixed secret assignments (CHAIN_SIGNER_PASSWORD=, ETH_KEYSTORE_PASSWORD=, *_API_KEY=) and a 'passphrase' key

#### SEC-M-014 (review-security-032)

- **Where:** `publish-contracts/src/evidence-check.ts:1452` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / tooling / code
- **Class / confidence:** `SECURITY_SECRET_SCAN_GAP` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, low, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-32

**Scenario.** A debug step or a tee'd log line writes `CHAIN_SIGNER_PASSWORD=<deployer passphrase>` (or `ETH_KEYSTORE_PASSWORD=...`, or an RPC `*_API_KEY=`) into the evidence folder. `evidence-check --evidence` reports the folder clean. The secret ships with the published evidence.

**Evidence.**

- evidence-check.ts:1452 the 'secret assignment' regex starts with \b before PASSWORD, API_KEY, PRIVATE_KEY and the others. In CHAIN_SIGNER_PASSWORD the '_' before 'PASSWORD' is a word character, so \b never matches. PASSPHRASE is not in the list.
- A probe run of scanEvidenceFolder flagged only 'PASSWORD=hunter2hunter2'. It returned no hit for SAFE_OWNER_A_PASSWORD=, ETH_KEYSTORE_PASSWORD=, CHAIN_SIGNER_PASSWORD=, ALCHEMY_API_KEY=abcdefghijk12345 or {"passphrase": "hunter2hunter2"}.
- floors.ts:15 lists ETH_KEYSTORE_PASSWORD as plaintext signing material. signers.ts:112-113 CHAIN_SIGNER_PASSWORD is the production deployer passphrase hand-off.
- evidence-check.ts:1713 the production --evidence check runs scanEvidenceFolder alone. The literal-passphrase search in ci/scan-rehearsal-secrets.ts:21 covers rehearsals only.
- tests/evidence-secret-scan.test.ts:39 tests only the exact name ETH_PASSWORD=.

**Recommended fix (reviewer).** Drop the leading \b, or use (?:^|[^A-Za-z0-9]) plus an optional [A-Z0-9_]*_ prefix, so any *_PASSWORD, *_PASSPHRASE, *_API_KEY, *_SECRET, *_PRIVATE_KEY or *_MNEMONIC assignment matches. Add PASSPHRASE and SECRET to the list.

**Regression test the reviewer asked for.** evidence-secret-scan.test.ts: lines `CHAIN_SIGNER_PASSWORD=hunter2hunter2`, `ETH_KEYSTORE_PASSWORD=hunter2hunter2`, `ALCHEMY_API_KEY=abcdefghijk12345` and `{"passphrase": "hunter2hunter2"}` are each flagged.

**What the fixer changed.**

- The leading \b is replaced by (?<![A-Za-z0-9]) plus an optional WORD_/WORD- prefix. PASSPHRASE, PASSWD and SECRET were added. The bare TOKEN rule keeps its old boundary so an ERC-20 token field is not flagged.

**Regression tests the fixer wrote (not run).**

- publish-contracts/tests/evidence-secret-scan.test.ts::a prefixed password, passphrase or API key assignment is found, each on its own line; publish-contracts/tests/evidence-secret-scan.test.ts::mutation: the redacted forms and names that only contain a secret word scan clean

**Files changed:** `publish-contracts/src/evidence-check.ts`, `publish-contracts/tests/evidence-secret-scan.test.ts`

**Related.** finder note: issue 1689, QA plan v1 E8

### 33. Medium — A govern resume against a fresh run manifest silently drops the issue-1686 pause interlock: a cwd-relative default evidence dir and a printed resume command without --evidence let a pending unpause execute after a recorded pause-all

#### SEC-M-015 (review-security-033)

- **Where:** `publish-contracts/src/govern.ts:652` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / tooling / code
- **Class / confidence:** `SECURITY_INTERLOCK_BYPASS` / medium
- **Skeptics:** 3 of 3 confirmed. Votes: medium, low, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-33

**Scenario.** Stage 13 schedules unpause-PROTO round 1 on 8453 and exits GOVERN_PENDING. During the 48 h window the emergency key holder runs pause-all with the run's --evidence. A pause entry is recorded there. Two days later the operator runs the printed resume command from another shell directory (or drops a custom --evidence), adding --counts-dir when the release gate asks for it. runStages makes a new empty manifest. govern adopts the scheduled operation and finds no pause entry. It executes the unpause and reopens the vault the emergency holder closed.

**Evidence.**

- cli.ts:532 the default evidence dir is resolve(cwd, 'evidence/publish-<chain>-<sha12>'). It depends on the working directory.
- govern.ts:652 resumeCommand, printed in every GOVERN_PENDING exit (govern.ts:685-688), lists '--rpc, --sheet, --signer, --environment and --owner-signer' and omits --evidence. verify-stage.ts:253 does include --evidence for the redeploy row, so the omission is not deliberate.
- runner.ts:1163 runStages builds newManifest when no run manifest exists. Nothing refuses a govern run whose manifest has no finished timelock stage.
- govern.ts:864 the pending operation is adopted from the chain with seq 0. govern.ts:893-917 refuseIfPausedSince reads pause entries from this evidence dir only. A fresh manifest has none, so nothing refuses.
- runbook contract-release-runbooks.md:410-418 promises govern refuses before it sends when a pause entry is newer than a pending unpause.

**Recommended fix (reviewer).** Make every follow-on verb (govern, verify, pause-all) refuse with RESUME when the run manifest is missing or has no finished timelock stage. Make resumeCommand print the absolute --evidence path plus --counts-dir and --counts-require-origin-dev. Consider requiring --evidence on 8453.

**Regression test the reviewer asked for.** cli test: `govern` with an --evidence dir holding no publish-run.json exits RESUME before connectSafe. govern test: resumeCommand output contains `--evidence <abs path>`. Twin test: schedule an unpause in dir A, run pause-all in A, then run govern from another cwd: it must refuse.

**What the fixer changed.**

- runStages refuses RESUME when every selected stage is verify or govern and no run manifest exists, and govern also when the timelock stage is not done. resumeCommand prints --evidence <absolute path>, --counts-dir and --counts-require-origin-dev from new optional RunContext fields the CLI sets. pause-all keeps its existing missing-manifest RESUME but is not held to a finished timelock stage, because pause-all before the handover is legitimate. --evidence was not made mandatory on 8453.

**Regression tests the fixer wrote (not run).**

- publish-contracts/tests/runner.test.ts::security round 1: follow-on runs continue the deployment's own run manifest (govern with an --evidence dir that holds no publish-run.json exits RESUME before the Safe is read; govern on a run manifest with no finished timelock stage exits RESUME; the printed resume command names the run's absolute --evidence dir and its counts flags)

**Files changed:** `publish-contracts/src/runner.ts`, `publish-contracts/src/govern.ts`, `publish-contracts/src/cli.ts`, `docs/operations/contract-release-runbooks.md`, `publish-contracts/tests/runner.test.ts`

**Residual.** --evidence is still optional on 8453.

**Related.** related findings review-security-045; finder note: issue 1686, issue 1688

### 34. Medium — upgrade-proxy accepts any build=DIR as the reviewed build and never compares storage layouts, so an unreviewed or layout-breaking implementation passes every tool gate on 8453

#### SEC-M-016 (review-security-034)

- **Where:** `publish-contracts/src/govern.ts:1378` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / tooling / code
- **Class / confidence:** `SECURITY_PROVENANCE_BYPASS` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-34

**Scenario.** On 8453 at a release-tagged green sha, an operator builds a modified RobotMoneyVault (reordered state variable or an extra transfer path) in /tmp/x, deploys it at 0xB and runs govern --row upgrade-proxy --admin-arg proxy=rmUSDC implementation=0xB build=/tmp/x/out. The masked compare passes, the Safe transaction is presented as an upgrade to the reviewed build, the evidence records the release sha, and the post-upgrade verify compares 0xB with /tmp/x/out again and skips the layout identifier check. No CI layout gate or reviewer ever saw that build, and every tool gate is green.

**Evidence.**

- publish-contracts/src/govern.ts:1378-1382 buildDirFor returns the operator's build= path verbatim; nothing checks it is a git checkout, its sha, a release tag or CI status
- publish-contracts/src/govern.ts:1438 upgradeRefusals binds the target only through againstBuild(code, buildDir, artifact): the target equals whatever out/ the operator named
- publish-contracts/src/cli.ts:402-407 and :636 the 8453 release gate (release tag + check-sha-green) binds only coreDir/a.coreSha; govern.ts:1442 still records core_sha: ctx.coreSha for an implementation built elsewhere
- publish-contracts/src/verify/index.ts:244-246 after an executed upgrade the code label compares the implementation with up.buildDir, the same operator-chosen directory
- publish-contracts/src/verify-stage.ts:173-177 an upgraded proxy's layout_hash falls back to the checkout snapshot, so the deploy-vs-checkout layout label (verify-stage.ts:312-313) never fires; upgrade-rows.ts has no layout rule at all
- publish-contracts/src/upgrade-rows.ts:3-4 header claims the module binds every operation to a reviewed build

**Recommended fix (reviewer).** Resolve build= to a git checkout and, on 8453 (and in evidence), require a clean checkout at a release-tagged check-sha-green sha; record build_sha. Before scheduling, compare the live implementation's layout (deploy manifest <field>_layout_id or the last upgrade's recorded layout) with the build checkout's snapshot under the append-only rules of storage_layout_gate.compare; record both layout ids in proxy_upgrades and make verify/evidence-check compare them.

**Regression test the reviewer asked for.** publish-contracts/tests/upgrade-rows.test.ts: on 8453 an upgrade-proxy whose build= is not a clean release-tagged green checkout, or whose layout snapshot moves an existing variable relative to the live layout id, is refused with GOVERN and nothing is scheduled; evidence-check refuses a proxy_upgrades entry without build_sha and layout ids.

**What the fixer changed.**

- build= is proven by build-provenance.ts proveBuild: it must sit in a git checkout (HEAD recorded as build_sha). On 8453 the checkout must be clean and pass assertReleaseGate (tag of the sheet's kind, remote tag, green CI, no counts); the deployment checkout at --core-sha is accepted as already gated. The upgrade row compares the live layout (last executed round's build_layout_hash, else the deploy manifest's <field>_layout_id while the proxy runs the deployed implementation) with the build checkout's snapshot under the storage rules ported from storage_layout_gate.compare (variables, gaps, structs, linearization, GovernedUpgrade). Library-code and OZ-commit rules are not applied live-vs-build: they are code, covered by the masked compare and CI. Records carry build_sha, build_tag, build_proof, live_layout_hash, build_layout_hash (named *_hash so the evidence secret scan's public-hash allowlist covers the 64-hex values). Verify now records an upgraded proxy's layout as layout_source upgrade-round, held to its build checkout's snapshot, so the layout label can fire.

**Regression tests the fixer wrote (not run).**

- publish-contracts/tests/upgrade-rows.test.ts::security round 1: the build an upgrade or a freeze compares with is a reviewed release, and its layout keeps the live one (7 tests: untagged RELEASE_SHA_UNTAGGED before connectSafe, no checkout / dirty checkout GOVERN, clean gated checkout records build_sha+tag, layout that moves a live variable refused on 8453 and Twin, append-only layout passes, missing live id or snapshot refused on 8453 only, evidence-check refuses entries without build_sha/layout hashes); publish-contracts/tests/layout-immutability.test.ts::an upgraded proxy carries the layout its round recorded, held to the snapshot of the round's build checkout; publish-contracts/tests/evidence-check.test.ts::an upgrade-round layout identifier that differs from its build checkout's snapshot is refused

**Files changed:** `publish-contracts/src/build-provenance.ts`, `publish-contracts/src/layout-compare.ts`, `publish-contracts/src/upgrade-rows.ts`, `publish-contracts/src/govern.ts`, `publish-contracts/src/verify-stage.ts`, `publish-contracts/src/proxies.ts`, `publish-contracts/src/evidence-check.ts`, `publish-contracts/tests/upgrade-rows.test.ts`, `publish-contracts/tests/layout-immutability.test.ts`, `publish-contracts/tests/evidence-check.test.ts`

**Related.** related findings review-security-030, review-security-035, review-security-037; finder note: ADR-0014 §4 and §8; storage-layout gate enum finding

### 35. Medium — upgrade-proxy and freeze-proxy bind the installed code to an arbitrary build directory: no release gate covers the code they install on 8453, and verify and evidence trust the recorded build_dir

#### SEC-M-017 (review-security-035)

- **Where:** `publish-contracts/src/govern.ts:1378` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / tooling / code
- **Class / confidence:** `SECURITY_TRUST_ROOT` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-35

**Scenario.** On 8453 production an operator runs `govern --row upgrade-proxy --admin-arg proxy=rmUSDC --admin-arg implementation=0xI --admin-arg build=/home/op/feature/out`. 0xI is built from an untagged, unmerged commit with no CI. Every tool check passes. The Safe description shows only addresses, so the owners sign. After 48 h the upgrade executes. verify compares 0xI with the recorded build_dir and passes. The evidence entry names the deployment sha. freeze-proxy can then lock that unreviewed implementation forever through the same path.

**Evidence.**

- govern.ts:1378-1382 buildDirFor returns `--admin-arg build=DIR` as given, else the run manifest's last proxy_upgrades[].build_dir, else <coreDir>/out. Nothing checks that DIR is a checkout, which sha it holds, or that the sha has a release tag or green CI.
- govern.ts:1438 upgradeRefusals compares the target only with loadArtifact(buildDir); govern.ts:1517-1518 does the same for every freeze target.
- govern.ts:1442 records core_sha: ctx.coreSha (the deployment sha, not the sha the new implementation was built from). The build's commit is never recorded.
- cli.ts:634-639 the release gate runs on --core-sha (the deployment sha) only. The implementation being installed is never gated.
- verify-stage.ts:132-139 upgradesOf takes build_dir from the editable run manifest. verify/index.ts:245 compares the upgraded implementation with that build_dir, so verify reports green against the same arbitrary build.
- evidence-check.ts:737-863 checkEvidenceOnChain chain-checks unpauses, releases, applications, clears and redeploys. It never re-reads proxy_upgrades or proxy_freezes schedule/execute txs (only the Twin --proxy-lifecycle mode does).
- upgrade-rows.ts:4 claims the rows bind every operation to a reviewed build. ADR-0014 lines 650-651 repeat it. runbook contract-release-runbooks.md:623 leaves 'the reviewed release checkout' as a manual step.

**Recommended fix (reviewer).** Require build=DIR to sit inside a clean git checkout whose HEAD carries an annotated release tag of the sheet's kind. Run assertReleaseGate (requireCounts false) on that sha before anything is scheduled. Record build_sha in proxy_upgrades and freeze records. Make verify and evidence-check refuse a build_dir whose checkout sha differs from build_sha or is untagged. Add proxy_upgrades and proxy_freezes to checkEvidenceOnChain.

**Regression test the reviewer asked for.** govern upgrade-proxy test: build=DIR in a checkout at an untagged sha refuses with RELEASE_SHA_UNTAGGED before connectSafe. Freeze-proxy test: the same for a freeze. Verify test: a proxy_upgrades entry whose build_dir checkout is not at its build_sha fails the code-hash label.

**What the fixer changed.**

- An explicit build= is proven before connectSafe; default and recorded build dirs are proven when the round is planned. The CLI passes its release-gate seams to runGovern as buildGate. Freeze records build_shas per proxy. Verify fails the code label when a recorded build_sha does not match the checkout holding build_dir. checkEvidence (8453) refuses proxy_upgrades without build_sha/live_layout_hash/build_layout_hash and proxy_freezes without build_shas per proxy. checkEvidenceOnChain now chain-checks proxy_upgrades and proxy_freezes through checkProxyLifecycleOnChain (schedule/execute events, rebuilt calls, delay, Upgraded/UpgradesFrozen, frozen state now); that on-chain addition has no dedicated new test.

**Regression tests the fixer wrote (not run).**

- publish-contracts/tests/upgrade-rows.test.ts::on 8453 an upgrade-proxy whose build= is a checkout at an untagged sha is refused with RELEASE_SHA_UNTAGGED before the Safe is read; nothing is scheduled; publish-contracts/tests/upgrade-rows.test.ts::on 8453 a freeze-proxy whose build= is a checkout at an untagged sha is refused with RELEASE_SHA_UNTAGGED before the Safe is read; publish-contracts/tests/verify/proxies.test.ts::an executed upgrade-proxy round: the proxy is expected on the round's target and compared with the round's build (extended: a build dir not at the recorded build_sha fails the code-hash label, the same build in a checkout at that sha passes, a moved checkout fails again)

**Files changed:** `publish-contracts/src/govern.ts`, `publish-contracts/src/cli.ts`, `publish-contracts/src/verify/index.ts`, `publish-contracts/src/verify/types.ts`, `publish-contracts/src/verify-stage.ts`, `publish-contracts/src/evidence-check.ts`, `publish-contracts/tests/upgrade-rows.test.ts`, `publish-contracts/tests/verify/proxies.test.ts`

**Related.** related findings review-security-030, review-security-034, review-security-038, review-security-040; finder note: issue 1809, ADR-0014 §4-§5, QA plan v1 P2 and L1

### 36. Low — After redeploy-vault the retired rmPROTO proxy drops out of freeze-proxy proxy=all, the per-proxy verify labels and the immutability statement, so a release can claim immutable core logic while a fund-holding proxy stays upgradeable

**Index:** L-017 (review-security-036)

- **Where:** `publish-contracts/src/govern.ts:1479` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / tooling / code
- **Class / confidence:** `SECURITY_LIFECYCLE_GAP` / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-36

**Scenario.** On a Base rehearsal (DEPLOYMENT_KIND=rehearsal, UPGRADE_MODE=upgradeable) rmPROTO is redeployed and some holders stay in the retired proxy. Later govern --row freeze-proxy --admin-arg proxy=all freezes the nine table proxies and reports done, verify records core_logic_immutable=true and evidence-check accepts an immutability_claim. The retired proxy is still upgradeable by the timelock, so the exit logic of the remaining holders can still change, and no tool path can freeze it on 8453.

**Evidence.**

- publish-contracts/src/redeploy-vault.ts:672-675 keeps the old proto manifest as .retired-N.json and renames the new one over it, so tableProxies and proxyAddressOf (govern.ts:1376) resolve rmPROTO to the new vault only
- publish-contracts/src/govern.ts:1479 the freeze set is tableProxies(t); parseFreezeArgs (upgrade-rows.ts:56-61) accepts only table names; the generic --call path is refused on 8453 (govern.ts:736)
- publish-contracts/src/verify/index.ts:968-1010 redeployChecks for retired[...] checks code, status and links but never upgradeAuthority, upgradesFrozen or the admin/beacon slots
- publish-contracts/src/verify-stage.ts:333 immutabilityOf runs over table names only; evidence-check.ts:233-236 accepts an immutability_claim once those names read frozen
- publish-contracts/src/redeploy-vault.ts:88-91 the verb runs on 8453 rehearsal and Twin; the retired vault keeps holders' shares withdraw-only (verify/index.ts:963-966)

**Recommended fix (reviewer).** Treat every vault_redeploys old_vault that is a proxy as a proxy of the deployment: include it in freeze-proxy proxy=all and let it be named, add the eight proxy labels for it in redeployChecks, and include it in immutabilityOf and evidence-check names so an immutability_claim is refused while it reads unfrozen. Until then, refuse redeploy-vault in upgradeable mode.

**Regression test the reviewer asked for.** publish-contracts/tests/redeploy-vault.test.ts or upgrade-rows.test.ts: after an executed redeploy round, freeze-proxy proxy=all includes the retired proxy; verify fails retired[PROTO] upgradesFrozen when it reads unfrozen after a freeze-all; evidence-check refuses an immutability_claim.

**What the fixer changed.**

- retiredProxiesOf names each deployed or governed redeploy's old vault <vault>.retired-<n>. freeze-proxy proxy=all includes it, and it can be named alone. Its build is the deployment checkout unless build= names another. verify-stage withRetiredProxies keeps core_logic_immutable false until an executed freeze froze its address. evidence-check refuses an immutability_claim on the same rule. Deferred: the eight per-proxy verify labels for a retired proxy in redeployChecks.

**Regression tests the fixer wrote (not run).**

- publish-contracts/tests/upgrade-rows.test.ts::proxy=all freezes the retired rmPROTO proxy in the same batch; it can also be named alone; publish-contracts/tests/upgrade-rows.test.ts::the verify record keeps core logic upgradeable while no executed freeze froze the retired proxy; publish-contracts/tests/evidence-check.test.ts::a claim is refused while a vault a redeploy replaced is not frozen by an executed proxy_freezes entry

**Files changed:** `publish-contracts/src/redeploy-vault.ts`, `publish-contracts/src/govern.ts`, `publish-contracts/src/verify-stage.ts`, `publish-contracts/src/evidence-check.ts`, `publish-contracts/tests/upgrade-rows.test.ts`, `publish-contracts/tests/evidence-check.test.ts`

**Residual.** The eight per-proxy verify labels for a retired vault proxy were not added (tooling lane, round 1).

**Related.** related findings review-security-044; finder note: ADR-0014 §5 (immutable only when every proxy reads frozen); issue 1796

### 37. Medium — The upgrade-time layout gate (layout-compare.ts) has no enum rule, so an enum insert or reorder in VaultRegistry.VaultStatus or BasketAssetConfigGuard.Venue passes the only gate tied to the live layout

#### SEC-M-018 (review-security-037)

- **Where:** `publish-contracts/src/layout-compare.ts:62` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / tooling / code
- **Class / confidence:** `SECURITY_LAYOUT_GATE_GAP` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-37

**Scenario.** Commit X1 reorders VaultStatus to {Active, Retired, DepositsPaused} and reruns --write. It lands on dev with a red forge-unit-tests run. X2 on top is green, because --base now compares X1's snapshot with X2's. An admin tags X2 and the operator runs upgrade-proxy proxy=registry against it. upgradeLayoutRefusals compares the deploy-time snapshot with X2's and finds no variable, struct or linearization change, so it passes. After execution every Retired vault (for example the old rmPROTO a redeploy replaced) reads as DepositsPaused, which ADMIN can reactivate. A Venue reorder sends each basket asset's swaps to the wrong venue the same way.

**Evidence.**

- publish-contracts/src/layout-compare.ts:10 says 'Keep in step with storage_layout_gate.py compare'. The LayoutSnapshot interface (line 15) has no enums field.
- layoutAppendOnlyProblems (layout-compare.ts:47-74) compares variables on slot, offset, bytes and type label (line 62), then structs (line 70) and linearization. It never reads the 'enums' key.
- scripts/ci/storage_layout_gate.py:311-319 (round-1 fix) fails a changed enum member list. ADR-0014 §8 (lines 320-324) lists 'a storage enum's existing members change in any way' as a failing rule.
- contracts/test/fixtures/storage-layout/VaultRegistry.json:45 stores `mapping(address => enum VaultRegistry.VaultStatus)`. ProtocolAssetVault.json:248 stores `enum BasketAssetConfigGuard.Venue` inside the AssetInfo struct. A reorder keeps both type labels and the struct member list byte-identical, so neither the variable rule nor the struct rule fires.
- publish-contracts/tests: grep finds no enum case for upgradeLayoutRefusals or layoutAppendOnlyProblems.
- The CI --base check, the other gate that sees enums, anchors only to the previous tip or PR base (see the ci finding). The 8453 release gate checks only that the tagged sha itself is green.

**Also reported by another lens and folded in here.**

- `publish-contracts/src/layout-compare.ts:46` (3 of 3 confirmed): upgrade-proxy's live-vs-build layout compare ignores enum members, so a build that inserts or reorders a VaultStatus, Venue or Stance member passes on 8453
- `publish-contracts/src/layout-compare.ts:46` (3 of 3 confirmed): upgrade-proxy's live-versus-build layout compare has no enum rule, so a reordered VaultStatus or Venue passes the only live-anchored layout check

**Recommended fix (reviewer).** Port the enum rule into layoutAppendOnlyProblems. For each enum in live.enums that next still reaches, require next.enums[e] to start with the live member list. When the live snapshot predates enum recording (no 'enums' key) and a stored variable or struct member has an enum type, refuse on 8453 rather than pass.

**Regression test the reviewer asked for.** publish-contracts/tests/upgrade-rows.test.ts: build a live snapshot with enums {'enum VaultRegistry.VaultStatus': ['Active','DepositsPaused','Retired']}. Build a copy with the members reordered, plus one with a member inserted before the last. Assert upgradeLayoutRefusals({mainnet: true, ...}) returns a refusal for both. Assert that an appended member passes.

**What the fixer changed.**

- LayoutSnapshot gains an enums map, and asLayoutSnapshot validates it. layoutAppendOnlyProblems ports the Python rule: every live enum still present in the build must start with the live member list. A build snapshot that stores an enum but records no members for it is refused on every chain. With requireEnums (passed as mainnet by upgradeLayoutRefusals), a live or build snapshot without an enums key is refused when storage holds any enum.
- Duplicate of the enum finding above, with the same fix. The probe case (VaultStatus=[Active, Sunsetting, DepositsPaused, Retired]) now returns one refusal naming enum VaultRegistry.VaultStatus.
- Duplicate of the enum finding, with the same fix. Decision: on 8453 a snapshot without an enums key is refused only when storage holds an enum. A snapshot whose storage holds no enum has nothing to compare, so it is not refused. That avoids blocking upgrades of enum-free contracts.

**Regression tests the fixer wrote (not run).**

- publish-contracts/tests/upgrade-rows.test.ts::a member inserted before Retired, or the members reordered, is refused naming the enum, on 8453 and elsewhere; ::mutation: a member appended at the end passes; ::on 8453 a live snapshot recorded before enums were (no enums map) is refused while storage holds an enum; elsewhere it passes as before
- publish-contracts/tests/upgrade-rows.test.ts::a member inserted before Retired, or the members reordered, is refused naming the enum (real VaultRegistry.json, insert Sunsetting before Retired) ; ::a reordered BasketAssetConfigGuard.Venue inside the basket vaults' AssetInfo struct is refused
- publish-contracts/tests/layout-compare.test.ts::a live enum [A, B, C] against a build [A, D, B, C] is refused, and so is a reorder or a removal; ::mutation: a live enum [A, B, C] against a build [A, B, C, D] passes; ::with requireEnums (8453) a snapshot that records no enum members while storage holds an enum is refused, live or build; ::a build snapshot that still stores the enum and records none of its members is refused on every chain

**Files changed:** `publish-contracts/src/layout-compare.ts`, `publish-contracts/src/upgrade-rows.ts`

**Related.** related findings review-security-004, review-security-034, review-security-046, review-security-047; finder note: Round-1 [medium] 'Storage-layout gate records enums only by type label' (storage_layout_gate.py:144): the Python gate is fixed, its TypeScript twin used at upgrade time is not. Composes with the ci finding on --base anchoring.

### 38. Low — The 8453 build gate runs the gated checkout's own check-sha-green.ts and required-checks.json, and checks the tag against that checkout's own origin

**Index:** L-018 (review-security-038)

- **Where:** `publish-contracts/src/release-gate.ts:38` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / tooling / code
- **Class / confidence:** `SECURITY_TRUST_ROOT` / medium
- **Skeptics:** 2 of 3 confirmed. Votes: low, refuted, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-38

**Scenario.** A clean checkout of a fork has its origin set to the fork. It has an annotated release/vX tag pushed there and a committed check-sha-green.ts that exits 0 (or an empty required-checks.json). Used as build= on 8453, it passes every step of the gate. The round records build_tag release/vX and build_proof release-gate for a commit that does not exist in robotmoney/robotmoney-core. This needs a deliberate operator choice, so it is low.

**Evidence.**

- publish-contracts/src/govern.ts:796 and publish-contracts/src/cli.ts:713 pass coreDir: i.checkout, the build checkout being gated, into assertReleaseGate
- publish-contracts/src/release-gate.ts:33,38 spawn the relative path scripts/ci/check-sha-green.ts with cwd set to that checkout, so the checkout under test supplies the verifier
- scripts/ci/check-sha-green.ts:178 reads required-checks.json from its own directory, which is also inside the gated checkout
- publish-contracts/src/release-tag.ts:54-64 verifyRemoteTag compares the tag object with the checkout's own `origin`, and nothing checks the origin URL
- publish-contracts/src/release-gate.ts:157 reads the release tags from the gated checkout

**Recommended fix (reviewer).** For the build gate, run the tool's own check-sha-green.ts and required-checks.json (from the deployment checkout or OWN_CORE_DIR) with --repo CORE_REPO and cwd set there. Verify the tag with `git ls-remote https://github.com/robotmoney/robotmoney-core refs/tags/<tag>` instead of the checkout's origin.

**Regression test the reviewer asked for.** publish-contracts/tests/release-gate or plan-gate: build gate against a temporary checkout whose origin is a local bare repo with the tag, and whose scripts/ci/check-sha-green.ts exits 0. The gate must still call the tool's own script and refuse (RELEASE_TAG_REMOTE_MISMATCH or CI_NOT_GREEN).

**What the fixer changed.**

- ReleaseGateInput gains ciDir: check-sha-green.ts and its required-checks.json now run from ciDir. cli.ts and the govern default pass the deployment checkout as ciDir. The default remote check is now verifyCanonicalRemoteTag. It requires the origin's effective URL (ls-remote --get-url, after any insteadOf rewrite) to be robotmoney/robotmoney-core in the ssh, https or token-https form, else RELEASE_TAG_REMOTE_MISMATCH, and credentials are redacted from the message. This default also applies to the main CLI release gate, which shares assertReleaseGate.

**Regression tests the fixer wrote (not run).**

- publish-contracts/tests/build-provenance.test.ts::the gate runs the deployment checkout's check-sha-green, never the build checkout's own (which exits 0 on anything); ::the seam receives the deployment checkout as the directory to run check-sha-green in; ::a url.<base>.insteadOf in the checkout's config that rewrites the canonical URL to another repository is refused; ::the origin forms of the canonical repository pass, every other repository is refused, and the tag is read only after the origin passed

**Files changed:** `publish-contracts/src/release-gate.ts`, `publish-contracts/src/release-tag.ts`, `publish-contracts/src/govern.ts`, `publish-contracts/src/cli.ts`

**Related.** related findings review-security-035, review-security-039, review-security-040; finder note: Round-1 build-provenance fix (build-provenance.ts) and the known finding on CORE_REPO / GITHUB_REPOSITORY (release-gate.ts:176).

### 39. Low — The 8453 release gate asks check-sha-green about the caller's GITHUB_REPOSITORY, which is the devops repo inside the devops workflow

**Index:** L-019 (review-security-039)

- **Where:** `publish-contracts/src/release-gate.ts:176` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / tooling / code
- **Class / confidence:** `SECURITY_RELIABILITY_GATE_WRONG_SUBJECT` (lens class: `RELIABILITY_GATE_WRONG_SUBJECT`) / low
- **Skeptics:** 2 of 3 confirmed. Votes: low, low, refuted. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-39

**Scenario.** A devops Actions job runs publish or govern on 8453. GITHUB_REPOSITORY is the devops repo, so the script lists check-runs for a core sha in the wrong repo. That returns HTTP 422 and exit 2, which becomes CI_NOT_GREEN. Every gated 8453 run is refused, including stage 13 after the 48 h delay. The failure is safe, and E4 widens it from the plan job to every broadcast. Not verified, because the devops workflow is outside this repo.

**Evidence.**

- publish-contracts/src/release-gate.ts:28 spawns bun scripts/ci/check-sha-green.ts <sha> with no --repo.
- publish-contracts/src/release-gate.ts:176 forwards GITHUB_REPOSITORY from the CLI environment. cli.ts:473 sets env = process.env.
- scripts/ci/check-sha-green.ts:162-166 resolveRepo prefers GITHUB_REPOSITORY over the core default.
- docs/technical/security-model.md:304 says the mainnet workflow lives in the devops repo and checks core out.

**Recommended fix (reviewer).** Pass --repo robotmoney/robotmoney-core, either as a constant or from the core checkout's origin. Stop forwarding GITHUB_REPOSITORY.

**Regression test the reviewer asked for.** In a release-gate test with env GITHUB_REPOSITORY=<devops-repo>, assert that the spawned argv carries --repo robotmoney/robotmoney-core.

**What the fixer changed.**

- CORE_REPO = robotmoney/robotmoney-core (check-sha-green's own default). checkShaGreenArgv always passes --repo. GITHUB_REPOSITORY is no longer forwarded. The CheckShaGreen seam gains a repo field.

**Regression tests the fixer wrote (not run).**

- publish-contracts/tests/plan-gate.test.ts::check-sha-green is asked about robotmoney/robotmoney-core, never the caller's GITHUB_REPOSITORY

**Files changed:** `publish-contracts/src/release-gate.ts`, `publish-contracts/tests/plan-gate.test.ts`

**Related.** related findings review-security-038; finder note: core 1601 (plan gate), QA plan E4 (issue 1816)

### 40. Medium — A local refs/replace ref makes an untagged commit pass the 8453 release-tag gate for both the deploy and the upgrade/freeze build

#### SEC-M-019 (review-security-040)

**Statement.** A local refs/replace ref makes an untagged commit pass the 8453 release-tag gate for both the deploy and the upgrade/freeze build. Verify, evidence-check and the dapp pin builder then carry its build_tag forward without checking it again.

- **Where:** `publish-contracts/src/release-tag.ts:20` (line as the round 3 finder saw it)
- **Round / lane / owner:** 3 / tooling / code
- **Class / confidence:** `SECURITY_TRUST_ROOT` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-40

**Scenario.** The operator's build checkout is clean at commit Y, which is an unreviewed PR head with green CI on the canonical repo. Its origin is the real robotmoney/robotmoney-core, and it holds one extra ref: refs/replace/<release/1.0 tag object> pointing to a forged tag on Y. govern --row upgrade-proxy build=<that checkout>/out runs on 8453. releaseTagsFor returns release/1.0 for Y. verifyCanonicalRemoteTag passes against GitHub. check-sha-green passes from the deployment checkout. artifactSourceProblems passes, since the artifacts are Y's own committed sources. Y's layout snapshot is append-only, so the layout check passes. The round is scheduled with build_proof release-gate and build_tag release/1.0. After the delay, verify passes, evidence-check passes, and the dapp builder pins the implementation. The same replace ref passes the deploy gate for --core-sha Y. There the CI script also comes from Y's own checkout. The remaining controls are the Safe signers' review and the 48 h timelock.

**Evidence.**

- publish-contracts/src/release-tag.ts:17-26 spawnGit runs Bun.spawn(['git', ...args]) with the caller's full process.env. It does not use gitEnv() and does not pass --no-replace-objects, unlike every other proving git call (build-provenance.ts:69,78, release-gate.ts:93,157).
- publish-contracts/src/git-env.ts:1-6 says every git child that proves the core checkout drops GIT_* and turns replace refs off, because 'a refs/replace ref could fake ancestry'. release-tag.ts breaks that rule.
- publish-contracts/src/release-tag.ts:31 releaseTagsFor peels each tag with for-each-ref %(*objectname), and that peel follows replace refs. Lines 85-88 (verifyRemoteTag) compare the unpeeled tag object id from rev-parse with ls-remote.
- Reproduced with git 2.43 in the scratchpad. Steps: clone a repo whose annotated tag release/1.0 points at X, commit Y, write a forged tag object for Y, then run 'git replace <tagobj> <forged>'. Result: for-each-ref reports release/1.0 -> Y, while rev-parse and ls-remote both still return the genuine tag object. git status --porcelain stays empty, and adding --no-replace-objects brings back X.
- publish-contracts/src/release-gate.ts:179-181 assertReleaseGate trusts tagForKind and then verifyCanonicalRemoteTag. The canonical-origin check added in round 2 passes because origin really is robotmoney/robotmoney-core.
- publish-contracts/src/cli.ts:657-660 runs the deploy gate on every 8453 broadcasting run. cli.ts:716 and build-provenance.ts:234-236 run the build gate, and a pass records proof 'release-gate' with the genuine tag name.
- Composition: verify/index.ts:250-266 only checks that the build dir HEAD equals the recorded build_sha. evidence-check.ts:284-290 only checks that build_sha is 40 hex. Nothing reads build_tag again. scripts/stage/mainnet-dapp.ts:381-400 then pins that round's implementation_code_hash into the dapp's implementation pins.

**Recommended fix (reviewer).** In release-tag.ts, run every git call with env: gitEnv() and --no-replace-objects. Peel the tag with 'git --no-replace-objects cat-file -p <tagobj>' (or rev-parse <tag>^{commit} with the same env), not with for-each-ref. Run the remote comparison as 'git ls-remote https://github.com/robotmoney/robotmoney-core refs/tags/<tag>' from a neutral cwd, not from inside the checkout under test, so its repo-local config (core.sshCommand, http.proxy) cannot answer. Optionally have evidence-check and verify re-prove build_tag -> build_sha with the GitHub API.

**Regression test the reviewer asked for.** publish-contracts/tests/release-tag.test.ts: build a temp repo with an annotated release/1.0 on X and a commit Y. Add a replace ref from the tag object to a forged tag on Y. Assert releaseTagsFor(dir, Y) is [] and releaseTagsFor(dir, X) is ['release/1.0']. Run it again with GIT_DIR in process.env pointing at another repo and assert the same result.

**What the fixer changed.**

- I reproduced the bypass with git 2.43 in the scratchpad. spawnGit now runs 'git --no-replace-objects' with gitEnv() plus the proxy env vars only. verifyCanonicalRemoteTag still asserts the canonical origin. It then runs ls-remote of https://github.com/robotmoney/robotmoney-core from an empty mkdtemp dir with GIT_CEILING_DIRECTORIES set, so no repo-local config answers. It also requires the remote's peeled tag^{} to equal the gated sha. assertReleaseGate passes i.sha as a new optional third RemoteTagCheck argument, so existing seams stay compatible. I did not add the optional GitHub API re-proof of build_tag in evidence-check or verify. The gate-time remote peel already binds the tag to the sha on the canonical repo.

**Regression tests the fixer wrote (not run).**

- publish-contracts/tests/release-tag.test.ts::a refs/replace ref that swaps the genuine release tag object for a forged tag on an untagged commit does not tag that commit; publish-contracts/tests/release-tag.test.ts::a GIT_DIR in the caller's environment that names another repository is not read: the same result; publish-contracts/tests/release-tag.test.ts::with the sha, the remote must peel the tag to it: a remote whose tag names another commit is refused; publish-contracts/tests/release-tag.test.ts::neutral: ls-remote runs outside the checkout, so a url.<base>.insteadOf in the checkout's config cannot answer for the remote; publish-contracts/tests/release-tag.test.ts::verifyCanonicalRemoteTag asks the canonical https URL, from a directory that is not the checkout, for the tag and its peeled commit

**Files changed:** `publish-contracts/src/release-tag.ts`, `publish-contracts/src/release-gate.ts`, `publish-contracts/README.md`, `docs/operations/contract-release-runbooks.md`

**Residual.** The tag gate now reaches GitHub over https from a neutral directory, so an ssh-only network fails closed. Evidence-check and verify do not re-prove build_tag through the GitHub API.

**Related.** related findings review-security-030, review-security-035, review-security-038; finder note: Fix is incomplete for the round-2 finding '[low] The 8453 build gate runs the gated checkout's own check-sha-green.ts ... checks the tag against that checkout's own origin' (publish-contracts/src/release-gate.ts:38), and it also reaches the core 1524 deploy gate.

### 41. Low — A proxy read-back that throws after a stage is marked done leaves no proxy_gate record, so --resume skips the stage and later stages build on an unchecked proxy

**Index:** L-020 (review-security-041)

- **Where:** `publish-contracts/src/runner.ts:941` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / tooling / code
- **Class / confidence:** `SECURITY_FAIL_OPEN_ON_ERROR` / medium
- **Skeptics:** 2 of 3 confirmed. Votes: low, refuted, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-41

**Scenario.** The vault stage broadcasts, then the read-back hits an RPC outage on every retry and throws. On --resume the vault stage is skipped as done and refuseAfterFailedProxyGate finds no record, so registry, router, gateway and the timelock handover run on a proxy the tool never read. The forge script's own _deployProxy requires and the stage-12 verifier still check it, so this only matters when the script itself was altered.

**Evidence.**

- publish-contracts/src/runner.ts:941-944 rec.status = "done" is saved before the proxy gate runs
- publish-contracts/src/runner.ts:947 proxyStageGate can throw: readUntil rethrows the last RPC error (publish-contracts/src/safe/read-after-write.ts:55-59) and an unreadable manifest throws MANIFEST (runner.ts:792)
- publish-contracts/src/runner.ts:948-951 proxy_gate is written only when the gate returns
- publish-contracts/src/runner.ts:1177 --resume skips every done stage; runner.ts:813-816 refuses only on proxy_gate.ok === false, not on a missing record

**Recommended fix (reviewer).** Run the gate before marking the stage done, or record proxy_gate {ok:false, problems:[read error]} on any exception, and make refuseAfterFailedProxyGate require proxy_gate.ok === true for every done stage that deploys proxies.

**Regression test the reviewer asked for.** publish-contracts/tests/proxies.test.ts: a proxy read-back that throws on every retry leaves --resume refusing the next stage until the read-back passes.

**What the fixer changed.**

- recordProxyGate records proxy_gate {ok:false, read_error:true} on a throw and exits VERIFY. Before any forge stage, refuseAfterFailedProxyGate re-reads every done proxy stage whose gate is missing or read_error, and refuses until it passes. A gate that found problems stays final.

**Regression tests the fixer wrote (not run).**

- publish-contracts/tests/proxies.test.ts::a proxy read-back that throws on every retry is a failed gate: --resume reads it again first and refuses the next stage until the read-back passes

**Files changed:** `publish-contracts/src/runner.ts`, `publish-contracts/tests/proxies.test.ts`

**Related.** finder note: issue 1809 runner proxy gate

### 42. Low — A refused confirmation at the safe stage leaves a started record with the predicted Safe address, and --resume then fails on a Safe that was never created

**Index:** L-021 (review-security-042)

- **Where:** `publish-contracts/src/runner.ts:1072` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / tooling / code
- **Class / confidence:** `SECURITY_RELIABILITY_STATE_CORRUPTION` (lens class: `RELIABILITY_STATE_CORRUPTION`) / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-42

**Scenario.** First stage of an 8453 publish: the reviewer mistypes the stage name, or the CONFIRM=environment floor refuses at confirmStage. Nothing is sent. Every rerun with --resume dies with NOT_A_SAFE. The only exits are a fresh evidence directory or a hand edit of publish-run.json.

**Evidence.**

- runner.ts:1072-1074 the confirm callback saves stages.safe = {status: started, safe: predicted} before runner.ts:1075 confirmStage.
- runner.ts:1154 a rerun without --resume is refused (RESUME).
- runner.ts:1046 with --resume, prior.safe plus no safe.json goes to adoption. safe/safe.ts:62 connectSafe throws NOT_A_SAFE because nothing was created.
- E2 fixed the identical pattern in redeploy-vault.ts:592-602 only.

**Recommended fix (reviewer).** Call confirmStage before saving the predicted address, as E2 did for the redeploy. Or make the resume adoption treat 'no code at the recorded address and deployer nonce unchanged' as a fresh safe stage.

**Regression test the reviewer asked for.** runner test: refuse the typed confirmation at the safe stage, then rerun with --resume: the Safe stage runs normally instead of throwing NOT_A_SAFE.

**What the fixer changed.**

- confirmStage now runs before the predicted address is saved, as E2 did for the redeploy. The forge stages still save started before confirm, but their resume path handles that.

**Regression tests the fixer wrote (not run).**

- publish-contracts/tests/runner.test.ts::a refused confirmation at the safe stage leaves no record: the --resume creates the Safe normally instead of adopting one that was never created

**Files changed:** `publish-contracts/src/runner.ts`, `publish-contracts/tests/runner.test.ts`

**Related.** finder note: DT-4, QA plan v1 E2

### 43. Low — upgrade-proxy rounds are keyed by (proxy, implementation, call) with no round number, so an earlier executed or skipped record silently blocks a later upgrade or rollback to that implementation

**Index:** L-022 (review-security-043)

- **Where:** `publish-contracts/src/upgrade-rows.ts:89` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / tooling / code
- **Class / confidence:** `SECURITY_STALE_STATE` / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, medium. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-43

**Scenario.** rmUSDC runs A. The operator upgrades A to B (key kB executed), then rolls back to A (kA executed). After investigation B is cleared and the operator runs upgrade-proxy implementation=B: kB is complete, the tool prints the old scheduled and executed lines and exits successfully while the chain still runs A. Likewise an earlier no-op run to A (recorded skipped) makes a later emergency rollback from B to A report 'already runs A' and schedule nothing.

**Evidence.**

- publish-contracts/src/upgrade-rows.ts:89 upgradeRecordKey hashes only implementation and call
- publish-contracts/src/govern.ts:603 rowComplete is true for skipped, executed or cancelled records
- publish-contracts/src/govern.ts:1419 and 1456-1460 a complete record only reprints its old phases; the chain is not read
- publish-contracts/src/govern.ts:1426-1432 a run whose target is already live writes a permanent skipped record
- publish-contracts/src/govern.ts:1396-1408 reopenCancelled reopens only scheduled operations that no longer exist

**Recommended fix (reviewer).** Give upgrade rounds a round counter like the unpause rows (key and salt include the round), start a new round whenever the live implementation differs from the target, and read the live slot before reporting a complete or skipped record.

**Regression test the reviewer asked for.** publish-contracts/tests/upgrade-rows.test.ts: A to B to A then B again schedules a new round; a skipped record for A does not block a later rollback from B to A.

**What the fixer changed.**

- A completed (executed or skipped) record is archived under <key>:round-n and round n+1 opens when the live implementation slot differs from the target. The salt already carried labelOf(name), so the new round is a new operation id.

**Regression tests the fixer wrote (not run).**

- publish-contracts/tests/upgrade-rows.test.ts::A to B to A, then B again schedules a NEW round (a new operation) instead of reprinting the round that executed first; publish-contracts/tests/upgrade-rows.test.ts::a skipped record for A does not block a later rollback from B to A

**Files changed:** `publish-contracts/src/govern.ts`, `publish-contracts/src/upgrade-rows.ts`, `publish-contracts/tests/upgrade-rows.test.ts`

**Related.** finder note: ADR-0014 §4 upgrade path

### 44. Low — Upgrade and freeze history is keyed by proxy name, so after a redeploy-vault the new vault inherits the old vault's freeze/upgrade: verify fails and the automatic pause-all fires

**Index:** L-023 (review-security-044)

- **Where:** `publish-contracts/src/verify-stage.ts:157` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / tooling / code
- **Class / confidence:** `SECURITY_LIFECYCLE_GAP` / medium
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-44

**Scenario.** On a Base mainnet rehearsal, freeze-proxy proxy=all executes and records rmPROTO by name at the old address. A vault fix is then needed, and after a freeze the only path is redeploy-vault rmPROTO. The redeploy's verify at the redeploy sha reads freezesOf, finds 'rmPROTO' frozen by row, and expects the new, unfrozen vault to read frozen. The label fails, and the automatic pause-all pauses all four vaults. With an earlier upgrade-proxy of rmPROTO instead, verify expects the new vault's slot to hold the old upgrade's implementation, and any later upgrade-proxy of the new rmPROTO is refused for lack of a live layout id.

**Evidence.**

- publish-contracts/src/verify-stage.ts:157-163 freezesOf collects proxies[].name; :134-139 upgradesOf and upgradeLayoutsOf are keyed by e.proxy (the name), never by proxy_address
- publish-contracts/src/verify/index.ts:313,329-331 the expected implementation slot and expectFrozen use these maps by mp.name
- publish-contracts/src/redeploy-vault.ts:168-179 the round-1 fix names the old vault <vault>.retired-<n> only for freezes planned after the redeploy. Once deployed, the vault's stage manifest names the NEW vault under the table name
- publish-contracts/src/govern.ts:1422-1440 lastUpgradeOf/buildDirFor/upgradeLayouts are also by name. After an earlier upgrade of the old vault, liveId is undefined for the new one, and upgradeLayoutRefusals refuses on 8453
- publish-contracts/src/cli.ts:697-719 a failed verify runs pauseOnFailure, which pauses deposits on all four vaults
- publish-contracts/src/redeploy-vault.ts:89-93 redeploy is refused on 8453 production, so this is reachable on a Base mainnet rehearsal and the Twin

**Recommended fix (reviewer).** Bind history to addresses. In upgradesOf, upgradeLayoutsOf, freezesOf (verify-stage.ts) and lastUpgradeOf (govern.ts), use only entries whose proxy_address (or proxies[].proxy) equals the proxy's current manifest address. Attribute older entries to <vault>.retired-<n> through retiredProxiesOf.

**Regression test the reviewer asked for.** publish-contracts/tests/verify-stage or proxies test: a run manifest with an executed freeze of rmPROTO at the old address plus a governed vault_redeploys entry. For the new rmPROTO, expectFrozen is false and the implementation slot expectation is the stage manifest's. Then govern upgrade-proxy rmPROTO uses the new vault's deploy layout id.

**What the fixer changed.**

- upgradesOf, upgradeLayoutsOf and freezesOf take an optional addressOf (currentProxyAddresses reads each table proxy's stage manifest). They keep only entries whose proxy_address or proxies[].proxy equals the address the name reaches now. runVerifyStage passes it everywhere. govern lastUpgradeOf now takes the TableProxy and filters by proxyAddressOf. A retired name (rmPROTO.retired-n) has no table address, so its entries stay its own. withRetiredProxies was already address-based.

**Regression tests the fixer wrote (not run).**

- publish-contracts/tests/upgrade-rows.test.ts::an executed upgrade recorded at another address (a vault a redeploy replaced) is not the proxy's history: the upgrade compares with the deploy manifest's layout; ::the verify inputs count only the rounds recorded at the address each name reaches now; a retired name keeps its own

**Files changed:** `publish-contracts/src/verify-stage.ts`, `publish-contracts/src/govern.ts`

**Related.** related findings review-security-036, review-security-045; finder note: Known finding 'After redeploy-vault the retired rmPROTO proxy drops out of freeze-proxy proxy=all...' (publish-contracts/src/govern.ts:1479): the round-1 fix added retired names for new freezes but left name-keyed upgrade and freeze history in place.

### 45. Low — After any executed upgrade, a verify run where the round's build_dir is missing, relative to another cwd, or no longer at build_sha fails a code label and auto-pauses deposits on all four vaults

**Index:** L-024 (review-security-045)

- **Where:** `publish-contracts/src/verify/index.ts:247` (line as the round 3 finder saw it)
- **Round / lane / owner:** 3 / tooling / code
- **Class / confidence:** `SECURITY_AVAILABILITY_SELF_PAUSE` / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-45

**Scenario.** An operator upgrades the router from a laptop with build=../rm-r2/out. Later the release owner runs `cli.ts verify` from the deployment checkout on another host. The same happens after the R2 checkout is deleted or moved to R3. The label `router: runtime code equals build artifact (masked)` fails with 'the build ... is a checkout at <core sha>, but the upgrade round recorded build_sha'. pause-all fires on all four vaults, and the unpause needs a 48-hour timelock round.

**Evidence.**

- publish-contracts/src/verify/index.ts:247: when build_dir does not exist, the verifier silently falls back to the deployment out/. Line 252 then fails the label because that checkout is not at build_sha. Line 258 also fails on an out/ rebuilt from other sources.
- publish-contracts/src/govern.ts:1502 and :1543 record build_dir exactly as typed. upgrade-rows.ts:65 keeps the build= value raw and never resolves it, so a relative build= resolves against the verify process's cwd.
- publish-contracts/src/verify-stage.ts:416 throws VERIFY. cli.ts:709 then sets postflight='verify', and pauseOnFailure pauses deposits on all four vaults.
- The redeploy sha model pre-refuses such verifies (redeploy-vault.ts:263 verifyBuildRefusal, refused_before_verify) because 'a failed verify would pause all four vaults'. Upgrade rounds have no such pre-check.
- Runbook §4.12 has the release owner run verify on the freeze-deadline day, from any machine.

**Also reported by another lens and folded in here.**

- `publish-contracts/src/verify/index.ts:247` (3 of 3 confirmed): After an upgrade, any verify run where the round's build_dir is gone, relative to another cwd, or at another HEAD fails and fires the automatic pause-all on all four vaults. It is not refused before the verifier runs.

**Recommended fix (reviewer).** Resolve build_dir to an absolute path when the round is recorded. Before the verifier runs, check that each upgraded proxy's build_dir exists, sits at build_sha and (on 8453) passes artifactSourceProblems. If any check fails, refuse with USAGE refused_before_verify and name the missing checkout, so no pause fires.

**Regression test the reviewer asked for.** A runVerifyStage or cli test with a proxy_upgrades entry whose build_dir is missing or relative: expect USAGE refused_before_verify and no pauseAll call.

**What the fixer changed.**

- New verify-stage.ts upgradeBuildRefusal runs before the verifier. It refuses with USAGE and refused_before_verify, so cli.ts pauses nothing. It checks a relative or missing build_dir, a checkout not at build_sha, on 8453 an out/ that is not the checkout's own or not compiled from the committed sources, and a layout snapshot that differs from build_layout_hash. The verifier's inline build rules moved into a shared verify/index.ts upgradeBuildProblem, so the pre-check and the label cannot drift. The messages are unchanged. govern.ts buildDirFor and the freeze dirs now record absolute paths. cli.ts absoluteBuild resolves build= against deps.cwd. A round without build_sha is still not held to a build, as before.
- This is the same fix as the self-pause finding. It adds the suggested override: verify --upgrade-build PROXY=DIR, repeatable, allowed only when the run reaches verify. The CLI resolves DIR against cwd into ctx.upgradeBuilds. withUpgradeBuilds applies the override to a copy of the manifest, so it never reaches the evidence. The override is held to the same rules. An override naming a proxy with no executed round is refused.

**Regression tests the fixer wrote (not run).**

- publish-contracts/tests/verify-stage.test.ts::a round whose build_dir is missing, or relative, is refused before the verifier with USAGE refused_before_verify; publish-contracts/tests/verify-stage.test.ts::the round's build_dir is gone: exit USAGE, the verifier did not run, pauseAll was never called; publish-contracts/tests/upgrade-rows.test.ts::security round 3 (review: SECURITY_AVAILABILITY_SELF_PAUSE): a relative build= is recorded as an absolute build_dir, so a verify from another directory names the same build
- publish-contracts/tests/verify-stage.test.ts::a build_dir that is a checkout at another sha (the next release checked out in the same place), or not its checkout's out/ on 8453, is refused; publish-contracts/tests/verify-stage.test.ts::a build checkout at build_sha whose storage-layout snapshot no longer hashes to the round's build_layout_hash is refused, not a failed layout label; publish-contracts/tests/verify-stage.test.ts::--upgrade-build stands for a missing build_dir, is held to build_sha, and is never written into the run manifest; publish-contracts/tests/verify-stage.test.ts::a round with no build_sha (a Twin build outside a checkout, as before) and a round not executed are not held to a build; publish-contracts/tests/verify-stage.test.ts::--upgrade-build goes with a run that reaches verify only, and is resolved against the working directory

**Files changed:** `publish-contracts/src/verify-stage.ts`, `publish-contracts/src/verify/index.ts`, `publish-contracts/src/govern.ts`, `publish-contracts/src/cli.ts`, `publish-contracts/src/runner.ts`, `publish-contracts/README.md`, `docs/operations/contract-release-runbooks.md`

**Related.** related findings review-security-033, review-security-044; finder note: The same class as the round-1 finding on the cwd-relative default evidence dir (govern.ts:652).

### 46. Medium — Storage-layout gate records enums only by type label, so inserting or reordering a member of VaultRegistry.VaultStatus or BasketAssetConfigGuard.Venue passes while reinterpreting every stored value

#### SEC-M-020 (review-security-046)

- **Where:** `scripts/ci/storage_layout_gate.py:144` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / ci / code
- **Class / confidence:** `SECURITY_GATE_BLIND_SPOT` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-46

**Scenario.** A PR inserts Paused between Active and DepositsPaused, or UniswapV2 before V4. forge inspect reports identical labels, slots and sizes, so the gate and its selftest pass in the required forge-unit-tests job. After the Safe upgrades the registry or a basket vault, every Retired vault reads as DepositsPaused and every V4 asset takes the Aerodrome path.

**Evidence.**

- scripts/ci/storage_layout_gate.py:133-157 normalize keeps label/slot/offset/bytes/type per variable and struct members only for types that carry 'members'; forge storageLayout gives enum types no member list
- contracts/test/fixtures/storage-layout/VaultRegistry.json: _status is 'mapping(address => enum VaultRegistry.VaultStatus)' and structs lists only VaultMetadata; ProtocolAssetVault.json AssetInfo.venue is 'enum BasketAssetConfigGuard.Venue' with no members recorded
- contracts/VaultRegistry.sol:69-75 enum VaultStatus {Active, DepositsPaused, Retired}; tooling hardcodes STATUS_RETIRED = 2 (publish-contracts/src/redeploy-vault.ts:49)
- contracts/lib/BasketAssetConfigGuard.sol:41-45 enum Venue {V3, V4, Aerodrome} selects each asset's swap path
- docs/technical/smart-contract-invariants.md:308 UPG-7 promises an upgrade never retypes existing proxy storage unseen; the selftest (storage_layout_gate.py:390-470) has no enum case

**Recommended fix (reviewer).** Record each storage-reachable enum's member list in the snapshot (from the AST or source of the enum definition) and add a rule that enum members may only be appended; add selftest cases for an inserted and a reordered member.

**Regression test the reviewer asked for.** scripts/ci/storage_layout_gate.py --selftest: an enum member inserted before the last member fails; a member appended at the end passes.

**What the fixer changed.**

- normalize() now records an 'enums' map (label -> members in order) for every enum type the storageLayout reaches. forge gives enums no member list, so members are read from the enum definition in the sources listed by `forge inspect <C> metadata`, with comments and strings blanked and scopes tracked; a missing or conflicting definition is a ToolError (fail closed). compare() fails unless old members are a prefix of new ones. 'enums' is now a required snapshot key. I added it to all nine committed snapshots without touching any other field (VaultRegistry.VaultStatus [Active, DepositsPaused, Retired]; BasketAssetConfigGuard.Venue [V3, V4, Aerodrome] in the three basket vaults; InvestmentCommitteePolicy.Stance [Overweight, Neutral, Underweight]). ADR-0014 §8 rules and UPG-7 updated.

**Regression tests the fixer wrote (not run).**

- scripts/ci/storage_layout_gate.py --selftest::'an enum member inserted before the last member fails', 'an enum member appended at the end passes', 'reordered enum members fail', 'a removed enum member fails', 'a renamed enum member fails', '<subject>'s storage enums are recorded with their members', 'enum definitions are read per scope, past comments, strings and nested braces'

**Files changed:** `scripts/ci/storage_layout_gate.py`, `scripts/ci/check-storage-layout.sh`, `contracts/test/fixtures/storage-layout/AgentTokenVault.json`, `contracts/test/fixtures/storage-layout/ConsensusRecommendationReceipt.json`, `contracts/test/fixtures/storage-layout/InvestmentCommitteePolicy.json`, `contracts/test/fixtures/storage-layout/PortfolioRouter.json`, `contracts/test/fixtures/storage-layout/ProtocolAssetVault.json`, `contracts/test/fixtures/storage-layout/RobotMoneyGateway.json`, `contracts/test/fixtures/storage-layout/RobotMoneyVault.json`, `contracts/test/fixtures/storage-layout/RwaBasketVault.json`, `contracts/test/fixtures/storage-layout/VaultRegistry.json`, `docs/adr/ADR-0014-governed-upgrades-and-freeze.md`, `docs/technical/smart-contract-invariants.md`

**Related.** related findings review-security-037, review-security-048; finder note: ADR-0014 §8; upgrade-proxy layout finding

### 47. High — The layout gates trust a committed snapshot that is never proven to be the code's layout

#### SEC-H-002 (review-security-047)

**Statement.** The layout gates trust a committed snapshot that is never proven to be the code's layout. An append shipped without --write, or a struct or enum entry deleted by hand, lets a later upgrade reinterpret a live slot while CI, --base, --release-anchor and upgrade-proxy all pass

- **Where:** `scripts/ci/storage_layout_gate.py:305` (line as the round 3 finder saw it)
- **Round / lane / owner:** 3 / ci / code
- **Class / confidence:** `SECURITY_LAYOUT_GATE_GAP` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, high, high. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-47

**Scenario.** Composition of the CI gate, the release gate and upgrade-proxy. Release R1 appends V to RobotMoneyVault. Nobody runs --write, because the append passes the same-tree compare and CI is green. upgrade-proxy R0->R1 sees liveId == buildId (both S0), so it passes with no compare and records build_layout_hash = S0 although R1 holds V at slot 63. A later change inserts W before V, which moves V to slot 64. The same-tree compare against S0, --base and --release-anchor (the R1 tag carries S0) all pass. upgrade-proxy R1->R2 compares S0 with S0 (equal ids) or with S2 (both rows look appended) and passes. After the timelock executes, the live proxy reads V's stored value as W. A deliberate variant: reorder Venue or change AssetInfo, run --write, then delete both entries from the JSON. All three CI compares and the 8453 upgrade compare pass.

**Evidence.**

- scripts/ci/storage_layout_gate.py:305: the same-tree compare skips any live variable at or past the snapshot's end (`if n["slot"] >= old_end: continue`). Code that appends V therefore passes against the old snapshot, and no rule ever requires --write.
- scripts/ci/storage_layout_gate.py:316-327 and publish-contracts/src/layout-compare.ts:91-102: a struct missing from the newer snapshot is skipped, not refused. So is an enum reached only through that struct, because storedEnumsOf(next) cannot see it.
- publish-contracts/src/upgrade-rows.ts:144: equal layout identifiers pass with no compare at all. The identifiers are the sha256 of the committed snapshot file (build-provenance.ts:240-247, contracts/script/GovernedProxyDeploy.sol:118-122), never of the build's actual layout.
- docs/operations/contract-release-runbooks.md:627: the upgrade runbook never tells anyone to run check-storage-layout.sh --write. The gate header only says to run it 'when a release deploys'.
- Simulated with the gate's own compare() on the committed RobotMoneyVault.json (S0). R1 code is S0 plus V@63, and it passes the same-tree compare against S0 with []. R2 code is S0 plus W@63 and V@64. It passes the same-tree compare against S0 with [] and passes --base S0->S2 with []. Only an exact R1 record reports 'variable V changed slot: 63 -> 64'.
- Simulated with layoutAppendOnlyProblems(AgentTokenVault.json, the same snapshot with 'struct BasketAssetConfigGuard.AssetInfo' and 'enum BasketAssetConfigGuard.Venue' deleted, {requireEnums:true}). It returns [], so the round-2 enum rule misses an enum stored only inside a dropped struct.
- All nine committed snapshots equal forge inspect exactly today, checked with the gate's normalize(). This is a latent gate defect, not a live mismatch.

**Recommended fix (reviewer).** Make the committed snapshot equal the code. In cmd_check, fail when normalize(c) differs from the snapshot in storage, structs or enums: require an exact match, not an append-compatible one. --base and --release-anchor already enforce append-only against history. In compare() and layoutAppendOnlyProblems(), refuse a newer snapshot whose storage rows or struct members reach a struct or enum label that it does not record. Optionally, have upgrade-proxy run `forge inspect <C> storageLayout` in the clean build checkout and require it to equal that checkout's snapshot.

**Regression test the reviewer asked for.** Add a storage_layout_gate.py selftest case where snapshot S and code S+V without --write must fail the same-tree compare. Add a layout-compare.test.ts case where a build snapshot keeps `assets: struct BasketAssetConfigGuard.AssetInfo[]` but drops the AssetInfo struct and the Venue enum: it must be refused on 8453.

**What the fixer changed.**

- New snapshot_drift() and same_tree_problems(). cmd_check now runs compare() first. When compare() passes, it fails any difference between the committed snapshot and normalize(c): storage rows (an append included), row order, structs, enums and release pins. The failure text tells the author to run --write in the same change. --base and --release-anchor are unchanged, and they keep the rewritten snapshot append-only against history. A green sha's snapshot hash is now its code's layout, so the equal-id pass in upgrade-rows.ts:144 is sound on 8453, where both checkouts are green release shas. I updated that docstring to say so. I updated the gate docstring, the wrapper header (help range is now 2-38) and the CI step comment.
- Python: new unrecorded_types() is called from compare() on the newer record. It refuses any struct or enum label that a storage row or a recorded struct member reaches but the record does not hold. TS: new storedStructsOf(). layoutAppendOnlyProblems now refuses, on every chain, a build snapshot that reaches a struct it does not record. It also refuses an enum it does not record when the snapshot has an enums map. This replaces the narrower round-2 in-loop enum check and keeps its wording, so the round-2 test still matches. A snapshot with no enums map stays under the requireEnums (8453) rule. Only the newer record is checked, as the fix asked. The older record's completeness now follows from the exact same-tree match at the commit that recorded it. I read all nine committed snapshots: each one records every struct and enum its storage reaches, so the new rule passes on the current tree.

**Regression tests the fixer wrote (not run).**

- scripts/ci/storage_layout_gate.py::cmd_selftest 'same tree: code S plus an appended V against snapshot S (no --write) fails'; 'same tree: code S plus W, then V a slot later, against snapshot S fails (the append rule alone passes it)'; 'same tree: code S against snapshot S passes'; '--base: snapshot S, then snapshot R1 written with --write: the append passes'; 'same tree: an enum member appended in the code and not recorded in the snapshot fails'; 'same tree: a snapshot with <AssetInfo> and its enum deleted by hand fails against the code'
- publish-contracts/tests/layout-compare.test.ts::'a build snapshot that keeps `assets: struct BasketAssetConfigGuard.AssetInfo[]` but drops the AssetInfo struct and the Venue enum is refused on 8453'; ::'the deliberate variant: Venue reordered (written with --write), then deleted by hand while AssetInfo is kept, is refused naming Venue'; ::'mutation: the unmodified snapshot passes on 8453, and a recorded struct no variable reaches any more is no refusal of its own'; scripts/ci/storage_layout_gate.py::cmd_selftest '--base: a committed snapshot that still stores <AssetInfo> but drops it and [Venue] fails', 'same-tree rules: a newer record that drops a stored struct and its enum fails', '--base: a committed snapshot that keeps <AssetInfo> but drops [Venue] fails'

**Files changed:** `scripts/ci/storage_layout_gate.py`, `scripts/ci/check-storage-layout.sh`, `.github/workflows/suite-01-02-forge-tests.yml`, `publish-contracts/src/layout-compare.ts`, `publish-contracts/tests/layout-compare.test.ts`

**Related.** related findings review-security-004, review-security-037, review-security-048; finder note: This is the remaining hole in the round-1/2 fixes for 'the storage-layout gate compares against a snapshot the same change can rewrite' (storage_layout_gate.py:375) and 'upgrade-time layout gate has no enum rule' (layout-compare.ts:46/62).

### 48. Medium — The storage-layout gate compares against a snapshot the same change can rewrite, and its own failure message says to rewrite it

#### SEC-M-021 (review-security-048)

- **Where:** `scripts/ci/storage_layout_gate.py:375` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / ci / code
- **Class / confidence:** `SECURITY_GATE_SELF_REFERENCE` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-48

**Scenario.** A PR inserts or reorders a state variable in a proxied contract such as RobotMoneyVault. The gate goes red. The author or an automated agent follows the message and runs --write. CI goes green. A later governed upgrade of the live proxy then installs logic whose slots have shifted, which corrupts the live vault's balances or roles. The only defense is a reviewer reading the fixture JSON diff.

**Evidence.**

- scripts/ci/storage_layout_gate.py:369-376 cmd_check compares the live forge inspect layout with contracts/test/fixtures/storage-layout/<C>.json from the same working tree.
- scripts/ci/storage_layout_gate.py:386-391 on failure it prints 'review the diff and rerun with --write'.
- scripts/ci/storage_layout_gate.py:17-19 and docs/adr/ADR-0014-governed-upgrades-and-freeze.md:310-312 define a snapshot as the layout of the implementation live on the release chain, rewritten only when a release deploys.
- .github/workflows/suite-01-02-forge-tests.yml:169-181 CI runs only this same-tree compare. Nothing compares against the PR base snapshot or the last release tag's snapshot.
- ADR-0014:477-480 names the layout gate as one of the controls between an upgrade proposal and execution. docs/development/ci-suites.md:1427 has no branch protection, and merges run automated.

**Recommended fix (reviewer).** Add a second compare in CI: run compare(base_snapshot, committed_snapshot), where base is git show <PR base or latest release tag>:contracts/test/fixtures/storage-layout/<C>.json. Then a rewritten snapshot must itself be append-only against what is live, and --write cannot launder a non-append change.

**Regression test the reviewer asked for.** Add a selftest case in storage_layout_gate.py: the base snapshot is S, the committed snapshot S' moves a slot, and live equals S'. The gate must fail.

**What the fixer changed.**

- New `--base <ref>` mode: compare(snapshot at ref via git show, committed snapshot) under the storage rules (variables, gaps, structs, enums, GovernedUpgrade). Linearization, library and OZ pins are printed as notes in that mode, because ADR-0014 §8 expects a release to rewrite them. A contract with no snapshot at ref, or a legacy pre-ADR-0014 snapshot (dev's gateway file), is skipped with a message. A bad ref exits 2. The CI step fetches github.event.pull_request.base.sha || github.event.before (dev on dispatch) with depth 1 through env:, then runs --base FETCH_HEAD after the same-tree check. The failure message no longer tells the reader to rerun --write. No escape hatch by design.

**Regression tests the fixer wrote (not run).**

- scripts/ci/storage_layout_gate.py --selftest::'base S, committed S' with a moved slot, live == S': the same-tree compare passes and --base fails', '--base: a variable appended at the end passes', '--base: an enum member inserted before the last member fails', '--base: a field appended to a storage struct fails', '--base: a missing GovernedUpgrade fails', '--base: an OpenZeppelin commit a release recorded is a note, not a failure', '--base: a base snapshot from before enums were recorded still holds the storage rules'

**Files changed:** `scripts/ci/storage_layout_gate.py`, `scripts/ci/check-storage-layout.sh`, `.github/workflows/suite-01-02-forge-tests.yml`, `docs/adr/ADR-0014-governed-upgrades-and-freeze.md`, `docs/technical/smart-contract-invariants.md`

**Related.** related findings review-security-004, review-security-046, review-security-047; finder note: ADR-0014 §8, issue 1808 (P1)

### 49. High — Any repo writer can mint the rmpc build attestation that install-rmpc.sh trusts, so the admin-only rmpc-v* tag ruleset does not protect installs

#### SEC-H-003 (review-security-049)

- **Where:** `scripts/release/install-rmpc.sh:276` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / ci / code
- **Class / confidence:** `SECURITY_TRUST_ROOT_BYPASS` / medium
- **Skeptics:** 3 of 3 confirmed. Votes: high, high, high. The finder said high.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-49

**Scenario.** A writer pushes a branch with a trojaned rmpc, or with an edited release-rmpc.yml. They dispatch release-rmpc with dry_run=true and commit_hash set to that commit. The build job signs a Sigstore attestation over the archive digest as robotmoney/robotmoney-core/.github/workflows/release-rmpc.yml@refs/heads/<branch>. Using contents: write, the writer replaces rmpc-X.Y.Z-linux-amd64.tar.gz and its .sha256 on an existing rmpc-vX.Y.Z release. The tag ruleset covers refs, not release assets. Every agent operator who runs install-rmpc.sh --tag rmpc-vX.Y.Z then sees 'verified, attested' and installs a binary that holds their agent signing key. This assumes GitHub immutable releases are off, and the repo docs never mention them.

**Evidence.**

- .github/workflows/release-rmpc.yml:79-92 workflow_dispatch takes commit_hash and dry_run. Any writer can dispatch it on any branch, and that branch's copy of the workflow runs.
- .github/workflows/release-rmpc.yml:370-371 the build job holds id-token: write and attestations: write.
- .github/workflows/release-rmpc.yml:545-546 the attest-build-provenance step has no if:. It signs on dry runs and on branch dispatches, before any tag push or publish.
- scripts/release/install-rmpc.sh:276-279 runs gh attestation verify with only --repo, --signer-workflow and --deny-self-hosted-runners. It sets no --source-ref and no ref-pinned cert identity, so a run on any ref of release-rmpc.yml passes.
- docs/development/releasing.md:130-133 says the protect-rmpc-release-tags ruleset means a hostile release needs org admin. install-rmpc.sh:44-49 says a compromised maintainer account that edits release assets is defeated.
- scripts/release/install-rmpc-selftest.sh:2002-2012 asserts only --repo and --signer-workflow. Nothing asserts the source ref.

**Recommended fix (reviewer).** Pin the attestation to the admin-only tag ref. In install-rmpc.sh add --source-ref "refs/tags/${TAG}", or use a cert identity that ends in release-rmpc.yml@refs/tags/${TAG}. In release-rmpc.yml run the attest step only when github.event_name == 'push' && startsWith(github.ref, 'refs/tags/rmpc-v'). Never attest on dry_run. Make the release path tag-push only. Turn on immutable releases.

**Regression test the reviewer asked for.** In install-rmpc-selftest.sh, use the recorded gh call to fail unless it carries --source-ref refs/tags/<TAG>. In audit_workflow_run_splice_and_perms.py, refuse an attest step without the tag-push condition, and prove that with a hostile mutated copy.

**What the fixer changed.**

- Installer: --source-ref refs/tags/$TAG plus `--format json --jq` counting verified attestations whose certificate buildTrigger is push; anything but a positive count is exit 6. The trigger pin closes a sibling bypass: dispatching an old tag's own workflow copy (which attested on every dispatch) gives source ref = that tag. --tag must be rmpc-vX.Y.Z (bare v* is release-dapp's namespace, not covered by the admin ruleset, and has no attestations). Field names were checked against the real rmpc-v0.3.4 attestation (buildTrigger=workflow_dispatch, sourceRepositoryRef=refs/heads/dev). Real gh exits 1 with --source-ref refs/tags/rmpc-v0.3.4 and prints 0 for the push filter. Workflow: the attest step runs only if github.event_name == 'push' && startsWith(github.ref, 'refs/tags/rmpc-v'). The `tag` dispatch input is removed and dry_run defaults to true. Validate inputs refuses dry_run=false and shape-checks the pushed tag. publish and bump-manifest run only on the tag push. The dispatch tag-creation step is gone. Auditor gains an attest-ungated finding (exact tag-push condition only). Selftest fixture tag moved to rmpc-v0.0.0-selftest. Its extractor allow-list swaps INPUT_TAG for REF_NAME and reads the attest step's if:. The plugin suite floor goes 66 -> 73.

**Regression tests the fixer wrote (not run).**

- scripts/release/install-rmpc-selftest.sh::'provenance: the gh call pins --source-ref refs/tags/${TAG}', 'provenance: the gh call keeps only attestations whose certificate buildTrigger is push', 'provenance: an attestation that verifies but was not minted by the push of the tag is refused with exit 6, before extract', 'provenance: a bare vX.Y.Z tag is refused with exit 2 before any download or attestation lookup', 'release-rmpc.yml attests only on the push of an rmpc-v* tag', 'a dispatch with dry_run=false is refused', 'a dry-run dispatch is still accepted'; .github/scripts/tests/test_audit_workflow_run_splice_and_perms.sh::'release-rmpc.yml: an attest step with no if: ... is caught', 'release-rmpc.yml: an attest step widened with || inputs.dry_run is caught'

**Files changed:** `scripts/release/install-rmpc.sh`, `scripts/release/install-rmpc-selftest.sh`, `.github/workflows/release-rmpc.yml`, `.github/scripts/audit_workflow_run_splice_and_perms.py`, `.github/scripts/tests/test_audit_workflow_run_splice_and_perms.sh`, `plugins/robotmoney-swarm/tests/run-tests.sh`, `docs/development/releasing.md`, `BOOTSTRAP.md`

**Residual.** Owner action: turn on GitHub immutable releases. rmpc-v0.3.4 was dispatched from dev, so the new installer refuses it until an admin pushes the next rmpc-v tag.

**Related.** related findings review-security-001, review-security-002; finder note: issue 1236 (attestation), issue 1342 (no review on release-rmpc.yml), releasing.md ruleset claim

### 50. Low — The 8453 dapp builder pins only deploy-time implementations, so the runbook step 'rebuild the dapp with the new hash next to the old one' has no supported path after an upgrade

**Index:** L-025 (review-security-050)

- **Where:** `scripts/stage/mainnet-dapp.ts:318` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / tooling / code
- **Class / confidence:** `SECURITY_OPERATIONAL_PIN_ROTATION_GAP` / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-50

**Scenario.** After upgrade-proxy executes for a vault or the router, every mainnet dapp deposit and approval to it refuses implementation-mismatch. core-stack dapp up can only rebuild the old pin. The operator either leaves deposits closed or hand-edits timelock.json, the release record that verify and evidence read.

**Evidence.**

- scripts/stage/mainnet-dapp.ts:315-333 derives VITE_VAULT/ROUTER_EXPECTED_IMPLEMENTATION_HASH only from timelock.json, which DeployTimelock writes once at deploy (contracts/script/DeployTimelock.s.sol:1234, :1261)
- scripts/stage/mainnet-dapp.ts:357-368 MainnetDappInput and scripts/stage/core-stack.ts:941 accept no extra or upgraded implementation hash
- docs/operations/contract-release-runbooks.md:632 tells operators to rebuild the dapp with the new hash listed next to the old one before the execute

**Recommended fix (reviewer).** Let buildMainnetDappEnv append per-address hashes from the govern evidence's executed proxy_upgrades rows (chain 8453, matching proxy), and refuse rows that are not executed. Point the runbook at that input.

**Regression test the reviewer asked for.** scripts/stage/tests/mainnet-dapp.test.ts: timelock.json plus an evidence file with an executed upgrade row for vault_0 yields both hashes for vault_0. A scheduled-only row or a row for another chain is refused.

**What the fixer changed.**

- New MainnetDappInput.upgradeEvidence and core-stack flag --upgrade-evidence FILE. upgradedImplementationHashes reads proxy_upgrades from 8453 evidence and refuses any row without a successful execute_tx/execute_status 1, or with another chain_id. Each hash is appended comma-separated to the vault, router or gateway implementation pin, matched by address. timelock.json is never edited. Following the finding, only executed rounds are pinned, so the runbook step now says rebuild after the execute. Deposits to the upgraded contract stay refused until then, and redeems stay open.

**Regression tests the fixer wrote (not run).**

- scripts/stage/tests/mainnet-dapp.test.ts::timelock.json plus an evidence file with an executed upgrade row for vault_0 yields both hashes for vault_0; the router's row adds to the router pin; ::a scheduled-only row, a failed execute, a row of another chain's evidence, or an upgrade of a contract the manifests say is direct is refused; ::up: --upgrade-evidence reaches the env builder (security round 2); a scheduled-only row refuses the build before compose runs

**Files changed:** `scripts/stage/mainnet-dapp.ts`, `scripts/stage/core-stack.ts`, `docs/operations/contract-release-runbooks.md`

**Related.** related findings review-security-007, review-security-052; finder note: Round-1 upgrade-proxy build-binding findings (publish-contracts/src/govern.ts:1378); fails safe, so availability only

### 51. Medium — InvestmentCommitteePolicy proxy is never watched by any shipped indexer config, so its Upgraded/UpgradesFrozen events never reach the watchdog upgrade page

#### SEC-M-022 (review-security-051)

- **Where:** `scripts/stage/mainnet-dapp.ts:366` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / tooling / code
- **Class / confidence:** `SECURITY_MONITORING_COVERAGE_GAP` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-51

**Scenario.** A Safe signer set that is compromised (or an unreviewed release) schedules and executes upgradeToAndCall on the InvestmentCommitteePolicy proxy through the timelock. The proxy emits Upgraded(newImpl). The indexer never asks eth_getLogs for that address, so proxy_upgrade_events gets no row. The watchdog upgrade alert, which exists to tell on-call about exactly this event, stays silent. /v1/upgrades and the dapp's indexed fallback also omit the IC. The same omission leaves /v1/committee/* and /v1/regime/feed empty on every shipped stack.

**Evidence.**

- scripts/stage/mainnet-dapp.ts:366-381 builds the indexer env with GATEWAY, VAULT, REGISTRY, PORTFOLIO_ROUTER, ROUTER_GOVERNANCE, CONSENSUS_RECEIPT, TIMELOCK and SAFE. It sets no INDEXER_INVESTMENT_COMMITTEE.
- scripts/stage/mainnet-dapp.ts:245-297 readMainnetManifests never reads addresses.ic_policy, though deployments/8453/deploy-2/timelock.json carries it (keys: consensus_receipt, ic_policy, ...).
- testing/ethereum-testnet/config/docker-compose.dapp.yaml:152-190 explorer-indexer environment has no INDEXER_INVESTMENT_COMMITTEE key, so even an exported value never reaches the container.
- services/explorer-indexer/src/main.rs:107 the only source of cfg.investment_committee is that env var; services/explorer-indexer/src/indexer.rs:145-183 watched_addresses adds the IC only when it is Some.
- services/explorer-indexer/src/indexer.rs:2691-2706 proxy upgrade rows are written only for logs of watched addresses.
- services/watchdog/src/upgrade_events.rs:1-30 and main.rs:688-740 page only from proxy_upgrade_events. Its doc says every proxied Robot Money contract pages.
- docs/adr/ADR-0014-governed-upgrades-and-freeze.md:88 lists InvestmentCommitteePolicy as one of the nine proxied contracts.

**Recommended fix (reviewer).** In mainnet-dapp.ts read addresses.ic_policy from timelock.json and set INDEXER_INVESTMENT_COMMITTEE. Map INDEXER_INVESTMENT_COMMITTEE: ${INDEXER_INVESTMENT_COMMITTEE:-} in docker-compose.dapp.yaml. Add a startup warning, or a refusal on the mainnet class, in the indexer when a proxied role (IC, consensus receipt, registry) is unset.

**Regression test the reviewer asked for.** scripts/stage/tests/mainnet-dapp.test.ts: assert env.INDEXER_INVESTMENT_COMMITTEE equals timelock.json addresses.ic_policy. A compose-lint test that every IndexerConfig env var in main.rs is mapped in docker-compose.dapp.yaml.

**What the fixer changed.**

- readMainnetManifests requires addresses.ic_policy and the env sets INDEXER_INVESTMENT_COMMITTEE. Compose maps it. The lint test parses every env = "INDEXER_*" in services/explorer-indexer/src/main.rs and requires a mapping in the dapp compose or the mainnet overlay, except INDEXER_TICK_SECONDS and INDEXER_END_BLOCK. Not done: the indexer startup warning or refusal when a proxied role is unset (services lane), and testing/smoke-test/src/lib.rs Twin env still omits INDEXER_INVESTMENT_COMMITTEE, INDEXER_TIMELOCK and INDEXER_SAFE.

**Regression tests the fixer wrote (not run).**

- scripts/stage/tests/mainnet-dapp.test.ts::reads the four vaults in order, the gateway hash, and every contract address (asserts INDEXER_INVESTMENT_COMMITTEE equals addresses.ic_policy); scripts/stage/tests/mainnet-dapp.test.ts::security round 1: a timelock manifest with no IC policy address, or a zero one, is refused; scripts/stage/tests/mainnet-dapp.test.ts::security round 1: every INDEXER_* setting of the indexer reaches its container (INDEXER_INVESTMENT_COMMITTEE among them)

**Files changed:** `scripts/stage/mainnet-dapp.ts`, `testing/ethereum-testnet/config/docker-compose.dapp.yaml`, `scripts/stage/tests/mainnet-dapp.test.ts`

**Residual.** No indexer startup warning or refusal exists when a proxied role address is unset. The stage stack half was fixed in round 2.

**Related.** related findings review-security-069; finder note: ADR-0014 §1; issue 1810 (P3 upgrade alert); X3/X4 (committee indexing is dead on shipped stacks)

### 52. Low — Implementation pins never retire: the 8453 dapp build pins the deploy-time implementation plus every executed upgrade, and the rmpc export copies them all, so a timelock rollback to a superseded implementation passes every client check

**Index:** L-026 (review-security-052)

- **Where:** `scripts/stage/mainnet-dapp.ts:454` (line as the round 3 finder saw it)
- **Round / lane / owner:** 3 / tooling / code
- **Class / confidence:** `SECURITY_STALE_PIN_ACCEPTS_ROLLBACK` / medium
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-52

**Scenario.** rmUSDC is upgraded from implementation v1 to v2 to fix a bug. The operator rebuilds the dapp with --upgrade-evidence as the runbook says: the build now pins v1 and v2. Before any freeze, the timelock schedules upgradeToAndCall(v1) (a compromised Safe, or a mistaken rollback round). After 48 hours it executes. The dapp guard reads the slot, finds v1's hash in the pin list, badges rmUSDC '[bytecode verified]' and sends deposits and approvals into the buggy logic. An operator who exported an rmpc config from that dapp also has v1 in proxy_implementation_hashes, so rmpc signs too. The same holds for the gateway pin list.

**Evidence.**

- scripts/stage/mainnet-dapp.ts:401: upgradedImplementationHashes appends every executed proxy_upgrades row's implementation_code_hash per proxy
- scripts/stage/mainnet-dapp.ts:451-454: pinsOf returns the deploy-time hash plus every upgraded hash; there is no way to drop one
- scripts/stage/mainnet-dapp.ts:471,477,478: the gateway, vault and router implementation pins are all built with pinsOf
- clients/dapp/src/lib/codePins.ts checkImplementationPin: any listed hash for the address passes; clients/dapp/src/lib/useGuardedWriteContract.ts:245 sends the deposit/approve when it passes
- clients/dapp/src/components/AdminFlow.tsx:94-101 and clients/dapp/src/lib/configExport.ts:148-156: the rmpc export writes the union of every non-gateway pin as proxy_implementation_hashes, a flat list rmpc applies to every vault, the router and every leg
- docs/operations/contract-release-runbooks.md:632: after an execute, operators must remove the old hash from rmpc; the export re-adds it
- contracts/lib/GovernedUpgrade.sol:148-152: _authorizeUpgrade checks only the authority and the freeze, so a downgrade to an older implementation is accepted on chain; publish-contracts/src/govern.ts:1505-1511 supports rollback rounds

**Recommended fix (reviewer).** In mainnet-dapp.ts pin, per proxy, only the implementation of the latest executed round (the deploy-time hash only when no round executed), or require an explicit retire list. In the export, write only the hashes that match each address's live implementation (as the gateway export already does) instead of the union of all pins.

**Regression test the reviewer asked for.** scripts/stage/tests/mainnet-dapp.test.ts: evidence with one executed rmUSDC round v1->v2 yields VITE_VAULT_EXPECTED_IMPLEMENTATION_HASH[rmUSDC] == v2 only. code-pin.test.tsx: with pins built from that evidence, a proxy whose slot names v1 is refused implementation-mismatch. configExport.test.ts: proxy_implementation_hashes excludes a pinned hash that no address currently runs.

**What the fixer changed.**

- pinsOf now pins only the hash of each proxy's latest executed round. It uses the deploy-time hash only when no round executed. upgradedImplementationHashes orders rows by execute_block_timestamp, with file order breaking ties, because the timelock executor is open. A malformed timestamp is refused. The dapp-lane half is not done: configExport.ts per-address live filtering, code-pin.test.tsx and configExport.test.ts. The build pins no longer carry retired hashes, so the rmpc export can no longer re-add them. The flat cross-address list in the export is still the dapp lane's call.

**Regression tests the fixer wrote (not run).**

- scripts/stage/tests/mainnet-dapp.test.ts::security round 3: an evidence file with one executed rmUSDC round v1->v2 pins v2 only for vault_0 (the deploy-time v1 retires); the router's row replaces the router pin; scripts/stage/tests/mainnet-dapp.test.ts::security round 3 (review: SECURITY_STALE_PIN_ACCEPTS_ROLLBACK): only the latest executed round is pinned, by execute time, so a rollback is pinned only once a round records it

**Files changed:** `scripts/stage/mainnet-dapp.ts`, `scripts/stage/tests/mainnet-dapp.test.ts`, `docs/operations/contract-release-runbooks.md`

**Residual.** The dapp-lane half is not done: the rmpc export still writes one flat pin list instead of filtering by each address's live implementation.

**Related.** related findings review-security-009, review-security-050; finder note: Round-2 fix of the known findings 'The 8453 dapp builder pins only deploy-time implementations' (scripts/stage/mainnet-dapp.ts:318) and 'The dapp's rmpc config export tells operators to pin the live vault implementation hash' (clients/dapp/src/lib/configExport.ts:138). Composition pass: govern evidence -> 8453 builder pins -> dapp write guard -> config export -> rmpc flat list.

### 53. Low — The explorer's exclusion snapshot pass skips a holder who redeems in the record's own block after it opens

**Index:** L-027 (review-security-053)

- **Where:** `services/explorer-indexer/src/db.rs:2890` (line as the round 3 finder saw it)
- **Round / lane / owner:** 3 / indexer / code
- **Class / confidence:** `SECURITY_ECONOMICS_CLAIM_ACCOUNTING_DISPLAY` (lens class: `ECONOMICS_CLAIM_ACCOUNTING_DISPLAY`) / medium
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-53

**Scenario.** Record id opens in tx1 of block B. Holder H, holding 100 shares since B-10, redeems all of them in tx2 of block B. wallet_positions(H, B) = 0, so H is not a candidate. The pass marks the record done. /v1 account exclusion claims shows nothing for H, and the stored snapshot balances sum to less than snapshotSupply, until H happens to claim on-chain.

**Evidence.**

- services/explorer-indexer/src/db.rs:2887-2894 picks each owner's latest wallet_positions row with block_number <= opened_block and keeps it only when shares > 0
- services/explorer-indexer/src/db.rs:1561-1563: the row of a block is the owner's balance after every log of that block
- contracts/ExclusionLedger.sol checkpoint stores the pre-change balance, so balanceAt(holder, id) is still the pre-exit balance on-chain
- services/explorer-indexer/src/indexer.rs:1358-1374 marks the record done once candidates run out, so that holder is never read again; only a later ExclusionClaimed (indexer.rs:1269) adds it
- clients/explorer-api/src/routes.rs:1478-1481 claims the indexer reads every address with a deposit or withdrawal at or before the snapshot

**Recommended fix (reviewer).** Take candidates as owners whose latest row strictly below opened_block holds shares, plus every owner with any row at opened_block. balanceAt already filters out the ones with no claim.

**Regression test the reviewer asked for.** services/explorer-indexer/tests/vault_detail.rs: open a record and redeem a holder's whole balance in the same block. Assert exclusion_holder_balances holds that holder with the pre-exit balance after the pass reports done.

**What the fixer changed.**

- exclusion_snapshot_candidates now takes the UNION of two sets: owners whose latest row strictly below opened_block holds shares, and every owner with a row at opened_block. A zero balanceAt is still not stored. The round-2 rule that never reads exited dust owners still holds, because those exit before the record's block. The test runs end to end through Deposit and Withdraw logs. G and H deposit at block 45. At block 55 the record opens, then H redeems all and D deposits for the first time. The test asserts G, H and D are each read once, G=50 and H=100 are stored, D is not stored, and progress is done.

**Regression tests the fixer wrote (not run).**

- services/explorer-indexer/tests/vault_detail.rs::a_holder_who_exits_in_the_records_own_block_keeps_its_snapshot_balance

**Files changed:** `services/explorer-indexer/src/db.rs`, `services/explorer-indexer/src/indexer.rs`, `services/explorer-indexer/tests/vault_detail.rs`, `clients/explorer-api/src/routes.rs`, `docs/explorer-api.md`

**Related.** related findings review-security-054, review-security-059, review-security-063; finder note: Known findings on exclusion ledger indexing and same-block wallet_positions writes

### 54. Info — Round-2 snapshot candidate filter skips holders whose deposit/withdraw sum saturates to zero, and the route doc still says every depositor is read

**Index:** review-security-054

- **Where:** `services/explorer-indexer/src/db.rs:2894` (line as the round 3 finder saw it)
- **Round / lane / owner:** 3 / indexer / code
- **Class / confidence:** `SECURITY_DATA_COMPLETENESS_REGRESSION` (lens class: `DATA_COMPLETENESS_REGRESSION`) / high
- **Skeptics:** 3 of 3 confirmed. Votes: info, info, info. The finder said info.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-54

**Scenario.** A holder receives 100 shares by transfer and redeems 50 directly. The Withdraw makes its wallet_positions row 0 while it really holds 50. A record opens. Before round 2 this holder was read; now the filter skips it, and its claim is missing from the explorer until it claims. ExclusionLedger.claimable() stays the authority.

**Evidence.**

- services/explorer-indexer/src/db.rs:2883-2899 keeps an owner only when its latest wallet_positions row at or before the record holds shares > 0
- services/explorer-indexer/src/db.rs apply_wallet_position_delta saturates a Withdraw at zero, and wallet_positions ignores plain transfers
- clients/explorer-api/src/routes.rs:1479 still says the indexer 'reads the balance of every address with a deposit or withdrawal in the vault at or before the snapshot'

**Recommended fix (reviewer).** Keep zero-row owners as candidates (the progress cursor already stops re-reads), or update the routes.rs doc to the new rule.

**Regression test the reviewer asked for.** vault_detail.rs: wallet_positions row 0 for an owner whose stubbed balanceAt is 50; assert the snapshot pass stores 50 for that owner.

**What the fixer changed.**

- I chose the doc fix, not the code fix. Keeping zero-row owners as candidates would read every exited dust owner again, which is what round 2 removed. That change would also break the existing budgeted-pass test. routes.rs, the db.rs doc and docs/explorer-api.md now state the rule. They name the saturated-zero holder as not listed until it claims, and say ExclusionLedger.claimable is the authority.

**Regression tests the fixer wrote (not run).**

- none new; exclusion_snapshot_balances_are_read_by_a_budgeted_pass already pins the rule that exited owners are never read

**Files changed:** `clients/explorer-api/src/routes.rs`, `services/explorer-indexer/src/db.rs`, `docs/explorer-api.md`

**Residual.** Fixed by documenting the rule, not by changing the filter. ExclusionLedger.claimable stays the authority.

**Related.** related findings review-security-053, review-security-059; finder note: Round-2 budgeted snapshot pass (migration 0028)

### 55. Medium — Indexer derives the ExclusionLedger as vault.create(1), but ADR-0014 moved ledger creation into ExclusionLedgerFactory, so no exclusion record is ever indexed

#### SEC-M-023 (review-security-055)

- **Where:** `services/explorer-indexer/src/indexer.rs:1036` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / indexer / code
- **Class / confidence:** `SECURITY_DATA_PROVENANCE_DRIFT` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-55

**Scenario.** On any ADR-0014 deployment, every vault is a proxy. An adapter is excluded, the real ledger emits ExclusionOpened, recoveries are credited, and holders claim. The indexer never fetches those logs. GET /v1/accounts/:address/exclusion-claims returns claims [] and total_claimable_usdc "0" for every holder, including exited holders owed recovered USDC. Funds stay safe: ledger.claimable is authoritative and the dapp reads it on chain. Every API or agent consumer is still told nothing is owed.

**Evidence.**

- services/explorer-indexer/src/indexer.rs:1036-1038 exclusion_ledger_of(vault) = vault.create(1).
- contracts/RobotMoneyVault.sol:481-485 _initLedger calls factory.create(asset). contracts/ExclusionLedgerFactory.sol:27-29 runs `new ExclusionLedger(msg.sender, asset)`, so the ledger sits at the factory's CREATE address. The vault proxy never CREATEs, so vault.create(1) holds no code.
- indexer.rs:1328-1339 (watched ledgers) and 1361 (X1 refetch) watch only the derived address. indexer.rs:1042-1061 vault_of_exclusion_ledger refuses any other emitter.
- services/explorer-indexer/tests/vault_detail.rs:906-994 guard asserts RobotMoneyVault.sol creates exactly one `new ExclusionLedger(` in its constructor. The source now has none (grep finds no `new [A-Z]`), so this test fails when suite-08 runs it (.github/workflows/suite-08-explorer-indexer.yml:311). The landed notes say tests were not run.
- tests/vault_detail.rs:718-724 and tests/multi_vault.rs:546 build synthetic logs at the derived address, so they pass against the wrong derivation.
- docs/explorer-api.md:48 still states the indexer derives the ledger as the vault's first contract creation.

**Recommended fix (reviewer).** Resolve each vault's ledger from the chain. Either eth_call exclusionLedger() when a vault is first registered or configured and store it in a vaults.exclusion_ledger column, or index ExclusionLedgerCreated(vault, ledger) from the CREATE2 factory. Use the stored mapping for the watched set, the X1 refetch and the emitter gate in vault_of_exclusion_ledger. Fix the guard test to check that mapping, not to relax it.

**Regression test the reviewer asked for.** An anvil test that deploys a RobotMoneyVault proxy with the real ExclusionLedgerFactory, excludes an adapter and runs run_once. It asserts an exclusion_records row at the factory-created ledger address and a non-zero claimable from /v1/accounts/:holder/exclusion-claims.

**What the fixer changed.**

- exclusion_ledger_of is removed. exclusion_ledgers_of calls the vault's exclusionLedger() once at the tick's safe head and stores the answer in the new table vault_exclusion_ledgers (migration 0026). The table has block_number = the read block, so the reorg rollback covers it. A revert (BasketVault) is stored as NULL. A zero, empty or undecodable reply is not stored and is read again next tick. Any other RPC error fails the tick, so the cursor holds. The watched set, the X1 refetch (the new vault is read in the same tick) and the handle_log emitter gate (Db::vault_of_exclusion_ledger) all use the stored mapping. I chose an eth_call over indexing ExclusionLedgerCreated because the factory event fires at vault initialize, which is before the registration block that the X1 refetch starts from. catch_up_budget now counts one ledger read per vault on the first tick only. vault_snapshot_cadence's reads_of_vault leaves out the getter.

**Regression tests the fixer wrote (not run).**

- fork_indexer::exclusion_record_of_a_proxy_vault_is_indexed_at_its_factory_ledger (Twin/anvil: a holder deposits, the real Safe and timelock exclude and then restore the Aave adapter, run_once indexes the range, then it asserts the vault_exclusion_ledgers row, the exclusion_records row at the factory ledger and that /v1/accounts/:holder/exclusion-claims claimable equals the ledger's on-chain claimable(1, holder) > 0); vault_detail::exclusion_record_events_store_each_snapshot_holders_balance (updated: the ledger is factory.create(1), the old vault.create(1) is the impostor); vault_detail::exclusion_ledger_is_set_once_from_the_factory_and_read_from_the_vault (replaces the failing nonce-1 guard); vault_detail::ledger_read_classifies_each_reply; multi_vault::vault_registered_and_deposited_in_one_tick_indexes_the_deposit (updated)

**Files changed:** `services/explorer-indexer/src/indexer.rs`, `services/explorer-indexer/src/abi.rs`, `services/explorer-indexer/src/db.rs`, `services/explorer-indexer/migrations/0026_vault_exclusion_ledgers.sql`, `services/explorer-indexer/tests/vault_detail.rs`, `services/explorer-indexer/tests/multi_vault.rs`, `services/explorer-indexer/tests/fork_indexer.rs`, `services/explorer-indexer/tests/catch_up_budget.rs`, `services/explorer-indexer/tests/vault_snapshot_cadence.rs`, `services/explorer-indexer/tests/reorg_cursor_vault_status.rs`, `docs/explorer-api.md`

**Related.** related findings review-security-056, review-security-059; finder note: QA plan X7 / core 1820; P1 (ADR-0014 §9 ExclusionLedgerFactory)

### 56. Low — The indexer caches each vault's ExclusionLedger forever and never refreshes it on the vault's Upgraded event, so a governed ledger migration silently drops every new exclusion record

**Index:** L-028 (review-security-056)

- **Where:** `services/explorer-indexer/src/indexer.rs:1099` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / indexer / code
- **Class / confidence:** `SECURITY_LIFECYCLE_GAP` / medium
- **Skeptics:** 2 of 3 confirmed. Votes: low, low, refuted. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-56

**Scenario.** A bug is found in ExclusionLedger. Governance upgrades rmUSDC through the timelock, and the reinitializer creates and stores a new ledger. The indexer keeps watching the old ledger address. Every ExclusionRecordOpened or claim event from the new ledger fails the emitter gate and is dropped. The explorer and any client that reads it show no claims for holders who are owed a pro-rata share. The same happens to a basket vault that gains a ledger through an upgrade, because its NULL row is never re-read.

**Evidence.**

- services/explorer-indexer/src/indexer.rs:1098-1099 uses the stored vault_exclusion_ledgers row whenever one exists. The chain is read only when no row exists (1100-1138). A NULL row (LedgerRead::NoLedger) is final.
- services/explorer-indexer/migrations/0026_vault_exclusion_ledgers.sql says the row is 'written once from the vault's own exclusionLedger() getter (set once, in initialize)' and that 'a NULL row is a final answer'. The emitter gate accepts exclusion events only from stored ledgers.
- indexer.rs:2793-2808 handles Upgraded and UpgradesFrozen by inserting proxy_upgrade_events only. It does not invalidate vault_exclusion_ledgers for that vault.
- contracts/RobotMoneyVault.sol:168 declares `ExclusionLedger public exclusionLedger` as a plain state variable written by _initLedger (line 485). ExclusionLedger is not in proxied.txt. Under ADR-0014 the only way to fix a ledger bug is a vault upgrade whose reinitializer points the vault at a new ledger.

**Recommended fix (reviewer).** When an Upgraded event from a watched vault is indexed, delete that vault's vault_exclusion_ledgers row in the same transaction, so the next tick re-reads exclusionLedger() at the safe head. Keep the old ledger in the watched set as well, so late claims against it still index.

**Regression test the reviewer asked for.** services/explorer-indexer/tests/fork_indexer.rs (or consensus_receipt_indexing-style DB test): seed a vault_exclusion_ledgers row for vault V. Index an Upgraded log from V. Assert the row is gone and that the next tick reads the getter again and accepts an exclusion event from the new ledger address.

**What the fixer changed.**

- Migration 0026 was amended in place. It is untracked and was created in round 1 on this branch, so no deployed DB has it. The PK is now (chain_id, vault_address, block_number), one row per answer. exclusion_ledgers_of returns every ledger a vault ever named, so old ledgers stay watched. The new exclusion_ledgers_moved_by_upgrades runs in the same tick, after the discovery refetch. It re-reads the getter at the safe head for each watched vault that emitted Upgraded. A new ledger is stored as of the upgrade block, so a reorg drops it with the upgrade, and its logs are refetched from that block to target before the cursor moves. I chose this over the finding's 'delete the row, re-read next tick': that approach loses new-ledger events between the upgrade and the tick's target. A NULL (basket) row gains a ledger the same way. The test covers the same-tick record on the new ledger, a late record on the old ledger, a basket vault gaining a ledger, one getter read per upgrade, and reorg rollback.

**Regression tests the fixer wrote (not run).**

- services/explorer-indexer/tests/vault_detail.rs::a_vault_upgrade_that_moves_its_ledger_keeps_both_ledgers_indexed

**Files changed:** `services/explorer-indexer/migrations/0026_vault_exclusion_ledgers.sql`, `services/explorer-indexer/src/indexer.rs`, `services/explorer-indexer/src/db.rs`, `services/explorer-indexer/src/abi.rs`, `services/explorer-indexer/tests/vault_detail.rs`, `docs/explorer-api.md`

**Related.** related findings review-security-055, review-security-057, review-security-058; finder note: Follows the round-1 fix of 'Indexer derives the ExclusionLedger as vault.create(1)' (indexer.rs:1036): the read is now correct, but it is cached for the proxy's whole life.

### 57. Low — Every exclusionLedger() read is made at the safe head, so a rebuilt or late-starting indexer, a vault discovered after a ledger move, or two moves in one window never stores the older ledger

**Index:** L-029 (review-security-057)

- **Where:** `services/explorer-indexer/src/indexer.rs:1184` (line as the round 3 finder saw it)
- **Round / lane / owner:** 3 / indexer / code
- **Class / confidence:** `SECURITY_DATA_MISSING_EVENTS_LEDGER_HISTORY` (lens class: `DATA_MISSING_EVENTS_LEDGER_HISTORY`) / medium
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-57

**Scenario.** rmUSDC is upgraded with a reinitializer that moves it from ledger L1 to L2 (the ADR-0014 fix path). Later the explorer DB is rebuilt from the deploy floor, or the indexer was first started after the upgrade. The first tick reads exclusionLedger() at the safe head and stores only L2. The Upgraded log at the move block re-reads L2 and skips. L1's records, recoveries and claims are never fetched. /v1/accounts/:address/exclusion-claims silently omits them, and the dapp never shows them either.

**Evidence.**

- services/explorer-indexer/src/indexer.rs:1086-1119 exclusion_ledgers_of reads a vault with no stored row at read_block = safe_head (called at 1626 and 1652), which names only the newest ledger
- services/explorer-indexer/src/indexer.rs:1184-1239 exclusion_ledgers_moved_by_upgrades re-reads at the safe head and skips a ledger already known (1216-1221), so a pre-move ledger is never recovered
- services/explorer-indexer/src/indexer.rs:2954-2966 the emitter gate refuses every event from a ledger with no vault_exclusion_ledgers row
- docs/adr/ADR-0014-governed-upgrades-and-freeze.md §2: a ledger fix is a vault upgrade that opens new records in a new ledger while old records keep paying from the old one
- docs/explorer-api.md and migrations/0025 claim 'the old ledger stays watched', which holds only for an indexer that read the vault before the move
- clients/dapp/src/lib/useExclusionClaims.ts reads only the vault's current exclusionLedger(), so after a move the explorer is the only surface for old-record claims
- contracts/ExclusionLedgerFactory.sol emits ExclusionLedgerCreated(vault indexed, ledger indexed) for every ledger; the indexer does not use it

**Recommended fix (reviewer).** Learn each vault's ledgers from ExclusionLedgerFactory's ExclusionLedgerCreated events (watch the factory, filter on the vault topic), or on each vault Upgraded also read exclusionLedger() at upgrade_block - 1 and store both answers. Until then, scope the docs claim to an indexer that was live before the move.

**Regression test the reviewer asked for.** vault_detail.rs: fresh DB, stub vault whose getter answers L2 at the safe head and L1 at block U-1, an Upgraded at U, and an L1 ExclusionOpened before U; assert the L1 record is indexed and L1 stays watched.

**What the fixer changed.**

- A vault's first read is now made at the tick's from_block, or at the registration block for a newly discovered vault. The answer is stored as of the block that answered. Triggers are read at their own block, so two moves in one range each name their ledger. The new read_ledger_at falls back to the safe head on RpcError::Server (other than a revert) or Refused, so a pruned node does not wedge the tick. That fallback names only the newest ledger. docs/explorer-api.md now says a full rebuild needs an RPC that serves old state. I did not use the ExclusionLedgerFactory-event approach. It needs a new configured factory address, and that means deploy wiring in other lanes. Test 1 uses a fresh DB, and the getter answers L1 below U and L2 from U. Both ledgers' records are indexed, and a late L1 claim in the next tick is indexed, with L1 still in the getLogs filter. Test 2 shows that 'missing trie node' at old blocks falls back to the safe head and the tick succeeds.

**Regression tests the fixer wrote (not run).**

- services/explorer-indexer/tests/vault_detail.rs::a_rebuilt_index_learns_the_ledger_a_vault_moved_away_from ; services/explorer-indexer/tests/vault_detail.rs::a_node_without_old_state_reads_the_ledger_at_the_safe_head

**Files changed:** `services/explorer-indexer/src/indexer.rs`, `services/explorer-indexer/src/db.rs`, `services/explorer-indexer/tests/vault_detail.rs`, `docs/explorer-api.md`

**Residual.** A full rebuild needs an RPC that serves old state. A pruned node falls back to the newest ledger only.

**Related.** related findings review-security-056, review-security-058; finder note: Round-1 finding 'The indexer caches each vault's ExclusionLedger forever and never refreshes it on the vault's Upgraded event' (indexer.rs:1099)

### 58. Low — The indexer re-reads a vault's ExclusionLedger only on Upgraded

**Index:** L-030 (review-security-058)

**Statement.** The indexer re-reads a vault's ExclusionLedger only on Upgraded. A reinitializer run as a later timelock operation (the ADR-0014 empty-call path) moves the ledger without the indexer seeing it

- **Where:** `services/explorer-indexer/src/indexer.rs:1195` (line as the round 3 finder saw it)
- **Round / lane / owner:** 3 / indexer / code
- **Class / confidence:** `SECURITY_LIFECYCLE_GAP` / high
- **Skeptics:** 2 of 3 confirmed. Votes: low, low, refuted. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-58

**Scenario.** Governance upgrades rmUSDC with upgrade-proxy and no call=, which the tool and the runbook allow. A later Safe-scheduled timelock operation runs `initializeV2` (onlyUpgradeAuthority reinitializer), which points exclusionLedger at a new ledger. The tick that held Upgraded reads the old ledger, which is already known, so nothing is stored. The reinitializer transaction 48 hours later emits only Initialized. The indexer keeps watching the old ledger, drops every record of the new ledger at the emitter gate, and serves stale exclusion data with no error.

**Evidence.**

- services/explorer-indexer/src/indexer.rs:1195: only a `proxy_upgraded` log from a vault triggers the re-read. indexer.rs:1682-1684 says 'an upgrade's reinitializer is the one way to point it at a new ExclusionLedger'.
- contracts/lib/GovernedUpgrade.sol:97-102 and contract-release-runbooks.md §4.12: an upgrade installed without call= leaves the reinitializer pending, and only a later timelock operation can call it. That call emits Initialized(uint64), not Upgraded.
- indexer.rs:1098-1105: the stored ledger rows are reused forever. read_exclusion_ledger runs only for a vault that has no row yet.
- contracts/RobotMoneyVault.sol:491: an initializer is the only place that sets exclusionLedger, so every ledger move goes through a reinitializer.

**Recommended fix (reviewer).** Also treat a vault's `Initialized(uint64)` log as a re-read trigger in exclusion_ledgers_moved_by_upgrades. Or re-read exclusionLedger() of every ledger vault whenever the configured timelock's CallExecuted targets that vault.

**Regression test the reviewer asked for.** Add a fork_indexer test: upgrade with empty data, then call the reinitializer in a later block so it points at a new ledger. Open an exclusion on that ledger and assert the record is indexed.

**What the fixer changed.**

- I added `Initialized(uint64)` to IUpgradeEvents, to Topics (proxy_initialized), to all_topic0, to the artifact drift table (RobotMoneyVault) and to the canonical signature table. handle_log ignores it and stores nothing. exclusion_ledgers_moved_by_upgrades now treats Upgraded or Initialized from a ledger vault as a trigger, with one read per (vault, block), at the trigger's own block. The test uses a stub RPC, not a Twin fork. RobotMoneyVault has no reinitializer that moves the ledger, and fork tests cannot run here. Tick 1 has Upgraded at 55 and the getter still names L1, so nothing is stored. Tick 2 has Initialized at 60, which moves to L2, and L2 opens a record at 61. The test asserts L2 is stored as of block 60 and read at block 60, and its record is indexed. I added a block-aware stub hook, set_call_hook_at, to tests/common.

**Regression tests the fixer wrote (not run).**

- services/explorer-indexer/tests/vault_detail.rs::a_reinitializer_run_after_its_upgrade_moves_the_ledger_and_is_indexed

**Files changed:** `services/explorer-indexer/src/abi.rs`, `services/explorer-indexer/src/indexer.rs`, `services/explorer-indexer/src/db.rs`, `services/explorer-indexer/tests/vault_detail.rs`, `services/explorer-indexer/tests/common/mod.rs`, `docs/explorer-api.md`

**Related.** related findings review-security-056, review-security-057; finder note: The round-2 finding 'indexer caches each vault's ExclusionLedger forever and never refreshes it on the vault's Upgraded event' (indexer.rs:1099). That fix is incomplete.

### 59. Low — Now that exclusion ledgers are actually indexed, opening one record makes the tick read the snapshot balance of every depositor in the vault's history, one eth_call at a time

**Index:** L-031 (review-security-059)

**Statement.** Now that exclusion ledgers are actually indexed, opening one record makes the tick read the snapshot balance of every depositor in the vault's history, one eth_call at a time. Dust receivers can stretch that into an hours-long stall during an incident.

- **Where:** `services/explorer-indexer/src/indexer.rs:1199` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / indexer / code
- **Class / confidence:** `SECURITY_DOS_INDEXER_STALL` / medium
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-59

**Scenario.** An attacker deposits 1 base unit to 100,000 fresh receivers in about 1,000 transactions, for roughly $1k of gas on Base. When governance or EMERGENCY later opens an exclusion record during an adapter incident, the indexer's next tick makes 100,000 sequential eth_calls against the public Base RPC. That takes hours, and any refused call restarts the tick. During the incident the watchdog evaluates nothing and pages indexer_behind. Explorer claims stay stale, though the dapp reads claims on chain.

**Evidence.**

- services/explorer-indexer/src/indexer.rs:1199-1214: on ExclusionOpened the tick loops over exclusion_snapshot_candidates and makes one sequential exclusion_balance_at eth_call per holder. A failed read fails the whole tick.
- services/explorer-indexer/src/db.rs:2835-2842: the candidates are every distinct wallet_positions owner of the vault at or below the opened block, including holders who have exited. Zero balances are not stored (indexer.rs:1206), so they are read again on every retry.
- services/explorer-indexer/src/indexer.rs:1432-1446: the round-1 fix now watches the real ledger. Before it no ExclusionOpened was ever indexed, so this path was never live.
- contracts/RobotMoneyVault.sol:582-634: deposit has no minimum and the receiver is arbitrary. One transaction can create about 100 distinct receivers, each with a wallet_positions row.

**Recommended fix (reviewer).** Move snapshot balance reads out of the tick into a budgeted background pass, like the receipt sweep. Read only owners whose latest wallet_positions row at or below the opened block has shares > 0, and batch the reads through Multicall3.

**Regression test the reviewer asked for.** Indexer test: a vault with 10,000 wallet_positions owners and one ExclusionOpened. Assert the tick finishes within a fixed bound and that every non-zero holder balance is stored within N later ticks.

**What the fixer changed.**

- record_exclusion_balances now handles only claim-revealed holders. The new read_snapshot_balances pass runs every tick under SNAPSHOT_READ_TIME_BUDGET = 10 s. It reads candidates in owner byte order, 256 per DB batch, and only owners whose latest wallet_positions row at or below the record block has shares > 0. Progress goes to a new exclusion_snapshot_progress table (migration 0028: read_through, done, block_number = the record's block, so it rolls back with the record). That keeps exclusion_records append-only, and zero balances are never re-read. A failed or cut read ends the pass for that tick without failing the tick, and the next tick resumes at that holder. Multicall3 batching was not added; the budget alone removes the stall. The existing exclusion_record_events_store_each_snapshot_holders_balance expectations still hold.

**Regression tests the fixer wrote (not run).**

- services/explorer-indexer/tests/vault_detail.rs::exclusion_snapshot_balances_are_read_by_a_budgeted_pass; services/explorer-indexer/tests/reorg_cursor_vault_status.rs (rollback set now must include exclusion_snapshot_progress)

**Files changed:** `services/explorer-indexer/migrations/0028_exclusion_snapshot_progress.sql`, `services/explorer-indexer/src/indexer.rs`, `services/explorer-indexer/src/db.rs`, `services/explorer-indexer/tests/vault_detail.rs`, `services/explorer-indexer/tests/reorg_cursor_vault_status.rs`, `docs/explorer-api.md`

**Residual.** Multicall3 batching of snapshot reads was not added.

**Related.** related findings review-security-053, review-security-054, review-security-055; finder note: Composition of the round-1 fix for 'Indexer derives the ExclusionLedger as vault.create(1)' (services/explorer-indexer/src/indexer.rs:1036) with X7 holder snapshots.

### 60. Low — The fix for inline payload and memo fetches is incomplete

**Index:** L-032 (review-security-060)

**Statement.** The fix for inline payload and memo fetches is incomplete. The handle_log fetches still run inside the tick with no tick budget, and the new DNS lookup sits outside the client timeout.

- **Where:** `services/explorer-indexer/src/indexer.rs:2859` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / indexer / code
- **Class / confidence:** `SECURITY_DOS_INDEXER_STALL` / medium
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-60

**Scenario.** A committee agent records 100 receipts in one block, each pointing at a host that accepts the connection and never answers, or at a name whose nameserver never replies. The tick that contains them blocks for about 40 minutes or more. While it does, the watchdog sees no new indexed blocks and pages indexer_behind, but mint and burn evaluation stays blind. /health turns degraded after 300 s. The run fails safe because it pages, but the stall is repeatable for the cost of gas.

**Evidence.**

- services/explorer-indexer/src/indexer.rs:2859: every ReceiptRecorded log runs fetch_and_verify_payload inline in handle_log. That is 3 attempts x 5 s plus 8 s of backoff, about 23 s per receipt, and there is no per-tick cap.
- services/explorer-indexer/src/indexer.rs:2606: every VoteSubmitted log runs fetch_and_verify_memo inline with a 10 s timeout.
- Only the sweep got the round-1 budget: services/explorer-indexer/src/indexer.rs:2985-3021 (SWEEP_TIME_BUDGET, timeout_at).
- services/explorer-indexer/src/indexer.rs:3204: guarded_fetch_client calls tokio::net::lookup_host before building the client. The reqwest timeout does not cover this, so a slow authoritative DNS adds the system resolver timeout to every inline attempt.
- contracts/gateway/ConsensusRecommendationReceipt.sol:159-166 and contracts/gateway/InvestmentCommitteePolicy.sol:242-253: any COMMITTEE_AGENT_ROLE member can record receipts or votes through the gateway with an arbitrary URI.

**Recommended fix (reviewer).** Store new receipts and votes with verified=false and no inline fetch, then let the budgeted sweep verify them (extend the sweep to votes). Wrap lookup_host in the same per-attempt timeout as the request.

**Regression test the reviewer asked for.** Indexer test: one tick holds 10 ReceiptRecorded logs whose payload host never answers. Assert the tick finishes within a fixed bound (for example under 5 s) and the sweep later records the attempts. Unit test: guarded_fetch_client against a resolver stub that hangs returns an error within the timeout.

**What the fixer changed.**

- handle_log is now a wrapper with no deadline. The tick calls handle_log_within with a shared deadline, INLINE_FETCH_TIME_BUDGET = 30 s. Past it a ReceiptRecorded is stored with verified=false and attempts 0, so it lands in the sweep's working set. A fetch still in flight at the deadline is cut and counts as one attempt. guarded_fetch_client now resolves through resolve_within(), which wraps lookup_host in the attempt's timeout. That covers memo fetches too. Partly deferred: VoteSubmitted memo fetches stay inline, now bounded only by 10 s plus the DNS timeout. Moving them to a sweep needs attempt columns on committee_votes and a regime-snapshot refresh on repair. Putting them under the tick budget would let one committee member permanently unverify another member's vote.

**Regression tests the fixer wrote (not run).**

- services/explorer-indexer/tests/consensus_receipt_indexing.rs::tarpit_payload_hosts_cannot_hold_the_indexing_tick_past_the_inline_budget; services/explorer-indexer/tests/consensus_receipt_indexing.rs::a_resolver_that_never_answers_fails_within_the_fetch_timeout

**Files changed:** `services/explorer-indexer/src/indexer.rs`, `services/explorer-indexer/tests/consensus_receipt_indexing.rs`, `docs/technical/consensus-receipt-submitter-runbook.md`

**Related.** related findings review-security-061, review-security-062; finder note: Earlier finding (low): Receipt payloadUri and vote rationaleUri are fetched inline in the tick with no host or scheme limit and the body buffered before the size cap (services/explorer-indexer/src/indexer.rs:2970). Host, scheme and body cap are fixed. The inline-in-tick part is not.

### 61. Low — Vote memo fetches still run inline with no tick budget: round 2 budgeted only receipt payloads, and the IC policy is now watched on 8453 and stage

**Index:** L-033 (review-security-061)

- **Where:** `services/explorer-indexer/src/indexer.rs:2874` (line as the round 3 finder saw it)
- **Round / lane / owner:** 3 / indexer / code
- **Class / confidence:** `SECURITY_DOS_INDEXER_STALL_INCOMPLETE_FIX` / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-61

**Scenario.** A committee agent hot key submits 1,000 votes in one block whose rationaleUri is a blackholed IP. The tick that indexes them waits about 10-20 s per vote, 3-5 hours, inside handle_log. No run finishes, so the watchdog evaluates no new block and its mint/burn auto-pause is blind for that time. It only pages indexer_behind. Any failure after handle_log repeats the whole wait.

**Evidence.**

- services/explorer-indexer/src/indexer.rs:2859-2885 the VoteSubmitted branch (the line the round-1 finding cited) awaits fetch_and_verify_memo for each vote with no deadline
- services/explorer-indexer/src/indexer.rs:3651 guarded_fetch_client(rationale_uri, 10s): DNS up to 10 s plus the request up to 10 s per vote
- services/explorer-indexer/src/indexer.rs:2236-2252 INLINE_FETCH_TIME_BUDGET covers 'the payloads of the receipts' only; the deadline reaches only the ReceiptRecorded branch (3129-3157)
- contracts/gateway/InvestmentCommitteePolicy.sol:242-252 and RobotMoneyGateway.sol:1351-1358: any AGENT_ROLE + COMMITTEE_AGENT_ROLE key can submit unlimited votes with any non-empty rationaleUri
- scripts/stage/mainnet-dapp.ts:493 and testing/smoke-test/src/lib.rs:3106 now set INDEXER_INVESTMENT_COMMITTEE, so VoteSubmitted (abi.rs:708) is fetched where it was not before
- The fetch runs before insert, so a tick that fails later re-fetches every memo; there is no vote re-verification sweep and tilts count only verified votes (db.rs:121)

**Recommended fix (reviewer).** Pass the tick's inline deadline into the VoteSubmitted branch and share INLINE_FETCH_TIME_BUDGET; past it, store the vote unverified without a fetch. Add a budgeted vote re-verification sweep like sweep_unverified_receipts, so budget-skipped and briefly unreachable memos still verify and count toward the tilt.

**Regression test the reviewer asked for.** Indexer integration test: five VoteSubmitted logs whose rationaleUri points at a listener that accepts and never answers; assert run_once returns within the inline budget plus margin with all five votes stored, then a later tick's sweep verifies one whose host now answers.

**What the fixer changed.**

- The VoteSubmitted branch now shares INLINE_FETCH_TIME_BUDGET with receipts. Past the deadline a vote is stored unfetched, and the in-flight fetch is cut by timeout_at. Migration 0029 adds committee_votes.verify_attempts, last_verify_error and a partial index. The new Db functions are note_vote_verification (called only when the insert stored a row), list_unverified_votes (newest first) and repair_vote_verification (never downgrades, counts every attempt). The new sweep_unverified_votes runs in run_once after the receipt sweep under the same SWEEP_TIME_BUDGET deadline. So the worst-case cost per tick is unchanged at 30 s total. The cap is 12 attempts per vote. The tick's existing DI-3 regime refresh counts a vote once it verifies. The test sends five votes at hosts that never answer. The first tick returns within budget plus 15 s with all five stored, and vote 5 has 0 attempts. Then vote 5's host starts answering. The next tick's sweep verifies vote 5, the tarpit attempts count, and the vault's regime vote_count becomes 1.

**Regression tests the fixer wrote (not run).**

- services/explorer-indexer/tests/committee_indexing.rs::tarpit_memo_hosts_cannot_hold_the_tick_and_the_sweep_verifies_a_skipped_vote

**Files changed:** `services/explorer-indexer/src/indexer.rs`, `services/explorer-indexer/src/db.rs`, `services/explorer-indexer/migrations/0029_committee_votes_verify_attempts.sql`, `services/explorer-indexer/tests/committee_indexing.rs`, `docs/architecture.md`

**Related.** related findings review-security-060; finder note: Round-1 finding 'The fix for inline payload and memo fetches is incomplete' (indexer.rs:2859); round-1 IC policy watch fix

### 62. Low — Receipt payloadUri and vote rationaleUri are fetched inline in the tick with no host or scheme limit and the body buffered before the size cap

**Index:** L-034 (review-security-062)

- **Where:** `services/explorer-indexer/src/indexer.rs:2970` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / indexer / code
- **Class / confidence:** `SECURITY_SSRF_UNBOUNDED_FETCH` / medium
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-62

**Scenario.** An allowlisted receipt submitter (or a compromised frontend key) records 16+ receipts whose payloadUri points at a tarpit. Each tick spends about 6 minutes in the sweep before indexing, for 12 passes per receipt, so the watchdog's volume evaluation lags by minutes to hours. indexer_behind does page, so this fails visible. URIs like http://169.254.169.254/... make the indexer probe its internal network, and the response size is published in /v1/consensus-receipts.

**Evidence.**

- services/explorer-indexer/src/indexer.rs:2970-2998 and 3066-3097: reqwest GET of the on-chain URI with no scheme, host or private-IP check. resp.bytes() reads the whole body, and only then is the 1 MiB cap checked (2989, 3089).
- indexer.rs:2757 the receipt fetch runs inside handle_log: 3 attempts × 5 s plus 2 s and 6 s backoff, about 23 s per receipt. indexer.rs:936 the sweep runs before run_inner every tick: 16 receipts per pass, up to 12 passes each (SWEEP_MAX_ATTEMPTS).
- clients/explorer-api/src/routes.rs:2050-2053 serves payload_bytes and verified publicly, which reveals the size and 2xx status of whatever the indexer's network position fetched.
- contracts/gateway/ConsensusRecommendationReceipt.sol:159-170: any allowlisted submitter chooses payloadUri freely.

**Recommended fix (reviewer).** Allow only https and refuse loopback, link-local and private ranges after DNS resolution. Stream the body with a hard byte cap. Move payload and memo fetching out of the tick into the bounded async sweep only, with a per-tick time budget. Stop serving payload_bytes for unverified rows.

**Regression test the reviewer asked for.** Unit test: fetch_payload_once refuses http://127.0.0.1 and http://169.254.169.254. Integration test: a tarpit payload host cannot hold run_once beyond a fixed budget.

**What the fixer changed.**

- guarded_fetch_client allows only http and https. It refuses link-local addresses (169.254.169.254), unspecified, broadcast, multicast, fd00:ec2::254 and IPv4-mapped forms of these, whether given as an IP literal or reached after DNS. It pins the connection to the checked addresses with resolve_to_addrs and follows at most 5 redirects, same host only. Bodies are streamed through read_capped_body with a 1 MiB cap. The sweep has a 30 s per-tick budget (SWEEP_TIME_BUDGET), and a fetch cut by the budget still counts toward SWEEP_MAX_ATTEMPTS. The API serves payload_bytes only for verified rows. Decision: loopback and private ranges stay allowed, unlike the finding's suggested 127.0.0.1 refusal, because devnets and every receipt and committee test serve payloads from them. Not done: moving the inline handle_log fetch out of the tick, because it would change the verification timing that the receipt tests assert. That fetch stays bounded at about 23 s per receipt. tokio feature 'net' was added for lookup_host.

**Regression tests the fixer wrote (not run).**

- consensus_receipt_indexing::fetch_payload_once_refuses_metadata_link_local_and_other_schemes; consensus_receipt_indexing::only_link_local_unspecified_broadcast_and_multicast_hosts_are_forbidden; consensus_receipt_indexing::a_body_past_the_cap_is_refused_while_it_streams; consensus_receipt_indexing::tarpit_payload_hosts_cannot_hold_the_tick_past_the_sweep_budget (8 tarpit receipts, run_once must return within SWEEP_TIME_BUDGET + 15 s, which is about 30 s of test time); consensus_receipt_api::unverified_and_unreleased_receipts_are_still_listed (extended: an unverified receipt serves payload_bytes null)

**Files changed:** `services/explorer-indexer/src/indexer.rs`, `services/explorer-indexer/Cargo.toml`, `services/explorer-indexer/tests/consensus_receipt_indexing.rs`, `clients/explorer-api/src/routes.rs`, `clients/explorer-api/src/model.rs`, `clients/explorer-api/tests/consensus_receipt_api.rs`, `docs/technical/consensus-receipt-submitter-runbook.md`

**Residual.** Loopback and private address ranges stay allowed so devnets work. The inline-in-tick part was finished in rounds 2 and 3.

**Related.** related findings review-security-060; finder note: T12 sweep; docs/code-review/20261012-security-review.md finding 3 context

### 63. Low — wallet_positions drops the second share change of an owner in one block because the writer reads its own row then hits ON CONFLICT DO NOTHING

**Index:** L-035 (review-security-063)

- **Where:** `services/explorer-indexer/src/indexer.rs:3108` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / indexer / code
- **Class / confidence:** `SECURITY_DATA_LOST_UPDATE` (lens class: `DATA_LOST_UPDATE`) / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-63

**Scenario.** An agent makes two gateway deposits for the same shareReceiver in one Base block (or a deposit and a withdraw land in one block). The first Deposit writes P+s1 at block B. The second reads P+s1, computes P+s1+s2 and is silently discarded. /v1/accounts/:addr/positions and the dapp PositionSelector prefill understate or overstate shares until a later event. Signing is unaffected because the dapp checks the on-chain balance.

**Evidence.**

- services/explorer-indexer/src/indexer.rs:3108-3132 persist_wallet_position reads latest_wallet_position(..., block) and inserts prior ± shares at the same block.
- services/explorer-indexer/src/db.rs:1561-1564 the read uses block_number <= $4, so it returns the row just written for this block. db.rs:1529-1533 the insert is ON CONFLICT (chain_id, contract, owner, block_number) DO NOTHING.
- tests/account_history.rs:415-470 'same block' test actually uses blocks 8 and 10. No test covers two events for one owner in one block.

**Recommended fix (reviewer).** Accumulate per (contract, owner, block) within the tick and write once, or use ON CONFLICT DO UPDATE SET shares = EXCLUDED.shares keyed by the event's log_index ordering. Keep replay idempotent by recording the last applied (block, log_index) per row.

**Regression test the reviewer asked for.** idempotency/account test: two ERC-4626 Deposit logs for the same owner and vault at the same block, different log_index. Assert wallet_positions equals s1+s2, and still equals s1+s2 after replaying the tick.

**What the fixer changed.**

- Migration 0027 adds wallet_positions.last_log_index. The new Db::apply_wallet_position_delta runs in a transaction. If the block already has a row with a lower log index, it uses that row as the prior balance and updates it in place (ON CONFLICT DO UPDATE ... WHERE last_log_index < new). A log at or below last_log_index is skipped, so a replay is a no-op. A legacy row with NULL last_log_index is treated as final, which is the old DO NOTHING behaviour.

**Regression tests the fixer wrote (not run).**

- account_history::two_share_changes_of_one_owner_in_one_block_both_count (two Deposits and a Withdraw of one owner at block 10 through run_once, then a full replay after the indexer_runs are deleted, still 1200000); idempotency::wallet_position_delta_counts_each_log_of_a_block_once

**Files changed:** `services/explorer-indexer/migrations/0027_wallet_position_log_index.sql`, `services/explorer-indexer/src/db.rs`, `services/explorer-indexer/src/indexer.rs`, `services/explorer-indexer/tests/account_history.rs`, `services/explorer-indexer/tests/idempotency.rs`

**Related.** related findings review-security-053; finder note: IDX-3

### 64. High — Round-1 router-leg netting makes the watchdog's per-hour mint query quadratic in deposit history

#### SEC-H-004 (review-security-064)

**Statement.** Round-1 router-leg netting makes the watchdog's per-hour mint query quadratic in deposit history. The watchdog then lags block production without paging, because its heartbeat refreshes on every evaluated block.

- **Where:** `services/watchdog/src/volume.rs:58` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / indexer / code
- **Class / confidence:** `SECURITY_MONITOR_SILENT_DEGRADATION` / high
- **Skeptics:** 3 of 3 confirmed. Votes: high, high, high. The finder said high.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-64

**Scenario.** Anyone sends a few thousand small PortfolioRouter.deposit or direct vault.deposit transactions (each in its own tx), or organic usage reaches the same count. Each mint_volume_per_hour call then takes seconds to minutes, and it runs for every Base block. The watchdog evaluates blocks slower than the chain makes them, so its distance behind the head grows without bound. store_cursor still refreshes updated_at each block, so watchdog-liveness reports healthy and no indexer_behind page fires. A mint or burn spike is detected, alerted and auto-paused hours late or never. That defeats the §9 response-time SLA while the liveness check reports success.

**Evidence.**

- services/watchdog/src/volume.rs:58-71 DIRECT_DEPOSITS_NET_OF_ROUTER_LEGS has a correlated scalar subquery on router_deposit_legs (chain_id, tx_hash, vault). It runs once per (tx, vault) group.
- services/watchdog/src/volume.rs:117-147 and :239-270: the per-hour queries splice it in with only a chain or vault filter. Every direct-deposit group in the chain's history is aggregated before the blocks timestamp join filters it.
- services/explorer-indexer/migrations/0006_agent_deposit_vault_and_router_legs.sql:48-58: router_deposit_legs has no (chain_id, tx_hash) index. Each SubPlan run scans every leg of that vault through router_deposit_legs_vault_idx.
- Measured on postgres:16 with the same tables and indexes. 20,000 two-leg router deposits: the new mint_volume_per_hour took 37.8 s (SubPlan loops=40000, 20000 legs each) and the pre-fix query took 20 ms. 5,000 router deposits: 2.5 s, already longer than Base's 2 s block time.
- services/watchdog/src/watchdog.rs:650-677 calls run_cycle for every block number from cursor+1 to the indexed head. Each call runs the global per-hour mint query plus one per configured vault. store_cursor after each block refreshes the heartbeat.
- services/watchdog/src/liveness.rs:9-14,102-110: liveness reads only the heartbeat age. IndexerBehind is checked only when there is no new block (watchdog.rs:625-646). Nothing pages when the watchdog's cursor falls behind the indexed head.
- contracts/PortfolioRouter.sol:877-907: deposit and depositFor are public with no minimum. contracts/RobotMoneyVault.sol:582 deposit is public with no minimum. Anyone can add groups or legs cheaply.

**Recommended fix (reviewer).** Pre-aggregate router legs per (chain_id, tx_hash, vault) in a grouped subquery and LEFT JOIN it, instead of a correlated scalar subquery. Restrict the direct source to the window's blocks before grouping (join blocks inside the subquery, or filter vte.block_number by the window's first block). Add an index on router_deposit_legs(chain_id, tx_hash). Separately, have the watchdog page when its cursor lags the indexed head by more than a budget, so a slow watchdog cannot read as live.

**Regression test the reviewer asked for.** Watchdog DB test: seed 5,000 two-leg router deposits, one per block, plus matching vault_transfer_events. Assert mint_volume_per_hour and mint_volume_per_hour_for_vault each return in under 200 ms, or assert EXPLAIN shows no SubPlan whose loop count scales with history. Add a liveness test where the cursor is more than max_lag_blocks behind the indexed head and assert the run pages or reports stale.

**What the fixer changed.**

- The correlated subquery is gone. DIRECT_DEPOSITS_NET LEFT JOINs router legs and gateway deposits that are pre-aggregated per (chain, block, tx, vault). All three sources are cut to the evaluated block before grouping. Per-hour queries also filter block_number > block_before_window(), which walks the blocks primary key down from the newest block. Per-hour burn queries got the same window floor. The (chain_id, tx_hash) index was not added because the joins now ride the (chain_id, block_number, log_index) primary keys. Liveness: new [indexer_lag] max_cursor_lag_blocks (default 150, validated > 0). advance_cursor() moves the cursor every block but refreshes updated_at only while the newest successful indexer run's cursor minus this block is within the budget. Past the budget the heartbeat ages and watchdog-liveness reports stale, so the supervisor pages watchdog_cursor_stale. store_cursor is unchanged and is still used by tests to seed.

**Regression tests the fixer wrote (not run).**

- services/watchdog/tests/cursor_and_volume.rs::mint_volume_queries_cost_the_window_not_the_history; services/watchdog/tests/liveness.rs::a_watchdog_far_behind_the_indexed_head_reports_stale; services/watchdog/src/liveness.rs::tests::a_budget_that_would_page_every_poll_is_refused (extended)

**Files changed:** `services/watchdog/src/volume.rs`, `services/watchdog/src/watchdog.rs`, `services/watchdog/src/liveness.rs`, `services/watchdog/src/config.rs`, `services/watchdog/config.example.toml`, `docs/operations/watchdog-liveness.md`, `docs/architecture.md`

**Related.** related findings review-security-065, review-security-067; finder note: Introduced by the round-1 fix for 'A direct PortfolioRouter.deposit is counted twice in watchdog mint volume' (services/watchdog/src/volume.rs:60).

### 65. Low — A direct PortfolioRouter.deposit is counted twice in watchdog mint volume, so it trips the auto-pause at half the configured threshold

**Index:** L-036 (review-security-065)

- **Where:** `services/watchdog/src/volume.rs:60` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / indexer / code
- **Class / confidence:** `SECURITY_SIGNAL_DOUBLE_COUNT` / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-65

**Scenario.** Anyone calls router.deposit(501 USDC). The legs total 501 and the vault Deposit events total 501, so the watchdog sees 1002 > 1000. It pages and submits gateway.pauseDeposits(), which only a timelocked ADMIN can undo. The attacker redeems the shares afterwards. The design already lets 1001 USDC trigger the pause, so this halves the cost of that griefing and inflates per-hour sums.

**Evidence.**

- services/watchdog/src/volume.rs:52-66 sums router_deposit_legs plus vault_transfer_events deposits whose tx has no agent_deposits row.
- contracts/PortfolioRouter.sol:871-900: deposit() and depositFor() are public. A direct call emits RouterDeposit legs and each leg vault's ERC-4626 Deposit, with no gateway event, so no agent_deposits row exists for that tx.
- Every registered vault is watched (indexer.rs:1306-1323, X2), so those Deposit logs are stored. The per-vault variant (volume.rs:184-200) double counts the same way.
- services/watchdog/tests/cursor_and_volume.rs:415-436 covers only the gateway-routed case (parent row present). No test pairs legs with vault Deposit rows in one tx without a parent.
- services/watchdog/config.toml:13-30 example limits are 1000 USDC per block with mode pause_and_alert. Unpause needs ADMIN through the timelock.

**Recommended fix (reviewer).** In the direct-deposit branch, also exclude vault_transfer_events deposits whose tx_hash has router_deposit_legs for the same vault (or whose caller is the configured router). Apply this to both the global and per-vault queries.

**Regression test the reviewer asked for.** cursor_and_volume: insert two router_deposit_legs and the matching two vault_transfer_events deposits in one tx with no agent_deposits row. Assert mint_volume_per_block equals the leg total once.

**What the fixer changed.**

- The direct-deposit source in all four mint queries (global and per-vault, per-block and per-hour) now nets out router legs per (tx, vault): GREATEST(SUM(vte.assets) - SUM(legs.amount), 0), from one shared SQL constant. I did not drop every Deposit in a tx that has a leg, because that would let a large direct deposit hide behind a small router leg.

**Regression tests the fixer wrote (not run).**

- cursor_and_volume::direct_router_deposit_counted_once_in_mint_volume (two legs plus two matching vault Deposit rows in one tx with no agent_deposits row: per-block 501000, per-hour 501000, per-vault 300000 and 201000; a 2 USDC-million direct deposit batched in the same tx still counts, 2501000)

**Files changed:** `services/watchdog/src/volume.rs`, `services/watchdog/tests/cursor_and_volume.rs`

**Related.** related findings review-security-064, review-security-066; finder note: IDX-4 / IDX-7 (issue 990)

### 66. Medium — A contract or EIP-7702 agent can hide an arbitrarily large direct vault deposit from watchdog mint volume

#### SEC-M-024 (review-security-066)

**Statement.** A contract or EIP-7702 agent can hide an arbitrarily large direct vault deposit from watchdog mint volume. It only needs to batch the deposit with a tiny gateway deposit in the same transaction.

- **Where:** `services/watchdog/src/volume.rs:67` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / indexer / code
- **Class / confidence:** `SECURITY_MONITOR_EVASION` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, low, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-66

**Scenario.** An authorized agent that is a contract (or a 7702-delegated EOA) calls gateway.deposit(1 USDC) and vault.deposit(5,000,000 USDC, receiver) in one transaction. The indexer writes an agent_deposits row for that tx. The watchdog then excludes both vault Deposit rows of the tx and counts only 1 USDC. No per-block or per-hour mint breach fires, so no on-call alert is sent. A large inflow can be staged unseen, for example ahead of the known exclusion re-add NAV issue.

**Evidence.**

- services/watchdog/src/volume.rs:66-70: the direct source drops every vault Deposit row whose tx_hash has any agent_deposits row (a transaction-level NOT EXISTS). It does not net per (tx, vault).
- services/watchdog/src/volume.rs:24-32: the round-1 comment says netting per (transaction, vault) is meant to keep 'a large direct deposit batched with a small router deposit in one transaction visible'. The same batching against a gateway deposit is still dropped.
- contracts/lib/GatewayAuth.sol:89-91: contract agents are supported ('A contract agent ... consents by revealing for itself'). contracts/gateway/RobotMoneyGateway.sol:739-742 deposit is onlyRole(AGENT_ROLE) with no EOA check.
- contracts/RobotMoneyVault.sol:582 and contracts/vaults/BasketVault.sol:543: vault.deposit is public.
- The same filter feeds mint_volume_per_block_for_vault and mint_volume_per_hour_for_vault, so per-vault overrides are blind to it too.

**Also reported by another lens and folded in here.**

- `services/watchdog/src/volume.rs:66` (3 of 3 confirmed): Watchdog mint volume still drops every direct vault Deposit in a transaction that also holds a gateway deposit, so an agent account that batches the two hides the direct mint

**Recommended fix (reviewer).** Net gateway deposits per (tx, vault) the same way as router legs. direct = max(SUM(vte.assets) - SUM(non-routed agent_deposits.amount for that tx and vault) - SUM(router legs for that tx and vault), 0). Replace the transaction-level NOT EXISTS with this.

**Regression test the reviewer asked for.** Watchdog test: one tx_hash has an agent_deposits row (vault = V, amount 1) and two vault_transfer_events deposits to V (1 from the gateway, 1,000,000 from another caller). Assert mint_volume_per_block >= 1,000,001 and mint_volume_per_block_for_vault(V) >= 1,000,001.

**What the fixer changed.**

- The transaction-level NOT EXISTS(agent_deposits) is gone. direct = GREATEST(SUM(vte.assets) - router legs - non-routed agent_deposits.amount, 0) per (tx, vault). The test seeds a 1 USDC gateway deposit and a 1,000,000 USDC direct deposit to vault A in one tx. It checks 1,000,001 USDC per block, per vault, per hour and per vault per hour, and that a gateway-only tx still counts once. agent_deposits.vault = cfg.vault is correct because RobotMoneyGateway._validateDestination allows only the pinned vaultContract (set once in initialize) or the router. Both findings (low and medium) are the same defect and share one fix.

**Regression tests the fixer wrote (not run).**

- services/watchdog/tests/cursor_and_volume.rs::a_direct_deposit_batched_with_a_gateway_deposit_is_counted

**Files changed:** `services/watchdog/src/volume.rs`

**Related.** related findings review-security-065; finder note: Same per-(tx, vault) netting invariant the round-1 router-leg fix states (services/watchdog/src/volume.rs:24-32). Not covered by any earlier finding.

### 67. Medium — Watchdog per-hour volume has no upper bound, so any catch-up counts later blocks into each block's hour and auto-pauses gateway deposits behind a 48h timelock

#### SEC-M-025 (review-security-067)

- **Where:** `services/watchdog/src/volume.rs:174` (line as the round 3 finder saw it)
- **Round / lane / owner:** 3 / indexer / code
- **Class / confidence:** `SECURITY_AVAILABILITY_FALSE_TRIP_WINDOW_UNBOUNDED` / high
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, medium. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-67

**Scenario.** The indexer's RPC is down for 2 hours (or the alert webhook refuses and DI-7 holds the cursor, or the watchdog restarts after downtime). On recovery the watchdog evaluates the backlog. For block X the per-hour mint is everything from ts(X)-1h to the current indexed head, about 3 hours of volume. With normal hourly volume above a third of the limit, X and most later backlog blocks breach PerHourMint. Each sends its own webhook alert (thousands of incidents; any refused one re-holds the cursor) and calls pauseDeposits. Only a 48h timelock operation unpauses, and if governance unpauses earlier the next breached backlog block pauses again.

**Evidence.**

- services/watchdog/src/volume.rs:174-197 mint_volume_per_hour filters sources only by `t.block_number > $3` (block_before_window) and `b.timestamp >= $2`; nothing stops the sum at the evaluated block
- services/watchdog/src/volume.rs:225-246 burn_volume_per_hour, :287 mint_volume_per_hour_for_vault and :339 burn_volume_per_hour_for_vault have the same open upper end
- services/watchdog/src/watchdog.rs:125-151 anchors since to the evaluated block's timestamp but passes no block bound; watchdog.rs:119-123 claims this 'keeps the window consistent whether the watchdog is at tip or catching up'
- services/watchdog/src/watchdog.rs:695-740 evaluates every block from the cursor to MAX(last_indexed_block); a DI-7 held cursor (701-711), an IndexerBehind stretch or a daemon restart leaves a backlog
- services/watchdog/src/watchdog.rs:335-390 every breached block sends pauseDeposits (services/watchdog/config.toml:30 mode = "pause_and_alert"); alert.rs:99-110 dedup key is per block, so each breached block is its own incident
- contracts/gateway/RobotMoneyGateway.sol:718 unpauseDeposits is ADMIN_ROLE; contracts/script/DeployTimelock.s.sol:66-68 the timelock holds it, so undoing a pause is a 48h operation
- services/watchdog/src/volume.rs:34-44 (round 2) says per-hour cost is 'bounded by the window, not by history'; during catch-up each evaluation scans window plus the whole backlog
- services/watchdog/tests/cursor_and_volume.rs:179,359-405 catch-up tests set per-hour limits to 999999999999, so no test covers the window end

**Recommended fix (reviewer).** Pass the evaluated block number into the four per-hour functions and add `AND t.block_number <= $evaluated` to the mint source filter and `AND v.block_number <= $evaluated` to the burn queries, so the window is [ts(X)-1h, X]. Search block_before_window at or below the evaluated block. Correct the volume.rs cost doc.

**Regression test the reviewer asked for.** cursor_and_volume.rs: seed block 100 (T), 101 (T+12) with a 1 USDC deposit and 5000 (T+7200) with a deposit above per_hour_mint_limit; assert mint_volume_per_hour for block 101 excludes block 5000, and run_cycles_since_cursor from cursor 99 to 5000 reports PerHourMint for block 5000 only (no breach, alert or pause for 100 and 101).

**What the fixer changed.**

- All four per-hour functions now take the evaluated block number. The window is [ts(X)-1h, X]: mint sources filter on `t.block_number > after AND t.block_number <= X`, and burn queries filter on `v.block_number <= X`. block_before_window now searches at or below X. The volume.rs cost doc is corrected, and a new 'Per-hour window' section explains the bug. The run_cycle comment is updated. Existing test call sites now pass the block. In the test, blocks 100..=700 are 12 s apart, so the head is at T+7200. A 1 USDC deposit sits at block 101, and the head holds 1,500 USDC against a 1,000 USDC per-hour limit, plus a withdrawal under the burn limit. The test asserts that the per-hour mint and burn sums at block 101 exclude the head, globally and per vault. It then catches up from cursor 99 in PauseAndAlert mode against PauseRpcStub. It asserts Breached([PerHourMint]), exactly one webhook alert (block 700) and exactly one eth_sendRawTransaction. I used 601 blocks with headers instead of a jump from 101 to 5000, which keeps the run realistic and fast.

**Regression tests the fixer wrote (not run).**

- services/watchdog/tests/cursor_and_volume.rs::per_hour_window_ends_at_the_evaluated_block_during_catch_up

**Files changed:** `services/watchdog/src/volume.rs`, `services/watchdog/src/watchdog.rs`, `services/watchdog/tests/cursor_and_volume.rs`, `docs/operations/watchdog-liveness.md`

**Related.** related findings review-security-064, review-security-068; finder note: Composition of DI-7 held cursor, the round-1 pause re-send, the round-2 per-hour rewrite (quadratic per-hour query finding) and the timelock-gated unpause

### 68. Medium — DI-7 held cursor plus the pause-once record stops WD-5's stuck-pause replacement for as long as the alert webhook refuses

#### SEC-M-026 (review-security-068)

- **Where:** `services/watchdog/src/watchdog.rs:334` (line as the round 1 finder saw it)
- **Round / lane / owner:** 1 / indexer / code
- **Class / confidence:** `SECURITY_SAFETY_ACTION_STARVATION` / medium
- **Skeptics:** 3 of 3 confirmed. Votes: medium, medium, low. The finder said medium.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-68

**Scenario.** An exploit drives mint volume over the threshold at block B during a Base fee spike. The watchdog's pause tx is under-priced and sits in the mempool. At the same time the alert receiver returns 429 or 5xx (rate limit, outage, rotated URL). The pause record says submitted, so retries of B never re-send it. B+1.. are not evaluated, so the per-hour breaches that used to re-send a fee-bumped replacement never run. Gateway deposits stay open with no page, and the supervisor's stale-heartbeat page posts to the same failing webhook.

**Evidence.**

- services/watchdog/src/watchdog.rs:331-360: when a breach alert is undelivered, the first attempt submits pauseDeposits and saves volume_breach_pause_key firing=true. Every retry of that block then skips the pause ('already submitted ... not re-sent').
- watchdog.rs:598-608: BreachUndelivered returns before the cursor advances, so blocks after B are never evaluated until the webhook accepts.
- services/watchdog/src/pause.rs:208-209 and 173-174: trigger_pause returns Ok on eth_sendRawTransaction and never waits for a receipt.
- pause.rs:25-35 (WD-5) says a stuck under-priced pause is replaced by a later retry at the confirmed nonce with a fee bump. It calls replacing a stuck tx safety-critical. Before X5 the next breached block (the per-hour window stays breached for many blocks) provided that retry.

**Recommended fix (reviewer).** Record a pause as done only once depositsPaused() reads true on chain (or the tx receipt succeeded). Otherwise re-submit on each retry. Better, decouple alert delivery from evaluation: keep undelivered breach keys in watchdog_pager_state and retry them every poll while the cursor keeps advancing and later breaches still pause.

**Regression test the reviewer asked for.** threshold_breach test: the webhook stub returns 500 and the pause RPC stub accepts sendRawTransaction while gateway depositsPaused() stays false. Across three cycles assert pauseDeposits is re-submitted (or block B+1 is evaluated and pauses).

**What the fixer changed.**

- On a retry of a held block whose pause record exists, the watchdog now reads gateway.depositsPaused() (new pause::gateway_deposits_paused, bounded by the SLA). It skips the pause only when that read returns true. Otherwise it re-sends at the confirmed nonce with the fee bump, which is the WD-5 replacement. An unreadable or false flag counts as not paused. I chose this over the larger option of decoupling alert delivery from cursor advance. One side effect: if an admin unpauses while a block is still held because the webhook is down, the watchdog pauses again.

**Regression tests the fixer wrote (not run).**

- threshold_breach::unconfirmed_pause_is_resent_while_the_alert_is_undelivered (the webhook stub returns 500 and the new PauseRpcStub accepts sendRawTransaction while depositsPaused() is false: over 3 cycles the cursor holds and sendRawTransaction count is 1, 2, 3; after set_paused(true) a 4th cycle sends nothing); pause::tests::deposits_paused_selector_matches_keccak

**Files changed:** `services/watchdog/src/watchdog.rs`, `services/watchdog/src/pause.rs`, `services/watchdog/src/alert.rs`, `services/watchdog/tests/common/mod.rs`, `services/watchdog/tests/threshold_breach.rs`, `docs/architecture.md`

**Residual.** An admin unpause while the alert webhook still refuses is undone on the next poll (documented in round 3).

**Related.** related findings review-security-029, review-security-067; finder note: QA plan X5 / DI-7; scan finding WD-5

### 69. Low — The stage dapp stack still never watches the InvestmentCommitteePolicy proxy (or the timelock and Safe)

**Index:** L-037 (review-security-069)

**Statement.** The stage dapp stack still never watches the InvestmentCommitteePolicy proxy (or the timelock and Safe). Only the 8453 config got the round-1 fix.

- **Where:** `testing/smoke-test/src/lib.rs:3092` (line as the round 2 finder saw it)
- **Round / lane / owner:** 2 / indexer / code
- **Class / confidence:** `SECURITY_MONITOR_COVERAGE_GAP` / high
- **Skeptics:** 3 of 3 confirmed. Votes: low, low, low. The finder said low.
- **Outcome:** **fixed** in the uncommitted working tree. Compile-checked only; its tests have not run.
- **Ledger row:** SR-1015-69

**Scenario.** On the stage (Twin chain) stack, an Upgraded or UpgradesFrozen on the IC policy proxy never reaches proxy_upgrade_events. The watchdog upgrade page stays silent for that proxy, and /v1/committee/* and /v1/regime/feed stay empty. That means the rehearsal environment never exercises the coverage the 8453 fix adds.

**Evidence.**

- testing/smoke-test/src/lib.rs:3092-3116: dapp_compose_env sets INDEXER_GATEWAY, VAULT, REGISTRY, PORTFOLIO_ROUTER, ROUTER_GOVERNANCE and CONSENSUS_RECEIPT. It sets no INDEXER_INVESTMENT_COMMITTEE, INDEXER_TIMELOCK or INDEXER_SAFE.
- testing/smoke-test/src/lib.rs:3228-3233: that env is the StageDeployOutput for the stage stack.
- testing/smoke-test/src/lib.rs:809-813: the IC policy address is available as topology.ic_policy.
- testing/ethereum-testnet/config/docker-compose.dapp.yaml:180 now maps INDEXER_INVESTMENT_COMMITTEE, but the stage launcher passes an empty value.

**Recommended fix (reviewer).** Add kv("INDEXER_INVESTMENT_COMMITTEE", ic_policy), plus INDEXER_TIMELOCK and INDEXER_SAFE, to dapp_compose_env, with a unit assertion like scripts/stage/tests/mainnet-dapp.test.ts:111-116.

**Regression test the reviewer asked for.** Unit test in testing/smoke-test: dapp_compose_env output contains INDEXER_INVESTMENT_COMMITTEE equal to the fixture's ic_policy, and contains INDEXER_TIMELOCK and INDEXER_SAFE.

**What the fixer changed.**

- DappDeployed gained ic_policy (from fixture.ic_policy_hex()). dapp_compose_env now sets INDEXER_INVESTMENT_COMMITTEE, INDEXER_TIMELOCK and INDEXER_SAFE. The test also checks that docker-compose.dapp.yaml maps each of them into the indexer. This is a cross-lane edit: testing/ is in no listed lane.

**Regression tests the fixer wrote (not run).**

- testing/smoke-test/src/lib.rs::tests::dapp_compose_env_watches_the_ic_policy_timelock_and_safe

**Files changed:** `testing/smoke-test/src/lib.rs`

**Related.** related findings review-security-051; finder note: Earlier finding (medium): InvestmentCommitteePolicy proxy is never watched by any shipped indexer config (scripts/stage/mainnet-dapp.ts:366). Fixed for 8453 only.

## Refuted candidates

A candidate is refuted when at least two of its three skeptics refute it. The reason quoted is the first refuting skeptic's.

| Round | Location | Candidate | Votes | Why refuted |
|---|---|---|---|---|
| 1 | `publish-contracts/src/unwind-guard.ts:93` | The set-unwind-guard row with token=all writes one absolute minUsdcOut to every basket token, whatever each token's balance | 3 of 3 refuted | The code facts are right, but the security claim does not hold. With token=all, publish-contracts/src/unwind-guard.ts:82 and :88-95 write the same minUsdcOut and maxLossBps to every active token, and the override floor math at contracts/lib/BasketSwapOps.sol:196 and :377-380 works as the scenario says. That behavior is documented on purpose (unwind-guard.ts:11 "all with the same values", publish-contracts/README.md:125, docs/operations/contract-release-runbooks.md:522).  Only ADMIN_ROLE writes the guard (contracts/vaults/BasketVault.sol:1338-1343). That role is the Safe acting through the 48h ... |
| 1 | `publish-contracts/src/actions-proof.ts:146` | CONFIRM=environment accepts any GitHub OIDC token from any robotmoney/* repository, fetched from an env-controlled URL, so the Environment reviewer sign-off can be replayed from a laptop | 3 of 3 refuted | The code path works as described, but there is no security impact. The only person who can pull it off already holds more power than the bypass gives. Each step checks out. publish-contracts/src/actions-proof.ts:146 accepts any repository under the robotmoney/ owner. actions-proof.ts:151 builds the expected sub from the token's own repository claim. actions-proof.ts:165-167 reads the token URL from the environment and accepts any https URL. cli.ts:497-499 fetches the proof once. runner.ts:494-498 then reuses it for every stage. So a genuine token relayed from an unprotected Environment in ... |
| 1 | `contracts/lib/BasketSwapOps.sol:377` | The verifier forces a non-zero absolute emergency-unwind floor on every leg, and the contract applies it as a hard minimum on the TWAP-healthy path, so emergencyUnwind reverts once a leg's value falls below the guard | 2 of 3 refuted | The contract mechanics are real. On the healthy-TWAP path `_unwindLeg` uses max(twapFloor, configuredMin) (contracts/lib/BasketSwapOps.sol:370-377), and `emergencyUnwind` loops over every active leg in one transaction (BasketSwapOps.sol:171-175). The candidate's chain from tooling to a blocked lever breaks at two steps.  (1) The verifier does not require a floor of about half the leg value. It requires only minUsdcOut > 0 (publish-contracts/src/verify/index.ts:788-789, `zero = guards.filter(g => g.min === 0n)`). The tooling accepts min-usdc-out=1 with max-loss-bps=0 (unwind-guard.ts:63,70). ... |
| 1 | `publish-contracts/src/release-gate.ts:176` | The release gate's CI check queries whatever repository GITHUB_REPOSITORY names, and its remote-tag check trusts the checkout's origin | 3 of 3 refuted | The code facts are right, but they do not add up to a trust-root break. Both inputs the scenario changes belong to the operator who already holds the signing keys. The gate builds the check-sha-green env from i.env (publish-contracts/src/release-gate.ts:175-176). cli.ts:473 sets that env to `deps.env ?? process.env`, which is the operator's own shell. It is not the sheet and not any less-trusted input. The remote-tag check reads `origin` from the operator's local .git/config (release-tag.ts:54,60). The runbook already treats local clone state as operator-trusted and names code review plus the ... |
| 1 | `scripts/ci/check-sha-green.ts:51` | check-sha-green counts any check-run that has a required name, so a writer can fabricate a GREEN deploy sha | 2 of 3 refuted | The code facts are right, but the attack gives a writer nothing new, and the proposed fix would not stop that writer. check-sha-green.ts:51-55 matches only by name. fetchAllCheckRuns (check-sha-green.ts:138) keeps only name, status and conclusion. The `source` field (line 24) is never read. The scenario's attacker is a repository writer, and that writer already controls everything the gate trusts. First, the gate runs from the sha being deployed: release-gate.ts:29 spawns `bun scripts/ci/check-sha-green.ts` with cwd=coreDir, and cli.ts:517-518 refuses unless coreDir HEAD equals DEPLOY_SHA. So ... |
| 2 | `contracts/lib/VaultAdapterOps.sol:517` | emergencyWithdraw alone still leaves an illiquid adapter counted in NAV, so early redeemers take full NAV from idle unless the hot key runs emergencyExcludeAdapter first | 2 of 3 refuted | The code works as the candidate says, but the scenario only happens when the trusted emergency key ignores a documented, accepted procedure, so it is not an exploitable value transfer. Only the emergency role can press emergencyWithdraw (contracts/RobotMoneyVault.sol:1087). With no emergency action, the illiquid adapter blocks any redeem larger than idle cash: the proportional pull reverts (contracts/lib/VaultAdapterOps.sol:344-356; contracts/test/RobotMoneyVault.t.sol:1318 expects VenueIlliquid). So no holder can start this alone. The protocol gives the hot key a lever that closes the gap: ... |
| 2 | `clients/dapp/src/components/AdminFlow.tsx:94` | The rmpc export merges the dapp's per-address vault and router implementation pins into one flat list, and rmpc accepts any listed hash at any reached proxy | 2 of 3 refuted | The code shape is real but the scenario is blocked. rmpc's check_proxy_approved has no address binding (clients/rust-payment-client/src/upgrade.rs:222-250). The export unions the per-address pins (clients/dapp/src/components/AdminFlow.tsx:94-101, clients/dapp/src/lib/configExport.ts:148-156). The scenario needs one thing first: the timelock upgrading the rmUSDC proxy to the rmPROTO or router implementation. The only approved upgrade path refuses that. The upgrade-proxy row requires the target's runtime code to match the build artifact of that proxy's own contract ... |
| 2 | `publish-contracts/src/cli.ts:713` | The 8453 build gate runs the build checkout's own check-sha-green.ts and required-checks.json with the operator's GitHub token | 3 of 3 refuted | The code path is real, but it is not an exploitable gap, and the proposed fix would not stop the scenario. The upgrade gate does run the build checkout's own script with the operator's token. That chain is cli.ts:713, govern.ts:796, build-provenance.ts:80, release-gate.ts:38 (cwd: i.coreDir) and release-gate.ts:184, and check-sha-green.ts:178 reads required-checks.json from its own directory. The attacker in the scenario is a writer who can land a commit and push a release tag. That writer already controls whether CI looks green at that commit, whichever copy of the script runs. Push and ... |
| 3 | `contracts/PortfolioRouter.sol:1213` | Router deposits are not bound to the weight vector the caller previewed: floors are positional, there is no deadline, and anyone can time the timelock execution of a new vector, so a signed floor can be applied to a different vault | 3 of 3 refuted | The scenario's key step does not happen through any production path. The govern tool builds every applyReceipt vector in registry order (publish-contracts/src/apply-receipt.ts:120-123, govern.ts:1859-1861). rmUSDC is registered first (contracts/script/DeployVaultRegistry.s.sol:150), so it is always leg 0. The tool would queue V2 as [rmUSDC 1000, rmPROTO 9000], not [rmPROTO 9000, rmUSDC 1000]. Default vectors use the same registry order (BasketVaultDeployBase.sol:192-214; DeployPortfolioRouter.s.sol:144-150). In that case leg 0 gets 10% of the USDC against a floor set for 100%, so the deposit ... |
| 3 | `contracts/lib/VaultAdapterOps.sol:525` | Incomplete round-1 fix: emergencyWithdraw still leaves an adapter whose drain failed priced in NAV, so drain-before-exclude repeats the early-redeemer haircut shift; the order lives only in NatSpec and technical docs | 3 of 3 refuted | The mechanics reproduce. emergencyWithdrawAll (contracts/lib/VaultAdapterOps.sol:525-537) opens records only for entries that are already ineligible. _drain (:903-922) sets ok=false when withdraw reverts. The entry stays active and allowed with no record, so isCounted (:131-133) keeps it in totalAssets (contracts/RobotMoneyVault.sol:557-566). Alice can then redeem from idle at full NAV through the idle-first path (:777-805).  It is still not a vulnerability. The harm needs the trusted hot key (EMERGENCY_ROLE) to run the levers in the one order the docs forbid. The round-1 fix chose this ... |
| 3 | `publish-contracts/src/evidence-check.ts:1487` | The evidence secret scan still misses prefixed *_TOKEN names, including GITHUB_TOKEN and GH_TOKEN, which every gated 8453 run must have in its environment | 3 of 3 refuted | The regex gap is real, but no step of the leak path happens. Running bun against the shipped regex at publish-contracts/src/evidence-check.ts:1487 confirms that GITHUB_TOKEN=..., GH_TOKEN=..., "github_token": ... and NPM_TOKEN=... are not flagged, while TOKEN=... and CHAIN_SIGNER_PASSWORD=... are. The scenario still fails at every step that would put the token in the evidence folder. (1) Core's config check never receives the token. coreCheckEnv (publish-contracts/src/core-config-check.ts:25-30) passes only PATH, HOME and CONFIG_CHECK_RPC_URL to that child. (2) forge and cast are started ... |

## Clean areas

These are the areas the round 3 finders checked against the current working tree and found sound. The JSON summary also lists the round 1 and round 2 clean areas. A later fix can change an area an earlier round called clean, so the round 3 list is the current one.

- Lending adapter venue-refusal path (AaveV3Adapter/CompoundV3Adapter/MorphoAdapter deploy try/catch): the refused USDC goes back to VAULT, the allowance is always reset, a revert leaves no partial state, the Morpho exposure check stays outside the try, and the min-out overloads have no in-tree caller
- VaultAdapterOps._allocate measures by balance delta: no underflow, a refusal returns placed=0, and an over-return stays idle. The pass-1/pass-2 refused bitmask and cache invalidation (useCache requires refused==0) are consistent
- _ceiling vs MorphoAdapter._checkExposure: same expression (convertToAssets(balanceOf)) in the same block, so routing never asks past maxExposure. The staticcall tolerates adapters without the view
- recoverRemoved: EMERGENCY + nonReentrant. It acts only on an inactive index with an open record, clamps to the reported balance, credits by balance delta (an untrusted adapter cannot take idle), and finalizes only when the adapter reports empty. An inactive open record cannot coexist with an active entry of the same address, because addAdapter restores every such record before the push or reverts
- addAdapter restore-before-push and forceRemoveAdapter keep-record-open: a re-add can no longer lift NAV for today's holders. _markExclusionOpened is set on every opening path
- emergencyExcludeAdapter is exclude-only. Permissionless syncExclusions and the codehash restore cannot undo an address revocation, and deposits stay closed while the excluded entry is active
- ExclusionLedger lazy checkpoint math (balanceAt over multiple records, first change per snapshot id), snapshotSupply equals the sum of balances, claims are permissionless and pay the holder, and returnSurplus during an adapter callback can only donate
- PortfolioRouter LegSkippedWithFloor: the check covers both unavailable and zero-amount legs, the length is validated, and a revert is atomic across already executed legs
- BasketVault ORA-4 moved into previewDeposit plus mint. OZ deposit still runs it through previewDeposit, no other entrypoint reaches _deposit, and maxMint stays non-reverting
- DeployTimelock _implementationCodeHash reads the ERC-1967 slot and returns zero for a direct contract. The stage-table lists the two new EMERGENCY levers
- Mirrored event/error signatures in VaultAdapterOps (AdapterAllowedSet, NoOpenExclusion, EmergencyWithdrawAdapterCalled) match RobotMoneyVault
- EIP-170 margins after round 2 (forge build --sizes): RobotMoneyVault 1,213 B, AgentTokenVault 1,239 B, ProtocolAssetVault 1,310 B, RwaBasketVault 1,317 B, all at or above the 1,024 B ADR-0014 margin
- Storage-layout fixtures: no new vault storage. Only the VaultAdapterOps library hash and the enum member lists changed
- RouterGovernance round-2 change is documentation only (released-but-unapplied receipt now described correctly)
- contracts/lib/GovernedUpgrade.sol: the authority is write-once, the freeze is one-way and onlyProxy, and _authorizeUpgrade is gated to the timelock. No production contract has an arbitrary delegatecall, so the freeze cannot be bypassed.
- The round-2 contract changes (RobotMoneyVault, BasketVault, PortfolioRouter, RouterGovernance, ExclusionLedger, adapters) add no storage, immutables, initializers or reinitializers. All nine snapshots equal forge inspect exactly.
- publish-contracts/src/upgrade-rows.ts: the numbered rounds handle rollback and a skip followed by a return. reopenCancelled works. The freeze binds impl+codehash, so racing a freeze against an upgrade is safe on chain.
- publish-contracts/src/build-provenance.ts: on 8453, DIR must be the checkout's own out/. Artifact metadata source hashes are checked against the committed tree, with submodules followed. The release gate uses the deployment checkout's check-sha-green and the canonical origin.
- publish-contracts/src/release-gate.ts and release-tag.ts: CORE_REPO is passed on the command line. The canonical origin is checked after insteadOf rewriting.
- publish-contracts/src/verify-stage.ts: after redeploy-vault, upgradesOf, freezesOf and upgradeLayoutsOf are bound to addresses. withRetiredProxies and the evidence-check immutability claim count retired vaults.
- publish-contracts/src/runner.ts: a proxy_gate read_error is re-read on resume. Verify-only and govern-only runs refuse a fresh run manifest.
- scripts/ci/storage_layout_gate.py: enum members are recorded and enum_definitions scope parsing is sound. --release-anchor filters tags correctly. The delete/re-add and delist/re-add cases fail as intended.
- publish-contracts/src/layout-compare.ts: the enum rule holds for enums stored directly in variables or mapping values.
- clients/dapp codePins.ts and useGuardedWriteContract.ts: the code pin, slot and implementation pin are read at one block. The router legs are checked at send time.
- scripts/stage/mainnet-dapp.ts: the IC proxy is watched. --upgrade-evidence pins only executed rounds. The docker-compose.dapp.yaml FEATURE_FLAGS default of 4 means registered vaults and the registry are watched for Upgraded.
- clients/rust-payment-client withdraw.rs: the router implementation is verified before gateway.withdrawFromRouter.
- VaultAdapterOps._allocate measures what the adapter kept from the vault's own balance, so a refused or lying hand-back cannot over-credit; the refused USDC stays idle inside NAV
- _ceiling and MorphoAdapter._checkExposure read the same convertToAssets(balanceOf) in the same transaction, so routing never asks Morpho past maxExposure and the deposit no longer reverts on the cap
- The pass-1 refused bitmask disables the pass-2 read cache after any real deploy call, so pass 2 never reuses a stale balance
- recoverRemovedAdapter credits only the USDC that reached the vault during the adapter withdraw, clamps to the reported balance, cannot touch idle NAV, and closes the record only on an empty balance
- addAdapter settles an inactive entry's open record through _restore before pushing the new entry, so a re-add cannot lift NAV for today's holders; it is now nonReentrant
- forceRemoveAdapter opens a record with a supply snapshot for a funded or unreadable adapter and turns on checkpoints; no path moves the inactive entry's balance into NAV
- ExclusionLedger snapshot, checkpoint and claim math: claims floor per holder, heldUsdc cannot underflow, and gateway or router transient custody does not move a holder's claim
- emergencyExcludeAdapter: an exclusion snapshot taken right after a hot-key deposit gives the depositor no gain (value-neutral exclusion)
- PortfolioRouter LegSkippedWithFloor plus dapp deriveMinSharesPerLeg: skipped legs get 0 floors; a leg that turns available after preview makes the other legs miss their floors, which fails safe
- BasketVault ORA-4 moved into previewDeposit: OZ deposit and the mint override both still run it, and no subclass overrides deposit, mint, previewDeposit or _deposit
- Watchdog mint volume nets per (transaction, vault), which closes the batched gateway-plus-direct-deposit hide; window-bounded filters keep cost to the window
- publish-contracts/src/layout-compare.ts: the round-2 enum rule matches the committed fixture format ('enum VaultRegistry.VaultStatus' in mapping and struct member types). Members are append-only, and requireEnums refuses on 8453.
- publish-contracts/src/build-provenance.ts: gitTreeReader, gitDirtyLines and artifactSourceProblems use gitEnv() and --no-replace-objects. On 8453 the dir must be exactly <checkout>/out, and the deploy-checkout path also gets source proof. The hand-forged-metadata residual is documented in the header and was not re-reported.
- publish-contracts/src/release-gate.ts: check-sha-green runs from ciDir (the deployment checkout) with --repo robotmoney/robotmoney-core, and GITHUB_REPOSITORY is no longer forwarded.
- publish-contracts/src/runner.ts: recordProxyGate and refuseAfterFailedProxyGate re-read a read_error stage. The last proxy stage (rwa) is followed by the timelock forge stage, so the gate always runs before prove-control.
- publish-contracts/src/runner.ts runStages: a verify- or govern-only run is refused on a fresh manifest. Fresh-manifest mixes (prove-control,govern / safe,govern / forge,govern) are refused by prove-control adoption (Safe nonce must be 1) or the deployer nonce check. pause-all also requires the existing manifest.
- publish-contracts/src/runner.ts runSafeStage: a refused confirmation now leaves no started record.
- publish-contracts/src/govern.ts upgrade-proxy: a round reopens with a new salt (roundKey) only when the proxy runs another implementation. lastUpgradeOf and buildDirFor are bound to the current proxy address. Layout ids are content-pinned by sha256.
- publish-contracts/src/verify-stage.ts: upgradesOf, freezesOf and upgradeLayoutsOf are address-bound through currentProxyAddresses. withRetiredProxies and the verifySources implementation override are consistent.
- publish-contracts/src/evidence-check.ts: the retired-vault immutability check is sound, because old_vault is bound by the redeploy chain check that rebuilds the scheduled calls. The new checkProxyLifecycleOnChain path rebuilds upgrade and freeze calls and reads the frozen state, slot and code hash.
- publish-contracts/src/cli.ts ownerSignerShortfall: duplicate and non-owner claims are refused before stage 1. Claims that cannot be read are deferred to prove-control.
- publish-contracts/src/redeploy-vault.ts retiredProxiesOf and the freeze-proxy candidates: a freeze target must still have the timelock as upgrade authority, and the contract guard (FreezeTargetMismatch) covers a pending upgrade at the retired address.
- Direct-deposit netting per (tx, vault) in services/watchdog/src/volume.rs: each subtracted leg or gateway row is also counted, router legs and gateway deposits equal the vault's Deposit assets (BasketVault.sol:654 emits usdcAmount; gateway vaultContract is set only in initialize), so no hide path was found
- block_before_window lower bound: block timestamps are monotonic and every event block has a blocks row, so the per-hour cut does not under-count
- advance_cursor heartbeat SQL (RETURNING updated_at = now(), first insert stamps), max_cursor_lag_blocks validation at config load
- Pause re-send on a held cursor reads depositsPaused() at latest and treats unknown as not paused
- classify_ledger_read: revert means no ledger, zero or empty means retry, transport errors fail the tick; the emitter gate goes through vault_exclusion_ledgers; migrations 0026 and 0027 roll back by block_number
- Budgeted snapshot pass: owner-order cursor, zero balances not re-read, balances and progress stored at the record block
- wallet_positions per-log in-place update with last_log_index; replayed ticks are no-ops
- SSRF guard for payload and memo URIs: http/https only, link-local and IMDS refused including IPv4-mapped IPv6, pinned resolution, same-host redirects only, streamed 1 MiB cap, DNS inside the timeout
- Receipt inline fetch budget and sweep budget; payload_bytes hidden while unverified
- explorer-api chain scoping: every query and lateral join binds chain_id, /v1/vault/snapshots now 404s another chain, /health since_success_secs degrades a stopped indexer
- Stage stack now watches the IC policy, timelock and Safe (smoke-test env plus compose mapping); the 8453 env sets INDEXER_INVESTMENT_COMMITTEE
- Clients do not sign from explorer data: dapp redeem targets are re-checked on chain, exclusion claims are read on chain, rmpc never reads the explorer
- cargo check of explorer-indexer, watchdog and explorer-api with tests compiles cleanly
- Dapp write guard (clients/dapp/src/lib/useGuardedWriteContract.ts:131-263): it reads the code, the ERC-1967 slot and the implementation code at one block through the wallet, then runs verifyPinnedTarget. A router deposit also checks every getEffectiveWeights leg (0 bps legs too) at that block, and every failed read refuses. The router routes by the same _effectiveWeightsMemory (PortfolioRouter.sol:1091-1100). The only other upgradeable contract in the deposit path is VaultRegistry, and it only gates.
- pinnedWriteTarget (codePins.ts): only approve with args[1] === 0n is exempt, which grants nothing. Gateway writes are pinned only when the target is VITE_GATEWAY_ADDRESS, the same build-time address AdminFlow uses (bootstrap.tsx:133).
- useCodeTargetVerification separates definite refusals from failed reads. RouterDepositTab disables approve and deposit when any leg is refused. The router preview badges verified only when the router and every leg are verified.
- Withdraw tab: a refused router falls back to a direct vault.redeem. A leftover share allowance on any route is still read and offered for revoke through approve(router, 0), which needs no pin. A vault or router redeem preview is no longer refused when the gateway is unverified. Deposits are still refused.
- The implementation pins are build-time only: they are not in RUNTIME_CONFIG_KEYS or MAINNET_RUNTIME_KEYS (runtimeConfig.ts:99-133). The compose build args carry them, and the 8453 env asserts VITE_ENV_CLASS=mainnet.
- The dapp router floors fit round-2 LegSkippedWithFloor: unavailable legs get 0 and available legs a non-zero floor. A leg whose availability flips reverts instead of silently re-splitting.
- rmpc withdraw (withdraw.rs:424-443) checks the router's implementation against proxy_implementation_hashes before it simulates or signs, and cli_withdraw.rs covers it.
- rmpc committee identity create (committee_identity.rs:707-730) uses create_new plus mode 0600 plus set_permissions, matching the EVM keystore.
- rmpc agent-consent binds implementationVersion read at the same block as the code-hash and implementation checks. This was unchanged and re-read.
- The gateway forwards router reverts unwrapped (RobotMoneyGateway.sol:1009), and destinations are pinned to the gateway's vault or router.
- bun x tsc --noEmit for clients/dapp passes, and cargo check --tests for rmpc passes.
- release-rmpc.yml: all 10 pinned action SHAs match their claimed upstream tags (checked with git ls-remote). attest-build-provenance v4.2.2 pins its inner actions/attest by SHA.
- release-rmpc.yml: only the push of an rmpc-v* tag attests. A dispatch is a dry run only, with no commit_hash or tag input. The attesting build job restores no Actions cache. linux-arm64 builds natively on ubuntu-24.04-arm (the repo is public). Every ${{ }} reaches the shell through env, not spliced into run: bodies.
- install-rmpc.sh: tag shape check, --source-ref refs/tags/<tag>, and a push-trigger count through --jq. An older genuine archive swapped into a newer Release fails the source-ref pin. Dispatch attestations on a tag ref fail the trigger pin.
- The protect-rmpc-release-tags ruleset is live: creation, update and deletion of refs/tags/rmpc-v* are restricted, with only OrganizationAdmin able to bypass (checked through the API).
- release-dapp.yml: action pins checked. The image uses placeholder addresses with VITE_ENV_CLASS=fork, so no production path consumes it.
- audit_workflow_run_splice_and_perms.py: both release workflows audit clean. The attest-ungated regex is anchored at both ends. The unpinned-uses and attest-cache rules fail closed on unreadable structure.
- suite-01-02 layout step: BASE_SHA reaches the shell through env. The only production anchor (release/v0.4.0-base) predates the normalized snapshot shape and is skipped, so no false red.
- release-gate.ts / release-tag.ts: check-sha-green runs from ciDir with --repo robotmoney/robotmoney-core, and GITHUB_REPOSITORY is no longer forwarded. The origin is checked as canonical before the remote tag compare. The deployment checkout must be clean (cli.ts:540-543).
- build-provenance.ts: on 8453, out/ must be <checkout>/out, and artifacts plus their linked libraries are tied to committed sources through metadata keccak hashes read from git objects.
- check_governance_docs.py rule 7 and its selftest cases.

<details><summary>Round 1 clean areas (83)</summary>

- GovernedUpgrade (contracts/lib/GovernedUpgrade.sol): authority is write-once (reverts InvalidInitialization on a second init), must have code, freeze is one-way and implementation+codehash bound, upgradeToAndCall and freezeUpgrades are onlyProxy, and no withdraw path reads the frozen bit.
- All nine proxied implementations call _disableInitializers in their constructors. GovernedProxyDeploy._deployProxy initializes inside the ERC1967Proxy constructor and checks the impl slot, the empty admin/beacon slots, the authority and the mode.
- ProposerFloorTimelock: the floor covers revokeRole and renounceRole, base-constructor grants are counted through virtual dispatch, and there is no derived initializer to reset the count.
- Gateway agent consent (D2): the EIP-712 digest binds owner = msg.sender and the current nonce, the nonce advances on use, high-s is refused, a non-admin share receiver must be the caller, and the domain is the proxy plus implementationVersion. Pre-binding the timelock or Safe (ACL-7, CS-1, CS-2 squatting) is now impossible without the address's own signature.
- Gateway withdraw, withdrawFromRouter, deposit and depositTo: nonReentrant, CEI (payment id and window written before external calls), custody checks. Duplicate router-withdraw legs revert on the custody check. No pause gates any withdrawal.
- PortfolioRouter: redeemFor confused-deputy guard, DuplicateVault refusal in setWeights and _setDefaultWeights, self-administered rotation roles with Safe/timelock split, and the D4 availability loop terminates and matches previewDeposit.
- RouterGovernance.applyReceipt: checks recorded, unreleased and digest-equal, then does release plus setWeights atomically. The receipt register is gateway-only for writes and checks COMMITTEE_AGENT_ROLE on the submitter.
- ExclusionLedger: checkpoint and balanceAt follow ERC20Snapshot semantics correctly across multiple records. credit uses the vault balance delta, not the untrusted adapter return. claim pays only the holder. returnSurplus and sweepForeignToken protect USDC and the share token.
- RobotMoneyVault exclusion paths: excluded entries never count in NAV or take pulls, deposits close while a record is open on an active entry, emergency/admin drains credit the record, and restore drains before the entry counts again.
- Linked libraries (VaultAdapterOps, BasketSwapOps, GatewayAuth, GatewayWithdrawOps, GatewayWindows): stateful public functions are only reachable by DELEGATECALL from their host, which keeps every role check and nonReentrant guard. No low-level call, delegatecall or selfdestruct exists in production contracts.
- Role handover in DeployTimelock: the deployer loses ADMIN, DEFAULT_ADMIN, EMERGENCY, WEIGHT_SETTER and both rotation roles. RouterGovernance gets receipt ADMIN_ROLE but not DEFAULT_ADMIN_ROLE. The authority timelock must match every proxy's upgradeAuthority().
- Strategy adapters are onlyVault for deploy, withdraw and setMaxExposure. Swap adapters pull only from msg.sender. The V4 unlockCallback is gated on the PoolManager and an open flag, and exact-input partial fills revert.
- contracts/lib/GovernedUpgrade.sol: ERC-7201 slot 0x5f8c...7600 recomputed with cast and matches; authority write-once (InvalidInitialization once set) and must have code; Unset mode reverts; freezeUpgrades is onlyProxy, authority-only, target and codehash bound, one-way; _authorizeUpgrade checks authority then frozen; onlyUpgradeAuthority gates reinitializers; struct packing pinned by GovernedUpgradeLifecycle.t.sol:212-223
- All nine implementations (RobotMoneyVault, BasketVault for the three kinds, PortfolioRouter, VaultRegistry, RobotMoneyGateway, InvestmentCommitteePolicy, ConsensusRecommendationReceipt) call _disableInitializers in their constructors, run every parent init once and call __GovernedUpgrade_init last; no immutables remain; no DELEGATECALL to a caller-chosen target, no selfdestruct, ERC1967Utils used only in GovernedUpgrade; withdraw paths never read the frozen bit
- Implementation state-squatting: direct calls to an implementation only touch its own storage; UUPS __self immutable cannot be forged without failing proxiableUUID, which the upgrade row checks
- Proxy deploy + initialize atomicity: GovernedProxyDeploy._deployProxy uses ERC1967Proxy(impl, initData) in one transaction and reads back the implementation slot, empty admin/beacon slots, authority and frozen state; broadcast entry points use _useEnvUpgradeConfig (authority with code, explicit mode); the in-process default authority (script address) fails closed on chain; RedeployProtocolAssetVault binds authority to TIMELOCK_ADDRESS
- ExclusionLedgerFactory: ledger bound to msg.sender, vault checks VAULT()==address(this); CREATE2 factory code-checked in DeployLibs
- DeployTimelock handover requires TIMELOCK_ADDRESS on every chain and checks every handed-over proxy names it as upgradeAuthority
- Gateway EIP-712: domain hashes implementationVersion(), block.chainid and address(this) (the proxy) per call; agent consent is the only signature surface; per-agent nonce; a version bump voids outstanding consents; a reverted reveal does not consume the commitment
- Verifier proxy labels: ERC1967Proxy code, implementation slot vs manifest or last executed upgrade, admin/beacon slots, initialized + implementation locked, authority, declared mode, frozen state; compareCodeAndLinks follows every library link recursively
- freeze-proxy row: targets read from chain at planning, bound to live implementation and code hash, refused while an upgrade round of the proxy is pending, one batch so no partial freeze
- rmpc upgrade.rs and dapp gatewayVerifier.ts gateway implementation pins fail closed on missing pin, unreadable slot or code, or unlisted hash
- Indexer drops UpgradesFrozen whose proxy is not the emitter; /v1/upgrades SQL is parameterized and documented as disclosure only
- Storage-layout gate rules for moved/retyped/removed variables, gap shrink end-aligned, struct changes, linearization, GovernedUpgrade presence, linked library code, OZ gitlinks, reinitializer-without-onlyUpgradeAuthority; wired into the required forge-unit-tests job with selftest first; OZ remappings resolve both packages to v5.0.2
- ExclusionLedger math (contracts/ExclusionLedger.sol): lazy checkpoints match ERC20Snapshot semantics across several records. balanceAt returns the balance at open. The sum of claims is at most recoveredUsdc. Rounding dust stays in heldUsdc. returnSurplus moves only USDC above heldUsdc to NAV. claim always pays the holder. Test gap: no multi-record or fuzz invariant test (sum of claimable <= recovered).
- D3 recovery paths (VaultAdapterOps._drain/_credit, adminRebalancePull, emergencyWithdrawAll/One, syncExclusions): each credits the USDC balance delta, never the adapter's return value. Restoration is atomic and reverts AdapterNotEmpty when the drain fails. An open record keeps the entry out of NAV, pulls and allocation (isCounted/isUsable short-circuit before calling the adapter). Deposits stay closed through maxDeposit while a record is open, so the router skips rmUSDC. A ZeroPayoutDuringExclusion redeem keeps its claim.
- NAV/pull consistency: totalAssets and pullFromAdapters share one isCounted predicate. The library move (ADR-0014 section 9) keeps pull, route and rebalance arithmetic identical to cb1d9cc5.
- Inflation and donation: _decimalsOffset is 18 in both families. Proxies are initialized in their deploy transaction. A ledger donation returns to NAV through returnSurplus. A router USDC donation is excluded from AZ-RTR-2.
- Basket mint on the realized TWAP delta is in-kind fair for single-asset and equal-mix deposits. A record() call inside the deposit cannot move the window mean, because the new observation sits at the current timestamp with the lagged tick. The mint-side residual within the ORA-4 band is unprofitable at the ADR-0005 depth and fee.
- D5 sell anchor (BasketViews.checkSellAnchor, spotBelowSellAnchorBps, sellAnchorWindow): direction and decimals are correct for the RM/USDC ordering, the history window comes from oldestObservation, dust is skipped, and the recorder ring is V3-faithful through grow and wrap. The residuals (long holds, reabsorbRemovedAsset, emergencyUnwind) are documented in docs/technical/recorder-manipulation-1793.md.
- D6 dust rule: the same zero-floor test is used in sellProportional/_sellLeg, _unwindLeg, deactivateAsset and the anchor's _isDust. A skipped leg stays with the remaining holders.
- Router weight math: _splitAcrossAvailable renormalizes over the available bps, the remainder lands on the last weighted available leg, the re-quote loop terminates, and duplicate vaults are rejected in setWeights and _setDefaultWeights. applyReceipt binds the receipt digest.
- D9 single-leg floors: the redeemFor confused-deputy check (msg.sender == holder, or the vault-share allowance to the caller), and the per-leg floor is checked against the actual amount the vault returns (RobotMoneyVault net assets, Basket _lastWithdrawnAssets).
- Fees: the RobotMoneyVault exit fee comes from realized gross (FEE-2). The basket fee is charged on realized USDC. redeemInKind charges the fee in kind per leg. MAX_EXIT_FEE_BPS is 100 in both families.
- Gateway caps: GatewayWindows is a true rolling 24 h window. Withdraw caps are counted in shares by design (FS-RTR-9).
- prove-control --resume adoption (E7): sends nothing. It requires nonce 1 and exactly one ExecutionSuccess whose safeTxHash is the nonce-0 self-call. It re-reads the tx from --rpc. inspectProofTx proves every owner signed and no stranger did. --logs-rpc chain id is checked.
- Release gate coverage (E4): every 8453 broadcasting path (publish, default set, deploy, all, safe, prove-control, govern verb on all rows, redeploy-vault) is gated before any signer. Plain baselines now need the committed-dir proof.
- Redeploy SHA model (E1): redeployShaRun refuses wrong-sha or prior-out combinations before any signer. verifyBuildRefusal re-checks inside verify. The salt uses the round's sha.
- new_vault CREATE binding: the govern row reads deploy receipts from chain against sheet.admin. evidence-check binds r.deployer to ev.deployer. The verb binds to forge broadcast receipts.
- Applied vector (C2): taken from ReceiptApplied and VotedWeightsCleared events. A failed scan fails the labels instead of reading as 'nothing applied'.
- Redeploy confirm-before-save (E2) holds.
- Owner-signer floors (B1): env: refused as an owner on 8453. Plaintext, raw key and passphrase file refused. Hardware grammar checked at parse.
- Self-admin rows: refused on 8453 at parse (cli.ts:275) and in runGovern (govern.ts:744). The sheet roster check (B4) covers every other row.
- upgrade/freeze contract-level refusals: frozen, authority not the timelock, admin or beacon slot set, not UUPS, unlocked initializers. The freeze target is bound to the live implementation and code hash, and is resumed with the signed targets.
- Run manifest writes are atomic (tmp plus rename) under an O_EXCL lock. Pause entries merge from disk.
- YES=1 refused on 8453. Typed prompts require a TTY. A CONFIRM=environment token is never logged.
- Committed Deploy 2 manifests (deployments/8453/deploy-2) pass the secret scan.
- X1 discovery-tick refetch (services/explorer-indexer/src/indexer.rs:1341-1386): the refetch is limited to discovered vaults, the retain-by-registration-block filter guards against providers that ignore the address filter, and logs are appended after VaultRegistered so the contracts FK holds. A replay after a partial tick finds the vault already in vaults and its logs in the main fetch. The ledger part is covered by the factory finding above.
- X2 all-status vault watching and heartbeat (indexer.rs:1306-1323, 1505-1514): every vaults row is watched and snapshotted. Status stays a product filter in /v1/stats.
- X3 regime feed (db.rs:2266-2311, indexer.rs:1497-1501): rows are written only on change, a zero-count row is written on drop-out, and the API hides zero-count latest rows consistently with /v1/committee/tilts.
- X4 committee vote key and FK (migration 0019, db.rs:2102-2140): the contract-scoped PK refuses a populated table. The placeholder is written only when no row exists, so a registered member is never downgraded.
- X7 reorg reconcile (db.rs:1155-1275, 700-860): the rollback table set is derived from the schema, vaults are deleted by registered_block, committee membership is re-derived from append-only history with a placeholder for surviving votes, and receipt release is un-flipped. All new tables (0020-0024) carry chain_id and block_number.
- Watchdog indexer-lag paging (services/watchdog/src/main.rs:315-372, liveness.rs): progress is read every poll, so both wedged (gap) and dead (silence) indexers page. Liveness is not refreshed while the indexer is behind.
- Upgrade event decoding (indexer.rs:1753-1790, abi.rs:657-658): the Upgraded/UpgradesFrozen signatures match contracts/lib/GovernedUpgrade.sol:72, and an UpgradesFrozen naming another proxy is dropped. The watchdog upgrade cursor advances only after delivery.
- Emitter gating: consensus receipts, Timelock/Safe admin events and exclusion events are gated on the configured or derived emitter. No watched address can emit attacker-chosen topics.
- API chain scoping for contracts, latest snapshot, agents, deposits, transactions, accounts, committee, receipts and upgrades all binds state.chain_id. Only GET routes exist, all SQL is parameterised, and the rollback DDL uses a safe-identifier check.
- Anything a client signs from: the dapp redeem target is allowlisted against the on-chain registry (DepositWithdrawTab.tsx:205-213, U4). Router deposit legs come from live on-chain weights. /v1/upgrades is disclosure only. rmpc upgrade.rs never reads the explorer. Plugin skill docs forbid explorer reads for safety-critical decisions.
- Watchdog weight-setter check constants: WEIGHT_SETTER_ROLE, getRoleMemberCount and upgradesFrozen selectors were verified with cast. The router and RouterGovernance inherit AccessControlEnumerableUpgradeable, so the enumeration reads exist.
- dapp commit/reveal previews: commitAuthorizationCall and revealAuthorizationCall in commitReveal.ts are the objects that are both previewed and signed. The 4-argument reveal carries agentConsent. AuthorizeTab and OnboardingWizard freeze the {agent, salt, policy, consent} snapshot at commit. Commit is blocked until the consent recovers. The rotation reveal tracks the live preview.
- Agent consent: agentConsent.ts and useAgentConsent.ts recover the pasted signature against the live agentConsentNonce, implementationVersion(), chainId and gateway. The rmpc signer/consent.rs digest matches. Signatures are low-s with v=27/28. The software keystore binds its address as AEAD AAD.
- Dapp redeem targets: redeemTarget.ts accepts only on-chain VaultRegistry vaults or the build-time vault. onWithdraw re-checks the simulation target and the one-leg vault (DR-5 fixed).
- Dapp runtime config: on the mainnet class, contract addresses and all code pins are build-time only (runtimeConfig.ts MAINNET_RUNTIME_KEYS), so /config.json cannot substitute a target.
- Dapp CSP: script-src without 'unsafe-inline' blocks javascript: hrefs taken from on-chain rationale_uri, payload_uri and source_uri links. There is no dangerouslySetInnerHTML.
- rmpc gateway implementation check (2b) runs on deposit, withdraw, withdraw-router, agent-consent, committee vote-submit and receipt submit. Check 5c covers the gateway vault. Router deposits check the router and every leg. withdraw-router checks the router and every leg vault. Vault-destination depositTo can only target gateway.vault(), which 5c covers.
- rmpc software keystore: written 0600 through write_owner_only. An empty passphrase is refused at creation. rmpc-keystore-import reads the key from env and never argv. Errors are mirrored to stderr (DR-11 fixed for the EVM keystore).
- rmpc gas floors: deposit derives the router floor from getEffectiveWeights length. withdraw and withdraw-router refuse an explicit --gas-limit below the gateway floor. withdraw-router requires --min-assets-per-leg and prints a full preview (DR-3 and DR-6 fixed).
- Refusal-name parity: every Err* name in plugins/ exists in the rmpc sources.
- Swarm preflight guard 1 now reads ic_policy_address. Guard 3 fails closed on every outcome except has_role:true (DR-1 core fixed; residual reported separately).
- Plugin skill fences hold no literal passphrases or private keys.
- Committee and receipt writes accept a software keystore on 8453 with a warning only, per D12 (backend_is_production_grade is a label, not a gate).
- Compile checks pass: clients/dapp bun x tsc --noEmit (exit 0) and clients/rust-payment-client cargo check --all-targets.
- No pull_request_target, workflow_run or issue_comment trigger in any of the 43 workflows. Every workflow declares top-level permissions, usually contents: read. Write scopes appear only at job level in the release jobs, plus actions: write in suite-21 and release-tag-suite-dispatch.
- No run: block interpolates untrusted ${{ }} values. Inputs go through env. The release tags are shape-checked with [[ =~ ]]. twin-fork inputs.pin-block comes only from twin-pin outputs or workflow_call.
- The reusable-workflow permission checker (scripts/ci/check_reusable_workflow_permissions.py) is right. It requires the caller grant to cover each callee job, follows nested calls, handles read-all and write-all, and refuses a caller with no permissions block. Suite 13 runs it with a self-test. Suite 29's suite-07 call grants pull-requests: read.
- The deploy-gate derivation (scripts/ci/deploy-gate-jobs.ts) gives 76 jobs and 0 gaps. The only step-level skips in required jobs are PR-only paths that have push counterparts (config-check, gitleaks). There is no continue-on-error anywhere. A skipped or cancelled required run counts as failing.
- The executed-count wrappers (forge_test_require_executed.sh, cargo_test_require_executed.sh) fail on a non-zero tool exit and below the floor. Suite 22 floors are 37 and 40. The suite-09 mainnet Playwright floor requires exactly 4 passed, none skipped, none flaky.
- Supply chain inside the tree is pinned. Both OpenZeppelin submodules are at v5.0.2 (contracts dbb6104c, upgradeable 723f8cab). foundry.toml pins solc 0.8.24. gitleaks is pinned by version and sha256. Suite 11b and the twin-fork action pin Foundry v1.8.5. Bun installs use --frozen-lockfile.
- Secret handling in CI is sound. AGENT_PRIVKEY is masked before GITHUB_ENV. The twin run dir (keys, passphrase) is never uploaded. Rehearsal evidence is secret-scanned before upload. config-check records only the RPC host. Fork PRs get no secrets, and the testnet funder key is testnet-only.
- Caches cannot be poisoned from PRs. The twin anvil RPC cache and rust-cache are written by dev-scope runs, and PR or branch caches cannot reach dev or tag runs.
- actions-proof.ts (B2) checks the JWS and the iss, aud, exp, owner, environment and sub claims. It accepts a token from any robotmoney/* repo with a same-named environment. That adds no exposure, because CONFIRM=typed already lets a key holder run 8453 alone.
- The namespaced GovernedUpgradeStorage sits outside the layout gate. ADR-0014:454-456 documents this and covers it with a test.
- The committed .github/scripts/__pycache__/*.pyc is timestamp-based (flags 0), and its module runs as __main__, so the pyc is never loaded.
- Suite 29's results job fails on any non-success need, including the upgrade rehearsal. Every called suite's jobs run under schedule.

</details>

<details><summary>Round 2 clean areas (85)</summary>

- RobotMoneyVault.emergencyExcludeAdapter: EMERGENCY_ROLE only, nonReentrant, exclude-only. The permissionless syncExclusions and setAdapterCodeHashAllowed(true) cannot restore an entry whose address allowance was revoked. The record and its supply snapshot are opened in the same call, and deposits close through _anyActiveAdapterIneligible.
- forceRemoveAdapter record logic: a funded entry or one whose totalAssets reverts opens a record (skipped at zero supply). It finalizes only on a read balance of zero. _markExclusionOpened turns checkpoints on in the same tx. Reentrancy refuted: IStrategyAdapter.totalAssets is view (STATICCALL) and the ledger is vault-bound.
- addAdapter re-add settlement: nonReentrant, requireEligible before the restore, recovery credited by balance delta (not the adapter's return value), new entry pushed empty. At most one open inactive record per address exists by construction. Gas-griefing a false exclusion through the permissionless syncExclusions is refuted by the 63/64 rule against ledger.open's cost.
- ExclusionLedger math for forceRemove-opened records: snapshot id equals record id, lazy checkpoints are correct across multiple records, and claims sum to the recovered amount over the real supply. Gateway and router hold no shares at rest, so claims land on real holders.
- _ceiling vs MorphoAdapter._deposit: both use convertToAssets(balanceOf) and allocation <= cap - current, so no off-by-one. Pass 2 re-reads balances after any pass-1 allocation. An adapter without maxExposure counts as uncapped and never reverts the read.
- BasketVault ORA-4 relocation: OZ ERC4626Upgradeable.deposit calls previewDeposit (lib/openzeppelin-contracts-upgradeable ERC4626Upgradeable.sol:194-204) and mint calls _checkMarket explicitly. No other _deposit caller exists in the basket family. maxMint uses the non-reverting floor.
- PortfolioRouter quote-pass try/catch: OOG-induced leg skipping refuted (the catch keeps 1/64 of the gas, too little to execute the other legs). Leg skip and renormalise is the accepted QA plan D4 behaviour.
- RouterGovernance: round-1 change is NatSpec only. applyReceipt is still ADMIN-only and nonReentrant, with release and setWeights atomic.
- DeployTimelock _implementationCodeHash: reads the ERC-1967 slot and returns zero for a direct contract. Manifest keys (code_hashes.router_implementation, vault_handover.vault_<i>.implementation_code_hash) match scripts/stage/mainnet-dapp.ts.
- Library event and error mirrors (AdapterAllowedSet, AdapterNotEmpty) match RobotMoneyVault declarations. stage-table.json emergencyLevers lists the new lever.
- forge build --sizes passes for production contracts. RobotMoneyVault keeps 1,387 bytes of EIP-170 margin and the basket kinds keep 1,239-1,317, all above the ADR-0014 1,024 floor. Only the CoreStages script exceeds initcode, which is not deployed.
- contracts/lib/GovernedUpgrade.sol: the authority is write-once (`$.authority != 0` check), _authorizeUpgrade is gated to the timelock and to not-frozen, freezeUpgrades is onlyProxy with an implementation and codehash match, and nothing clears the freeze. It was not changed in round 1.
- All seven proxied implementations (RobotMoneyVault, BasketVault, PortfolioRouter, VaultRegistry, RobotMoneyGateway, InvestmentCommitteePolicy, ConsensusRecommendationReceipt) call _disableInitializers in their constructors.
- No production contract outside the linked libraries delegatecalls an arbitrary target, so the frozen bit cannot be cleared by state-squatting.
- The upgrade-proxy round numbering (govern.ts:1482-1494) is sound. A new round opens only when the last round completed, was not cancelled, and the proxy now runs another implementation. labelOf puts the round into the salt, so a new round gets a new operation id.
- upgradeLayoutRefusals fails closed on 8453 when the live id, the build id or the live snapshot is missing. The live snapshot is picked by sha256, so it cannot be substituted.
- The variable, gap, struct, linearization and GovernedUpgrade rules in layout-compare.ts: the gap must shrink from the front, and new variables must sit in gap room or after the old end. Everything else fails closed.
- verify/index.ts:246-251: a recorded build_dir that is missing or at another HEAD fails the code label. It never falls back silently.
- runner.ts recordProxyGate and refuseAfterFailedProxyGate: a read-back that throws is recorded as read_error and re-read before any later forge stage.
- runner.ts:1199-1209: a verify-only or govern-only run refuses a fresh run manifest, and govern also requires a finished handover. This closes the pause-interlock bypass.
- redeploy-vault.ts retiredProxiesOf is wired into freeze-proxy proxy=all, into verify-stage withRetiredProxies, and into the evidence-check immutability claim, which reads frozen state from the chain.
- release-gate.ts pins check-sha-green to CORE_REPO and no longer forwards GITHUB_REPOSITORY.
- Dapp codePins.ts verifyPinnedTarget: the code pin is checked, then the ERC-1967 slot and the implementation code hash at the same block. Pins are build-time only (not in RUNTIME_CONFIG_KEYS). Every deposit, approve and gateway write goes through useGuardedWriteContract.
- scripts/stage/mainnet-dapp.ts takes its implementation pins from the DeployTimelock read-back (_implementationCodeHash). It refuses a missing pin for a proxied contract. INDEXER_INVESTMENT_COMMITTEE is now set.
- rmpc withdraw.rs checks the router's implementation against proxy_implementation_hashes before it signs.
- evidence-check.ts checkEvidenceOnChain now replays the proxy_upgrades and proxy_freezes schedule and execute transactions, with their Upgraded and UpgradesFrozen events.
- The indexer watches retired vaults through the vaults table, and the compose default FEATURE_FLAGS=4 watches the registry. Upgraded events of the old rmPROTO therefore reach proxy_upgrade_events.
- VaultAdapterOps._ceiling routing math: it reads the same convertToAssets(balanceOf) expression MorphoAdapter._deposit checks against the cap, pass 2 re-reads balances fresh after any pass-1 allocation, and capHeadroom accounting uses the lowered ceiling, so a capped Morpho adapter can no longer revert routing or keeper rebalance (no economic loss beyond idle drag)
- addAdapter restore-on-re-add: the open record on the inactive index is drained (balance delta, not adapter return) and finalized before the push; at most one open record per address; nonReentrant; re-add never lifts NAV (Morpho share-rounding dust only)
- forceRemoveAdapter record opening: snapshot at totalSupply, opened flag set before any share movement, inactive records do not keep deposits closed (_anyActiveAdapterIneligible scans active entries only), and exit/stay parity holds by construction
- emergencyExcludeAdapter: exclude-only; permissionless syncExclusions cannot restore (allowed=false); a compromised hot key gains nothing by excluding a healthy adapter because claims bind to snapshot balances and deposits close
- 63/64 gas griefing of isEligible inside permissionless syncExclusions is infeasible: after a forced OOG of the USDC()/VAULT() staticcall the remaining 1/64 cannot pay for ledger.open, so the call reverts
- ExclusionLedger checkpoint/balanceAt binary search, claim floor rounding (sum of claims <= recovered), returnSurplus only above heldUsdc, and claim always paying the holder
- BasketVault ORA-4 move into previewDeposit: OZ deposit reads previewDeposit, mint calls _checkMarket explicitly, no subclass (ProtocolAsset, AgentToken, Rwa) overrides deposit/mint/_deposit/previewDeposit, maxMint stays non-reverting, and PortfolioRouter is the only on-chain previewDeposit caller and wraps it in try/catch
- Deposit-side TWAP manipulation after a held displacement: mint uses a TWAP-valued delta over TWAP-valued NAV, so a held price does not dilute existing holders (the depositor's gain equals the manipulator's own cost); the redeem side keeps the 4 h sell anchor
- Router split and renormalisation arithmetic, remainder sink on the last weighted leg, and the USDC custody invariant (unchanged in round 1)
- Watchdog router-leg netting: total counted is never below the actual router plus direct deposits, even with forged RouterDeposit rows
- Dapp redeem floors (deriveMinAssets from previewRedeem less tolerance) and router deposit floors (estShares less tolerance, 0 on preview-unavailable legs)
- runner.ts proxy read-back: a read that throws is now recorded as proxy_gate {ok:false, read_error:true}, and refuseAfterFailedProxyGate re-reads it before the next forge stage; timelock (forge) follows the last proxy stage, so a resume cannot reach handover/govern on an unread proxy
- runner.ts safe stage: confirmStage now runs before the predicted Safe address is recorded, so a refused confirmation leaves no started record
- runner.ts runStages: verify/govern-only runs refuse a missing run manifest and govern refuses one without a finished handover; govern.ts resumeCommand prints absolute --evidence and --counts-dir (closes the issue-1686 fresh-manifest pause bypass)
- cli.ts ownerSignerShortfall: duplicate specs, two specs claiming one owner, and claims outside SAFE_OWNERS are refused before stage 1; unreadable claims are deferred to prove-control by design (owner-signers.ts claimedOwnerOf)
- release-gate.ts: check-sha-green is always called with --repo robotmoney/robotmoney-core and GITHUB_REPOSITORY is no longer forwarded; the repo matches the checkout's origin
- evidence-check.ts secret scan: prefixed snake/kebab names (CHAIN_SIGNER_PASSWORD=, ETH_KEYSTORE_PASSWORD=, *_API_KEY=) and passphrase/secret keys now match; no camelCase-prefixed secret key is written by the tool
- evidence-check.ts: proxy_upgrades and proxy_freezes are now chain-checked on 8453 (schedule/execute, rebuilt calls, delay floor, Upgraded/UpgradesFrozen events, frozen slot and code hash); immutability claim requires retired vaults frozen, and registry.listVaults() cross-check prevents omitting a redeploy
- govern.ts upgrade-proxy round numbering: a completed round whose target is not live opens round n+1 with a new salt; the archived round keeps its key; the evidence entry is upserted by operation id
- govern.ts freeze-proxy: retired vaults are candidates for proxy=all and by name; a mixed-build proxy=all refuses rather than proceeding (fails safe)
- publish-contracts type-check (bun x tsc --noEmit) passes on the working tree
- clients/explorer-api/src/routes.rs:451-485 /v1/vault/snapshots is now bound to state.chain_id, and a foreign chain_id returns 404. Every other route binds state.chain_id (checked every sqlx query in routes.rs).
- clients/explorer-api/src/routes.rs:2111-2117 serves payload_bytes only when verified. The API never serves the fetch last_error.
- clients/explorer-api/src/routes.rs:301-331 /health degrades after 300 s without a successful run with a cursor. It uses the same row and clock as the watchdog's max_silence_secs.
- services/explorer-indexer/src/db.rs:1568-1634 apply_wallet_position_delta: the single writer, ordered within a block via one node-ordered eth_getLogs, with idempotent replay via last_log_index. Reorg rollback deletes by block.
- services/explorer-indexer/src/indexer.rs:1023-1100 reads the exclusion ledger from the vault's exclusionLedger() getter. A revert maps to NoLedger, zero or no code maps to Unknown, and other RPC errors fail the tick. vault_exclusion_ledgers has block_number, so the schema-derived rollback (db.rs:1170-1187) covers it. The emitter gate uses the stored ledger.
- services/explorer-indexer/src/indexer.rs:3140-3245 SSRF guard: blocks http/https-only schemes, link-local, IMDS v6 and IPv4-mapped addresses. DNS answers are pinned with resolve_to_addrs, only same-host redirects are followed, and the body is streamed with a 1 MiB cap.
- services/watchdog/src/watchdog.rs:333-385 and pause.rs:207-245 re-send the pause on a held block unless depositsPaused() reads true. The WD-5 confirmed-nonce fee bump can replace a stuck pause. An unreadable state counts as not paused.
- Gateway attribution: contracts/gateway/RobotMoneyGateway.sol:971-989 limits depositTo to the pinned vault or the router, so the indexer stamping AgentDeposit with cfg.vault is correct (refuted a per-vault misattribution hypothesis).
- scripts/stage/mainnet-dapp.ts:283,449 maps the IC policy into the 8453 indexer env. The compose default FEATURE_FLAGS=4 keeps VaultRegistry watched on 8453.
- Clients never sign from explorer data. The dapp reads exclusion claims (useExclusionClaims.ts) and upgrade gating from the chain. rmpc never reads the explorer (upgrade.rs:43, withdraw_router.rs:107).
- clients/dapp/src/lib/codePins.ts verifyPinnedTarget: code pin, then the ERC-1967 slot and implementation code read at one block; a missing pin, an unlisted or codeless implementation, and a pin on a direct contract each refuse
- clients/dapp/src/lib/useGuardedWriteContract.ts: the session cache is gone, every deposit, approve and gateway write re-reads at send time, and approve(spender, 0) is correctly exempt
- clients/dapp/src/lib/runtimeConfig.ts: implementation pins are build-time only and mainnet addresses come from the bundle, so the clone-proxy substitution (generic ERC1967Proxy plus a reviewed implementation over attacker storage) is refuted
- Every gateway write path (OnboardingWizard, AuthorizeTab, useRotationState, RevokeTab, PauseFlow, SafeProposalPanel, RefreshPriceButton) goes through useGuardedWriteContract
- clients/dapp/src/lib/vaultPreview.ts and routerRedeem.ts: redeems are no longer refused on gateway verification, they carry an UNVERIFIED badge and a warning, and the signed calldata equals the preview
- clients/dapp redeem targets: only the configured vault or VaultRegistry-listed vaults are signed against; explorer rows cannot choose a target
- clients/dapp/src/components/RouterDepositTab.tsx: zero floors on skipped legs are safe because a leg flipping to available shrinks the other legs below their floors and reverts
- clients/dapp/src/lib/configExport.ts: the live-read cast command is gone; gateway_implementation_hashes is exported only after it matched the build pin
- clients/rust-payment-client/src/commands/withdraw.rs: withdrawFromRouter now checks the router implementation before signing, and the source vault is checked in run_withdraw_vault
- clients/rust-payment-client deposit: a vault-destination depositTo can only reach gateway.vault(), which check 5c covers (gateway _validateDestination)
- clients/rust-payment-client agent-consent: checks the gateway code and implementation and signs under the live implementationVersion at one block
- clients/rust-payment-client/src/committee_identity.rs: create_new plus mode 0600 plus set_permissions before the write closes the umask and overwrite race
- scripts/stage/mainnet-dapp.ts: implementation pins are required for proxies and refused for direct contracts, and the IC policy proxy is now indexed
- Refusal name ErrImplementationNotApproved is documented in plugins/robotmoney-user safety.md and plugins/robotmoney-cli commands.md
- Gas floors: dapp and rmpc router and vault deposit floors still match PortfolioRouter.DEPOSIT_GAS_PER_LEG, RobotMoneyVault.DEPOSIT_ENTRY_GAS_FLOOR and the gateway ROUTER_DEPOSIT_* constants
- scripts/release/install-rmpc.sh: --source-ref refs/tags/<TAG>, the push-trigger count and the rmpc-v* tag shape close the writer-dispatch attestation path
- bun x tsc --noEmit on clients/dapp is clean on the working tree
- .github/workflows/release-rmpc.yml Validate inputs: dispatch with dry_run=false is refused, the pushed tag is shape-checked with bash [[ =~ ]], and no ${{ }} reaches a run: body. The publish and bump-manifest jobs and the attest step run only on the push of an rmpc-v* tag.
- Every uses: pin in release-rmpc.yml and release-dapp.yml resolves to the upstream tag commit it names, checked via gh api, so there are no impostor commits. The dtolnay/rust-toolchain pin equals upstream master.
- scripts/release/install-rmpc.sh: tag namespace regex, --source-ref refs/tags/<TAG>, the push-trigger count via --format json --jq, and the exit-6 refusals before extract.
- The protect-rmpc-release-tags ruleset is live. It restricts creation, update and deletion of refs/tags/rmpc-v*, and only OrganizationAdmin can bypass it.
- .github/scripts/audit_workflow_run_splice_and_perms.py: uses-unpinned and attest-ungated rules. suite-18 runs strict mode on both release workflows.
- publish-contracts/src/release-gate.ts: the CORE_REPO fix. check-sha-green gets --repo robotmoney/robotmoney-core, and GITHUB_REPOSITORY is no longer forwarded.
- scripts/ci/storage_layout_gate.py: the enum scanner handles comments, strings and nested braces, and fails closed on a missing or conflicting definition. Same-tree enum compare.
- .github/scripts/check_governance_docs.py rule 7 (release-receipt consequence).
- clients/dapp/Dockerfile and testing/ethereum-testnet/config/docker-compose.dapp.yaml: the new implementation-pin build args and the INDEXER_INVESTMENT_COMMITTEE pass-through.
- scripts/stage/mainnet-dapp.ts: implementation pins are required for proxies and refused for direct contracts. The ic_policy address is watched.

</details>

## Recommended actions

1. Run Phase Q on this working tree before any commit lands: the forge suite (including the flipped SR-1012-5 PoCs and the new exclusion, venue and router tests), the publish-contracts bun suite, `cargo test` for the services and rmpc (suite-08 with `TWIN_RPC_URL` for `fork_indexer`), the dapp unit tests, the shell self-tests (`storage_layout_gate.py --selftest`, `test_audit_workflow_run_splice_and_perms.sh`, `install-rmpc-selftest.sh`, `check-audit-ledger.test.sh`) and the fork tests that need `FORK_RPC_URL`.
2. Run a fourth security round scoped to the round 3 diff: the venue-health deposit gate, the `--no-replace-objects` tag gate, the snapshot-equals-code layout rule, the bounded per-hour window, the vote memo sweep, rmpc derived floors and latest-only pins. Add one composition pass across them.
3. Re-measure deposit gas after the `_allocate` balance reads and the `venueWithdrawable` static calls, against `docs/technical/redeem-gas-1482.md`, the 1.6M entry floor and the dapp's fixed `VAULT_DEPOSIT_GAS_LIMIT`.
4. Ask the repository owner for three GitHub settings: immutable releases, an admin-only ruleset on `refs/tags/release/*` (the layout anchor trusts those tags), and required status checks on `dev`.
5. After merge, dispatch one `release-rmpc` dry run to prove the new `ubuntu-24.04-arm` leg, then have an admin push the next `rmpc-v` tag. The new installer refuses `rmpc-v0.3.4`, which was dispatched from `dev`.
6. Point every operator checkout's `origin` at `robotmoney/robotmoney-core`. The canonical tag check now refuses an origin that names `robotmoney-monorepo`.
7. Plan a redeploy of the rmUSDC adapters in the final deployment. The deploy-2 adapters have neither the supply-refusal refund nor `venueWithdrawable`.
8. Schedule the deferred swarm preflight fix (review-security-014).
9. Close the residuals named in the findings: a watchdog alert on `DeployRefused` and `UnroutedDeposit`, the `type=gha` cache in `release-dapp.yml`, a dapp revert-name entry for `LegSkippedWithFloor`, pin coverage for `router.depositFor`, `recoverRemovedAdapter` in the illiquid-adapter runbook, and the stale lines in `portfolio-router-decisions.md` and `unified-vault-spec.md`.
10. Commit the fixes in lane-sized commits that name these review IDs, so the ledger rows can cite commits instead of the working tree.

## Documentation changes

The lane fixers and sweeps changed these canonical documents in the working tree to match the fixes:

- `docs/adr/ADR-0014-governed-upgrades-and-freeze.md`
- `docs/architecture.md`
- `docs/audits.md`
- `docs/development/environments.md`
- `docs/development/releasing.md`
- `docs/development/stage-deployment.md`
- `docs/explorer-api.md`
- `docs/operations/contract-release-runbooks.md`
- `docs/operations/watchdog-liveness.md`
- `docs/technical/adapter-architecture.md`
- `docs/technical/consensus-receipt-submitter-runbook.md`
- `docs/technical/dapp-topology.md`
- `docs/technical/governance-decisions.md`
- `docs/technical/rmpc-read-output-contract.md`
- `docs/technical/security-model.md`
- `docs/technical/smart-contract-invariants.md`
- `docs/technical/smart-contracts.md`

This report adds rows `SR-1015-1` to `SR-1015-69` to the `docs/audits.md` finding register, keys this file in `scripts/check-audit-ledger.sh`, and records the review-skill file name form in `docs/code-review/README.md`. It also retargets the planted cite in `scripts/check-audit-ledger.test.sh` from `RobotMoneyVault.sol:1104-1107` to `RobotMoneyVault.sol:1150-1155`, because round 1 rewrote row SR-1012-5 and the self-test had stopped finding its setup line.

## Unresolved decisions

- EMERGENCY authority (issue 1705, Q2/C6). The fixes give the hot key two new levers: `emergencyExcludeAdapter` (exclude only) and `recoverRemovedAdapter` (moves value only into an open exclusion record). The owner has to accept that wider authority or narrow it.
- ADR-0014 is still "Proposed, pending owner acceptance". Every upgrade and freeze fix in this review builds on it.
- The `ZeroPayoutDuringExclusion` guard was not widened to inactive records. A zero-payout redeem after a force-remove still burns shares and keeps its claim through the checkpoint.
- The indexer's payload and memo fetch still allows loopback and private address ranges, so devnets keep working. Decide whether the 8453 indexer should refuse them.
- The watchdog now re-pauses after an admin unpause while a breach alert stays undelivered. Decide whether that is the wanted behavior.
- `--evidence` stays optional on 8453, and `pause-all` is not held to a finished timelock stage.
- `release-rmpc` dispatch is dry-run only, and linux-arm64 now builds natively. That drops prebuilt arm64 binaries for Debian 11 and Ubuntu 20.04.
- rmpc now derives router floors, which changes the on-chain `paymentId` between runs. A retry after a lost local replay cache can land twice.
- The release-tag gate now needs https access to GitHub. An ssh-only network fails closed.
- A rename or delisting of a proxied contract now fails the layout gate closed. There is no rename map.
- The rmpc `proxy_implementation_hashes` list stays flat across addresses. A round 2 candidate about it was refuted as documented design, and round 3 left the export filter undone.
- Queued operations and in-flight transactions across an upgrade, and alerting on a scheduled but not yet executed upgrade, are an open owner question (ADR-0014 §10, `docs/development/open-questions.md`).

## Limitations

- No test suite ran, by the preamble's rule. Every fix is compile-verified only and needs Phase Q. That includes the fork tests that need `FORK_RPC_URL` or `TWIN_RPC_URL`.
- The loop stopped at its three-round cap while round 3 was still confirming medium and high findings. The round 3 fixes have not been reviewed.
- The reviewed state is an uncommitted working tree on top of `9d9bb854b1f0b7ca5a572242c715ada0fe27ed77`. The `commit` field pins that base, not the reviewed bytes.
- Line numbers are as each finder saw them in its round. Later fixes moved many of them.
- Each lens finder returned at most 12 findings per round, so lower-severity issues beyond that cap can be missing.
- Skeptics read code. They did not execute anything. Some refutations rest on accepted, documented risks (for example the exclude-then-drain order of FS-VLT-8).
- This writer rebuilt rounds 2 and 3 from subagent transcripts because the digest it received was truncated. The replay matched round 1 exactly.
- Nine candidates were folded into the findings they repeat. Each fold follows a fixer's own "duplicate" or "same fix" note.
- Deposit gas after the fixes was not re-measured.
- GitHub settings, the devops repository and live chain state were not inspected.

## Unreviewed surfaces

The round 3 finders named these surfaces as not reviewed. The earlier rounds' lists follow in collapsed blocks, and the JSON summary holds all three.

- RobotMoneyGateway consent-on-authorize, commit/reveal and committee path (unchanged since base; only depositTo was re-read for the composition pass)
- InvestmentCommitteePolicy, ConsensusRecommendationReceipt and ProposerFloorTimelock internals (unchanged this round)
- BasketVault family beyond the round-1/2 diff: swap paths, _withdraw, redeemInKind, emergencyUnwind
- Adapter withdraw paths and the Uniswap/Aerodrome swap adapters
- VaultRegistry and ExclusionLedgerFactory
- Deploy scripts other than the DeployTimelock diff (CoreStages, DeployLibs CREATE2 linking of the new VaultAdapterOps)
- Off-lens consumers of the new exclusion semantics: the indexer still labels AdapterForceRemoved.lossAmount as a loss, and dapp/explorer rendering was not checked
- Non-upgrade round-2 contract logic: VaultAdapterOps exclusion/exposure caps (note: Book.openExclusionOf is keyed by adapter index), RobotMoneyVault emergencyExcludeAdapter/recoverRemovedAdapter, PortfolioRouter leg skipping, and RouterGovernance. These belong to the economics and contracts lens.
- CI supply chain: release-rmpc.yml, release-dapp.yml, audit_workflow_run_splice_and_perms.py, check_governance_docs.py and install-rmpc.sh.
- services/watchdog (volume.rs, watchdog.rs, liveness.rs, pause.rs) and clients/explorer-api route changes.
- explorer-indexer changes other than the ExclusionLedger refresh, and migrations 0026-0027.
- Pre-existing upgrade code untouched by round 2: GovernedProxyDeploy deploy+initialize atomicity, twin-upgrade-rehearsal.ts, and the gateway implementationVersion consent binding. These were only spot-checked.
- No test suite was run. The layout checks used the gate's own normalize() and compare() through forge inspect, plus small pure simulations in the session scratchpad.
- publish-contracts/, scripts/ci/, .github/workflows/ and release scripts changed in round 2 (tooling and CI, outside the economics lens)
- UniswapV4PriceRecorder and BasketViews.checkMarket internals (unchanged this round; recorder TWAP manipulation was not re-derived)
- RobotMoneyGateway beyond the router deposit and withdraw call sites
- Dapp code-pin and write-guard internals (codePins.ts, useGuardedWriteContract.ts, useVerifiedCodeTargets.ts)
- Indexer payload and memo fetch changes, reorg handling, and watchdog pause.rs and liveness.rs changes
- Forge tests were not run (read-only review; no compile check was needed for these findings)
- scripts/release/install-rmpc.sh and install-rmpc-selftest.sh (ci lane)
- scripts/ci/storage_layout_gate.py and check-storage-layout.sh round-2 changes (ci lane)
- .github/workflows and .github/scripts changes (ci lane)
- contracts/, services/, clients/ and plugins/ diffs (other lenses)
- Not checked: whether artifactSourceProblems accepts a genuine solc build with altered remappings or settings that resolve an import to a different committed file. It checks source hashes, not metadata.settings against foundry.toml.
- Not checked: whether the git transport in verifyRemoteTag/assertCanonicalOrigin can be redirected by the build checkout's repo-local config (core.sshCommand, http.proxy with sslVerify off). It is plausible and folded into finding 1's fix, but not reproduced.
- Trust in operator-editable stage manifests for <field>_layout_id (upgradeLayouts liveId == buildId skips the compare). Noted, but not reported as a separate finding.
- prove-control adoption, self-admin rows, set-unwind-guard, CONFIRM=environment Actions proof: not changed by round 2 and not re-traced this round
- scripts/stage/mainnet-dapp.ts upgradedImplementationHashes: trusts the evidence file without a chain check and keeps rolled-back implementations pinned. Not taken further.
- Dapp code pins (codePins.ts, useGuardedWriteContract.ts) and the mainnet-dapp --upgrade-evidence pin rotation beyond the env wiring (clients lane)
- Watchdog upgrade_events.rs and freeze_deadline.rs (unchanged this round)
- Regime feed and committee vote placeholder logic, beyond their role in the composition pass (unchanged since base)
- Watchdog reorg reconcile: the watchdog never re-evaluates blocks the indexer rolls back and re-indexes below its cursor (pre-existing, not traced in depth)
- New SQL was checked only by reading, never against Postgres; no test suites were run per the rules
- services/explorer-indexer/tests/fork_indexer.rs Twin-chain tests
- The swarm preflight guard: rmpc committee.rs:552 is a known open finding with no round-2 change, so it was not re-reviewed.
- rmpc upgrade::verify_router_and_legs and verify_reached_proxy internals (unchanged). Only their call sites in withdraw.rs and deposit.rs were read.
- The dapp commit/reveal preview and the AuthorizeTab consent flows, unchanged since base apart from the send-time gateway re-check.
- The SafeProposalPanel and TimelockPanel admin signing payloads, including upgrade scheduling previews.
- The explorer-api, indexer and watchdog round-2 changes (indexer lane).
- install-rmpc.sh, release-rmpc.yml and release-dapp.yml round-2 changes (ci lane). The diff was skimmed only for client supply-chain context.
- The publish-contracts govern, upgrade-rows and build-provenance changes beyond the evidence-row shape the dapp builder consumes (tooling lane).
- No test suites were run, as the review rules require. Test adequacy for the two findings was judged by reading the test files only.
- Internals of install-rmpc-selftest.sh and test_audit_workflow_run_splice_and_perms.sh: skimmed only, not traced assertion by assertion.
- gh attestation verify --signer-workflow anchoring: I could not confirm from the gh 2.102.0 binary whether the SAN regex is a prefix match. If it is, a sibling workflow in an admin-tagged commit (for example release-rmpc-yml-x.yml) would also satisfy the pin.
- scripts/ci/check-sha-green.ts trusts a check run by name only, from any app or workflow. A writer workflow with checks: write can post a 'success' run for a required check that never ran on a sha. This file did not change in round 2 and was left out of scope.
- No ruleset protects release/* tags, so any writer can delete or move the anchors --release-anchor treats as fixed. Not reported because the upgrade-time compare is anchored to the recorded layout_id.
- Workflows outside release-dapp.yml and release-rmpc.yml get only the workflow-scope audit (for example release-tag-suite-dispatch.yml and suite-21-nightly.yml with actions: write). They did not change in round 2.
- Repository Actions settings beyond rulesets (default token permissions, fork PR approval policy).
- scripts/stage/mainnet-dapp.ts upgradedImplementationHashes trusts implementation_code_hash from an operator-supplied evidence file without an on-chain read-back (tooling/clients lane).

<details><summary>Round 1 unreviewed surfaces (56)</summary>

- publish-contracts/ govern rows, the verifier and evidence-check (only grepped for receipt release, the timelock codehash and the exclusion ledger).
- scripts/deploy stage driver and stage-table wiring of TIMELOCK_ADDRESS, UPGRADE_AUTHORITY and EXCLUSION_LEDGER_FACTORY. The contracts/script side only checks code presence. I judged this not exploitable without tampered operator inputs.
- BasketAssetConfigGuard.addAsset/requirePoolUsable/requireExecutionPoolMatchesTwap, TwapTickMath, TickMath, BasketViews.checkNavDeviation, AerodromeSwapAdapter and UniswapV3SwapAdapter internals.
- Economic manipulation of the permissionless UniswapV4PriceRecorder and the D5 sell-anchor sandwich-DoS on USDC redeems (owner-accepted and documented trade-offs, not re-assessed).
- Storage-layout snapshots against compiled layouts (forge inspect was not run). Gas-floor adequacy after the ledger checkpoint and D4 preview calls.
- DeployVault, BasketVaultDeployBase, DeployVaultRegistry, DeployPortfolioRouter and DeployRouterGovernance full bodies (skimmed for role grants only).
- No tests were run, per the contract. All test evidence comes from reading test source.
- publish-contracts/src/ci/twin-upgrade-rehearsal.ts and evidence-check --proxy-lifecycle (Twin-only) beyond the 8453 refusal of the generic call
- Behaviour parity of code moved into VaultAdapterOps, BasketSwapOps, GatewayWindows, GatewayWithdrawOps (reviewed only for delegatecall and storage binding, not business logic)
- services/watchdog upgrade_events.rs and freeze_deadline.rs polling logic beyond the hand-configured proxy list
- Dapp UpgradeStatePanel and ProtocolUpgradesPanel rendering; rmpc per-command wiring of checks 2b (which commands call verify_reached_proxy / verify_router_and_legs)
- No alert or client warning exists for a scheduled (not yet executed) upgrade; recorded as an open owner decision (ADR-0014 §10, open-questions.md), not reported
- GovernedProxyDeploy._layoutId hashes the checkout snapshot file rather than the built implementation's layout; only relevant off a green release sha
- EIP-170 headroom, gas re-measurement and all forge/bun/cargo tests (not run per preamble)
- services/explorer-indexer and clients/explorer-api: TVL, share-price and APY math during an exclusion (the ledger's USDC is outside totalAssets), and the preview_redeem_total use (X8).
- clients/rust-payment-client: derivation of the router deposit and redeem floors beyond the withdraw route, and how claims are shown or used during an exclusion.
- plugins/: agent-facing guidance on floors and leg skipping.
- AerodromeSwapAdapter and UniswapV3SwapAdapter swap and TWAP paths (not changed on this branch), plus the Aave and Compound adapter rounding (clean in the prior review).
- InvestmentCommitteePolicy and ConsensusRecommendationReceipt weight provenance (governance lens).
- GovernedUpgrade, ProposerFloorTimelock and upgrade-time changes to constant ceilings (authority lens, not economics).
- publish-contracts verifier labels for caps, weights and the recorder ring (D5 tooling), and scripts/ops recorder keeper cadence.
- No tests were run (contract rule). Every claim was checked by reading the code.
- publish-contracts/src/verify/index.ts beyond the applied-vector, code-target and unwind-guard labels
- publish-contracts/src/pause-all.ts internals
- publish-contracts/src/record-receipt.ts, committee-register.ts, submitter-safe.ts (B6 self-authorization) in depth
- publish-contracts/src/safe/tx.ts, safe/timelock.ts, safe/safe.ts createSafe internals
- publish-contracts/src/libs-adopt.ts, counts-reconstruct.ts, counts-drift.ts
- publish-contracts/src/rehearsal/* and ci/twin-publish.ts. ci/twin-upgrade-rehearsal.ts beyond its header.
- scripts/deploy forge scripts other than RedeployProtocolAssetVault.s.sol
- The devops repo's mainnet workflow (external): GITHUB_REPOSITORY handling and CONFIRM=environment usage
- forge out/ and cache freshness relative to the checkout (no tool check ties out/ to the source at the sha)
- services/explorer-indexer/src/rpc.rs retry, refusal classification and URL redaction internals (skimmed only)
- clients/explorer-api exclusion-claims SQL claimable math (moot while no records are indexed)
- services/watchdog/src/receipt_liveness.rs and alert.rs payload formats in depth
- services/explorer-indexer/src/abi.rs full topic table (only the upgrade and exclusion topics were checked)
- Migrations 0019-0024 behaviour against a populated production database and the rebuild runbook
- scripts/stage/measure-catch-up.ts and the stage supervisor install units
- Dapp display paths that consume explorer data without signing (VaultCards, RouterView, ConsensusReceiptPanel's browser-side payload fetch)
- Watchdog upgrade-event cursor versus out-of-order inserts from the X1 refetch within one in-flight tick (judged too improbable to report, not proven safe)
- clients/rust-payment-client/src/consensus_receipt.rs (2126 lines): receipt verification and digest derivation were not traced.
- rmpc fees/, nonce/ and replay_cache internals, plus the get_agent.rs null handling claimed by DR-8.
- Dapp SafeProposalPanel and safeProposal.ts EIP-712 SafeTx digest and import logic: only the execute path was skimmed.
- Dapp ConsensusReceiptPanel, CommitteePanel, RegimeFeedPanel and ProtocolUpgradesPanel indexed-state labelling (display only).
- plugins/robotmoney-analyst and plugins/robotmoney-committee skills.
- Whether the fixed VAULT_DEPOSIT_GAS_LIMIT of 2.5M covers basket vault deposits, and whether rmpc's 150k router-deposit margin covers pre-check gas on a proxied gateway and router. Neither can be measured without running the fork tests.
- No test suite was run, by contract. The new U-lane and P3 tests remain unexecuted.
- clients/explorer-api: indexer lane, outside this lens.
- The devops repo workflow: how it calls check-sha-green and the CLI, its Environment reviewers, and how its secrets are scoped.
- GitHub repository settings: rulesets (rmpc-v*, release/*, v*), immutable releases, the default GITHUB_TOKEN permissions, whether the github-actions app can bypass the tag ruleset, and secret scoping (repo or environment).
- How the GitHub check-runs API filter=latest de-duplicates check-runs that share a name across check suites. This decides whether a forged later success can hide a real failure.
- The test-counting logic of check_executed_floors.py and check_cargo_test_target_coverage.py, beyond their wiring and the T5 claims.
- The step logic of publish-contracts/src/ci/twin-publish.ts and twin-upgrade-rehearsal.ts, beyond key and evidence handling.
- The gating semantics of release-tag-suite-dispatch.yml: the 30 s first poll, no check of dispatched against observed runs, and skipped counted as pass. It is a secondary gate.
- The code of third-party actions, and the actionlint curl|bash installer in suites 13 and 21-drift.
- The suite-28 stack selftest containers and the scripts/stage Dockerfile digest rules.
- release-dapp.yml image consumers outside this repo.

</details>

<details><summary>Round 2 unreviewed surfaces (59)</summary>

- publish-contracts/* and scripts/ci/storage_layout_gate.py round-1 changes (tooling and ci lenses)
- services/explorer-indexer, services/watchdog, clients/explorer-api round-1 changes (indexer lens)
- clients/dapp and clients/rust-payment-client round-1 changes beyond reading codePins.ts and useExclusionClaims.ts (clients lens)
- .github workflows and scripts/release/install-rmpc.sh (ci lens)
- RobotMoneyGateway consent and commit-reveal, the committee path, InvestmentCommitteePolicy, ConsensusRecommendationReceipt, ProposerFloorTimelock, VaultRegistry: unchanged in round 1 and not re-reviewed this round
- Basket realised-swap slippage-floor revert on routed deposits: known and documented, not re-examined
- No forge tests were executed (review rules); conclusions rest on code reading plus forge build
- contracts/script/GovernedProxyDeploy.sol and the per-stage Deploy*.s.sol scripts (whether deploy and initialize are atomic, and the proxy read-back). They were not changed in round 1 and were not re-read.
- contracts/ProposerFloorTimelock.sol and DeployUpgradeAuthority.s.sol.
- publish-contracts/src/ci/twin-upgrade-rehearsal.ts and evidence-check --proxy-lifecycle mode internals beyond the call-site.
- How an Upgraded event invalidates other indexer caches besides the ledger (vault family and kind caches).
- The dapp's useUpgradeState indexed path: whether the dapp trusts explorer-api upgrade or freeze state.
- The rmpc proxy_implementation_hashes flat-list semantics: one hash list covers all vaults and the router, so the pins are not per proxy. This is a pre-existing design and was not judged.
- The release-rmpc.yml, release-dapp.yml and install-rmpc.sh changes (outside the upgrade lens).
- The watchdog volume, pause and alert changes, and the explorer-api routes changes (outside the upgrade lens).
- Exclusion and adapter economics in contracts/lib/VaultAdapterOps.sol and RobotMoneyVault.sol (economics lens).
- Whether GitHub branch protection on dev requires forge-unit-tests. It was not checked because there was no GitHub access. The ci finding assumes red commits can land, as the user memory notes that dev is unprotected.
- publish-contracts/ (govern, runner, release-gate, upgrade rows, evidence scan) round-1 changes: outside the economics lens
- scripts/ci/storage_layout_gate.py, scripts/release/install-rmpc*.sh and .github/workflows changes
- services/explorer-indexer round-1 changes beyond the exclusionLedger() read classification (snapshot cadence, wallet_positions, consensus receipt indexing)
- clients/explorer-api routes and model changes
- clients/dapp code pins, useGuardedWriteContract and useVerifiedCodeTargets implementation-pin logic, and the dapp still closing router deposits when a weighted leg is paused even though the router would skip it (UX, clients lane)
- clients/rust-payment-client withdraw and committee_identity changes
- contracts/script/DeployTimelock.s.sol implementation-hash manifest fields
- Gas impact of ExclusionLedger.checkpoint on every share movement against the vault and router gas floors (needs measurement; tests not run per contract)
- UniswapV4PriceRecorder and BasketViews sell-anchor math (unchanged in round 1)
- Live 8453 cap and slippage values (only the example and twin sheets were read)
- CONFIRM=environment Actions proof (actions-proof.ts unchanged this round)
- prove-control adoption and hardware-optional owner-signer floors (floors.ts, prove-control.ts unchanged)
- set-unwind-guard and self-admin row internals beyond the resumeCommand change (unwind-guard.ts unchanged)
- evidence-check applied-vector and new_vault CREATE binding paths (unchanged this round)
- redeploy-vault sha model beyond retiredProxiesOf
- scripts/stage/mainnet-dapp.ts indexer watch list (indexer/clients lens)
- contracts/, clients/, services/, .github/ and scripts/release changes from round 1 (other lenses)
- Runtime behaviour of check-sha-green against GitHub and forge-based storage gate selftest (not executed: no test suites)
- contracts/, publish-contracts/, scripts/ci and .github round-1 changes (other lanes)
- clients/dapp and clients/rust-payment-client round-1 changes beyond whether they sign from explorer data
- services/watchdog/src/upgrade_events.rs paging logic (unchanged in round 1)
- Committee regime, vote FK and key, and reorg reconcile code paths unchanged since base 9d9bb854
- Test-file changes under services/*/tests and clients/explorer-api/tests (read only to locate behavior; not audited for adequacy)
- Backfill of historical ledger events on an existing indexer DB after migration 0026 (the cursor is not reset). Not assessed for data completeness.
- Indexer and watchdog behavior behind an HTTP proxy set through environment variables (reqwest system proxy)
- services/ and clients/explorer-api changes (indexer lens)
- contracts/ and publish-contracts/ round-1 changes beyond the BasketVault previewDeposit and router skip semantics used in the composition pass
- clients/rust-payment-client/src/commands/committee.rs swarm role guard (unchanged; already reported at committee.rs:552)
- plugins/robotmoney-swarm/scripts/check-preflight.sh beyond confirming it is unchanged
- SafeProposalPanel and timelock schedule/execute proposal flows (unchanged this round)
- clients/dapp MultiVaultWithdrawalTab.tsx and VaultSelectorDepositTab.tsx (no render site found)
- gh attestation --signer-workflow suffix-matching semantics (not checked against gh source)
- release-rmpc.yml, release-dapp.yml and install-rmpc-selftest.sh (ci lane)
- cargo check of rust-payment-client (not run)
- Keystore load paths do not refuse or warn on a world-readable identity or EVM keystore made by an older rmpc (noted as hygiene, not reported)
- Contract diffs (RobotMoneyVault.sol, PortfolioRouter.sol, RouterGovernance.sol, BasketVault.sol) and their tests: outside the CI lens.
- services/explorer-indexer, services/watchdog, clients/explorer-api: changes and migrations 0026/0026 not read.
- clients/dapp and clients/rust-payment-client source changes: only the build-arg plumbing was read.
- publish-contracts runner.ts, evidence-check.ts, upgrade-rows.ts round numbering, verify-stage.ts, redeploy-vault.ts, owner-signers.ts: only the build-provenance, layout and release-gate seams were traced.
- Workflows not changed this round: release-tag-suite-dispatch.yml, suite-21-nightly.yml, suite-13-doc-checks.yml and suite-07 write scopes. Also release-dapp.yml, which any writer can dispatch with any commit_hash, pushes ghcr.io/<owner>/dapp:latest and an unprotected v* tag, and uses a cache-from/cache-to type=gha cache. That path is pre-existing and was not re-scored.
- scripts/ci/deploy-gate-jobs.ts and forge_test_require_executed.sh were not changed. Their executed-floor behavior was not re-verified.
- No test suites were run (by rule). The cache-poisoning chain was traced from the rust-cache source at the pinned sha and from GitHub cache-scope rules. It was not executed.

</details>
