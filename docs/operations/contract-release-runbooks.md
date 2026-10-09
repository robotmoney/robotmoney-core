# Contract release process — foundational runbook policy

> **Status: in effect.** This document defines the foundational
> release-runbook policy that every per-release contract-deployment runbook
> must follow. It is not itself a runnable checklist; concrete deployments
> are executed from per-release runbooks committed under `docs/runbooks/`
> (see §5). An example is [`docs/runbooks/v0.1.0-devnet-verification.md`](../runbooks/v0.1.0-devnet-verification.md).
>
> Modeled on the sibling frontend repo's `docs/technical/release-runbooks.md`
> policy, adapted for immutable Solidity contract deployments rather than a
> mutable Postgres-backed application: there is no schema migration, no
> in-place rollback, and "the release branch" is the stage scripts under `contracts/script/` (listed in
> `scripts/deploy/stage-table.json`) at a specific commit, not a database.

This is not the process for landing ordinary feature work — that is PR review
against `dev`, covered by the repo's CI taxonomy. This document is
specifically about the step where a set of already-merged `dev` history is
packaged, rehearsed, and cut over into a real chain deployment — Robot Money
Devnet or Base mainnet.

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

## 2. Release identity and target network

Each contract release is identified by a semantic version `vA.B.C`, minted
**only for a change that actually ships** — i.e. a real, addressed deployment
to a real network (Robot Money Devnet or Base mainnet). A
rehearsal that does not produce a lasting, addressed deployment record does
not consume a version number.

Unlike the frontend's `releases-A.B.x` branch convention, contract releases
do not need a dedicated long-lived branch: the scripts under `contracts/script/`
already read every deploy-time parameter from
environment variables, so the same scripts at a single commit on `dev`
deploy to every target network. The version tag `vA.B.C` is cut on `dev` at
the exact commit that was deployed and verified — there is no cherry-pick
dance, because there is no long-lived release branch to keep in sync.

A version tag is **network-scoped**: `vA.B.C` alone always means the Robot
Money Devnet (§8's default target), and a network suffix names anything
else — `vA.B.C-base` (mainnet). A given `vA.B.C` may
exist for multiple networks (a Devnet verification pass, later followed by a
Base mainnet deployment of the identical commit), and each network's tag is
its own go/no-go cycle through §4.

## 3. Version tags and rehearsal candidates

This section covers two different tags. Do not confuse them.

- The **release tag** (`release/<version>`, annotated) names the release SHA
  *before* the final Twin rehearsal. It is the contracts-freeze gate: tag the
  release SHA, run the final Twin rehearsal at that SHA, then commit its
  frozen per-stage transaction counts to
  `deployments/frozen-counts/<sha>.json`. The rehearsal is the `core-stages-twin-chain`
  job of suite 28 (every push to `dev` and the nightly). Download the `rehearsal-counts-<sha>`
  artifact of the release SHA's run, review `counts.json`, and write its `counts` (with `deploySha` and
  the `measured` chain id and time) to that file with
  `bun publish-contracts/scripts/freeze-counts.ts --counts counts.json`. Take the artifact from the
  **push** run of the tagged SHA: on a pull request `github.sha` is the merge commit, not the release SHA.
  CI never commits it. The mainnet plan job refuses any
  `DEPLOY_SHA` that is not an annotated-release-tagged SHA (`RELEASE_SHA_UNTAGGED`), whose tag object differs from, or is missing on, the checkout's `origin` or whose remote is unreachable (`RELEASE_TAG_REMOTE_MISMATCH`, exit 23; push the tag before planning), has no committed
  frozen counts (`COUNTS_MISSING`) or is not green in `check-sha-green` (`CI_NOT_GREEN`).
  Any later commit that changes `contracts/` has a new SHA with no tag and no
  counts, so it needs a new rehearsal and tag. This flow is enforced by the plan job (core #1524).
  - **Green rehearsal only.** The artifact uploads even when the rehearsal failed. The job therefore records its
    own conclusion in `counts.json` (`rehearsal.conclusion`), and `freeze-counts.ts` refuses any file whose
    conclusion is not `success` (core #1602). `core-stages-twin-chain` is deliberately not in
    `scripts/ci/required-checks.json`: it reads a public upstream that can rate limit, and a required entry would
    block every DEPLOY_SHA on a provider outage. Freezing needs a green run, and `check-sha-green` still gates the plan.
  - **Required list source.** `check-sha-green` runs from the tagged SHA's own checkout, so it reads that SHA's
    `scripts/ci/required-checks.json`. Review that file's diff since the last release before tagging.
  - **Later 8453 stages (decision, core #1602).** Only the `plan` stage checks the tag and green CI. Later stages check the
    frozen counts file only. Default: they do not re-check, because the deploy job needs the plan job in the devops
    workflow, and a re-check days later (stage 13 runs after the 48-hour delay) would fail on an unrelated
    flaky check mid-deploy. Revisit if a deploy job ever runs without the plan job.
  - **Remote tag check (core #1602).** The plan compares the local `release/<version>` tag with `origin` of the core
    checkout (`git ls-remote`): the remote must hold the same tag object. Push the tag before planning.
  - **Optional hardening (owner action, defense in depth).** A GitHub tag ruleset stops a pusher from creating or moving a
    release tag at all. Settings: target `Tags`, pattern `release/*`, enforcement `Active`, rules `Restrict creations`,
    `Restrict updates` and `Restrict deletions`, bypass list only the release owners. The gate does not depend on it.
- The **version tag** (`vA.B.C[-network]`) is the post-deploy record
  described in the rest of this section.

A version tag is **never** cut before **both** a completed preflight and a
completed postflight on the target network. The version tag records what has
been *proven deployed*, not what is *intended for deployment*. Everything
before that point is a rehearsal candidate, referenced by commit SHA (and,
for mainnet, by its release tag), not a version tag.

The cycle:

1. Pick the `dev` commit SHA you intend to deploy. For mainnet this is the
   release-tagged SHA with committed frozen counts (see above).
2. Run preflight against that SHA (§4.1-4.2). **Preflight fails** → fix on
   `dev`, pick the new tip, return to step 2.
3. **Preflight passes** → run the deploy ceremony against the target network.
4. Run postflight (§4.3-4.4). **Postflight fails** → see §4.5 (fix loop) —
   patch on `dev`, and go back through preflight (step 2) before deploying
   again. A contract deployment cannot be "patched in place": a postflight
   failure after broadcast means either the deployed contracts are
   unusable (redeploy fresh addresses) or a mitigating admin action (deposit pause,
   role revocation) contains the issue while a fix lands (§4.6).
5. **Postflight clean** → tag `vA.B.C[-network]` at the exact commit that was
   deployed and verified.

Two consequences, stated outright because each one looks unusual and neither
is a mistake:

- **The version tag can never be cut at a commit that was not actually
  deployed and verified.** A fix that lands after the deployment requires a
  new deployment (and, for anything past the Devnet, a new tag) — it cannot
  be "rolled into" a tag for a commit that was never broadcast.
- **A version tag may exist on multiple networks at different times**, each
  its own deploy record under `deployments/<network>.json` (§8's naming) —
  this is expected, not duplication.

## 4. Foundational release workflow

Every per-release runbook must implement the following workflow, in order.
Each gate is blocking: the runbook must stop and escalate if a gate fails,
and no later gate may be started until the current one is satisfied or
explicitly waived by the operator with a written reason.

### 4.1. Code-readiness gate

Before any deployment activity, verify both of the following:

1. The release tracking issue is closed/complete — every linked task is
   closed, and the release's objective is clearly stated (§6).
2. `forge build` succeeds against the commit SHA being deployed, with no
   uncommitted local changes (`git status --short` is clean at that SHA).

Do not begin preflight, rehearsal, or any other deployment step while either
of the above is incomplete.

### 4.2. Preflight

Before any transaction is broadcast:

1. **Guard scripts.** Run `scripts/release/preflight-guards.sh`
   (network-agnostic — it checks the exact `forge
   build` artifacts, not a specific chain): the EIP-170 size gate on every
   contract in the ceremony's runtime set, and the env-default guard against
   an unsafe `RouterGovernance` `EXECUTION_DELAY`/`QUORUM_THRESHOLD`.
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
rehearsal of publish, verify and govern runs on every push to `dev` (not
yet implemented: core #1523).

The stage sequence. The stage table holds the forge stages 1 to 11; the CLI
adds `safe`, `prove-control` (between stages 10 and 11), `verify` and `govern`:

| Stage | What it does |
| --- | --- |
| 0 `safe` | Create a canonical SafeL2 1.4.1 through the canonical factory from the sheet's owners and threshold (threshold ≥ 2), then read it back. |
| 1 `libs` | Deploy TickMath. The basket stages link it. |
| 1b `recorder` | Deploy `UniswapV4PriceRecorder` for the RM pool key in `config/agent-token-shortlist.json`, grow its ring to 901 slots in chunks of 250 and record the first snapshot. No role is involved: anyone could send every one of these transactions, and the deployer holds nothing on it afterwards. It runs right after `libs` so the 30 minute price history accumulates while the other stages run. It keeps the stage numbers around it (it is stage 1b, not a renumbering). The manifest `recorder.json` names the recorder. |
| 2 `vault` | rmUSDC and its lending adapters. Seed 1 USDC to `SEED_SHARE_RECEIVER`; the deployer holds no shares. |
| 3 `registry` | Register rmUSDC. |
| 4 `router` | Portfolio Router, `registry.setRouter`. |
| 5 `gateway` | Gateway with the router as an immutable. No agent is authorized: `DeployGateway` reads no `AGENT_*` input and the sheet refuses them. Depositors authorize their own agents through `commitAuthorization` and `revealAuthorization`. |
| 6 `governance` | RouterGovernance from the sheet. |
| 7 `ic-policy` | IC policy and consensus receipt, bound to the gateway. |
| 8 `proto` | rmPROTO, paused, wETH and cbBTC, registered. |
| 9 `agent` | rmAGENT, paused, RM (`0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3`) on the Uniswap V4 RM/USDC 2.91% pool (owner, 2026-10-08; supersedes the 2026-10-06 V3 decision), registered with venue V4, the price recorder from stage 1b as its pool and `UniswapV4SwapAdapter` as its adapter (the script allowlists the adapter codehash and applies `maxSlippageBps` 500 from the config, because the pool fee alone is 291 bps). RM is in `config/agent-token-shortlist.json` with its full PoolKey (core 1676, venue `UniswapV4`, fee 29100, tickSpacing 582, hooks 0x0, pool id `0xf2e7b957...2391`). **The runner refuses this stage until the recorder holds a full 1800 s window of history** (`RECORDER_HISTORY`, exit 26): it warps the Twin chain and the dry-run chain, and polls on 8453. The live config check (`config-check-live-base`) resolves the PoolKey through StateView and fails while the pool's liquidity L (a raw uint128, not USDC) is below the floor of 1e6: nothing bypasses it, and no one funds the pool (owner decision 2026-10-09). `BasketVault.addAsset` then needs the recorder's ring at 901 slots and 1800 s of history. The Twin forks the live pool and never funds it. **Containment for the mainnet test (a test, not the final deployment):** 1 USDC seed, low `tvlCap` and `perDepositCap` sized below the pool depth (at the 2026-10-08 depth a single swap above about 18 USDC would fail the 5 percent slippage bound), nonzero NAV deviation guard, pause available, no announcement until the governance checks pass. |
| 10 `rwa` | rmRWA, paused, a plain basket row: deSPXA on its Uniswap V3 fee 500 pool, no oracle. |
| — `prove-control` | Before stage 11 the real Safe signs and executes one proof transaction: a call from the Safe to itself with value 0 and empty data. EVERY owner signs it, not only a threshold, so one run proves every key (plan decision 21, core #1618). The Safe tool checks each owner signature, and the Safe itself checks all of them, before it executes. The run manifest records the transaction hash and the signers. The first owner pays the gas, not the deployer. The proof goes straight through the Safe, never through the timelock, so the 8453 evidence check (unpause operations only) is unaffected. A signer missing for any owner stops the step with `CONTROL_NOT_PROVEN` (exit 24) before anything is sent. **If the run died after the proof landed** (the Safe is at nonce 1 and the run manifest has no `prove-control` record), rerun the same command with `--resume`: the tool reads the Safe's own `ExecutionSuccess`/`ExecutionFailure` events from the safe stage block, adopts the nonce-0 execution only when it is the exact self-call (value 0, empty data, a plain call to the Safe, chain and Safe bound by the Safe transaction hash) whose calldata signatures recover to exactly the current owners (every owner, no stranger, no repeat), records it with `adopted: true` and the on-chain hash, sends nothing, and goes on to stage 11. Anything else (a failed or reverted execution, another target, value or data, a missing owner, a nonce of 2 or more, two executions, no event) stops with `CONTROL_NOT_PROVEN` and the reason. Without `--resume` it never adopts. Log reads walk the range in 2000-block windows (Base RPC providers cap one `eth_getLogs` call), and a read that fails is a refusal, never an empty answer. |
| — config | Before stage 11 the deployer sets the deploy-time configuration: setters, router eligibility, voting power, and router default weights rmUSDC 9500, rmPROTO 500, rmAGENT 0, rmRWA 0 bps (not yet implemented: core #1520). |
| 11 `timelock` | Refuses with `CONTROL_NOT_PROVEN` (exit 24) unless the run manifest holds the `prove-control` record on the same Safe signed by every owner and the Safe nonce is 1 or more (stage 0 asserts nonce 0). TimelockController: proposer and canceller the Safe, executor open `address(0)` (implemented: core #1521; `DeployTimelock` grants `EXECUTOR_ROLE` to `address(0)` only, and the verifier checks it), delay from the sheet with a 172800 s floor on 8453. Every role on every vault, the gateway, registry, router, governance, IC policy and receipt goes to the timelock (vault EMERGENCY_ROLE to the emergency key), and the deployer is revoked. `AGENT_ADDRESSES=none`. |
| 12 `verify` | One verifier reads the chain and checks every postcondition, including the Safe owners and threshold, the proof transaction read back from the chain (a self-call of the Safe, signed by every owner, Safe nonce 1 or more), the delay floor, that the deployer holds no role, that the gateway has no `AgentAuthorized` or `AgentOwnershipTransferred` log up to the handover block and nobody holds `AGENT_ROLE` from an earlier grant (the deploy authorizes no agent), and the deployer nonce against the frozen per-stage counts for the release SHA (counts not yet committed: core #1524). |
| 13 `govern` | Only `unpauseDeposits()` on each basket vault (rmPROTO, rmAGENT, rmRWA). Each is its own timelock operation, scheduled the same day through the real Safe and executed after one 48-hour delay. None is skipped on any deploy. On 8453 the CLI exits `GOVERN_PENDING` with the resume command; on the Twin chain the wait runs by time warp (not yet implemented: core #1520; `govern.ts` still runs the older per-step matrix). |

**Run order: publish, verify, govern, verify (issue 1667).** The stage numbers are fixed (12 `verify`, 13 `govern`), the run order on 8453 is not
verify once. Verify runs twice, and each run checks a different state, which the CLI reads from the run manifest and confirms against the chain:

1. `publish` (stages 0 to 11).
2. `verify`: the **pre-govern** state. No unpause row is scheduled. rmPROTO, rmAGENT and rmRWA must read `depositsPaused` true and rmUSDC must read false.
3. `govern`: schedules the three basket unpauses through the real Safe in one sitting and exits `GOVERN_PENDING` (15). After the 48-hour delay the same
   command executes them.
4. `verify`: the **post-govern** state. All three unpause rows are executed and all four vaults must read `depositsPaused` false.

A manifest that says one state while the chain reads the other fails verify (exit 13), and a failed verify runs `pause-all` (§4.6). A verify run while
govern is **part-way** (some but not all basket unpause rows scheduled or executed, or an `unpause-USDC` round scheduled and not executed) is not a failed
verify: it exits 15 (`GOVERN_PENDING`), names the govern command that finishes the work, checks nothing and pauses nothing. Run that command, then verify.
The Twin chain rehearsal runs the same order (`twin-publish.ts`, `twin_publish.rs`). It only checks that the scripts execute in this order: the 48-hour
delay and the Safe signers are proven on 8453 through the real Safe.

**Basket sheet values (issue 1666).** Each basket (`PROTO`, `AGENT`, `RWA`, never `USDC`) carries two more
names in the frozen sheet, read by its stage as `NAV_DEVIATION_BPS` and `MIN_POOL_LIQUIDITY`:

| Sheet name | Rule |
| --- | --- |
| `VAULT_<KEY>_NAV_DEVIATION_BPS` | The ORA-4 deposit guard in basis points, from 1 to 2000. The vault default is 0, which disables the check, so 0 is refused. A value above 2000 is refused (the vault ceiling is 20 percent). The unit is basis points: 100 is 1 percent. The guard runs on deposit only, never on redeem. |
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
2. **Functional smoke test.** Execute one real deposit and one real
   withdrawal against the deployed vault (through the gateway, using a
   non-admin test account) and confirm share accounting matches
   `previewDeposit`/`previewRedeem`.
3. **Dapp integration.** Point a browser wallet at the deployment's RPC URL
   and chain id, connect, and confirm the dapp shows the correct vault
   balance, adapter allocations, and the deposit/withdrawal from step 2.
4. **Explorer/indexer.** If an explorer/indexer is part of the target
   environment (true for the Devnet's `--full-stack` mode), confirm the
   deposit and withdrawal events from step 2 are visible there — this is the
   check that the deployment is observable, not just functional.

The postflight gate is satisfied only when every check above passes and the
operator has signed off. Write the results into the stage rehearsal or
production rollout report (§4.5/§4.9).

### 4.5. Fix loop

If preflight, the cutover, or postflight finds any issue:

1. Open PRs with fixes against `dev`.
2. Merge the fixes to `dev`.
3. Restart the runbook from §4.1 at the new `dev` tip.

If verify (stage 12) or the postflight is what failed, the publish-contracts
CLI has already paused deposits on all four vaults (rmUSDC, rmPROTO, rmAGENT,
rmRWA) before you read the failure: `pause-all` (§4.6). Check the
`rollout-report-<chain>.json` it wrote before you start the fix. A vault that `pause-all` paused comes back through the Safe: `govern --row unpause-USDC`
for rmUSDC (never part of a default run, and refused while rmUSDC reads open) and `govern --row unpause-PROTO`, `unpause-AGENT` or `unpause-RWA` for a basket
that was already unpaused. Each opens a new numbered round (a new timelock operation id, a new 48-hour delay): the run exits `GOVERN_PENDING`, and the same
command executes it after the delay. A default `govern` run never reopens a vault that was paused again. Record each round under `govern` in the evidence
file with its `round` number (`unpause-USDC` is optional there, and every step may have rounds 1 to n).

**Never resume `govern` after a `pause-all` without cancelling first (issue 1686).**
If an unpause was already scheduled when `pause-all` ran (by hand, or the
automatic one after a failed verify), the timelock would still execute it after
its delay and reopen the vault you just paused. `pause-all` therefore records a
`pauses` entry (sequence number, timestamp, trigger, per-vault result) in
`publish-run.json`, and `govern` refuses before it sends anything when a pause
entry is newer than a pending unpause's schedule: `GOVERN` (exit 14), naming
the row, the pause entry and the operation id. The tool has no cancel on 8453,
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
all four vaults, because an emergency pause must not wait on bookkeeping. It
then exits `PAUSE` (25) and says the pause was not recorded: `govern` cannot
see it, so cancel every pending unpause through the Safe by hand. The rollout
report has `manifestRecorded: false` in that case.

There is no branch to cherry-pick onto and no rc-numbering cost — every
contract deployment is a fresh broadcast, so "try again" is simply "deploy
the fixed commit."

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
deposits on **all four** vaults: rmUSDC, rmPROTO, rmAGENT and rmRWA (rmUSDC
is not special; owner decision 2026-10-07, plan decision 22). It runs by
itself when stage 12 (verify) or the postflight fails, and the run still exits
with the verify failure's code (13). It picks the signer by stage (deployer
before the handover, EMERGENCY key after), reads `depositsPaused` back on
every vault and records each vault's paused state in
`rollout-report-<chain>.json` under the run's evidence directory. Withdrawals
stay open. Exit 25 means a vault is not confirmed paused. rmUSDC still deploys
open with its 1 USDC seed. Only the baskets deploy paused (`docs/prd.md`).
Rehearsed on every pull request that touches the deploy by the Twin test
`testing/smoke-test/tests/twin_pause_all.rs`.

The rollback/mitigation procedure must be written into the per-release
runbook and rehearsed on the Devnet at least once before a
mainnet deployment.

### 4.7. Production rollout report

After a deployment (successful or not), produce a report covering at least:

- the commit SHA and target network deployed,
- preflight and postflight results (and, when verify or the postflight
  failed, the `pause-all` result: each vault's `depositsPaused`),
- any issues encountered and their resolution,
- the final version tag applied (if any — see §3),
- operator sign-off.

The report is the closing artifact of the release. The release tracking
issue is closed only after this report is filed.

### 4.8. Post-launch consensus receipt release

Releasing a consensus receipt on 8453 is a standalone post-launch action (core 1611). It is never part of
stage 13, which stays the three basket unpauses (an `unpause-USDC` round after `pause-all` is likewise outside the default run). Run `govern --row release-receipt --receipt-id 0x<bytes32>`
with the usual chain, RPC, sheet, signer and `--owner-signer` arguments. The real Safe schedules `releaseReceipt` on
the timelock as its own operation and the CLI exits `GOVERN_PENDING` (exit 15) with the resume command. After the
48-hour delay the same command makes the Safe execute it, and the CLI reads `released` back. Record the operation
under `receipt_releases` in the evidence file. `update-delay`, `batch` and `cancel` stay Twin-only.

### 4.9. Post-launch receipt application (the Safe applies a rebalance)

The Safe multisig, through the timelock, is the only body that changes Robot Money contract configuration, router weights included. There is no vote. `govern --row apply-receipt --receipt-id 0x<bytes32> --payload FILE` applies one recorded consensus receipt as ONE timelock batch (issue 1696): `releaseReceipt(receiptId)` on the receipt contract and the router weight change for the receipt's vector (on today's bytecode `RouterGovernance.setDefaultWeights(vaults, bps)`, the ADMIN call the timelock holds). Release and weights are one operation, so partial state is impossible. After the real delay the same command makes the Safe execute the batch, and the tool reads `isReleased(receiptId)` and the router's default weights back and fails (`GOVERN`, exit 14) if either differs.

`--payload FILE` is the receipt payload whose `weights` list names a bucket and `weight_bps` per entry. The buckets map to the basket vaults (`conservative_defi_yield` rmUSDC, `protocol_tokens` rmPROTO, `agent_tokens` rmAGENT, `real_world_assets` rmRWA). A bucket at 0 bps whose vault is not router-eligible is dropped, every other entry stays in payload order.

Refusals. Each exits `USAGE` (exit 2) before anything is sent, so no delay is spent:

- the receipt is not recorded on the receipt contract, or is already released;
- `keccak256` of the payload file bytes differs from the digest the receipt stored on chain (a weights-only edit of a published receipt);
- the weights do not sum to 10000 bps;
- the vector does not list exactly the registry's router-eligible vaults (a missing vault, a vault that is not eligible and carries weight, an unknown or repeated bucket);
- the vault order differs from the registry order.

Never part of stage 13, which stays the three basket unpauses: no default run, stage run or numbered `--row` reaches it. On 8453 it runs only when named with `--row apply-receipt`, a receipt id and a payload, as a post-launch action with its own 172800 s delay: the first run schedules and exits `GOVERN_PENDING` (exit 15) with the resume command, the same command after the delay executes it. An operation the operator cancelled through the Safe is scheduled again by the same command, with a newer sequence number. Record the operation under `receipt_applications` in the evidence file (with `governance.address`): `evidence-check` accepts it only as one batch of exactly the release and the weight change, one delay apart. Whether the mainnet test deployment runs this row after the unpause round is an open owner decision, default: no.

The Twin rehearsal runs the row after the unpause rows (and checks `receipt_applications` of its run manifest with `evidence-check --receipt-applications`). The Twin proves execution only: that the row executes on the real contracts through the real Safe and timelock. It is not evidence that mainnet governance works (rule b).

## 5. Per-release runbook format

Each release has an operator runbook committed under `docs/runbooks/`. The
runbook must:

- state the release identity (`vA.B.C[-network]`) and the delta it
  introduces,
- list go/no-go gates that map directly to §4,
- provide a preflight script or checklist,
- provide step-by-step cutover commands, with destructive or irreversible
  steps explicitly marked,
- provide post-cutover manual QA steps (§4.4),
- be written so it can be executed top to bottom, every command
  copy-pasteable, every claim verified against a specific commit SHA rather
  than described from memory.

Filenames under `docs/runbooks/` are kebab-case, matching the frontend
repo's convention: `vA-B-C-<network>-<short-description>.md`.

## 6. Per-release GitHub tracking issue

Each release has one GitHub tracking issue. The tracking issue states the
release's **objective** — what should be true after deployment (which
contracts, on which network, with what role wiring) — not just a list of
merged PRs.

The issue carries two GitHub-checkbox checklists mirroring the runbook's
preflight and postflight gates. Checking a box is a claim that the
corresponding gate was actually executed and passed.

## 7. Backporting

Not applicable in the frontend's sense (§7 of that repo's policy) — there is
no release branch to backport from, since every deployment runs the same
`dev`-tip scripts (§2). A fix discovered during a deployment simply merges to
`dev` like any other change (§4.5).

## 8. Target networks

| Network | Chain id | Default per ADR-0013 | Notes |
| --- | --- | --- | --- |
| Robot Money Devnet | `918453` | **Yes — the default verification target.** | The Twin chain: a pinned lazy anvil fork of real Base at the upstream head minus 2 per CI run (`scripts/devnet/twin-fork.ts`, `docs/technical/full-stack-devnet.md`). Tests deploy their own vault (clean room). Full production-parity for all three yield adapters (Aave V3, Compound V3, Morpho). No lasting address record; a version tag against the Devnet documents a verification pass, not a persistent deployment. |
| Base mainnet | `8453` | The eventual real target — a separate, deliberately-costed decision (D9). | Requires an audit pass, Safe/hardware-wallet signers, and a funded submitter key. |
