# Contract upgradeability policy and implementation plan

**Status:** policy and design plan, 2026-10-13. ADR-0014 turns it into one
pattern, and QA plan P1 to P4 implemented that pattern on qa/test-merge-v1
(the ADR's implementation records). Where this plan and ADR-0014 differ, the
ADR wins. Existing Base mainnet contracts remain direct deployments and cannot
be upgraded in place.

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

Candidates for per-instance proxies are `RobotMoneyVault`, the three concrete
`BasketVault` subclasses, `VaultRegistry`, `PortfolioRouter`,
`RobotMoneyGateway`, `RouterGovernance`, `InvestmentCommitteePolicy`, and
`ConsensusRecommendationReceipt`. Inventory each deployment stage before
implementation; make the decision per contract and record exclusions in the
release manifest. ADR-0014 §1 pins nine of them and §2 keeps `RouterGovernance`
direct: after #1698 it holds a role set and one receipt pointer, and a fix is a
timelock rotation of `WEIGHT_SETTER_ROLE`. The strategy and swap adapters, linked libraries,
`UniswapV4PriceRecorder`, and `TimelockController` remain direct
deployments in this plan. Safe retains its existing canonical SafeProxy 1.4.1
and verified SafeL2 singleton topology; it is not converted to a Robot Money
UUPS proxy. Adapter address and runtime-codehash checks and the
no-proxy scan remain mandatory. An adapter upgrade means deploying a new
adapter and approving its address/hash through the existing governance path.

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

The stage table used to deploy the timelock last. Before proxy deployment,
either move the timelock/Safe setup ahead of every proxy stage or use a
deterministically precomputed timelock address whose code and Safe ownership
are verified before opening deposits. The deployment plan must prove the
authority exists and cannot leave an interim deployer-controlled upgrade path.
P2 chose the first option: the `authority` stage
(`DeployUpgradeAuthority.s.sol`) deploys the timelock before the first proxy,
and the handover stage reuses it (ADR-0014 "Implementation record (P2)").

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
unknown implementation or failed read must refuse signing. The
`clients/rust-payment-client/src/policy/mod.rs` gateway runtime-code hash check
alone cannot detect a proxy implementation change, so QA plan P3 added check 2b:
rmpc reads the implementation slot and its code at one block and refuses
(`ErrImplementationNotApproved`) unless the code hash is in the config's
`gateway_implementation_hashes` (ADR-0014 "Implementation record (P3)"). Every
gateway write runs it (the committee and receipt writes included), and the
vaults and the router a write reaches are checked the same way against
`proxy_implementation_hashes`. The dapp checks the gateway's implementation
against its build-time pin `VITE_GATEWAY_EXPECTED_IMPLEMENTATION_HASH`. State reads should use a
consistent block; pre-sign verification does not prevent an upgrade before
transaction execution. The handling of queued user transactions and signed
gateway authorizations across upgrades is decided in ADR-0014 §10 and its
"Implementation record (P3)": an `AgentConsent` is bound to
`RobotMoneyGateway.implementationVersion()` (the EIP-712 domain version), an
implementation that changes what a consent means bumps it and so voids every
older consent, a pure fix keeps it, and a transaction already in flight runs
against whatever implementation is live when it lands. The public timelock
delay is the warning; rmpc and the dapp do not scan the queue. The release
runbook records the version decision for every gateway upgrade
(`docs/operations/contract-release-runbooks.md` §4.12). The indexer must track implementation
changes and freeze events without treating its cache as signing authority. Public contract
metadata should show whether upgrades remain possible.

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
   The rehearsal is the nightly job `twin-upgrade-rehearsal`
   (`publish-contracts/src/ci/twin-upgrade-rehearsal.ts`, checked by
   `evidence-check --proxy-lifecycle`; ADR-0014 "Implementation record (P4)").
   A final mainnet release needs it green at the release SHA and an external
   security review (`docs/operations/contract-release-runbooks.md` §4.1).
5. For already deployed direct contracts, plan new addresses and an explicit
   cutover. Existing share balances and permissions do **not** move merely by
   pointing a proxy at an implementation. Respect ADR-0009's no assisted
   migration rule: keep old vaults redeemable and let holders move voluntarily;
   update registry/router/gateway references only after cutover gates pass.

## Canonical-document change map

This plan is detailed design; the following documents carry policy or
operational authority. Their present-state claims must remain distinct from
the target design until code and on-chain evidence exist.

| Document | Required change |
| --- | --- |
| `docs/architecture.md` §4, §7.3, §8 | State target proxy/freeze lifecycle, Safe/timelock authority, and compatibility with one codebase; keep current direct deployments labeled as current. |
| `docs/technical/security-model.md` §2, §4, §13 | Replace blanket proxy prohibition with restricted per-instance UUPS policy, upgrade threat model, freeze evidence, and release gates. |
| `docs/technical/smart-contracts.md` §2, §5 | Preserve historic direct-address facts; distinguish current state from target, then document actual proxy and implementation addresses after deployment. |
| `docs/development/single-production-codebase.md` | Permit mode as initialized state of one artifact; prohibit an environment-specific implementation. |
| `docs/prd.md` §9 and `docs/technical/smart-contract-invariants.md` | The PRD now requires public upgrade/freeze disclosure; add executable invariants once the interface and implementation are settled. |
| `docs/operations/contract-release-runbooks.md`, `docs/development/stage-deployment.md`, per-release runbooks | Add mode approval, storage/layout review, Safe/timelock execution, freeze proof, and existing-address cutover procedure before an upgradeable release. |
| `scripts/deploy/stage-table.json`, `publish-contracts/`, manifests, CI, client/indexer configuration | Implement and verify the selected mode; refresh frozen counts and address/config expectations. |
| `docs/adr/` | Record the final pattern and its irreversibility in an accepted ADR once implementation choices are reviewed; do not rewrite prior ADRs. Written as [ADR-0014](../adr/ADR-0014-governed-upgrades-and-freeze.md) (Proposed, pending owner acceptance): it pins the proxied list, the layout gate, the constant ceilings, the freeze rules and the EIP-170 budget. |

## References

- [OpenZeppelin proxy patterns and UUPS authorization](https://docs.openzeppelin.com/contracts/5.x/api/proxy)
- [OpenZeppelin rules for initializers and storage-safe upgrades](https://docs.openzeppelin.com/upgrades-plugins/writing-upgradeable)
- [OpenZeppelin upgrade validation tools](https://docs.openzeppelin.com/upgrades-plugins/api-core)
