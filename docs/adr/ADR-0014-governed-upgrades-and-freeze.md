# ADR-0014: Governed UUPS upgrades and a permanent freeze for the stateful core contracts

- **Status:** Proposed — implemented on qa/test-merge-v1 on the QA plan v1 defaults (Decisions D4), pending owner acceptance
- **Date:** 2026-10-15
- **Deciders:** Product owner (acceptance pending)
- **Related:**
  - `docs/technical/contract-upgradeability-plan.md` — the policy this ADR
    turns into one pattern. Its document map (line 170) asks for this ADR.
  - `docs/development/qa-plan-v1.md` — workstream P (P0 is this ADR; P1 to P4
    implement it) and Decisions D4 ("P0 list; ADR first") and D5 ("bind").
  - Issues #1808 (contracts), #1809 (tooling), #1810 (clients), #1811 (Twin
    rehearsal).
  - `docs/technical/security-model.md` §2, §4, §8 and §13 — proxy, access
    control, dependency and deployment rules this ADR must satisfy.
  - `docs/adr/ADR-0009-vault-retirement-no-assisted-migration.md` — current
    direct vaults move to proxies only by voluntary holder migration.
  - `docs/adr/ADR-0010-unified-vault-architecture.md` — Rejected. The four
    vault kinds stay. This ADR does not revive the unified vault.
  - `contracts/ProposerFloorTimelock.sol` — the only upgrade authority.
  - `contracts/test/VaultCodeSizeGuard.t.sol` and
    `scripts/ci/check-storage-layout.sh` — the size gate and the layout gate.
    The layout gate replaced the gateway-only gate of issue 1476.

## Context

Every Robot Money contract on Base today is a direct deployment. A logic fix
needs a new address and a holder migration. The upgradeability plan asks for
independent ERC-1967/UUPS proxies over the stateful core, with the Safe-run
timelock as the only upgrade authority and a one-way freeze for a final
release. It leaves four choices to an ADR: the exact proxy list, the
storage-layout tool, how the fixed ceilings survive, and how a freeze relates
to withdrawals. Decisions D4 says the ADR comes before any code.

Three facts from the current tree shape the design.

**1. Five of the nine candidates have almost no EIP-170 room.** Measured with
`forge build --sizes` on qa/test-merge-v1 at 2b5d9c4a (solc 0.8.24, 100
optimizer runs, cancun):

| Contract | Runtime (B) | Margin under 24,576 B |
| --- | ---: | ---: |
| RobotMoneyVault | 24,410 | 166 |
| RobotMoneyGateway | 24,343 | 233 |
| AgentTokenVault | 24,308 | 268 |
| ProtocolAssetVault | 24,266 | 310 |
| RwaBasketVault | 24,266 | 310 |
| PortfolioRouter | 16,041 | 8,535 |
| VaultRegistry | 6,912 | 17,664 |
| InvestmentCommitteePolicy | 6,566 | 18,010 |
| ConsensusRecommendationReceipt | 5,552 | 19,024 |

RobotMoneyVault had 1,127 B of margin when QA plan D3 was designed. The
workstream D changes that landed since spent all but 166 B of it. A probe compiled with the same settings
measured the upgrade machinery: OZ 5.0.2 `UUPSUpgradeable` alone costs about
1,580 B of runtime. The full governed base below (authority, mode, freeze,
getters, errors, event, initializer) costs about 2,630 B. A UUPS proxy also
moves constructor code into runtime, because `initialize` is an ordinary
function. The ERC1967Proxy itself is 163 B of runtime.

**2. RobotMoneyVault creates its ExclusionLedger in the constructor.** D3 did
this on purpose: `new ExclusionLedger(asset)` in a constructor is initcode,
not runtime. In an initializer the same line would embed the ledger's 5,889 B
of creation code in the vault's runtime.

**3. A basket struct is declared twice.** `BasketVault.AssetInfo` and
`BasketAssetConfigGuard.AssetInfo` are "layout-identical" copies.
`BasketVault._guardAssets()` casts one storage pointer to the other in
assembly so the linked library can write the vault's `assets` array. Nothing
checks that the copies stay identical. Behind a proxy, a drift between them
corrupts live state on the next upgrade.

## Decision

### 1. The proxied contracts (pinned list)

These nine contracts run behind their own ERC-1967 proxy. One proxy per
deployed instance. No beacon, no shared upgrade.

| Contract | Why it is proxied | Constructor immutables that move to write-once storage |
| --- | --- | --- |
| `RobotMoneyVault` (rmUSDC) | Holds user funds, shares, adapter registry and exclusion records. | `exclusionLedger` |
| `ProtocolAssetVault` (rmPROTO) | Holds user funds and a basket. | `SWAP_ROUTER`, `_USDC` (from `BasketVault`) |
| `AgentTokenVault` (rmAGENT) | Same. | Same. |
| `RwaBasketVault` (rmRWA) | Same. | Same. |
| `PortfolioRouter` | Holds weights, caps and roles every routed deposit reads. | `usdc`, `registry` |
| `VaultRegistry` | Holds vault status and eligibility. | none |
| `RobotMoneyGateway` | Holds agent policies, ownership, windows and commitments. | `usdcToken`, `vaultContract`, `routerContract` |
| `InvestmentCommitteePolicy` | Holds the committee roster and policy. | `gateway` |
| `ConsensusRecommendationReceipt` | Holds recorded receipts and their release state. | `gateway`, `icPolicy` |

The four vault kinds stay four kinds (ADR-0010 stays Rejected). The abstract
`BasketVault` carries the upgrade base once for its three concrete kinds.

### 2. What stays a direct deployment

| Contract | Why it is not proxied |
| --- | --- |
| `RouterGovernance` | After #1698 it holds a role set and one receipt pointer. It holds no funds. A fix is a new deployment plus a timelock rotation of `WEIGHT_SETTER_ROLE` on the router and `ADMIN_ROLE` on the receipt contract. A proxy here would add a second upgrade surface over weights for no gain. |
| `ExclusionLedger` | One per vault, bound to its vault, holds recovered USDC owed to snapshot holders. A logic fix is a vault upgrade that opens new records in a new ledger. Old records keep paying from the old ledger. |
| `ExclusionLedgerFactory` (new, see §9) | Stateless. Deployed once per chain by CREATE2. |
| Strategy adapters (Aave V3, Compound V3, Morpho) and swap adapters (Uniswap V3, Aerodrome, Uniswap V4) | The plan keeps them immutable and replaceable. The vault's address and runtime-codehash allowlist and the deploy-time no-`DELEGATECALL` scan (`AdapterBytecodeGuard.requireNoDelegatecall`) stay mandatory. An adapter "upgrade" is a new adapter approved through the timelock. |
| `UniswapV4PriceRecorder` | Permissionless recorder. Same rule as adapters. |
| Linked libraries (`TickMath`, `TwapTickMath`, `BasketViews`, `BasketAssetConfigGuard`, and the libraries §9 adds) | Fixed code at fixed addresses. A library change is a new library address and therefore a new implementation. |
| `ProposerFloorTimelock` | It is the upgrade authority. It must never be upgradeable itself. |
| Safe | Keeps the canonical SafeProxy 1.4.1 and SafeL2 singleton. Not a Robot Money proxy. |

### 3. Mechanism

- **Proxy:** OpenZeppelin `ERC1967Proxy` from the pinned
  `lib/openzeppelin-contracts` (5.0.2). Every proxy has the same runtime code,
  so clients pin one proxy codehash. The ERC-1967 admin and beacon slots stay
  zero. The P2 verifier refuses a proxy where either is non-zero.
- **Upgrade logic:** OZ `UUPSUpgradeable` and `Initializable`, used as shipped.
  No extra OZ modules: no `AccessManager`, no `PausableUpgradeable`, no
  `MulticallUpgradeable`, no `EIP712Upgradeable`, no `ERC20PermitUpgradeable`.
- **Upgradeable parents:** a new submodule `lib/openzeppelin-contracts-upgradeable`
  pinned to the v5.0.2 tag, the same release as `lib/openzeppelin-contracts`.
  `ERC20Upgradeable`, `ERC4626Upgradeable`, `AccessControlUpgradeable` and
  `ReentrancyGuardUpgradeable` replace their constructor-based twins. They keep
  their state in ERC-7201 namespaced slots. `UUPSUpgradeable` and
  `Initializable` also come from that package, so every parent shares one
  `Initializable`.
- **Robot Money state stays in the ordinary linear layout.** Every variable a
  Robot Money contract declares keeps a numbered slot. `forge inspect … storageLayout`
  reports all of it, so the layout gate (§8) sees all of it.
- **One shared base, `contracts/lib/GovernedUpgrade.sol`:**
  `abstract contract GovernedUpgrade is Initializable, UUPSUpgradeable`. Every
  proxied implementation inherits it. Its whole surface:
  - storage: `struct GovernedUpgradeStorage { address authority; bool frozen; }`
    in the ERC-7201 namespace `robotmoney.storage.GovernedUpgrade`, slot
    `0x5f8c19f69998101f56563e0013e2ccd167eee33eac647374045191b3bd187600`.
    The two fields share one slot.
  - `enum UpgradeMode { Unset, Upgradeable, FrozenAtDeploy }`.
  - `__GovernedUpgrade_init(address authority, UpgradeMode mode)`: reverts
    `UpgradeModeUnset()` on `Unset` and `UpgradeAuthorityNotContract(authority)`
    when `authority` has no code. It stores the authority. On `FrozenAtDeploy`
    it freezes before the initializer returns.
  - `upgradeAuthority() returns (address)` and `upgradesFrozen() returns (bool)`.
  - `freezeUpgrades(address expectedImplementation, bytes32 expectedCodeHash)`
    (`onlyProxy`): authority only. Reverts `FreezeTargetMismatch(live, liveCodeHash)`
    unless the live ERC-1967 implementation and its code hash equal the
    arguments.
  - `_authorizeUpgrade`: reverts `UpgradeNotAuthorized(caller)` unless the
    caller is the authority. Reverts `UpgradesAreFrozen()` when frozen.
  - `event UpgradesFrozen(address indexed proxy, address indexed implementation, bytes32 codeHash)`.
    OZ's own `Upgraded(address indexed implementation)` marks each upgrade.
- **Initialization is atomic.** The proxy constructor calls `initialize` in
  the deployment transaction. No public call can reach an uninitialized proxy.
  Each implementation's constructor calls `_disableInitializers()`. Each parent
  initializer runs exactly once. Every former constructor argument becomes an
  initializer argument. Each initializer takes `authority` and `mode` as well.
- **Former immutables become write-once storage.** Each one in the §1 table
  keeps its public getter name and type, so the ABI does not change. The
  initializer writes it once. No setter exists.
- **Reinitializers** (`reinitializer(n)`) run only as the `data` of an
  `upgradeToAndCall`, so only through the timelock. Every reinitializer
  carries `onlyUpgradeAuthority` next to `reinitializer(n)`: inside a
  timelock-executed `upgradeToAndCall` the caller is the timelock, so it runs.
  An upgrade installed with empty data leaves it pending, and then only a
  later timelock operation can run it, never a stranger. The layout gate (§8)
  fails a production `reinitializer(` without it. No initializer or
  reinitializer writes the `GovernedUpgrade` namespace except
  `__GovernedUpgrade_init`, which runs once per proxy: it reverts
  `InvalidInitialization` once an authority is stored, so a reinitializer
  that calls it cannot rotate the authority (UPG-3).
- **Every implementation keeps the base.** An implementation without
  `GovernedUpgrade` would silently end upgrades with no target-bound freeze
  and no `UpgradesFrozen` event. The layout gate (§8) fails when
  `GovernedUpgrade` leaves a proxied contract's inheritance list. OZ's
  `proxiableUUID` check refuses an upgrade to a non-UUPS implementation.
- **Nothing else writes the implementation slot.** `GovernedUpgrade` is the
  only production source under `contracts/` (outside `contracts/test/` and
  `contracts/script/`) that imports `ERC1967Utils`. Implementations
  `DELEGATECALL` only their linked libraries, never a caller-chosen target.

### 4. Upgrade authority: the timelock, and only the timelock

- The authority is one fixed address: the deployment's `ProposerFloorTimelock`.
  The initializer stores it and refuses an address with no code. There is no
  setter. No role confers upgrade power. Holding `ADMIN_ROLE`,
  `DEFAULT_ADMIN_ROLE`, `EMERGENCY_ROLE`, `KEEPER_ROLE`, `WEIGHT_SETTER_ROLE`
  or any other role grants none. `RouterGovernance`, the deployer and every EOA
  hold none.
- Role changes do not touch upgrade authority. Moving `ADMIN_ROLE` away from
  the timelock would not move the authority.
- **The path is the existing governance path.** The Safe (`PROPOSER_ROLE`,
  threshold ≥ 2) schedules `upgradeToAndCall` or `freezeUpgrades` on the
  timelock. The delay runs (at least `TIMELOCK_MIN_DELAY`; 48 hours or more on
  8453). Then anyone executes it, because `EXECUTOR_ROLE` is open
  (`address(0)`). The Safe (`CANCELLER_ROLE`) may cancel it during the delay.
- **The timelock is deployed before every proxy.** The current stage table
  deploys and hands over the timelock last. P2 splits that stage: the timelock
  is deployed (Safe as proposer and canceller, no admin) before the first
  proxy, and the role handover stays the last stage. Every proxy is born with
  the timelock as its authority. No interim deployer-held upgrade path exists
  at any point. The deployer still holds business roles until the handover, as
  today, and those roles never include upgrade power.
- The timelock address never needs to change. Its proposer set rotates
  inside the timelock (through the delay, never below one proposer, QA plan B3).

### 5. Freeze: permanent, per proxy, bound to a reviewed implementation

- `freezeUpgrades` sets one bit. Nothing unsets it. No function, initializer,
  reinitializer or role change can clear it. Once it is set,
  `_authorizeUpgrade` always reverts, so no later code can ever be installed
  that could clear it.
- The freeze names its target. A freeze scheduled for implementation A
  reverts if an upgrade to B executed first. A queued freeze can never lock in
  a version nobody reviewed.
- An upgrade already scheduled before the freeze reverts with
  `UpgradesAreFrozen()` when someone executes it later. The release runbook
  reviews pending timelock operations before a freeze and cancels any upgrade
  still queued.
- **Release modes** are initialized state of one artifact, never a build
  variant:

| `UpgradeMode` | Used for | Allowed later |
| --- | --- | --- |
| `Upgradeable` | Twin, demo, rehearsal, contained mainnet test, and a final mainnet release with a production proving period | Upgrades and one freeze, each Safe → timelock |
| `FrozenAtDeploy` | Final mainnet release fixed at launch | Nothing. The proxy is frozen inside its deployment transaction. |
| `Unset` | Nothing | The initializer reverts. A deployment must state its mode. |

- A proving-period deadline is an operational commitment, not an on-chain
  timer. The P2 runbook names the Safe signers who schedule the freeze and
  alerts on a missed deadline. The deployment stays reported as upgradeable
  until `upgradesFrozen()` reads true on chain.
- Freeze is per proxy. A release may call its core logic immutable only when
  all nine proxies of that deployment read frozen. Governed parameters,
  adapter choice and upstream contracts (USDC, Aave, Compound, Morpho, the
  DEX venues) stay mutable by their own authorities after a freeze. The P2
  verifier lists them.

### 6. Withdrawal rights are never touched by a freeze or by the upgrade machinery

This carries forward the standing rule that withdrawals are never frozen, by
anyone (owner decision 2026-10-05, core 1494).

- A freeze never pauses or alters withdrawal rights. `freezeUpgrades` writes
  only the frozen bit and emits one event. No business function reads that
  bit. `redeem`, `withdraw`, `BasketVault.redeemInKind`,
  `PortfolioRouter.redeemFor` and the gateway withdraw paths have no
  freeze-dependent branch.
- `GovernedUpgrade` adds no pause, no `whenNotFrozen` or `whenFrozen`
  modifier, and no hook on transfers or redemptions.
- An upgrade is atomic. `upgradeToAndCall` swaps the implementation and runs
  any reinitializer in one transaction, so there is no in-between state that
  could block a redeem.
- Policy for every future implementation: it may not remove, gate or narrow
  `redeem`, `withdraw` or `redeemInKind`, and it may not lower `maxRedeem` or
  `maxWithdraw` through any pause, status or role. P1 runs the existing
  `contracts/test/WithdrawalsNeverFrozen.t.sol` levers against the proxies,
  before and after an upgrade and after a freeze.
- The timelock delay is the holder's protection against a bad upgrade. The
  upgrade target is public in the timelock's `CallScheduled` event for the
  whole delay. Withdrawals stay open the whole time. `redeemInKind` stays the
  oracle-free exit for basket holders.

### 7. Fixed ceilings stay constants in the implementation

The ceilings are `constant`s in implementation bytecode. They are never moved
to storage, never taken as initializer arguments and never given a setter.
They cost no storage and no role can change them.

| Contract | Ceilings that stay constants |
| --- | --- |
| `RobotMoneyVault` | `MAX_EXIT_FEE_BPS` (100), `MAX_ADAPTERS` (20), `MAX_REBALANCE_BPS_CEILING` (5000), `MIN_REBALANCE_INTERVAL_FLOOR` (1 hour), and the gas floors |
| `BasketVault` (all three kinds) | `MAX_EXIT_FEE_BPS` (100), `MAX_SLIPPAGE_BPS` (500), `MIN_TWAP_WINDOW` (600 s), `MAX_TWAP_WINDOW` (86,400 s), `MAX_NAV_DEVIATION_BPS` (2,000), `MIN_POOL_LIQUIDITY` (1e6), and each kind's `_MAX_ASSETS` |
| `RobotMoneyGateway` | `MAX_DEADLINE_SKEW` (600 s), `MAX_WINDOW_ENTRIES`, and the gas floors |

- The initializer checks every initial value against the same constants the
  setters use. `MAX_EXIT_FEE_BPS` bounds the initial fee exactly as it bounds
  `setExitFeeBps`.
- **What "immutable" now means.** With a proxy, a new implementation could
  carry a different constant. So the guarantee in `docs/technical/security-model.md` §4
  ("`MAX_EXIT_FEE_BPS` must be `immutable`") becomes:
  - no role, setter or initializer can change a ceiling;
  - an upgrade may keep or tighten a ceiling and may never loosen one;
  - every upgrade sits in public view for the full timelock delay, with
    withdrawals open;
  - after a freeze, the ceiling is fixed forever.
- **Enforcement in CI:** P1 adds `contracts/test/UpgradeCeilings.t.sol`.
  `test_ceilingsNeverLoosened` pins each value in the table and fails when the
  source loosens one. It reads the public constants directly. It reads the
  internal ones (`MAX_NAV_DEVIATION_BPS`, `_MAX_ASSETS`, the gas floors)
  through a test-only harness under `contracts/test/`. Raising a ceiling needs
  a new ADR, not a test edit.
- No on-chain ceiling check runs at upgrade time. A new implementation could
  report one value from a getter and use another inside. The check would cost
  bytecode and would prove nothing.

### 8. The storage-layout tool and its CI job

P1 generalizes `scripts/ci/check-gateway-storage-layout.sh` into
`scripts/ci/check-storage-layout.sh`. The gateway-only script is folded into
it.

- **Inputs, per proxied contract, after `forge build`:**
  - `forge inspect <C> storageLayout --json`: label, slot, offset and type of
    every state variable and every storage-struct member. AST ids are stripped
    as the gateway script does today. Type labels keep their defining contract,
    so `struct BasketAssetConfigGuard.AssetInfo` and `struct BasketVault.AssetInfo`
    are different types to the gate.
  - `forge inspect <C> linearization --json`: the ordered inheritance list.
  - `forge inspect <C> libraries --json`, plus the keccak256 of each linked
    library's `deployedBytecode` from `out/`.
  - The commits of `lib/openzeppelin-contracts` and
    `lib/openzeppelin-contracts-upgradeable` from `git ls-tree HEAD lib/`. The
    OZ parents' namespaced layout is fixed by those commits.
- **Snapshots:** one normalized file per contract in
  `contracts/test/fixtures/storage-layout/<Contract>.json`, next to today's
  gateway snapshot. A snapshot is exactly the layout of the code in the same
  tree. `--write` rewrites it in the change that appends to the layout, and the
  same-tree compare fails a snapshot that differs from the code in any way, an
  append included (security round 3). P2 records the sha256 of the normalized
  snapshot in the manifest as the proxy's storage-layout identifier, and the
  upgrade-proxy row passes equal identifiers with no compare. An append that
  skipped `--write` would keep the old identifier on a build that holds the new
  variable, and a later insert before it would pass every compare. The release
  tags hold the layouts releases put live (`--release-anchor` below).
- **Rules, all of which fail the job:**
  - an existing variable moves, changes type or offset, or disappears;
  - a new variable sits anywhere but after the last existing one;
  - any storage struct changes at all (a new field needs a new struct in a new
    mapping);
  - a storage enum's existing members change in any way: insert, remove,
    reorder or rename. A stored enum is its member's index, so members may only
    be appended. `forge inspect` gives an enum type no member list, so the
    snapshot records each storage enum's members from its definition in the
    contract's compiled sources;
  - the newer record stores a struct or an enum (in a variable, a mapping, an
    array or a struct member) whose members it does not record. The struct and
    enum rules skip what the newer record leaves out, so a snapshot with a
    struct and its enum deleted by hand would hide a change to either;
  - in the same-tree compare only, the committed snapshot differs from the
    code's layout record at all;
  - the linearization list differs in any way, including order;
  - `GovernedUpgrade` is missing from a proxied contract's linearization;
  - a production function uses `reinitializer(n)` without `onlyUpgradeAuthority` (§3);
  - a linked library is added, removed, or has different code;
  - an OZ submodule commit differs;
  - a contract under `contracts/` (outside `contracts/test/` and
    `contracts/script/`) inherits `GovernedUpgrade` but is missing from
    `contracts/test/fixtures/storage-layout/proxied.txt`, or a listed name does
    not inherit it, or a listed name is missing from this ADR's §1 table.
- **Library links in detail.** A struct passed by `storage` to a linked
  library is declared once, and the vault and the library both use that one
  declaration. P1 deletes the `BasketVault.AssetInfo` copy and the assembly
  cast in `BasketVault._guardAssets()`. `assets` becomes
  `BasketAssetConfigGuard.AssetInfo[]`. The snapshot then pins the one type
  the library writes through. A library code change changes the snapshot, so
  it shows up in review and forces a new CREATE2 library address.
- **The governed-upgrade slot** is outside the linear layout.
  `contracts/test/GovernedUpgradeLifecycle.t.sol` pins it: it recomputes the
  ERC-7201 slot from the namespace string, and it reads `vm.load(proxy, slot)`
  to check the authority and the frozen bit after deploy, upgrade and freeze.
- **CI job:** a step "Upgradeable storage-layout gate (ADR-0014)" in the
  `forge-unit-tests` job of `.github/workflows/suite-01-02-forge-tests.yml`. It
  replaces the step "Gateway storage-layout gate (issue 1476)". It runs
  `scripts/ci/check-storage-layout.sh --selftest` first, which proves each
  rule fires on a mutated snapshot. Then it runs `scripts/ci/check-storage-layout.sh`
  over every listed contract. `forge-unit-tests` is already a required check
  (`scripts/ci/required-checks.json`). Last it runs
  `scripts/ci/check-storage-layout.sh --base <ref>`, with `<ref>` the PR base
  (the previous tip on a push, `dev` on a dispatch). The same-tree compare
  reads its snapshot from the change under test, so a change that reruns
  `--write` would pass it whatever it did to the layout. `--base` holds the
  committed snapshots to the storage rules above against the base's snapshots,
  so a rewritten snapshot must itself be append-only. The linearization,
  library and OZ pins are printed, not failed, in that mode, because a release
  rewrites them on purpose. The parent alone is not an anchor: a red commit
  that rewrote a snapshot becomes the next commit's parent, which then passes.
  So the step fetches the `release/*` tags and runs
  `scripts/ci/check-storage-layout.sh --release-anchor`, the same compare
  against every annotated production `release/<version>` tag (a `-rehearsal`
  or lightweight tag never anchors). In both modes a contract proxied at the
  anchor must still be listed in `proxied.txt` (a rename or delisting fails),
  and a contract listed there with no snapshot is not treated as new.
- The gateway snapshot is re-baselined once in P1. The proxy implementation
  moves immutables into storage and changes parents, so it starts a new layout
  series. From then on the rules above hold.

### 9. EIP-170 size budget

**Floor:** every proxied implementation keeps at least 1,024 B of runtime
margin under 24,576 B when P1 lands. 1,024 B is about one D-sized fix. Today's
166 B shows how fast margin disappears. P1 adds the gateway, the router, the
registry, the IC policy, the receipt contract, `ExclusionLedgerFactory` and
every new library to `contracts/test/VaultCodeSizeGuard.t.sol`. It also adds
`test_proxiedImplementations_keepUpgradeHeadroom`, which asserts the floor.
That test runs in the existing "forge test (EIP-170 size gate)" step of
`forge-unit-tests`.

**What has to fit.** For each of the five tight contracts:

- about 2,630 B for `GovernedUpgrade` with OZ `UUPSUpgradeable`;
- the initializer body, which moves from initcode to runtime. Its upper bound
  is the constructor code. That is about 2,065 B for RobotMoneyVault (initcode
  32,364 B, minus runtime 24,410 B, minus the 5,889 B ledger creation code).
  It is about 2,090 to 2,110 B for the basket kinds and about 1,930 B for the
  gateway.
  Much of it reuses runtime helpers, so P1 measures the real cost;
- the small extra cost of namespaced parent storage. P1 measures this too.

So each tight contract must shed about 4 to 5 KB of runtime. The three basket
kinds shed it once, in the shared `BasketVault` base.

**How the design gets under the limit:**

1. **OZ `UUPSUpgradeable` without extra modules (§3).** It is the cheapest
   audited upgrade path. The upgrade check stays inside each implementation,
   where reviewers read it.
2. **Business code moves into CREATE2-linked libraries.** This is the
   existing `BasketViews` and `BasketAssetConfigGuard` pattern: `public`
   library functions run as the vault through `DELEGATECALL`. They take
   storage references only to the single shared struct types (§8). The
   starting candidates are:
   - RobotMoneyVault: a new `VaultAdapterOps` library for adapter registry
     writes (`addAdapter` checks, `_requireAdapterCompatible`, `removeAdapter`,
     `forceRemoveAdapter`, `setAdapterCap`) and for `rebalance` and
     `adminRebalance` math. Its views (`getAdapterInfo`, `getAdapterDrift`)
     move behind a self-call view library like `BasketViews`.
   - BasketVault: more of the emergency-unwind loop and the rebalance math
     into `BasketAssetConfigGuard` and `BasketViews`.
   - RobotMoneyGateway: a new `GatewayAuth` library for the agent-consent
     EIP-712 check, the commit/reveal check and the policy-window checks.
   Each new library is deployed by CREATE2 in the libs stage, listed in
   `create2Libraries` (P2), covered by the size guard and pinned by the
   layout gate.
3. **The ExclusionLedger leaves the vault's code.** A new
   `ExclusionLedgerFactory` is deployed once per chain by CREATE2.
   `ExclusionLedger`'s constructor takes the vault address explicitly. The
   vault initializer calls `factory.create(asset)`. The factory deploys
   `new ExclusionLedger(msg.sender, asset)`, so the ledger is bound to the
   calling proxy. The initializer stores the result and checks
   `VAULT() == address(this)`. The ledger's creation code lives in the factory,
   not in the vault. `exclusionLedger()` keeps its ABI.
4. **The initializer reuses runtime code.** It sets values through the same
   internal validation helpers the setters already use, so no check is
   compiled twice.
5. **No other levers.** `optimizer_runs` stays 100 and `via_ir` stays off.
   Changing either would change every codehash and the gas budgets
   (QA plan Decisions D6: 920,000 gas per deposit) for a few hundred bytes.

If P1 cannot reach the 1,024 B floor on a contract, P1 amends this ADR with
the measured number and the reason. It must not quietly ship with less, and
it must not ship a contract over the limit.

### 10. Signed authorizations and queued transactions across an upgrade

Decisions D5 says bind. The gateway's hand-rolled EIP-712 domain carries a
`version`. That version becomes the gateway implementation version, a
constant in the implementation. An implementation that changes what a signed
gateway authorization means must bump it. Every outstanding signature over the
old meaning then fails to verify. A pure fix may keep the version. The domain
already uses `address(this)`, which is the proxy, so signatures stay bound to
the proxy address across upgrades. P3 makes rmpc check the live ERC-1967
implementation and its code hash, not only the proxy code, before it signs. A
transaction already in flight runs against whatever implementation is live
when it lands. The 48-hour public schedule is what lets clients see that
coming. P3 decides how rmpc and the dapp warn on a pending upgrade.

### 11. Current direct deployments

The Base contracts deployed today are not upgraded and cannot become proxies
in place. A proxy release gets new addresses. Under ADR-0009, holders move by
choice. Old vaults stay redeemable and withdraw-only. Registry, router and
gateway references move only after the cutover gates pass (P2 runbook).

## Alternatives considered

- **Transparent proxies (`TransparentUpgradeableProxy` with a `ProxyAdmin`).**
  These need no upgrade code in the implementation, which would solve EIP-170
  at once. Rejected. The plan, `docs/architecture.md` §4 and the security
  model already pin UUPS. It would add nine `Ownable` admin contracts to
  verify and monitor. A freeze would become an ownership renounce, which
  cannot be bound to a reviewed implementation without a custom admin. Moving
  code into libraries solves the size problem without a second admin surface.
- **The upgrade path itself in a linked library.** Rejected. It would save
  under 1 KB per contract. It would also put the implementation-slot write
  behind a second `DELEGATECALL` hop, away from the reviewed contract.
- **Beacon proxies.** Rejected by the plan. One beacon upgrade would change
  every vault at once.
- **Diamonds (EIP-2535).** Rejected. Every facet cut is a per-selector upgrade
  surface and is much harder to review and freeze.
- **Namespaced (ERC-7201) storage for all Robot Money state.** Rejected.
  `forge inspect` does not report namespaced layouts, so the gate would go
  blind. Only the two-field `GovernedUpgrade` record is namespaced, and a test
  pins it.
- **The OpenZeppelin upgrades-core validator as the CI gate.** Rejected as the
  gate. It needs `ffi` and build-info output in the forge profile. Its
  namespaced checks duplicate what pinning the OZ commit already gives.
  Reviewers may still run it by hand on an upgrade candidate.
- **Upgrade authority by role (an `UPGRADER_ROLE` or `ADMIN_ROLE`).**
  Rejected. The deployer holds business roles until the handover, so a role
  check would open an interim deployer upgrade path. A role is also something
  a role change can move.
- **An on-chain "ceiling not loosened" check in `_authorizeUpgrade`.**
  Rejected for the reason in §7.
- **Proxying `RouterGovernance`.** Rejected for the reason in §2. The plan
  listed it as a candidate before #1698 reduced it to a role holder.

## Consequences

- Test, Twin, demo and contained mainnet deployments can fix logic in place
  through the Safe and the timelock, with a public delay and open withdrawals.
- A final release can be frozen at deploy or after a proving period. Either
  way the freeze is one-way and bound to a reviewed implementation.
- Before a freeze, the Safe and the timelock can install any logic, including
  bad logic. The delay gives inspection time. It does not make an upgrade
  safe. Review, the layout gate, the ceiling test, the size guard and a Twin
  rehearsal of the exact operation stand between a proposal and execution.
- Five contracts lose about 4 to 5 KB of inline code to linked libraries.
  Each library call costs some gas. P1 re-measures the deposit and redeem gas
  budgets. Status: every gas test now deploys through the proxies, so each CI
  run measures the proxied path, and `gas_estimate_reality_check` refuses to
  measure a direct vault. The numbers themselves come from the first
  post-merge CI run (QA plan Phase Q). `docs/technical/redeem-gas-1482.md`
  ("ADR-0014: the proxy hop") lists the tests and the ceilings they must stay
  under.
- New moving parts: one OZ submodule, one base contract, one factory, two or
  three new libraries, nine layout snapshots and a wider gate.
- `docs/technical/security-model.md` §2, §4 and §13,
  `docs/technical/smart-contract-invariants.md`, `docs/architecture.md` §4
  and §8, and `docs/technical/smart-contracts.md` describe proxies as
  implemented only once P1 lands. P1 has landed on qa/test-merge-v1, so they
  now do: security-model §2 and §4 carry the proxy, initializer, ceiling and
  upgrade-authority rows and §13 the proxy deploy and verify row;
  architecture §4.1, §7.3 and §8; smart-contracts §3.3 and §3.11;
  invariants UPG-1..UPG-8.

## Implementation map

| Task | Delivers |
| --- | --- |
| P1 (#1808) | `GovernedUpgrade`; the nine conversions; the OZ upgradeable submodule; `ExclusionLedgerFactory`; the single `AssetInfo`; the size libraries; `check-storage-layout.sh` and snapshots; `UpgradeCeilings.t.sol`; the size floor; the lifecycle tests below; forge deploy scripts that deploy the timelock first; freeze invariants in `smart-contract-invariants.md`. |
| P2 (#1809) | Stage table (timelock first, handover last, new libraries and the factory); manifests and verifier labels for proxy, implementation, code hashes, layout identifier, authority, delay, mode and freeze state; refusal of an undeclared mode or a non-zero admin or beacon slot; release runbooks. |
| P3 (#1810) | rmpc implementation checks; the gateway domain version binding; indexer `Upgraded` and `UpgradesFrozen` events; dapp and explorer disclosure. |
| P4 (#1811) | Twin rehearsal of deploy, governed upgrade, freeze and a rejected post-freeze upgrade. |

## Tests this ADR requires (P1)

In `contracts/test/GovernedUpgradeLifecycle.t.sol`, run for every proxied
contract kind:

- `test_upgrade_onlyTimelock`: the deployer, an EOA, an `ADMIN_ROLE` holder
  that is not the timelock, `EMERGENCY_ROLE` and `RouterGovernance` are each
  refused.
- `test_initialize_cannotReplay`, `test_implementation_initializersLocked`,
  `test_upgradeToAndCall_onImplementationReverts`.
- `test_initialize_refusesUnsetMode`, `test_initialize_refusesEoaAuthority`.
- `test_freezeAtDeploy_rejectsUpgrade`.
- `test_freeze_wrongTargetReverts`, including an upgrade that executes between
  scheduling and executing the freeze.
- `test_freeze_queuedUpgradeFailsAfterFreeze`.
- `test_freeze_survivesRoleChangesAndReinitializers`.
- `test_frozenProxyKeepsRedeemAndRedeemInKindOpen`.
- `test_governedUpgradeSlot_isPinned`.

Also required: an upgrade of populated v1 proxies to a v2 through the real
Safe and timelock on a Base fork that keeps balances, allowances, roles, fees,
caps, gateway policies, weights, receipts, adapter positions and synchronous
redemptions (#1808 test plan); `UpgradeCeilings.t.sol::test_ceilingsNeverLoosened`;
`VaultCodeSizeGuard.t.sol::test_proxiedImplementations_keepUpgradeHeadroom`;
and `scripts/ci/check-storage-layout.sh --selftest`.

## Implementation record (P1, 2026-10-15)

P1 (#1808) implemented this ADR on qa/test-merge-v1. Where the code differs from the text above,
the code and this record win; nothing below relaxes a rule of §3–§9.

- **Base and parents.** `contracts/lib/GovernedUpgrade.sol` is exactly §3 (namespace slot
  `0x5f8c…7600`, the five errors, `UpgradesFrozen`). A second `freezeUpgrades` reverts
  `UpgradesAreFrozen`. `lib/openzeppelin-contracts-upgradeable` is pinned at v5.0.2
  (`723f8cab`, the transpile of `dbb6104c`). `AdminFloorAccessControl`,
  `AdminFloorAccessControlCounter` and `AccessRoles` now extend the upgradeable parents.
  `RouterGovernance` stays direct (§2) and keeps its constructor; the parent needs no initializer
  for that.
- **Initializers.** Every former constructor argument is an `initialize` argument, followed by
  `(address upgradeAuthority, UpgradeMode mode)`; `__GovernedUpgrade_init` runs last, so the
  business checks keep their former revert order. The three basket kinds share one
  `BasketVault.initialize`; each kind supplies its name, symbol and starting slippage through
  `_kindConfig()`. Storage gaps: `AdminFloorAccessControlCounter.__gap` (49 slots) and
  `BasketVault.__gap` (50 slots); the layout gate lets a gap shrink only by the slots a new field
  takes, end-aligned.
- **Size libraries (§9 item 2), all CREATE2-linked and covered by the size guard and the layout gate:**
  `VaultAdapterOps` (rmUSDC adapter registry, deposit routing, proportional pulls, exclusion
  records, emergency drains, rebalance legs and the adapter views; it also owns the single
  `Book` / `AdapterInfo` declaration of the vault's adapter state), `BasketSwapOps` (every basket
  swap: deposit legs, redeem legs, both emergency unwinds, removed-asset re-absorption, the
  emergency-guard and TWAP-window writes; it owns `EmergencyUnwindGuard`),
  `BasketAssetConfigGuard.addAsset` (the four `addAsset` checks in one call),
  `GatewayWindows` (the rolling-window ring buffer; owns `RollingWindow`), `GatewayAuth`
  (commit/reveal and agent consent; owns `Commitment`; the EIP-712 domain and its version stay in
  the gateway, §10) and `GatewayWithdrawOps` (the `withdraw` policy checks and the whole
  `withdrawFromRouter` body). Every entry gas floor stays in the contract's own frame; a floor a
  library checks is measured on the 63/64 it receives, so it can only bind later than before.
  `BasketVault.emergencyTwapUsdcValue` is gone: the unwind legs price through the existing
  `assetUsdcValue(index, amount)` self-call.
- **Measured runtime (`forge build --sizes`, same settings as §Context):** RobotMoneyVault 22,978 B
  (1,598 B margin), AgentTokenVault 23,280 (1,296), ProtocolAssetVault 23,209 (1,367),
  RwaBasketVault 23,202 (1,374), RobotMoneyGateway 23,255 (1,321), PortfolioRouter 19,116,
  VaultRegistry 10,123, InvestmentCommitteePolicy 9,886, ConsensusRecommendationReceipt 8,798.
  Every proxied implementation clears the 1,024 B floor
  (`VaultCodeSizeGuard.t.sol::test_proxiedImplementations_keepUpgradeHeadroom`).
- **Deploy scripts.** `contracts/script/GovernedProxyDeploy.sol` deploys implementation + proxy with
  the `initialize` call in the proxy constructor and reads the proxy back (implementation slot,
  zero admin and beacon slots, authority, frozen bit). Broadcast runs require `UPGRADE_AUTHORITY`
  (code) and `UPGRADE_MODE` (`upgradeable` | `frozen-at-deploy`) on every chain; the rmUSDC stage
  also requires `EXCLUSION_LEDGER_FACTORY`. `DeployLibs` deploys the new libraries and the factory
  (CREATE2, reused when present). `DeployTimelock.runAuthority` is the timelock-first stage; the
  handover (`run`) reuses `TIMELOCK_ADDRESS` (mandatory on 8453) and refuses unless every handed-over
  proxy names it. The single-vault redeploy names its `TIMELOCK_ADDRESS` as the new vault's
  authority. The stage table, the tooling and the verifier labels that feed these inputs are P2.
- **Layout gate (§8).** `scripts/ci/check-storage-layout.sh` (rules in
  `scripts/ci/storage_layout_gate.py`) replaced the gateway-only gate in `forge-unit-tests`. Rows are
  keyed by label and occurrence because `forge inspect` names the inspected contract, not the
  declaring base, so two bases' `__gap` share a label. A library's identity is the keccak256 of its
  unlinked `deployedBytecode` text, which keeps the link placeholders of a library it links.
- **Tests.** `GovernedUpgradeLifecycle.t.sol` (every kind; the names in "Tests this ADR requires"
  plus `test_deploy_proxyBornGoverned`, `test_governedUpgrade_throughTimelock_keepsState`,
  `test_freeze_throughTimelock_rejectsLaterUpgrade`, `test_freeze_onlyAuthority`),
  `UpgradeCeilings.t.sol`, the size guard, and `WithdrawalsNeverFrozen.t.sol`, whose fork setup now
  deploys the timelock first and adds
  `test_allVaults_exitsStayOpenAfterGovernedUpgradeAndFreeze` (upgrade and freeze through the real
  Safe and timelock, then every exit). The invariants are UPG-1..UPG-7 in
  `docs/technical/smart-contract-invariants.md`.
- **Follow-up fixes (QA plan v1 WF3 critics).** `__GovernedUpgrade_init` is write-once (it reverts
  `InvalidInitialization`, the error `Initializable` already declares, once an authority is stored) and
  `GovernedUpgrade` exports `onlyUpgradeAuthority` for every reinitializer (§3): runtime cost about 42 B
  per proxied implementation; the tightest margins are now the gateway's 1,229 B and AgentTokenVault's
  1,254 B, still above the 1,024 B floor. Tests: `GovernedUpgradeLifecycle.t.sol` adds
  `test_reinitializer_pendingAfterEmptyUpgrade_refusesEveryoneButTheTimelock`,
  `test_reinitializer_cannotRotateUpgradeAuthority` and `test_receipts_surviveGovernedUpgrade`; its
  per-kind state digests now cover allowances, fees, caps, the adapter position, both router weight
  vectors and caps, the gateway policy record, the IC vote log and the receipt log with its release
  state. `WithdrawalsNeverFrozen.t.sol::test_allNineProxies_upgradeThroughSafeKeepsPopulatedState` is
  the "Tests this ADR requires" fork test: all nine populated proxies upgrade in one Safe batch through
  the timelock at the Base delay, every digest is equal at the execute timestamp, then every exit and
  the committee surface run on v2. The handover (`DeployTimelock.run`) requires `TIMELOCK_ADDRESS` on
  every chain, not only 8453, so roles and upgrade power can never land on two timelocks
  (`DeployTimelockTimelockAddressRequiredTest`, `DeployTimelockForeignTimelockTest`).

## Implementation record (P2, 2026-10-15)

P2 (#1809) implemented the tooling half of this ADR in `publish-contracts` and the core stage table.
Where the code differs from the text above, the code and this record win.

- **Stage table.** A new stage `authority` (`contracts/script/DeployUpgradeAuthority.s.sol`, manifest
  `upgrade-authority.json`) runs right before the first proxy stage and deploys the timelock (§4).
  Each proxy stage requires `UPGRADE_AUTHORITY` (that timelock) and `UPGRADE_MODE` (the sheet). The
  handover stage reads the same timelock as `TIMELOCK_ADDRESS`. The table's `proxies` block lists the
  nine proxies with their stage, proxy field, implementation field and artifact, and `proxyArtifact`
  names `ERC1967Proxy`. The parser refuses a proxy stage that does not require both env names. Core
  parity and `scripts/deploy/stage-table.test.ts` hold the list equal to `proxied.txt`.
- **Libraries.** `DeployLibs` no longer deploys `BasketSwapOps`. The basket stages compile with
  `--libraries TickMath`, which changes the metadata hash, so a libs-stage copy would never run. The
  first basket stage deploys it. The table's `libraries` and `create2Libraries` are unchanged: the
  §9 libraries are deployed by forge's CREATE2 library deployment (the vault and gateway stages find
  the libs stage's copies at the same addresses), and those two lists drive the first release's
  library adoption and its frozen transaction counts. The libs stage's `manifestNotes` name the §9
  libraries and the factory with their manifest fields. Their code is verified another way, which
  covers every library at every depth: the masked code compare blanks each library link, so the
  verifier, the `upgrade-proxy` row and the `freeze-proxy` row now follow every link reference of an
  implementation to the address forge wrote there and compare that library's code with its build
  artifact (CBOR trailer masked), recursively (`publish-contracts/src/verify/codehash.ts`
  `compareLinkedLibraries`). A proxied implementation, an upgrade target or a freeze target that links
  unreviewed library code fails its `runtime code equals build artifact (masked)` label or is refused.
- **Sheet.** `UPGRADE_MODE` (`upgradeable` or `frozen-at-deploy`) is required. Anything else is refused
  before any stage runs.
- **Runner.** After each proxy stage, `proxyStageGate` reads every proxy back: the implementation slot,
  empty admin and beacon slots, the authority, the mode, the frozen flag, initialization and locked
  implementation initializers. A miss is `VERIFY` and blocks every later stage
  (`proxy_gate.ok: false` on the stage record). Each stage record keeps the proxies it read.
- **Verifier.** Eight labels per proxy plus `upgrade authority: the authority stage's timelock is the
  handover timelock`. The existing code-hash labels compare the implementation the proxy's slot names.
  An executed `upgrade-proxy` round moves the expected implementation and build. An executed
  `freeze-proxy` round makes the proxy expected frozen. A retired vault that is a proxy is read through
  its slot. The verify record keeps each proxy with a `layout_hash` (0x + sha256 of its layout snapshot).
- **Govern rows.** `upgrade-proxy` (one `upgradeToAndCall`) and `freeze-proxy` (one
  `freezeUpgrades(liveImplementation, liveCodeHash)`, or a batch for `all`) both go through the Safe and
  the timelock, on every chain and kind, never in stage 13. Both bind to a reviewed build by masked code
  comparison. On 8453 the build must sit in a clean checkout at a release-tagged, CI-green sha, recorded as
  `build_sha`. The build must be that checkout's own `out/`, and every compared artifact and each library
  it links must be compiled from the sources committed at that sha (forge's metadata source hashes). The
  tag is checked on `robotmoney/robotmoney-core`, and CI is read with the deployment checkout's
  `check-sha-green`. `upgrade-proxy` also refuses a build whose layout snapshot moves a live variable or
  changes a stored enum's existing members.
- **Evidence.** `evidence.json` carries `upgrade_mode`, `proxies`, `proxy_upgrades` and `proxy_freezes`.
  `evidence-check` refuses an undeclared mode and a proxy record whose admin or beacon slot is not empty.
- **Runbook.** `docs/operations/contract-release-runbooks.md` §4.12 names the freeze owners, the deadline
  and the missed-deadline check, and documents the voluntary cutover without executing it.
- **Layout identifier (§8).** Every proxy stage writes `<field>_layout_id`, the sha256 of the committed
  snapshot of the contract it deployed (`GovernedProxyDeploy._layoutId`), next to `<field>_implementation`
  in its manifest. The verify record's `layout_hash` is that deploy-time identifier (`layout_source:
  "deploy-manifest"`) unless an executed upgrade replaced the implementation, with the checkout's
  snapshot hash next to it (`checkout_layout_hash`). A mismatch adds the failing label `proxy[<name>]:
  deploy layout identifier equals the checkout's layout snapshot`, and `evidence-check` refuses it.
- **Immutability statement (§5).** The verify record carries `immutability`: `core_logic_immutable` (true
  only when all nine proxies read frozen), the frozen and the upgradeable proxies, and `still_mutable`,
  the governed parameters and upstream dependencies a freeze leaves mutable
  (`publish-contracts/src/proxies.ts` `STILL_MUTABLE_AFTER_FREEZE`). `evidence-check` refuses an
  `immutability_claim` while any proxy reads upgradeable, and one without that list.
- **Runbook drift.** `publish-contracts/tests/docs-consistency.test.ts` fails when
  `docs/operations/contract-release-runbooks.md` §4.12 and the stage table disagree on the authority
  stage, the proxy list, the release modes or the refusal exit codes.
- **Left for later.** The proxy read-back in the `redeploy-vault` verb (the verifier already reads the
  redeployed vault). The on-chain re-reads of the proxy evidence (QA plan v1 L1) and the missed-deadline
  alert (`services/watchdog/src/freeze_deadline.rs`) have landed. QA plan v1 L1 (2026-10-15) closed three of the four:
  `checkProxyEvidenceOnChain` re-reads every `proxies` entry from the chain under `--rpc` and in a
  recorded chain fixture (implementation slot, empty admin and beacon slots, implementation code hash,
  authority, frozen flag, initialization); the `redeploy-vault` verb reads the new vault back with the
  runner gate's checks and keeps the read as the round's `proxy` record; and the watchdog's
  `[freeze_deadline]` check pages `freeze_deadline_missed:<chain>` once the deadline passes with a
  proxy unfrozen (`services/watchdog/src/freeze_deadline.rs`). The immutability claim stays open.
- **Tests.** `publish-contracts/tests/proxies.test.ts`, `tests/upgrade-rows.test.ts`,
  `tests/verify/proxies.test.ts`, the proxied verify world (`tests/verify/world.ts`) with a negative
  fixture per new label, and the `proxies` block of `scripts/deploy/stage-table.test.ts`.

## Implementation record (P3, 2026-10-15)

P3 (#1810) implemented the client half of this ADR. Where the code differs from the text above, the
code and this record win.

- **Version binding (§10, QA plan Decisions D5 "bind").** `RobotMoneyGateway.implementationVersion()`
  (`public pure virtual`, `"1"`, declared in `IGateway`) is the EIP-712 domain `version` of every
  `AgentConsent`: `_domainSeparator` hashes the getter's return value, so the value clients read and the
  digest the gateway checks cannot disagree. An implementation that changes what a consent means
  overrides it with a new value; every consent signed before that upgrade then reverts
  `InvalidAgentConsent`. A pure fix keeps it. The commit/reveal commitment itself is not versioned: it
  binds no signature, expires after 256 blocks, and the reveal is a transaction that runs against the
  live implementation. Cost: 50 B of runtime (gateway margin 1,271 B). `IGateway` declares the getter,
  and `GatewayAuth` and `GatewayWithdrawOps` import `IGateway`, so their metadata hashes moved: the
  gateway's layout snapshot records the two new library code hashes (`check-storage-layout.sh --write
  RobotMoneyGateway`; no storage change). Tests:
  `contracts/test/GatewayImplementationVersion.t.sol` (bump voids, pure fix keeps, domain stays on the
  proxy); invariant UPG-8 in `docs/technical/smart-contract-invariants.md`.
- **rmpc.** `clients/rust-payment-client/src/upgrade.rs`. Every write preflight (check 2b) and
  `rmpc agent-consent` read the ERC-1967 implementation slot and that implementation's code at one
  explicit block and refuse with `ErrImplementationNotApproved` unless its code hash is in the new
  config key `gateway_implementation_hashes`. A failed read is a refusal. A zero slot is a direct
  gateway and needs no pin; a pin for one is refused. `agent-consent` also checks the proxy's own code
  against `gateway_runtime_hash` and signs in the domain of the live `implementationVersion()`, read at
  the same block. `rmpc get-gateway` prints the implementation, its code hash, whether it is approved,
  the version, the upgrade authority and the freeze flag. Indexed state never feeds any of it.
- **Pending upgrades (the §10 open point).** rmpc and the dapp do not scan the timelock queue. The
  public delay is the warning; the operator lists a reviewed implementation's code hash in
  `gateway_implementation_hashes` before its upgrade executes, and until then the first write after the
  upgrade refuses instead of signing against unreviewed logic. A transaction already in flight runs
  against whatever implementation is live when it lands, and a consent signed before a version bump
  fails on reveal. The dapp shows the live state; `/v1/governance/admin-events` already lists every
  queued `CallScheduled`.
- **Dapp.** The vault page (`VaultDetail`, `UpgradeStatePanel`, `useUpgradeState`, `upgradeState.ts`)
  shows the implementation, its code hash, the timelock and whether the proxy is upgradeable, frozen or
  a direct deployment, read from the chain under the deposit-pause read guard. The consent check
  (`useAgentConsent`) reads `implementationVersion()` and never assumes `"1"`. The rmpc export pins the
  live implementation's code hash when the gateway is a proxy.
- **Indexer and explorer.** Migration 0024 `proxy_upgrade_events` stores every `Upgraded` and
  `UpgradesFrozen` of a watched address (the gateway, the vaults, the registry, the router, the IC policy
  and the receipt); an `UpgradesFrozen` that names another proxy than its emitter is not recorded. The
  reorg rollback covers it. `GET /v1/upgrades` serves each proxy's newest implementation and freeze
  state with the events behind them.
- **Follow-up fixes (QA plan v1 WF3 critics).**
  - *Every gateway write checks the implementation.* `rmpc committee vote-submit` and `rmpc receipt
    submit` run checks 1, 2 and 2b before they sign (`upgrade::verify_gateway_before_signing`); they had
    run none. A mismatch exits 2 and a failed read exits 3, never a signature.
  - *The vaults and the router are pinned too.* A deposit checks the gateway's vault (check 5c), a
    withdraw every vault it redeems from and, on a gateway with a router, the router it redeems
    through (security round 1: `withdraw` signed `withdrawFromRouter` without it), a router deposit the
    router and every leg of its effective weight vector, and `withdraw-router` the router, each against
    the new config key
    `proxy_implementation_hashes` with the rules of check 2b. `ErrImplementationNotApproved` gained a
    `proxy` field naming the refused contract.
  - *The JSON `checks` block no longer claims 2b passed* when the refusal could have come from 2b itself
    (an RPC, decode or config error); only refusals raised after 2b set `gateway_implementation_approved`.
  - *The dapp pins a reviewed gateway implementation.* `VITE_GATEWAY_EXPECTED_IMPLEMENTATION_HASH`
    (build-time, from `gateway.json` `gateway_implementation_runtime_hash`, one or more hashes) is checked
    after the code-hash pin: a proxy without a pin, an unlisted implementation and a pin for a direct
    gateway each refuse. The rmpc export pins only a hash that matched it (no trust on first use), and for
    a proxied vault it names `proxy_implementation_hashes` with how to fill it from the release record.
    `scripts/stage/mainnet-dapp.ts`, the Docker build, the compose files and the smoke-test dapp env carry
    the value.
  - *The dapp pins the vault and router implementations too (security round 1).* Their code-hash pins
    were the generic `ERC1967Proxy`, so deposits, approvals and the "[bytecode verified]" badge passed
    for any implementation the timelock installed. `VITE_VAULT_EXPECTED_IMPLEMENTATION_HASH` and
    `VITE_ROUTER_EXPECTED_IMPLEMENTATION_HASH` (from `timelock.json`, which `DeployTimelock` now records:
    `vault_handover.vault_<i>.implementation_code_hash`, `code_hashes.router_implementation`) are checked
    by the write guard at send time, with the code and the slot read at one block and no session cache,
    and by the badge. Every gateway write re-checks the gateway implementation the same way, so a tab
    left open across an upgrade no longer signs against it. Redeems are never gated on any of it, nor on
    gateway verification (core 1494). The rmpc export writes the reviewed vault and router hashes the
    build pins as `proxy_implementation_hashes`, and never a live-read command.
  - *A dapp router deposit checks every leg (security round 2).* The guard checked only the router, so a
    leg upgraded to unreviewed logic took USDC through the router while a direct deposit into it was
    refused. A router deposit now reads `getEffectiveWeights()` at the guard's block and checks every
    leg vault's code and implementation pins, as rmpc does; the refusal names the leg. The router form
    closes and the badge stays UNVERIFIED while a leg is refused. The Withdraw tab still shows and
    revokes a share allowance left on a router that fails its pins.
  - *Disclosure beyond the vault pages.* `ProtocolUpgradesPanel` (Router Governance tab) shows the
    implementation and freeze state of the gateway, router, registry, IC policy and receipt. Without a
    chain read (no wallet on the mainnet class) every panel shows the explorer index's answer, labelled as
    indexed, or says it cannot read, instead of "Reading…" forever.
  - *Monitoring.* The watchdog pages once per indexed `Upgraded` (warning) and `UpgradesFrozen` (info)
    event (`services/watchdog/src/upgrade_events.rs`, `[upgrade_events]`, on by default).
  - *Templates and deploy output.* `clients/rust-payment-client/config.example.toml` carries both pin keys;
    the smoke-test deploy output prints `gateway_implementation_hash` and `proxy_implementation_hashes`;
    the devnet e2e, suite 11b and the fork router test write `proxy_implementation_hashes`.
- **Open decision: queued transactions (issue 1810 acceptance "queued transactions are bound to or
  invalidated by an implementation version change").** What is bound: every agent consent (version
  domain, UPG-8), and every freeze (implementation and code hash, UPG-4/§5). What is not: a timelock
  operation queued before an upgrade (other than a freeze) runs against whatever implementation is live
  when it executes, and so does an rmpc transaction already in flight; rmpc's next write after an
  unapproved upgrade refuses, and the watchdog pages the upgrade. Binding those would need either a
  version argument on every governed and agent write path or an rmpc scan of the timelock queue. This
  record does not change the acceptance criterion: it is recorded as an open owner decision in
  `docs/development/open-questions.md` ("Queued transactions across a gateway upgrade").
- **Tests.** `GatewayImplementationVersion.t.sol`; rmpc `policy::tests` (approved, swapped, unpinned,
  failed slot and code reads, withdraw path), `upgrade::tests`, `signer::consent::tests`,
  `tests/cli_get_gateway.rs`, `tests/cli_agent_consent.rs`; dapp `tests/unit/upgrade-state.test.tsx`,
  `agent-consent.test.ts`, `configExport.test.ts`, `vault-detail.test.tsx`, `abi-parity.test.ts`;
  indexer `admin_events_and_progress::proxy_upgrade_and_freeze_events_are_indexed_and_rolled_back_on_reorg`
  and the `abi.rs` drift gates; explorer-api
  `progress_and_admin::upgrades_endpoint_serves_implementation_and_freeze_state`.

## Implementation record (P4, 2026-10-15)

P4 (#1811) implemented the Twin rehearsal of the lifecycle. Where the code differs from the text above, the code and this record win.

- **Where it runs.** The job `twin-upgrade-rehearsal` in `.github/workflows/suite-29-nightly-twin-fork.yml` runs nightly and on dispatch, never on a pull request. It starts its own Twin fork at the run's one pin. `record-results` needs it, so a red rehearsal makes the nightly red.
- **Deploy.** The `twin-publish` action deploys this commit's exact release artifacts. It runs publish (the authority stage's timelock before the nine proxies, `UPGRADE_MODE=upgradeable` from the committed Twin sheet), verify, and stage 13 through the real Safe and timelock.
- **Lifecycle.** `publish-contracts/src/ci/twin-upgrade-rehearsal.ts` uses the same CLI, keys, sheet and run manifest. It deploys a new `VaultRegistry` implementation from the build artifact and runs `govern --row upgrade-proxy`. The slot must move and `listVaults()` must not change. Then it runs verify. It runs `govern --row freeze-proxy --admin-arg proxy=all`, and all nine proxies must read frozen.
- **Rejected post-freeze upgrade.** The rehearsal tries a rollback of the frozen registry to its original implementation twice. The tool must refuse it with `GOVERN` (exit 14) naming the freeze, sending nothing. Then the Safe schedules the same `upgradeToAndCall` on the timelock as the Twin-only generic call `post-freeze-upgrade-registry`. After the delay, the proxy must refuse the execute. The round stays scheduled, never executed, and the slot does not move. This is the §5 rule that a queued upgrade reverts once frozen, shown on the real contracts.
- **Evidence.** The rehearsal runs verify again, then `evidence-check --proxy-lifecycle` with `--rejected-upgrade` and `--rpc`. The check rebuilds every timelock call from the run manifest. It requires the proxies' `Upgraded` and `UpgradesFrozen` events. It requires every frozen proxy to read frozen now, on the frozen implementation and code hash. It requires the post-freeze operation to be ready and not done, with a simulated execute that reverts `UpgradesAreFrozen()`. The job uploads `upgrade-rehearsal-<sha>`: the evidence folder after the rehearsal secret scan, the verifier labels and the manifests.
- **Release checklist.** `docs/operations/contract-release-runbooks.md` §4.1 items 3 and 4 gate a final mainnet release. Item 3 requires an external security review of the exact release SHA, filed in `docs/audits.md`, and is never waived. Item 4 requires this job green at that SHA. `publish-contracts/tests/docs-consistency.test.ts` fails when either requirement leaves the checklist.
- **Limits.** The Twin upgrade target is a second deployment of the reviewed build, because `upgrade-proxy` refuses any other code. A v1 to v2 state migration is covered by the P1 forge tests, not by the Twin. The Twin proves the scripts and contracts execute the lifecycle. It does not prove mainnet governance works. A rollback after a state-changing upgrade is never assumed safe.
- **Tests.** `publish-contracts/tests/twin-upgrade-rehearsal-script.test.ts` runs the step script with stub tools, including each failure that must stop it. `publish-contracts/tests/proxy-lifecycle-evidence.test.ts` covers the offline and chain checks and the CLI. `scripts/devnet/check-twin-chain-ci-selftest.ts` (suite 13) checks that the job stays nightly, its step order, its upload and that `record-results` requires it.
