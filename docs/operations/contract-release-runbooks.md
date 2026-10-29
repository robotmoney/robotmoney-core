# Contract release process — foundational runbook policy

> **Status: in effect.** This document defines the foundational
> release-runbook policy that every per-release contract-deployment runbook
> must follow. It is not itself a runnable checklist; concrete deployments
> are executed from per-release runbooks committed under `docs/runbooks/`
> (see §5). A contract release's runbook is a YAML file under
> [`docs/runbooks/contract-qa/`](../runbooks/contract-qa/README.md). An older
> Markdown example is [`docs/runbooks/v0-1-0-devnet-verification.md`](../runbooks/v0-1-0-devnet-verification.md).
>
> Modeled on the sibling frontend repo's `docs/technical/release-runbooks.md`
> policy (owner decision 2026-10-22): release branches `releases-A.B.x`, QA on a
> `qa/` branch with every patch merged there, a squash of the passed QA branch onto
> the release branch, a release candidate tag at the squash commit, and production
> executed only from that tag. It is written for Solidity contracts rather than a
> mutable Postgres-backed application. "The release" is the stage scripts under
> `contracts/script/` (listed in `scripts/deploy/stage-table.json`), the contracts,
> the `publish-contracts` tool and the release runbook YAML, at one commit of the
> release branch. A release either deploys a NEW set of contracts (the first release of a line) or
> upgrades the live governed proxies of the line through the Safe and the timelock
> (§4.14). There is no in-place upgrade of the existing direct contracts and no
> in-place rollback of any contract: a governed proxy rolls back by another governed
> upgrade (§4.12). The governed upgrade path requires the mode and verification
> gates in [`docs/technical/contract-upgradeability-plan.md`](../technical/contract-upgradeability-plan.md).

This is not the process for landing ordinary feature work — that is PR review
against `dev`, covered by the repo's CI taxonomy. This document is
specifically about the step where a release's scope is carried onto a release
branch, rehearsed on a QA branch, cut as a release candidate and cut over into
a real chain deployment — Robot Money Devnet or Base mainnet.

## 1. Scope and authority

Every deployment of a numbered contract release must be planned, rehearsed,
and executed from a per-release runbook that conforms to this policy. The
per-release runbook is the **definitive, agent-executable procedure** for
that release — not the tracking issue (§6), and not tribal knowledge held by
whoever last ran a deployment. The tracking issue's checklists exist to gate
progress through the runbook, not to duplicate or replace its content.

No deployment may skip a gate described here unless the release tracking
issue explicitly records the exception, the reason for it, and operator
sign-off.

**Owner-gated broadcast.** An agent drives the runbook, and the owner holds the
keys and the go. An agent never broadcasts a transaction to Base mainnet (chain
8453, rehearsal or production kind) without the owner's explicit, recorded go
for that run (the `go` of the step, `docs/runbooks/contract-qa/README.md`).
The Twin chain needs no go. Owners and operators sign Safe transactions with
their own keystores or hardware wallets, and the passphrase is typed by the
owner at the hidden prompt.

## 2. Release identity, branches and target network

Each contract release is identified by a semantic version `vA.B.C`, minted
**only for a change that actually ships** — i.e. a real, addressed deployment
to a real network (Robot Money Devnet or Base mainnet), or a governed upgrade
of one. A rehearsal that does not produce a lasting, addressed deployment
record does not consume a version number.

**Release branches (owner decision 2026-10-22).** Each release line ships from
`releases-A.B.x` (literal `releases`, the integer major and minor, a literal
`x`). Example: `releases-0.5.x`. The scripts under `contracts/script/` read every
deploy-time parameter from environment variables, so one commit deploys to
every target network. The release branch fixes which commit that is, and keeps
the line's tags, QA evidence and patches in one history. Feature PRs never
target a release branch. The first release of a line (`vA.B.0`) cuts
`releases-A.B.x` from `dev` at the tip its scope names. `dev` carries the next
line. A line frozen on chain (`freezeUpgrades`, §4.12) takes only tooling,
runbook and documentation patches, and never a change to `contracts/`.

The release branch takes changes by three routes only:

- **(a) Scope.** Before a QA session starts, the release's scope reaches
  `releases-A.B.x` from `dev` by a pull request whose base is the release
  branch, carrying a merge of, or `git cherry-pick -x` of, the named `dev`
  commits. The release YAML's `scope:` lists every PR the release ships (§5).
- **(b) The passed QA branch.** After the QA runbook passes on the Twin at a
  commit of `qa/A.B.x-<YYYY-MM-DD>`, that branch is **squash-merged** onto
  `releases-A.B.x`. The squash commit's tree must equal the tree QA passed, and
  the release branch must not have moved since the QA branch was cut.
- **(c) The frozen-counts record.** After an rc tag is cut at the squash
  commit and the Twin rehearsal has run there, the data-only pull request that
  adds `deployments/frozen-counts/<sha>.json` and nothing else (§3, §4.3). It
  lands before the next QA session is cut.

No other commit lands on the release branch, and no commit lands on it during a QA
session. Session fixes reach `dev` afterwards by a separate PR from the QA
branch (§7). A release branch is force-pushed only on an explicit owner
instruction, after `archive/releases-A.B.x-<YYYY-MM-DD>` is pushed. Release tags
land on the release branch, never on `dev` or a QA branch.

**QA branches.** A QA session cuts one `qa/A.B.x-<YYYY-MM-DD>` branch from the
release branch tip and pushes it. Every patch of the session, runbook
corrections included, merges there by PR. A pushed QA branch is never
rewritten: no force push, reset or rebase. A new base means a new branch,
`qa/A.B.x-<YYYY-MM-DD>-2`, and the session report names which branch each piece
of evidence ran on. A push to `qa/**` or `releases-*` runs `release-tag-suite-dispatch.yml`, which
dispatches every suite that has a `workflow_dispatch` trigger against the pushed commit
(path filters do not apply to a dispatch), waits for them and ends with `check-sha-green`
on that commit. The commit QA runs carries its own green CI, with no manual dispatch. A QA branch is kept after its squash: the
session report and a release file's `templateSha` name its commits.

**Where QA runs.** QA runs the release's runbook YAML on the Twin chain (918453)
at a clean, pushed QA commit, never a PR head or a fix branch
(`docs/runbooks/contract-qa/README.md`, Targets). The Twin fork, any anvil and any fork of Base
run on the stage host `rm-core-stage-1`, never on the operator machine. The
operator machine holds the keys and drives the run over ssh. A host runs a clean
checkout of a pushed commit (`git status --porcelain` empty), and a fix is
developed in a development worktree, never on a host. The QA runbook, and the
freeze gate's Twin job, `core-stages-twin-upgrade-lifecycle` (§4.1), run at the
QA commit. The Twin proves execution and ordering. It does not prove the 48 hour delay or the mainnet signers.

**Rehearsal kind.** A release of the rehearsal kind (`DEPLOYMENT_KIND=rehearsal`,
§4.10) is deployed to Base 8453 with a 900 s timelock. That deployment is the
release itself, so it runs from the rc tag exactly as a production release does
(§4.14), after the Twin QA passed. A tool-only fix found during such a run is made on a new
QA branch, squashed and tagged as the next rc, and the run continues at that
commit, gated at the sha the deployment started at (`publish-contracts/src/tooling-sha.ts`).

**The squash.** Before squashing, confirm all of the following, and record them
in the QA report: the QA branch's tip is the commit the QA runbook passed; its
tree hash is recorded; `origin/releases-A.B.x` is the commit the QA branch was
cut from; CI is green on the QA tip. After squashing, confirm the squash
commit's tree hash equals the recorded one. A mismatch, or a release branch
that moved, means the QA branch is abandoned and a new one is cut from the new
tip.

**Adopting `releases-0.5.x` as the v0.5 line.** The live Deploy 3 line is the
branch `releases-0.5.x`, whose name already follows this policy. It is adopted
as it stands. Its tip (`077de79c`, 2026-10-19) is the line's baseline. Its rc
tags `release/v0.5.0-rc.1-rehearsal` to `release/v0.5.0-rc.13-rehearsal` and the record tag
`release/v0.5.0-rehearsal` (cut at the `rc.9` commit, `57fbe618`) stay where they are, as
the history of Deploy 3 before this policy. The tip's tree equals `dev`'s tree at the merge of the
runbook pull request (1877, `e362df0c`), which squashed the branch's commits
onto `dev`. From the adoption on, the branch takes changes by routes (a) to (c) only. The
next v0.5 session cuts `qa/0.5.x-<YYYY-MM-DD>` from the tip, and the next rc of
`v0.5.0` is `rc.14`. A `dev` change reaches the line only by route (a), and the
owner names it: everything else on `dev` ships on the next line,
`releases-0.6.x`.

From v0.5.0 (owner decision 2026-10-16) the version tag of a Base mainnet
production deployment is `vA.B.C` with no network suffix. A rehearsal-kind
deployment (§4.10, Deploy 3 included) cuts no version tag: its record is the
`release/<version>-rehearsal` tag and its evidence. Earlier tags keep their old names (`release/v0.4.0-base`).
A Devnet (Twin chain) verification pass is not tagged: its record is the CI
run, the QA journal and the evidence folder.

## 3. Release candidates and version tags

**Tag names.** There are three kinds of tag. Do not confuse them.

| Tag | Name | Cut at | Meaning |
| --- | --- | --- | --- |
| Release candidate (rc) | `release/vA.B.C-rc.N` (production kind) or `release/vA.B.C-rc.N-rehearsal` (rehearsal kind), annotated, `N` from 0 | The squash commit on `releases-A.B.x` | The commit whose tree passed Twin QA. The contracts-freeze gate tag. Production runs only from it (§4.14) |
| Record (rehearsal kind only) | `release/vA.B.C-rehearsal`, annotated | The sha the deployment started at | The deployment's record. Cut once, never moved |
| Version | `vA.B.C`, annotated | The commit of the final rc | What production was proven deployed at. Production kind only |

The kind of an rc tag is its suffix: `-rehearsal` means rehearsal, anything else
means production, and a name that mentions rehearsal anywhere else satisfies
neither (`release-tag.ts`). The release gate needs an annotated tag of the sheet's
kind at the sha a run names, so each run is gated on its rc tag. The rc tag lives in the `release/` namespace on purpose:
`v*.*.*` is also the dApp's release namespace (`release-dapp.yml`, issue 1243), and
pushing `vA.B.C-rc.N` would build and publish the dApp image. Pushing `vA.B.C`
builds the dApp image at that commit, pushes it to GHCR as `vA.B.C` and `:latest`,
and starts the release-tag suite dispatch. One version tag therefore names the
contracts and the dApp of a release. Do not push a contract version tag whose
number a dApp release already used.

A rehearsal that continues at a later tool-only commit
(`publish-contracts/src/tooling-sha.ts`) keeps its record tag where the
deployment started. The rc tags mark every commit a run ran at, and that run is gated at the sha the
deployment started at: the tag, the green CI and the frozen counts of that sha
cover it (owner decision 2026-10-19, `publish-contracts/src/cli.ts`). A production run is always gated at its own sha.

This section covers the rc tag and the version tag. The first bullet is the
contracts-freeze gate that the rc tag satisfies.

- The **release candidate tag** (the rc tag, annotated; its name is in "Tag names" above)
  names the release SHA, the squash commit on the release branch, *before* the
  final Twin rehearsal. It is the contracts-freeze gate: tag the squash commit,
  run the final Twin rehearsal at that SHA, then commit its
  frozen per-stage transaction counts to
  `deployments/frozen-counts/<sha>.json` by §2 route (c). The rehearsal is the `core-stages-twin-chain`
  job of suite 28 (every push to `dev` and `releases-*`, the dispatch of `release-tag-suite-dispatch.yml` on a push to `qa/**`, and the nightly). Download the `rehearsal-counts-<sha>`
  artifact of the release SHA's run, review `counts.json`, and write its `counts` (with `deploySha` and
  the `measured` chain id and time) to that file with
  `bun publish-contracts/scripts/freeze-counts.ts --counts counts.json`. Take the artifact from the
  **push** run of the tagged SHA, the push of the squash commit to `releases-A.B.x`: on a pull request `github.sha` is the merge commit, not the release SHA.
  - **The normal case since Base block 52401633: the run adopted the CREATE2 libraries (issue 1733).** Every Twin fork pinned at or after that block already holds
    TickMath, BasketAssetConfigGuard, TwapTickMath and BasketViews, so the measuring run ADOPTS them (libs 0, proto 7) and its `counts.json` carries `adopted`.
    `freeze-counts.ts --counts` refuses it, and so does every 8453 path. Rebuild the BASELINE for the new sha from that same `counts.json` instead:
    `git checkout <sha>` (the checkout must BE the sha, with `forge`), then
    `bun publish-contracts/scripts/freeze-counts.ts --from-adopted-run counts.json --sha <sha> --rpc <Twin or Base RPC that holds the libraries> [--cross-check deployments/frozen-counts/<earlier sha>.json [--accept-diff stage,stage]]`.
    Review the file, commit it as `deployments/frozen-counts/<sha>.json`. What the verb does and refuses:
    baseline(stage) = measured deployer txs + the adopted creations of that stage (libs 0 + 1, proto 7 + 3 = 10; every other stage as measured). It refuses unless
    (a) every adopted library is re-derived from the build at `<sha>` (CREATE2 address of the artifact, runtime hash) AND its code hash is read from `--rpc`
    (`LIBS_ADOPTION`), (b) each adopted stage adopted EXACTLY the libraries the stage table lists for it (libs: `libraries`; a basket stage: `create2Libraries`), so a baseline can neither be
    inflated nor hide a dropped creation, and the stage's measured count equals the deployer txs the run sent (a partly resumed stage is no clean measurement),
    (c) with `--cross-check`, the baseline equals the earlier release's frozen counts (`COUNT_MISMATCH` names each differing stage; a difference you reviewed on purpose is named in
    `--accept-diff` and then written into the file under `crossCheck`), (d) `counts.json` is for `<sha>`, from a green Twin run, with a nonce that equals the sum of its counts (no stray transaction).
    The file is marked `measured.reconstructed = { fromRun: { sha, chainId, pinBlock }, adopted: [{ stage, library, artifact, address, codeHash }], measuredCounts, crossCheck }`
    and is NOT marked `adopted`. **Safety.** `loadFrozen` verifies the block on every load (sha, Twin source, table bound, `count = measured + adopted` for every stage, no duplicate), so a hand-edited
    count or record is refused. The mainnet plan additionally re-verifies the records against the build and the chain (`cast code` on `--rpc`) before it passes, and refuses a reconstructed file when it cannot.
    The old marker `measured.adopted` is still refused on every chain except for the Twin run's own follow-on verbs. **Composition on 8453.** The baseline is what a fresh chain shows (libs 1, proto 10). A real run
    on 8453 finds the libraries already there, adopts them again, and `effectiveCounts` replaces libs with 0 and proto with 7 (the deployer txs it really sent), so the expected nonce stays
    start + sum(effectiveCounts) + 1 proof. The measured counts of the stages that adopt nothing come from a Twin counts.json that cannot be proven untampered offline, so the **cross-check against the previous release is MANDATORY**:
    when the counts dir holds any earlier frozen file the verb compares with the most recent one (or the file named by `--cross-check`), refuses with `COUNT_MISMATCH` on any stage difference unless `--accept-diff` names the stage, and writes
    `measured.crossChecked = { sha, fileHash }` (sha256 of the earlier file's bytes). There is no flag to skip it. The anchor must be a frozen file of the counts dir, and it must be COMMITTED: `loadFrozen` refuses a baseline whose anchor file is missing ("restore the anchor file") or has other bytes ("restore the committed bytes": `git checkout` it; autocrlf or a reformat trips this), and the 8453 plan and every deploy run also prove the anchor is committed at the checkout's HEAD with the checked bytes (`git show HEAD:<path>`, before any signer exists). The loader does not trust `measured.at`: a reconstructed file with no `crossChecked` is refused whenever ANY other frozen file is in the dir, and its counts must equal the anchor's apart from the differences recorded as accepted. The anchor is loaded with the SAME rules, recursively (cycle-checked, at most 8 links): an anchor that is itself reconstructed needs its own `crossChecked`, its own committed anchor and counts equal to it, so every chain ends at a plain measured file of the dir, and the git proof covers every hop. On 8453 a reconstructed baseline also requires the counts dir to be a clean dir of a git checkout whose HEAD is the release sha or a descendant of it (the same repository history), tracking every `<sha>.json` in the dir with the same bytes at HEAD, and every `<sha>.json` tracked there to exist in the dir (issue 1740; see **Release layout of a reconstructed baseline** below). When `git` cannot run the refusal says "git could not run". One malformed `<sha>.json` in the dir blocks the load of every reconstructed baseline (fails closed). `cast code` is retried 3 times with backoff and then fails with a `CHAIN` error naming the RPC origin. **Limit, stated plainly:** the hashes and the anchor do not defend against an attacker who forges a chain of two consistent files, because that attacker controls both. The protection against that is code review of the committed counts files (the reviewer reads every stage count and the `crossChecked` record), not this tool. `loadFrozen` refuses a reconstructed file that lacks the record while an earlier frozen file exists, or whose anchor file changed since.
    **Plan before publish.** Run `--stage plan` first as always. The chain re-verification of the reconstructed block is not left to that order: a run on 8453 that sends deployer transactions re-verifies the block against the build and the chain itself, before any signer exists (`LIBS_ADOPTION` on a difference).
    The `core-stages-twin-chain` job runs this verb itself on every run (and loads the result strictly), so a broken reconstruction fails CI before a release.
  CI never commits it. The mainnet plan job refuses any
  `DEPLOY_SHA` that is not an annotated-release-tagged SHA (`RELEASE_SHA_UNTAGGED`), whose tag object differs from, or is missing on, `robotmoney/robotmoney-core`, whose tag the repository peels to another commit, or whose remote is unreachable (`RELEASE_TAG_REMOTE_MISMATCH`, exit 23; push the tag before planning; the checkout's `origin` must name that repository, and the tag is read from its https URL in an empty directory outside the checkout, with replace refs off and no `GIT_*` variable, so no `refs/replace` ref or repo-local config can answer), has no committed
  frozen counts (`COUNTS_MISSING`), whose counts file is untracked, staged, modified or ignored in its git work tree (`COUNTS_UNTRACKED`, exit 31; a reconstructed baseline gets the stricter whole-dir proof instead, see **Release layout of a reconstructed baseline**) or is not green in `check-sha-green` (`CI_NOT_GREEN`; the check always names `robotmoney/robotmoney-core`, never the caller's `GITHUB_REPOSITORY`).
  The same gate runs before any signer exists and before forge on every other broadcasting 8453 run (issue 1816): `publish`, the default stage set, `--stage deploy` or `all`, any stage list naming a deployer stage, `safe`, `prove-control` or `govern`, the `govern` verb (every row, stage 13 and on demand) and the `redeploy-vault` verb. The redeploy verb and the `govern --row redeploy-vault` run at its round's SHA skip only the counts step (they have no frozen file of their own). A verify-only run, `pause-all`, `record-receipt` and a `--dry-run` of the stages are exempt. Hardware signing (`ledger`, `trezor`) is optional for a Safe owner signer, never required (owner decision 2026-10-14): a software keystore (`keystore:PATH`, passphrase typed at the hidden prompt) stays valid on 8453, while plaintext keys and passphrase files are refused. A device is bound to its owner as `ledger:PATH@0xOWNER` / `trezor:PATH@0xOWNER`. A publish with fewer `--owner-signer` specs than sheet owners is refused before stage 1 (`CONTROL_NOT_PROVEN`), never after stages 1–10 have broadcast.
  Any later commit that changes `contracts/` has a new SHA with no tag and no
  counts, so it needs a new QA branch, a squash, a new rc tag and a new rehearsal. This flow is enforced by the plan job (core #1524) and by every broadcasting 8453 run (QA plan v1 E4).
  - **Green rehearsal only.** The artifact uploads even when the rehearsal failed. The job therefore records its
    own conclusion in `counts.json` (`rehearsal.conclusion`), and `freeze-counts.ts` refuses any file whose
    conclusion is not `success` (core #1602). `core-stages-twin-chain` is deliberately not in
    `scripts/ci/required-checks.json`: it reads a public upstream that can rate limit, and a required entry would
    block every DEPLOY_SHA on a provider outage. It is gated indirectly: freezing needs a green run, and `check-sha-green` still gates the plan.
    `core-stages-twin-upgrade-lifecycle` reads the same upstream, yet it IS in the required list and gates every DEPLOY_SHA
    directly through `check-sha-green` (issue 1846). Every core stage deploys a governed proxy and the freeze is irreversible,
    so the Twin rehearsal of the upgrade and the freeze is never skipped. On an upstream outage, re-run the failed job:
    `check-sha-green` lists check-runs with `filter=latest` (the GitHub API default, pinned explicitly), so a successful re-run supersedes the failed attempt.
    **Prolonged upstream outage.** When re-runs keep failing because the provider stays down, point the `BASE_UPSTREAM_RPC`
    secret at another provider and re-run the failed job. If the re-run logs `WARN: STALE PIN` (the new provider no longer serves the
    run's pinned block), use **Re-run all jobs** so the pin job picks a fresh block. `scripts/devnet/README-twin-fork.md` says the same.
  - **Required list source.** `check-sha-green` runs from the tagged SHA's own checkout, so it reads that SHA's
    `scripts/ci/required-checks.json`. Review that file's diff since the last release before tagging.
  - **Later 8453 stages (QA plan v1 E4, issue 1816; replaces the core #1602 default).** Every broadcasting 8453 run
    re-runs the whole gate: tag, remote tag, committed counts and green CI. The core #1602 default trusted the devops
    workflow to run the plan job first, and a run without it reached forge at an untagged SHA. The re-check reads the CI
    conclusions already recorded at the tagged SHA, so stage 13 after the 48-hour delay needs the GitHub API and a token,
    not a new CI run. A GitHub outage therefore holds a later stage until it ends. Pass the same `--counts-dir` (and
    `--counts-require-origin-dev`) to every 8453 run, not only to the plan.
  - **Remote tag check (core #1602).** The gate (the plan and every broadcasting 8453 run) compares the local `release/<version>` tag with `origin` of the core
    checkout (`git ls-remote`): the remote must hold the same tag object. Push the tag before planning.
  - **Optional hardening (owner action, defense in depth).** A GitHub tag ruleset stops a pusher from creating or moving a
    release tag at all. Settings: target `Tags`, pattern `release/*`, enforcement `Active`, rules `Restrict creations`,
    `Restrict updates` and `Restrict deletions`, bypass list only the release owners. The gate does not depend on it.
- The **version tag** (`vA.B.C`) is the post-deploy record
  described in the rest of this section.

A version tag is **never** cut before **both** a completed preflight and a
completed postflight on the target network. The version tag records what has
been *proven deployed*, not what is *intended for deployment*. Everything
before that point is a release candidate, referenced by its rc tag and commit SHA, not a version tag.

The cycle (owner decision 2026-10-22):

1. **Scope reaches the release branch** by §2 route (a). The counts record of the previous rc (route (c)) is on it.
2. **Cut `qa/A.B.x-<YYYY-MM-DD>`** from the release branch tip and push it (§2).
3. **QA runs on the Twin** at a clean, pushed QA commit (§4.1 to §4.4). **A QA failure** consumes no rc number: the fix merges into the QA branch by PR and QA reruns on its new tip. The storage layout of a proxied contract stays append-only against the deployed baseline (§4.12 step 1) at every QA commit.
4. **The QA runbook passes.** Record the commit and its tree hash.
5. **Squash the QA branch onto the release branch** (§2 route (b)). The release branch must not have moved since the QA branch was cut, and the squash tree must equal the passed tree.
6. **Cut the rc tag** at the squash commit and push it. Run the Twin rehearsal at that SHA, rebuild the frozen counts, and land them by §2 route (c) (the freeze gate above).
7. **Production runs only from that rc tag** (§4.14), with the owner's recorded go, a new deployment or a governed upgrade. A failure before the first irreversible broadcast of the run means the rc never
   reaches production: fix it on a new QA branch, run QA again, squash again, cut `vA.B.C-rc.(N+1)`. A failure after a broadcast is handled by §4.5 and §4.6, and the next attempt is also `rc.(N+1)`.
8. **A clean postflight** → tag `vA.B.C` at the exact commit that was
   deployed and verified, the final rc's commit.

Two consequences, stated outright because each one looks unusual and neither
is a mistake:

- **The version tag can never be cut at a commit that was not actually
  deployed and verified.** A fix that lands after the deployment requires a
  new deployment or a new governed upgrade from a new rc, and a version tag only after
  that one is verified. It cannot be "rolled into" a tag for a commit that was never broadcast.
- **`vA.B.C` and the final `vA.B.C-rc.N` point at the same commit.** An rc number counts
  production attempts stopped before a clean postflight. Five Twin QA attempts and a clean first
  production attempt is `rc.0`. A version tag may exist on multiple networks at different times, each
  its own deploy record under `deployments/<network>.json` (§8's naming) —
  this is expected, not duplication. Twin QA and production run different commits with the
  same tree (the QA tip and the squash commit): the tree hash ties them together.

## 4. Foundational release workflow

Every per-release runbook must implement the following workflow, in order.
Each gate is blocking: the runbook must stop and escalate if a gate fails,
and no later gate may be started until the current one is satisfied or
explicitly waived by the operator with a written reason.

### 4.1. Code-readiness gate

Before any deployment activity, verify all of the following:

1. The release tracking issue is closed/complete — every linked task is
   closed, and the release's objective is clearly stated (§6).
2. `forge build` succeeds against the commit SHA being deployed, with no
   uncommitted local changes (`git status --short` is clean at that SHA).
3. **External security review before a final mainnet release.** A final Base
   mainnet release (chain 8453, `DEPLOYMENT_KIND` production, not a contained
   test) requires a completed external security review of the exact contracts
   at the release SHA, including the governed proxy form (`GovernedUUPS`, the
   `GovernedUpgrade` library, the per-instance `ERC1967Proxy` deployment and
   `freezeUpgrades`) and every contract `docs/audits.md` marks as needing an
   external audit before the final deployment. The report is recorded in
   `docs/audits.md`, every High and Medium finding is fixed or carries an owner
   decision, and the tracking issue links it. Freeze removes recovery by
   upgrade, so this gate is never waived for a final release. A Base mainnet
   rehearsal or contained test does not need it.
4. **Twin rehearsal of the governed proxy lifecycle.** The CI job
   `core-stages-twin-upgrade-lifecycle` gates every `DEPLOY_SHA` (it is in
   `scripts/ci/required-checks.json`, section 3), because every core stage
   deploys a governed proxy. It is green at the release SHA: it deploys the exact release artifacts upgradeable,
   upgrades through the real Safe and timelock, freezes, and shows a queued
   upgrade is refused after the freeze, with the evidence check passing (4.12).

Do not begin preflight, rehearsal, or any other deployment step while any
item above that applies to this deployment is incomplete.

Every commit expected to ship is on `releases-A.B.x` by §2 route (a) before
the QA session starts. Every deployment step runs at an rc tag of that branch
(§4.14), never at a `dev` commit, a QA branch commit or a pull request head.

### 4.2. Preflight

Before any transaction is broadcast:

1. **Guard scripts.** Run `scripts/release/preflight-guards.sh`
   (network-agnostic — it checks the exact `forge
   build` artifacts, not a specific chain): the EIP-170 size gate on every
   contract in the ceremony's runtime set, and the env-default guard against
   an unsafe zero timelock delay (`TIMELOCK_MIN_DELAY`). `RouterGovernance` has
   no delay or quorum of its own (issue 1698).
   For a release deploy add `--dependency-manifest CHAIN_ID:RELEASE` (with
   `DEPENDENCY_MANIFEST_RPC_URL` in the environment): it records every
   third-party address, its code hash, its proxy implementation and the block
   into `deployments/dependency-manifests/<chain id>/<release>.json`. Commit that
   file with the release deployment record (hook: `scripts/release/record-release-dependencies.ts`; see `deployments/dependency-manifests/README.md`). The nightly third-party drift
   workflow (disabled by default) compares live state to the latest such file.
2. **Role and address validation.** Every deploy script's own `_validate` step enforces distinct non-zero role
   addresses, a canonical asset address with deployed bytecode, and a real
   timelock/Safe destination for the eventual role handover.
3. **Funding.** The deployer EOA holds enough native gas token and enough of
   the seed asset (`SEED_DEPOSIT_USDC` on the frozen sheet, required, no default; 1 USDC is the
   planned value) for the
   mandatory seed deposit.
4. **Network identity.** Confirm the RPC's reported chain id matches the
   target network's expected chain id before broadcasting anything. Every
   deploy script in this repo that broadcasts checks this itself and refuses
   to proceed on a mismatch — each script's own chain-id assertion is the
   pattern every network's runbook should follow.

5. **Explorer-database migrations.** Check whether the release ships an
   `services/explorer-indexer/migrations/` file that cannot backfill — i.e. one
   that changes a primary key or adds a `NOT NULL` column with no derivable
   value. Migration `0016_consensus_receipts_contract_scope.sql` is the first,
   and it deliberately **raises an exception** rather than guessing. Such a
   release requires the rebuild/reindex procedure in
   `docs/operations/explorer-db-rebuild.md`, run inside the cutover window
   (between the deploy and the manual QA pass), with:
   - the pre-drop dump and row counts captured as release evidence (§2 there),
   - the watchdog cold-start baseline `MIN(indexer_runs.started_at)` recorded
     and its post-rebuild disposition decided **in advance** (§3 there) —
     wiping it silently moves the baseline and the watchdog pages on the gap,
   - the §6 verification output recorded before the watchdog is restarted.

   Sequence this with any contract redeploy in the same ceremony so the
   database is rebuilt **once**. Note that `docker compose down -v` is not the
   sanctioned way to get a clean database — it also destroys `indexer_runs`.

The preflight gate passes only when every check above passes with no
failures and no silently-skipped check.

### 4.3. Cutover — the deploy ceremony

One driver runs the ceremony: the `publish-contracts` Bun CLI in this repo
(`publish-contracts/`). It reads `scripts/deploy/stage-table.json` and runs
the same scripts in the same order on every chain. Stage, rehearsal and
production differ only by parameters (the frozen sheet and the CLI
arguments), never by source. Core never depends on the devops repo. Devops
owns operations only: the credential engine, fusion-qa product acceptance
and the mainnet canary, stage hosts, the operator runbook
(`docs/runbooks/publish-contracts.md` in devops), and the mainnet workflows
that check out core. `--dry-run` is the preflight: it simulates every
deployer stage on a local anvil and broadcasts nothing. A Twin-chain
rehearsal of publish, verify and govern runs on every push to `dev`, a release branch and a QA branch
(`core-stages-twin-chain` in `.github/workflows/suite-28-core-stages.yml`, core #1523).

> **System split (owner decision, 2026-10-19).** The vaults system and the
> rmpc gateway system are separate systems (`docs/architecture.md` §1).
> The target text of this runbook describes the vaults release. The stage
> table below is a separate thing: it is today's `scripts/deploy/stage-table.json`,
> labeled "Deployed release (v0.5.0)". Operators run it as written. The
> target delta list after the table names what the vaults run changes. The
> system split review records the differences
> (`docs/code-review/20261019-vaults-gateway-split/20261019-code-review-internal-claude-opus-5-5-system-split.md`).

**Deployed release (v0.5.0): the stage sequence.** The stage table holds the forge stages 1 to 11; the CLI
adds `safe`, `prove-control` (between stages 10 and 11), `verify` and `govern`:

| Stage | What it does |
| --- | --- |
| 0 `safe` | Create a canonical SafeL2 1.4.1 through the canonical factory from the sheet's owners and threshold (threshold ≥ 2), then read it back. |
| 1 `libs` | Deploy TickMath through the CREATE2 factory (`0x4e59b44847b379578588920cA78FbF26c0B4956C`, salt 0), so its address is fixed by the build: on Base `0x3353854084194AE5Cc1697a9E4337806ECcdD9F6` (block 52401633). The basket stages link it. **If the library is already on chain** (every Twin fork pinned at or after that block; 8453 after a `--resume` where it landed) forge plans zero transactions and the CLI ADOPTS the stage instead of failing: it checks the address is the build's CREATE2 address and that keccak256 of the runtime code there equals the build artifact's, records `adopted: true` with the address and code hash on the `libs` record, and does not demand the frozen count of 1. Other code at the address, no code, an address the build does not predict, or a deployer nonce that moved by anything but 0 or the whole libs count stops with `LIBS_ADOPTION` (exit 27) or `NONCE`, nothing sent. **Resume after libs landed: rerun the same command with `--resume`. Never mark libs done by hand.** The deployer nonce then counts the transactions this deployer actually sent for libs (0 on a Twin fork, the frozen count when its own transaction landed): final nonce = frozen counts - libs count (when 0 was sent) + 1 prove-control. In the evidence file give the libs stage `adopted: { deployer_txs, libraries: [{ name, address, code_hash }] }` and `receipt_count` equal to `deployer_txs`; `evidence-check --rpc` re-reads the code hash. The libs stage deploys exactly ONE library, `tick_math`. BasketAssetConfigGuard (`0xB026a232f54d381A47a9E2640d04084830F0Ae58`), TwapTickMath (`0x7fDc1E387486C81F97A2379CE897b202d4E815E2`) and BasketViews (`0xE0a16a5B9a4EDd2E0723B74F593C1053F8cBe6BA`) are created by forge as the first transactions of the `proto` stage (`create2Libraries` in `stage-table.json`). Probed with forge and anvil: when they already exist the `proto` simulation exits 0 with `SIMULATION COMPLETE` and 7 transactions instead of 10 (no revert). The CLI then ADOPTS those libraries in the `proto` stage on the same rule as `libs` (address = CREATE2 of the build with BasketViews' link to TwapTickMath resolved, keccak256 of the runtime code equal), requires the shortfall to equal exactly the number adopted (else `COUNT_MISMATCH`), and records them with `deployerTxs` 7. The deployer nonce is then the frozen counts less the libs count less 3 plus the proof transaction. A `proto` that plans fewer transactions for any other reason still fails. **Details.** `agent` and `rwa` list the same three `create2Libraries` (`stage-table.json`, per stage); they normally find them made by `proto` earlier in the run (recorded in the stage's `created`) and adopt nothing. BasketViews links TwapTickMath: the CLI fills the link before it derives the CREATE2 address and hashes the code, and all three addresses depend on the TickMath address because the basket stages compile with `--libraries TickMath:<address>`. Each adopted stage records `adoption.deployerTxs`: exactly what the simulation planned, or on `--resume` between the frozen count less the adopted libraries and the frozen count; the later stages' nonce checks use it. **A run where libraries exist can CONSUME frozen counts but never PRODUCE them**: a measuring run that adopts writes a counts file marked `measured.adopted`; it is read back only by the follow-on verbs of the same Twin run (chain 918453 only), and `freeze-counts`, `loadFrozen`, the release gate and `counts-drift` refuse it. The Twin CI job `core-stages-twin-chain` runs the `twin-publish` action with `predeploy-libs: true`: `src/ci/predeploy-libs.ts` builds the four libraries as the stages do and deploys any that are missing through the real factory on the fork; it refuses Base mainnet and any node that is not an anvil fork. The offline `evidence-check` caps an adopted stage's library list by the stage table and refuses a repeat. A run where TickMath already exists can consume frozen counts (frozen `libs: 1` against 0 deployer transactions works) but can never produce a libs count: its raw counts file is marked `measured.adopted` and every freeze path refuses it. `evidence-check --rpc` compares the chain code hash with the hash recorded in the evidence itself, so only the runner should author that entry. A Twin rehearsal that adopted libs is never frozen as a measurement (`freeze-counts --counts` refuses it): rebuild its baseline with `freeze-counts --from-adopted-run` (section 3, issue 1733), or freeze from a fork pinned before block 52401633. |
| 1b `recorder` | v0.5.0 line only: the v0.6.0 line has no `recorder` stage (ADR-0017). Deploy `UniswapV4PriceRecorder` for the V4 pool key of the `shortlist` entry in `config/agent-token-shortlist.json` (BNKR while RM is parked, ADR-0016), grow its ring to 7,201 slots in chunks of 250 and record the first snapshot. 7,201 slots hold the 4 hour USDC sell anchor at one record per 2 s block, so no spammer can evict it (core 1793, `docs/technical/recorder-manipulation-1793.md`). No role is involved: anyone could send every one of these transactions, and the deployer holds nothing on it afterwards. It runs right after `libs` so the 30 minute price history accumulates while the other stages run. It keeps the stage numbers around it (it is stage 1b, not a renumbering). The manifest `recorder.json` names the recorder. |
| 2 `vault` | rmUSDC and its lending adapters. Seed 1 USDC to `SEED_SHARE_RECEIVER`; the deployer holds no shares. |
| 3 `registry` | Register rmUSDC. |
| 4 `router` | Portfolio Router, `registry.setRouter`. |
| 5 `gateway` | Deposit-only gateway (binds no vault and no router, core 1895), with the pauser and the share receiver from the sheet. No agent is authorized: the stage reads no `AGENT_*` input and the sheet refuses them. Depositors authorize their own agents through `commitAuthorization` and `revealAuthorization`. |
| 6 `ic-policy` | `InvestmentCommitteePolicy` and the `ConsensusRecommendationReceipt` register, bound to the gateway (`GATEWAY_ADDRESS`, `RECEIPT_ADMIN_ADDRESS`). Manifest `ic-policy.json` (`policy`, `consensus_receipt`). |
| 7 `governance` | RouterGovernance from the sheet (`ROUTER_ADDRESS`, `CONSENSUS_RECEIPT_ADDRESS` read from `ic-policy.json`). It runs after ic-policy because the receipt register must exist. The stage grants it router `ADMIN_ROLE`, router `WEIGHT_SETTER_ROLE` and the receipt register's `ADMIN_ROLE`. |
| 8 `proto` | rmPROTO, paused, wETH and cbBTC, registered. |
| 9 `agent` | v0.5.0 line only: the v0.6.0 line has no `agent` stage and no rmAGENT, which is retired and withdraw-only ([ADR-0017](../adr/ADR-0017-rmagent-retired-router-uses-three-vaults.md), section 4.14). On the v0.5.0 line: rmAGENT, paused, holding BNKR as a TEST asset (owner, 2026-10-22, [ADR-0016, superseded by ADR-0017](../adr/ADR-0016-bnkr-is-the-rmagent-test-asset-on-uniswap-v4-while-rm-is-parked.md)): BNKR (BankrCoin, `0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b`) on the hookless Uniswap V4 BNKR/USDC 0.30% pool (id `0x87a44b2f...0f52`, tickSpacing 60), about 706 USD of virtual depth, L 3.9e16 (39 times the 1e15 floor, which is not lowered). The largest safe deposit is 5 USDC. This is contained test scope only (1 USDC seed, caps of 5 USDC per deposit and 20 USDC TVL, pause available, no announcement), not a production sizing. RM is parked (owner, 2026-10-21, [ADR-0015](../adr/ADR-0015-rm-parked-from-rmagent-until-market-depth.md), `docs/code-review/20261021-code-review-internal-claude-rm-parked-from-rmagent.md`). The recorder gate, the live pool checks and the verifier read the listed V4 entry. When RM is listed: RM (`0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3`) on the Uniswap V4 RM/USDC 2.91% pool (owner, 2026-10-08; supersedes the 2026-10-06 V3 decision), registered with venue V4, the price recorder from stage 1b as its pool and `UniswapV4SwapAdapter` as its adapter (the script allowlists the adapter codehash and applies `maxSlippageBps` 500 from the config, because the pool fee alone is 291 bps). RM is in `config/agent-token-shortlist.json` with its full PoolKey (core 1676, venue `UniswapV4`, fee 29100, tickSpacing 582, hooks 0x0, pool id `0xf2e7b957...2391`). **The runner refuses this stage until the recorder holds a full 1800 s window of history** (`RECORDER_HISTORY`, exit 26): it warps the Twin chain and the dry-run chain, and polls on 8453. The live config check (`config-check-live-base`) resolves the PoolKey through StateView and fails while the pool's liquidity L (a raw uint128, not USDC) is below the floor of 1e6: nothing bypasses it, and no one funds the pool (owner decision 2026-10-09). `BasketVault.addAsset` then needs the recorder's ring at 901 slots and 1800 s of history. The Twin forks the live pool and never funds it. **Containment for the mainnet test (a test, not the final deployment):** 1 USDC seed, low `tvlCap` and `perDepositCap` set in the 8453 frozen sheet (check them before the run) and sized below the pool depth (at the 2026-10-08 depth a single swap above about 18 USDC would fail the 5 percent slippage bound), nonzero NAV deviation guard, pause available, no announcement until the governance checks pass. |
| 10 `rwa` | rmRWA, paused, a plain basket row: deSPXA on its Uniswap V3 fee 500 pool, no oracle. |
| — `prove-control` | Before stage 11 the real Safe signs and executes one proof transaction: a call from the Safe to itself with value 0 and empty data. EVERY owner signs it, not only a threshold, so one run proves every key (plan decision 21, core #1618). The Safe tool checks each owner signature, and the Safe itself checks all of them, before it executes. The run manifest records the transaction hash and the signers. The deployer submits the transaction and pays its gas (the only funded key; the owners only sign), so the deployer nonce at and after stage 11 is the summed frozen counts plus one, and `--resume` adoption accepts a landed proof whoever sent it. The proof goes straight through the Safe, never through the timelock, so the 8453 evidence check (unpause operations only) is unaffected. A signer missing for any owner stops the step with `CONTROL_NOT_PROVEN` (exit 24) before anything is sent, and on 8453 the count is checked before stage 1 too: fewer `--owner-signer` specs than sheet owners refuse the publish before any stage broadcasts. Owners sign with encrypted keystores (`--owner-signer keystore:PATH`, passphrase typed at the hidden prompt) or, at each owner's choice, a hardware wallet: hardware is optional, never required (owner decision 2026-10-14). Owners on several hardware wallets of one type are named one per `--owner-signer ledger:PATH@0xOWNER` (or `trezor:`): the tool asks for each device in turn, refuses with `HARDWARE_ADDRESS_MISMATCH` when the attached device is not the named owner, refuses two specs that resolve to one address, and asks for the device again and re-checks it before each signature. **If the run died after the proof landed** (the Safe is at nonce 1 and the run manifest has no `prove-control` record), rerun the same command with `--resume`: the tool reads the Safe's own `ExecutionSuccess`/`ExecutionFailure` events from the safe stage block, adopts the nonce-0 execution only when it is the exact self-call (value 0, empty data, a plain call to the Safe, chain and Safe bound by the Safe transaction hash) whose calldata signatures recover to exactly the current owners (every owner, no stranger, no repeat), records it with `adopted: true` and the on-chain hash, sends nothing, and goes on to stage 11. Anything else (a failed or reverted execution, another target, value or data, a missing owner, a nonce of 2 or more, two executions, no event) stops with `CONTROL_NOT_PROVEN` and the reason. Without `--resume` it never adopts. Log reads walk the range in 2000-block windows (Base RPC providers cap one `eth_getLogs` call) from the safe stage block and stop at the first window that holds an event. A throttled call (HTTP 429) is retried with a bounded backoff (`--logs-tries`, default 6), a range-limit error halves the window (`--logs-window` sets the start), and `--logs-rpc URL` sends `eth_getLogs` alone to another RPC (the rest stays on `--rpc`). Any other failure is `RPC_REFUSED` (exit 30) naming the RPC host, the method and the block range or transaction, never an empty answer or "not found" (issue 1724). |
| — config | Before stage 11 the deployer sets the deploy-time configuration: setters, router eligibility, and router default weights rmUSDC 9500, rmPROTO 500, rmAGENT 0, rmRWA 0 bps (v0.5.0; the v0.6.0 vector is rmUSDC 9500, rmPROTO 500, rmRWA 0, ADR-0017). Stages 4 to 10 set it (core #1520), govern never touches it, and the stage 12 verifier reads it back. RouterGovernance has no voting (core 1698). |
| 11 `timelock` | Refuses with `CONTROL_NOT_PROVEN` (exit 24) unless the run manifest holds the `prove-control` record on the same Safe signed by every owner and the Safe nonce is 1 or more (stage 0 asserts nonce 0). TimelockController: proposer and canceller the Safe, executor open `address(0)` (core #1521: `DeployTimelock` grants `EXECUTOR_ROLE` to `address(0)` only, and the verifier checks it), delay from the sheet with a 172800 s floor on 8453. Every role on every vault, the gateway, the IC policy, registry, router, governance and receipt goes to the timelock (vault EMERGENCY_ROLE to the emergency key), and the deployer is revoked. The stage reads `GATEWAY_ADDRESS`, `IC_POLICY_ADDRESS`, `CONSENSUS_RECEIPT_ADDRESS` and `RECEIPT_ADMIN_ADDRESS` from the manifests. The CLI sets `AGENT_ADDRESSES=none`. |
| 12 `verify` | One verifier reads the chain and checks every postcondition, including the Safe owners and threshold, the proof transaction read back from the chain (a self-call of the Safe, signed by every owner, Safe nonce 1 or more), the delay floor, that the deployer holds no role, that the gateway has no `AgentAuthorized` or `AgentOwnershipTransferred` log up to the handover block and nobody holds `AGENT_ROLE` from an earlier grant (the deploy authorizes no agent), and the deployer nonce against the frozen per-stage counts for the release SHA (committed as `deployments/frozen-counts/<sha>.json`, section 3, core #1524). |
| 13 `govern` | Only `unpauseDeposits()` on each of the four vaults of the v0.5.0 line (rmUSDC, rmPROTO, rmAGENT, rmRWA; three from v0.6.0, ADR-0017), all deployed paused. Each is its own timelock operation, scheduled the same day through the real Safe and executed after one 48-hour delay. None is skipped on any deploy. On 8453 the CLI exits `GOVERN_PENDING` with the resume command; on the Twin chain the wait runs by time warp. The rows come from the stage table's vault rules (`unpauseRow`, `unpauseInStage13`, issue 1705). |

**Target: the vaults release run (owner decisions 2026-10-19 and 2026-10-20).** What changes against the deployed table above:

- No `gateway` stage. The stage table (`scripts/deploy/stage-table.json`) declares two systems. The default run, `--system vaults`, runs the vaults stages only and needs no gateway, no gateway sheet name and no `AGENT_*` input. The gateway stages (`gateway`, `gateway-handover`) are the gateway system's own release run, section 4.13.
- No `ic-policy` stage. A `receipt` stage deploys the `ConsensusRecommendationReceipt` proxy on its own (manifest `receipt.json`: `consensus_receipt`, `consensus_receipt_implementation`, `receipt_admin`). It binds nothing to a gateway and grants no gateway role.
- The `receipt` stage runs BEFORE `governance`. The governance stage reads `CONSENSUS_RECEIPT_ADDRESS` from `receipt.json`.
- No `AGENT_*` input anywhere. The timelock stage reads no `AGENT_ADDRESSES`, no `GATEWAY_ADDRESS` and no `IC_POLICY_ADDRESS`.
- The vaults verifier checks no `AgentAuthorized` log and names no gateway contract. That check moves to the gateway release (section 4.13). `AgentOwnershipTransferred` no longer exists: the gateway verifier does not scan it, and a combined historical manifest (`deployments/8453/deploy-2`) keeps its own reading of it.

- Three vaults, not four (ADR-0017, core 1912). The vaults release has no `recorder` stage (1b) and no `agent` stage (9). The stage table describes rmUSDC, rmPROTO and rmRWA, the router default vector is rmUSDC 9500, rmPROTO 500, rmRWA 0 bps, the sheet carries `ELIGIBLE_VAULTS=PROTO,RWA`, and no `VAULT_AGENT_*` line or recorder input exists. Initial state: all three vaults deploy paused, and stage 13 unpauses all three through the Safe and the timelock (`scripts/deploy/stage-table.json` `vaults[].deployPaused` and `unpauseInStage13`, issue 1705). The `VAULT_AGENT_MIN_POOL_LIQUIDITY` floor of 1e15 is not lowered. The live v0.5.0 rmAGENT is retired by the governed batch of section 4.14.

**Run order: publish, verify, govern, verify (issue 1667).** The stage numbers are fixed (12 `verify`, 13 `govern`), the run order on 8453 is not
verify once. Verify runs twice, and each run checks a different state, which the CLI reads from the run manifest and confirms against the chain:

1. `publish` (stages 0 to 11).
2. `verify`: the **pre-govern** state. No unpause row is scheduled. All three vaults (rmUSDC, rmPROTO and rmRWA) must read `depositsPaused` true: every vault deploys paused, rmUSDC right after its seed deposit.
3. `govern`: schedules the three unpauses (rmUSDC, rmPROTO, rmRWA) through the real Safe in one sitting and exits `GOVERN_PENDING` (15). After the 48-hour delay the same
   command executes them. In the same sitting schedule one `govern --row set-unwind-guard` round per basket (QA plan v1 D7, §4.9), and execute them after the same delay.
4. `verify`: the **post-govern** state. All three unpause rows are executed and all three vaults must read `depositsPaused` false. Every active asset of the three open baskets must read a non-zero emergency unwind `minUsdcOut` (`vault[...]: emergencyUnwindGuard minUsdcOut above zero on every active asset of an open vault`).

A manifest that says one state while the chain reads the other fails verify (exit 13), and a failed verify runs `pause-all` (§4.6). A verify run while
govern is **part-way** (some but not all of the three unpause rows scheduled or executed) is not a failed
verify: it exits 15 (`GOVERN_PENDING`), names the govern command that finishes the work, checks nothing and pauses nothing. Run that command, then verify.
The Twin chain rehearsal runs the same order (`twin-publish.ts`, `twin_publish.rs`). It only checks that the scripts execute in this order: the 48-hour
delay and the Safe signers are proven on 8453 through the real Safe.

**Mainnet test run-day steps (issue 1695).** The run checks core out at the release tag commit (`9a768bb9`, `release/v0.4.0-base`) and passes `--counts-dir` pointing at a dev checkout (`0d40e671` or later) `deployments/frozen-counts`.

**Release layout of a reconstructed baseline (issue 1740).** The baseline file is named by the release sha X (`deployments/frozen-counts/<X>.json`), so it can never be inside the checkout at X: it holds X, and X is the hash of the tree that would hold it. Putting it untracked in the checkout at X makes the tree dirty and the run refuses (`USAGE`, "uncommitted changes"). The steps:
1. Tag X, the squash commit (the rc tag, annotated, pushed, §3). Run the Twin rehearsal at X and rebuild the baseline with `freeze-counts.ts --from-adopted-run` in a checkout of the release branch (any commit at or after X).
2. Merge the file into `releases-A.B.x` as a data-only change (`deployments/frozen-counts/<X>.json` only, §2 route (c)) after the tag. Call the merged commit Y. `git pull` the release-branch checkout to Y or later. It must be clean. The rc tag stays at X, and so does the version tag.
3. Check core out at X for the code (`--core-dir`, clean, HEAD equals the tag target). Keep the release-branch checkout at Y or later for the counts (`--counts-dir <release-branch checkout>/deployments/frozen-counts`). They are two checkouts of the same repository.
4. The plan and every broadcasting run on 8453 (issue 1816: deploy stages, `prove-control`, `govern`) refuse (`COUNTS_MISSING`, before any signer) a RECONSTRUCTED baseline unless, in the COUNTS checkout: it is a git work tree; its HEAD is X or a descendant of X (a shallow clone without X, an older commit or another repository is refused); every `<sha>.json` in the dir (the baseline, every anchor) is tracked at HEAD with identical bytes; every `<sha>.json` tracked at HEAD is in the dir; and nothing under the dir is modified or untracked. The anchor proof (`git show HEAD:<anchor>`) also runs in the counts checkout. Nothing is read from the core checkout but its HEAD. Every git child runs with every `GIT_*` variable removed, no system or global config, replace refs off (`--no-replace-objects`) and the fsmonitor hook off, so the environment cannot redirect the checks and a `refs/replace` ref cannot fake ancestry. Ignored files in the dir are refused too. A plain measured baseline gets the lighter proof of the same issue: its one file must be committed and clean in its git work tree (`COUNTS_UNTRACKED`, exit 31: untracked, staged-new, modified or ignored is refused), checked with replace refs off and no `GIT_*` variable. A counts checkout owned by another user is refused by git (safe.directory) and the message says so. With no `--counts-dir` the default dir is the core checkout's own and cannot satisfy this; the refusal says to pass `--counts-dir`.
5. **The counts checkout MUST be a reviewed, merged commit reachable from the release line's origin ref, `origin/releases-A.B.x`.** The code checks history and bytes, not review: a clone with a local descendant Y' that adds a forged X.json is accepted by the checks of step 4 alone. So in the counts checkout run `git fetch origin releases-A.B.x`, check out the merged commit Y (or later), and pass the origin-ref flag (`--counts-require-origin-dev` in the CLI) on every 8453 plan and broadcasting run (deploy, `prove-control`, `govern`). The flag (off by default in code, REQUIRED here) refuses unless HEAD of the counts checkout is an ancestor of, or equal to, the local origin ref of the release line. It reads only that local ref, so the fetch is the operator's step. That ref is LOCAL: anyone with write access to the operator's clone can forge it, so the flag proves only that the operator fetched and that the counts HEAD is on or behind their local origin ref, NOT provenance or review. The review of the data-only PR is the control.
Tested with real git repositories in `publish-contracts/tests/counts-layouts.test.ts`.

1. **Make the keys.** Run `bun run rehearsal keys --dir <backed-up folder> --chain-id 8453` and type the passphrase at the hidden prompt. Never pass `--password-file` for the mainnet test, and never put the passphrase in an argument or the environment. The helper makes no voter keys: there is no voting (issue 1698). `--chain-id 8453` puts `CHAIN_ID=8453` in the printed sheet fragment. Back the folder up before any funds move. The Safe owners made here are encrypted keystores, named `--owner-signer keystore:PATH` at prove-control and govern with the passphrase typed at the hidden prompt. An owner may instead keep their key on a hardware wallet: put that owner's address in `SAFE_OWNERS` and name it `--owner-signer ledger:PATH@0xOWNER` (or `trezor:`). Hardware is optional, never required (owner decision 2026-10-14).
   **Unlocking later steps:** `rehearsal run` still requires `--password-file`. The owner creates their own 0600 file on tmpfs (for example under `/dev/shm`) holding the passphrase, uses it, and runs `shred -u` on it straight after. Never put it in the backed-up folder or its parent.
2. **The seed receiver is Safe owner A's address** (`SAFE_OWNER_A` in the printed fragment). The tool makes no separate seed key.
3. **Passphrase file on older code.** From this change on, the hidden-prompt path keeps the passphrase in memory and writes no file. Keys made from the `release/v0.4.0-base` tag (older code) also wrote the passphrase to a plaintext 0600 file `<dir>.pw` beside the folder. When keys were made that way, run `shred -u <dir>.pw` after use and never back that file up. The file sits BESIDE the keys folder, so a backup of the parent directory includes it. Check every backup for it first, and shred it before backing up the parent.
4. **Funding.** Only the deployer is funded. It submits every transaction, including the Safe owners' signature bundles (prove-control and govern). The pauser and the emergency key are funded only when an agent asks to exercise a pause. `pause-all` with an unfunded key stops and names the key to fund.
5. **Recorder poker (named role).** `UniswapV4PriceRecorder.record()` has no keeper. The run names one accountable poker before it starts, who calls `record()` well inside the 1800 s staleness limit (for example every 10 minutes), because a revert happens just past 1800 s. After 1800 s without a `record()`, every rmAGENT deposit and USDC redeem reverts `StaleRecorder` until someone pokes. `redeemInKind` stays available while the recorder is stale. The first poke after a long gap weights the old tick over the whole gap, so the recorded average lags the live price until the window refills. The automated keeper in "Recorder keeper (issue 1779)" below replaces the manual poke. Until it runs, the named poker does it by hand.
6. **Run the verifier before unpausing.** `RECORDER_ADDRESS` comes from the environment and the deploy script only checks its getters, so only the verifier binds the recorder codehash. Run `verify` (pre-govern) and require it green before `govern` schedules any unpause. The verifier also reads `maxSlippageBps` back from every basket and compares it with the basket's config, or the vault default the config keeps (label `vault[rmPROTO|rmAGENT|rmRWA]: maxSlippageBps equals config`; rmAGENT's config sets 500, issue 1705). It fails on any other value.
7. **Standing rule (owner, 2026-10-09): every mainnet rehearsal and test uses 1 USDC.** The seed is 1 USDC (`SEED_DEPOSIT_USDC=1000000` in the frozen sheet, which the deploy only requires to be non-zero), and the test is one 1 USDC deposit into each of the four vaults, then a full redeem, all from the deployer after the handover. No code enforces the 1 USDC amount: the operator holds to it. The deployer needs 5 USDC (1 seed plus 4 test deposits). The Twin sheet sets the caps at 1000 USDC TVL and 100 USDC per deposit for all four vaults, with no minimum. Those are Twin values only: the 8453 frozen sheet governs the real caps, so check its `tvlCap` and `perDepositCap` before the run. The 1 USDC test deposit is far below either.
8. **Deposit and redeem commands** (`$V` the vault, `$U` USDC, `$D` the deployer, `$REC` the recorder, each `cast send` with the deployer keystore and a tmpfs password file):
   - `cast send $U "approve(address,uint256)" $V 1000000`
   - `cast send $V "deposit(uint256,address)" 1000000 $D`
   - `cast send $V "redeem(uint256,address,address)" <shares> $D $D` (shares from `cast call $V "balanceOf(address)(uint256)" $D`)
   - `cast send $V "redeemInKind(uint256,address,address)" <shares> $D $D`
   - `cast send $REC "record()"` and `cast call $REC "isFresh()(bool)"`
9. **rmAGENT order.** rmUSDC, rmPROTO and rmRWA need no extra step. For rmAGENT, call `record()` and check that `isFresh()` reads true immediately before the deposit, otherwise the deposit reverts `StaleRecorder(uint32 lastRecordedAt, uint32 nowTs)` (selector `0x4512c7f1`) once more than 1800 s have passed since the last `record()`. Redeem within 30 minutes of the last `record()`, or poke again first. If the rmAGENT USDC redeem still reverts `StaleRecorder`, use `redeemInKind`: it reads no oracle and still pays.
10. **Expected round-trip loss (measured on the post-govern Twin at the tag, not a guarantee for mainnet):** rmUSDC about 0, rmPROTO about 19 bps, rmRWA about 10 bps, rmAGENT about 592 bps (the 2.91% pool fee on each leg).

**Recorder keeper (issue 1779).** `scripts/ops/recorder-keeper.sh` calls `record()` on the rmAGENT `UniswapV4PriceRecorder` every 240 s, under the 5 minute promise and well inside the 1800 s staleness limit. It is code and docs only. The DevOps operator who runs the mainnet stack (the devops runtime repository) owns it: they deploy it, hold its key and answer its alerts. Core ships the script and its test.

- **Cadence is measured (issue 1793).** `contracts/test/V4RecorderSamplingEconomicsFork.t.sol` shows that at 240 s the best recorder sample leaves a NAV mark error of about 60 bps, inside the deployed rmAGENT's 100 bps guard, and costs the attacker more than 3 USDC for no gain. The error grows linearly with the interval (about 100 bps at 360 s), so keep `INTERVAL_SECS` at or below 240. See `docs/code-review/20261014-code-review-internal-claude-v4-sampling-economics.md`.
- **Why a loop and not one call.** One `record()` moves the recorded tick by at most 600 ticks (about 6.2 percent), and only when 60 s or more passed since the last one. After a gap the NAV deviation guard (the vault's `navDeviationGuardBps`: 100 bps on the deployed rmAGENT; the sheet sets 400 bps for a new rmAGENT, QA plan D4) refuses deposits until the 1800 s NAV TWAP catches the live tick. The keeper repeats `record()` every 60 s until the gap is at most 90 ticks (about 0.9 percent), at most 30 extra calls. The full TWAP window must refill; two clamped observations alone do not restore the guard.
- **Key.** A fresh low-privilege key in an encrypted keystore, funded with gas only (a few cents of ETH on Base). It holds no role, no USDC and no shares. Never reuse the deployer, pauser or emergency key. Put the password in a 0600 file on tmpfs, never in an argument.
- **Run.**
  ```
  RPC_URL=<base rpc> RECORDER_ADDRESS=<rmAGENT recorder> \
  KEEPER_KEYSTORE=<keystore file> KEEPER_PASSWORD_FILE=<0600 password file> \
  ALERT_WEBHOOK=<alert url> scripts/ops/recorder-keeper.sh
  ```
  Install Foundry `cast`, Python 3 and curl. Run it under a supervisor that restarts it on exit (systemd `Restart=always`, `RestartSec=10`). `--once` does one tick and exits 0 healthy, 1 on an alert, 2 on bad config. Tunables are `INTERVAL_SECS`, `CATCHUP_INTERVAL_SECS`, `MAX_CATCHUP_CALLS` `MAX_DEVIATION_TICKS` and `TWAP_WINDOW_SECS`.
- **Alerts.** Each is one JSON line on stderr and a POST to `ALERT_WEBHOOK`: `recorder_stale` (`isFresh()` read false, before or after the call), `record_failed` (the send failed, for example no gas), `recorder_unreadable` (an RPC read failed), `deviation_not_converged` (still above the limit after the catch-up calls). A webhook outage is logged and never stops the keeper. A dead keeper sends nothing, so also page when `isFresh()` reads false for a recorder for more than 5 minutes from a monitor on another host.
- **Restart steps.** (1) Read the last alert and the supervisor log. (2) Check the key balance with `cast balance` and top it up if `record_failed` shows an out-of-gas error. (3) Check the RPC with `cast block-number`. (4) Run `scripts/ops/recorder-keeper.sh --once` by hand and read the output. (5) Restart the supervisor unit. (6) Confirm `cast call $REC "isFresh()(bool)"` reads true. If the keeper cannot be fixed fast, fall back to the manual poke in step 5 of the run-day steps above, and send no deposit to rmAGENT while it is stale.
- **Check before relying on it.** `bash scripts/ops/test-recorder-keeper.sh` (needs anvil, forge and cast) checks the component alert paths. `BASE_FORK_RPC_URL=<Base RPC> bash scripts/ops/test-recorder-keeper-fork.sh` runs the keeper on an isolated Base fork against Deploy 2 rmAGENT and its recorder. It seeds a historical recorded tick 1500 ticks behind the real pool, advances two days, requires repeated catch-up calls, asserts the actual vault NAV deviation is inside its enabled guard, and deposits 1 USDC with positive credited shares. The upstream is read only; transactions and seeded recorder state stay on the local fork. Both addresses come from the committed Deploy 2 manifests, `deployments/8453/deploy-2/agent-token-vault.json` (`vault` and `recorder`), never from a literal (clean room rule, QA plan v1 E10). The forge half also asserts that the vault prices its asset through that recorder. To test another deployment, set `DEPLOY_MANIFESTS` to its manifest folder, placed under `deployments/` because forge reads nothing else. `scripts/ci/check-no-production-addresses.ts` lists every Deploy 2 contract, so a test that hard-codes one fails. CI runs the component test in `recorder-keeper-selftest` on pull requests and pushes. It runs the fork test only nightly and on manual dispatch, in `recorder-keeper-fork` (`suite-18-live-monitoring.yml`), never on a pull request. Both fail if resources or deployed contracts are unavailable, and the fork test prints the fork pin and assertion evidence. Set `BASE_FORK_BLOCK` to reproduce a specific pin. Catch-up compares the full NAV TWAP rather than only the latest clamped observation; `TWAP_WINDOW_SECS` defaults to 1800 and must match the vault window.

**Run-day: look at the deployed contracts in the dapp, read-only (issue 1725).** After the deploy, copy the manifests directory to a scratch folder and run on the operator machine only, with no key, passphrase or keystore variable in the environment:

```
bun scripts/stage/core-stack.ts dapp up --chain 8453 --rpc <base rpc> --manifests <copy of manifests> --start-block <first block of the run>
```

The first block of the mainnet test run is 52401633. Open `http://127.0.0.1:15173` (dapp) and `http://127.0.0.1:18547/health` (explorer API). The stack sends no transaction and has no faucet. Stop it with `dapp down --chain 8453`. Public exposure through the existing cloudflared tunnel on the stage host is approved by the owner (decision 2026-10-10): this tool never touches tunnel, DNS or proxy configuration, and the ports stay on 127.0.0.1. Once the vaults open on 2026-10-12 anyone reaching the public dapp can deposit REAL USDC. The dapp shows the red "Base mainnet — real funds" banner and the wrong-chain screen (issue 1729): run the public dapp checks below before the tunnel points at it. See `docs/development/stage-deployment.md`.

**Basket sheet values (issue 1666).** Each basket (`PROTO`, `AGENT`, `RWA`, never `USDC`) carries two more
names in the frozen sheet, read by its stage as `NAV_DEVIATION_BPS` and `MIN_POOL_LIQUIDITY`:

| Sheet name | Rule |
| --- | --- |
| `VAULT_<KEY>_NAV_DEVIATION_BPS` | The ORA-4 deposit guard in basis points, from 1 to 2000. The vault default is 0, which disables the check, so 0 is refused. A value above 2000 is refused (the vault ceiling is 20 percent). The unit is basis points: 100 is 1 percent. The guard runs on deposit only, never on redeem. The value must be above the fee of every pool the basket lists, in bps (`poolFee / 100`): the deploy script refuses a guard at or below a pool fee, because spot can rest anywhere inside the fee band with no arbitrage to close it, and such a guard reverts deposits (and the routed deposit with them) on idle drift (QA plan D4). rmAGENT's RM V4 pool charges 291 bps, so its sheet value is 400: the fee plus a TWAP lag budget (decision D10). |
| `VAULT_<KEY>_MIN_POOL_LIQUIDITY` | The floor for `IUniswapV3Pool.liquidity()` of every pool the basket lists. The unit is the pool's in-range liquidity L (a `uint128`, about sqrt(token0 x token1) in raw units), not a USDC amount. Above 0 and at most 2^128 - 1. It is checked on top of the vault's own dust constant `MIN_POOL_LIQUIDITY` (1e6), which is not changed. Read the live value with `cast call <pool> "liquidity()(uint128)"` before you pick it. |

`VAULT_USDC_NAV_DEVIATION_BPS` and `VAULT_USDC_MIN_POOL_LIQUIDITY` are refused: rmUSDC has no guard and no pool.
The 8453 values are the owner's, set in the frozen sheet. The deploy script sets the guard on the new vault before the
timelock handover and reads it back, then refuses any pool below the floor. The verifier (stage 12) reads
`navDeviationGuardBps` from the chain and asserts it equals the sheet and is above zero, and asserts each basket pool's
liquidity meets the floor. Each basket stage sends one more transaction (`setNavDeviationGuardBps`), so the frozen
per-stage counts are the ones the Twin rehearsal measures after this change.

Every privileged action after stage 11 is Safe → `TimelockController` →
target. `updateDelay`, a batch and a cancel run only as Twin-chain tests of
the Safe tool, never on 8453.

Every destructive or irreversible step (anything past the seed deposit, since
the vault is then open to real deposits) must be explicitly marked in the
per-release runbook and authorized by the operator before execution.

### 4.4. Postflight — manual QA

After the ceremony completes, the release's manual QA is what actually proves
the deployment is usable, not just that the transactions didn't revert. At
minimum:

1. **Role wiring.** Run the stage 12 verifier (§4.3), which re-reads every
   role postcondition from the chain — do not trust that broadcast success implies correct role
   state.
2. **Functional smoke test.** Execute one real deposit through the gateway
   (a non-admin test agent), then one real withdrawal from the vault directly
   by the share owner, and confirm share accounting matches
   `previewDeposit`/`previewRedeem`.
3. **Dapp integration.** Point a browser wallet at the deployment's RPC URL
   and chain id, connect, and confirm the dapp shows the correct vault
   balance, adapter allocations, and the deposit/withdrawal from step 2.
4. **Explorer/indexer.** If an explorer/indexer is part of the target
   environment (true for the Devnet's `--full-stack` mode), confirm the
   deposit and withdrawal events from step 2 are visible there — this is the
   check that the deployment is observable, not just functional.

The contract QA runbook (§5) carries these checks as its phase 2 (verify), 4
(verify again), 6 (deposits) and 8 (observability). A contract release runs
those phases instead of writing its own postflight list. QA runs them on the
Twin at the QA branch commit (§2). Production runs the same phases at the rc tag
(§4.14), unmodified: the same step list, with only the target and sheet different.

The postflight gate is satisfied only when every check above passes and the
operator has signed off. Write the results into the stage rehearsal or
production rollout report (§4.5/§4.9).

**What "complete" means.** A run of a release file is complete when its
`P10.52-record-signoff` step wrote `go/signoff.json` (`scripts/runbook/run-record.ts`).
That record exists only when the rollout report, written by the run itself, lists
no issue: no failed step, no step that runs on the target without a result, no vault
still paused, and no transaction a marked sender made that no step journaled. The
runner (`scripts/runbook/run.ts`) runs every step that runs on the target and has no
option to skip one. Nothing an operator or an agent says about a run makes it complete,
and no one reports as done what that record does not show. The assurances the steps
give are listed in `docs/runbooks/contract-qa/README.md` ("Assurances").

### 4.5. Fix loop

If QA, preflight, the cutover, or postflight finds any issue:

1. Develop the fix in a development worktree, never on a host.
2. Open a PR with the fix against the session's QA branch `qa/A.B.x-<YYYY-MM-DD>` (§2) and merge it there.
   A pushed QA branch is never rewritten. If the release branch moved, cut a new
   QA branch from its tip (`-2` suffix).
3. Run the QA runbook on the Twin at the QA branch's new tip. A QA failure consumes no rc number.
4. When QA passes, squash the QA branch onto `releases-A.B.x`, cut the next rc
   (`vA.B.C-rc.(N+1)`, §3) and restart from §4.1 at that rc. The fix reaches `dev`
   afterwards by a separate PR (§7).

If verify (stage 12) or the postflight is what failed, the publish-contracts
CLI has already paused deposits on all three vaults (rmUSDC, rmPROTO,
rmRWA) before you read the failure: `pause-all` (§4.6). Check the
`rollout-report-<chain>.json` it wrote before you start the fix. A vault that `pause-all` paused comes back through the Safe: `govern --row unpause-USDC`
for rmUSDC and `govern --row unpause-PROTO` or `unpause-RWA` for a basket
that was already unpaused (every row is refused while its vault reads open). Each opens a new numbered round (a new timelock operation id, a new 48-hour delay): the run exits `GOVERN_PENDING`, and the same
command executes it after the delay. A default `govern` run never reopens a vault that was paused again. Record each round under `govern` in the evidence
file with its `round` number (all four steps are required, and every step may have rounds 1 to n).

**Never resume `govern` after a `pause-all` without cancelling first (issue 1686).**
If an unpause was already scheduled when `pause-all` ran (by hand, or the
automatic one after a failed verify), the timelock would still execute it after
its delay and reopen the vault you just paused. `pause-all` therefore records a
`pauses` entry (sequence number, timestamp, trigger, per-vault result) in
`publish-run.json`, and `govern` refuses before it sends anything when a pause
entry is newer than a pending unpause's schedule: `GOVERN` (exit 14), naming
the row, the pause entry and the operation id. The pause entries live in the
run's own `publish-run.json`, so `govern` and `verify` refuse with `RESUME`
(exit 16) when `--evidence` holds no run manifest, and `govern` also when that
manifest has no finished timelock stage. Run the resume command exactly as
printed: it names the absolute `--evidence` directory. The tool has no cancel on 8453,
so the recovery is, in this order:

1. Cancel the pending operation through the Safe on the timelock: a Safe
   transaction that calls `cancel(<operation id>)` on the timelock (the id is
   in the error and in `publish-run.json` under `govern.<row>.scheduled.operation_id`).
2. Fix what made you pause.
3. Run `govern --row unpause-X` (same arguments as before). It sees the
   cancelled operation, archives it in the manifest as `<row>:round-<n>:cancelled-<k>`
   and schedules the same round again with a fresh sequence number, a new
   48-hour delay and the usual `GOVERN_PENDING`. The same command executes it.
4. A pause-all older than the schedule does not block. A row whose vault was
   paused again after it executed opens round n+1 as described above.

Ordering details (issue 1688). `govern` reserves the schedule's sequence number
in `publish-run.json` (`seqHigh`) BEFORE it sends the schedule, so a pause-all
that begins after the send is always newer than the schedule. A record with no
`seq` (written by an older tool, or adopted from the chain) is never given one
by a later save: it counts as older than every pause entry. If `pause-all`
cannot write its entry (the manifest is unwritable or missing), it still pauses
all three vaults, because an emergency pause must not wait on bookkeeping. It
then exits `PAUSE` (25) and says the pause was not recorded: `govern` cannot
see it, so cancel every pending unpause through the Safe by hand. The rollout
report has `manifestRecorded: false` in that case. When a vault is also left
open, the one error names the open vault and still says to cancel every pending
unpause (issue 1701). Exit 25 therefore means either cause: `details.unpaused`
lists open vaults, `details.manifest_recorded: false` marks an unrecorded pause.

An apply-receipt operation scheduled before a pause-all can still execute after it (issue 1701): govern's pause check (`refuseIfPausedSince` in `src/govern.ts`) ignores every row that is not an unpause or a redeploy round, so it refuses no `apply-receipt` (nor `release-receipt` or a Twin-only row) scheduled before a recorded pause-all. If its weights must not land after the pause, cancel that operation through the Safe on the timelock by hand.

A contract deployment cannot be patched in place, so "try again" after a
broadcast is a fresh deployment, or a further governed upgrade, from the next rc. An rc that
failed after a broadcast is never reused, and no version tag exists for it (§3).

### 4.6. Rollback

**Contracts are immutable; there is no in-place rollback.** A postflight
failure's mitigation depends on how far the ceremony got:

- **Before the timelock/role handover (§4.3's last step):** the deployer EOA
  still holds `EMERGENCY_ROLE` on every vault and signs `pauseDeposits()`
  (the `pause-all` command below), or you abandon the deployment (it holds
  no real user funds yet on a fresh network) and redeploy fresh addresses
  after the fix.
- **After the timelock/role handover:** the deployer no longer holds admin
  authority. The EMERGENCY key signs the vault's `EMERGENCY_ROLE` deposit
  pause (`pause-all` with `--emergency-signer`), which never blocks a redeem
  (`docs/operations/manual-admin-actions.md`), while a fix is prepared and a
  **new** deployment (new addresses) is planned — a live vault's stored
  state cannot be transplanted onto fixed contract code.

**The command.** `bun publish-contracts/src/cli.ts pause-all ...` pauses
deposits on **all three** vaults: rmUSDC, rmPROTO and rmRWA (rmUSDC
is not special; owner decision 2026-10-07, plan decision 22). It runs by
itself when stage 12 (verify) or the postflight fails, and the run still exits
with the verify failure's code (13). It picks the signer by stage (deployer
before the handover, EMERGENCY key after), reads `depositsPaused` back on
every vault and records each vault's paused state in
`rollout-report-<chain>.json` under the run's evidence directory. Each send
takes a fresh pending nonce (never below one past the key's last send in the
run), and each read-back waits until the RPC reads the receipt block three
times in a row, 60 reads at most, the same rule as `scripts/runbook/cast-send.sh`
(issue 1981: a lagging Base RPC node read `false` after a mined pause). Withdrawals
stay open. Exit 25 means a vault is not confirmed paused. Run the CLI from a
checkout of `DEPLOY_SHA`. A CLI from another sha still pauses, with one
`vault_rules.mismatch` warning naming both stage tables (`pause-all` reads no
per-vault rule); every other verb refuses the mismatch (issue 1851). A verify
whose only failures are RPC-refused receipt reads exits 30 (`RPC_REFUSED`) and
pauses nothing: the deployment is NOT verified, so do not govern; rerun verify against an RPC that serves the deploy receipts. A recorded deploy transaction with no receipt while the same RPC serves the run's other receipts is not an RPC problem: it is missing from the chain, so verify exits 13 and pauses (issue 1864). **Initial deposit state, one rule for all four vaults** (`scripts/deploy/stage-table.json` `vaults[].deployPaused` and `unpauseInStage13`, issue 1705): all four vaults deploy paused, and stage 13 unpauses all four through the Safe and the timelock. rmUSDC
pauses right after its 1 USDC seed deposit.
Rehearsed on every pull request that touches the deploy by the Twin test
`testing/smoke-test/tests/twin_pause_all.rs`.

The rollback/mitigation procedure must be written into the per-release
runbook and rehearsed on the Devnet at least once before a
mainnet deployment.

### 4.7. Production rollout report

After a deployment (successful or not), produce a report covering at least:

- the commit SHA, the rc tag and the QA branch it was squashed from, the QA
  tree hash, and the target network deployed,
- preflight and postflight results (and, when verify or the postflight
  failed, the `pause-all` result: each vault's `depositsPaused`),
- any issues encountered and their resolution,
- the final version tag applied (if any — see §3), and the backport TODOs (§7),
- operator sign-off.

The report is the closing artifact of the release. The release tracking
issue is closed only after this report is filed.

### 4.8. Post-launch consensus receipt application (the rebalance)

Do not release a consensus receipt on its own. `govern --row release-receipt` is refused with USAGE (issue 1831)
because `RouterGovernance` holds the receipt contract's `ADMIN_ROLE` on every deployment since core 1698. A release
alone would burn the receipt: `applyReceipt` then reverts `ReceiptAlreadyReleased`, so its vector could never land.
A receipt is released only by applying it with `govern --row apply-receipt` (4.9). Historical `receipt_releases`
entries in an evidence file are still parsed by the evidence check.

### 4.9. Post-launch receipt application (the Safe applies a rebalance)

The Safe multisig, through the timelock, is the only body that changes Robot Money contract configuration, router weights included. There is no vote. `govern --row apply-receipt --receipt-id 0x<bytes32> --payload FILE` applies one recorded consensus receipt as ONE timelock call (issue 1696, issue 1698): `RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps)`, gated by `RouterGovernance`'s `WEIGHT_SETTER_ROLE`, which the timelock holds. It checks that the receipt is recorded, unreleased, recorded strictly after the last applied receipt (`lastAppliedRecordedAt`, issue 1831: an older receipt executed after a newer one reverts `ReceiptNotNewerThanApplied`, and the tool refuses it with USAGE before scheduling) and that `payloadDigest` equals the stored digest, then releases the receipt and sets the router's ACTIVE vector in the same call. Partial state is impossible. The default vector is untouched and stays the fallback. After the real delay the same command makes the Safe execute the call, and the tool reads `isReleased(receiptId)`, the router's active weights (`getWeights()`), its EFFECTIVE weights (`getEffectiveWeights()`, what deposits route by) and `votedWeightsActive()` back. It fails (`GOVERN`, exit 14) unless the receipt is released, `votedWeightsActive()` is true and the active and effective weights equal the receipt vector.

`--payload FILE` is the receipt payload whose `weights` list names a bucket and `weight_bps` per entry. The buckets map to the basket vaults (`conservative_defi_yield` rmUSDC, `protocol_tokens` rmPROTO, `agent_tokens` rmAGENT, `real_world_assets` rmRWA). A bucket at 0 bps whose vault is not router-eligible is dropped, every other entry is kept and the vector is arranged in registry order (issue 1754: the signed payload lists the buckets in the receipt's canonical order agent, conservative, protocol, rwa).

An active vector already in effect does not block the row: `applyReceipt` overwrites it.

Refusals. Each exits `USAGE` (exit 2) before anything is sent, so no delay is spent:

- the receipt is not recorded on the receipt contract, or is already released;
- the receipt digest (`keccak256` of the domain line `robotmoney:consensus-receipt:v1\n` plus the payload file bytes) differs from the digest the receipt stored on chain (a weights-only edit of a published receipt);
- the weights do not sum to 10000 bps;
- the vector does not list exactly the registry's router-eligible vaults (a missing vault, a vault that is not eligible and carries weight, an unknown or repeated bucket);

Never part of stage 13, which stays the three vault unpauses: no default run, stage run or numbered `--row` reaches it. On 8453 it runs only when named with `--row apply-receipt`, a receipt id and a payload, as a post-launch action with its own 172800 s delay: the first run schedules and exits `GOVERN_PENDING` (exit 15) with the resume command, the same command after the delay executes it. An operation the operator cancelled through the Safe is scheduled again by the same command, with a newer sequence number. Record the operation under `receipt_applications` in the evidence file (with `governance.address`): `evidence-check` accepts it only as one `applyReceipt` call whose target is the governance contract, with the `payload_digest` and `voted_weights_active` true. On 8453 verify does not trust the run manifest's `receipt_applications` (issue 1701): every entry must be backed by its timelock batch on chain (the same check as `evidence-check --receipt-applications --rpc`: the schedule and execute transactions, the one `applyReceipt` calldata of the recorded vector, the delay), or verify fails (exit 13), so a forged entry cannot hide router weight drift. `evidence-check --delay-floor` is refused (exit 2) below the 8453 floor of the deployment kind (172800 s for production) when `--rpc` reads chain 8453. See 4.6 for the pause-all ordering gap of this row. Whether the mainnet test deployment runs this row after the unpause round is an open owner decision, default: no.

**The active vector is never cleared (issue 1988, issue 1743).** The router's active vector is the one an applied receipt wrote (`PortfolioRouter.setWeights`, called by `RouterGovernance.applyReceipt`); the router storage keeps its pre-1698 "voted" name, there is no voting. While `votedWeightsActive()` is true the active vector overrides the default. The first Base mainnet deployment (router stage `setWeights` at `DeployPortfolioRouter.s.sol`) left one (100% rmUSDC on top of the 9500/500/0/0 default), so the launch weights never took effect. The deploy no longer calls `setWeights` (the router stage sets the default `[rmUSDC]/[10000]` with `setDefaultWeights`, the basket stages' `migrateEligibility` re-set it to the sheet's `ROUTER_WEIGHTS`), and the verifier fails a freshly deployed router that still carries an active vector (the label `router: votedWeightsActive is true only after an applied receipt`, read as: router: votedWeightsActive is false after deploy, true once a receipt is applied; and `router: effective weights equal the sheet's launch vector`). No contract function, tool row or runbook step clears the active vector or resets it to the default: the owner ruled it too dangerous if it ran in production by accident (issue 1988). A vector that should no longer route is replaced by a newer receipt with `apply-receipt`, in one call. The routers of Deploy 3 and earlier still carry the pre-1988 clear function; nothing in this repository calls it, and the runbook validator (`scripts/runbook/validate-contract-qa.ts`) refuses a step that would. Run manifests of those deployments may hold `voted_weights_clears` entries from before issue 1988: `evidence-check` still decodes them as historical records.

**Setting a basket's emergency unwind guard (`govern --row set-unwind-guard`, QA plan v1 D7, issue 1705 Q2).** Until this row no stage or row set `BasketVault.emergencyUnwindGuard`, so an unwind whose TWAP read fails reverted `EmergencyFloorUnavailable` and `emergencyUnwindWithOverride` reverted `EmergencyUnwindOverrideDisabled`. One Safe -> Timelock round per basket: `govern --row set-unwind-guard --admin-arg vault=PROTO|AGENT|RWA --admin-arg token=0x<address>|all --admin-arg min-usdc-out=N --admin-arg max-loss-bps=N [--admin-arg override-allowed=true|false]` schedules `setEmergencyUnwindGuard(token, minUsdcOut, overrideAllowed, maxLossBps)` (`ADMIN_ROLE`, the timelock) for the one token, or one call per active asset with `token=all`. No contract change. `min-usdc-out` is USDC (6 decimals) for the vault's whole balance of that token: size it from the current holding less the loss you accept, because a floor above what the holding can fetch makes the unwind revert, and run the row again as the holding grows. `override-allowed` defaults to true and only the Safe sets it (QA plan v1 Decisions D3). Refused before anything is sent for rmUSDC, a zero floor, an override floor that rounds to zero, a token that is not an active asset, or a vault whose `ADMIN_ROLE` the timelock does not hold. Allowed in production and in a rehearsal, never part of stage 13; schedule the three rounds in the stage 13 sitting, because the post-govern verify fails every open basket whose active asset reads `minUsdcOut` 0. The run manifest records each round under `unwind_guards`.

The Twin rehearsal runs the row after the unpause rows (and checks `receipt_applications` of its run manifest with `evidence-check --receipt-applications`). The Twin proves execution only: that the row executes on the real contracts through the real Safe and timelock. It is not evidence that mainnet governance works (rule b).

### 4.10. Base mainnet REHEARSAL with a 900 s timelock (issue 1727)

Owner decision 2026-10-10 (reverses the 2026-10-02 rule that a short-delay run is never evidence, for REHEARSALS only). The main goal is to test governance and the router rebalance driven by Investment Committee consensus receipts, end to end on real 8453 contracts, with the full receipt path and no fixture. The rehearsal REUSES the keys of the first rehearsal (deployer, pauser, emergency, Safe owners A, B and C) and deploys NEW contract addresses. Production is untouched: its 172800 s floor and its fresh-deployer accounting are unchanged and pinned by tests.

**Selecting the mode.** One sheet line, `DEPLOYMENT_KIND=rehearsal`. It is never read from the environment and there is no flag, because the sheet is the reviewed input that also reaches forge (`DeployTimelock.s.sol` enforces the same floor from the same value), is diffed by the isomorphism report and is copied into the run record. Absent or `production` is production. Any other value is a sheet error. Start from `deployments/base-8453-rehearsal/stage-sheet.example.env` (public placeholder addresses only: type the real public addresses of the reused keys, a NEW `SAFE_SALT_NONCE`, the 8453 caps from the first rehearsal sheet).

**Floors, production against rehearsal** (every other floor stays):

| Floor | Production (default, unchanged) | Rehearsal (explicit) |
| --- | --- | --- |
| `TIMELOCK_MIN_DELAY`, sheet and `floors.ts` | at least 172800 on 8453, at least 1 elsewhere | 900 to 172799 on every chain (172800 or more is refused: the chain could not tell it from production) |
| `GOVERN_NEW_DELAY` | 3600 to 2592000, and the chain floor | 900 to 172799 |
| `DeployTimelock.s.sol` | `MIN_PRODUCTION_DELAY` 172800 on chain 8453 | `MIN_REHEARSAL_DELAY` 900, below 172800, when `DEPLOYMENT_KIND=rehearsal` is set (the runner sets it from the sheet only) |
| Safe tool `updateDelay` | floor 172800 on 8453 | floor 900, below 172800 |
| verifier | delay at least 172800 on 8453, label `deployment kind: the timelock delay agrees with the kind` | delay 900 to 172799 (a rehearsal verify against 172800 fails, a production verify against 900 fails) |
| `evidence-check` | floor 172800, kind production | `--deployment-kind rehearsal`: floor 900. Rehearsal evidence checked as production fails, and the reverse |
| release tag | the annotated rc tag `release/vA.B.C-rc.N` (no `rehearsal` in the name; an annotated `release/<version>` of an older line also passes) | annotated `release/<version>-rehearsal`, or the run's rc tag `release/<version>-rc.N-rehearsal` (any annotated tag ending in `-rehearsal` at the sha). A mismatch fails `RELEASE_TAG_KIND` (exit 28) before any signer exists |

**What records the kind.** The run manifest (`deploymentKind`), the evidence (`deployment_kind`), the verifier label detail and the `verify.deployment_kind` log event (`[rehearsal 900s]`), the isomorphism notes, `timelock.json` (`deployment_kind`), the tag name, and the timelock `minDelay` itself on chain (900).

**Per row, on 8453 in a rehearsal:**

| Row | Rehearsal on 8453 | Why |
| --- | --- | --- |
| `unpause-USDC`, `-PROTO`, `-RWA` | yes, stage 13, run first | the launch path, unchanged |
| `register-submitter --submitter ADDR` | yes, on demand; target: allowed on every chain, Base production included | the ADMIN_ROLE action that lets a submitter anchor receipts: one timelock call, `ConsensusRecommendationReceipt.grantRole(RECEIPT_SUBMITTER_ROLE, submitter)`. No gateway call and no gateway policy is part of it. **Deployed release (v0.5.0):** the row does not exist yet. Today's row is `govern --row register-committee --submitter ADDR` (`publish-contracts/src/committee-register.ts`, evidence key `committee_registrations`; `src/ci/twin-publish.ts` runs it), rehearsal and Twin only, refused on 8453 in production |
| `release-receipt` | no, refused with USAGE (issue 1831) | a release alone burns the receipt; use `apply-receipt` |
| `apply-receipt` | yes, as in production | one `RouterGovernance.applyReceipt` call releases the receipt and sets the router's active weights; read back |
| `set-unwind-guard` | yes, as in production, one round per basket with the unpauses | sets each basket's emergency unwind guard through the timelock (QA plan v1 D7); the post-govern verify requires it on every open basket. The Twin CI path (`ci/twin-publish.ts`) and the stage flow (`core-stack.ts governance ensure`, which `governance verify` follows) run it themselves with fixed proving values (`token=all`, `min-usdc-out=1000000`, `max-loss-bps=500`) because their baskets hold nothing. On 8453 nothing runs it for you: the operator sizes each guard from the vault's holding |
| `redeploy-vault` | yes, rehearsal and Twin only, on demand, after the `redeploy-vault` verb (section 4.11) | replaces rmPROTO with a redeployed vault in one batch of six calls, the old vault's router cap included; refused on 8453 in production (issue 1796) |
| `update-delay` | yes, explicit `--row`, after the three unpauses | exercises the Safe tool timelock path on real contracts; the new delay stays 900 to 172799 and the verifier follows the executed delay |
| `batch` | yes, explicit `--row`, after `update-delay` | a no-op `scheduleBatch` (updateDelay to the current value, rmUSDC cap to its current value): no state change |
| `cancel` | yes, explicit `--row`, after `batch` | schedules a no-op and cancels it: no state change |
| generic `--call-*` | no | a test verb, refused on 8453 in every kind |

Stage 13 on 8453 stays the three unpauses in every kind. In production `update-delay`, `batch` and `cancel` are refused with `USAGE` exactly as before. Rehearsal evidence for them goes in `rehearsal_rows`, which a production evidence may not carry.

**The receipt path (no fixture).** After the three unpauses:

1. Create or choose the SUBMITTER SAFE once (a SafeL2 1.4.1 multisig with threshold 2 or more; it may be the governing Safe, owner decision 2026-10-20; v0.5.0 tooling refuses it, `submitter-safe.ts` `forbiddenSubmitters`), then register it through the governing Safe and the timelock: `govern --row register-submitter --submitter 0x<submitter Safe>` (target: the row does not exist yet. **Deployed release (v0.5.0):** `govern --row register-committee --submitter 0x<submitter Safe>`, `publish-contracts/src/committee-register.ts`, evidence key `committee_registrations`). The row refuses a key (no code) on 8453, a contract that is not a canonical SafeL2 1.4.1 proxy with threshold 2 or more, no module, no guard and the canonical fallback handler, and the timelock, admin (= the deployer), the pauser and the emergency address (the governing Safe is accepted in the target, owner decision 2026-10-20; v0.5.0 refuses it). It schedules one timelock call, `ConsensusRecommendationReceipt.grantRole(RECEIPT_SUBMITTER_ROLE, submitter)`, exits `GOVERN_PENDING` (15) with the resume command, and the same command after the 900 s delay executes and reads `hasRole(RECEIPT_SUBMITTER_ROLE, submitter)` back. Evidence: `submitter_registrations` (target; `committee_registrations` on v0.5.0).
2. A submitter anchors a REAL receipt on the receipt contract: first `rmpc receipt verify` (read-only, no signer) checks every analyst signature off chain and prints `receipt_id` and `payload_digest`; then `publish-contracts record-receipt --payload FILE --submitter 0x<submitter Safe> --signer <deployer signer> --owner-signer <owner 1> --owner-signer <owner 2> --receipt-id ID --payload-digest DIGEST --payload-uri URL` (FILE is the receipt as served by the canonical route; `--payload` is optional but recommended: the verb recomputes the digest and the id from the bytes and refuses a mismatch before any signer exists) proposes, through the submitter Safe, a call to `ConsensusRecommendationReceipt.recordReceipt(receiptId, payloadDigest, payloadUri)`, collects the signatures of `threshold` of the submitter Safe's owners and executes it with the DEPLOYER as the gas payer (`--signer`). It refuses when fewer owner signers than the threshold are given, when the Safe that executed is not `--submitter`, and when the Safe emitted no `ExecutionSuccess` for the Safe transaction hash; it reads the receipt back and requires the stored submitter to be the Safe. On 8453 there is no single-key mode: `record-receipt` without `--submitter` is refused before any signer exists. `rmpc` records no receipts: its one on-chain write is an agent deposit into a vault (owner decision 2026-10-19), so a rehearsal and production both record through this verb, on every chain (target). **Deployed release (v0.5.0):** `publish-contracts/src/cli.ts` (line 617) and `src/record-receipt.ts` (line 166) refuse the production kind on 8453. The refusal is lifted with the target (RS-1019 finding 5), and `rmpc receipt submit` is deleted with it; on v0.5.0 that command still exists and no longer refuses a software signer on 8453 (`ErrProductionSignerRequired` was deleted with the hardware rule, owner decision 2026-10-14, QA plan Decision D12). The verb checks `RECEIPT_SUBMITTER_ROLE` and that the id is not recorded with other data before it sends, reads the receipt back, and writes `recorded_receipts` (id, digest, uri, submitter ADDRESS, transaction; never a key).
3. The Safe applies it: `govern --row apply-receipt --receipt-id ID --payload FILE`, where FILE is the receipt bytes as served by the canonical route, whose RECEIPT DIGEST is the recorded digest. The receipt digest is `keccak256("robotmoney:consensus-receipt:v1\n" || FILE)`, not a plain `keccak256` of FILE (issue 1754; the single definition is `publish-contracts/src/receipt-digest.ts`; the oracle is the real receipt of session 5015526d-27f6-478a-86e9-ac768e310af1, digest `0x2aebf2b33c117d41813ef338ccf1d44b8006cc8a54eb162b17cbb8ac18adbacb`). The payload may list the buckets in any order: the tool arranges the vector in registry order. The row schedules ONE timelock call, `RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps)`; `isReleased` and the router's effective weights are read back (issue 1698). An active vector from an earlier receipt needs no clear first: the new receipt replaces it.
4. `verify` again, then `evidence-check --receipt-applications <publish-run.json> --deployment-kind rehearsal ...` traces the application to a recorded receipt with the same digest by a registered submitter.

**What the submitter can do.** It anchors receipts and nothing else. It holds `RECEIPT_SUBMITTER_ROLE` on the receipt contract and no other role. There is no value path from the timelock or the Safe to it, and it cannot move weights or release a receipt.

**Deployed release (v0.5.0): roles in the 900 s rehearsal (acceptance criterion 5).** The OLD governance Safe `0x5E68a40648DD23065b21b1C414e1178ddE6482ca` (the first rehearsal's governing Safe, 2 of 3, proxy code hash and singleton checked read-only on 8453) is the **PROPOSER**: it is the submitter Safe that records receipts (`record-receipt --submitter 0x5E68a40648DD23065b21b1C414e1178ddE6482ca`). The NEW governing Safe, created by this rehearsal with `SAFE_SALT_NONCE` 2026101002, is the **APPROVER**: it registers the proposer through the timelock and applies the receipt (`govern --row apply-receipt`). The old Safe holds no role on the new deployment until `register-committee` (v0.5.0; `register-submitter` in the target) registers it. **Caveat: the same three owner keys (A, B, C) control BOTH Safes**, so proposer and approver are separated by the multisig and by each Safe's own nonce, not by key. **Preflight:** the three owner EOAs A, B and C must differ from the 900 s sheet's ADMIN_ADDRESS, PAUSER_ADDRESS and EMERGENCY_ADDRESS (the sheet already enforces it for the new Safe; the submitter check enforces it for the old one) or registration is refused with an error naming which owner collided. The same paragraph is in `docs/technical/consensus-receipt-submitter-runbook.md` §1.1.

**Who is the submitter. OWNER DECISION 2026-10-10 (it closes the earlier OWNER QUESTION about which key): a multisig, no single key.** The submitter is a Safe with threshold 2 or more; it may be the governing Safe (owner decision 2026-10-20, separate multisigs are not required; v0.5.0 tooling refuses it, `submitter-safe.ts` `forbiddenSubmitters`). It holds `RECEIPT_SUBMITTER_ROLE` on the receipt contract and nothing else. On every chain, Base production included, receipts go on-chain only through this Safe via the `record-receipt` row (target; v0.5.0 refuses the production kind, see step 2); `rmpc receipt submit` is not a path. The contract accepts a contract account as the role holder (no `msg.sender`, `tx.origin`, `isContract` or `ecrecover` check applies to it), so no contract change is needed: the rule lives in the tooling (`publish-contracts/src/submitter-safe.ts`) and is proven by the forge test `ConsensusReceiptSafeSubmitter.t.sol` with a real Safe. When a separate Safe is wanted, create it once, before `register-submitter`, with the Safe tool: `bun src/safe/cli.ts create --owners A,B,C --threshold 2 --signer <deployer signer> --salt-nonce <a number different from the governing Safe's SAFE_SALT_NONCE>` (the same factory and singleton, a different salt, so a different address). **The same three owner keys control BOTH Safes.** The separation between proposing and approving a receipt is therefore the multisig (two of three owner signatures) and the two Safes' own nonces, not different keys: a submitter Safe signature cannot execute on the governing Safe and the reverse, because the Safe transaction hash binds the Safe address and chain. The deployer only pays gas. No key, passphrase or keystore path reaches the repo, the sheet or the evidence. The evidence entries carry `submitter_safe` (threshold, owners, proxy code hash, and for a record the Safe transaction hash, nonce and the owners that signed); `evidence-check` refuses a recorded receipt without it on 8453, a submitter that is a role key or the timelock, and (with `--rpc`) a record whose Safe emitted no `ExecutionSuccess` for the recorded hash.

**Deployer nonce (not fresh).** The first rehearsal's deployer was last observed at about nonce 118 and moves on; the number is not fixed and nothing depends on it. In rehearsal mode the run manifest records `deployerStartNonce` at the FIRST deployer stage, before the first transaction. Every later stage must start at the recorded start plus the stages' counts before it (plus the prove-control transaction after it); a stray deployer transaction before, between or after stages is refused; the end nonce is start plus the summed counts plus the proof; the verifier and `evidence-check` (`deployer_start_nonce`) count from the same start. The recorded start is read from the manifest on resume, cross-checked against the first stage's own record and, before any stage has started, against the chain: it is never rewritten. The frozen per-stage counts are deltas and do not change. Production stays absolute from nonce 0.

**New Safe.** The same owners, threshold and `SAFE_SALT_NONCE` predict the first rehearsal's Safe. A rehearsal sheet therefore REQUIRES an explicit `SAFE_SALT_NONCE`, and the Safe stage refuses a predicted address that already holds code with `SAFE_SALT_NONCE_REUSED` (exit 19) before anything is sent. Only a `--resume` of the same run, whose manifest recorded that address, adopts an existing Safe.

**Libraries.** All four CREATE2 libraries already sit on 8453 from the first rehearsal: tick_math is deployed by the libs stage, and TwapTickMath, BasketViews and BasketAssetConfigGuard by the PROTO stage. A second deployment therefore finds them all: the libs stage is adopted (0 deployer transactions) and the PROTO stage adopts three creations (7 transactions instead of 10), as built by issue 1721 (`effectiveCounts`, the adopted records in the run manifest, the stage table's `create2Libraries`). The relative start nonce composes with it: **expected nonce = start + sum(effectiveCounts) + proof**, at every site (the runner's stage start and end-of-deploy check, `checkNonce` and `finalDeployerNonce`, the verifier, `evidence-check` offline and with `--rpc`, `rehearsal-counts.ts`). The start is recorded at the first stage (safe), before libs is adopted. With all four libraries present the final nonce is start + (sum - libs count - 3) + 1. The evidence carries `deployer_start_nonce` and each adopted stage's `deployer_txs`, bounded by the table. A run that adopts any stage consumes frozen counts but can never produce them: do not measure on 8453 (a marked counts file is Twin-only). A new sha gets its frozen file by rebuilding the baseline from the adopted Twin measuring run (`freeze-counts.ts --from-adopted-run`, section 3, issue 1733); the 9a768bb9 file is only the optional `--cross-check` reference. The Twin job pre-deploys the four libraries (`predeploy-libs`) so libs and the first basket stage are adopted there too. 1723 (read-after-write safe reads) and 1724 (getLogs scan) are separate issues and are not duplicated here.

**Funding for a new run** (numbers from the plan owner's `ops fee-estimate` measurement of the 114-transaction run at 5x margin, 0.00234478 ETH, not stored in the repo: re-run `ops fee-estimate` at the tagged SHA before funding): about 0.00234 ETH for the tool plus 0.0000242 ETH for stage 13, recommended 0.00237 ETH, and the extra Safe `execTransaction` gas of the rehearsal rows (10 more Safe transactions: two each for register-submitter, apply-receipt, update-delay, batch and cancel, plus the submitter Safe's creation and its `execTransaction` for the receipt, both paid by the deployer; stage 13's 8 Safe transactions cost 0.0000242 ETH, so these are about 0.00003 ETH, an estimate to re-measure) plus no funding for the submitter: it is a Safe and the deployer pays its gas. The owner funds about 0.005 ETH in total. USDC: 1 for the seed plus 1 per vault test deposit times 4, so 5 USDC. The reused deployer holds 0.00456 ETH (enough) and 4.5 USDC (0.5 USDC short; the first rehearsal's second sitting needs 4 USDC and returns most of it).

**Key tool steps.** No key is generated: the first rehearsal's keystores are reused. 1) `publish-contracts ops fee-estimate` for the numbers above at the tagged SHA. 2) Copy the example sheet, type the public addresses, set a NEW `SAFE_SALT_NONCE`. 3) Tag `release/<version>-rehearsal` on the Twin-rehearsed SHA (the plan owner cuts it; never move `release/v0.4.0-base`). 4) `publish --stage plan` (the gate checks the rehearsal tag), then `publish`, `verify`, `govern`, `verify` as usual with the deployer keystore typed at the hidden prompt and the three Safe owner signers. 5) The receipt path above. 6) `update-delay`, `batch`, `cancel` rows in that order. 7) Evidence with `deployment_kind: rehearsal`, `deployer_start_nonce`, `rehearsal_rows`, `submitter_registrations`, `recorded_receipts` and `receipt_applications`, checked with `evidence-check --deployment-kind rehearsal`. The mode is selected explicitly in the sheet and by the `-rehearsal` tag; nothing selects it by default.

The Twin job (`core-stages-twin-chain`) runs this whole path in the rehearsal kind at 900 s with a REAL recorded receipt: a non-fresh deployer, a new salt, the three unpauses and the other rows, the submitter registration (`register-committee` on v0.5.0, `register-submitter` in the target), `record-receipt` through a throwaway SUBMITTER Safe (`--submitter`, the deployer pays the gas), `apply-receipt`, a third `verify` and the receipt-path evidence check. The Twin proves execution only; it is not evidence that mainnet governance works.

**Run-day: public mainnet dapp checks (issue 1729).** Before the public tunnel points at the mainnet dapp, open it with a wallet on Ethereum (1) and with a wallet on the Twin chain (918453). Each must show the red "Base mainnet — real funds" banner and the "Switch your wallet to Base (chain 8453)" screen, with no deposit or withdraw control. Switch to Base: the app loads and the banner stays. The guard is described in `docs/development/stage-deployment.md`.

Also check the class the deployed bundle reports. **The bundle check is the real one.** `VITE_ENV_CLASS` is build time only, so fetch the main JS bundle and confirm it contains `"mainnet"` as the baked class (for example `curl -s <dapp url>/assets/index-*.js | grep -o 'VITE_ENV_CLASS:"[a-z]*"'`). The `/config.json` check is weaker and must be read precisely. On the stage host a missing `/config.json` is answered by the single page app fallback: `index.html` with HTTP 200. A text search of that HTML for `VITE_ENV_CLASS` finds nothing, so "the served `/config.json` has no `VITE_ENV_CLASS`" passes trivially when no document is served (the dapp then logs a console warning and uses its build time values). Check it as a JSON parse of the response: it passes meaningfully only when the response parses as a JSON object without a `VITE_ENV_CLASS` key. `bun scripts/stage/dapp-served-check.ts <dapp url>` does both checks (`PASS served /config.json` says when the pass is trivial, `PASS bundle class` is the one that proves the class) and exits 1 on a fail. On a mainnet build any address in a served `/config.json` is ignored. Then load the page: the red banner must show. A page that shows no banner must not be exposed. The stack must have been built through `core-stack dapp up --chain 8453` (its overlay sets `VITE_ENV_CLASS=mainnet` as a build arg). A bundle built from the base `docker-compose.dapp.yaml` defaults to class fork and has neither the banner nor the guard. Treat explorer API data as untrusted: it is display only, and writes read the chain.

### 4.11. Redeploy one vault into a live deployment (issue 1796, an experiment on Deploy 2)

`redeploy-vault --vault PROTO` deploys a new rmPROTO closed and unregistered, binds the existing registry once, hands every role to the timelock and the emergency key, and drops the deployer. Govern row `redeploy-vault` then runs ONE timelock batch of six calls (register new, copy the router cap, five-leg migration, four-leg migration, retire old, unpause new). Tests: `contracts/test/RedeployProtocolAssetVault.t.sol`, `publish-contracts/tests/redeploy-vault.test.ts`.

Owner decision 2026-10-13: redeploying ONE vault into a live deployment is an experiment on the Base mainnet REHEARSAL deployment (section 4.10, `DEPLOYMENT_KIND=rehearsal`) and on the Twin chain. The verb and the row are refused on 8453 in production. Whether a final deployment may use it is an open owner decision. Only rmPROTO can be redeployed. The specification, with the reasons for each step and the failure table, is `docs/technical/single-vault-redeploy.md`; this section is the operator procedure. The old vault keeps its shares: its holders exit through `redeem` and `redeemInKind` (ADR-0009: a retired vault is withdraw-only). The flags and evidence fields are in `publish-contracts/README.md`.

**Acceptance has two halves.** The code half is the tooling below and its tests (the implementation (1797), plus QA plan v1 E1 and E2). The operator half is one run of this procedure on the Base mainnet rehearsal deployment, with its evidence recorded under `deployments/base-8453-rehearsal/`. The issue closes only when both exist.

**Before the round.**

- The `--evidence` directory of the run that deployed the rehearsal: its `publish-run.json` with the timelock stage done and stage 13 executed.
- A release tag `release/<version>-rehearsal` on the fix SHA, with green CI. The verb runs the release gate on 8453, and so does the `govern --row redeploy-vault` run at that SHA (QA plan v1 E4). No frozen counts file is needed for the fix SHA.
- On chain: the old rmPROTO Active and router-eligible; `router.votedWeightsActive()` false (the redeploy row runs only on a deployment with no applied receipt vector, and nothing clears one: issue 1988); the timelock holds `ADMIN_ROLE` on the registry and on the router (the batch's cap call needs the router role). The row refuses to schedule in any other registry or router state, and nothing is sent.
- A second checkout at the ORIGINAL deployment SHA, built with `forge build`. Its `out/` is the `--prior-out` of the verify in step 3.
- Inventory and cancel conflicting queued operations, as `single-vault-redeploy.md` section 2 requires.

**Steps.**

1. **Deploy (the DEPLOYER signs).** `bun publish-contracts/src/cli.ts redeploy-vault --vault PROTO --chain 8453 --rpc $RPC --sheet <frozen sheet> --signer <deployer> --environment <env> --core-sha <fix SHA> --evidence <run dir>`. Run it once with `--dry-run` first: that simulates only. The script `RedeployProtocolAssetVault.s.sol` deploys a new rmPROTO from the same config file and sheet inputs as the launch vault. It pauses the vault right after creating it, before the first asset is added, so no direct deposit can land while it is configured. It links the existing registry once (`setRegistry`; the S5 guard allows this one script to bind the unopened replacement), hands `ADMIN_ROLE` to the timelock and `EMERGENCY_ROLE` to the emergency key, drops both from the deployer, and leaves the vault unregistered. The verb keeps the old vault manifest as `protocol-asset-vault.retired-N.json`, writes the new address into `protocol-asset-vault.json`, and records the round in `publish-run.json` `vault_redeploys` with status `deployed`. The round is saved only after the typed confirmation, so a refused confirmation sends and records nothing (QA plan v1 E2).
2. **Govern (the Safe, through the timelock).** `bun publish-contracts/src/cli.ts govern --row redeploy-vault --core-sha <fix SHA>` with the usual chain, RPC, sheet, signer, environment, evidence and `--owner-signer` arguments. It schedules the batch of six calls: `registry.registerVault(new)`, `router.setVaultCap(new, vaultCap(old))`, `registry.migrateEligibility(new, true, five legs)`, `registry.migrateEligibility(old, false, four legs)`, `registry.retire(old)`, `new.unpauseDeposits()`. The cap is `router.vaultCap(old)` as the row read it when it planned the round. `vaultCap` is keyed by address and a new address reads 0, which the router treats as uncapped, so the cap lands before the new vault becomes eligible. The first run schedules and exits `GOVERN_PENDING` (exit 15). The same command after the delay executes the batch. The read-back checks the registry statuses, the eligibility, the router cap, the router's default and effective vectors and the deposit state; a failed read-back exits `GOVERN` and records nothing as governed. The row may also run at the original SHA, with the same operation (QA plan v1 E1).
3. **Verify at the fix SHA.** `bun publish-contracts/src/cli.ts verify --core-sha <fix SHA> --prior-out <out/ of the checkout at the original SHA>` with the usual arguments. The replacing vault is compared with this checkout's build, and every other contract with `--prior-out`. The labels `retired[rmPROTO]: ...` and `redeploy[rmPROTO]: ...` check both generations, including `redeploy[rmPROTO]: router per-address cap equals approved old cap`. A verify at the original SHA, or at the fix SHA without `--prior-out`, is refused before any signer exists, so it can never fail and pause all four vaults. So is every other run that reaches the verify stage at either SHA: the default stage set with `--resume`, `--stage all`, or a `--stage` list naming verify. Run the verify alone. A passing verify writes `verified_at_sha` and `prior_out_sha` on the round (QA plan v1 E1).
4. **Evidence.** `bun publish-contracts/src/evidence-check.ts --vault-redeploys <publish-run.json> --registry <registry> --timelock <timelock> --deployment-kind rehearsal --rpc $RPC`. Run it after step 3 passed: a round at the fix SHA needs `verified_at_sha` (the fix SHA) and `prior_out_sha` (the original SHA). It checks the entry's shape (including `router_vault_cap`), every deploy receipt, the six `CallScheduled` and `CallExecuted` events rebuilt from the entry, and the delay. Copy the `vault_redeploys` entry into the evidence file, and file the run under `deployments/base-8453-rehearsal/`.
5. **Round trip.** The 1 USDC router deposit and its redeem in `single-vault-redeploy.md` section 4, step 5. Record the four legs and the redeem proceeds.

**Interrupted versus atomic.** The deploy is several broadcast transactions and can die part-way: the round stays `started`, the vault stays closed and unregistered, a fresh run is refused, and only `--resume` with the same arguments continues it. The govern batch is atomic: one reverting call reverts all six, the chain is unchanged, and the same command executes the same operation again after the cause is fixed.

**Local pause is a possible whole-router revert.** A vault paused locally with `pauseDeposits()` while the registry still says Active and router-eligible is counted as depositable by the router. Its own pause then reverts the whole router deposit (all-or-revert), not just its leg. Only a registry status change or an eligibility migration makes the router skip the leg. Pause monitoring must cover both generations of rmPROTO.

**Stale operations.** A pause-all recorded after the batch was scheduled stops the batch from executing (its last call unpauses the new vault): cancel the operation through the Safe, then open a fresh round. An unpause or receipt operation scheduled before the cutover is refused or cancelled: the unpause row plans against the manifest's current vault, so the old operation is a different one, an apply-receipt vector that no longer matches the router-eligible set is refused, and a receipt released after its schedule is refused at execute time.

**Deposit guide and clients: holdings and history stay address-specific.** After the cutover the deposit guide names the current rmPROTO address (the verified overlay `current-vaults.json`, never the original manifest), its expected code hash, the effective split, the retirement block of the old vault and the old-holder exits (`redeem` for USDC, `redeemInKind` for the underlying assets). Retired old holdings are shown as their own line at the old address. The explorer API keys `/v1/accounts/:address/positions` and `/history` by vault address and the dapp position selector keys and selects by address, so one holder of both generations sees two positions and two histories, never one merged rmPROTO row. Tests: `retired_generation_keeps_address_specific_holdings_and_history` (explorer API, `clients/explorer-api/tests/endpoints.rs`), `cutover_interval_backfills_old_and_new_generation_exits_and_survives_restart` (indexer: the retired vault stays watched, the new vault is discovered inside the cutover interval, a restart from the saved cursor keeps both). Old shares are never moved.

**Restore-old recovery (needs separate approval, never automatic: the old vault keeps the known redeem defect).** `buildRestoreOldCalls` builds one inverse batch of four calls: `reactivate(old)` first, then two matching eligibility migrations (old joins at 0 bps beside new, then new leaves and old takes its slot at the unchanged weight), then `retire(new)`. Retirement stops deposits only: holders of the new vault keep `redeem` and `redeemInKind`. The order is proven on the real contracts by `test_restoreOld_*`.

### 4.12. Governed proxies: release mode, freeze ownership, deadline and the voluntary cutover (issue 1809)

Upgradeability stage 2. The contracts (issue 1808) and the clients (issue 1810) are in place; this section is how a release deploys, verifies, records and later freezes the governed proxies. Canonical design: `docs/technical/contract-upgradeability-plan.md` and `docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md` (Proposed). A CI test (`publish-contracts/tests/upgrade-runbook-drift.test.ts`) checks that the stage table, the labels and the sheet names below agree with the code.

**Release mode.** One required sheet line, `UPGRADE_MODE`, with no default: `frozen` freezes upgrades inside every proxy's atomic initializer, `upgradeable` leaves every proxy upgradeable through the Safe and the timelock. The sheet declares one mode for every proxy of the release; the manifests, the verifier and the evidence record it per proxy. `UPGRADE_FREEZE_DEADLINE` (ISO 8601 UTC, for example `2027-01-31T00:00:00Z`) is the proving-period deadline of an upgradeable release. It is required for an upgradeable PRODUCTION release on 8453 and refused with `frozen`. A deploy run also refuses a deadline in the past or sooner than now + `TIMELOCK_MIN_DELAY` + 1 day (`SHEET`, before any stage broadcasts), because the Safe could not schedule and execute the freeze in time; the follow-on verbs (`verify`, `govern`, `pause-all`) accept the deployment's deadline as it nears. A run never changes its mode: the run manifest records `upgradeMode`, and `--resume` under another mode is refused (`RESUME`, exit 16) before any forge call.

| Release | `UPGRADE_MODE` | `UPGRADE_FREEZE_DEADLINE` | Core immutability claim |
| --- | --- | --- | --- |
| Final mainnet, fixed at launch | `frozen` | none | made by verify only when the full core set verifies frozen on chain |
| Final mainnet, production proving period | `upgradeable` | required | none until governance has frozen every proxy and verify passes |
| Twin, rehearsal, contained mainnet test | either | optional | as above |

The committed Twin sheet, the 8453 rehearsal example and the production fixture sheet declare `frozen`.

**Stage order and transactions.** The vaults system's proxy stages run in this order, each before the `timelock` stage, which deploys the upgrade authority LAST. The `gateway` stage belongs to the gateway system: it runs in its own run after the vaults run and names its own explicit upgrade timelock (`GATEWAY_UPGRADE_TIMELOCK`, nonzero, with code), never the core timelock and never a default (issue 1892; production governance of the gateway is an open decision, `docs/architecture.md` §10). The table is pinned to `scripts/deploy/stage-table.json` by `tests/upgrade-runbook-drift.test.ts`; the table carries the one `receipt` row (issue 1888) before `governance`:

| Stage | Proxy (manifest field) | Implementation (manifest field) | Implementation contract |
| --- | --- | --- | --- |
| `vault` | `vault` | `vault_implementation` | `RobotMoneyVault` |
| `registry` | `registry` | `registry_implementation` | `VaultRegistry` |
| `router` | `router` | `router_implementation` | `PortfolioRouter` |
| `receipt` | `consensus_receipt` | `consensus_receipt_implementation` | `ConsensusRecommendationReceipt` |
| `governance` | `governance` | `governance_implementation` | `RouterGovernance` |
| `proto` | `vault` | `implementation` | `ProtocolAssetVault` |
| `rwa` | `vault` | `implementation` | `RwaBasketVault` |
| `gateway` | `gateway` | `gateway_implementation` | `RobotMoneyGateway` |

Each proxy is 2 deployer transactions: the implementation, then the `ERC1967Proxy` whose constructor runs `initialize` atomically. The mode changes no count, so a frozen count measured on the Twin chain in one mode holds for the other. The deterministic address assumption is the timelock: every proxy names, from its first block, the CREATE2 address of the exact Safe-proposer `ProposerFloorTimelock` (an OpenZeppelin `TimelockController` that refuses to drop its last proposer), from the factory `0x4e59b44847b379578588920cA78FbF26c0B4956C`, the salt `robotmoney.core.timelock.v1` and `SAFE_ADDRESS` and `TIMELOCK_MIN_DELAY`. Nothing else can hold code there, so no interim deployer upgrade path exists. The stage table (`scripts/deploy/stage-table.json`, `proxies` on each stage and `upgradeAuthority`) carries the same facts.

**Resume after a partial failure.** A proxy stage that dies part-way stays `started` in the run manifest. Rerun with `--resume` and the same arguments: forge replays the stage's own transactions at the same nonces, so its proxy and implementation addresses do not move. After every proxy stage the runner checks the stage manifest: each proxy and implementation address, `upgrade_timelock` equal to the pinned timelock prediction, and `upgrade_mode` equal to the sheet's mode. Anything else stops the run (`MANIFEST`, exit 12) with the stage left `started`. Stop and read the chain before anything else runs.

**Timelock pin and a timelock deployed by someone else (issue 1835).** The `vault` stage, the first proxy stage, records `timelockPrediction` (address, init code hash, Safe, delay) on its record in `publish-run.json`, derived from the build's `ProposerFloorTimelock` artifact. Every later proxy stage (`registry` to `rwa`) and the timelock stage recompute it after their simulation and refuse with `MANIFEST` (exit 12), nothing sent, when it differs (issue 1853). A difference means the build, the Safe or the delay changed since the first proxy stage (another solc or foundry version changes the CBOR metadata, so the address): rebuild with the toolchain and inputs of the first proxy stage. **A run manifest from a release before 1835** has a done `vault` record with no `timelockPrediction`. The next proxy stage backfills it only when all of these agree (issue 1866): `upgrade_timelock` in the `vault` manifest, `upgradeTimelock()` on chain of every proxy of the `vault` stage, `upgrade_timelock` in the manifest of every other done proxy stage plus one on-chain `upgradeTimelock()` read per such stage, and the recomputed prediction. It then logs `stage.timelock_pin_backfilled` and continues. Otherwise it refuses with `MANIFEST`, nothing sent: restore the `vault` manifest, rebuild with the toolchain, Safe and delay the `vault` stage used, or (chain and manifest disagree) stop and read the chain. Do not try to rerun the `vault` stage: the runner refuses a stage whose manifest exists. A refusal or error between a stage's simulation and its broadcast (these pin checks, a `cast` failure, `COUNT_MISMATCH`, an adoption refusal) removes the manifest that simulation wrote when the run is neither resumed nor dry, so after fixing the cause run the same command again; no manual manifest deletion. A `vault` stage started by an earlier release that landed transactions without a pin is refused on `--resume`: finish it with the release that started it, and the next proxy stage backfills the pin. Anyone can deploy the timelock at the prediction once the proxies are on chain. The stage script then reuses it and plans one transaction fewer. The CLI accepts that only when the runtime code at the prediction hashes to the build's `ProposerFloorTimelock` runtime code: the stage then sends the frozen count minus one and records `adopted: true` with `adoption.libraries: [{ name: "TimelockController", address, codeHash }]`, and the nonce checks count what was sent. Other code, or no code, keeps the frozen count, so the shortfall is `COUNT_MISMATCH` (exit 10), nothing sent. In the evidence the timelock stage may list that one adopted entry (`evidence-check` caps it by the stage table).

**What verify proves and records.** Per proxied core contract (the full set above), the verifier reads the chain and pushes these labels:

- `is the build's proxy with no admin and no beacon`
- `implementation slot equals the manifest`
- `implementation links the build's libraries`
- `upgradeTimelock() is the deployed timelock`
- `initialized once and not initializing`
- `upgradesFrozen() agrees with the release mode`
- `manifest upgrade_mode equals the release sheet`
- `storage layout identifier recorded`

The implementation code itself is the existing `runtime code equals build artifact (masked)` label. Three release labels follow: `upgrades: the sheet declares the release mode`, `upgrades: the freeze deadline is not missed` and `upgrades: core immutability is claimed only when the full core set verifies frozen on chain`. The gateway manifest's two runtime hash pins (the signing clients' pins, issue 1810) are fail-closed (issue 1842): `gateway_implementation_runtime_hash` must be present and equal the live implementation code hash, and `gateway_runtime_hash` must be present and equal the live proxy code hash. In an `upgradeable` release a proxy that reads `upgradesFrozen()` true passes `upgradesFrozen() agrees with the release mode` only when its `UpgradesFrozen` log sits in a transaction where the deployed timelock executed `freezeUpgrades` on it (a governed freeze after deployment). A proxy frozen in its initializer fails. On 8453 source verification covers the proxy and the implementation of every proxied contract (`source[<name> implementation]`).

Verify writes `deployments/<chain>/upgradeability.json` on every run, pass or fail. For each proxy it records the proxy and implementation addresses, both runtime code hashes, the layout file, and `layout_id`, which is the keccak256 of the committed layout snapshot followed by `pins.json`. It also records `upgrade_timelock`, `upgrades_frozen`, `initialized_version` and `manifest_upgrade_mode`, and for a governed freeze `freeze_block` and `freeze_tx`. For the release it records the timelock and its delay and `core_immutable`. It lists the parameters a freeze leaves governed and the upstream dependencies it does not control. `core_immutable` is true only for a frozen release whose full core set verified frozen with every check of the run passing; otherwise `immutability_refused_because` says why. Copy the file into the evidence as `upgradeability`. `evidence-check` refuses a missing or partial record, a claim it cannot back, and dropped list entries. With `--rpc` or `--chain-fixture` it reads every proxy fact back from the chain.

**Freeze ownership.** The freeze of an upgradeable release belongs to the governing Safe's owners (`SAFE_OWNERS`, at the sheet's `SAFE_THRESHOLD`): only they can propose on the timelock, which is the only freeze authority. The per-release runbook (section 5) names the release owner, the Safe signers who will sign the freeze, and a backup signer for each. The release owner schedules the freeze, and the signers sign it.

**The freeze round: `govern --row freeze-upgrades`.** First run `verify`, so `upgradeability.json` is current. Review the pending timelock operations and cancel every pending upgrade through the Safe: a queued upgrade must not run after the review. Then run `bun publish-contracts/src/cli.ts govern --row freeze-upgrades` with the release's usual `--chain`, `--rpc`, `--sheet`, `--signer`, `--owner-signer` and `--core-sha` arguments. The row reads the latest `upgradeability.json` and refuses (`GOVERN`, nothing scheduled) while any upgrade operation is still pending on the timelock, or when a proxy's live implementation or code hash no longer matches the record. It prints a `govern.preview` line per proxy (the proxy address, the expected implementation and the expected code hash) for the signers to compare with what they sign. It then schedules ONE timelock batch of `freezeUpgrades(expectedImplementation, expectedCodeHash)`, one call per unfrozen proxy, with both values taken from the record (`implementation`, `implementation_code_hash`). The call reverts if an upgrade landed in between, so a queued freeze can never lock in a version nobody reviewed. On 8453 the run exits `GOVERN_PENDING` with the ready time; the same command after the delay executes the batch, reads `upgradesFrozen()` back on every proxy and records the operation and its schedule and execute transactions in the run manifest (`upgrade_freezes`). Then run `verify` with the release's own sheet (still `upgradeable`: the manifests recorded that mode). Once every proxy of the full core set reads `upgradesFrozen()` true and every check passes, verify makes the immutability claim and records `core_immutable` true. The watchdog pages each executed freeze once (issue 1810).

**The deadline is not an on-chain freeze.** Nothing on chain freezes a proxy when `UPGRADE_FREEZE_DEADLINE` passes. The deadline is the Safe signers' commitment. Schedule the freeze no later than the deadline minus the timelock delay minus one day of margin: on 8453 production that is at least 72 hours before the deadline.

**Missed-deadline alerts.** The signal is the verify stage. From the deadline minus (timelock delay + 7 days), the release owner runs `verify` on 8453 at least once a day and posts the result in the release tracking issue (section 6). Inside the window `upgrades: the freeze deadline is not missed` still passes, and its detail starts with the alert state, names every unfrozen proxy that has no freeze pending on the timelock (`CallScheduled` of `freezeUpgrades`, operation still pending) and the time by which `govern --row freeze-upgrades` must be scheduled.

| When | Condition | Verify detail | Who is alerted |
| --- | --- | --- | --- |
| deadline minus (timelock delay + 7 days) | any proxy still reads `upgradesFrozen()` false and no freeze is scheduled | starts with `WARN` (label passes) | the release owner and the named Safe signers: schedule the freeze now |
| deadline minus (timelock delay + 1 day) | still no freeze scheduled | starts with `ESCALATE` (label passes) | the release owner escalates to every Safe owner: this is the last safe moment |
| deadline passed | any proxy still reads `upgradesFrozen()` false | `upgrades: the freeze deadline is not missed` fails (`VERIFY`, exit 13), with a detail that starts with `MISSED` and names every unfrozen proxy | the release owner pages every Safe owner and records the miss in the tracking issue |

After a miss the deployment stays reported as upgradeable everywhere until every proxy verifies frozen: `core_immutable` stays false, the explorer reports `upgrade_state` `upgradeable`, and the dapp shows the gateway as upgradeable. Never describe the release as immutable before that.

**Twin rehearsal of the lifecycle (issue 1811).** At every `DEPLOY_SHA`, the CI job `core-stages-twin-upgrade-lifecycle` (suite 28, in the deploy-gate list) rehearses the whole lifecycle with the exact release artifacts of the SHA on the Twin chain. It publishes with the committed Twin sheet plus the overlay `deployments/twin-918453/upgrade-rehearsal.env` (`UPGRADE_MODE=upgradeable`). The overlay names no deadline: `twin-publish` sets `UPGRADE_FREEZE_DEADLINE` to the pin block timestamp plus 365 days (issue 1846). Then `publish-contracts/src/ci/twin-upgrade-lifecycle.ts` runs these steps through the real Safe (two owners sign, the deployer pays gas) and the real timelock, with the delay passed by a Twin time warp:

1. Record the deployment: every proxy upgradeable, no immutability claim.
2. Run `deploy-implementation --proxy gateway` (issue 1861): it deploys a second copy of the gateway implementation from the build, linked to the live libraries, and records `implementation_deploys`. A rerun with the same arguments reuses the entry. Run `govern --row upgrade-proxy --proxy gateway --implementation 0x<new>`: it schedules and executes `upgradeToAndCall(newImplementation, "")` on the gateway proxy, re-records the gateway manifest's implementation pin and records `proxy_upgrades`. Run verify.
2b. Upgrade a v0.5.0-shaped receipt with its typed migration (issue 1910). The harness builds a populated v0.5.0 receipt proxy (`LegacyConsensusRecommendationReceipt` behind an ERC1967 proxy under the same timelock, two receipts, one released, `ADMIN_ROLE` on the timelock and on RouterGovernance), deploys a second copy of the current receipt with `deploy-implementation --proxy receipt`, and runs `govern --row upgrade-proxy --proxy receipt --implementation 0x<new> --migration receipt-submitter-roles` against a copy of the manifests that names that proxy. It asserts `RECEIPT_RELEASER_ROLE` on RouterGovernance only, `ADMIN_ROLE` on the timelock only, the receipts and the retired slots unchanged, and a second `migrateToSubmitterRoles` reverting with `InvalidInitialization`. Then `evidence-check --governed-upgrades --rpc` reads the scheduled data back from the chain and a copy of the entry without its migration fails.
3. Run `govern --row freeze-upgrades --no-warp --max-wait 0`: it schedules ONE batch of `freezeUpgrades(implementation, implementation_code_hash)` on all nine proxies, with both values taken from the `upgradeability.json` the verify of step 2 wrote, and exits 15 (`GOVERN_PENDING`) before the execute.
4. Queue a second gateway upgrade before the freeze executes, and leave it pending. It goes through the Safe tool library: the freeze row refuses to schedule while an upgrade is pending, so the upgrade is queued between the schedule and the execute.
5. Run `govern --row freeze-upgrades` again: it executes the batch, reads every proxy frozen and records `upgrade_freezes`. The harness checks both run manifest lists as evidence-check does.
6. Ask the Safe to execute the queued upgrade. The Safe tool refuses, and a simulated execute reverts with `UpgradesAreFrozen`.
7. Run verify again. It claims core immutability.

The record `upgrade-lifecycle.json` is checked by `bun publish-contracts/src/evidence-check.ts --upgrade-lifecycle FILE --rpc URL`, which reads every transaction, the refused operation and every proxy fact back from the chain. A Twin run proves the operations execute on the real contracts in this order. It does not prove the 48 hour delay or the mainnet signers.

**The governed upgrade procedure: `govern --row upgrade-proxy` (issue 1842).** Only while the proxy is unfrozen. Each step in order:

1. **Layout review.** Build the new implementation from a reviewed core commit. Its storage-layout snapshot (`contracts/test/fixtures/storage-layout/<Contract>.json`) passed `scripts/ci/check-core-storage-layout.sh` in CI against the deployed release's baseline. Review the snapshot diff: rows and members may only be appended.
2. **Deploy the implementation.** Run `bun publish-contracts/src/cli.ts deploy-implementation --proxy NAME --upgrade-build DIR` with the release's usual arguments and the deployer as `--signer` (issue 1861). It reads the proxy's live implementation and fills every library link placeholder of `DIR/out`'s artifact with the address the live implementation links. It refuses (`REFUSED`, nothing sent) when the proxy reads `upgradesFrozen()` true, when `DIR`'s layout snapshot does not extend the deployed snapshot append-only (the same gate as step 3), when the build links a library the live implementation does not link, or when the live implementation links a library the build does not name. It sends ONE CREATE from the deployer, reads the runtime code back and compares it with the build artifact (immutables and library links masked, as verify does). A mismatch exits `VERIFY` and records nothing: never upgrade to that address. On success it records an `implementation_deploys` entry in the run manifest and prints the exact `govern --row upgrade-proxy --implementation` command for step 3. A rerun with the same arguments reprints the recorded entry and sends nothing. On 8453 the release gate runs first, as for `govern`. The new implementation holds no state and no role: its constructor disables initializers.
3. **Schedule.** Run `bun publish-contracts/src/cli.ts govern --row upgrade-proxy --proxy NAME --implementation 0x<new> --upgrade-build DIR` with the release's usual arguments. `NAME` is the verifier name (`gateway`, `registry`, `router`, `governance`, `receipt`, `vault[rmUSDC]`, `vault[rmPROTO]`, `vault[rmAGENT]`, `vault[rmRWA]`). `DIR` is a core checkout at the commit the implementation was built from, after `forge build` (default: the DEPLOY_SHA checkout, for a new copy of the release implementation). The row refuses (`GOVERN`, nothing scheduled) when the proxy reads `upgradesFrozen()` true, when `DIR`'s layout snapshot does not extend the deployed snapshot append-only (the snapshot in the DEPLOY_SHA checkout, whose layout id must equal the one `upgradeability.json` recorded), or when the code at the new implementation is not `DIR/out`'s build artifact (immutables and library links masked, every linked library's code compared too). It prints a `govern.preview` line with the old and new implementation and their code hashes, then schedules ONE timelock call, `upgradeToAndCall(newImplementation, "")`, through the Safe. With `--migration NAME` the data is the typed migration instead (see "Typed migrations" below). The generic raw `--call-data` row stays Twin-only and is refused on 8453.
4. **Execute.** On 8453 the run exits `GOVERN_PENDING`. After the delay the same command executes it through the Safe and reads the implementation slot back.
5. **Re-record.** The same run then rewrites the proxy's stage manifest: the implementation field and, for the gateway, `gateway_implementation_runtime_hash` and `gateway_runtime_hash` from the chain. It records the operation and both transactions in the run manifest (`proxy_upgrades`, with the `build` the implementation came from). The re-record is gated on the live implementation slot (issue 1859). A rerun of an older row after a later upgrade (B to C, then the B row again) finds the proxy on C: it reprints the row and leaves the manifest and the entry unchanged. An operation executed outside the row (the run died after the Safe execute was mined, or another signer executed it through the Safe UI) is adopted when the same command runs again: the slot read-back passes, the manifest is re-recorded, and the entry takes the execute transaction from the timelock's `CallExecuted` log of the operation. When no such log is found the entry records `execute_tx` null with a `note`, which evidence-check accepts. `govern --row freeze-upgrades` does the same for `upgrade_freezes`, gated on the `upgradesFrozen()` read-back.
6. **Verify.** Run `verify`: it re-records `upgradeability.json`. Copy it into the evidence.

**Typed migrations (issue 1910).** An upgrade that must run state migration code in the same `upgradeToAndCall` names a typed migration with `--migration NAME`. The operator never supplies calldata. The tool builds it, and there is exactly one name today: `receipt-submitter-roles`, valid only with `--proxy receipt`. It is `migrateToSubmitterRoles(releaser)` (a `reinitializer(2)` that only the upgrade timelock may call). The tool resolves the function from the ABI of `DIR/out`'s `ConsensusRecommendationReceipt` artifact (`--upgrade-build DIR`) and takes `releaser` from the `governance` field of the governance stage manifest, the RouterGovernance address of the deployment. The bytes must equal the reviewed one-line signature `migrateToSubmitterRoles(address)`. The row refuses, with nothing scheduled, an unknown name, a migration on a proxy that has none, a build ABI that lacks the function or declares it differently, and a governance address that is missing or zero. Its `govern.preview` line decodes the migration for the signers: `migration`, `migration_function` (`migrateToSubmitterRoles(releaser = 0x<governance>)`), `migration_selector` and `migration_data_hash`. Compare the releaser with the RouterGovernance address in the deployment manifest before signing. The Safe schedules ONE timelock call, `upgradeToAndCall(newImplementation, <migration data>)`. The migration is part of the operation: its row key and its salt carry the migration name, so a plain upgrade to the same implementation is a different operation. The `proxy_upgrades` entry records the `migration` (name, function, selector, releaser, data, data hash). `bun publish-contracts/src/evidence-check.ts` checks the entry offline (the data is recomputed from the name and the releaser, the releaser must be the deployment's RouterGovernance) and, with `--rpc`, reads the schedule transaction back from the chain: the timelock's `CallScheduled` data must be `upgradeToAndCall(to_implementation, typed migration data)` for an entry with a migration and `upgradeToAndCall(to_implementation, "")` for an entry without one, so an entry can neither claim a migration the chain did not schedule nor hide one it did. `checkEvidenceOnChain` runs the same read for every `proxy_upgrades` entry of a production or rehearsal evidence file. `bun publish-contracts/src/evidence-check.ts --governed-upgrades RUN_MANIFEST --timelock ADDR --governance ADDR --rpc URL` runs it on a run manifest alone. Before the schedule on the live receipt proxy, read its initialized version (the Initializable slot, 1 before the migration), the `ADMIN_ROLE` holders (the timelock and RouterGovernance) and its upgrade timelock from the chain, because the row does not (gap RM-1022-2 in `docs/audits.md`). A proxy already at version 2 reverts the whole execute with `InvalidInitialization`, and no half state is written. After the execute, read `RECEIPT_RELEASER_ROLE` (RouterGovernance only), `ADMIN_ROLE` (the timelock only) and the receipt count and compare them with the preview.

**Ownership of the implementation deploy and the re-record.** Deploying the new implementation with its library links (step 2) and re-recording the stage manifest, the gateway implementation pin and the gateway runtime hashes after a governed upgrade (step 5) are owned by the operator tooling follow-up (1842). Its `govern --row upgrade-proxy` executes the re-record. The implementation deploy with library linking is the `deploy-implementation` verb (issue 1861). The Twin harness (`publish-contracts/src/ci/twin-upgrade-lifecycle.ts`) deploys its second gateway implementation through that verb, so the verb runs against the real libraries in CI. The harness then runs `govern --row upgrade-proxy` and `govern --row freeze-upgrades` themselves (issue 1859), so both rows run through the real Safe and timelock in CI. It also runs `govern --row upgrade-proxy --proxy receipt --migration receipt-submitter-roles` on a v0.5.0-shaped receipt proxy (issue 1910).

**After a governed upgrade.** Until the manifest is re-recorded from the chain (step 5 above; the Twin rehearsal runs the same row), `implementation slot equals the manifest` fails: the implementation slot of the upgraded proxy no longer equals its manifest. Then run verify, and copy the new `upgradeability.json` into the evidence. Verify reads per-proxy build directories (issue 1859): an upgraded proxy's `runtime code equals build artifact (masked)` and its library-link label compare with the `out/` of the `build` its last `proxy_upgrades` entry names (`--upgrade-build DIR`), and every other contract with the DEPLOY_SHA's `out/`. Keep that checkout in place as long as the proxy runs its implementation. Every signing client's implementation pin is updated from the new gateway manifest: the `rmpc` TOML, the dapp build env and the headless agent config. Until then the clients refuse to sign, which is the intended fail-closed behavior.

**Rollback is not assumed safe.** A rollback is another governed upgrade (`govern --row upgrade-proxy` back to the previous implementation), possible only while the proxy is unfrozen, with the same review and delay. After an upgrade that migrated state (a reinitializer in `upgradeToAndCall` data, or new storage written by the new logic), the previous implementation may not read the migrated state correctly. Never schedule a rollback without the same storage layout review as a forward upgrade. After the freeze no rollback exists: only a new deployment and a voluntary cutover change logic.

**Voluntary cutover from the current direct Base deployments (planned, not executed by this issue).** The contracts already live on Base 8453 are direct deployments. They cannot be upgraded in place, and pointing a new proxy at an implementation moves no share or permission. A governed-proxy release is therefore a NEW deployment at new addresses, and holders move by their own choice (`docs/adr/ADR-0009-vault-retirement-no-assisted-migration.md`, no assisted migration):

1. Deploy the proxied release with this tool (sections 4.3 and 4.12) at new addresses, and run verify and the evidence check. The current direct addresses stay recorded as they are and are labelled legacy (direct deployment, not upgradeable). They are never presented as upgraded.
2. Keep every legacy vault redeemable: `redeem` and `withdraw` for USDC, and `redeemInKind` for the baskets. Do not pause a legacy vault's withdrawals, and do not move a legacy holder's shares.
3. Point new deposits at the new release only after its cutover gates pass: verify green, evidence accepted, and the signing clients' implementation pins updated from the new gateway manifest (`gateway_implementation`, `gateway_implementation_runtime_hash`). The registry, router and gateway references of the new deployment are its own. Nothing in the legacy deployment is rewired.
4. Retire legacy vaults only through their own governance (registry retirement, deposits halted, withdrawals kept), as in 4.11. Holders exit and deposit into the new release themselves. The dapp and the explorer show legacy positions at their own addresses (4.11, address-specific holdings).

### 4.13. The gateway system run (issue 1892)

The rmpc gateway system (`RobotMoneyGateway` and its `GatewayWindows` library) deploys, verifies and records its evidence on its own, after the vaults system, against the vaults system's manifests. The vaults system never reads a gateway manifest (invariant `SYS-1`).

**Run.** `bun publish-contracts/src/cli.ts publish --system gateway --sheet <gateway sheet> --evidence <gateway evidence dir> ...` and `verify --system gateway` with the same arguments. The default `--system vaults` is the vaults run of the sections above. Each system has its own evidence directory and run manifest: a run manifest of one system refuses `--resume` by the other (`RESUME`). The gateway system has two stages and no `safe`, `prove-control` or `govern` stage, and the verbs `govern`, `pause-all`, `record-receipt`, `redeploy-vault` and `deploy-implementation` refuse `--system gateway` (`USAGE`).

**Sheet.** A small sheet, not the treasury sheet: `CHAIN_ID`, `EXPECTED_CHAIN_ID`, `ADMIN_ADDRESS` (the deployer), `PAUSER_ADDRESS`, `SHARE_RECEIVER_ADDRESS`, `UPGRADE_MODE`, optional `DEPLOYMENT_KIND`, and two names with no default: `GATEWAY_ADMIN_ADDRESS` (the holder of the gateway `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE` after the handover) and `GATEWAY_UPGRADE_TIMELOCK` (the gateway's own nonzero upgrade timelock, with code on the chain). Every other name is refused before any signer, forge call or broadcast: an `AGENT_*` name (the deploy authorizes no agent), `SAFE_*`, `TIMELOCK_MIN_DELAY` and every treasury name, because the vaults timelock is not an input of this system. A vaults sheet that names `GATEWAY_ADMIN_ADDRESS` or `GATEWAY_UPGRADE_TIMELOCK` is refused too. **Open decision:** which authority holds the production gateway `ADMIN_ROLE` and which timelock governs the production gateway release is not chosen (`docs/architecture.md` §10). The sheet never defaults it and never reuses the vaults timelock by omission. The production release records its choice.

**Stages.** `gateway` deploys the gateway proxy bound to the vaults system's vault and router, with `GATEWAY_UPGRADE_TIMELOCK` as its upgrade authority (the manifest `gateway.json` records `upgrade_timelock` and `upgrade_mode`; the runner refuses a manifest that names another timelock). `gateway-handover` has the deployer grant `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE` to `GATEWAY_ADMIN_ADDRESS` and revoke both from itself: 4 deployer transactions. It authorizes no agent and transfers no agent. The deployer's start nonce is recorded when the run begins (the deployer already sent the vaults run), so every nonce check is relative to it.

**Consumed manifests.** When the run begins it hashes `libs.json` (the only vaults manifest the gateway reads: it binds no vault and no router, core 1895) and refuses to start if one is missing (`INPUT_MISSING`). The verifier fails `vaults system: the manifests this run consumed are unchanged since it began` when one changed.

**Verify.** The gateway verifier checks the gateway proxy and implementation against the build and the manifest pins, the gateway reads the sheet's upgrade timelock, the admin roles are held by the gateway admin and not by the deployer, the pauser holds `DEPOSIT_PAUSER_ROLE`, and the deployer nonce equals its start plus the gateway stages' frozen counts. Two chain-backed labels read the gateway's logs up to the handover block: `agents: no AgentAuthorized log on the gateway up to the handover block` and `agents: no AGENT_ROLE grant on the gateway up to the handover block`, so a run that authorized an agent before the handover fails. A depositor's own agent after the handover is theirs and does not fail it. A failed gateway verify fails the run and pauses no vault.

**Counts and evidence.** One frozen file per DEPLOY_SHA (`deployments/frozen-counts/<sha>.json`) holds both systems' counts: a Twin run of the gateway system adds `gateway` and `gateway-handover` to the file and changes no count already in it; a run on 8453 needs them already reviewed in the file. Each system sums its own stages only. The gateway evidence names `system: "gateway"` and is checked by `evidence-check` on its own (`publish-contracts/src/evidence-gateway.ts`): its two stages, the explicit upgrade timelock, the admin, the consumed vaults addresses, `agents_at_handover: 0` and the nonce from `deployer_start_nonce`. A vaults evidence may name `system: "vaults"` and then carries no gateway stage; evidence with no `system` is the combined historical reading.

**Historical combined manifests.** A table without `systems` (a core checkout at the combined release SHA, for example the one behind `deployments/8453/deploy-2`) is read as one combined run: the gateway stage sits after the router, the verifier keeps its gateway, `AgentAuthorized` and `AgentOwnershipTransferred` checks and the `gateway_agents_listed_count` and `deployer_owns_a_listed_gateway_agent` manifest fields keep their meaning. Nothing here rewrites a historical manifest or a completed release record.

### 4.14. Production execution from the rc tag: a new deployment or a governed upgrade

Production runs only from an rc tag. The checkout is a clean checkout of the
tag, DEPLOY_SHA is the rc commit, and the release gate (tag, remote tag, committed counts,
green CI) runs before any signer exists (§3). The rc tag must be annotated, on
`releases-A.B.x` (its commit is an ancestor of the branch tip), and its tree must equal the
tree the Twin QA run passed. A run refuses an rc whose tree differs, a tag
on a QA branch or on `dev`, and a version tag.

The owner writes the go for the run (§1). The runbook then runs unmodified, as
QA ran it, with the production sheet. A mainnet broadcast without the owner's
go is never started by an agent.

**A mainnet run sends only what QA sent.** Every step of a `rehearsal` or
`production` run is a step of the same release file that the `twin` target ran, at the
same template, and passed. QA is the superset: it runs every mainnet step and the
Twin-only ones (a failed verify's pause, the refusals, the dirty pre-state). A
transaction a mainnet step would send that no Twin step sent is a step to add to the
file first, then run on the Twin, then on 8453. Nothing is sent on 8453 outside the
runner: the run's report reads each marked sender's nonce and fails on a transaction
no step journaled. The two shapes below are the file's two flows (`flows:`,
`docs/runbooks/contract-qa/README.md` "Flows").

**Two shapes of a production release.**

| Shape | When | Procedure |
| --- | --- | --- |
| New deployment | The first release of a line (`vA.B.0`), or any release of a line with no live governed proxy to upgrade | The cutover of §4.3 and §4.12 at new addresses, then verify, govern (stage 13) and the postflight of §4.4. Holders move by their own choice (§4.12, voluntary cutover) |
| Governed upgrade | A later release of a line whose proxies are live and not frozen | **The governed upgrade procedure of §4.12**, in order: layout review; `deploy-implementation --proxy NAME --upgrade-build DIR` at the rc checkout; `govern --row upgrade-proxy` to schedule; execute after the delay; re-record the manifests; `verify`; evidence (copy `upgradeability.json`, run the evidence check) |

The timelock delay of the run is the sheet's: 48 hours (172800 s) in the production kind and 900 s in the
rehearsal kind (§4.10). On 8453 the schedule exits `GOVERN_PENDING` and the same command executes it after
the delay. Safe signers sign through the real Safe, as in §4.3. After the postflight (§4.4) is clean, cut `vA.B.C` at the rc's commit (§3).
A rehearsal-kind release cuts no version tag. Every signing client's implementation pin is updated from the
new gateway manifest after a governed upgrade (§4.12), before the version tag.

**Retire rmAGENT on the live v0.5.0 line (`govern --row retire-vault`, core 1912, ADR-0017, ADR-0009).** The v0.6.0 line deploys three vaults. The live v0.5.0 rmAGENT leaves the router through one governed timelock batch. It is a configuration change, not a code change. It is owner-gated: nothing in CI schedules it on Base, and an agent never runs it.

`pause-all` covers the live v0.5.0 rmAGENT only when it runs with `--core-dir` of the v0.5.0 checkout (§4.15 `COMMON`): it then pauses rmAGENT like the other vaults, and counts it covered without a send once `retired()` reads true. Run with this line's checkout as `--core-dir`, it pauses the three vaults only: pause rmAGENT by hand with `EMERGENCY_ROLE`, or run the retire first.

1. **Read the balance first.** Read `totalAssets()` and `totalSupply()` of rmAGENT, and `registry.routerEligibleCount()` and `router.getDefaultWeights()`, with `cast call`. The live balance is not in this repository. If holders exist, they keep `redeem` and `redeemInKind` after the retire (withdraw-only, no assisted migration). `redeem` reads the recorder, so keep `scripts/ops/recorder-keeper.sh` running for the retired vault while it holds funds.
2. **Preview and schedule.** Run `bun publish-contracts/src/cli.ts govern --row retire-vault --admin-arg vault=0x<rmAGENT> --admin-arg weights=USDC:9500,PROTO:500,RWA:0` with the release's usual arguments. The row prints the preview first: the vault, the three-leg vector that stays and both calls. It refuses a vector that is not exactly rmUSDC, rmPROTO and rmRWA summing to 10000, a vault that is not Active and router-eligible, and a router that the registry does not link. An active receipt vector stays as it is: nothing clears it (issue 1988). The row refuses one whose vaults without rmAGENT are not rmUSDC, rmPROTO and rmRWA in that order, or that puts no weight on them.
3. **The batch is one timelock operation of two calls, in the one order the contracts allow.** `registry.migrateEligibility(rmAGENT, false, [rmUSDC, rmPROTO, rmRWA], [9500, 500, 0])` then `registry.retire(rmAGENT)`. `retire` reverts `RetireWhileRouterEligible` while the vault is eligible, and the router reverts when the vector length differs from the eligible count, so the pair is atomic.
4. **Execute after the delay** with the same command (the 48-hour production delay exits `GOVERN_PENDING` first). The row reads back: registry status Retired, `routerEligibleCount()` 3, the default vector equal to the three legs, the vault's `retired()` flag true, and the vault still has code. With no active receipt vector the effective vector equals the default. With one, the effective vector is that receipt vector, unchanged by the batch. While it still names rmAGENT the row reads `router.previewDeposit` and requires the rmAGENT leg unavailable with amount 0: the router skips the retired leg and spreads its share over the other legs by their bps. The next `apply-receipt` sets the three-vault vector.
5. **Evidence.** The run manifest records `vault_retirements`. `bun publish-contracts/src/evidence-check.ts --vault-retirements <publish-run.json> --registry <registry> --timelock <timelock> --rpc <url>` re-reads the chain (`evidence ok (vault retirements: 1 retirement(s), chain read)`). Then `verify` reads the retired vault as withdraw-only.
6. **Postflight.** A deposit into rmAGENT reverts, a router deposit splits across three legs, and `redeem` and `redeemInKind` pay existing holders. The Twin proves the same batch on a four-vault populated deployment (`core-stages-twin-upgrade-lifecycle`, step 2c).

A frozen proxy takes no upgrade. A fix to frozen contracts is a new deployment on a new line, never an rc of
the frozen line. Recovery follows §4.5 and §4.6: another rc, another governed upgrade or a new deployment.

### 4.15. The v0.6.0 governed upgrade of the live Deploy 3 on Base 8453 (issue 1914)

This section is the ordered, owner-gated procedure that moves the live Deploy 3 record (v0.5.0, kind rehearsal, tag `release/v0.5.0-rehearsal`) to the v0.6.0 line. It applies the generic procedure of §4.12 and §4.14 to three operations on three live proxies. The release file is `docs/runbooks/contract-qa/releases/v0.6.0.yaml`.

| Operation | Command row | What it changes |
| --- | --- | --- |
| Gateway upgrade | `govern --row upgrade-proxy --proxy gateway` | The gateway proxy runs the v0.6.0 `RobotMoneyGateway`. The gateway address does not change. |
| Receipt upgrade with its typed migration | `govern --row upgrade-proxy --proxy receipt --migration receipt-submitter-roles` | The receipt proxy runs the v0.6.0 `ConsensusRecommendationReceipt` and `migrateToSubmitterRoles(RouterGovernance)` runs once, in the same `upgradeToAndCall`. |
| rmAGENT retirement | `govern --row retire-vault` | One timelock batch of two calls takes rmAGENT out of the router. rmAGENT is withdraw-only afterwards (ADR-0017, ADR-0009). |

**Not upgraded.** `RouterGovernance`, `VaultRegistry`, `PortfolioRouter`, `RobotMoneyVault` (rmUSDC), `ProtocolAssetVault` (rmPROTO), `AgentTokenVault` (rmAGENT) and `RwaBasketVault` (rmRWA) keep their Deploy 3 implementations. Their v0.6.0 source differs from Deploy 3 in comments only. `bun publish-contracts/src/ci/check-comment-only-contracts.ts` builds `release/v0.5.0-rehearsal` and the candidate, masks the immutables, the library links and the CBOR metadata trailer with the verifier's own masking, and exits non-zero on any difference in the runtime logic of these seven. It runs in the required CI job `forge-unit-tests` on every pull request. On `dev` it checks five of the seven since issue 1988: that issue removed the clear of the router's applied vector from `PortfolioRouter` and `RouterGovernance`, which ship on the next line as governed upgrades. `releases-0.6.x` keeps the seven-contract check. The orphaned `InvestmentCommitteePolicy` proxy of Deploy 3 stays on chain unchanged.

**Authority and gates.** The owner records an explicit go before step 1. An agent never broadcasts to Base 8453, and the 2026-10-18 go covered Deploy 3 only. The run starts from a clean checkout of the rc tag `release/v0.6.0-rc.N-rehearsal` (§4.14). The storage layout of all nine proxied contracts must pass `scripts/ci/check-core-storage-layout.sh --baseline release/v0.5.0-rehearsal` (the required `forge-unit-tests` job runs it on every pull request) before the rc tag is cut. Two clean runs of `core-stages-twin-upgrade-lifecycle` on `rm-core-stage-1` must pass at the QA commit before the rc tag is cut (§2). Do not cut the rc tag, and do not start step 1, until both are recorded green.

**The Twin procedure.** The Twin procedure of this release is three things: the CI job `core-stages-twin-upgrade-lifecycle` (two clean runs on `rm-core-stage-1`), the CI job `core-stages-twin-upgrade-from-v050` and the yaml run of `docs/runbooks/contract-qa/releases/v0.6.0.yaml` on the stage host (`docs/runbooks/contract-qa/README.md`), whose upgrade flow is the whole of steps 2 to 10 below against a real v0.5.0 deployment, the dirty pre-state included. All must pass at the QA commit. The 8453 run is that same flow, run by the same runner, on the Deploy 3 record (§4.14: a mainnet run sends only what QA sent). `core-stages-twin-upgrade-from-v050` publishes `release/v0.5.0-rehearsal` on a Twin fork with that tag's own publish-contracts CLI and its committed Twin sheet (`VAULT_AGENT_MIN_POOL_LIQUIDITY` 1000000000000000, never lowered), then runs the commands of steps 3 to 9 below from the QA checkout (`publish-contracts/src/ci/twin-upgrade-from-v050.ts`). The live RM pool was drained at Base block 52881518, so that job forks Base at block 52881000, the state the v0.5.0 rmAGENT stage was built for. None of them proves the 48 hour delay or the mainnet Safe signers.

**The two checkouts.** Every command below runs against the build that is live. The live Deploy 3 build is `release/v0.5.0-rehearsal` (`57fbe61833e9d7f94557d69102138f7c410c1346`); the Deploy 3 checkout recorded the tool-only descendant `7bea6b9b`, which changes nothing under `contracts`. Make two clean checkouts:

| Checkout | What it is | Flag |
| --- | --- | --- |
| `$V050_DIR` | a clean checkout of `release/v0.5.0-rehearsal` (`git submodule update --init --recursive`), after `forge build` with Foundry 1.8.5 (the version CI pins), with HEAD equal to `$V050_SHA` | `--core-dir $V050_DIR --core-sha $V050_SHA` (in `COMMON`) |
| the working directory (`$PWD`) | a clean checkout of the rc tag (`git submodule update --init --recursive`), after `forge build` with Foundry 1.8.5 (the version CI pins), with HEAD equal to `$RC_SHA` | `--upgrade-build "$PWD"`; the CLI runs from here |

The `--core-dir` checkout supplies the stage table, the manifest set (the receipt is `consensus_receipt` in `ic-policy.json`, rmAGENT is `agent-token-vault.json`), the deployed storage layout snapshots and the live link offsets, and the release gate reads its tag, its committed counts and its green CI. So `deploy-implementation` compares the live gateway code (24283 bytes) with the v0.5.0 build and reads its `GovernedUpgrade` and `GatewayWindows` links, and both layout gates read the deployed receipt snapshot of the v0.5.0 checkout, whose layout id is the one Deploy 3 recorded. The new implementation still comes from the rc build, and its code is still read back against the rc artifact. The rmAGENT lines of the Deploy 3 sheet are read as the retired vault: rmAGENT leaves `ELIGIBLE_VAULTS`, `GOVERN_UNPAUSE_VAULTS` and `ROUTER_WEIGHTS` (its 0 bps leg). No refusal of the rows is removed. On 8453 the CLI gates the `--upgrade-build` checkout itself, before any signer, whenever it is not the `--core-dir` checkout: a clean HEAD carrying an annotated rc tag of the sheet's kind, that tag on the canonical repository, the commit on `origin/releases-A.B.x`, and green CI at it (the release gate above covers the `--core-sha`). The stage manifests are the Deploy 3 ones: `PUBLISH_MANIFEST_DIR` names that directory, because `$V050_DIR/deployments/8453` holds only Deploy 2 and must stay clean.

**The delay.** Deploy 3 is a rehearsal-kind deployment with a 900 s timelock. Every schedule below waits 900 s, and the Twin does not prove the 48 hour production delay or the mainnet Safe signers. A production-kind deployment waits 172800 s (48 hours) and uses the production floors of §4.10. Never plan a production window from the 900 s figure. Read the delay from the chain in step 2 and never type it from memory.

**Signers.** The governing Safe is the one recorded in the Deploy 3 run manifest, threshold 2 of its 3 owners. Every schedule and every execute is a Safe transaction signed by two owners (`--owner-signer`, twice). The deployer (`--signer`) only pays gas. No key, passphrase or keystore path enters the repo, the sheet or the evidence.

**Pinned values come from the chain.** The proxy addresses, the timelock, RouterGovernance, the registry, the router and rmAGENT are read from the Deploy 3 run manifest, then confirmed on chain in step 2. The implementation addresses of steps 3 and 5 are the ones `deploy-implementation` prints. The releaser of the migration is the `governance` field of the governance stage manifest, and the tool takes it from there. No address is typed from a document, a chat or this section.

Set these once. `COMMON` is the argument set every `publish-contracts` command below shares ("the release's usual arguments").

```bash
export DEPLOY3_SHEET=<the Deploy 3 frozen sheet>      # sheet of the live deployment, DEPLOYMENT_KIND=rehearsal
export EVIDENCE=<the Deploy 3 run evidence directory>  # holds publish-run.json and the stage manifests
export RC_SHA=<the full commit of the rc tag>
export RC_TAG=<the rc tag, release/v0.6.0-rc.N-rehearsal>
export V050_DIR=<the clean checkout of release/v0.5.0-rehearsal, submodules included, after forge build>
export V050_SHA=57fbe61833e9d7f94557d69102138f7c410c1346
export PUBLISH_MANIFEST_DIR=<the Deploy 3 stage manifest directory in $EVIDENCE>
export GITHUB_TOKEN=<a read-only GitHub token: the release gates read check-sha-green for both checkouts>
export SAFE=<the governing Safe, from the Deploy 3 run manifest>
export GOVERNANCE=<RouterGovernance, from the governance stage manifest of the Deploy 3 run manifest>
COMMON="--chain 8453 --rpc $BASE_RPC_URL --sheet $DEPLOY3_SHEET --core-dir $V050_DIR --core-sha $V050_SHA --evidence $EVIDENCE --environment local --signer $DEPLOYER_SIGNER --owner-signer $OWNER_SIGNER_1 --owner-signer $OWNER_SIGNER_2"
```

**Pause-all caveat.** Run `pause-all` with `COMMON` (the v0.5.0 checkout as `--core-dir`, and `--emergency-signer`): it reads the v0.5.0 table, so it pauses rmAGENT with rmUSDC, rmPROTO and rmRWA, and after step 7 it counts rmAGENT covered without a send because `retired()` reads true. A run that reads `retired()` false and cannot pause rmAGENT fails and names it. Run with the rc checkout as `--core-dir`, it pauses the three vaults only: then pause rmAGENT by hand with the `EMERGENCY_ROLE` key (`pauseDeposits()` on the rmAGENT proxy). Withdrawals are never paused.

**Mainnet steps.** Each step is owner-gated and runs in this order. Do not start a step before the previous one is recorded in the evidence.

0. Check both checkouts before any command uses `--core-dir` or `--upgrade-build "$PWD"`. This build-pin check is repeated immediately before every later use of `--upgrade-build` (steps 3, 4 and 5): rerun the six `test` lines below, and compare `git ls-remote origin "refs/tags/$RC_TAG^{}"` with `$RC_SHA` and `git ls-remote origin "refs/tags/release/v0.5.0-rehearsal^{}"` with `$V050_SHA`, so a tag that moved after step 0 stops the run. In the rc checkout HEAD must equal `$RC_SHA`, the work tree must be clean and the rc tag must point at `$RC_SHA`. In the v0.5.0 checkout HEAD must equal `$V050_SHA`, the work tree must be clean and `release/v0.5.0-rehearsal` must point at `$V050_SHA`. The last line fetches the release branch and checks the rc commit is on it, which the CLI's `--upgrade-build` gate also requires (it reads `origin/releases-0.6.x` as fetched, and `GITHUB_TOKEN` for green CI). Stop on any failure: a build from another tree would deploy code the owners never reviewed, or compare the live code with a build that is not live. Run `forge build` in the rc checkout after it is checked out at the tag: the CLI refuses an `out/` whose sources are not the tree's bytes.

```bash
test "$(git rev-parse HEAD)" = "$RC_SHA"
test -z "$(git status --porcelain)"
test "$(git rev-parse "$RC_TAG^{commit}")" = "$RC_SHA"
test "$(git -C "$V050_DIR" rev-parse HEAD)" = "$V050_SHA"
test -z "$(git -C "$V050_DIR" status --porcelain)"
test "$(git -C "$V050_DIR" rev-parse "release/v0.5.0-rehearsal^{commit}")" = "$V050_SHA"
git fetch origin releases-0.6.x && git merge-base --is-ancestor "$RC_SHA" origin/releases-0.6.x
```

1. Record the owner go in the run record with the rc commit and the Deploy 3 sheet. Stop if the owner has not given the go.

```bash
bun scripts/runbook/run-record.ts go --kind publish --run-dir $RUN_DIR --sha $RC_SHA --target rehearsal --sheet $DEPLOY3_SHEET
```

2. Read the live pre-state from the chain and record it in the evidence. Nothing is scheduled yet.

```bash
cast call $TIMELOCK "getMinDelay()(uint256)" --rpc-url $BASE_RPC_URL
cast call $SAFE "getOwners()(address[])" --rpc-url $BASE_RPC_URL
cast call $SAFE "getThreshold()(uint256)" --rpc-url $BASE_RPC_URL
cast call $TIMELOCK "PROPOSER_ROLE()(bytes32)" --rpc-url $BASE_RPC_URL
cast call $TIMELOCK "EXECUTOR_ROLE()(bytes32)" --rpc-url $BASE_RPC_URL
cast call $TIMELOCK "hasRole(bytes32,address)(bool)" $PROPOSER_ROLE $SAFE --rpc-url $BASE_RPC_URL
cast call $TIMELOCK "hasRole(bytes32,address)(bool)" $EXECUTOR_ROLE 0x0000000000000000000000000000000000000000 --rpc-url $BASE_RPC_URL
cast codehash $GOVERNANCE --rpc-url $BASE_RPC_URL
cast storage $RECEIPT 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00 --rpc-url $BASE_RPC_URL
cast call $RECEIPT "ADMIN_ROLE()(bytes32)" --rpc-url $BASE_RPC_URL
cast call $RECEIPT "hasRole(bytes32,address)(bool)" $ADMIN_ROLE $TIMELOCK --rpc-url $BASE_RPC_URL
cast call $RECEIPT "hasRole(bytes32,address)(bool)" $ADMIN_ROLE $GOVERNANCE --rpc-url $BASE_RPC_URL
cast call $GATEWAY "upgradesFrozen()(bool)" --rpc-url $BASE_RPC_URL
cast call $RECEIPT "upgradesFrozen()(bool)" --rpc-url $BASE_RPC_URL
cast call $RMAGENT "totalAssets()(uint256)" --rpc-url $BASE_RPC_URL
cast call $RMAGENT "totalSupply()(uint256)" --rpc-url $BASE_RPC_URL
cast call $REGISTRY "routerEligibleCount()(uint256)" --rpc-url $BASE_RPC_URL
cast call $ROUTER "getDefaultWeights()" --rpc-url $BASE_RPC_URL
cast call $ROUTER "getEffectiveWeights()" --rpc-url $BASE_RPC_URL
```

   The `ADMIN_ROLE()` output is the `$ADMIN_ROLE` of the two receipt `hasRole` reads. The `PROPOSER_ROLE()` and `EXECUTOR_ROLE()` outputs are the `$PROPOSER_ROLE` and `$EXECUTOR_ROLE` of the two timelock `hasRole` reads. `getOwners` must return exactly the three owners of the Deploy 3 run manifest and `getThreshold` must read 2. Compare each `OWNER_SIGNER` address (`$OWNER_SIGNER_1` and `$OWNER_SIGNER_2`) with the `getOwners` list: each must be one of the returned owners, and the two must differ. These are the signers of `--owner-signer` (twice). The Safe must hold `PROPOSER_ROLE` on `$TIMELOCK`, and the executor is open: `hasRole(EXECUTOR_ROLE, address(0))` must be true (core #1521: `DeployTimelock` grants `EXECUTOR_ROLE` to `address(0)` only). The Safe is not read for `EXECUTOR_ROLE` and does not hold it: anyone may execute a ready operation. Both reads must be true. Take `$GOVERNANCE`, `$RECEIPT` and every other proxy address from the Deploy 3 run manifest, never from memory. `$GOVERNANCE` is the `governance` field of the governance stage manifest, never typed from memory, and `cast codehash` must have code (not the empty-code hash). Record the code hash: step 5 and step 9 compare against it. The delay reads 900. The receipt initialized version reads 1. The timelock and RouterGovernance both hold `ADMIN_ROLE` on the receipt. Neither proxy is frozen. The router reads four eligible vaults. If the delay reads anything else, or if the receipt reads version 2 (the migration already ran and the whole execute would revert with `InvalidInitialization`), stop and report. If an active receipt vector shows in the effective weights, record it in the evidence and do not stop: nothing clears it (issue 1988). The retire of step 6 leaves it active, the router skips its rmAGENT leg, and the receipt of step 10 replaces it with the three-vault vector. The row does not read these values (gap RM-1022-2 in `docs/audits.md`), so this step is the only check of them before the signers sign.

3. Deploy the gateway implementation. The deployer sends one CREATE from the rc checkout build, linked to the libraries the live implementation links (read at the link offsets of the `$V050_DIR` build).

```bash
bun publish-contracts/src/cli.ts deploy-implementation --proxy gateway --upgrade-build "$PWD" $COMMON
```

   Record the printed address as `GATEWAY_IMPL`. A mismatch of the read-back runtime code exits `VERIFY`: never upgrade to that address.

4. Schedule the gateway upgrade, then execute it after the delay with the same command.

```bash
bun publish-contracts/src/cli.ts govern --row upgrade-proxy --proxy gateway --implementation $GATEWAY_IMPL --upgrade-build "$PWD" $COMMON
```

   The first run prints `govern.preview` and exits `GOVERN_PENDING` (15). After 900 s the same command executes through the Safe, reads the implementation slot back and re-records the gateway manifest, `gateway_implementation_runtime_hash` and `gateway_runtime_hash` from the chain.

5. Deploy the receipt implementation, then schedule the receipt upgrade with its typed migration. Before the second owner signs, review the whole `govern.preview` line: `new_implementation` must equal the `RECEIPT_IMPL` the deploy printed, `new_code_hash` must equal the code hash read back from that address, and the `migration_function` line must name the `$GOVERNANCE` address and code read in step 2. The delay is the one read in step 2 (900), and the schedule must not go ahead if it differs. Review the gateway `govern.preview` of step 4 the same way (implementation address and delay) before its second signature. The operator never supplies calldata.

```bash
bun publish-contracts/src/cli.ts deploy-implementation --proxy receipt --upgrade-build "$PWD" $COMMON
bun publish-contracts/src/cli.ts govern --row upgrade-proxy --proxy receipt --implementation $RECEIPT_IMPL --migration receipt-submitter-roles --upgrade-build "$PWD" $COMMON
```

   Record the printed address as `RECEIPT_IMPL`. After 900 s run the second command again to execute it. Then read back `RECEIPT_RELEASER_ROLE` (held by RouterGovernance only), `ADMIN_ROLE` (held by the timelock only) and the receipt count, and compare them with the step 2 values. A second `migrateToSubmitterRoles` must revert with `InvalidInitialization`.

6. Schedule the rmAGENT retire batch. An active receipt vector stays as it is: nothing clears or resets the router's vector (issue 1988). The row prints its preview first (the vault, the three-leg vector that stays, both calls) and refuses a vault that is not Active and router-eligible, a vector that is not exactly rmUSDC, rmPROTO and rmRWA summing to 10000, and an active receipt vector whose vaults without rmAGENT are not rmUSDC, rmPROTO and rmRWA in that order, or that puts no weight on them.

```bash
bun publish-contracts/src/cli.ts govern --row retire-vault --admin-arg vault=$RMAGENT --admin-arg weights=USDC:9500,PROTO:500,RWA:0 $COMMON
```

   The batch is one timelock operation: `registry.migrateEligibility(rmAGENT, false, [rmUSDC, rmPROTO, rmRWA], [9500, 500, 0])` then `registry.retire(rmAGENT)`. Neither call touches the active receipt vector. If rmAGENT holds funds (step 2 `totalAssets`), keep `scripts/ops/recorder-keeper.sh` running for it, because `redeem` reads the recorder and `redeemInKind` does not.

7. Execute the retire batch after the delay with the same `retire-vault` command. Right before the execute the row re-reads the state it checked in step 6 and sends nothing if it changed. It reads back registry status Retired, `routerEligibleCount()` 3, the default vector equal to the three legs, `retired()` true on rmAGENT, and code at the vault. With no active receipt vector the effective vector equals the default. With one, the effective vector is that receipt vector, unchanged: while it still names rmAGENT the row reads `router.previewDeposit` and requires the rmAGENT leg unavailable with amount 0, so the router spreads that leg's share over rmUSDC, rmPROTO and rmRWA by their bps until the step 10 receipt sets the three-vault vector.

8. Verify. The post-upgrade verify compares the upgraded gateway and receipt against the builds of their `proxy_upgrades` entries (the rc checkout) and every other contract against the `$V050_DIR` build, and reads rmAGENT as withdraw-only: retired by the step 6 batch, its code the v0.5.0 build.

```bash
bun publish-contracts/src/cli.ts verify $COMMON
```

   Verify writes the new `upgradeability.json` to `$PUBLISH_MANIFEST_DIR`. Copy it into the evidence.

9. Check the evidence against the chain. Both commands must exit 0, and the receipt migration read-back must equal the typed calldata step 5 previewed. Deploy 3 is a rehearsal-kind deployment, so both name `--deployment-kind rehearsal` (the 900 s floor); without it they hold the run to the 172800 s production floor and fail.

```bash
bun publish-contracts/src/evidence-check.ts --governed-upgrades $EVIDENCE/publish-run.json --deployment-kind rehearsal --timelock $TIMELOCK --governance $GOVERNANCE --rpc $BASE_RPC_URL
bun publish-contracts/src/evidence-check.ts --vault-retirements $EVIDENCE/publish-run.json --deployment-kind rehearsal --registry $REGISTRY --timelock $TIMELOCK --rpc $BASE_RPC_URL
```

10. Postflight (§4.4): the rest of the upgrade flow of `docs/runbooks/contract-qa/releases/v0.6.0.yaml`, steps P8.19 to P8.38, which the runner runs after step 9 in the same run as steps 3 to 9 (P8.10 to P8.17). It has no list of its own here: the file is the list, and the Twin ran it first. In order: the submitter Safe is registered again on the migrated receipt (the migration left `RECEIPT_SUBMITTER_ROLE` empty), the latest consensus receipt is recorded by it and applied by the Safe through the timelock, and the effective weights read back equal its vector (the rebalance, §4.9; a receipt that weights `agent_tokens` is refused, ADR-0017); 1 USDC is deposited into and redeemed from each of rmUSDC, rmPROTO and rmRWA; 2 USDC go through the router and split by the applied vector, never into rmAGENT; an agent is consented on the upgraded gateway, deposits 1 USDC through it into the router and is revoked; a real deposit into rmAGENT is mined reverted, and any rmAGENT shares the deployer holds leave by `redeemInKind` (the exit that reads no price; `redeem` sells RM through the drained RM V4 pool, Base block 52881518, and may revert on its slippage or freshness bound); `pause-all` pauses the three vaults with the emergency key, every position is redeemed while paused, and the three unpause rounds reopen them; `verify` and both evidence checks pass on the end state. Before step 3 the same flow's P8.06 reads the pre-state of step 2 into the journal, marks the deployer's and the emergency key's nonces, and leaves the deployer holding no shares and no agent registration (Deploy 3's postflight had left both, and every verify requires neither). The go or no-go is the run's sign-off record (§4.4), not a note.

11. Update every signing client pin from the new gateway manifest before any client signs: the `rmpc` TOML (`gateway_implementation` and `gateway_implementation_runtime_hash`), the dapp build env and the headless agent config. Until then the clients refuse to sign, which is the intended fail-closed behavior. The clients are not contracts: their checks are their own runbooks, not this one.

12. A rehearsal-kind release cuts no `vA.B.C` tag (§2). Cut `release/v0.6.0-rehearsal` as the record tag at the rc commit, and file the production report (§4.7) from the run's `rollout-report.md` and `go/signoff.json`. A run with no sign-off record gets no record tag.

**Recovery.** A schedule that must not run is cancelled through the Safe on the timelock before it is ready (§4.5). A rollback of the gateway or the receipt is another governed upgrade with the same review (§4.12). After step 5 the previous receipt implementation cannot read the migrated roles, so never roll the receipt back without a layout and role review.

## 5. Per-release runbook format

A contract release is executed from YAML under `docs/runbooks/contract-qa/`,
in the shape of the frontend repo's release runbooks:

- **One template**, `template.yaml`: every step a contract release runs, in
  order. It is general and names no release.
- **One add-only file per release**, `releases/<release>.yaml`: a full copy of
  the template steps, unchanged and in order, plus only the steps that release
  adds (each marked `added: <release>`). It also holds the release's owner
  `decisions:`, its `recovery:` decision, its `notes:` and its `scope:` (every
  PR the release ships, tied to a check or a reason for none).
- **The environment is chosen at run time** (`--target twin|rehearsal|production`).
  There are no per-environment files. Only the sheet and the arguments differ.
- **A release has two flows**, a new deployment and a governed upgrade of the live
  deployment (`flow:` on a step, `flows:` per target in the release file). Every step
  whose target and flow match runs; the report lists one that did not.
- **The runner runs it** (`scripts/runbook/run.ts`), and the run's own records say
  whether it is complete (§4.4).
- **The validator is the gate.** `bun scripts/runbook/validate-contract-qa.ts`
  refuses a release file that drops, edits or reorders a template step, a step
  that reads state no step writes, and a command the real CLIs do not accept.
  CI runs it on every pull request (`docs/development/ci-suites.md`, suite 13).
- **A production run is refused** while an owner decision is open or the
  release is not marked `productionReady`.

Each release runbook must still:

- state the release identity (`vA.B.C`) and the delta it introduces,
- map its go/no-go gates to §4,
- mark destructive or irreversible steps (`irreversible`, with `notBefore`,
  `onlyFor` or `go`),
- be executable top to bottom, with every claim verified against a specific
  commit SHA rather than described from memory.

A new release adds `releases/<next>.yaml`. It never edits the template steps.
The format, the placeholders and the run procedure are in
`docs/runbooks/contract-qa/README.md`.

Markdown runbooks under `docs/runbooks/` stay valid for work that is not a
contract release (for example the devnet verification). Their filenames are
kebab-case: `vA-B-C-<network>-<short-description>.md`.

## 6. Per-release GitHub tracking issue

Each release has one GitHub tracking issue, labelled `release:vA.B.C`. It names the
release branch, each QA branch and each rc tag with the QA journal that earned it. The tracking issue states the
release's **objective** — what should be true after deployment (which
contracts, on which network, with what role wiring) — not just a list of
merged PRs.

The issue carries two GitHub-checkbox checklists mirroring the runbook's
preflight and postflight gates. For a contract release these are the phases of
the release's YAML runbook (§5): phase 0 for preflight, phases 1 to 10 for
the cutover and postflight. Checking a box is a claim that the
corresponding gate was actually executed and passed.

For a final Base mainnet release the preflight checklist always contains the
item "External security review completed for the release SHA, report recorded
in `docs/audits.md`" (§4.1, item 3). Every release also carries
"`core-stages-twin-upgrade-lifecycle` green at the release SHA"
(§4.1, item 4).

## 7. Backporting

Not a gate. Scope and fixes move in two directions between `dev` and a release line.

- **`dev` to the release line (scope).** A change made on `dev` that a live line
  needs reaches `releases-A.B.x` by §2 route (a): a PR with the base
  `releases-A.B.x` that merges, or `git cherry-pick -x`'s, the named `dev`
  commits, before the next QA session. The release YAML's `scope:` lists it (§5).
  A `dev` change that renumbers or retypes proxied storage cannot be carried to
  a line that is live, because the layout stays append-only against the
  deployed baseline (§4.12 step 1). A change to `contracts/` on a line whose proxies are frozen is not
  possible (§2). Both ship on the next line.
- **The release line to `dev` (fixes).** Every fix made on a QA branch reaches the
  release branch in the stage-passed squash (§2 route (b)), and reaches `dev`
  afterwards by a separate PR from the QA branch (the squash commit, or the
  QA PRs, cherry-picked with `-x`), evaluated against `dev` as it is then. The
  production report lists each backport TODO (§4.7). The next QA session does not start
  before a TODO that would conflict with it is landed or dropped with a reason.

## 8. Target networks

| Network | Chain id | Default per ADR-0013 | Notes |
| --- | --- | --- | --- |
| Robot Money Devnet | `918453` | **Yes — the default verification target.** | The Twin chain: a pinned lazy anvil fork of real Base at the upstream head minus 2 per CI run (`scripts/devnet/twin-fork.ts`, `docs/technical/full-stack-devnet.md`). Tests deploy their own vault (clean room). Full production-parity for all three yield adapters (Aave V3, Compound V3, Morpho). No lasting address record and no version tag: a verification pass is recorded by its CI run, the QA journal with its commit and tree hash, and the evidence folder (§3). It is the QA target of every release (§2). |
| Base mainnet | `8453` | The eventual real target — a separate, deliberately-costed decision (D9). | Requires an audit pass, and Safe owners signing with encrypted keystores (passphrase typed) or, at each owner's choice, hardware wallets (optional, never required). The submitter is a Safe: the deployer pays its gas. |

## 9. Safe and timelock self-administration (Twin-only)

Issue 1645, part of 1447. This section is the procedure for changing the Safe's
own owners and threshold, and the timelock's own roles. The forge tests in
`contracts/test/SafeIntegration.t.sol` (`test_selfAdmin_*`) run each action
through the real Safe. The govern rows live in `publish-contracts/src/govern.ts`.

**Availability.** The rows run on the Twin chain (`918453`) only. They are
refused with `USAGE` on `8453` before the Safe is read. That is owner question 2
at its default (Twin-only). The owner may later decide to open them on mainnet.

| Row | What it does | Route |
| --- | --- | --- |
| `safe-add-owner` | `addOwnerWithThreshold(owner, threshold)` | One Safe transaction to the Safe, signed by the threshold. No delay. |
| `safe-remove-owner` | `removeOwner(prev, owner, threshold)` | Same. The tool reads the owner list for `prev`. |
| `safe-swap-owner` | `swapOwner(prev, old, new)` | Same. |
| `safe-change-threshold` | `changeThreshold(threshold)` | Same. |
| `timelock-grant-role` | `grantRole(role, account)` on the timelock | Safe schedules, the delay passes, the Safe executes. The timelock calls itself. |
| `timelock-revoke-role` | `revokeRole(role, account)` on the timelock | Same. |
| `update-delay` | `updateDelay(newDelay)` on the timelock | The existing Twin-only row. |

Run a row with the govern verb, the row name, and one `--admin-arg key=value`
per argument (keys: `owner`, `old-owner`, `new-owner`, `threshold`, `role`,
`account`). The roles are `PROPOSER_ROLE`, `EXECUTOR_ROLE` and `CANCELLER_ROLE`.

```
bun publish-contracts/src/cli.ts govern --row safe-add-owner --admin-arg owner=0x... --admin-arg threshold=3 --chain 918453 --core-sha <sha> ...
bun publish-contracts/src/cli.ts govern --row timelock-grant-role --admin-arg role=PROPOSER_ROLE --admin-arg account=0x... --chain 918453 --core-sha <sha> ...
```

Each run prints one JSON line per phase and reads the result back from the
chain against the row's own arguments (the owner set and threshold, or
`hasRole`), never against the sheet. The same read-back runs before the send: a
change that already reads in effect is reprinted from its record, or recorded
as skipped when no record holds it, and nothing is sent. The Safe's own rules
are checked before anything is proposed (a threshold above the owner count
after the change, GS201; the zero address, the sentinel or the Safe as an
owner, GS203; an owner added twice, GS204): the tool refuses with `USAGE` and
sends nothing. The run-manifest record is keyed on the row, the calldata and the
Safe nonce the transaction was proposed at (`safe-add-owner-<calldata hash>-n<nonce>`),
so `add X`, `remove X`, `add X` is three transactions, while a rerun of a
change still in effect sends nothing.

**After a Safe change, update the sheet.** Every other govern row (the
unpauses, `apply-receipt`, the rest; `release-receipt` is refused before
the check) compares the Safe's
live owners and threshold with the sheet's `SAFE_OWNERS` and `SAFE_THRESHOLD`
and refuses (`GOVERN`, exit 14) while they differ. The self-administration rows
are exempt, because that difference is what they make, and they log
`govern.sheet_stale` while it holds. So, after `safe-add-owner`,
`safe-remove-owner`, `safe-swap-owner` or `safe-change-threshold` executes:

1. Read the Safe: `getOwners()` and `getThreshold()` (the run logs them under
   `govern.sheet_update_needed`).
2. Set `SAFE_OWNERS` to that owner list and `SAFE_THRESHOLD` to that threshold
   in the stage sheet, and commit the sheet change with the run evidence.
3. Pass `--owner-signer` for the owners the change added on every later run;
   an owner the change removed or swapped out can no longer sign.

A second self-administration row runs before the sheet is updated (the Twin
matrix runs several in a row); a stage row does not.

**Refused: module, guard and fallback-handler changes.** No row builds
`enableModule`, `disableModule`, `setGuard`, `setModuleGuard` or
`setFallbackHandler`. The tool refuses them by name (`refuseSafeConfigChange`).
The Safe contract does not refuse a well-formed one: two owners can enable a
module at once, outside the timelock. The forge test
`test_selfAdmin_wellFormedModuleAndHandlerChangeIsDetectableNotPrevented` pins
that fact. The control is therefore this tool plus the verifier, which asserts
no module, no guard and the canonical fallback handler.

**The Safe's own timelock role.** Owner question 1 is answered (2026-10-14,
QA plan v1 B3): (b), and never the last proposer. Giving up a timelock role goes
through the delay. The route is `timelock-revoke-role` with the Safe as
`account`. The tool never builds `renounceRole`, because a Safe transaction is
instant. The deployed timelock is `ProposerFloorTimelock`
(`contracts/ProposerFloorTimelock.sol`, an OpenZeppelin `TimelockController`
whose `_revokeRole` refuses to drop the last `PROPOSER_ROLE` holder): a revoke
of the last proposer reverts at execute with `LastProposerFloor`, and so does a
renounce, instant or not. The tool reads `proposerCount()` and refuses
`timelock-revoke-role PROPOSER_ROLE` for the last holder (exit 14, `GOVERN`)
before anything is sent. To retire the Safe as proposer, grant `PROPOSER_ROLE`
to its successor first (`timelock-grant-role`), then revoke the Safe. The
contract still cannot force the delay on a renounce that is not the last
proposer's: `test_selfAdmin_directRenounceIsInstant_soTheToolMustNotBuildIt`
pins both halves, `DeployTimelock.t.sol::test_lastProposerCannotBeRevokedOrRenounced`
pins the floor through the real Safe, and the govern negative is in
`publish-contracts/tests/govern.test.ts` (issue 1645 block).

**Owner decisions.** Record the answer here when given.

| Question | Default in force | Owner answer |
| --- | --- | --- |
| 1. May the Safe renounce its timelock roles instantly? | (b) through the timelock delay | No: through the delay, and never the last proposer (`ProposerFloorTimelock`; QA plan v1 B3, 2026-10-14) |
| 2. Are these rows available on mainnet 8453? | (a) Twin-only | not yet given |

**CI proof.** The forge tests run in the required SafeIntegration suite. The
govern rows are covered by `publish-contracts/tests/govern.test.ts` (issue 1645
block): accepted on the Twin chain, refused on 8453. The QA plan v1 B4 block of
the same file runs the rows against a fake Safe whose roster is live and whose
rules are the Safe's own: "second owner row after safe-add-owner",
"safe-change-threshold above owner count refused", the add X / remove X / add X
sequence (three transactions, three records), and the fake's negatives
(threshold above owner count, wrong `prevOwner`, a cancel below threshold or
without `CANCELLER_ROLE`). The Twin publish govern matrix runs one of the rows
on the real SafeL2 (QA plan v1 B5): after the post-govern verify, both
`publish-contracts/src/ci/twin-publish.ts` (suite 28) and
`testing/smoke-test/tests/twin_publish.rs` (suite 14) run
`govern --row safe-change-threshold` twice, raised to the owner count (two
signatures) and restored to the sheet's `SAFE_THRESHOLD` (every owner signs,
the sheet stale in between), before the receipt path. The restore is what keeps
the later rows and the verifier's Safe threshold label green: a sheet cannot
carry a threshold equal to the owner count, so the sheet is not rewritten.
