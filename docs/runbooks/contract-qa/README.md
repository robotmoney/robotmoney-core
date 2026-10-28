# Contract QA runbook

The rehearsal deploy runbook deploys a contract release on a network, governs it and proves it works. It runs in three environments. The policy is `docs/operations/contract-release-runbooks.md` (4.4, 4.12 and 4.14). The format follows the frontend release runbooks.

## Assurances

A run of a release file is the proof of three things. Each step proves part of one of them, and the `standing` field names the policy section it proves.

| Assurance | What the steps prove |
| --- | --- |
| The code on chain is the tagged build | the release gate (tag, remote, branch, green CI), every implementation's and library's code hash against the build, append-only storage layouts |
| Only the intended parties can change anything | the Safe owners and threshold, the timelock roles and delay, every role holder of every governed contract enumerated from logs, the deployer holding no role, no shares and no agent registration |
| Each governed operation did what the release says, and nothing else | the implementation slots, the migration run once, the roles after it, the state before the operation still readable after it, every operation scheduled, delayed and executed through the timelock (the evidence checks read this from the chain) |
| The governance pipeline works on the new state | a submitter registered, a receipt recorded by it, the receipt applied through the Safe and the timelock, the router weights read back equal to it |
| Users and agents can use it | a deposit and a redeem in each vault and a deposit through the router split by the effective weights, both before and after the router rebalance ("Before and after the rebalance"), an agent consented, deposited through the gateway and revoked, a retired vault refusing a real deposit and paying its holders |
| The safety controls work | pause-all with the emergency key, a redeem while paused, the unpause rounds through the Safe, the unwind and slippage guards set |
| The record is complete, and nothing happened outside it | every step that runs on the target has a result, every transaction a marked sender made during the run is one a step journaled, the sign-off written from the report |

Two rules follow from this:

- **QA runs everything mainnet runs, and more.** A step of the `rehearsal` or `production` target is a step of the same file that the `twin` target ran at the same template. A mainnet rehearsal may send only what a passing Twin run sent (policy 4.14). The Twin adds what only a disposable chain allows (the Twin-only steps).
- **"Complete" is a record, not a claim.** A run is complete when `P10.52-record-signoff` wrote `{runDir}/go/signoff.json`. The report it checks lists every applicable step without a result, every failed step, every vault still paused and every transaction sent outside the journal as an issue. Nothing an operator or an agent says changes that.

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
| `gateway.yaml` | The gateway system's own runbook (issue 1892): deploy, verify, an agent deposit through the gateway, evidence. |
| `../../../scripts/runbook/run.ts` | The runner. It runs a release file on a target from the first step that runs there to the last, journals every command and writes every result. |
| `../../../scripts/runbook/validate-contract-qa.ts` | The checker. Run it with no arguments for the template and every release file. |
| `../../../scripts/runbook/qa-assert.ts` | The small assertions a step makes between two commands: share deltas, the router deposit's legs against a weight vector, a split that changed across the rebalance. |
| `../../../scripts/runbook/cast-send.sh` | `cast send` that fails on a mined revert: cast exits 0 when a send with `--gas-limit` is mined with status 0. Every step sends through it. |
| `../../../scripts/runbook/run-record.ts` | Writes the run's own records: the publish go (with the senders' nonces), a later sender's nonce mark, the Twin freeze go, the rollout report and the sign-off. |
| `../../../scripts/runbook/receipt-payload.ts` | The Twin's receipt payload: the real production envelope with the three-vault vector. On 8453 the operator passes the receipt the canonical route serves. |

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

## Before and after the rebalance

The router rebalance is the `apply-receipt` govern row: the submission that applies a recorded receipt is the rebalance (`publish-contracts/src/govern.ts`). ADR-0003 routes only new deposits by the new vector and moves no existing funds. So a run proves the vaults and the router on both sides of it (issue 1984). Each flow runs one round before the step that applies the receipt and one after it.

| Flow | Before the rebalance | The rebalance | After the rebalance |
| --- | --- | --- | --- |
| new | P5.05, P5.10, P5.11, P5.13, P5.20, P5.21, P5.23, P5.30, P5.31 (before P5.02 records the receipt) | P5.03 | P6.10 to P6.31, with P6.32 |
| upgrade | P8.25 (funding), P8.40 to P8.48 (before P8.22 records the receipt) | P8.23 | P8.26 to P8.29, P8.49, P8.50, and P8.35 while paused |

- The round before: P5.05 (P8.40) saves the router's effective weights as the pre-rebalance vector, whatever `votedWeightsActive` reads. The runbook never clears a vector to reach a default (issue 1980): on a new deployment the effective vector is the sheet's default, on the live deployment it is the vector in effect. It also refuses a receipt whose vault vector equals it (`qa-assert.ts receipt-changes-split`): such a receipt cannot show the split change. It runs before the receipt is recorded, so it stops the run before anything irreversible. Then one direct deposit into each of rmUSDC, rmPROTO and rmRWA (shares against previewDeposit, measured as the balance after less the balance before), a full redeem of each (rmPROTO by redeemInKind), one router deposit whose RouterDeposit legs are exactly the saved vector's non-zero weights (`qa-assert.ts router-legs`: the vault and weightBps of every leg, shares minted), and a full redeem of the router positions. Every step ends with the deployer holding no shares. Its state is named `pre-*` (`v050-pre-*`), apart from the later round's `preview-*` and `shares-*`.
- The round after: the existing deposits, redeems and router deposit. P6.32 (P8.49) then checks the router deposit's legs against the effective weights now (the receipt's vector, which P5.04 and P8.24 read back) and against the legs of the round before (`qa-assert.ts legs-differ`): the split changed. In the upgrade flow P8.50 redeems the round's positions with deposits open, and P8.35 still redeems the gateway deposits while paused.
- The Twin's receipt payloads (P5.00, P8.19) use USDC 8000, PROTO 1000, RWA 1000: every vault has a weight, so the router deposit after the rebalance has three legs (8,400,000 gas covers 400,000 plus 2,550,000 per leg; the router's own floor is 2,400,000 per leg of the vector, zero-weight legs included, so it is the same before and after). It differs from the vector in effect before the rebalance (the default 9500, 500, 0 on a new deployment), so a Twin run proves a changed split. On 8453 the operator's receipt must also differ from the default vector, or P5.05 (P8.40) stops the run before the receipt is recorded.
- Rerun: the runner skips a step that passed. A deposit step that failed after its send measures the shares of its own send (the balance delta), and a redeem takes the whole balance, so a rerun still checks what it sent.

The validator enforces it: for every flow and target where a step runs the `apply-receipt` row, a step marked `exercises: vault-deposit`, one marked `exercises: router-deposit` and one marked `exercises: redeem` run before the first such step and again after the last one. A step counts only by that field, never by its command alone: the Twin's dirty pre-state deposit (P8.05), the cleanup redeem of the live pre-state (P8.06), the retired-vault redeem (P6.24) and the refused rmAGENT probe (P8.33) send the same calls and prove no round. A step that carries the field must send that call through `scripts/runbook/cast-send.sh`, so the label cannot stand in for the send. Pinned releases (v0.4.0, v0.5.0) are records and are not reopened.

## Targets

The environment is chosen at run time with `--target twin|rehearsal|production`. There are no per-environment files. Only parameters differ. A step that exists for one environment says so with `onlyFor`.

## Flows

A release has two flows. The **new** flow deploys the release at new addresses (the template steps). The **upgrade** flow upgrades the live deployment in place (a governed upgrade, policy 4.12 and 4.14: the steps the release adds for it, v0.6.0's phase 8). A step names its flows with `flow:` (absent: `new`). A release names the flows each target runs with `flows:`; absent, every target runs the new flow. A step runs on a target when its `onlyFor` admits the target and its flow is one the release runs there, and every such step must run: the report lists one that did not as an issue.

v0.6.0 runs both flows on the Twin in one run, the upgrade flow on the 8453 rehearsal (the live Deploy 3 record) and the new flow in production. In the upgrade flow the `{v050...}` placeholders name the live deployment: on the Twin the v0.5.0 tag run the flow itself publishes (P8.03), on 8453 the Deploy 3 record. `{v050CoreDir}` is the checkout whose build is the live one (a rebuild elsewhere embeds another path in the metadata and fails the library hash check, issue 1926). Template steps with no `flow` belong to the new flow only: the Twin keys and fork, the sheet merge, the plan and the dry run of a new deployment, the publish and its verifies, the first govern rounds, the template's own receipt and deposit rounds and pause drills, the frozen-counts evidence check. The upgrade flow has its own steps for the same assurances against the live deployment (phase 8): P8.06 reads its pre-state, P8.20 to P8.24 govern a receipt with the round before the rebalance (P8.25, P8.40 to P8.48) ahead of its record and apply, P8.26 to P8.33 and P8.49 and P8.50 deposit and redeem after it, P8.34 to P8.36 drill the pause, P8.37 and P8.38 verify and check the evidence. The steps that do belong to both are marked `flow: ["new", "upgrade"]`.

**What these records cannot do.** They stop an honest run that skips, forgets or sends outside the runbook, and a hand-edited report (the sign-off computes the report again). They cannot stop someone who holds the keys and the run directory from forging a result file, a `done-*` marker or a journal line: a sign-off is evidence the run produced, not an authority. The sender nonce check covers the deployer and the emergency key, not the Safe owners' keys. The report redacts every URL in a journal line, because it is published and a cast error can print the keyed RPC URL; the journal itself stays in the run directory outside the repo.

On a deployment that is already upgraded, P8.07 (which runs on every invocation and only reads) writes a `done-*` marker for each governed operation the chain and the run manifest show executed; the operation's steps are then skipped by their own `gateAbsent`, the report lists the skips, and every later step still runs.

No step clears the router's voted vector (`govern --row clear-voted-weights`, or a direct `clearVotedWeights()` call): the owner decided the runbook never does (issue 1980), because a rerun or a resume cleared the vector the flow had applied itself. The validator refuses such a step in the template and in the release being prepared. The router deposit after the rebalance (P8.29) first reads `votedWeightsActive` true and the effective weights equal to the receipt's, so a lost vector fails the run instead of routing on the default.

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

- The Twin fork steps (P0.12, and in v0.6.0 P8.02) run on the stage host from the yaml itself, as `ssh` commands: the host checkout `{stageCore}` is fetched and checked out at `{coreSha}` (clean tree, submodules updated), the port is checked free on the host (8545, and 8547 for the second fork; a listener with no `anvil.json` of this run is a foreign anvil and the step exits 70: stop it, do not edit the port), the fork is started and waited ready with the host's Foundry 1.8.5 at `$HOME/.foundry/bin`, an ssh control-socket tunnel (`ssh -f -N -M -S {runDir}/tunnel-<port>.sock -L {tunnelPort}:127.0.0.1:8545`) brings it to a local port, and `anvil.json` is copied back to `{runDir}/twin/anvil.json` with `scp`, because the step's receipt check reads it on this machine. These two steps are marked `refresh`: on every invocation they find the fork already running (its `anvil.json` is there and the port answers) and reopen the tunnel if it died (a stale control socket left by a dead master is removed first, so the teardown's `ssh -O exit` always reaches the live master). The teardowns (P10.07, and P10.06 for the upgrade flow's fork, which runs after the sign-off because the report and the sign-off read that fork) close the tunnel with `ssh -O exit` and stop the fork on the host. The validator refuses a step that runs `twin-fork.ts` or `anvil` as a command of this machine.
- The runner config gives the host scalars: `{stageHost}` (the ssh config alias, `rm-core-stage-1`), `{stageCore}` (the core checkout on the host, relative to its home, for example `tmp/twin-qa-v060/core`), `{stageDir}` (this run's state dir on the host, relative to its home, for example `tmp/twin-qa-v060-9/host-run1`: one per run, never shared), and `{tunnelPort}` and `{tunnelPort2}` (the local ends of the two tunnels, which `{rpcUrl}` and `{v050RpcUrl}` point at). The control socket path is `{runDir}/tunnel-<port>.sock`: keep the run directory path short: ssh adds a 17-character suffix while it creates the socket and a unix socket path holds 107 bytes, so `{runDir}/tunnel-8545.sock` must be 90 characters or fewer (the runner refuses a longer one on the twin target). The upstream Base endpoint the fork uses is the host's own configuration: no keyed RPC URL is sent to the host.
- The v0.6.0 release adds a second Twin fork for its phase 8 (issue 1927, runbook 4.15 rehearsed from a real v0.5.0 deployment): P8.00 checks that forge, cast and anvil are Foundry 1.8.5 on both hosts (on the stage host it calls `$HOME/.foundry/bin/<tool>` by path, since a non-interactive ssh shell has no Foundry on PATH: install 1.8.5 there with `foundryup -i v1.8.5` before the run). P8.02 starts that fork with `--pin-block 52881000`. The upstream the host forks from must serve archive state at Base block 52881000: a node that has pruned it cannot fork there, and a later pin fails the v0.5.0 agent stage. The pin is fixed because the live RM V4 pool the v0.5.0 rmAGENT holds was drained at Base block 52881518. P8.01 checks out `release/v0.5.0-rehearsal` at `{runDir}/v050` (outside the core checkout, so the core checkout stays clean), P8.03 publishes it with that tag's own `publish-contracts/src/ci/twin-publish.ts` and links its run directory to `{runDir}/v050-run`, and the 4.15 commands run with `{v050common}` (on the Twin `--core-dir {v050CoreDir}` is `{runDir}/v050`, and the tag's sha). P8.04 checks out the qa commit a second time at `{runDir}/v060` (with submodules) and runs `forge build --root {runDir}/v060 --out {runDir}/v060/out` there, and P8.10 to P8.13 pass `--upgrade-build {runDir}/v060`. A plain `forge build` in the main checkout would replace its library-linked `out/`, which P9.05 and every later verify read (issue 1929). The validator refuses a forge build, script, clean or test after P1.02-publish unless it names `--root` and `--out` under `{runDir}`. P10.06 removes both checkouts.
- No rehearsal chain runs on the operator machine. That covers the Twin fork, any anvil and any fork of Base. A Twin run starts its fork on the stage host (P0.12 runs there over ssh).
- The operator machine drives the whole run over ssh. A `control` step on the Twin target reaches the stage fork through an ssh tunnel (`ssh -N -L <port>:127.0.0.1:<port> rm-core-stage-1`), and `{rpcUrl}` is the local end of that tunnel.
- Keys, passphrase files and keyed RPC URLs never leave the operator machine. Nothing on the stage host signs (`docs/development/stage-deployment.md`).
- A mainnet run (`rehearsal` or `production`) sends from the operator machine to `BASE_RPC_URL`.

## Placeholders

`{name}` is resolved at run time from the target, the sheet or the run. `{sheet:NAME}` reads a sheet line. `{m:file.key}` reads a deployment manifest. `{state:name}` reads a file an earlier step wrote under `{runDir}/state/`. `{journal:id}` reads an earlier step's journaled output.

`{v050Sheet}`, `{v050CoreDir}`, `{v050CountsDir}`, `{v050EvidenceDir}`, `{v050ManifestDir}` and `{v050RpcUrl}` name the live deployment of the upgrade flow ("Flows"). `{v050Signer}` is its deployer's signer spec, `{v050OwnerSigner}` one of its Safe owners' specs, `{v050EmergencySigner}` its emergency key's spec, `{v050DeployerKeystore}` and `{v050CastFlagsInline}` its deployer keystore for `cast send`. On the Twin they point into `{runDir}/v050-run` (the tag run of P8.03) and the signer lists are empty, because that run's keystores sign by default.

`{manifestDir}` is `deployments/qa-runs/<run name>` in the core checkout. Forge may write manifests only under `./deployments` or `/tmp` (`fs_permissions` in `foundry.toml`). Git ignores `deployments/qa-runs/`, so verify (P2.01), which refuses a checkout with untracked files, still passes. Any other folder under `deployments/` fails P2.01, and a folder outside the checkout fails publish (P1.02). The dry run (P0.21) writes to `{runDir}/manifests-dry`, which P0.57 links to `{manifestDir}-dry` for the same reason.

`{gateSha}` is the sha whose tag, green CI and frozen counts gate the run (P0.20, P10.01). It is `{coreSha}`, except on a rehearsal that continues at a tool-only commit (`publish-contracts/src/tooling-sha.ts`): there it is the sha the deployment started at, the `coreSha` of `{evidenceDir}/publish-run.json`, as the publish CLI's own release gate does (owner decision 2026-10-19). A production run is always gated at its own sha.

`{releaseTag}` is the release candidate tag at `{gateSha}`. On the twin target the runner uses the QA branch name as the tag name (for example `qa/0.6.x-2026-10-23`), an annotated tag of the sheet's kind at `{gateSha}`, the tip of that QA branch. On a rehearsal or production run it is the tag at `{gateSha}`, the squash commit on the release branch (`release/<version>-rc.N-rehearsal` on a rehearsal, `release/<version>-rc.N` on a production run): the release gate (P0.20) needs an annotated tag of the sheet's kind at that sha, nothing more. The record tag `release/<version>-rehearsal` is cut once, at the sha the deployment's run manifest names, and never moved (policy `docs/operations/contract-release-runbooks.md`, version tags).

Placeholders the runner or operator supplies:

- `{owners}` expands to `--owner-signer {ownerSigner}`: one owner signer spec for the Safe owner set. On the Twin target the default throwaway keystores of P0.13 apply, so give none or one per sheet owner.
- `{emergency}` expands to `--emergency-signer {emergencySigner}`: the key that holds `EMERGENCY_ROLE`, used by `pause-all` and nothing else.
- `{releaseTag}` is defined above: the annotated rc tag at `{gateSha}` that the release gate (P0.20) reads.
- `{ownerSignerCount}` is the number of owner signer specs the operator passes to `{owners}`, and P0.17 hands it to `--owner-signers`. It is `0` on the Twin target (the default keystores sign) and equals the number of `SAFE_OWNERS` on a `rehearsal` or `production` run.
- `{receiptFile}` is the consensus receipt payload the run records and applies. On the Twin, `P5.00-receipt-payload` (and `P8.19` in the upgrade flow) writes it: the real production envelope with the three-vault vector. On 8453 the operator passes the latest receipt the canonical route serves; `apply-receipt` refuses one that weights `agent_tokens` (ADR-0017) and the run stops there, so the committee issues a receipt the router can take.
- `{receiptUri}` is the URI recorded on chain with the consensus receipt (`record-receipt --payload-uri`). It points at the stored receipt payload that `{receiptFile}` holds and is not a secret. The operator or runner supplies it.
- `{cast}` expands to `--keystore {deployerKeystore}`: the flags that `scripts/runbook/cast-send.sh` forwards to `cast send`. It is the deployer keystore only. The passphrase comes from the 0600 file of P0.13 and never appears on the command line.

A whole-element list placeholder expands to several argv elements: `{common}`, `{gcommon}`, `{v050common}`, `{owners}`, `{v050owners}`, `{gate}`, `{wait}`, `{emergency}`, `{v050emergency}`, `{cast}`, `{v050cast}`. The definitions are `LIST_PLACEHOLDERS` in the validator. The scalar names are `SCALARS` in the same file. The runner's config may give a list its value for the target (`lists`): `{owners}`, `{v050owners}`, `{emergency}` and `{v050emergency}` are empty on the Twin, and on 8453 `{v050common}` is the README definition plus one `--owner-signer` per live Safe owner, because the upgrade flow's commands take no separate owner list.

## Target

The target deployment has three vaults: rmUSDC, rmPROTO and rmRWA (ADR-0017). A new release record has no `agent` or `recorder` stage. The v0.4.0 and v0.5.0 records are released and keep their rmAGENT steps.

## Run it

One command runs a release on a target, from the first step that runs there to the last:

```
bun scripts/runbook/run.ts --release v0.6.0 --target twin --config ~/tmp/<run>/config.json
```

The config is a JSON file outside the repo, `{"scalars": {...}, "lists": {...}}`: every scalar placeholder above, and a list placeholder's value for the target where it differs from the definition. A keystore spec in it is a path; the passphrase is typed at the CLI's own prompt on the terminal the runner runs in (8453 refuses passphrase files), and never written anywhere. The runner refuses to start on a runbook the validator rejects, or on a target the release does not run.

For every step that runs on the target the runner, in order: skips a step whose result is already `pass` unless it is marked `refresh` (so the same command continues a run after a failure; P0.12, P8.02 and P8.07 refresh, because they reopen the tunnel or re-read the chain, and P8.06, which redeems and revokes, runs once); adds `--resume` to a `publish` that failed on the earlier invocation (the CLI refuses a rerun without it); writes `skip <reason>` for a step whose `gateAbsent` file exists or whose `sheetIs` line differs; refuses a `go` step whose record is missing; waits out `notBefore` itself (the earlier step's result time plus its hours, the sheet's `TIMELOCK_MIN_DELAY` for `timelockDelay`); runs each command from the checkout root with the step's env, stdin on the terminal, stdout appended to `{runDir}/journal/<id>.out` and stderr to `<id>.err` (both also shown); requires the exit code to be one of `expectExit` and every required receipt to exist; writes `pass` or `fail exit <n>` to `{runDir}/journal/<id>.result`, and stops on a failure. There is no option to skip a step. `--from` and `--to` bound a continuation only: a step without a result stays an issue in the report, so a bounded run cannot sign off. `--dry-run` prints the resolved commands and writes nothing.

The record of the run is written by the run: `P1.50-record-go` records the sha, target, sheet hash and the deployer's and emergency key's nonces; `P10.51-write-rollout-report` (and v0.6.0's P10.53) writes `rollout-report.md` with every step's journal and result, every evidence file's sha256, and as issues every failed step, every applicable step with no result, every vault still paused and every transaction a marked sender made that no step journaled; `P10.52-record-signoff` writes `go/signoff.json` only when the report lists no issue and matches the go. That file is what "the run is complete" means. An operator or an agent reports the run by quoting it, and reports nothing as done that it does not show.

Check before any run:

```
bun scripts/runbook/validate-contract-qa.ts
bun scripts/runbook/validate-contract-qa.ts --release v0.6.0 --target twin --runnable
bun scripts/runbook/validate-contract-qa.ts --check-sheet <sheet.env> --target twin
bun scripts/runbook/run.ts --release v0.6.0 --target twin --config <config.json> --dry-run
```

A `production` run is refused while any owner decision is open or `productionReady` is `false`. Only the owner sets those.

## Rules

- Steps run in phase order, 0 to 10.
- An irreversible step carries `notBefore`, `onlyFor` or `go`.
- A step reads only state an earlier step (or the step itself) writes.
- No step waits on a file a person makes at run time. A record a step checks is written by an earlier step, or committed and reviewed (the Deploy 3 sheet fragment, `deployments/base-8453-rehearsal/deploy-3.env`).
- No secret and no keyed RPC URL appears in any file here.
- Core never imports devops. A step calls the documented `publish-contracts` CLI only.
- Every flow that applies a receipt deposits into each vault, deposits through the router and redeems both before and after it ("Before and after the rebalance").

The tests are `scripts/runbook/validate-contract-qa.test.ts`, `scripts/runbook/qa-assert.test.ts`, `scripts/runbook/run-record.test.ts` and `scripts/runbook/run.test.ts`. CI runs them in the doc checks suite.
