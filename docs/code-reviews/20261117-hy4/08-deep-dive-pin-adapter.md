# Deep-dive worker C — local-only commits, adapter metadata bypass, RB-1022

- Repository: `git@github.com:robotmoney/robotmoney-core.git`; branch reviewed: `release-0.9.0`
- Pin: `d4a43e6d21efed208816698d2b32f0decea45451`; `reviewed_at 2026-11-17`; tracker: github (adhoc, no issue/PR)
- Worker worktree: `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/adhoc-20261117-145601` (HEAD verified `d4a43e6d2`)
- Contract: `AGENTS.md` global + `/drive2/home/lucas/.agents/skills/_shared/review-contract.md` severity rubric
- Scope discipline: principal checkout untouched; only this output file written; no production code, canonical docs, sibling scratch, `docs/code-review/` artifacts or `scripts/check-audit-ledger.sh` modified.

---

## C1 — The two local-only commits in the pin

VERDICT: closed

EVIDENCE: commits `f25f77faf02689c0ab4d40da391dea4a9d118f25` ("Fix Deploy 4 v0.9 upgrade preflight") and `d4a43e6d21efed208816698d2b32f0decea45451` ("Verify prior Deploy 4 upgrade builds"), each `git show --format=fuller` read in full; `publish-contracts/src/release-gate.ts:359-360`; `publish-contracts/src/deploy-implementation.ts:167-168,193,201,206,208`; `publish-contracts/src/evidence-check.ts:1026-1032`; `scripts/runbook/relocate-deploy4-v080.ts:8-22`; `docs/runbooks/contract-qa/releases/v0.9.0-onevault-upgrade.yaml:81,105,442,468-480`; `scripts/runbook/validate-contract-qa.ts` (`d4live` def); new/updated tests in `publish-contracts/tests/{cli,deploy-implementation,evidence-check,deploy4-relocation}.test.ts`.

ANALYSIS:

`origin/release-0.9.0` is `ffc5e4b0d`; the pin is exactly two commits ahead. Both commits were read in full (diffs above). They do touch security-relevant *surfaces* — release gate, storage-layout gate, verifier, run manifest — but every edit preserves or strengthens the guard; none is a regression against the clean verdict.

**`f25f77faf`:**

- Runbook decisions D4-12 (`:81`), D4-16 (`:105`) move from `open` to `decided`, recording the owner's 8453 go and the accepted `cancelBuffer=900`, `maxPause=259200`, `matchBandBps=10`; D4-13 (`:87`) corrects the gate's expected branch from `releases-0.9.x` to `release-0.9.0`. This is owner-authorization *recording* required by runbook policy 4.14, not a code guard.
- `release-gate.ts:359-360` — the one edit to an actual security gate. For `release/v0.9.0-rc.*` tags the required branch becomes `release-0.9.0` instead of the derived `releases-0.9.x`; the `onBranch` ancestry check is retained and still refuses a tag on a QA branch or `dev`. This is a correctness fix matching the reviewed branch name (the reviewed branch **is** `release-0.9.0`), not a weakening: any rc build still must be an ancestor of `origin/release-0.9.0`. `publish-contracts/tests/cli.test.ts:85-93` adds a positive case plus a `branch:false` rejection case, so the binding is executed, not merely asserted.
- `P0.89` (`:442`) now excludes the retired `REBALANCER_KEEPER_GRACE` field from the live-vs-run-sheet diff — a run-sheet comparison correction, not a guard removal.

**`d4a43e6d2`:**

- `P0.91` (`:468-480`) rebuilds the original v0.7 deployment (`7c23569f8`) and the two v0.8 proxy builds (`fa7c47182`) in clean detached worktrees, verifies clean status, adds `evidence-check --governed-upgrades` (on-chain timelock verification of the two prior upgrades) and runs the relocation script. The verifier now compares each upgraded proxy against its *recorded* build and every other proxy against v0.7. This is a more precise per-proxy reconstruction of on-chain history, not a relaxation.
- `deploy-implementation.ts:167-168,193,201,206,208` — for a fund proxy, the storage-layout baseline becomes the proxy's own previous build from the run manifest (`proxyBuildDirsOf`) rather than `ctx.coreDir`; the layout gate still runs (`layoutGateProblems` at `:201`, refuse at `:208`). `publish-contracts/tests/deploy-implementation.test.ts:433-450` proves an incompatible prior field is refused (`REFUSED`, zero sends). The manifest baseline is the run's own read-only evidence dir, and the relocation script pins the exact two entries (below); so this is a correctness improvement for an already-upgraded proxy, not a bypass. Advisory watch-point: the baseline now depends on manifest `proxy_upgrades` `build` paths — but those are pinned by `relocate-deploy4-v080.ts` and the guard fails closed on a bad path.
- `evidence-check.ts:1026-1032` adds an on-chain check that each recorded `execute_tx` has a successful receipt and exactly one matching `CallExecuted(id, proxy, upgradeToAndCall calldata)` — strictly stronger verification. `evidence-check.test.ts` adds a negative test.
- `scripts/runbook/relocate-deploy4-v080.ts:13-22` — new fail-closed tooling: refuses unless `system=fund`, `coreSha=7c23569f8`, exactly two `proxy_upgrades`, exact implementation addresses, both `schedule_tx`/`execute_tx` present, `build_sha` pinned to `fa7c47182`; records `original_build` and never writes the live record. Throws on unexpected history (covered by the new `deploy4-relocation.test.ts`).
- `validate-contract-qa.ts` `d4live` retargets to `v070`/`7c23569f8`, consistent with `P0.91`. Cleanup (`P9.83`) now also removes `v070`.

Chain guards, role wiring, timelock/upgrade authority, codehash pins, CI guards and freezes are not changed by either commit. The edits are verification/tooling and owner-decision recording, plus one branch-binding correction that keeps the release gate intact on the reviewed branch.

SEVERITY IF PROMOTED: N/A — no regression identified. (If the `release-gate.ts:359` branch relaxation were later found to admit a non-reviewed branch, it would be Medium as a release-authorization gate; at this pin the ancestry check is retained and the target branch is the reviewed one, so it does not.)

RECOMMENDATION: No action. Record in the synthesis that both local-only commits are in-scope and clean; optionally note the `release-0.9.0` branch specialization at `release-gate.ts:359` as the single security-gate-affecting edit so a future reviewer can confirm it is removed/ generalized with the branch.

---

## C2 — Adapter metadata-length bypass (`_codeLengthWithoutMetadata`)

VERDICT: advisory

EVIDENCE: `contracts/script/AdapterBytecodeGuard.sol:54-58,69-87,92-100`; `contracts/script/DeployVault.s.sol:137-144,248-250,266-268,304-306`; `contracts/test/AdapterDelegatecallGuard.t.sol:20-40,65-123`; `contracts/adapters/{AaveV3Adapter,CompoundV3Adapter,MorphoAdapter}.sol` (`using SafeERC20 for IERC20` only: :26/:28/:26); `publish-contracts/src/verify/index.ts:504,615,662`; `publish-contracts/src/release-gate.ts:350-352` (`buildProvenanceProblems`); `docs/technical/smart-contract-invariants.md:274`; `contracts/vaults/BasketVault.sol:1131`.

ANALYSIS:

**The library property is real in isolation.** `_codeLengthWithoutMetadata` (`:92-100`) trusts the last two bytes as a CBOR length `metaLen` and sets the scan bound to `len - metaLen - 2`; `_scan` (`:69-87`) only examines bytes below that bound and skips `PUSHn` immediates. An arbitrary `bytes` passed to `containsDelegatecall`, or an arbitrary on-chain address passed to `requireNoDelegatecall`, could place a `0xF4` just before a trailer that declares a large plausible `metaLen`, hiding it from the scan. The test suite only covers PUSH-immediate false positives (`AdapterDelegatecallGuard.t.sol:108-123`) and the bare-opcode/proxy cases (`:65-117`) — there is no test for a forged metadata trailer. So the code is not defensively complete as a general scanner.

**But it is unreachable on every production path at this pin, for four independent reasons:**

1. **Only one production caller, and it scans freshly compiled bytecode.** `AdapterBytecodeGuard.requireNoDelegatecall` appears in exactly one non-test site: `DeployVault.s.sol:266` inside `_approveAdapter`, called for `d.aaveAdapter`, `d.compoundAdapter`, `d.moonwellAdapter` (`:248-250`). Those three addresses are created by `new AaveV3Adapter(...)`, `new CompoundV3Adapter(...)`, `new MorphoAdapter(...)` inside `_deploy` (`:304-306`), which runs *before* `_approveAndRegisterAdapters` in every entry point (`run()` `:137-144`, and the three in-process variants). The scanner reads `adapter_.code` — live on-chain code of a contract deployed seconds earlier from locally compiled source. No external, manifest-supplied, or operator-supplied adapter address reaches it.

2. **Metadata trailer is solc-controlled, not attacker-controlled.** For these locally compiled adapters the trailing two bytes are the genuine CBOR length, so the scan bound lands exactly at the metadata boundary; there is no adversarial input to `metaLen`. The v0.9 upgrade (`deploy-implementation.ts`) upgrades fund/queue implementations via GovernedUUPS and does not re-approve adapters or touch the adapter codehash allowlist, so no new adapter bytecode enters on the upgrade path either.

3. **"Swapped library at link time" does not apply.** The three adapters use only `using SafeERC20 for IERC20` — OpenZeppelin *internal* functions, statically inlined, no external library link and no `DELEGATECALL`. (The adapters that legitimately `DELEGATECALL` `TickMath` are the *basket* swap adapters, which are explicitly outside this guard: `smart-contract-invariants.md:274`, `BasketVault.sol:1131` — a documented exception, not a hidden bypass.) Introducing a delegatecalling linked library would require changing trusted source.

4. **"Compromised cached `out/`" does not reach the guard, and is independently gated.** The guard never reads an artifact; it reads deployed on-chain code. A poisoned `out/` would have to change the bytecode *before* `new Adapter(...)`, i.e. a full build/deploy-environment compromise — at which point the attacker can edit `DeployVault.s.sol` to skip the guard or pin arbitrary codehashes directly, so the bypass grants no incremental capability. Build integrity is also gated: `assertUpgradeBuildGate` refuses a dirty checkout and stale `out/` whose sources do not match the tree plus forge config (`release-gate.ts:350-352`), and `P0.91` builds in clean detached worktrees with a `status --porcelain` assertion.

**Pin order and fail-closed behaviour.** In `_approveAdapter`, the guard is at `:266`, `setAdapterAllowed` at `:267`, and the codehash pin `setAdapterCodeHashAllowed(adapter_.codehash, true)` at `:268` — the pin is computed **after** the guard. `requireNoDelegatecall` reverts on a hit (`:54-58`), so a detected `DELEGATECALL` aborts before any allowlist or codehash is written: fails closed. The pinned value is `adapter_.codehash` read from the same freshly deployed contract by the EVM, not an artifact hash, so no stale/artifact codehash can be pinned past the guard. The TS verifier (`verify/index.ts:662`) independently enumerates `AdapterCodeHashAllowedSet` events and checks the on-chain allowlist against the manifest; it does not use this Solidity guard.

Conclusion: remains theoretical. The library is a deploy-time defense-in-depth scan over trusted, locally built bytecode; there is no attacker-controlled or stale-artifact path to `_codeLengthWithoutMetadata` at this pin. This matches the first pass's C5-2 refutation and adds the explicit pin-order, link-time, cached-`out` and codehash-source analysis. Not inflated to a finding.

SEVERITY IF PROMOTED: N/A as a current finding (unreachable). If a future path ever accepts an externally supplied adapter address into `_approveAdapter`, the consequence — approving a delegatecall-proxy adapter whose proxy codehash is pinned while its implementation is hot-swapped, enabling storage collision/NAV manipulation — would be High/Critical.

RECOMMENDATION: Advisory hardening only: (a) add a regression test that a forged trailing 2-byte length cannot hide a `0xF4`, and (b) consider scanning the full runtime and treating the metadata boundary as derived only from a well-formed solc CBOR trailer (or document that the scanner's trust model assumes locally compiled adapters). Do not report as a live finding for 0.9.0.

---

## C3 — RB-1022 release-tooling items at this commit

VERDICT: advisory

EVIDENCE: `docs/audits.md:672-686` (rows RB-1022-1…9, all `Medium`/`Low`, `accepted-with-rationale`); source snapshot `docs/code-review/20261022-code-review-internal-claude-release-branch-model-gaps.md:21-61`; `publish-contracts/src/release-gate.ts:152-153,183-188,247,359-360`; `scripts/ci/check-core-storage-layout.sh:239`; `scripts/ci/check-sha-green.ts:4,6,85,109,117` and `scripts/ci/deploy-gate-jobs.ts:26,32`; `scripts/release/` directory listing (no rc/squash/journal tool); `scripts/runbook/validate-contract-qa.ts:531,555`; `docs/development/ci-suites.md:1443-1445`; `docs/development/fusion-devnet-ci.md:144,205`; `.github/workflows/release-tag-suite-dispatch.yml:54-56`.

ANALYSIS (per row, disposition verified where code/CI permits):

- **RB-1022-1 (Medium)** — *Partially addressed at this pin.* `assertUpgradeBuildGate` now binds the rc tag to a sha **and** branch (`release-gate.ts:359-360`), enforces the rc grammar (`RC_TAG_PATTERN`), canonical remote annotated tag (`:356`), build provenance/clean tree (`:350-352`) and green CI (`:361-365`). The general `tagForKind` (`:183-188`) still binds tag→sha/kind only, and no tool binds the tag to the Twin-QA-passed *tree*. Not a live gap for this release's 8453 upgrade path (the branch binding is present and targets the reviewed branch); the QA-tree binding remains a manual owner convention. No upgrade needed.
- **RB-1022-2 (Medium)** — *Still open as described.* `--counts-require-origin-dev` still checks ancestry only against `refs/remotes/origin/dev` (`release-gate.ts:152-153`); no release-line form exists. Failure mode is a valid release-branch counts commit being **refused** (fail-closed), not an unsafe build passing. Accepted ops convention. No upgrade.
- **RB-1022-3 (Medium)** — *Partially addressed.* `release-tag-suite-dispatch.yml:54-56` now triggers on `["releases-*", "qa/**"]` (issue 1931), but the forge/doc/smoke suites still lack a `qa/**` trigger and `deploy-gate-jobs.ts:26` still models refs as `["dev", "releases-vA.B.C"]` (old naming, no `qa/**`). A squash commit lacking required jobs makes `check-sha-green` report `MISSING` and exit 1 (`check-sha-green.ts:4,109,117`) — fail-closed, not a bypass. No upgrade.
- **RB-1022-4 (Low)** — *Still open.* `check-core-storage-layout.sh:239` still takes `git tag -l 'release/*' | grep -v rehearsal` as `--releases` baselines, so an undeployed rc can become a baseline. Effect is over-strict (refuses layouts an undeployed rc does not extend), not permissive. No upgrade.
- **RB-1022-5 (Medium)** — *Still open.* `scripts/release/` contains dependency-manifest/rmpc-install/preflight tooling only — no rc-cut, squash-check or QA-journal tool. Manual owner step, accepted convention; not a contract defect. No upgrade.
- **RB-1022-6 (Low)** — *Still open.* `validate-contract-qa.ts` still checks step/command/state shape and `templateSha` shape (`:531,555`) without binding a run target to a ref. Gated upstream by finding 1's tag/branch check and by owner-controlled runbook decisions; accepted convention. No upgrade.
- **RB-1022-7 (Low)** — *Confirmed convention.* `docs/development/ci-suites.md:1443-1445`: branch protection is a won't-fix owner decision; tag ruleset is an owner setting. Owner action, not a code gap this review can upgrade from code evidence. No upgrade.
- **RB-1022-8 (Low)** — *Still open.* `scopeProblems` (`:531`) checks scope entries are PRs with a check/reason, not against the deployed-version→rc commit range. Audit-completeness gap, not a security bypass. No upgrade.
- **RB-1022-9 (Low)** — *Still open housekeeping.* `fusion-devnet-ci.md:144,205` still names `releases-0.4.x`; legacy branches remain an owner archive/delete decision. No security impact. No upgrade.

None of the nine is a live security gap for release-0.9.0: each is an accepted operations convention, an owner setting, or a fail-closed tooling strictness gap, and the two security-relevant ones (1 and 3) are partially closed at this pin by the local commits and the issue-1931 trigger change. No row needs promotion from advisory to finding.

SEVERITY IF PROMOTED: N/A — no row qualifies as a finding. Highest residual is RB-1022-1/3 at their recorded Medium/Low as *accepted-with-rationale*; promoting them would conflate policy/tooling completeness with a security defect.

RECOMMENDATION: Report all nine as accepted advisory items, noting RB-1022-1 and RB-1022-3 are partially mitigated at the pin (`release-gate.ts:359-360`; issue-1931 trigger). Leave the canonical ledger dispositions unchanged; do not open or upgrade findings from this task.

---

## Limitations

- Read-only analysis at the pinned commit; no contracts/CI were executed by this worker (no `forge test`/`bun test` run here). Test claims are limited to the executed evidence recorded in the first-pass lane-5 report and to the presence and content of test files at the pin.
- C1 conclusions about on-chain state (that Deploy 4's proxies are at the recorded v0.7/v0.8 builds) rest on the runbook/verifier/manifest design and the first-pass lane-5 verification, not on independent RPC reads by this worker.
- C2 assumes the documented production deploy flow (`DeployVault.s.sol`) is the only way adapters are approved; a private, out-of-repo tool that calls `setAdapterCodeHashAllowed` with an externally chosen codehash was not observable and is out of scope. The basket `TickMath` delegatecall adapters are a documented exception and were not re-audited.
- C3 verification is by static inspection of code/CI/config at the pin plus the review snapshot; live GitHub branch protection, tag rulesets and remote branch/tag existence (RB-1022-7/9) are owner settings not observable from this checkout. `release-0.9.0`'s relationship to `origin` was read from `git log`/`git worktree list`, not from the GitHub API.

## checked_shapes

- `false-positive-guard` (C2): PUSH-immediate `0xF4` and PUSH32 trailer cases are handled and tested (`AdapterDelegatecallGuard.t.sol:108-123`); the *forged metadata-length* shape is untested but unreachable (C2 ANALYSIS).
- `artifact-guard-runs-before-build` / `stale-artifact` (C1/C2): gated builds check clean tree + source↔`out/` provenance after build (`release-gate.ts:350-352`; runbook `P0.91` clean-worktree assertions); guard reads on-chain code, not an artifact.
- `wrong-codehash-source`: codehash pin uses `adapter_.codehash` from freshly deployed on-chain code (`DeployVault.s.sol:268`), after the guard (`:266`), and is re-enumerated by the verifier (`verify/index.ts:662`).
- `library-link-swap`: the three scanned adapters use only inlined `SafeERC20`; no external library link reaches the guard.
- `fail-closed-vs-false-green` (C3): `check-sha-green` marks missing checks red (`check-sha-green.ts:109,117`); RB-1022-2/3/4 failures are refusals, not bypasses.
- `owner-setting-vs-code-gap` (C3 RB-1022-7/9): classified as conventions/owner actions, not code findings.
- `local-commit-scope` (C1): both commits enumerated via `git log origin/release-0.9.0..d4a43e6d2` and read via `git show` in full; no unread hunk in either.
