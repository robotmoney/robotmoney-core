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

## Running it by hand

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
