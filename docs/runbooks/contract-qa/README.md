# Contract QA runbook

One runbook checks every deploy, governance and deposit step of a contract release. It runs in three environments. The policy is `docs/operations/contract-release-runbooks.md` (4.4 and 4.12). The format follows the frontend release runbooks.

## Files

| File | What it is |
| --- | --- |
| `template.yaml` | Every step a contract release runs, in order. General: no release in it. |
| `releases/<release>.yaml` | A full copy of the template steps, unchanged and in order. Plus only the steps that release adds, each marked `added: <release>`. |
| `../../../scripts/runbook/validate-contract-qa.ts` | The checker. Run it with no arguments for the template and every release file. |
| `../../../scripts/runbook/qa-assert.ts` | The small assertions a step makes between two commands. |
| `../../../scripts/runbook/run-record.ts` | Writes the run's own records: the publish go, the Twin freeze go, the rollout report and the sign-off. |

A release file also holds its `decisions:` (owner decisions, open or decided), its `recovery:` decision, its `notes:` and its `scope:` (every PR the release ships, each tied to a check or a reason for none).

The next release adds its own file. It never edits the template steps. The validator refuses a release file that drops, edits or reorders a template step.

## Targets

The environment is chosen at run time with `--target twin|rehearsal|production`. There are no per-environment files. Only parameters differ. A step that exists for one environment says so with `onlyFor`.

| Target | Chain | RPC variable | Starting sheet |
| --- | --- | --- | --- |
| `twin` | 918453 | `TWIN_RPC_URL` | `deployments/twin-918453/stage-sheet.env` |
| `rehearsal` | 8453 | `BASE_RPC_URL` | `deployments/base-8453-rehearsal/stage-sheet.example.env` |
| `production` | 8453 | `BASE_RPC_URL` | the reviewed, frozen sheet the operator names |

The RPC URL itself is never written down.

## Placeholders

`{name}` is resolved at run time from the target, the sheet or the run. `{sheet:NAME}` reads a sheet line. `{m:file.key}` reads a deployment manifest. `{state:name}` reads a file an earlier step wrote under `{runDir}/state/`. `{journal:id}` reads an earlier step's journaled output.

A whole-element list placeholder expands to several argv elements: `{common}`, `{owners}`, `{gate}`, `{wait}`, `{emergency}`, `{cast}`. The definitions are `LIST_PLACEHOLDERS` in the validator. The scalar names are `SCALARS` in the same file.

## Run it

Until a runner is ported, an operator or an agent follows the YAML by hand. Each step's commands run in order from the root of the core checkout at the deploy sha. Pipe every command through `tee {runDir}/journal/<id>.out`. Write receipts to the paths the step names.

Check before any run:

```
bun scripts/runbook/validate-contract-qa.ts
bun scripts/runbook/validate-contract-qa.ts --release v0.5.0 --target twin --runnable
bun scripts/runbook/validate-contract-qa.ts --check-sheet <sheet.env> --target twin
```

A `production` run is refused while any owner decision is open or `productionReady` is `false`. Only the owner sets those.

## Rules

- Steps run in phase order, 0 to 10.
- An irreversible step carries `notBefore`, `onlyFor` or `go`.
- A step reads only state an earlier step (or the step itself) writes.
- No step waits on a file a person makes at run time. A record a step checks is written by an earlier step, or committed and reviewed (the Deploy 3 sheet fragment, `deployments/base-8453-rehearsal/deploy-3.env`).
- No secret and no keyed RPC URL appears in any file here.
- Core never imports devops. A step calls the documented `publish-contracts` CLI only.

The tests are `scripts/runbook/validate-contract-qa.test.ts` and `scripts/runbook/run-record.test.ts`. CI runs it in the doc checks suite.
