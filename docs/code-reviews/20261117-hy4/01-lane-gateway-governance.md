# LANE 1 — Adversarial security review: gateway, roles, governance and upgrade authority

## Pin scope

- repository: `/drive2/home/lucas/robotmoney/robotmoney-core`
- branch under review: `release-0.9.0`
- branch at analysis: `review/security-release-0.9.0-20261117`
- commit: `d4a43e6d21efed208816698d2b32f0decea45451` ("Verify prior Deploy 4 upgrade builds")
- reviewed_at: `2026-11-17`
- `git log d4a43e6d..origin/release-0.9.0` is empty — origin is not ahead of the pin.
- worktree: `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/adhoc-20261117-145601`
- tracker backend: `github`; issue/PR: none (adhoc review).
- Scope: `contracts/gateway/RobotMoneyGateway.sol`, `contracts/gateway/AccessRoles.sol`, `contracts/gateway/interfaces/*.sol`, `contracts/RouterGovernance.sol`, `contracts/ProposerFloorTimelock.sol`, `contracts/lib/GovernedUUPS.sol`, `contracts/lib/AdminFloorAccessControl.sol`, `contracts/lib/AdminFloorAccessControlCounter.sol`, `contracts/lib/GatewayWindows.sol`, and the lane tests named below. Canonical trust model: `docs/architecture.md` §2.3, §4.3/4.5/4.6/4.8, §5.2, §6, §8. Prior dispositions: `docs/audits.md`, `docs/code-review/20261015-review-security-claude.json`.
- Repository instructions: `/drive2/home/lucas/superfield/prompts/AGENTS.md` (principal checkout read-only; all work in this worktree; no production edits, no commits).

## Headline verdict

**Clean lane at the pinned commit.** No new confirmed security finding and no surviving re-reportable prior finding was found across gateway authority, agent consent, role separation, rolling-window caps, governance receipt application, or upgrade/freeze authority. Zero `FINDING L1-NN` entries are reported. The verdict is `high` confidence for the reviewed surfaces and is bounded by the `## Limitations` section (no local `forge test` execution this session; some test bodies read by name only; submodule dirty).

Severity summary: 0 critical, 0 high, 0 medium, 0 low, 0 info. No merge-blocking item.

## Methodology

1. Repinned the worktree and re-verified the HEAD and origin relationship before any analysis.
2. Read the canonical trust model (`docs/architecture.md` §5.2: owner owns policy and chooses destinations offline, agent consents, every policy writer forces `shareReceiver == caller`) and prior audit ledgers before judging any candidate. The owner-trust model makes "a malicious destination named by the owner" out of scope unless a code invariant is independently violated.
3. Read every in-scope production contract in full and the lane tests in full or by executed-test name, then checked CI wiring (`.github/workflows/suite-01-02-forge-tests.yml`) for execution evidence rather than test existence.
4. Applied the contract-review rule "adversarially refute candidate findings before keeping them": six candidate hypotheses were constructed and refuted with `path:line` evidence (below). None survived.
5. Performed two explicit n-order composition checks, because each authority in this lane is a composition of independent guards whose combination — not any single guard — is the security property (below).

Statements below are labelled **[observed]** when they rest on cited source/CI lines and **[inference]** when they explain impact.

## n-order composition checks

### C1 — Agent registration authority is a four-way composition

**[observed]** The only writers of `agents[agent]`, `agentOwner[agent]` and the grant of `AGENT_ROLE` are `_register` (`contracts/gateway/RobotMoneyGateway.sol:467-487`), `setPolicy` (`:490-502`) and `_endRegistration` (`:516-526`). There is no second path.

**[observed]** Four independent guards must all pass for `_register` to succeed:

1. Owner commit/reveal: `commitAuthorization` stores a committer-scoped commitment (`:416-421`); `revealAuthorization` checks existence, one-block delay, 256-block expiry and clears it CEI (`:424-443`).
2. Agent consent bound to the exact call: when `agent != msg.sender`, the consent key is `keccak256(abi.encode(msg.sender, keccak256(msg.data)))` scoped to the agent (`:452-461`). `msg.data` is the full reveal calldata, so the owner cannot alter agent, salt or policy after consent.
3. Role separation: `_register` calls `_grantRole(AGENT_ROLE, agent)` (`:481`), which runs `AccessRoles._grantRole` (`contracts/gateway/AccessRoles.sol:95-110`) and then `_assertRoleSeparation` (`RobotMoneyGateway.sol:482`, `AccessRoles.sol:122-131`).
4. Gateway overrides compose via `super`, not shadowing: `_grantRole` (`RobotMoneyGateway.sol:305-311`) calls `super._grantRole` (AccessRoles), which calls OZ; `_revokeRole` (`:316-326`) enforces the last-admin floor then calls `super`. Both invariants therefore hold simultaneously.

**[inference]** No single role (ADMIN, DEFAULT_ADMIN, DEPOSIT_PAUSER) and no mempool observer can register or replace an agent without the owner's reveal and, where distinct, the agent's calldata-bound consent. The property is n-order: removing any one of the four guards breaks it, and I verified each hook is reached under Solidity override resolution rather than accidentally bypassed.

### C2 — Upgrade/freeze authority is a four-way composition across two contracts

**[observed]** `upgradeToAndCall` and `freezeUpgrades` forward the exact calldata by `delegatecall` to the linked `GovernedUpgrade` library (`contracts/lib/GovernedUUPS.sol:224-252`). `_authorize` permits only `msg.sender == upgradeTimelock` and rejects a frozen proxy (`:154-158`).

**[observed]** `upgradeTimelock` is written once in `init` (`:78-97`, write at `:87`), has no setter, and is explicitly not an AccessControl role (`:21-23`), so no grant/revoke/renounce path can reach it.

**[observed]** Freeze is one-way: `upgradesFrozen = true` (`:130`) with no clearing write anywhere; `_disableInitializers` raises the Initializable version to `type(uint64).max` (`:146-152`), blocking every reinitializer. `init` bounds the freeze to a declared `UpgradeMode` and refuses `Undeclared` (`:83-85`).

**[observed]** The timelock's own proposer role cannot be bricked: `ProposerFloorTimelock._revokeRole` reverts at count 1 for `PROPOSER_ROLE` (`contracts/ProposerFloorTimelock.sol:77-83`), covering both `revokeRole` and `renounceRole`; the constructor refuses a proposerless timelock (`:61`).

**[inference]** No gateway role carries upgrade power, upgrade authority is disjoint from all gateway roles, and the sole authority cannot be lost through role management on either contract. Freeze binds to the live implementation and code hash (`GovernedUUPS.sol:123-135`), so a queued freeze cannot lock in a different version after an intervening upgrade.

## Adversarial refutations (candidates constructed, then refuted)

- **R1 — Commit/reveal front-running or consent reuse.** Hypothesis: an observer copies a reveal or reuses an agent consent. Refuted: commitments are keyed by `_commitmentKey(commitHash, committer)` (`RobotMoneyGateway.sol:417-419, :184-188`), so a copier's `msg.sender` yields a different key and `CommitmentNotFound` (`:430`). Reveal requires a strictly later block (`:433`) and is single-use via CEI delete (`:441`). Consent is keyed by the owner address plus `keccak256(msg.data)` and the agent (`:452-455`), is single-use (`:460`) and expires (`:457-459`). **[observed]** No bypass path found.

- **R2 — Rolling-window boundary burst / `maxPerWindow` TOCTOU.** Hypothesis: a deposit near a window edge or a concurrent `setPolicy` lets an agent exceed `maxPerWindow`. Refuted: `depositTo` takes a single in-memory policy snapshot (`:593-615`) and passes `args.maxPerWindow` to `_accrueRollingDeposit` (`:661`), so there is no second SLOAD to race. Enforcement uses strict `(t-WINDOW_SECONDS, t]` expiry in `GatewayWindows.accrue`/`_prune` (`contracts/lib/GatewayWindows.sol:48-57, :75-89`), eliminating calendar-boundary double-spend. Same-second coalescing and slot reuse bound storage (`:94-127`). **[observed]**

- **R3 — Role-separation escalation.** Hypothesis: a `DEFAULT_ADMIN_ROLE` holder renounces `ADMIN_ROLE` and self-grants `AGENT_ROLE`, or an admin doubles as pauser. Refuted: all three public role methods hard-deny `AGENT_ROLE` (`AccessRoles.sol:57-88`), and `_grantRole` rejects any cross-tier overlap, treating `DEFAULT_ADMIN_ROLE` as admin tier (`:95-115`). `_register` re-asserts separation after granting agent (`:481-482`). **[observed]** This is the documented L-14 fix; no regression.

- **R4 — Governance brick by removing the last admin or proposer.** Hypothesis: the sole holder drops its role and freezes all configuration. Refuted on three contracts: gateway admin tiers are floored (`RobotMoneyGateway.sol:316-326`); router/admin contracts floor `ADMIN_ROLE` via `_revokeRole` (`contracts/lib/AdminFloorAccessControl.sol:50-55`); the timelock floors `PROPOSER_ROLE` (`ProposerFloorTimelock.sol:77-83`). Each override intercepts both revoke and renounce. **[observed]**

- **R5 — Out-of-order or replayed receipt application.** Hypothesis: a stale ready receipt can be applied after a newer one, or an already-released receipt reused. Refuted: `applyReceipt` requires `r.recordedAt > lastAppliedRecordedAt` and writes it before external calls (`contracts/RouterGovernance.sol:191-193`), rejects a released receipt (`:187`), binds the named digest to the stored digest (`:188-190`), and is `nonReentrant` (`:182`). A reverting router `setWeights` rolls the whole update back (`:195-198`). **[observed]**

- **R6 — Frozen-proxy reinitializer takeover / wrong-target freeze.** Hypothesis: after freeze an attacker reinitializes storage to seize roles, or a queued freeze locks a different implementation. Refuted: freeze raises the Initializable version to max (`GovernedUUPS.sol:123-135, :146-152`), `upgradeToAndCall` is gated by `!upgradesFrozen` (`:154-158`), `FrozenAtDeploy` fixes the flag inside the atomic initializer (`:88-96`), and `freezeUpgrades` requires both expected implementation and code hash to match live state (`:127-129`). **[observed]**

## Findings

None. Zero `### FINDING L1-NN` entries at the pinned commit. No prior finding was re-reported: the lane-relevant 20261015 items are recorded as fixed or superseded in `docs/audits.md` (SR-1015-23 fixed; SR-1015-034/035/047/048 superseded by `GovernedUUPS`), SR-1015-14 is explicitly out of lane (`rmpc`), and RS-1019-10/11/12 are fixed by core commits 1889/1890/1891/1892 present in the reviewed source and tests.

## Clean areas

- **Agent lifecycle and consent** — commit/reveal with one-block delay, 256-block expiry, calldata-bound agent consent, CEI commitment clearing (`RobotMoneyGateway.sol:416-487`).
- **Policy authority (ACL-9/GW-7)** — one validator forces `shareReceiver == caller` on every writer (`:532-550`); only the recorded owner can call `setPolicy` (`:490-495`); retired withdraw fields must stay zero (`:545-549`).
- **Deposit caps and replay** — in-memory snapshot cap check (`:593-661`), exact rolling-window accounting (`GatewayWindows.sol:48-127`), full-intent `paymentId` binding including destination and `minSharesPerLeg` (`RobotMoneyGateway.sol:624-651`), custody and fee-on-transfer checks (`:666-728`).
- **Role separation and floors** — pairwise tier disjointness (`AccessRoles.sol:95-131`), last-admin floor on gateway and router governance (`RobotMoneyGateway.sol:316-326`, `AdminFloorAccessControl.sol:50-55`), last-proposer floor (`ProposerFloorTimelock.sol:77-83`).
- **Pause asymmetry** — pauser can only block deposits; no withdrawal path exists, so pause cannot block a withdrawal (`RobotMoneyGateway.sol:553-564`; architecture §5.2, core 1494).
- **Governance receipt application** — monotonic `recordedAt`, released-receipt refusal, payload-digest binding, CEI ordering (`RouterGovernance.sol:177-199`).
- **Upgrade/freeze authority** — timelock-only, one-way freeze, implementation+code-hash binding, no role carries upgrade power (`GovernedUUPS.sol:78-158, :224-252`).
- **CI execution evidence** — lane tests are run through `forge_test_require_executed.sh` with non-zero executed-test floors (`.github/workflows/suite-01-02-forge-tests.yml:168, :180, :196-198, :284, :295-296, :428-442`), including named evidence targets `AccessRoles`, `RouterGovernanceApplyReceipt`, `GatewayAgentPolicyAuthorization` (`:196`); the fork-only `WithdrawalsNeverFrozen.t.sol` is excluded from the default `forge test` set (`:161, :746`) and run explicitly via `scripts/devnet/forge-fork-tests.ts` (`:598-599`).

## checked_shapes

Evaluated and ruled out on the lane surfaces (names are the stable `### Name` values from `docs/development/false-green-shapes.md`; `none-published` does not apply because the catalogue exists):

- `digest-blind-to-attribute` — checked that the idempotency hash folds in the routing target and slippage vector (`RobotMoneyGateway.sol:638-650`) and that no ABI `indexed` swap in lane events was observed; the deliberate omission of `deadline` is documented intent (`:30, :624`), not a drifting attribute the runtime depends on.
- `starved-guard-input` — the executed-test floors are literal non-zero constants feeding `forge_test_require_executed.sh` (`.github/workflows/suite-01-02-forge-tests.yml:168, :180, :295, :437`), not a value from a swallowed git command.
- `trigger-scoped-dead-code` — the fork test `WithdrawalsNeverFrozen.t.sol` is trigger-scoped out of the plain `forge test` job but has a dedicated CI execution step (`:598-599`), so it is not unexercised at PR time.
- `optional-fixture-early-return` and `artifact-guard-runs-before-build` — the reviewed Solidity tests contain no `Option`/`existsSync`-style early returns over a missing resource; execution is proven by the executed-count guards above.
- `missing-evidence-script` and `uninvoked-evidence-script` — the devnet fork-test runner named as the evidence for `WithdrawalsNeverFrozen.t.sol` is invoked by a workflow step (`:598-599`), not merely named in a doc.

Not evaluated here (outside lane scope): `selftest-env-splice`, `quoted-path-evasion`, `matrix-tool-absent-step-skipped`, `fixture-shape-blind-selftest`, `doc-contradicts-guard-invariant`, `stale-cache-embedded-artefact` — these concern release/CI harnesses and Rust/TS suites, not the gateway/governance/upgrade contracts.

## Limitations

- No local `forge test` run was performed this session; the `lib/openzeppelin-contracts-upgradeable` submodule shows a pre-existing ` m` (modified) state in the worktree and was deliberately left untouched. Execution evidence is taken from the pinned CI workflow definitions, not from a fresh local run.
- `contracts/test/RobotMoneyGateway.t.sol` and `contracts/test/RouterGovernance.t.sol` were assessed by executed-test names and CI wiring, not read line-by-line in full this session.
- `docs/prd.md` was not read directly; product-level authority expectations were taken from `docs/architecture.md` §5.2 and the prior-audit ledgers, which are the canonical trust model for this lane.
- This is a code-and-CI review at a pinned commit. It does not verify deployed proxy state, the live Safe/timelock configuration, or that the implementation bytecode at the pin matches any on-chain deployment; the pinned commit is a publish-contracts change and on-chain pin verification was out of lane.
- No fixes were implemented and no production code, canonical documents, issues or external state were modified, per the review instruction.
