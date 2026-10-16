# Contract release process — foundational runbook policy

> **Status: in effect.** This document defines the foundational
> release-runbook policy that every per-release contract-deployment runbook
> must follow. It is not itself a runnable checklist; concrete deployments
> are executed from per-release runbooks committed under `docs/runbooks/`
> (see §5). An example is [`docs/runbooks/v0.1.0-devnet-verification.md`](../runbooks/v0.1.0-devnet-verification.md).
>
> Modeled on the sibling frontend repo's `docs/technical/release-runbooks.md`
> policy, currently written for direct Solidity contract deployments rather than a
> mutable Postgres-backed application: there is no in-place upgrade of the
> existing direct contracts and no in-place rollback. The planned UUPS/freeze
> release path requires the mode and verification gates in
> [`docs/technical/contract-upgradeability-plan.md`](../technical/contract-upgradeability-plan.md)
> before it can be used. "The release branch" is the stage scripts under `contracts/script/` (listed in
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
  `DEPLOY_SHA` that is not an annotated-release-tagged SHA (`RELEASE_SHA_UNTAGGED`), whose tag object differs from, or is missing on, the checkout's `origin` or whose remote is unreachable (`RELEASE_TAG_REMOTE_MISMATCH`, exit 23; push the tag before planning), has no committed
  frozen counts (`COUNTS_MISSING`), whose counts file is untracked, staged, modified or ignored in its git work tree (`COUNTS_UNTRACKED`, exit 31) or is not green in `check-sha-green` (`CI_NOT_GREEN`).
  The same gate runs before any signer exists on every other broadcasting 8453 run (publish, prove-control, deploy, all, govern; issue 1816). `pause-all`, a dry run and a `verify`-only run are exempt. Hardware signing (`ledger`, `trezor`) is optional for a Safe owner signer: a software keystore stays valid on 8453, while plaintext keys and passphrase files are refused.
  Any later commit that changes `contracts/` has a new SHA with no tag and no
  counts, so it needs a new rehearsal and tag. This flow is enforced by the plan job (core #1524).
  - **Green rehearsal only.** The artifact uploads even when the rehearsal failed. The job therefore records its
    own conclusion in `counts.json` (`rehearsal.conclusion`), and `freeze-counts.ts` refuses any file whose
    conclusion is not `success` (core #1602). `core-stages-twin-chain` is deliberately not in
    `scripts/ci/required-checks.json`: it reads a public upstream that can rate limit, and a required entry would
    block every DEPLOY_SHA on a provider outage. It is gated indirectly: freezing needs a green run, and `check-sha-green` still gates the plan.
    `core-stages-twin-upgrade-lifecycle` reads the same upstream, yet it IS in the required list and gates every DEPLOY_SHA
    directly through `check-sha-green` (issue 1846). Every core stage deploys a governed proxy and the freeze is irreversible,
    so the Twin rehearsal of the upgrade and the freeze is never skipped. On an upstream outage, re-run the failed job:
    `check-sha-green` lists check-runs with `filter=latest`, so a successful re-run supersedes the failed attempt.
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
rehearsal of publish, verify and govern runs on every push to `dev` (not
yet implemented: core #1523).

The stage sequence. The stage table holds the forge stages 1 to 11; the CLI
adds `safe`, `prove-control` (between stages 10 and 11), `verify` and `govern`:

| Stage | What it does |
| --- | --- |
| 0 `safe` | Create a canonical SafeL2 1.4.1 through the canonical factory from the sheet's owners and threshold (threshold ≥ 2), then read it back. |
| 1 `libs` | Deploy TickMath through the CREATE2 factory (`0x4e59b44847b379578588920cA78FbF26c0B4956C`, salt 0), so its address is fixed by the build: on Base `0x3353854084194AE5Cc1697a9E4337806ECcdD9F6` (block 52401633). The basket stages link it. **If the library is already on chain** (every Twin fork pinned at or after that block; 8453 after a `--resume` where it landed) forge plans zero transactions and the CLI ADOPTS the stage instead of failing: it checks the address is the build's CREATE2 address and that keccak256 of the runtime code there equals the build artifact's, records `adopted: true` with the address and code hash on the `libs` record, and does not demand the frozen count of 1. Other code at the address, no code, an address the build does not predict, or a deployer nonce that moved by anything but 0 or the whole libs count stops with `LIBS_ADOPTION` (exit 27) or `NONCE`, nothing sent. **Resume after libs landed: rerun the same command with `--resume`. Never mark libs done by hand.** The deployer nonce then counts the transactions this deployer actually sent for libs (0 on a Twin fork, the frozen count when its own transaction landed): final nonce = frozen counts - libs count (when 0 was sent) + 1 prove-control. In the evidence file give the libs stage `adopted: { deployer_txs, libraries: [{ name, address, code_hash }] }` and `receipt_count` equal to `deployer_txs`; `evidence-check --rpc` re-reads the code hash. The libs stage deploys exactly ONE library, `tick_math`. BasketAssetConfigGuard (`0xB026a232f54d381A47a9E2640d04084830F0Ae58`), TwapTickMath (`0x7fDc1E387486C81F97A2379CE897b202d4E815E2`) and BasketViews (`0xE0a16a5B9a4EDd2E0723B74F593C1053F8cBe6BA`) are created by forge as the first transactions of the `proto` stage (`create2Libraries` in `stage-table.json`). Probed with forge and anvil: when they already exist the `proto` simulation exits 0 with `SIMULATION COMPLETE` and 7 transactions instead of 10 (no revert). The CLI then ADOPTS those libraries in the `proto` stage on the same rule as `libs` (address = CREATE2 of the build with BasketViews' link to TwapTickMath resolved, keccak256 of the runtime code equal), requires the shortfall to equal exactly the number adopted (else `COUNT_MISMATCH`), and records them with `deployerTxs` 7. The deployer nonce is then the frozen counts less the libs count less 3 plus the proof transaction. A `proto` that plans fewer transactions for any other reason still fails. **Details.** `agent` and `rwa` list the same three `create2Libraries` (`stage-table.json`, per stage); they normally find them made by `proto` earlier in the run (recorded in the stage's `created`) and adopt nothing. BasketViews links TwapTickMath: the CLI fills the link before it derives the CREATE2 address and hashes the code, and all three addresses depend on the TickMath address because the basket stages compile with `--libraries TickMath:<address>`. Each adopted stage records `adoption.deployerTxs`: exactly what the simulation planned, or on `--resume` between the frozen count less the adopted libraries and the frozen count; the later stages' nonce checks use it. **A run where libraries exist can CONSUME frozen counts but never PRODUCE them**: a measuring run that adopts writes a counts file marked `measured.adopted`; it is read back only by the follow-on verbs of the same Twin run (chain 918453 only), and `freeze-counts`, `loadFrozen`, the release gate and `counts-drift` refuse it. The Twin CI job `core-stages-twin-chain` runs the `twin-publish` action with `predeploy-libs: true`: `src/ci/predeploy-libs.ts` builds the four libraries as the stages do and deploys any that are missing through the real factory on the fork; it refuses Base mainnet and any node that is not an anvil fork. The offline `evidence-check` caps an adopted stage's library list by the stage table and refuses a repeat. A run where TickMath already exists can consume frozen counts (frozen `libs: 1` against 0 deployer transactions works) but can never produce a libs count: its raw counts file is marked `measured.adopted` and every freeze path refuses it. `evidence-check --rpc` compares the chain code hash with the hash recorded in the evidence itself, so only the runner should author that entry. A Twin rehearsal that adopted libs is never frozen as a measurement (`freeze-counts --counts` refuses it): rebuild its baseline with `freeze-counts --from-adopted-run` (section 3, issue 1733), or freeze from a fork pinned before block 52401633. |
| 1b `recorder` | Deploy `UniswapV4PriceRecorder` for the RM pool key in `config/agent-token-shortlist.json`, grow its ring to 901 slots in chunks of 250 and record the first snapshot. No role is involved: anyone could send every one of these transactions, and the deployer holds nothing on it afterwards. It runs right after `libs` so the 30 minute price history accumulates while the other stages run. It keeps the stage numbers around it (it is stage 1b, not a renumbering). The manifest `recorder.json` names the recorder. |
| 2 `vault` | rmUSDC and its lending adapters. Seed 1 USDC to `SEED_SHARE_RECEIVER`; the deployer holds no shares. |
| 3 `registry` | Register rmUSDC. |
| 4 `router` | Portfolio Router, `registry.setRouter`. |
| 5 `gateway` | Gateway with the router as an immutable. No agent is authorized: `DeployGateway` reads no `AGENT_*` input and the sheet refuses them. Depositors authorize their own agents through `commitAuthorization` and `revealAuthorization`. |
| 6 `governance` | RouterGovernance from the sheet. |
| 7 `ic-policy` | IC policy and consensus receipt, bound to the gateway. |
| 8 `proto` | rmPROTO, paused, wETH and cbBTC, registered. |
| 9 `agent` | rmAGENT, paused, RM (`0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3`) on the Uniswap V4 RM/USDC 2.91% pool (owner, 2026-10-08; supersedes the 2026-10-06 V3 decision), registered with venue V4, the price recorder from stage 1b as its pool and `UniswapV4SwapAdapter` as its adapter (the script allowlists the adapter codehash and applies `maxSlippageBps` 500 from the config, because the pool fee alone is 291 bps). RM is in `config/agent-token-shortlist.json` with its full PoolKey (core 1676, venue `UniswapV4`, fee 29100, tickSpacing 582, hooks 0x0, pool id `0xf2e7b957...2391`). **The runner refuses this stage until the recorder holds a full 1800 s window of history** (`RECORDER_HISTORY`, exit 26): it warps the Twin chain and the dry-run chain, and polls on 8453. The live config check (`config-check-live-base`) resolves the PoolKey through StateView and fails while the pool's liquidity L (a raw uint128, not USDC) is below the floor of 1e6: nothing bypasses it, and no one funds the pool (owner decision 2026-10-09). `BasketVault.addAsset` then needs the recorder's ring at 901 slots and 1800 s of history. The Twin forks the live pool and never funds it. **Containment for the mainnet test (a test, not the final deployment):** 1 USDC seed, low `tvlCap` and `perDepositCap` set in the 8453 frozen sheet (check them before the run) and sized below the pool depth (at the 2026-10-08 depth a single swap above about 18 USDC would fail the 5 percent slippage bound), nonzero NAV deviation guard, pause available, no announcement until the governance checks pass. |
| 10 `rwa` | rmRWA, paused, a plain basket row: deSPXA on its Uniswap V3 fee 500 pool, no oracle. |
| — `prove-control` | Before stage 11 the real Safe signs and executes one proof transaction: a call from the Safe to itself with value 0 and empty data. EVERY owner signs it, not only a threshold, so one run proves every key (plan decision 21, core #1618). The Safe tool checks each owner signature, and the Safe itself checks all of them, before it executes. The run manifest records the transaction hash and the signers. The deployer submits the transaction and pays its gas (the only funded key; the owners only sign), so the deployer nonce at and after stage 11 is the summed frozen counts plus one, and `--resume` adoption accepts a landed proof whoever sent it. The proof goes straight through the Safe, never through the timelock, so the 8453 evidence check (unpause operations only) is unaffected. A signer missing for any owner stops the step with `CONTROL_NOT_PROVEN` (exit 24) before anything is sent. Owners on several hardware wallets of one type are named one per `--owner-signer ledger:PATH@0xOWNER` (or `trezor:`): the tool asks for each device in turn, refuses with `HARDWARE_ADDRESS_MISMATCH` when the attached device is not the named owner, refuses two specs that resolve to one address, and asks for the device again and re-checks it before each signature. **If the run died after the proof landed** (the Safe is at nonce 1 and the run manifest has no `prove-control` record), rerun the same command with `--resume`: the tool reads the Safe's own `ExecutionSuccess`/`ExecutionFailure` events from the safe stage block, adopts the nonce-0 execution only when it is the exact self-call (value 0, empty data, a plain call to the Safe, chain and Safe bound by the Safe transaction hash) whose calldata signatures recover to exactly the current owners (every owner, no stranger, no repeat), records it with `adopted: true` and the on-chain hash, sends nothing, and goes on to stage 11. Anything else (a failed or reverted execution, another target, value or data, a missing owner, a nonce of 2 or more, two executions, no event) stops with `CONTROL_NOT_PROVEN` and the reason. Without `--resume` it never adopts. Log reads walk the range in 2000-block windows (Base RPC providers cap one `eth_getLogs` call) from the safe stage block and stop at the first window that holds an event. A throttled call (HTTP 429) is retried with a bounded backoff (`--logs-tries`, default 6), a range-limit error halves the window (`--logs-window` sets the start), and `--logs-rpc URL` sends `eth_getLogs` alone to another RPC (the rest stays on `--rpc`). Any other failure is `RPC_REFUSED` (exit 30) naming the RPC host, the method and the block range or transaction, never an empty answer or "not found" (issue 1724). |
| — config | Before stage 11 the deployer sets the deploy-time configuration: setters, router eligibility, and router default weights rmUSDC 9500, rmPROTO 500, rmAGENT 0, rmRWA 0 bps. RouterGovernance has no voting (core 1698). |
| 11 `timelock` | Refuses with `CONTROL_NOT_PROVEN` (exit 24) unless the run manifest holds the `prove-control` record on the same Safe signed by every owner and the Safe nonce is 1 or more (stage 0 asserts nonce 0). TimelockController: proposer and canceller the Safe, executor open `address(0)` (implemented: core #1521; `DeployTimelock` grants `EXECUTOR_ROLE` to `address(0)` only, and the verifier checks it), delay from the sheet with a 172800 s floor on 8453. Every role on every vault, the gateway, registry, router, governance, IC policy and receipt goes to the timelock (vault EMERGENCY_ROLE to the emergency key), and the deployer is revoked. `AGENT_ADDRESSES=none`. |
| 12 `verify` | One verifier reads the chain and checks every postcondition, including the Safe owners and threshold, the proof transaction read back from the chain (a self-call of the Safe, signed by every owner, Safe nonce 1 or more), the delay floor, that the deployer holds no role, that the gateway has no `AgentAuthorized` or `AgentOwnershipTransferred` log up to the handover block and nobody holds `AGENT_ROLE` from an earlier grant (the deploy authorizes no agent), and the deployer nonce against the frozen per-stage counts for the release SHA (counts not yet committed: core #1524). |
| 13 `govern` | Only `unpauseDeposits()` on each of the four vaults (rmUSDC, rmPROTO, rmAGENT, rmRWA), all deployed paused. Each is its own timelock operation, scheduled the same day through the real Safe and executed after one 48-hour delay. None is skipped on any deploy. On 8453 the CLI exits `GOVERN_PENDING` with the resume command; on the Twin chain the wait runs by time warp. The rows come from the stage table's vault rules (`unpauseRow`, `unpauseInStage13`, issue 1705). |

**Run order: publish, verify, govern, verify (issue 1667).** The stage numbers are fixed (12 `verify`, 13 `govern`), the run order on 8453 is not
verify once. Verify runs twice, and each run checks a different state, which the CLI reads from the run manifest and confirms against the chain:

1. `publish` (stages 0 to 11).
2. `verify`: the **pre-govern** state. No unpause row is scheduled. All four vaults (rmUSDC, rmPROTO, rmAGENT and rmRWA) must read `depositsPaused` true: every vault deploys paused, rmUSDC right after its seed deposit.
3. `govern`: schedules the four unpauses (rmUSDC, rmPROTO, rmAGENT, rmRWA) through the real Safe in one sitting and exits `GOVERN_PENDING` (15). After the 48-hour delay the same
   command executes them.
4. `verify`: the **post-govern** state. All four unpause rows are executed and all four vaults must read `depositsPaused` false.

A manifest that says one state while the chain reads the other fails verify (exit 13), and a failed verify runs `pause-all` (§4.6). A verify run while
govern is **part-way** (some but not all of the four unpause rows scheduled or executed) is not a failed
verify: it exits 15 (`GOVERN_PENDING`), names the govern command that finishes the work, checks nothing and pauses nothing. Run that command, then verify.
The Twin chain rehearsal runs the same order (`twin-publish.ts`, `twin_publish.rs`). It only checks that the scripts execute in this order: the 48-hour
delay and the Safe signers are proven on 8453 through the real Safe.

**Mainnet test run-day steps (issue 1695).** The run checks core out at the release tag commit (`9a768bb9`, `release/v0.4.0-base`) and passes `--counts-dir` pointing at a dev checkout (`0d40e671` or later) `deployments/frozen-counts`.

**Release layout of a reconstructed baseline (issue 1740).** The baseline file is named by the release sha X (`deployments/frozen-counts/<X>.json`), so it can never be inside the checkout at X: it holds X, and X is the hash of the tree that would hold it. Putting it untracked in the checkout at X makes the tree dirty and the run refuses (`USAGE`, "uncommitted changes"). The steps:
1. Tag X (`release/<version>`, annotated, pushed). Run the Twin rehearsal at X and rebuild the baseline with `freeze-counts.ts --from-adopted-run` in a dev checkout (any commit at or after X).
2. Merge the file as a data-only change (`deployments/frozen-counts/<X>.json` only) after the tag. Call the merged commit Y. `git pull` the dev checkout to Y or later. It must be clean.
3. Check core out at X for the code (`--core-dir`, clean, HEAD equals the tag target). Keep the dev checkout at Y or later for the counts (`--counts-dir <dev>/deployments/frozen-counts`). They are two checkouts of the same repository.
4. The plan and every deploy stage on 8453 refuse (`COUNTS_MISSING`, before any signer) unless, in the COUNTS checkout: it is a git work tree; its HEAD is X or a descendant of X (a shallow clone without X, an older commit or another repository is refused); every `<sha>.json` in the dir (the baseline, every anchor) is tracked at HEAD with identical bytes; every `<sha>.json` tracked at HEAD is in the dir; and nothing under the dir is modified or untracked. The anchor proof (`git show HEAD:<anchor>`) also runs in the counts checkout. Nothing is read from the core checkout but its HEAD. Every git child runs with every `GIT_*` variable removed, no system or global config, replace refs off (`--no-replace-objects`) and the fsmonitor hook off, so the environment cannot redirect the checks and a `refs/replace` ref cannot fake ancestry. Ignored files in the dir are refused too. A counts checkout owned by another user is refused by git (safe.directory) and the message says so. With no `--counts-dir` the default dir is the core checkout's own and cannot satisfy this; the refusal says to pass `--counts-dir`.
5. **The counts checkout MUST be a reviewed, merged commit reachable from origin/dev.** The code checks history and bytes, not review: a clone with a local descendant Y' that adds a forged X.json is accepted by the checks of step 4 alone. So in the counts checkout run `git fetch origin dev`, check out the merged commit Y (or later), and pass `--counts-require-origin-dev` on every 8453 plan and deploy run. The flag (off by default in code, REQUIRED here) refuses unless HEAD of the counts checkout is an ancestor of, or equal to, its local `origin/dev` ref. It reads only that local ref, so the fetch is the operator's step. That ref is LOCAL: anyone with write access to the operator's clone can forge it, so the flag proves only that the operator fetched and that the counts HEAD is on or behind their local origin/dev, NOT provenance or review. The review of the data-only PR is the control.
Tested with real git repositories in `publish-contracts/tests/counts-layouts.test.ts`.

1. **Make the keys.** Run `bun run rehearsal keys --dir <backed-up folder> --chain-id 8453` and type the passphrase at the hidden prompt. Never pass `--password-file` for the mainnet test, and never put the passphrase in an argument or the environment. The helper makes no voter keys: there is no voting (issue 1698). `--chain-id 8453` puts `CHAIN_ID=8453` in the printed sheet fragment. Back the folder up before any funds move.
   **Unlocking later steps:** `rehearsal run` still requires `--password-file`. The owner creates their own 0600 file on tmpfs (for example under `/dev/shm`) holding the passphrase, uses it, and runs `shred -u` on it straight after. Never put it in the backed-up folder or its parent.
2. **The seed receiver is Safe owner A's address** (`SAFE_OWNER_A` in the printed fragment). The tool makes no separate seed key.
3. **Passphrase file on older code.** From this change on, the hidden-prompt path keeps the passphrase in memory and writes no file. Keys made from the `release/v0.4.0-base` tag (older code) also wrote the passphrase to a plaintext 0600 file `<dir>.pw` beside the folder. When keys were made that way, run `shred -u <dir>.pw` after use and never back that file up. The file sits BESIDE the keys folder, so a backup of the parent directory includes it. Check every backup for it first, and shred it before backing up the parent.
4. **Funding.** Only the deployer is funded. It submits every transaction, including the Safe owners' signature bundles (prove-control and govern). The pauser and the emergency key are funded only when an agent asks to exercise a pause. `pause-all` with an unfunded key stops and names the key to fund.
5. **Recorder poker (named role).** `UniswapV4PriceRecorder.record()` has no keeper. The run names one accountable poker before it starts, who calls `record()` well inside the 1800 s staleness limit (for example every 10 minutes), because a revert happens just past 1800 s. After 1800 s without a `record()`, every rmAGENT deposit and USDC redeem reverts `StaleRecorder` until someone pokes. `redeemInKind` stays available while the recorder is stale. The first poke after a long gap weights the old tick over the whole gap, so the recorded average lags the live price until the window refills. The automated keeper in "Recorder keeper (issue 1779)" below replaces the manual poke. Until it runs, the named poker does it by hand.
6. **Run the verifier before unpausing.** `RECORDER_ADDRESS` comes from the environment and the deploy script only checks its getters, so only the verifier binds the recorder codehash. Run `verify` (pre-govern) and require it green before `govern` schedules any unpause. The verifier also reads `maxSlippageBps` back from the rmAGENT vault (label `vault[rmAGENT]: maxSlippageBps equals 500`) and fails on any other value.
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

- **Cadence is measured (issue 1793).** `contracts/test/V4RecorderSamplingEconomicsFork.t.sol` shows that at 240 s the best recorder sample leaves a NAV mark error of about 60 bps, inside the 100 bps guard, and costs the attacker more than 3 USDC for no gain. The error grows linearly with the interval (about 100 bps at 360 s), so keep `INTERVAL_SECS` at or below 240. See `docs/code-review/20261014-code-review-internal-claude-v4-sampling-economics.md`.
- **Why a loop and not one call.** One `record()` moves the recorded tick by at most 600 ticks (about 6.2 percent), and only when 60 s or more passed since the last one. After a gap the NAV deviation guard (1 percent) refuses deposits until the 1800 s NAV TWAP catches the live tick. The keeper repeats `record()` every 60 s until the gap is at most 90 ticks (about 0.9 percent), at most 30 extra calls. The full TWAP window must refill; two clamped observations alone do not restore the guard.
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
- **Check before relying on it.** `bash scripts/ops/test-recorder-keeper.sh` (needs anvil, forge and cast) checks the component alert paths. `BASE_FORK_RPC_URL=<Base RPC> bash scripts/ops/test-recorder-keeper-fork.sh` runs the keeper on an isolated Base fork against Deploy 2 rmAGENT and its recorder. It seeds a historical recorded tick 1500 ticks behind the real pool, advances two days, requires repeated catch-up calls, asserts the actual vault NAV deviation is inside its enabled guard, and deposits 1 USDC with positive credited shares. The upstream is read only; transactions and seeded recorder state stay on the local fork. CI executes both in `recorder-keeper-selftest`, fails if resources or deployed contracts are unavailable, and prints the fork pin and assertion evidence. Set `BASE_FORK_BLOCK` to reproduce a specific pin. Catch-up compares the full NAV TWAP rather than only the latest clamped observation; `TWAP_WINDOW_SECS` defaults to 1800 and must match the vault window.

**Run-day: look at the deployed contracts in the dapp, read-only (issue 1725).** After the deploy, copy the manifests directory to a scratch folder and run on the operator machine only, with no key, passphrase or keystore variable in the environment:

```
bun scripts/stage/core-stack.ts dapp up --chain 8453 --rpc <base rpc> --manifests <copy of manifests> --start-block <first block of the run>
```

The first block of the mainnet test run is 52401633. Open `http://127.0.0.1:15173` (dapp) and `http://127.0.0.1:18547/health` (explorer API). The stack sends no transaction and has no faucet. Stop it with `dapp down --chain 8453`. Public exposure through the existing cloudflared tunnel on the stage host is approved by the owner (decision 2026-10-10): this tool never touches tunnel, DNS or proxy configuration, and the ports stay on 127.0.0.1. Once the vaults open on 2026-10-12 anyone reaching the public dapp can deposit REAL USDC. The dapp shows the red "Base mainnet — real funds" banner and the wrong-chain screen (issue 1729): run the public dapp checks below before the tunnel points at it. See `docs/development/stage-deployment.md`.

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
for rmUSDC and `govern --row unpause-PROTO`, `unpause-AGENT` or `unpause-RWA` for a basket
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
report has `manifestRecorded: false` in that case. When a vault is also left
open, the one error names the open vault and still says to cancel every pending
unpause (issue 1701). Exit 25 therefore means either cause: `details.unpaused`
lists open vaults, `details.manifest_recorded: false` marks an unrecorded pause.

An apply-receipt batch scheduled before a pause-all can still execute after it (issue 1701): govern's pause check (`refuseIfPausedSince` in `src/govern.ts`) ignores every row that is not an unpause or a redeploy round, so it refuses no `apply-receipt` (nor `clear-voted-weights`, `release-receipt` or a Twin-only row) scheduled before a recorded pause-all. If its weights must not land after the pause, cancel that operation through the Safe on the timelock by hand.

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
stay open. Exit 25 means a vault is not confirmed paused. Run the CLI from a
checkout of `DEPLOY_SHA`. A CLI from another sha still pauses, with one
`vault_rules.mismatch` warning naming both stage tables (`pause-all` reads no
per-vault rule); every other verb refuses the mismatch (issue 1851). A verify
whose only failures are RPC-refused receipt reads exits 30 (`RPC_REFUSED`) and
pauses nothing: rerun it against an RPC that serves the deploy receipts. **Initial deposit state, one rule for all four vaults** (`scripts/deploy/stage-table.json` `vaults[].deployPaused` and `unpauseInStage13`, issue 1705): all four vaults deploy paused, and stage 13 unpauses all four through the Safe and the timelock. rmUSDC
pauses right after its 1 USDC seed deposit.
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

Never part of stage 13, which stays the four vault unpauses: no default run, stage run or numbered `--row` reaches it. On 8453 it runs only when named with `--row apply-receipt`, a receipt id and a payload, as a post-launch action with its own 172800 s delay: the first run schedules and exits `GOVERN_PENDING` (exit 15) with the resume command, the same command after the delay executes it. An operation the operator cancelled through the Safe is scheduled again by the same command, with a newer sequence number. Record the operation under `receipt_applications` in the evidence file (with `governance.address`): `evidence-check` accepts it only as one `applyReceipt` call whose target is the governance contract, with the `payload_digest` and `voted_weights_active` true. On 8453 verify does not trust the run manifest's `receipt_applications` (issue 1701): every entry must be backed by its timelock batch on chain (the same check as `evidence-check --receipt-applications --rpc`: the schedule and execute transactions, the one `applyReceipt` calldata of the recorded vector, the delay), or verify fails (exit 13), so a forged entry cannot hide router weight drift. `evidence-check --delay-floor` is refused (exit 2) below the 8453 floor of the deployment kind (172800 s for production) when `--rpc` reads chain 8453. See 4.6 for the pause-all ordering gap of this row. Whether the mainnet test deployment runs this row after the unpause round is an open owner decision, default: no.

**Clearing a voted vector (`govern --row clear-voted-weights`, issue 1743).** The first Base mainnet deployment (router stage `setWeights` at `DeployPortfolioRouter.s.sol`) left `votedWeightsActive()` true with the voted vector 100% rmUSDC on top of the 9500/500/0/0 default, so the launch weights never took effect. The deploy no longer calls `setWeights` (the router stage sets the default `[rmUSDC]/[10000]` with `setDefaultWeights`, the basket stages' `migrateEligibility` re-set it to the sheet's `ROUTER_WEIGHTS`), and the verifier fails a router that still carries a voted vector (`router: votedWeightsActive is false after deploy`, `router: effective weights equal the sheet's launch vector`). A deployment that already carries one needs one Safe -> Timelock round: `govern --row clear-voted-weights` (no other argument) schedules ONE call, `RouterGovernance.clearVotedWeights()` (`ADMIN_ROLE`, the timelock), which forwards to `PortfolioRouter.clearVotedWeights()` (`ADMIN_ROLE`, RouterGovernance). A `WEIGHT_SETTER_ROLE` holder without `ADMIN_ROLE` cannot call it. No contract change. The first run exits `GOVERN_PENDING` (15) with the resume command, the same command after the timelock delay executes it and reads `votedWeightsActive()` false and `getEffectiveWeights()` equal to `getDefaultWeights()` back. It is refused (`GOVERN`, nothing scheduled) when no voted vector is active. Allowed in production and in a rehearsal, never part of stage 13. Record the round under `voted_weights_clears` in the evidence file (with `governance.address`). NEVER run clear-voted-weights on the LIVE 8453 router (it predates the zero-leg fix: clearing makes every router deposit revert UsdcLegTransferFailed(rmAGENT) once the vaults are unpaused, because rmAGENT.deposit(0) reverts). Router deposits over the 9500/500/0/0 launch vector need a router built with issue 1746 (`PortfolioRouter` skips legs whose computed amount is 0). A new router deployment (such as the rehearsal at a new SHA) carries the fix.

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
| release tag | annotated `release/<version>` (no `rehearsal` in the name) | annotated `release/<version>-rehearsal`. A mismatch fails `RELEASE_TAG_KIND` (exit 28) before any signer exists |

**What records the kind.** The run manifest (`deploymentKind`), the evidence (`deployment_kind`), the verifier label detail and the `verify.deployment_kind` log event (`[rehearsal 900s]`), the isomorphism notes, `timelock.json` (`deployment_kind`), the tag name, and the timelock `minDelay` itself on chain (900).

**Per row, on 8453 in a rehearsal:**

| Row | Rehearsal on 8453 | Why |
| --- | --- | --- |
| `unpause-USDC`, `-PROTO`, `-AGENT`, `-RWA` | yes, stage 13, run first | the launch path, unchanged |
| `register-committee --submitter ADDR` | yes, rehearsal and Twin only, on demand | the ADMIN_ROLE action that lets a submitter anchor receipts: one batch of `gateway.authorizeAgent` (AGENT_ROLE, the smallest legal policy: deposits capped at 1 raw unit per payment and window, withdrawals disabled (zero withdraw caps), owned by the timelock, 90 days) and `gateway.committeeRegister` (COMMITTEE_AGENT_ROLE on the IC policy). Refused on 8453 in production: adding it to the production surface is a separate owner decision |
| `release-receipt` | no, refused with USAGE (issue 1831) | a release alone burns the receipt; use `apply-receipt` |
| `apply-receipt` | yes, as in production | one `RouterGovernance.applyReceipt` call releases the receipt and sets the router's active weights; read back |
| `clear-voted-weights` | yes, as in production, on demand | clears a voted router weight vector so the default is what routes; read back (issue 1743) |
| `update-delay` | yes, explicit `--row`, after the four unpauses | exercises the Safe tool timelock path on real contracts; the new delay stays 900 to 172799 and the verifier follows the executed delay |
| `batch` | yes, explicit `--row`, after `update-delay` | a no-op `scheduleBatch` (updateDelay to the current value, rmUSDC cap to its current value): no state change |
| `cancel` | yes, explicit `--row`, after `batch` | schedules a no-op and cancels it: no state change |
| generic `--call-*` | no | a test verb, refused on 8453 in every kind |

Stage 13 on 8453 stays the four unpauses in every kind. In production `update-delay`, `batch` and `cancel` are refused with `USAGE` exactly as before. Rehearsal evidence for them goes in `rehearsal_rows`, which a production evidence may not carry.

**The receipt path (no fixture).** After the four unpauses:

1. Create the SUBMITTER SAFE once (a second SafeL2 1.4.1 multisig, see below), then register it through the governing Safe and the timelock: `govern --row register-committee --submitter 0x<submitter Safe> --agent-label NAME`. The row refuses a key (no code) on 8453, a contract that is not a canonical SafeL2 1.4.1 proxy with threshold 2 or more, no module, no guard and the canonical fallback handler, and the governing Safe, the timelock, admin (= the deployer), the pauser and the emergency address. It schedules, exits `GOVERN_PENDING` (15) with the resume command, and the same command after the 900 s delay executes and reads `AGENT_ROLE`, `COMMITTEE_AGENT_ROLE`, the label and the agent owner back. Evidence: `committee_registrations`.
2. A submitter anchors a REAL receipt through the gateway: first `rmpc receipt verify` (read-only, no signer) checks every analyst signature off chain and prints `receipt_id` and `payload_digest`; then `publish-contracts record-receipt --payload FILE --submitter 0x<submitter Safe> --signer <deployer signer> --owner-signer <owner 1> --owner-signer <owner 2> --receipt-id ID --payload-digest DIGEST --payload-uri URL` (FILE is the receipt as served by the canonical route; `--payload` is optional but recommended: the verb recomputes the digest and the id from the bytes and refuses a mismatch before any signer exists) proposes, through the submitter Safe, a call to `RobotMoneyGateway.consensusRecordReceipt(receiptId, payloadDigest, payloadUri)`, collects the signatures of `threshold` of the submitter Safe's owners and executes it with the DEPLOYER as the gas payer (`--signer`). It refuses when fewer owner signers than the threshold are given, when the Safe that executed is not `--submitter`, and when the Safe emitted no `ExecutionSuccess` for the Safe transaction hash; it reads the receipt back and requires the stored submitter to be the Safe. On 8453 there is no single-key mode: `record-receipt` without `--submitter` is refused before any signer exists. `rmpc receipt submit` refuses a software signer on 8453 (`ErrProductionSignerRequired`: only HSM or KMS count and none is implemented), so a rehearsal records through this verb; production keeps rmpc with an HSM or KMS. The verb checks the roles, the gateway routing and that the id is not recorded with other data before it sends, reads the receipt back, and writes `recorded_receipts` (id, digest, uri, submitter ADDRESS, transaction; never a key).
3. The Safe applies it: `govern --row apply-receipt --receipt-id ID --payload FILE`, where FILE is the receipt bytes as served by the canonical route, whose RECEIPT DIGEST is the recorded digest. The receipt digest is `keccak256("robotmoney:consensus-receipt:v1\n" || FILE)`, not a plain `keccak256` of FILE (issue 1754; the single definition is `publish-contracts/src/receipt-digest.ts`; the oracle is the real receipt of session 5015526d-27f6-478a-86e9-ac768e310af1, digest `0x2aebf2b33c117d41813ef338ccf1d44b8006cc8a54eb162b17cbb8ac18adbacb`). The payload may list the buckets in any order: the tool arranges the vector in registry order. `isReleased` and the router weights (default and effective) are read back. If `votedWeightsActive()` is true the row refuses: run `govern --row clear-voted-weights` first.
4. `verify` again, then `evidence-check --receipt-applications <publish-run.json> --deployment-kind rehearsal ...` traces the application to a recorded receipt with the same digest by a registered submitter.

**What the submitter can do.** It anchors receipts and can post allocation-signalling votes (`committeeVoteSubmit`, once it holds COMMITTEE_AGENT_ROLE). Withdrawals are disabled (the policy's withdraw caps are 0, so withdraw reverts WithdrawalNotEnabled); deposits are capped at 1 raw unit of USDC per payment and per window, paid from the submitter's own funds, with the shares going to the timelock. There is no value path from the timelock or the Safe to it, and it cannot move weights or release a receipt.

**Roles in the 900 s rehearsal (acceptance criterion 5).** The OLD governance Safe `0x5E68a40648DD23065b21b1C414e1178ddE6482ca` (the first rehearsal's governing Safe, 2 of 3, proxy code hash and singleton checked read-only on 8453) is the **PROPOSER**: it is the submitter Safe that records receipts (`record-receipt --submitter 0x5E68a40648DD23065b21b1C414e1178ddE6482ca`). The NEW governing Safe, created by this rehearsal with `SAFE_SALT_NONCE` 2026101002, is the **APPROVER**: it registers the proposer through the timelock and applies the receipt (`govern --row apply-receipt`). The old Safe holds no role on the new deployment until `register-committee` gives it AGENT_ROLE and COMMITTEE_AGENT_ROLE. **Caveat: the same three owner keys (A, B, C) control BOTH Safes**, so proposer and approver are separated by the multisig and by each Safe's own nonce, not by key. **Preflight:** the three owner EOAs A, B and C must differ from the 900 s sheet's ADMIN_ADDRESS, PAUSER_ADDRESS and EMERGENCY_ADDRESS (the sheet already enforces it for the new Safe; the submitter check enforces it for the old one) or registration is refused with an error naming which owner collided.

**Who is the submitter. OWNER DECISION 2026-10-10 (it closes the earlier OWNER QUESTION about which key): a multisig, no single key.** The submitter is a SECOND Safe, a SafeL2 1.4.1 proxy separate from the governing Safe. It holds AGENT_ROLE on the gateway and COMMITTEE_AGENT_ROLE on the IC policy and nothing else. The contracts accept a contract account as the role holder (no `msg.sender`, `tx.origin`, `isContract` or `ecrecover` check applies to it), so no contract change is needed: the rule lives in the tooling (`publish-contracts/src/submitter-safe.ts`) and is proven by the forge test `ConsensusReceiptSafeSubmitter.t.sol` with a real Safe. Create it once, before `register-committee`, with the Safe tool: `bun src/safe/cli.ts create --owners A,B,C --threshold 2 --signer <deployer signer> --salt-nonce <a number different from the governing Safe's SAFE_SALT_NONCE>` (the same factory and singleton, a different salt, so a different address). **The same three owner keys control BOTH Safes.** The separation between proposing and approving a receipt is therefore the multisig (two of three owner signatures) and the two Safes' own nonces, not different keys: a submitter Safe signature cannot execute on the governing Safe and the reverse, because the Safe transaction hash binds the Safe address and chain. The deployer only pays gas. The submitter Safe keeps the 1-raw-unit deposit cap and the disabled withdrawals of the policy, which hold for any holder. No key, passphrase or keystore path reaches the repo, the sheet or the evidence. The evidence entries carry `submitter_safe` (threshold, owners, proxy code hash, and for a record the Safe transaction hash, nonce and the owners that signed); `evidence-check` refuses a recorded receipt without it on 8453, a submitter that is a role key, the governing Safe or the timelock, and (with `--rpc`) a record whose Safe emitted no `ExecutionSuccess` for the recorded hash.

**Deployer nonce (not fresh).** The first rehearsal's deployer was last observed at about nonce 118 and moves on; the number is not fixed and nothing depends on it. In rehearsal mode the run manifest records `deployerStartNonce` at the FIRST deployer stage, before the first transaction. Every later stage must start at the recorded start plus the stages' counts before it (plus the prove-control transaction after it); a stray deployer transaction before, between or after stages is refused; the end nonce is start plus the summed counts plus the proof; the verifier and `evidence-check` (`deployer_start_nonce`) count from the same start. The recorded start is read from the manifest on resume, cross-checked against the first stage's own record and, before any stage has started, against the chain: it is never rewritten. The frozen per-stage counts are deltas and do not change. Production stays absolute from nonce 0.

**New Safe.** The same owners, threshold and `SAFE_SALT_NONCE` predict the first rehearsal's Safe. A rehearsal sheet therefore REQUIRES an explicit `SAFE_SALT_NONCE`, and the Safe stage refuses a predicted address that already holds code with `SAFE_SALT_NONCE_REUSED` (exit 19) before anything is sent. Only a `--resume` of the same run, whose manifest recorded that address, adopts an existing Safe.

**Libraries.** All four CREATE2 libraries already sit on 8453 from the first rehearsal: tick_math is deployed by the libs stage, and TwapTickMath, BasketViews and BasketAssetConfigGuard by the PROTO stage. A second deployment therefore finds them all: the libs stage is adopted (0 deployer transactions) and the PROTO stage adopts three creations (7 transactions instead of 10), as built by issue 1721 (`effectiveCounts`, the adopted records in the run manifest, the stage table's `create2Libraries`). The relative start nonce composes with it: **expected nonce = start + sum(effectiveCounts) + proof**, at every site (the runner's stage start and end-of-deploy check, `checkNonce` and `finalDeployerNonce`, the verifier, `evidence-check` offline and with `--rpc`, `rehearsal-counts.ts`). The start is recorded at the first stage (safe), before libs is adopted. With all four libraries present the final nonce is start + (sum - libs count - 3) + 1. The evidence carries `deployer_start_nonce` and each adopted stage's `deployer_txs`, bounded by the table. A run that adopts any stage consumes frozen counts but can never produce them: do not measure on 8453 (a marked counts file is Twin-only). A new sha gets its frozen file by rebuilding the baseline from the adopted Twin measuring run (`freeze-counts.ts --from-adopted-run`, section 3, issue 1733); the 9a768bb9 file is only the optional `--cross-check` reference. The Twin job pre-deploys the four libraries (`predeploy-libs`) so libs and the first basket stage are adopted there too. 1723 (read-after-write safe reads) and 1724 (getLogs scan) are separate issues and are not duplicated here.

**Funding for a new run** (numbers from the plan owner's `ops fee-estimate` measurement of the 114-transaction run at 5x margin, 0.00234478 ETH, not stored in the repo: re-run `ops fee-estimate` at the tagged SHA before funding): about 0.00234 ETH for the tool plus 0.0000242 ETH for stage 13, recommended 0.00237 ETH, and the extra Safe `execTransaction` gas of the rehearsal rows (10 more Safe transactions: two each for register-committee, apply-receipt, update-delay, batch and cancel, plus the submitter Safe's creation and its `execTransaction` for the receipt, both paid by the deployer; stage 13's 8 Safe transactions cost 0.0000242 ETH, so these are about 0.00003 ETH, an estimate to re-measure) plus no funding for the submitter: it is a Safe and the deployer pays its gas. The owner funds about 0.005 ETH in total. USDC: 1 for the seed plus 1 per vault test deposit times 4, so 5 USDC. The reused deployer holds 0.00456 ETH (enough) and 4.5 USDC (0.5 USDC short; the first rehearsal's second sitting needs 4 USDC and returns most of it).

**Key tool steps.** No key is generated: the first rehearsal's keystores are reused. 1) `publish-contracts ops fee-estimate` for the numbers above at the tagged SHA. 2) Copy the example sheet, type the public addresses, set a NEW `SAFE_SALT_NONCE`. 3) Tag `release/<version>-rehearsal` on the Twin-rehearsed SHA (the plan owner cuts it; never move `release/v0.4.0-base`). 4) `publish --stage plan` (the gate checks the rehearsal tag), then `publish`, `verify`, `govern`, `verify` as usual with the deployer keystore typed at the hidden prompt and the three Safe owner signers. 5) The receipt path above. 6) `update-delay`, `batch`, `cancel` rows in that order. 7) Evidence with `deployment_kind: rehearsal`, `deployer_start_nonce`, `rehearsal_rows`, `committee_registrations`, `recorded_receipts` and `receipt_applications`, checked with `evidence-check --deployment-kind rehearsal`. The mode is selected explicitly in the sheet and by the `-rehearsal` tag; nothing selects it by default.

The Twin job (`core-stages-twin-chain`) runs this whole path in the rehearsal kind at 900 s with a REAL recorded receipt: a non-fresh deployer, a new salt, the four unpauses and the other rows, `register-committee`, `record-receipt` by a throwaway SUBMITTER key, `apply-receipt`, a third `verify` and the receipt-path evidence check. The Twin proves execution only; it is not evidence that mainnet governance works.

**Run-day: public mainnet dapp checks (issue 1729).** Before the public tunnel points at the mainnet dapp, open it with a wallet on Ethereum (1) and with a wallet on the Twin chain (918453). Each must show the red "Base mainnet — real funds" banner and the "Switch your wallet to Base (chain 8453)" screen, with no deposit or withdraw control. Switch to Base: the app loads and the banner stays. The guard is described in `docs/development/stage-deployment.md`.

Also check the class the deployed bundle reports. **The bundle check is the real one.** `VITE_ENV_CLASS` is build time only, so fetch the main JS bundle and confirm it contains `"mainnet"` as the baked class (for example `curl -s <dapp url>/assets/index-*.js | grep -o 'VITE_ENV_CLASS:"[a-z]*"'`). The `/config.json` check is weaker and must be read precisely. On the stage host a missing `/config.json` is answered by the single page app fallback: `index.html` with HTTP 200. A text search of that HTML for `VITE_ENV_CLASS` finds nothing, so "the served `/config.json` has no `VITE_ENV_CLASS`" passes trivially when no document is served (the dapp then logs a console warning and uses its build time values). Check it as a JSON parse of the response: it passes meaningfully only when the response parses as a JSON object without a `VITE_ENV_CLASS` key. `bun scripts/stage/dapp-served-check.ts <dapp url>` does both checks (`PASS served /config.json` says when the pass is trivial, `PASS bundle class` is the one that proves the class) and exits 1 on a fail. On a mainnet build any address in a served `/config.json` is ignored. Then load the page: the red banner must show. A page that shows no banner must not be exposed. The stack must have been built through `core-stack dapp up --chain 8453` (its overlay sets `VITE_ENV_CLASS=mainnet` as a build arg). A bundle built from the base `docker-compose.dapp.yaml` defaults to class fork and has neither the banner nor the guard. Treat explorer API data as untrusted: it is display only, and writes read the chain.

### 4.11. Redeploy one vault into a live deployment (issue 1796, an experiment on Deploy 2)

`redeploy-vault --vault PROTO` deploys a new rmPROTO closed and unregistered, binds the existing registry once, hands every role to the timelock and the emergency key, and drops the deployer. Govern row `redeploy-vault` then runs ONE timelock batch of six calls (register new, copy the router cap, five-leg migration, four-leg migration, retire old, unpause new). Tests: `contracts/test/RedeployProtocolAssetVault.t.sol`, `publish-contracts/tests/redeploy-vault.test.ts`.

**Interrupted versus atomic.** The deploy is several broadcast transactions and can die part-way: the round stays `started`, the vault stays closed and unregistered, a fresh run is refused, and only `--resume` with the same arguments continues it. The govern batch is atomic: one reverting call reverts all six, the chain is unchanged, and the same command executes the same operation again after the cause is fixed.

**Local pause is a possible whole-router revert.** A vault paused locally with `pauseDeposits()` while the registry still says Active and router-eligible is counted as depositable by the router. Its own pause then reverts the whole router deposit (all-or-revert), not just its leg. Only a registry status change or an eligibility migration makes the router skip the leg. Pause monitoring must cover both generations of rmPROTO.

**Stale operations.** A pause-all recorded after the batch was scheduled stops the batch from executing (its last call unpauses the new vault): cancel the operation through the Safe, then open a fresh round. An unpause or receipt operation scheduled before the cutover is refused or cancelled: the unpause row plans against the manifest's current vault, so the old operation is a different one, an apply-receipt vector that no longer matches the router-eligible set is refused, and a receipt released after its schedule is refused at execute time.

**Deposit guide and clients: holdings and history stay address-specific.** After the cutover the deposit guide names the current rmPROTO address (the verified overlay `current-vaults.json`, never the original manifest), its expected code hash, the effective split, the retirement block of the old vault and the old-holder exits (`redeem` for USDC, `redeemInKind` for the underlying assets). Retired old holdings are shown as their own line at the old address. The explorer API keys `/v1/accounts/:address/positions` and `/history` by vault address and the dapp position selector keys and selects by address, so one holder of both generations sees two positions and two histories, never one merged rmPROTO row. Tests: `retired_generation_keeps_address_specific_holdings_and_history` (explorer API), `position-selector-generations.test.tsx` (dapp), `cutover_interval_backfills_old_and_new_generation_exits_and_survives_restart` (indexer: the retired vault stays watched, the new vault is discovered inside the cutover interval, a restart from the saved cursor keeps both). Old shares are never moved.

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

**Stage order and transactions.** The proxy stages run in this order, each before the `timelock` stage, which deploys the upgrade authority LAST:

| Stage | Proxy (manifest field) | Implementation (manifest field) | Implementation contract |
| --- | --- | --- | --- |
| `vault` | `vault` | `vault_implementation` | `RobotMoneyVault` |
| `registry` | `registry` | `registry_implementation` | `VaultRegistry` |
| `router` | `router` | `router_implementation` | `PortfolioRouter` |
| `gateway` | `gateway` | `gateway_implementation` | `RobotMoneyGateway` |
| `ic-policy` | `policy` | `policy_implementation` | `InvestmentCommitteePolicy` |
| `ic-policy` | `consensus_receipt` | `consensus_receipt_implementation` | `ConsensusRecommendationReceipt` |
| `governance` | `governance` | `governance_implementation` | `RouterGovernance` |
| `proto` | `vault` | `implementation` | `ProtocolAssetVault` |
| `agent` | `vault` | `implementation` | `AgentTokenVault` |
| `rwa` | `vault` | `implementation` | `RwaBasketVault` |

Each proxy is 2 deployer transactions: the implementation, then the `ERC1967Proxy` whose constructor runs `initialize` atomically. The mode changes no count, so a frozen count measured on the Twin chain in one mode holds for the other. The deterministic address assumption is the timelock: every proxy names, from its first block, the CREATE2 address of the exact Safe-proposer `TimelockController`, from the factory `0x4e59b44847b379578588920cA78FbF26c0B4956C`, the salt `robotmoney.core.timelock.v1` and `SAFE_ADDRESS` and `TIMELOCK_MIN_DELAY`. Nothing else can hold code there, so no interim deployer upgrade path exists. The stage table (`scripts/deploy/stage-table.json`, `proxies` on each stage and `upgradeAuthority`) carries the same facts.

**Resume after a partial failure.** A proxy stage that dies part-way stays `started` in the run manifest. Rerun with `--resume` and the same arguments: forge replays the stage's own transactions at the same nonces, so its proxy and implementation addresses do not move. After every proxy stage the runner checks the stage manifest: each proxy and implementation address, `upgrade_timelock` equal to the pinned timelock prediction, and `upgrade_mode` equal to the sheet's mode. Anything else stops the run (`MANIFEST`, exit 12) with the stage left `started`. Stop and read the chain before anything else runs.

**Timelock pin and a timelock deployed by someone else (issue 1835).** The `vault` stage, the first proxy stage, records `timelockPrediction` (address, init code hash, Safe, delay) on its record in `publish-run.json`, derived from the build's `TimelockController` artifact. The timelock stage recomputes it and refuses with `MANIFEST` (exit 12), nothing sent, when it differs or is missing. A difference means the build changed since the first proxy stage (another solc or foundry version changes the CBOR metadata, so the address): rebuild with the toolchain of the first proxy stage. Anyone can deploy the timelock at the prediction once the proxies are on chain. The stage script then reuses it and plans one transaction fewer. The CLI accepts that only when the runtime code at the prediction hashes to the build's `TimelockController` runtime code: the stage then sends the frozen count minus one and records `adopted: true` with `adoption.libraries: [{ name: "TimelockController", address, codeHash }]`, and the nonce checks count what was sent. Other code, or no code, keeps the frozen count, so the shortfall is `COUNT_MISMATCH` (exit 10), nothing sent. In the evidence the timelock stage may list that one adopted entry (`evidence-check` caps it by the stage table).

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
2. Deploy a second copy of the gateway implementation from the build. Schedule and execute `upgradeToAndCall(newImplementation, "")` on the gateway proxy. Re-record the gateway manifest's implementation pin and run verify.
3. Queue a second gateway upgrade before the freeze, and leave it pending.
4. Freeze all ten proxies in ONE batch of `freezeUpgrades(implementation, implementation_code_hash)`, with both values taken from the `upgradeability.json` the verify of step 2 wrote.
5. Ask the Safe to execute the queued upgrade. The Safe tool refuses, and a simulated execute reverts with `UpgradesAreFrozen`.
6. Run verify again. It claims core immutability.

The record `upgrade-lifecycle.json` is checked by `bun publish-contracts/src/evidence-check.ts --upgrade-lifecycle FILE --rpc URL`, which reads every transaction, the refused operation and every proxy fact back from the chain. A Twin run proves the operations execute on the real contracts in this order. It does not prove the 48 hour delay or the mainnet signers.

**The governed upgrade procedure: `govern --row upgrade-proxy` (issue 1842).** Only while the proxy is unfrozen. Each step in order:

1. **Layout review.** Build the new implementation from a reviewed core commit. Its storage-layout snapshot (`contracts/test/fixtures/storage-layout/<Contract>.json`) passed `scripts/ci/check-core-storage-layout.sh` in CI against the deployed release's baseline. Review the snapshot diff: rows and members may only be appended.
2. **Deploy the implementation.** Deploy the new implementation from that build with the deployer, linked to the libraries the live implementation links (the Twin rehearsal's harness does the same). It holds no state and no role: its constructor disables initializers.
3. **Schedule.** Run `bun publish-contracts/src/cli.ts govern --row upgrade-proxy --proxy NAME --implementation 0x<new> --upgrade-build DIR` with the release's usual arguments. `NAME` is the verifier name (`gateway`, `registry`, `router`, `governance`, `icpolicy`, `receipt`, `vault[rmUSDC]`, `vault[rmPROTO]`, `vault[rmAGENT]`, `vault[rmRWA]`). `DIR` is a core checkout at the commit the implementation was built from, after `forge build` (default: the DEPLOY_SHA checkout, for a new copy of the release implementation). The row refuses (`GOVERN`, nothing scheduled) when the proxy reads `upgradesFrozen()` true, when `DIR`'s layout snapshot does not extend the deployed snapshot append-only (the snapshot in the DEPLOY_SHA checkout, whose layout id must equal the one `upgradeability.json` recorded), or when the code at the new implementation is not `DIR/out`'s build artifact (immutables and library links masked, every linked library's code compared too). It prints a `govern.preview` line with the old and new implementation and their code hashes, then schedules ONE timelock call, `upgradeToAndCall(newImplementation, "")`, through the Safe.
4. **Execute.** On 8453 the run exits `GOVERN_PENDING`. After the delay the same command executes it through the Safe and reads the implementation slot back.
5. **Re-record.** The same run then rewrites the proxy's stage manifest: the implementation field and, for the gateway, `gateway_implementation_runtime_hash` and `gateway_runtime_hash` from the chain. It records the operation and both transactions in the run manifest (`proxy_upgrades`).
6. **Verify.** Run `verify`: it re-records `upgradeability.json`. Copy it into the evidence.

**Ownership of the implementation deploy and the re-record.** Deploying the new implementation with its library links (step 2) and re-recording the stage manifest, the gateway implementation pin and the gateway runtime hashes after a governed upgrade (step 5) are owned by the operator tooling follow-up (1842). Its `govern --row upgrade-proxy` executes the re-record. It ships no command for the implementation deploy with library linking: until one lands, the only executed path for that step is the Twin harness (`publish-contracts/src/ci/twin-upgrade-lifecycle.ts`), which fills the link placeholders from the live implementation and sends a raw `cast send --create`.

**After a governed upgrade.** Until the manifest is re-recorded from the chain (step 5 above; the Twin rehearsal re-records in its own harness), `implementation slot equals the manifest` fails: the implementation slot of the upgraded proxy no longer equals its manifest. Then run verify, and copy the new `upgradeability.json` into the evidence. An upgrade to a build other than the DEPLOY_SHA's also needs that build's `out/` for `runtime code equals build artifact (masked)`: verify compares every contract with one build directory. Every signing client's implementation pin is updated from the new gateway manifest: the `rmpc` TOML, the dapp build env and the headless agent config. Until then the clients refuse to sign, which is the intended fail-closed behavior.

**Rollback is not assumed safe.** A rollback is another governed upgrade (`govern --row upgrade-proxy` back to the previous implementation), possible only while the proxy is unfrozen, with the same review and delay. After an upgrade that migrated state (a reinitializer in `upgradeToAndCall` data, or new storage written by the new logic), the previous implementation may not read the migrated state correctly. Never schedule a rollback without the same storage layout review as a forward upgrade. After the freeze no rollback exists: only a new deployment and a voluntary cutover change logic.

**Voluntary cutover from the current direct Base deployments (planned, not executed by this issue).** The contracts already live on Base 8453 are direct deployments. They cannot be upgraded in place, and pointing a new proxy at an implementation moves no share or permission. A governed-proxy release is therefore a NEW deployment at new addresses, and holders move by their own choice (`docs/adr/ADR-0009-vault-retirement-no-assisted-migration.md`, no assisted migration):

1. Deploy the proxied release with this tool (sections 4.3 and 4.12) at new addresses, and run verify and the evidence check. The current direct addresses stay recorded as they are and are labelled legacy (direct deployment, not upgradeable). They are never presented as upgraded.
2. Keep every legacy vault redeemable: `redeem` and `withdraw` for USDC, and `redeemInKind` for the baskets. Do not pause a legacy vault's withdrawals, and do not move a legacy holder's shares.
3. Point new deposits at the new release only after its cutover gates pass: verify green, evidence accepted, and the signing clients' implementation pins updated from the new gateway manifest (`gateway_implementation`, `gateway_implementation_runtime_hash`). The registry, router and gateway references of the new deployment are its own. Nothing in the legacy deployment is rewired.
4. Retire legacy vaults only through their own governance (registry retirement, deposits halted, withdrawals kept), as in 4.11. Holders exit and deposit into the new release themselves. The dapp and the explorer show legacy positions at their own addresses (4.11, address-specific holdings).

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

For a final Base mainnet release the preflight checklist always contains the
item "External security review completed for the release SHA, report recorded
in `docs/audits.md`" (§4.1, item 3). Every release also carries
"`core-stages-twin-upgrade-lifecycle` green at the release SHA"
(§4.1, item 4).

## 7. Backporting

Not applicable in the frontend's sense (§7 of that repo's policy) — there is
no release branch to backport from, since every deployment runs the same
`dev`-tip scripts (§2). A fix discovered during a deployment simply merges to
`dev` like any other change (§4.5).

## 8. Target networks

| Network | Chain id | Default per ADR-0013 | Notes |
| --- | --- | --- | --- |
| Robot Money Devnet | `918453` | **Yes — the default verification target.** | The Twin chain: a pinned lazy anvil fork of real Base at the upstream head minus 2 per CI run (`scripts/devnet/twin-fork.ts`, `docs/technical/full-stack-devnet.md`). Tests deploy their own vault (clean room). Full production-parity for all three yield adapters (Aave V3, Compound V3, Morpho). No lasting address record; a version tag against the Devnet documents a verification pass, not a persistent deployment. |
| Base mainnet | `8453` | The eventual real target — a separate, deliberately-costed decision (D9). | Requires an audit pass, Safe owners signing with encrypted keystores, and a funded submitter key. |

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
chain (the owner set and threshold, or `hasRole`). A rerun of a finished change
sends nothing.

**Refused: module, guard and fallback-handler changes.** No row builds
`enableModule`, `disableModule`, `setGuard`, `setModuleGuard` or
`setFallbackHandler`. The tool refuses them by name (`refuseSafeConfigChange`).
The Safe contract does not refuse a well-formed one: two owners can enable a
module at once, outside the timelock. The forge test
`test_selfAdmin_wellFormedModuleAndHandlerChangeIsDetectableNotPrevented` pins
that fact. The control is therefore this tool plus the verifier, which asserts
no module, no guard and the canonical fallback handler.

**The Safe's own timelock role.** Owner question 1 is open. The default is (b):
giving up a timelock role goes through the delay. The route is
`timelock-revoke-role` with the Safe as `account`. The tool never builds
`renounceRole`, because a Safe transaction is instant. The contract cannot force
the delay on a renounce, and `test_selfAdmin_directRenounceIsInstant_soTheToolMustNotBuildIt`
pins that.

**Owner decisions.** Record the answer here when given.

| Question | Default in force | Owner answer |
| --- | --- | --- |
| 1. May the Safe renounce its timelock roles instantly? | (b) through the timelock delay | not yet given |
| 2. Are these rows available on mainnet 8453? | (a) Twin-only | not yet given |

**CI proof.** The forge tests run in the required SafeIntegration suite. The
govern rows are covered by `publish-contracts/tests/govern.test.ts` (issue 1645
block): accepted on the Twin chain, refused on 8453.
