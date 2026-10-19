# Contract QA runbook

One runbook checks every deploy, governance and deposit step of a contract release. It runs in three environments. The policy is `docs/operations/contract-release-runbooks.md` (4.4 and 4.12). The format follows the frontend release runbooks.

## Files

| File | What it is |
| --- | --- |
| `template.yaml` | Every step a contract release runs, in order. General: no release in it. |
| `releases/<release>.yaml` | A full copy of the template steps, unchanged and in order. Plus only the steps that release adds, each marked `added: <release>`. |
| `../../../scripts/runbook/validate-contract-qa.ts` | The checker. Run it with no arguments for the template and every release file. |
| `../../../scripts/runbook/qa-assert.ts` | The small assertions a step makes between two commands. |
| `../../../scripts/runbook/cast-send.sh` | `cast send` that fails on a mined revert: cast exits 0 when a send with `--gas-limit` is mined with status 0. Every step sends through it. |
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

## Hosts

Every step names its `host`. There are two.

| Host | What it is | What runs there |
| --- | --- | --- |
| `control` | The operator machine. It holds the keys. | The runbook driver and every signing command (`publish-contracts`, `cast send`, `rmpc`). |
| `stage` | The stage host, `rm-core-stage-1`, reached with the ssh config alias. | Every chain and service of a rehearsal: the Twin fork, the stage stack, the dapp. |

- No rehearsal chain runs on the operator machine. That covers the Twin fork, any anvil and any fork of Base. A Twin run starts its fork on the stage host (P0.12 runs there over ssh).
- The operator machine drives the whole run over ssh. A `control` step on the Twin target reaches the stage fork through an ssh tunnel (`ssh -N -L <port>:127.0.0.1:<port> rm-core-stage-1`), and `{rpcUrl}` is the local end of that tunnel.
- Keys, passphrase files and keyed RPC URLs never leave the operator machine. Nothing on the stage host signs (`docs/development/stage-deployment.md`).
- A mainnet run (`rehearsal` or `production`) sends from the operator machine to `BASE_RPC_URL`. Its `stage` steps (P8, P10.06) run the read-only dapp on the stage host.

## Placeholders

`{name}` is resolved at run time from the target, the sheet or the run. `{sheet:NAME}` reads a sheet line. `{m:file.key}` reads a deployment manifest. `{state:name}` reads a file an earlier step wrote under `{runDir}/state/`. `{journal:id}` reads an earlier step's journaled output.

`{manifestDir}` is `deployments/qa-runs/<run name>` in the core checkout. Forge may write manifests only under `./deployments` or `/tmp` (`fs_permissions` in `foundry.toml`). Git ignores `deployments/qa-runs/`, so verify (P2.01), which refuses a checkout with untracked files, still passes. Any other folder under `deployments/` fails P2.01, and a folder outside the checkout fails publish (P1.02). The dry run (P0.21) writes to `{runDir}/manifests-dry`, which P0.57 links to `{manifestDir}-dry` for the same reason.

`{gateSha}` is the sha whose tag, green CI and frozen counts gate the run (P0.09 to P0.11, P3.50, P10.01). It is `{coreSha}`, except on a rehearsal that continues at a tool-only commit (`publish-contracts/src/tooling-sha.ts`): there it is the sha the deployment started at, the `coreSha` of `{evidenceDir}/publish-run.json`, as the publish CLI's own release gate does (owner decision 2026-10-19). A production run is always gated at its own sha.

`{releaseTag}` is the release candidate tag at `{gateSha}` (`release/<version>-rc.N-rehearsal` on a rehearsal): the release gate (P0.09) needs an annotated tag of the sheet's kind at that sha, nothing more. The record tag `release/<version>-rehearsal` is cut once, at the sha the deployment's run manifest names, and never moved (policy `docs/operations/contract-release-runbooks.md`, version tags).

A whole-element list placeholder expands to several argv elements: `{common}`, `{owners}`, `{gate}`, `{wait}`, `{emergency}`, `{cast}`. The definitions are `LIST_PLACEHOLDERS` in the validator. The scalar names are `SCALARS` in the same file.

## Run it

Until a runner is ported, an operator or an agent follows the YAML by hand. Each step's commands run in order from the root of the core checkout at the deploy sha. Pipe every command's stdout through `tee -a {runDir}/journal/<id>.out` (the verifier labels the later steps grep). Keep stderr, the JSON logs, apart in `{runDir}/journal/<id>.err`: a log field named `label` is not a verifier label, and the label parity check (P2.03) reads every `label` it finds. Write receipts to the paths the step names. Record each step's outcome in `{runDir}/journal/<id>.result` as one line: `pass`, `skip <reason>` or `fail exit <n>`. A retry that passes overwrites it. The rollout report (P10.51) lists a failed step, or a journaled step with no result, as an issue, and the sign-off (P10.52) is then refused.

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
