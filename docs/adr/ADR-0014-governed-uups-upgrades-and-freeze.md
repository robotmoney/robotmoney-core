# ADR-0014: Governed per-instance UUPS proxies with a one-way, target-bound freeze for the core contracts

- **Status:** Proposed
- **Date:** 2026-10-15
- **Deciders:** Product owner (pending review)
- **Related:**
  - `docs/technical/contract-upgradeability-plan.md` — the policy this ADR implements (stage 1 of 4)
  - Issue 1808 (this stage: contracts and lifecycle tests); upgradeability stages 2 to 4 (publish-contracts,
    release sheet and evidence; signing clients, ABI consumers, dapp and indexer; Twin rehearsal and cutover)
  - `contracts/lib/GovernedUUPS.sol` — `GovernedUUPS` (the entry points) and the linked `GovernedUpgrade` library (the rules)
  - `contracts/script/UpgradeAuthority.sol` — the CREATE2 timelock address, the release mode, the proxy deploy
  - `contracts/script/DeployTimelock.s.sol` — deploys the timelock at that address and refuses a proxy naming any other authority
  - `scripts/ci/check-core-storage-layout.sh`, `contracts/test/fixtures/storage-layout/` — the layout gate
  - `contracts/test/GovernedUpgrade.t.sol`, `UpgradeAuthorityStages.t.sol`, `UpgradeLifecycleFork.t.sol`
  - `docs/adr/ADR-0009-vault-retirement-no-assisted-migration.md` — existing direct deployments are not migrated by this ADR
  - `docs/adr/ADR-0010-unified-vault-architecture.md` (Rejected) — the four vault kinds are preserved; nothing here revives it

## Context

Every Robot Money contract on Base 8453 today is a direct deployment. A logic fix needs new addresses and a
user-directed cutover. The upgradeability plan asks for governed upgrades on test, demo, rehearsal and contained
mainnet deployments, and for a final-mainnet choice between freezing at deployment and a bounded proving period
followed by a one-way freeze. The core contracts hold custody state, so a layout mistake can corrupt balances, and
a freeze removes recovery by upgrade.

Two constraints shaped the implementation:

1. **EIP-170.** The gateway had 6 bytes of runtime margin, the three basket vaults under 100, rmUSDC about 1,100.
   OpenZeppelin's `UUPSUpgradeable` inline costs about 2.5 KB per contract, and the upgradeable ERC-20 / ERC-4626
   bases (ERC-7201 namespaced storage) cost about 1 KB more on the vaults. Per-file `via_ir` was measured and
   rejected: Foundry compiles every test that imports a restricted file with the same profile.
2. **The timelock is the last deploy stage.** Every earlier stage runs as the deployer, so a naive proxy would name
   the deployer (or a placeholder) as its upgrade authority until the handover.

## Decision

### 1. Proxy inclusion

| Contract | Decision | Reason |
| --- | --- | --- |
| `RobotMoneyVault` (rmUSDC) | Proxied | Stateful, user-facing custody (shares, adapter registry, caps, fees) |
| `ProtocolAssetVault`, `AgentTokenVault`, `RwaBasketVault` | Proxied, one proxy each | Same, through `BasketVault`; the four vault kinds stay as they are |
| `VaultRegistry` | Proxied | Vault lifecycle and router eligibility state |
| `PortfolioRouter` | Proxied | Weights, caps, rotation state; holds USDC transiently |
| `RobotMoneyGateway` | Proxied | Agent policies, windows, replay ids; the agent trust boundary |
| `InvestmentCommitteePolicy`, `ConsensusRecommendationReceipt` | Proxied | Committee agents, votes and the receipt log |
| `RouterGovernance` | Proxied | Roles today, and the ordering state issue 1831 adds to `applyReceipt` |
| Strategy and swap adapters | Direct | Address and runtime-code-hash allowlists and the no-proxy scan stay mandatory |
| `UniswapV4PriceRecorder` | Direct | Permissionless, admin-free; a new recorder is a new address |
| Linked libraries (`TickMath`, `TwapTickMath`, `BasketAssetConfigGuard`, `BasketViews`, and the four below) | Direct, CREATE2 | Fixed addresses in the implementation bytecode, pinned by the layout gate |
| `TimelockController`, Safe | Direct | The upgrade authority itself; the Safe keeps its canonical SafeProxy 1.4.1 topology |
| `FeatureFlags` | Not deployed | A constants library |

There is no beacon: one upgrade never changes more than one proxy.

### 2. Mechanism

- Each proxied contract replaces its constructor with `initialize(...)` (the same arguments, plus
  `upgradeTimelock_` and `upgradeMode_`) on OpenZeppelin's upgradeable bases, pinned at v5.0.2, the transpile of
  the pinned `openzeppelin-contracts` commit. Every parent initializer is called once. Constructor immutables
  (`usdc`, `registry`, `router`, `gateway`, `SWAP_ROUTER`, ...) moved to storage with the same public getters.
  Constants stay constants.
- The deploy scripts create `new ERC1967Proxy(implementation, initialize(...))`, so a proxy is never observable
  uninitialized. Every implementation's constructor calls `_disableInitializers()`.
- `GovernedUUPS` exposes `upgradeToAndCall`, `freezeUpgrades`, `upgradeTimelock`, `upgradesFrozen` and
  `proxiableUUID`. The first two forward their exact calldata, through an `onlyProxy` check, to the linked
  `GovernedUpgrade` library, which holds the rules once for all ten contracts. Its storage is the ERC-7201
  namespace `robotmoney.storage.GovernedUUPS`: `{ address upgradeTimelock; bool upgradesFrozen; }`.
- To fit EIP-170, code that did not need to be inline moved unchanged into linked libraries:
  `GatewayWindows` (the gateway rolling-window ring buffer), `RobotMoneyVaultOps` (rmUSDC's emergency drains,
  the `adminRebalance` pull and the adapter views) and `BasketSwaps` (the basket swap executor, both emergency
  unwinds and `reabsorbRemovedAsset`); `BasketAssetConfigGuard.addAsset` took the rest of `BasketVault.addAsset`.
  Every external selector, event and error is unchanged.

### 3. Authority

- The only account that can upgrade or freeze a proxy is its `upgradeTimelock()`, the Safe-controlled
  `TimelockController` (proposer and canceller: the Safe; executor: anyone; no admin). It is written once at
  initialization, is not an AccessControl role, and has no setter. No role grant, revoke or renounce, and no
  reinitializer (`GovernedUpgrade.init` runs once per proxy), can move it. The deployer, `EMERGENCY_ROLE`,
  `ADMIN_ROLE`, `DEFAULT_ADMIN_ROLE`, the deposit pauser, RouterGovernance and the Safe itself hold no upgrade
  power.
- **Timelock-last stage order without interim authority.** The timelock stays the last stage. Every proxy names,
  from its first block, the CREATE2 address (canonical factory, salt `keccak256("robotmoney.core.timelock.v1")`) of
  the exact timelock the timelock stage deploys for `SAFE_ADDRESS` and `TIMELOCK_MIN_DELAY`. CREATE2 binds the init
  code, so nothing but that Safe-proposer timelock can ever have code there: until the stage runs, nobody can
  upgrade or freeze. The timelock stage deploys it there (reusing it if anyone deployed the identical timelock
  first), checks its roles and delay, and refuses the handover before any role moves unless every core proxy names
  it.

### 4. Freeze and release modes

- `freezeUpgrades(expectedImplementation, expectedCodeHash)` reverts unless the live implementation and its runtime
  code hash both match, so a freeze queued for one version cannot lock in another that an intervening upgrade
  installed. It sets the one-way flag (nothing ever writes it back), disables every later initializer and
  reinitializer, and emits `UpgradesFrozen(proxy, implementation, codeHash)`. A frozen proxy refuses every new and
  previously queued upgrade. Freezing never pauses or alters withdrawals.
- The release mode is a required initializer argument with no default: `Undeclared` (the zero value) reverts.
  `FrozenAtDeploy` sets the flag inside the atomic initialization (with the event); `Upgradeable` leaves the
  timelock path open for a test, demo, rehearsal, contained mainnet test or a final-mainnet proving period, closed
  later by a delayed freeze. The stage scripts read `UPGRADE_MODE` (`upgradeable` or `frozen`), required, no default.
  Until the release sheet carries the mode (stage 2), `publish-contracts` passes `frozen`, so no deployment comes up
  upgradeable by default.

### 5. Layout safety

`scripts/ci/check-core-storage-layout.sh` (forge job) pins, per proxied contract, the sequential layout, every stored
struct's members, the linked libraries and the ERC-7201 namespaces of the inheritance chain, plus the commits of both
OpenZeppelin submodules, and fails on any difference until the snapshot is rewritten and reviewed. Its self-test
proves it fails on a moved, retyped, added or reordered entry, a changed library link and a reordered namespace.

## Consequences

- One implementation artifact serves every environment; the environment differs only by initialized state.
- A proxy adds one DELEGATECALL per call (about 2.6 k gas cold) and the linked libraries one more on the moved
  paths. The gas floors are checked inside the implementation, so a caller needs floor / 63 more gas at the proxy
  entry; estimates already include it.
- The code at a core address is now the generic `ERC1967Proxy`. The publish verifier checks the implementation the
  slot names (stage 1); signing clients that pin the gateway runtime hash must also check the implementation
  before they authorize a write (stage 3). The manifests record each implementation, the upgrade timelock and the
  mode.
- Before a freeze, governance can still install broken or malicious logic: the timelock gives inspection time, not
  safety. Every upgrade needs the layout gate, implementation and linked-library review, calldata review and a fork
  rehearsal. After a freeze, only a new deployment and a user-directed migration (ADR-0009) can change logic.
- The live 8453 direct deployments are unchanged and cannot be upgraded in place. Moving to proxies is a new
  deployment and a cutover (stage 4).
- The proxy form and the four new libraries are not covered by the existing audit reports (`docs/audits.md`).

## Implemented here vs planned

| Item | State |
| --- | --- |
| Proxied core contracts, `GovernedUUPS` / `GovernedUpgrade`, linked libraries | Implemented (issue 1808) |
| Deploy scripts deploy initialized proxies; CREATE2 timelock; handover refuses a foreign authority | Implemented (issue 1808) |
| Layout gate in CI; lifecycle tests (unit, Safe + timelock, Twin fork) | Implemented (issue 1808) |
| Publish verifier checks the implementation behind each proxy | Implemented (issue 1808) |
| Release sheet declares every proxy's mode, implementation, layout id, deadline; publish refuses an undeclared mode; manifests and frozen counts | Planned (stage 2) |
| Signing clients, ABI consumers, dapp and indexer track implementation and freeze state | Planned (stage 3) |
| Twin rehearsal of upgrade and freeze; cutover from the direct deployments | Planned (stage 4) |

## Alternatives considered

- **Transparent proxy / ProxyAdmin.** Keeps the upgrade code out of the implementation, but the plan names UUPS,
  and the freeze would have to live in a custom ProxyAdmin outside the reviewed contracts.
- **A shared beacon.** One upgrade would change every vault at once; rejected by the plan.
- **OpenZeppelin `UUPSUpgradeable` inline.** About 2.5 KB per contract; it does not fit the gateway or the basket
  vaults without moving far more custody code out. The linked `GovernedUpgrade` keeps the rules in one place.
- **Per-file `via_ir`.** Fits the gateway, but Foundry compiles every importing test with the same profile and the
  coverage job's memory guard exists because of via-IR (issue 1298).
- **Moving the timelock stage first.** Equivalent safety, but it splits the timelock stage and reorders every runner;
  the CREATE2 prediction keeps the stage order and still leaves no interim authority.
