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
> in-place rollback, and "the release branch" is `Deploy.s.sol` and its
> companion deploy scripts at a specific commit, not a database.

This is not the process for landing ordinary feature work — that is PR review
against `dev`, covered by the repo's CI taxonomy. This document is
specifically about the step where a set of already-merged `dev` history is
packaged, rehearsed, and cut over into a real chain deployment — Robot Money
Devnet, Base Sepolia, or Base mainnet.

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
to a real network (Robot Money Devnet, Base Sepolia, or Base mainnet). A
rehearsal that does not produce a lasting, addressed deployment record does
not consume a version number.

Unlike the frontend's `releases-A.B.x` branch convention, contract releases
do not need a dedicated long-lived branch: `contracts/script/Deploy.s.sol`
and its companion scripts already read every deploy-time parameter from
environment variables, so the same scripts at a single commit on `dev`
deploy to every target network. The version tag `vA.B.C` is cut on `dev` at
the exact commit that was deployed and verified — there is no cherry-pick
dance, because there is no long-lived release branch to keep in sync.

A version tag is **network-scoped**: `vA.B.C` alone always means the Robot
Money Devnet (§8's default target), and a network suffix names anything
else — `vA.B.C-base-sepolia`, `vA.B.C-base` (mainnet). A given `vA.B.C` may
exist for multiple networks (a Devnet verification pass, later followed by a
Base mainnet deployment of the identical commit), and each network's tag is
its own go/no-go cycle through §4.

## 3. Version tags and rehearsal candidates

A version tag is **never** cut before **both** a completed preflight and a
completed postflight on the target network. The version tag records what has
been *proven deployed*, not what is *intended for deployment*. Everything
before that point is a rehearsal candidate, referenced by commit SHA, not a
tag.

The cycle:

1. Pick the `dev` commit SHA you intend to deploy.
2. Run preflight against that SHA (§4.1-4.2). **Preflight fails** → fix on
   `dev`, pick the new tip, return to step 2.
3. **Preflight passes** → run the deploy ceremony against the target network.
4. Run postflight (§4.3-4.4). **Postflight fails** → see §4.5 (fix loop) —
   patch on `dev`, and go back through preflight (step 2) before deploying
   again. A contract deployment cannot be "patched in place": a postflight
   failure after broadcast means either the deployed contracts are
   unusable (redeploy fresh addresses) or a mitigating admin action (pause,
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

1. **Guard scripts.** Run `scripts/base-sepolia-rehearsal/preflight-guards.sh`
   (network-agnostic despite the directory name — it checks the exact `forge
   build` artifacts, not a specific chain): the EIP-170 size gate on every
   contract in the ceremony's runtime set, and the env-default guard against
   an unsafe `RouterGovernance` `EXECUTION_DELAY`/`QUORUM_THRESHOLD`.
2. **Role and address validation.** `Deploy.s.sol`'s and every companion
   deploy script's own `_validate` step (P2-P6 in
   `docs/operations/base-sepolia-deployment.md`'s Preconditions table)
   — distinct non-zero role addresses, canonical asset address with deployed
   bytecode, a real timelock/Safe destination for the eventual role handover.
3. **Funding.** The deployer EOA holds enough native gas token and enough of
   the seed asset (`SEED_DEPOSIT_AMOUNT` in `Deploy.s.sol` — see
   `docs/future/review-usdc-seed.md` for its current temporary value) for the
   mandatory seed deposit.
4. **Network identity.** Confirm the RPC's reported chain id matches the
   target network's expected chain id before broadcasting anything — every
   deploy script in this repo that broadcasts checks this itself and refuses
   to proceed on a mismatch (see `scripts/base-sepolia-rehearsal/live.sh`'s
   `RPC_CID` check for the pattern every network's runbook should follow).

The preflight gate passes only when every check above passes with no
failures and no silently-skipped check.

### 4.3. Cutover — the deploy ceremony

Run the ordered deploy-script sequence documented in
`docs/operations/base-sepolia-deployment.md`'s "Ceremony steps" section (the
canonical step order and postcondition set — this policy does not restate it,
since the deploy scripts and their order are the same regardless of target
network): core stack (vault, adapters, gateway, seed deposit) → vault
registry → portfolio router → router governance → IC policy + consensus
receipt → timelock + role handover → record.

Every destructive or irreversible step (anything past the seed deposit, since
the vault is then open to real deposits) must be explicitly marked in the
per-release runbook and authorized by the operator before execution.

### 4.4. Postflight — manual QA

After the ceremony completes, the release's manual QA is what actually proves
the deployment is usable, not just that the transactions didn't revert. At
minimum:

1. **Role wiring.** Re-run every `cast call ... hasRole(...)` postcondition
   named in `docs/operations/base-sepolia-deployment.md`'s per-step
   postconditions — do not trust that broadcast success implies correct role
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

There is no branch to cherry-pick onto and no rc-numbering cost — every
contract deployment is a fresh broadcast, so "try again" is simply "deploy
the fixed commit."

### 4.6. Rollback

**Contracts are immutable; there is no in-place rollback.** A postflight
failure's mitigation depends on how far the ceremony got:

- **Before the timelock/role handover (§4.3's last step):** the deployer EOA
  still holds `ADMIN_ROLE` and can call `PAUSER_ROLE`-gated pause functions,
  or simply abandon the deployment (it holds no real user funds yet on a
  fresh network) and redeploy fresh addresses after the fix.
- **After the timelock/role handover:** the deployer no longer holds admin
  authority. Mitigation is whatever the timelock's configured emergency path
  allows (the vault's `EMERGENCY_ROLE` pause, per
  `docs/operations/manual-admin-actions.md`) while a fix is prepared and a
  **new** deployment (new addresses) is planned — a live vault's stored
  state cannot be transplanted onto fixed contract code.

The rollback/mitigation procedure must be written into the per-release
runbook and rehearsed on the Devnet at least once before a Base Sepolia or
mainnet deployment.

### 4.7. Production rollout report

After a deployment (successful or not), produce a report covering at least:

- the commit SHA and target network deployed,
- preflight and postflight results,
- any issues encountered and their resolution,
- the final version tag applied (if any — see §3),
- operator sign-off.

The report is the closing artifact of the release. The release tracking
issue is closed only after this report is filed.

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
| Robot Money Devnet | `918453` | **Yes — the default verification target.** | Local `docker compose` stack, genesis forked from real Base-mainnet state (`docs/technical/full-stack-devnet.md`). Full production-parity for all three yield adapters (Aave V3, Compound V3, Morpho). No lasting address record; a version tag against the Devnet documents a verification pass, not a persistent deployment. |
| Base Sepolia | `84532` | Rehearsal only, real network conditions. | `docs/operations/base-sepolia-deployment.md`. Compound V3 and Morpho lack production-parity deployments here (ADR-0013) — a full three-adapter ceremony cannot complete; Aave V3-only ceremonies are possible. |
| Base mainnet | `8453` | The eventual real target — a separate, deliberately-costed decision (D9). | Requires an audit pass, Safe/hardware-wallet signers, and a funded submitter key per `docs/operations/base-sepolia-deployment.md` §"Why this exists." |
