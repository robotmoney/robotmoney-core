# Fusion devnet acceptance in CI

Canonical workflow: [`.github/workflows/suite-26-fusion-devnet-acceptance.yml`](../../.github/workflows/suite-26-fusion-devnet-acceptance.yml)
Harness self-tests: [`.github/workflows/suite-25-fusion-harness-selftests.yml`](../../.github/workflows/suite-25-fusion-harness-selftests.yml)

## Why there are two workflows

`scripts/fusion/` carries the only executing proof of two acceptance clauses:
`AC-CORE-09`'s "retryable/idempotent" submitter and `AC-GOV-01`'s draft-only
watcher. Those properties live in shell, so they are exactly the kind of claim
that gets asserted in a comment and never executed.

| | suite-25 `fusion-harness-selftests` | suite-26 `fusion-devnet-acceptance` |
|---|---|---|
| What it proves | the harness itself is correct | the devnet satisfies the harness |
| Against | stub `rmpc` / `cast` / `curl` on a mktemp `PATH` | the real devnet, chain `918453` |
| Network / chain | none | yes |
| Triggers | every `pull_request`, `push` to `releases-*`, `push` of a `v*.*.*` tag | `workflow_dispatch` + nightly `10 4 * * *` |
| Credentials | none, ever | repository variables + secrets (below) |
| Blocks a merge | yes | no |

They are deliberately separate. A devnet outage must never be able to turn the
PR gate red, and a green harness self-test must never be mistaken for a green
devnet run.

## Executed-assertion floors

Neither workflow trusts an exit code.

`scripts/fusion/tests/run-tests.sh` runs under `set -uo pipefail` **without**
`-e`, so a truncated file or a block that aborts early still prints
"42 passed, 0 failed" and exits 0. It therefore:

- declares `MIN_EXPECTED_ASSERTIONS` (currently **55**) and ends at
  `[[ "$FAIL" -eq 0 && "$PASS" -ge "$MIN_EXPECTED_ASSERTIONS" ]]`;
- prints a machine-readable `FUSION_SELFTESTS_EXECUTED=$PASS` line;
- asserts, as one of its own assertions, that suite-25's independent floor
  literal **equals** `MIN_EXPECTED_ASSERTIONS`.

suite-25 re-derives the count from that contract line against its own literal.
The two numbers move together, in one commit; lowering one alone is red. This is
the `suite-17` / `plugins/robotmoney-swarm` convention.

suite-26 applies the same rule to the devnet run: for every stage it requested,
it asserts the result JSON contains at least one non-`SKIP` assertion for that
stage. A run where every stage skipped cannot report success.

`.github/scripts/check_evidence_scripts.py` invariant (B) now enumerates an
explicit registry, `EVIDENCE_SCRIPT_ROOTS = (".github/scripts/tests",
"scripts/fusion/tests")`, instead of one hardcoded directory — which is why the
sweep could not previously see that no workflow ran the Fusion harness at all.

## Repository configuration

Set these on `robotmoney/robotmoney-core` under
*Settings → Secrets and variables → Actions*. **Nothing here is committed, and
no workflow creates a key.**

### Variables (`vars.*`) — endpoints and addresses, not secret

| Variable | Meaning |
|---|---|
| `FUSION_RPC_URL` | devnet JSON-RPC endpoint |
| `FUSION_EXPLORER_API` | explorer API base URL (index stage) |
| `FUSION_DAPP_URL` | dapp base URL (dapp stage) |
| `FUSION_RECEIPT_URL` | default receipt URL the nightly run accepts |
| `FUSION_GATEWAY_ADDRESS` | `RobotMoneyGateway` |
| `FUSION_RECEIPT_ADDRESS` | `ConsensusRecommendationReceipt` |
| `FUSION_GOVERNANCE_ADDRESS` | `RouterGovernance` (INV-4 witness) |
| `FUSION_ROUTER_ADDRESS` | `PortfolioRouter` (INV-4 witness) |
| `FUSION_VAULT_ADDRESSES` | `rmUSDC,rmPROTO,rmAGENT,rmRWA` in canonical bucket order |
| `FUSION_SUBMITTER_ADDRESS` | the authorized submitter (positive control) |
| `FUSION_RELEASE_ADDRESS` | the admin EOA the release keystore unlocks |
| `FUSION_UNAUTHORIZED_SUBMITTER` | EOA with neither `AGENT_ROLE` nor submit rights |
| `FUSION_UNAUTHORIZED_RELEASER` | EOA **without** `ADMIN_ROLE` on the receipt |

The two `UNAUTHORIZED_*` entries are the negative controls. Without them the
negative stage proves nothing, so suite-26 refuses to run rather than skipping
them quietly.

### Secrets (`secrets.*`) — ephemeral devnet key material only

| Secret | Contents |
|---|---|
| `FUSION_RMPC_CONFIG` | operator config TOML for the submitter identity |
| `FUSION_RELEASE_KEYSTORE` | v3 keystore JSON for the admin releaser |
| `FUSION_RELEASE_PASSWORD` | password that unlocks that keystore |

**Rules.**

1. These are **devnet** keys for chain `918453` with no mainnet value. A Base
   mainnet or Base Sepolia key must never be placed in them.
2. The password reaches the harness as a **file** under `$RUNNER_TEMP`
   (`FUSION_RELEASE_PASSWORD_FILE`), never as an argument and never echoed. All
   three files are removed in an `if: always()` step.
3. Rotate them whenever the devnet is rebuilt, and whenever anyone who held them
   leaves. Rotation is: fund a new EOA on the devnet, re-grant its roles, replace
   the three secrets, dispatch suite-26 once and confirm green.
4. Fork PRs do not receive them, by design.

### When they are absent

suite-26 exits **0** with a loud `SKIPPED — not configured` block in the job
summary naming every missing `vars.*` / `secrets.*` entry, and executes nothing.
A skip is never a pass: it says so, in those words. The one thing it must not do
is run a degraded subset and report success, which is what the per-stage
assertion floor above prevents.

## STATUS: suite-26 and release-tag-suite-dispatch CANNOT RUN TODAY

Read this before citing a green — or an absence of red — from either workflow.

### They are not registered, so `workflow_dispatch` and `schedule` cannot reach them

GitHub registers a workflow for `workflow_dispatch`, and schedules its `cron`,
**only from the repository default branch**. This repository's default branch is
`dev`:

```
$ gh api repos/robotmoney/robotmoney-core --jq .default_branch
dev
$ gh api repos/robotmoney/robotmoney-core/contents/.github/workflows/suite-26-fusion-devnet-acceptance.yml?ref=dev
HTTP 404
$ gh run list --workflow=suite-26-fusion-devnet-acceptance.yml
HTTP 404: workflow ... not found on the default branch
$ gh api repos/robotmoney/robotmoney-core/actions/workflows --paginate | grep fusion-devnet
(empty)
```

`suite-26-fusion-devnet-acceptance.yml` and `release-tag-suite-dispatch.yml`
exist **only on `releases-0.4.x`**. Consequences, stated flatly:

- The nightly `cron: "10 4 * * *"` at suite-26 **will never fire.**
- suite-26 **cannot be dispatched**, including by the `gh workflow run` command
  below, until the file is on `dev`.
- `release-tag-suite-dispatch.yml` is likewise inert for `workflow_dispatch`.
  Its `push: tags: ['v*.*.*']` trigger is also unreachable while the file is
  absent from the default branch.

`suite-25-fusion-harness-selftests.yml` and `fusion-cross-repo-drift.yml` ARE
registered and DO run — not because they are on `dev`, but because they carry
`push`/`pull_request` triggers, which fire from any branch that holds the file.
suite-26 has neither, which is exactly why it is inert.

So **AC-E2E-05's "repeatable CI/devnet test, not only a one-off manual
demonstration" is NOT met** at `v0.4.0-rc.9`. Recorded in
`fusion-evidence/20260914T-run2/phase2-ci/VERIFY/R5-refuter1.md` (D1, D2) and
`R5-refuter2.md` (DEFECT 1).

**Remedy:** the workflow files must land on `dev`. A draft pull request carrying
only the five new workflow files and this document is open for that purpose:

> **robotmoney/robotmoney-core#1444** — <https://github.com/robotmoney/robotmoney-core/pull/1444>
> (branch `r2/workflows-to-dev`, cut from `origin/dev`)

Merging it is a human decision, not an automated one. Its body names the two
jobs that will be RED on `dev` until the `releases-0.4.x` content lands
(`suite-25-fusion-harness-selftests` and `fusion-cross-repo-drift`, whose
scripts and fixtures are not on `dev`) and the two clean orderings that avoid
that. Registration alone does not make suite-26 meaningful — see the credentials
section immediately below.

### Even once registered, every credential is unset

```
$ gh api repos/robotmoney/robotmoney-core/actions/variables  -> {"variables":[],"total_count":0}
$ gh api repos/robotmoney/robotmoney-core/actions/secrets    -> {"secrets":[],"total_count":0}
```

**All 13 repository variables and all 3 repository secrets documented above are
unset.** The workflow declares no `environment:`, so repository scope is the only
source. A run today would therefore take the `SKIPPED — not configured` branch,
every subsequent step is guarded by
`if: steps.gate.outputs.configured == 'true'`, and the **job would conclude
success having executed zero devnet assertions**. The skip is loud in the job
summary to a human who opens the run; the API, the badge and a branch-protection
check all see a plain pass.

Until the 16 entries are populated, a green suite-26 run is evidence of nothing.
See `R5-refuter2.md` DEFECT 2.

### The order of work

1. Land suite-26 and `release-tag-suite-dispatch.yml` on `dev` (registration).
2. Populate the 13 variables and 3 secrets (§ Repository configuration above).
3. Dispatch one run by hand and confirm the per-stage assertion floor actually
   fired rather than the skip branch.
4. Only then may a green run be cited as evidence for AC-E2E-05.

A further hardening worth doing at step 2, not done here: make the
not-configured path a **failure** on `schedule`, keeping the soft skip only for
fork `pull_request` contexts. A nightly that cannot run should be red, not green.

## Running it by hand

> Blocked until the workflow is on `dev` — see the STATUS section above.


```
gh workflow run suite-26-fusion-devnet-acceptance.yml -R robotmoney/robotmoney-core \
  --ref releases-0.4.x \
  -f stages=verify,negative,record,index,dapp,govern \
  -f receipt_url=https://…/receipt.json
```

`release` is **omitted from the default stage list on purpose**: a nightly run
must not broadcast an admin release transaction. Add it only for a deliberate,
recorded acceptance step.

## Related

- `docs/development/ci-suites.md` §25, §26 and *release-tag dispatch*
- `docs/development/false-green-shapes.md`
