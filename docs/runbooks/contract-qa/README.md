# Contract QA runbook

The rehearsal deploy runbook deploys a contract release on a network, governs it and proves it works. It runs in three environments. The policy is `docs/operations/contract-release-runbooks.md` (4.4, 4.12 and 4.14). The format follows the frontend release runbooks.

## Branches and tags

The release line is the branch `releases-A.B.x` (for example `releases-0.5.x`). Feature PRs never target it. The policy (sections 2, 3 and 4.14) is the rule. In short:

1. QA runs the release file on the `twin` target (the stage host `rm-core-stage-1`) at a clean, pushed commit of `qa/A.B.x-<YYYY-MM-DD>`, cut from the release branch tip. Every patch of the session merges into that QA branch by PR. A pushed QA branch is never rewritten, and it is kept after its squash.
2. When the run passes at a commit, the QA branch is squash-merged onto `releases-A.B.x`. The squash tree equals the passed tree, and the release branch has not moved since the QA branch was cut.
3. The rc tag is cut at the squash commit: `release/vA.B.C-rc.N` (production kind) or `release/vA.B.C-rc.N-rehearsal` (rehearsal kind). It is annotated and pushed.
4. The `rehearsal` and `production` targets run only from that rc tag, with the owner's recorded go. An agent never broadcasts to Base 8453 without it. The version tag `vA.B.C` is cut at the final rc's commit after the postflight is clean (production kind only).

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

The template itself can change. When a release is finished, its file pins `templateSha`, the full commit its template steps were copied from. A pinned release is a record. The validator reads `template.yaml` at that commit from git and checks the release add-only against it, never against the current template or the current CLIs. A `templateSha` with no template in git is refused. Only an unpinned release, the one being prepared, must match the current template.

## Next release

0. Land the release's scope on `releases-A.B.x` and cut the QA branch (policy section 2). Do the steps below on the QA branch.
1. Create `releases/<next>.yaml` with no `templateSha`. Copy the current template steps into it, unchanged and in order.
2. Add the steps only that release needs, each marked `added: <next>`, with an id the template lacks.
3. Run `bun scripts/runbook/validate-contract-qa.ts`. The unpinned file is checked against the current template and the current CLIs.
4. Run the release on the QA branch (the `twin` target), then squash and run it from the rc tag (`rehearsal` or `production`, policy section 4.14).
5. After the production run, pin `templateSha` to the commit of the template the steps were copied from (`git log -1 --format=%H -- docs/runbooks/contract-qa/template.yaml`). From then on the validator checks the file add-only against the template at that commit, read from git, and the template is free to change.

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

- P0.12 is written with `host: "control"` but starts the fork on the stage host (`rm-core-stage-1`): run the two `twin-fork.ts` commands over ssh there with `--state-dir <hostStateDir>/twin`, where `<hostStateDir>` is the host-side mirror of `{runDir}` on the stage host (for example `$HOME/tmp/twin-qa-v060/host-<run name>`). The exact file they write is `<hostStateDir>/twin/anvil.json` on the stage host. After `wait-ready`, copy it back to `{runDir}/twin/anvil.json` on the operator machine (`scp rm-core-stage-1:<hostStateDir>/twin/anvil.json {runDir}/twin/anvil.json`), because the step's receipt check reads `{runDir}/twin/anvil.json` on the machine that holds the run directory.
- Port rule: P0.12 and P10.07 hard-code port `8545`. The runner must confirm before P0.12 that port 8545 is free on the stage host (for example `ss -ltn 'sport = :8545'` prints no listener), because the host can also run a foreign anvil. If it is not free, stop and free it. Do not edit the port in a committed release yaml.
- The v0.6.0 release adds a second Twin fork for its phase 8 (issue 1927, runbook 4.15 rehearsed from a real v0.5.0 deployment): P8.00 checks that forge, cast and anvil are Foundry 1.8.5 on both hosts (on the stage host it calls `$HOME/.foundry/bin/<tool>` by path, since a non-interactive ssh shell has no Foundry on PATH: install 1.8.5 there with `foundryup -i v1.8.5` before the run). P8.02 starts the fork on the stage host over ssh like P0.12, on port 8547 with `--pin-block 52881000` and `--state-dir <hostStateDir>/twin-v050`; after `wait-ready`, copy `<hostStateDir>/twin-v050/anvil.json` back to `{runDir}/twin-v050/anvil.json` (`scp rm-core-stage-1:<hostStateDir>/twin-v050/anvil.json {runDir}/twin-v050/anvil.json`), because the step's receipt check reads it there. P8.18's `twin-fork.ts stop` also runs over ssh on the stage host, with `--state-dir <hostStateDir>/twin-v050`. The upstream `BASE_UPSTREAM_RPC` must serve archive state at Base block 52881000: a node that has pruned it cannot fork there, and a later pin fails the v0.5.0 agent stage. Confirm port 8547 is free on the stage host before P8.02, as for 8545. `{v050RpcUrl}` is the local end of a second tunnel (`ssh -N -L 8547:127.0.0.1:8547 rm-core-stage-1`). The pin is fixed because the live RM V4 pool the v0.5.0 rmAGENT holds was drained at Base block 52881518. P8.01 checks out `release/v0.5.0-rehearsal` at `{runDir}/v050` (outside the core checkout, so the core checkout stays clean), P8.03 publishes it with that tag's own `publish-contracts/src/ci/twin-publish.ts` and links its run directory to `{runDir}/v050-run`, and the 4.15 commands run with `{v050common}` (`--core-dir {runDir}/v050` and the tag's sha).
- No rehearsal chain runs on the operator machine. That covers the Twin fork, any anvil and any fork of Base. A Twin run starts its fork on the stage host (P0.12 runs there over ssh).
- The operator machine drives the whole run over ssh. A `control` step on the Twin target reaches the stage fork through an ssh tunnel (`ssh -N -L <port>:127.0.0.1:<port> rm-core-stage-1`), and `{rpcUrl}` is the local end of that tunnel.
- Keys, passphrase files and keyed RPC URLs never leave the operator machine. Nothing on the stage host signs (`docs/development/stage-deployment.md`).
- A mainnet run (`rehearsal` or `production`) sends from the operator machine to `BASE_RPC_URL`.

## Placeholders

`{name}` is resolved at run time from the target, the sheet or the run. `{sheet:NAME}` reads a sheet line. `{m:file.key}` reads a deployment manifest. `{state:name}` reads a file an earlier step wrote under `{runDir}/state/`. `{journal:id}` reads an earlier step's journaled output.

`{manifestDir}` is `deployments/qa-runs/<run name>` in the core checkout. Forge may write manifests only under `./deployments` or `/tmp` (`fs_permissions` in `foundry.toml`). Git ignores `deployments/qa-runs/`, so verify (P2.01), which refuses a checkout with untracked files, still passes. Any other folder under `deployments/` fails P2.01, and a folder outside the checkout fails publish (P1.02). The dry run (P0.21) writes to `{runDir}/manifests-dry`, which P0.57 links to `{manifestDir}-dry` for the same reason.

`{gateSha}` is the sha whose tag, green CI and frozen counts gate the run (P0.20, P10.01). It is `{coreSha}`, except on a rehearsal that continues at a tool-only commit (`publish-contracts/src/tooling-sha.ts`): there it is the sha the deployment started at, the `coreSha` of `{evidenceDir}/publish-run.json`, as the publish CLI's own release gate does (owner decision 2026-10-19). A production run is always gated at its own sha.

`{releaseTag}` is the release candidate tag at `{gateSha}`. On the twin target the runner uses the QA branch name as the tag name (for example `qa/0.6.x-2026-10-23`), an annotated tag of the sheet's kind at `{gateSha}`, the tip of that QA branch. On a rehearsal or production run it is the tag at `{gateSha}`, the squash commit on the release branch (`release/<version>-rc.N-rehearsal` on a rehearsal, `release/<version>-rc.N` on a production run): the release gate (P0.20) needs an annotated tag of the sheet's kind at that sha, nothing more. The record tag `release/<version>-rehearsal` is cut once, at the sha the deployment's run manifest names, and never moved (policy `docs/operations/contract-release-runbooks.md`, version tags).

Placeholders the runner or operator supplies:

- `{owners}` expands to `--owner-signer {ownerSigner}`: one owner signer spec for the Safe owner set. On the Twin target the default throwaway keystores of P0.13 apply, so give none or one per sheet owner.
- `{emergency}` expands to `--emergency-signer {emergencySigner}`: the key that holds `EMERGENCY_ROLE`, used by `pause-all` and nothing else.
- `{releaseTag}` is defined above: the annotated rc tag at `{gateSha}` that the release gate (P0.20) reads.
- `{ownerSignerCount}` is the number of owner signer specs the operator passes to `{owners}`, and P0.17 hands it to `--owner-signers`. It is `0` on the Twin target (the default keystores sign) and equals the number of `SAFE_OWNERS` on a `rehearsal` or `production` run.
- `{receiptUri}` is the URI recorded on chain with the consensus receipt (`record-receipt --payload-uri`). It points at the stored receipt payload that `{receiptFile}` holds and is not a secret. The operator or runner supplies it.
- `{cast}` expands to `--keystore {deployerKeystore}`: the flags that `scripts/runbook/cast-send.sh` forwards to `cast send`. It is the deployer keystore only. The passphrase comes from the 0600 file of P0.13 and never appears on the command line.

A whole-element list placeholder expands to several argv elements: `{common}`, `{owners}`, `{gate}`, `{wait}`, `{emergency}`, `{cast}`. The definitions are `LIST_PLACEHOLDERS` in the validator. The scalar names are `SCALARS` in the same file.

## Target

The target deployment has three vaults: rmUSDC, rmPROTO and rmRWA (ADR-0017). A new release record has no `agent` or `recorder` stage. The v0.4.0 and v0.5.0 records are released and keep their rmAGENT steps.

## Run it

Until a runner is ported, an operator or an agent follows the YAML by hand. Each step's commands run in order from the root of the core checkout at the deploy sha: the QA branch commit on the `twin` target, the rc tag's commit on `rehearsal` and `production`. Pipe every command's stdout through `tee -a {runDir}/journal/<id>.out` (the verifier labels the later steps grep). Keep stderr, the JSON logs, apart in `{runDir}/journal/<id>.err`: a log field named `label` is not a verifier label. Write receipts to the paths the step names. Record each step's outcome in `{runDir}/journal/<id>.result` as one line: `pass`, `skip <reason>` or `fail exit <n>`. A retry that passes overwrites it. The rollout report (P10.51) lists a failed step, or a journaled step with no result, as an issue, and the sign-off (P10.52) is then refused. v0.6.0 has three vaults (ADR-0017): its added step P10.53 rewrites the report with `--vaults vault,protocol-asset-vault,rwa-basket-vault`, because a template step is never edited and the default reads four manifests.

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
