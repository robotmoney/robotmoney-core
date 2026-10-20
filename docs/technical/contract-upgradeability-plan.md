# Contract upgradeability policy and implementation plan

**Status:** target policy and design plan, 2026-10-13. Stage 1 (contracts and
lifecycle tests) is implemented in the source by issue 1808 and recorded in
[ADR-0014](../adr/ADR-0014-governed-uups-upgrades-and-freeze.md) (Accepted 2026-10-16).
No upgradeable Robot Money deployment exists on Base 8453: the existing Base
mainnet contracts remain direct deployments and cannot be upgraded in place.
Stage 3 (signing clients, ABI consumers, dapp, explorer, indexer and monitoring)
is implemented by issue 1810; see "Signing clients and disclosure (stage 3)"
below. Stage 2 (release sheet and publish evidence) is implemented by issue
1809; see "Release tooling and evidence (stage 2)" below. Stage 4 (Twin
rehearsal and cutover documentation) is implemented by issue 1811; see "Twin
rehearsal and release gate (stage 4)" below.

## Decision and scope

Test, demo, rehearsal, and contained Base mainnet test deployments should be
upgradeable so a verified implementation can replace faulty logic without
changing the user-facing contract address or its state. A final mainnet release
must offer a choice between freezing upgrades in the deployment transaction and
keeping the upgrade path during a bounded production proving period, then
freezing it by a delayed governance action. The freeze is permanent for that
proxy. The release sheet must state the choice explicitly; no default may
silently leave a final deployment upgradeable.

Use one versioned implementation and one deployment scheme across environments:
independent ERC-1967/UUPS proxies for the **stateful, user-facing core**. The
initial implementation contains the upgrade and freeze logic in every
environment. The only environmental difference is initialization and governance
state. Do not make a test-only implementation or use a shared beacon whose
single upgrade would change every vault at once. A final deployment that needs
stronger immutability than a frozen UUPS proxy can instead use a separately
reviewed direct-deployment architecture; that is a distinct release decision,
not an interchangeable flag on the current constructors.

Candidates for per-instance proxies are, in the vaults system,
`RobotMoneyVault`, the three concrete `BasketVault` subclasses,
`VaultRegistry`, `PortfolioRouter`, `RouterGovernance`, and
`ConsensusRecommendationReceipt`, and, in the
rmpc gateway system, `RobotMoneyGateway`. Inventory each deployment stage before
implementation; make the decision per contract and record exclusions in the
release manifest. The strategy and swap adapters, linked libraries,
`UniswapV4PriceRecorder`, and `TimelockController` remain direct
deployments in this plan. Safe retains its existing canonical SafeProxy 1.4.1
and verified SafeL2 singleton topology; it is not converted to a Robot Money
UUPS proxy. Adapter address and runtime-codehash checks and the
no-proxy scan remain mandatory. An adapter upgrade means deploying a new
adapter and approving its address/hash through the existing governance path.

## Two systems

Owner decision, 2026-10-19. The proxied core is two separate systems. The
vaults system (the vaults, VaultRegistry, PortfolioRouter, RouterGovernance
and ConsensusRecommendationReceipt) is released,
rehearsed and frozen in its own run. The rmpc gateway system
(RobotMoneyGateway and `rmpc`) is released in its own later run and tested on
its own. The gateway is a client of the vaults system. The vaults system has
no dependency on the gateway: no vaults-system contract names the gateway,
takes it as an initializer argument, or accepts writes only from it. Who
governs the gateway, and so who upgrades and freezes its proxy, is an open
question for its own release.

## Mechanism and authority

Each proxy delegates to its own implementation. Convert constructor setup to
an atomic `initialize(...)` call in the proxy constructor; disable initializers
on implementation contracts. Use the OpenZeppelin upgradeable ERC-20/ERC-4626,
AccessControl, and ReentrancyGuard bases as appropriate, with explicit parent
initialization. Move instance-specific constructor `immutable` values into
proxy storage with public getters retaining the current ABI. Constants stay
constants. Audit inheritance order, namespaced storage, and every external
library link before choosing final storage layout. Pin and validate that layout
for every upgrade; append-only layout discipline alone is insufficient when
inheritance or library linking changes.

Storage that loses its use is retired in place, never removed or reused. It
keeps its label and type, becomes `internal`, and is never read or written
again. `RobotMoneyGateway` keeps the retired slots `icPolicy` and
`consensusReceipt`. An empty `IInvestmentCommitteePolicy` interface stays only
to type the `icPolicy` slot. `ConsensusRecommendationReceipt` keeps the retired
slots `gateway` and `icPolicy`. Their layout snapshots do not change.

The proxy's upgrade authority is the existing Safe-controlled
`TimelockController`, never the deployer, an EOA, `EMERGENCY_ROLE`, or
`RouterGovernance` (which only governs portfolio weights). `_authorizeUpgrade`
checks both the timelock caller and a one-way `upgradesFrozen` flag. Add
`freezeUpgrades(expectedImplementation, expectedCodeHash)` callable only through
the same timelock. It must revert if the live implementation or its code hash
differs from the reviewed target, preventing a queued freeze from permanently
locking a different version after an intervening upgrade. It emits an event
with the proxy and current implementation. The flag has no unset function. A
frozen implementation must not expose any other path that writes the ERC-1967
implementation slot or delegates to untrusted code. A freeze-at-deploy option
sets the flag during atomic proxy initialization, before any public call.
Timelock ownership/role handover and the absence of residual deployer powers
must be checked before opening deposits.

The current stage table deploys the timelock last. Before proxy deployment,
either move the timelock/Safe setup ahead of every proxy stage or use a
deterministically precomputed timelock address whose code and Safe ownership
are verified before opening deposits. The deployment plan must prove the
authority exists and cannot leave an interim deployer-controlled upgrade path.

Before freeze, governance can still install malicious or broken logic; the
timelock gives inspection time but does not make an upgrade safe. Review the
implementation bytecode, storage-layout report, linked libraries, calldata,
and any reinitializer; rehearse the exact Safe → timelock operation against a
fork of the target chain. A rollback is another governed upgrade and is
possible only while unfrozen. After freeze, only a new deployment and
user-directed migration can change logic. Freezing upgrades must never pause
or alter withdrawal rights.

Freeze is per proxy, not a claim that all system behavior is immutable. Normal
governed parameters and adapter selection remain mutable; external tokens and
venues retain their own upgrade authorities. Record the full core dependency
set and verify every required proxy is frozen before labeling a release's core
logic immutable. Review pending upgrade operations before freezing and test
that previously queued upgrades fail after freeze. No initializer,
reinitializer, role change, or other callable path may clear the frozen flag.
A proving deadline is an operational commitment, not an automatic on-chain
freeze: the release runbook must name the responsible Safe signers and schedule
the freeze early enough to satisfy the timelock delay. Alert on a missed
deadline and continue to report the deployment as upgradeable until verified.

## Release modes and proof

| Mode | Initial state | Allowed transition |
| --- | --- | --- |
| Test / demo / rehearsal / contained mainnet test | Upgradeable, timelock controlled | Upgrades and eventual freeze by Safe → timelock |
| Final mainnet, fixed at launch | Frozen in atomic initializer | No upgrade |
| Final mainnet, production proving period | Upgradeable, with explicit review deadline and capped exposure | Upgrade through Safe → timelock; freeze through Safe → timelock after the reviewed period |

The deployment sheet and per-release runbook must declare a mode **for every
proxy**, its implementation address/hash, storage-layout identifier, proxy
address, expected freeze state, timelock address and delay, and any proving
period/deadline. The publish CLI must refuse an undeclared mode, an uninitialized
proxy, unexpected implementation/admin slots, an unowned upgrade path, or a
final release whose actual freeze state differs from the approved sheet.
Verification must read the ERC-1967 slot and `upgradesFrozen()` on chain, verify
both proxy and implementation source, and record the evidence in manifests.
Signing clients must verify both proxy code and the live ERC-1967 implementation
address/code hash against the approved release before authorizing writes; an
unknown implementation or failed read must refuse signing. The current
`clients/rust-payment-client/src/policy/mod.rs` gateway runtime-code hash check
alone cannot detect a proxy implementation change. Update its configuration,
checks, and refusal tests as a release prerequisite. State reads should use a
consistent block; pre-sign verification does not prevent an upgrade before
transaction execution. Specify how queued user transactions and signed gateway
authorizations are handled across upgrades, including version binding or
invalidation where their semantics change. The indexer must track implementation
changes and freeze events without treating its cache as signing authority. Public contract
metadata should show whether upgrades remain possible.

## Release tooling and evidence (stage 2)

Implemented by issue 1809. The operator procedure is
`docs/operations/contract-release-runbooks.md` 4.12.

- **Mode.** The sheet's `UPGRADE_MODE` (`upgradeable` or `frozen`, required, no
  default) is the mode of every proxy of the release; `UPGRADE_FREEZE_DEADLINE`
  is required for an upgradeable production release on 8453 and refused with
  `frozen`. A run never changes its mode, and a resume under another mode is
  refused.
- **Stage table.** Each proxy stage lists its `proxies` (proxy and
  implementation manifest fields, contract, layout snapshot);
  `upgradeAuthority` states the deployed-last timelock, its CREATE2 inputs and
  2 deployer transactions per proxy. The counts do not depend on the mode.
- **Timelock pin (issue 1835).** The first proxy stage records the predicted
  timelock address and its init code hash, derived from the build, in the run
  manifest. Every proxy manifest must name that address. Every later proxy
  stage and the timelock stage recompute the prediction after their simulation
  and refuse before they broadcast when it differs (issue 1853: a toolchain
  change moves the CBOR metadata and so the address, and so does another Safe
  or delay). A run manifest from an earlier release without the pin is
  backfilled only when the first proxy stage's manifest, its proxy's
  `upgradeTimelock()` on chain and the recomputed prediction agree. CI checks
  that the TypeScript prediction equals `UpgradeAuthority.predictTimelock`
  for the same build. A timelock someone already
  deployed at the prediction with the build's runtime code is adopted: the
  stage sends one transaction fewer and records the adoption.
- **Verify.** Per proxied core contract the verifier proves the build's
  `ERC1967Proxy` with empty admin and beacon slots, the implementation the
  manifest names (and the gateway's implementation pin), the build's linked
  libraries, `upgradeTimelock()`, the initialized version, `upgradesFrozen()`
  against the mode, and the layout identifier (keccak256 of the committed
  snapshot and the OpenZeppelin pins). It fails a missed freeze deadline.
- **Claim.** Core immutability is claimed only when the full proxied core set
  of the stage table reads frozen on chain and verifies (after the split, the
  set of the system being released); a frozen-mode release
  fails verification otherwise. The record lists the parameters a freeze leaves
  governed and the upstream dependencies it does not control.
- **Evidence.** `deployments/<chain>/upgradeability.json` becomes the evidence
  `upgradeability` section; `evidence-check` checks it offline and reads every
  proxy fact back from the chain.

The sheet declares one mode for all proxies rather than one per proxy: every
proxy stage reads the same `UPGRADE_MODE`, and a release that wants a different
mode per contract needs a stage-table change. Implementation addresses are not
typed into the sheet ahead of the run; the build fixes their code and verify
records their addresses and hashes for the per-release runbook.

## Twin rehearsal and release gate (stage 4)

Implemented by issue 1811. The CI job `core-stages-twin-upgrade-lifecycle`
(suite 28, in the deploy-gate list) deploys the exact release artifacts of the
SHA on the Twin chain with `UPGRADE_MODE=upgradeable`
(`deployments/twin-918453/upgrade-rehearsal.env`). Through the real Safe and
timelock it upgrades the gateway proxy to a second copy of the release
implementation, queues a second upgrade, freezes all nine core proxies in one
batch bound to the reviewed `upgradeability.json`, and shows the queued upgrade
is refused after the freeze with `UpgradesAreFrozen` (deployed release,
v0.5.0). The target rehearsal covers the eight vaults-system proxies; the
gateway proxy is upgraded and frozen in its own rehearsal, under its own
upgrade timelock. Verify then claims core
immutability. `evidence-check --upgrade-lifecycle` reads the record back from
the chain. Each system's own rehearsal covers its own proxies (see "Two
systems"). The release runbook (4.1 and 4.12) makes this job and an external
security review gates of a final mainnet release, and says why a rollback is not
assumed safe after a state migration. The rehearsal runs the operator rows
`govern --row upgrade-proxy` and `govern --row freeze-upgrades` (issues 1842 and
1859); only the queued upgrade that never executes goes through the Safe tool
library directly.

## Signing clients and disclosure (stage 3)

Implemented by issue 1810. `rmpc`'s one on-chain write, the agent deposit
into a vault, goes to the gateway proxy, so the gateway is the proxy the
signing clients verify. This section is about the rmpc gateway system. The
submitter Safe records receipts with publish-contracts `record-receipt`, not
with `rmpc`.

**Verification before signing.** `rmpc deposit` and the dapp's
admin writes pin a block, then check at that block:

1. `keccak256(eth_getCode(gateway))` equals the proxy pin
   (`gateway_runtime_hash`, `VITE_GATEWAY_EXPECTED_CODE_HASH`);
2. the ERC-1967 implementation slot names exactly the approved implementation
   (`gateway_implementation`, `VITE_GATEWAY_EXPECTED_IMPLEMENTATION`);
3. `keccak256(eth_getCode(implementation))` equals its approved code hash
   (`gateway_implementation_runtime_hash`,
   `VITE_GATEWAY_EXPECTED_IMPLEMENTATION_HASH`).

The approved pair comes from the gateway manifest (`gateway_implementation`,
`gateway_implementation_runtime_hash`). The rules fail closed: a proxy with no
approved implementation, an approved implementation on an address whose slot
is empty, another address in the slot, another code hash, a slot word that is
not an address, or any failed read refuses (`rmpc`:
`ErrImplementationNotApproved`, `ErrImplementationUnverified`). A gateway with
an empty slot and no pin is a direct deployment, checked by the code-hash pin
alone. Every `rmpc` preflight read (proxy, implementation, `usdc()`, `vault()`,
`agents()`, window gross, allowance, balance, vault share checks) runs at the
same pinned block. The dapp's pins are build-time-only, like the code-hash pin;
a runtime `/config.json` cannot supply or replace them. Indexed state never
authorizes signing.

**Outstanding signed writes and queued transactions across an upgrade.** No
gateway call carries an implementation version, and adding one is a Solidity
change (stage 1 scope). The clients therefore bind what they sign:

- `rmpc deposit` re-reads the implementation at
  `latest` after signing and before broadcast. A changed or unapproved
  implementation discards the signed transaction unsent
  (`ErrImplementationChanged`), so it can never execute (issue 1856,
  `write_path.rs` module doc).
- After the receipt, `rmpc` reads the implementation slot at the block the
  transaction executed in. Anything other than the implementation it verified
  is reported as `ErrImplementationChanged` with the `tx_hash`, never as a
  success, and the replay-cache entry stays so the write is not re-sent
  blindly.
- A signed `deposit` carries an on-chain
  `deadline` of at most `MAX_DEADLINE_SKEW` (600 s) ahead of the block time.
  An upgrade must wait the
  timelock's minimum delay after it is scheduled, which is far longer, and the
  `CallScheduled` operation is public for that whole time. A write signed before
  an upgrade can only execute after it inside that bound, and the receipt check
  above reports it when it does.
- Gateway authorizations (agent policies, owner consent, pending
  `commitAuthorization` commitments) are proxy state and survive an upgrade by
  design; the storage-layout gate keeps their meaning. An upgrade that changes
  their semantics must migrate or invalidate them in its reviewed reinitializer
  (`upgradeToAndCall` data). Pending commitments also expire after
  `COMMIT_EXPIRY_BLOCKS`. The dapp gates every admin flow, including a
  reveal, on a verified gateway with the implementation pin. It verifies when
  the page loads, the wallet connects or changes chain, and on "Re-verify".
  Every write from AdminFlow and AgentsPanel, and every Safe proposal
  signature, also re-reads the gateway code, implementation slot and
  implementation code at the latest block right before it goes to the wallet,
  and is refused on any change. A gateway, Timelock or Safe write is refused
  outright while the gateway is not verified; other writes (approve, deposit,
  withdraw) pass through then and rely on their previews (issue 1840). It has
  no receipt-time check.
- Queued timelock operations: a queued `freezeUpgrades` is bound to the
  reviewed implementation and code hash and reverts after an intervening
  upgrade; a queued upgrade reverts once the proxy is frozen. Review and cancel
  every pending upgrade operation before freezing.

After an approved upgrade, every client's implementation pin is updated from
the new release manifest. Until then the clients refuse to sign, which is the
intended fail-closed behavior.

**Disclosure.** The explorer indexer stores every proxied core contract's
`Upgraded` and `UpgradesFrozen` events in `admin_events` (`contract_kind =
'proxy'`, migration 0019) and now watches RouterGovernance for them. The
registry's proxy events are fetched whether or not `INDEXER_MULTI_VAULT_EVENTS`
is on. On startup the indexer backfills both topics for every watched proxy from
the deploy floor to its cursor, so a proxy added after the cursor passed its
deploy block still gets its history (issue 1840). The backfill runs one bounded
slice per tick from a saved checkpoint, and a refused or cursorless backfill is
retried and shown as `proxy_backfill` in the explorer's `/health` (issue 1856).
The API
lists them with the governance events and gives each contract its
`implementation`, `upgrade_state` (`frozen`, `upgradeable`, `unknown`) and
`frozen_at_block` on `/v1/chains/:chain_id/contracts`. The dapp shows the
gateway's live implementation and freeze state once verified, and the vault
detail shows each vault's indexed implementation and upgrade state. `rmpc
get-gateway` reports the implementation, its code hash, `upgradesFrozen()` and
`upgradeTimelock()` beside the approved pin. The watchdog pages each governed
upgrade or freeze once; it never pauses. An event is the deployment, and not
paged, only when its transaction created that proxy: the indexer compares the
receipt's `contractAddress` with the emitting proxy and marks the row
`"deployment": true`. A bare contract-creation transaction is not enough,
because the timelock's executor role is open and anyone can execute a ready
upgrade from a throwaway contract's constructor. Neither the deploy block nor
"the first indexed `Upgraded`" exempts a row, so a late-registered vault's
first upgrade and a freeze with no indexed `Upgraded` both page (issue 1840).
Rows indexed before this rule existed are marked by the startup backfill. Proxy
events at or below the watchdog's first-run baseline (the indexer cursor when a
watchdog first starts on the database; `-1`, so nothing, when one ran before)
are recorded as seen and never paged, so neither those rows nor the
backfilled history page in a burst; every later event pages (issue 1856,
`docs/operations/watchdog-liveness.md`). The dapp re-verifies the gateway proxy and implementation
at the latest block right before each write from AdminFlow and AgentsPanel,
through the connected wallet's provider on the connected chain, and before a
Safe proposal signature. A gateway, Timelock or Safe write is refused unless
the gateway is verified and still matches.

## Delivery sequence and acceptance gates

1. Inventory every stateful contract, constructor, immutable, storage layout,
   inheritance tree, external link, address dependency, and deploy stage. Decide
   which candidates are truly proxied. Keep current direct Base addresses in a
   legacy manifest; do not present them as upgraded.
2. Build upgradeable versions and per-instance proxies. Preserve external
   selectors and asset/share accounting. Verify initializer replay prevention,
   implementation lock, role handover, and one-way freeze. Make the deploy mode
   explicit in `publish-contracts` and the stage table; update frozen transaction
   counts and manifest schemas.
3. Add layout compatibility checks and fork tests for v1 → v2 state preservation:
   balances, allowances, roles, caps, policy state, weights, receipts, fees,
   adapter positions, and synchronous redemptions. Test unauthorized upgrades,
   direct implementation calls, uninitialized proxies, reinitializer misuse,
   freeze-at-deploy, delayed freeze, wrong freeze target, queued upgrades after
   freeze, reinitializer/role-based freeze bypasses, and post-freeze upgrade
   refusal. Test that an unchanged proxy code hash with an unapproved
   implementation refuses signing. Audit
   proxy-specific risks and run static checks on every proposed upgrade.
4. Rehearse a full deployment and upgrade through the real Safe/timelock on the
   Twin fork, then a freeze and a failed upgrade attempt. Require the same
   checks in the mainnet plan and post-deploy verifier. Update ABI consumers,
   indexer, dapp, and monitors to track proxy implementation and freeze state.
5. For already deployed direct contracts, plan new addresses and an explicit
   cutover. Existing share balances and permissions do **not** move merely by
   pointing a proxy at an implementation. Respect ADR-0009's no assisted
   migration rule: keep old vaults redeemable and let holders move voluntarily;
   update registry/router/gateway references only after cutover gates pass.

## Canonical-document change map

This plan is detailed design; the following documents carry policy or
operational authority. Their present-state claims must remain distinct from
the target design until code and on-chain evidence exist.

| Document | Required change | State after stage 1 (issue 1808) |
| --- | --- | --- |
| `docs/architecture.md` §4, §7.3, §8 | State target proxy/freeze lifecycle, Safe/timelock authority, and compatibility with one codebase; keep current direct deployments labeled as current. | Done: §4.1, §7.3 and §8 say what the source implements and what stays planned. |
| `docs/technical/security-model.md` §2, §4, §13 | Replace blanket proxy prohibition with restricted per-instance UUPS policy, upgrade threat model, freeze evidence, and release gates. | Done: §2 proxy, delegatecall and initializer rows; §4 upgrade-authority row; §13 release-gate row. |
| `docs/technical/smart-contracts.md` §2, §5 | Preserve historic direct-address facts; distinguish current state from target, then document actual proxy and implementation addresses after deployment. | Done for the source; the proxy and implementation addresses are added after a proxied deployment. |
| `docs/development/single-production-codebase.md` | Permit mode as initialized state of one artifact; prohibit an environment-specific implementation. | Done. |
| `docs/prd.md` §9 and `docs/technical/smart-contract-invariants.md` | The PRD now requires public upgrade/freeze disclosure; add executable invariants once the interface and implementation are settled. | Done: GOV-6 to GOV-11 with their tests; the PRD names the on-chain facts. User-facing disclosure done in stage 3 (issue 1810): explorer API, dapp, `rmpc get-gateway`, watchdog. |
| `docs/operations/contract-release-runbooks.md`, `docs/development/stage-deployment.md`, per-release runbooks | Add mode approval, storage/layout review, Safe/timelock execution, freeze proof, and existing-address cutover procedure before an upgradeable release. | Stage 2 done (issue 1809): runbook 4.12 covers the mode, the stage order, resume, the verify labels and record, freeze ownership, the deadline, missed-deadline alerts and the voluntary cutover plan. Stage 4 done (issue 1811): runbook 4.1 adds the external security review and the lifecycle rehearsal gates, 4.12 adds the Twin rehearsal, the steps after a governed upgrade and the rollback limits. The per-release runbook is now YAML (`docs/runbooks/contract-qa/template.yaml` plus an add-only release file; Deploy 3 is `releases/v0.5.0.yaml`, launching as an upgradeable proving period), checked by `scripts/runbook/validate-contract-qa.ts`. |
| `scripts/deploy/stage-table.json`, `publish-contracts/`, manifests, CI, client/indexer configuration | Implement and verify the selected mode; refresh frozen counts and address/config expectations. | Partly done: the stage table names each proxy stage's `SAFE_ADDRESS`, `TIMELOCK_MIN_DELAY`, `UPGRADE_MODE` and linked libraries; publish passes the sheet's `UPGRADE_MODE` (`upgradeable` or `frozen`, no default) and verifies the implementation behind each proxy; the manifests record the implementation, timelock and mode; CI gates the storage layouts. Client and indexer configuration done in stage 3 (issue 1810): `rmpc` `gateway_implementation` + `gateway_implementation_runtime_hash`, the dapp's `VITE_GATEWAY_EXPECTED_IMPLEMENTATION(_HASH)`, the indexer's proxy events. Stage 2 done (issue 1809): the sheet's `UPGRADE_MODE` and `UPGRADE_FREEZE_DEADLINE`, the stage table's `proxies` and `upgradeAuthority`, the verifier's per-proxy labels and `upgradeability.json`, the evidence section, and source verification of every implementation. No frozen counts exist yet for a proxied DEPLOY_SHA: the next Twin rehearsal measures them. |
| `docs/adr/` | Record the final pattern and its irreversibility in an accepted ADR once implementation choices are reviewed; do not rewrite prior ADRs. | ADR-0014 records the pattern. Accepted 2026-10-16. |

## References

- [OpenZeppelin proxy patterns and UUPS authorization](https://docs.openzeppelin.com/contracts/5.x/api/proxy)
- [OpenZeppelin rules for initializers and storage-safe upgrades](https://docs.openzeppelin.com/upgrades-plugins/writing-upgradeable)
- [OpenZeppelin upgrade validation tools](https://docs.openzeppelin.com/upgrades-plugins/api-core)
