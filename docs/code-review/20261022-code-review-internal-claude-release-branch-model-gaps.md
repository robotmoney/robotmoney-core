# Release branch model: the gaps between the new policy and today's tooling and CI

Date: 2026-10-22. Decision: owner, verbatim: "I want our runbooks to follow the example in -frontend repo. We cut releases branches, we then qa on a branch and patch on qa branch then squash to releases cut a rc tag and do prod upgrade". The policy is [`docs/operations/contract-release-runbooks.md`](../operations/contract-release-runbooks.md) sections 2, 3, 4.5, 4.14 and 7, modeled on the frontend repo's `docs/technical/release-runbooks.md`.

The prescriptive docs state the target only. This review lists every place where the tooling, the CI or the repository settings do not yet do what the policy says. Each finding is a gap to build or to set, not a defect in shipped contracts. None blocks the policy text. Each blocks the policy being run end to end with no manual step. The coordinator decides which gaps become engineering tasks. No GitHub issue is filed from this review.

## Observation: how `releases-0.5.x` relates to the rc tags and to `dev`

Measured on 2026-10-22 against `origin/releases-0.5.x` (tip `077de79c`) and `origin/dev` (`911718f6`).

- The branch was cut from `dev` at `23edb452` (2026-10-16). It carries 57 commits that are not ancestors of `dev`. Its name already matches `releases-A.B.x`.
- Its tip tree is byte-identical to the tree of `dev`'s commit `e362df0c` (pull request 1877, "Contract QA runbook in YAML, trimmed to the rehearsal deploy runbook for Deploy 3"). That pull request squashed the whole branch onto `dev`. So every change on the branch is on `dev` as content, and none of its commits are on `dev` as history.
- `dev` has moved since: the system split (1887), receipt-only governance (1894), the independent vault and gateway deploys (1898) and the rm-parked changes (1904). Of the 54 files the branch touches, 26 differ from `dev` today for that reason and 28 are identical.
- All 13 rc tags `release/v0.5.0-rc.1-rehearsal` to `release/v0.5.0-rc.13-rehearsal` are on the branch. None of them is an ancestor of `dev` (checked for `rc.1` and `rc.13`). The record tag `release/v0.5.0-rehearsal` is at `57fbe618`, the same commit as `rc.9`. The frozen counts of seven rc commits are committed on the branch (and on `dev` through the squash).
- No QA branch (`qa/*`) exists. Four legacy branches `releases-v0.4.0-base`, `releases-v0.4.0-base-rehearsal`, `releases-v0.4.0-base.2-rehearsal` and `releases-v0.4.0-base.3-rehearsal` exist. They do not match `releases-A.B.x`.

Decision recorded in the policy (section 2): the branch is adopted as it stands, as the v0.5 line. Its tags stay as Deploy 3's pre-policy history. The next rc of `v0.5.0` is `rc.14`. A `dev` change reaches the line only by the scope route, and everything else ships on `releases-0.6.x`.

## Findings

### 1. The release gate binds an rc tag to a sha, not to the release branch, the QA tree or the rc grammar

`publish-contracts/src/release-tag.ts` (`releaseTagsFor`, `tagKind`) accepts any annotated `release/*` tag that peels to the sha, and reads the kind from the `-rehearsal` suffix. Nothing checks that the commit is on `origin/releases-A.B.x`, that the tag name is `release/vA.B.C-rc.N[-rehearsal]` with a monotone `N`, or that its tree equals the tree a Twin QA run passed. The frontend's `tag.ts rc --stage-journal` refuses a commit whose tree is not the stage run's tree, and SP.8 refuses it again in production. Contracts have the first half of the idea (the tag must exist, be remote and be annotated), not the tree and branch binding. Today a tag on a QA-branch commit, on a `dev` commit, or on an unreviewed commit passes the gate when CI is green and counts exist.

### 2. The counts-checkout flag proves reachability from `origin/dev` only

`--counts-require-origin-dev` (`publish-contracts/src/release-gate.ts`, `publish-contracts/src/cli.ts`, `publish-contracts/README.md`, `publish-contracts/tests/counts-layouts.test.ts`) refuses unless the HEAD of the counts checkout is an ancestor of the local `origin/dev`. In the new policy the squash commit and the data-only counts commit (route (c)) are on `releases-A.B.x` and are not on `dev` until a separate backport. The runbook requires the flag on every 8453 plan and broadcasting run (section 4.3, step 5), so a release-branch counts commit is refused. The flag needs a release-line form that takes the origin ref of the line, for example `origin/releases-0.5.x`, with the test planting a descendant that is not on that ref.

### 3. CI does not run on `qa/**`, and almost nothing runs on a push to `releases-*`

No workflow names `qa/**`. Only six workflow files name `releases-*` (suites 08, 25, 27 twice and 28 twice). Suites 01-02 (forge), 03, 04, 05, 06, 07, 09, 10, 13 (doc checks), 14 (smoke), 16 and the security gates trigger on pull requests and, where they have a push trigger, on `dev` (or `dev` and `dev-phase-*`) only. Three consequences:

- The commit QA runs on a QA branch carries no CI of its own, so the policy sentence "every CI workflow runs on a push to `qa/**`" is not true.
- The squash commit on `releases-A.B.x` gets no forge, doc-check or smoke run. `scripts/ci/check-sha-green.ts` reads check-runs of the sha, and the required list (`scripts/ci/required-checks.json`, derived by `scripts/ci/deploy-gate-jobs.ts` from the jobs that run on every push to `dev` or to `releases-*`) will report `MISSING` for those jobs. Today the flow avoids this because a deploy sha is a `dev` commit that already ran on `dev`. The squash commit is on no `dev` run.
- `docs/development/ci-suites.md` ("check-sha-green") describes `dev` as the source of a deploy sha. The text now says a release-branch squash commit is. The deploy-gate derivation must treat a push to `releases-*` and to `qa/**` as the source set.

The fix is to add `releases-*` and `qa/**` to the push trigger of every workflow that has a `dev` push trigger, keeping each workflow's path filters, then update `deploy-gate-jobs.ts` and its `KNOWN_CONDITIONS` table.

### 4. The storage-layout baseline set reads every non-rehearsal `release/*` tag

`scripts/ci/check-core-storage-layout.sh --releases` extends the layout of every `release/*` tag that is not a rehearsal tag and ships GovernedUUPS proxies. With the new rc tags `release/vA.B.C-rc.N`, a production rc that never reached production (a failed attempt, a spent rc) becomes a baseline that every later layout must extend. The policy's baseline is the commit the live implementation was built from, which is the final rc's commit, named by the version tag `vA.B.C`. The script should read the version tags of deployed production releases instead (and `--baseline` takes the release branch tip and the deployed rc for a QA commit), and its self-test should plant an undeployed rc whose layout the next release does not extend.

### 5. No tool cuts the rc, checks the squash or keeps the QA journal

The frontend has `scripts/release/tag.ts rc --release --commit --stage-journal`, a lockfile step and a stage journal that records the commit and the tree hash. Core has no equivalent. The squash checks of section 2 (release branch has not moved since the QA branch was cut, the squash tree equals the passed tree, CI green on the QA tip), the rc numbering and the annotated push are manual. The contract QA runbook has no runner yet (`docs/runbooks/contract-qa/README.md`, "Until a runner is ported"), so no journal records the QA commit and tree. A tool in `scripts/release/` should cut the rc, write the journal fields the report needs and refuse a mismatch. Section 4.7 asks the production report to carry those fields.

### 6. The runbook validator and the gate steps do not bind a target to its ref

`scripts/runbook/validate-contract-qa.ts` checks steps, commands and state, not where a run happens. Nothing refuses a `twin` run at a commit that is not on a `qa/` branch, or a `rehearsal` or `production` run at a commit that is not an rc tag on the release branch. The plan step P0.20 reuses the release gate of finding 1. Separately, a release file's `templateSha` is read from git (`fetch-depth: 0` in `suite-13-doc-checks.yml`), and a squash makes the QA branch's commit hashes unreachable from the release branch. The policy keeps QA branches after the squash, but nothing enforces retention, and a deleted QA branch would turn a pinned release into "templateSha has no template in git". The validator should accept a pin only at a commit reachable from the release branch or `dev`, or the retention should be a repository rule.

### 7. The branch and tag rules are conventions, because branch protection is a won't-fix

The policy says a pushed QA branch is never rewritten, a release branch is force-pushed only on an explicit owner instruction, the release branch takes only the three routes, and a release tag is never moved. `docs/development/ci-suites.md` ("Branch protection (won't fix)") records that no GitHub setting enforces any rule, and `docs/development/qa-plan-v1.md` lists the admin-only ruleset on `refs/tags/release/*` as an owner action still to do. The rc tags are the production gate, so the tag ruleset matters most. Rulesets for `releases-*` (no force push, no deletion, pull request only, squash only for QA merges) and `qa/**` (no force push) are owner settings. They are listed here, not filed as an issue.

### 8. The `scope:` of a release file is checked for shape, not against the commit range

`scopeProblems` in `scripts/runbook/validate-contract-qa.ts` requires every scope entry to be a pull request with a check step or a reason. Nothing compares the list with the commits between the deployed version and the rc, so a pull request that reaches the release branch by route (a) and is missing from `scope:` (or a listed one that did not arrive) is not refused. The frontend's Q05-scope step does that comparison. A route (a) cherry-pick (`-x`) also hides the original pull request number from a range walk, so the comparison needs the `-x` trailer or the squash message.

### 9. Stale references to branches that do not match the model

`docs/development/fusion-devnet-ci.md` names `releases-0.4.x` as a branch that holds `suite-26-fusion-devnet-acceptance.yml` and `release-tag-suite-dispatch.yml`, and `workflow_dispatch --ref releases-0.4.x`. The branch is not on `origin`. The four legacy `releases-v0.4.0-base*` branches use the old naming. They need an owner decision to archive (`archive/<name>-<date>`) or delete. They are not touched here.
