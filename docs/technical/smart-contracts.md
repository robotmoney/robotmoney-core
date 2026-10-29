# Robot Money — Smart Contract Reference

> This is a hand-curated overview (system diagram, roles, caps, and how the
> pieces fit). For the generated per-contract / per-symbol NatSpec reference,
> see `contracts/doc/` (produced by `forge doc`).

> Scope: verified source code for all Robot Money smart contracts deployed on Base mainnet. The main production vaults are RobotMoneyVault and the basket-vault family (BasketVault base class with ProtocolAssetVault, AgentTokenVault, and RwaBasketVault subclasses). Allocation and governance infrastructure includes VaultRegistry, PortfolioRouter, and RouterGovernance. All contracts are verified on BaseScan. Source files are in `contracts/` at the repo root. Compiler: `v0.8.24+commit.e11b9ed9`, optimization 200 runs, EVM Cancun. The previous version of this document was a reverse-engineering exercise from ABIs; this version is authoritative from source.

> `docs/adr/ADR-0010-unified-vault-architecture.md` is Rejected and dead. The shipped design keeps `RobotMoneyVault` and the plain `BasketVault` family: rmRWA is a plain basket row (`RwaBasketVault`), with no oracle and no position adapter.

---

## 1. System overview

```
                           ┌────────────────────────────┐
                           │      VaultRegistry         │
                           │   • Vault discovery        │
                           │   • Lifecycle status       │
                           │   • Router eligibility     │
                           │                            │
                           │   ADMIN_ROLE               │
                           └────────────────────────────┘
                                       │
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                  │
                    ▼                  ▼                  ▼
        ┌───────────────────┐ ┌──────────────────┐ ┌───────────────┐
        │  RobotMoneyVault  │ │  BasketVault     │ │  PortfolioRouter│
        │  (USDC → yield    │ │  (USDC → basket) │ │  (split USDC   │
        │  strategy)        │ │                  │ │   by weights)  │
        │                   │ │ • ProtocolAsset  │ │                │
        │ • Morpho Adapter  │ │   Vault          │ │ • Holds weights│
        │ • Aave Adapter    │ │ • AgentToken     │ │ • Eligibility  │
        │ • Compound Adapter│ │   Vault          │ │   from Registry│
        │                   │ │ • RwaBasketVault │ │ • Weights set  │
        │ ERC-4626 shares   │ │                  │ │   by Router-   │
        │ (rmUSDC)          │ │ ERC-4626 shares  │ │   Governance   │
        │                   │ │ (rmPROTO / rmAGT │ │ USDC → Vaults  │
        │ ADMIN_ROLE        │ │  / rmRWA)        │ │ (ERC-4626      │
        │ EMERGENCY_ROLE    │ │                  │ │  shares)       │
        │ KEEPER_ROLE       │ │ ADMIN_ROLE       │ │                │
        │                   │ │ EMERGENCY_ROLE   │ │ ADMIN_ROLE     │
        └───────────────────┘ └──────────────────┘ └───────────────┘
                    │                  │                  │
        ┌───────────┴──────────────────┴──────────────────┴────────────┐
        │                                                              │
        │        Uniswap Pools · Morpho · Aave · Compound            │
        │        (External protocols and market venues)              │
        │                                                             │
        └─────────────────────────────────────────────────────────────┘

        ┌────────────────────────────────────────────────────────────────┐
        │              RouterGovernance                                  │
        │              • Holds WEIGHT_SETTER_ROLE on PortfolioRouter    │
        │              • Applies consensus receipts as router weights   │
        │              • ADMIN_ROLE held by the timelock                │
        │                                                               │
        │              (no voting by anyone)                            │
        └────────────────────────────────────────────────────────────────┘
```

**Allocation flow**: Human wallets deposit USDC either directly to a vault (RobotMoneyVault or a BasketVault) or through PortfolioRouter, which splits the deposit across multiple vaults by the router weight vector. Agents reach the same public surfaces through the rmpc gateway system (§1.1). VaultRegistry provides the single source of truth for vault discovery and router eligibility. RouterGovernance holds `WEIGHT_SETTER_ROLE` on the router and applies the weights the Safe schedules through the timelock from a consensus receipt.

### 1.1 Two systems: the vaults system and the rmpc gateway system

Owner decision, 2026-10-19. The contracts form two separate systems. Each is deployed in its own run and tested on its own.

**Vaults system** (the treasury product):
- The Robot Money vaults (rmUSDC, rmPROTO, rmRWA), their adapters and libraries. rmAGENT is retired (ADR-0017) and a new deployment has neither it nor its price recorder.
- VaultRegistry, PortfolioRouter and RouterGovernance.
- The rebalancing signal: ConsensusRecommendationReceipt, the register of consensus receipts. It is the only rebalancing signal the Safe may cite. The vector the Safe schedules through `applyReceipt` is the input; the chain cannot parse the payload, so readers compare the applied vector to the payload (owner decision 2026-10-20). A submitter holding `RECEIPT_SUBMITTER_ROLE`, granted by `ADMIN_ROLE` (the Safe through the timelock), records a receipt with `recordReceipt(receiptId, payloadDigest, payloadUri)`. The Safe applies a receipt with `RouterGovernance.applyReceipt` through the timelock. The Safe can also set default weights directly (`setDefaultWeights`).
- Governance: the Safe multisig through the TimelockController.
- Users: human wallets deposit into a vault or the router directly. The receipt submitter records receipts on the receipt contract directly, not through the gateway.
- Deployed by the rehearsal deploy runbook (`docs/runbooks/contract-qa/`).

**rmpc gateway system** (`rmpc` and the gateway it needs, owner decision 2026-10-19):
- RobotMoneyGateway and the `rmpc` client (Rust payment client). `rmpc` is an agentic cryptographic signer for end users. Its uses are off-chain (signing, keystores, the committee-identity Ed25519 signer, config export, reads). Its one on-chain write is an agent deposit into an allowed vault.
- The gateway holds the depositor's authorization and policy (`commitAuthorization`/`revealAuthorization`, `setPolicy`, `revokeAgent`). The share receiver is always the owner, and an agent's owner never changes. It answers whether an agent may deposit, how much, until when, for which depositor and share receiver, into which allowed vault. It then forwards the permitted deposit to that vault. It has no withdrawal path and no router path.
- It is a client of the vaults system. It calls the same public vault deposit surface a human wallet uses.
- Deployed in its own run after the vaults system. It reads the vaults system's addresses for its allowed vaults. It has its own runbook and CI.
- Who governs the gateway is an open question for its own release.

**Dependency rule.** The gateway depends on the vaults system. The vaults system has no dependency on the gateway. No vaults-system contract names the gateway, takes it as a constructor or initializer argument, or accepts writes only from it. Rebalancing works with no gateway deployed.

---

## 2. Deployed addresses (Base mainnet, chain id 8453)

> **Retired v1, tests never read it.** The addresses in this section document the retired v1 production deployment for history only. No test, script or CI job reads the live v1 vault. Every test deploys its own vault from our scripts onto the Twin chain (a pinned lazy fork of real Base state, core 1498, 1496).

> **v1 vault control status (default pending owner confirmation).** The v1
> vault was deployed with the Safe `0x88bA…75A0` as the `_admin` constructor
> argument (§2.4, §5 role table), so its `ADMIN_ROLE` and `EMERGENCY_ROLE` follow
> that constructor argument, not a `TimelockController`. `DeployTimelock.s.sol`
> hands over only the vaults listed in `VAULT_ADDRESSES` for the launch run, and
> the launch plan (devops issue 72) deploys new vaults (rmUSDC, rmPROTO,
> rmRWA; rmAGENT is retired, ADR-0017) behind the timelock. Whether to migrate the v1 vault behind a
> timelock or retire it is an owner decision that has **not** been made. The
> current default is option (b): retire v1 and document its Safe-direct control
> as legacy (see `docs/operations/retired-v1-vault-maintenance.md`). This default
> stays until the owner confirms or changes it.

### 2.1 Core allocation and governance contracts

| Contract | Address | Source file |
|---|---|---|
| VaultRegistry | (devnet address in demo) | `contracts/VaultRegistry.sol` |
| PortfolioRouter | (devnet address in demo) | `contracts/PortfolioRouter.sol` |
| RouterGovernance | (devnet address in demo) | `contracts/RouterGovernance.sol` |

### 2.2 Production vaults and adapters (RobotMoneyVault strategy)

| Contract | Address | Source file |
|---|---|---|
| RobotMoneyVault | [`0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd`](https://basescan.org/address/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd) | `contracts/RobotMoneyVault.sol` |
| MorphoAdapter | [`0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9`](https://basescan.org/address/0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9) | `contracts/adapters/MorphoAdapter.sol` |
| AaveV3Adapter | [`0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea`](https://basescan.org/address/0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea) | `contracts/adapters/AaveV3Adapter.sol` |
| CompoundV3Adapter | [`0x8247da22a59fce074c102431048d0ce7294c2652`](https://basescan.org/address/0x8247da22a59fce074c102431048d0ce7294c2652) | `contracts/adapters/CompoundV3Adapter.sol` |

### 2.3 Basket vaults (multi-asset baskets)

| Contract | Role | Source file | Mainnet address |
|---|---|---|---|
| BasketVault (base) | Abstract ERC-4626 USDC → basket asset mix. Subclassed by ProtocolAssetVault, AgentTokenVault, RwaBasketVault. | `contracts/vaults/BasketVault.sol` | N/A (abstract) |
| ProtocolAssetVault | USDC → wETH, cbBTC (volatile protocol assets; assets with no usable pool are added later through the timelock) | `contracts/vaults/ProtocolAssetVault.sol` | set at the mainnet deploy |
| AgentTokenVault | Retired (ADR-0017). The live v0.5.0 vault is withdraw-only (`redeem`, `redeemInKind`) and holds its BNKR until holders exit. A new deployment does not deploy it, its Uniswap V4 swap adapter or its price recorder. The code stays for the retired proxy and for any future agent-token vault. | `contracts/vaults/AgentTokenVault.sol` | live v0.5.0 proxy only |
| RwaBasketVault | USDC → deSPXA, a plain basket row priced from its fee 500 pool TWAP | `contracts/vaults/RwaBasketVault.sol` | set at the mainnet deploy |

### 2.4 Admin and fee recipient

| Account | Address |
|---|---|
| Admin / fee recipient (Safe) | [`0x88bA7364cC6cE5054981d571b33f8fb3E91475A0`](https://basescan.org/address/0x88bA7364cC6cE5054981d571b33f8fb3E91475A0) |

**Notes:**
- RobotMoneyVault and its adapters are direct (non-proxy) deployments on mainnet. CompoundV3Adapter was compiled with `viaIR: true`; the others were not. Every address in this section is a direct deployment and cannot be upgraded in place.
- From issue 1808 the source deploys every core contract (the vaults system: rmUSDC, the three basket vaults, VaultRegistry, PortfolioRouter, ConsensusRecommendationReceipt, RouterGovernance; the rmpc gateway system: RobotMoneyGateway; §1.1) behind its own ERC-1967 proxy ([ADR-0014](../adr/ADR-0014-governed-uups-upgrades-and-freeze.md)). No proxied deployment is on 8453 yet. When one is, this section lists the proxy address (the address users and clients call), the implementation address and code hash, the upgrade timelock and the freeze state, and keeps the direct addresses above as the legacy deployment.
- VaultRegistry, PortfolioRouter, RouterGovernance, and basket vaults are deployed to Base mainnet by the publish-contracts CLI (`publish-contracts/`). The demo deploy path is retired. The gateway is deployed in its own later run (§1.1).
- Basket vault mainnet addresses are intentionally excluded here (out of scope); they will be added once they reach production status and mainnet deployment.

---

## 3. RobotMoneyVault

### 3.1 Inheritance

```
RobotMoneyVault
  ├── ERC4626Upgradeable   (OpenZeppelin v5.0.2 — ERC-20 shares + ERC-4626 accounting, ERC-7201 storage)
  ├── AdminFloorAccessControlCounter → AccessControlUpgradeable (three roles: ADMIN, EMERGENCY, KEEPER)
  ├── ReentrancyGuardUpgradeable
  └── GovernedUUPS   (upgrade and freeze entry points; the rules are the linked GovernedUpgrade library)
```

The deposit pause is the vault's own `depositsPaused` flag, not OZ Pausable (core 1494). The deployed v1 vault predates this and still inherits OZ Pausable.

Since issue 1808 the source runs behind an ERC-1967 proxy: `initialize(asset, tvlCap, perDepositCap, exitFeeBps, feeRecipient, admin, emergencyResponder, upgradeTimelock, upgradeMode)` replaces the constructor (same arguments plus the upgrade authority and the release mode; the vault creates its own `ExclusionLedger` inside `initialize`, core 1820) and runs inside the proxy's constructor. The retired v1 vault is a direct deployment with a constructor. Only `upgradeTimelock()` (the Safe-controlled timelock) can `upgradeToAndCall` or `freezeUpgrades`; no role below carries upgrade power. The emergency drains, the `adminRebalance` pull, `getAdapterInfo` and `getAdapterDrift` run in the linked `RobotMoneyVaultOps` library, unchanged. See [ADR-0014](../adr/ADR-0014-governed-uups-upgrades-and-freeze.md).

### 3.2 Access control roles

| Role | Keccak | Granted at deploy | Powers |
|---|---|---|---|
| `ADMIN_ROLE` | `keccak256("ADMIN_ROLE")` | `_admin` initializer arg | Add/remove/reconfigure adapters, set caps/fees (governance-gated, INV-3: ADMIN_ROLE is held by the TimelockController on the launch vaults; the retired v1 vault is the exception, see §2), `rebalance`, `adminRebalance`, `setMaxRebalanceBps`, `setMinRebalanceInterval`. **No** `rescueTokens` — arbitrary-recipient rescue is deleted (INV-1); the only token movement is the permissionless `sweepForeignToken` |
| `EMERGENCY_ROLE` | `keccak256("EMERGENCY_ROLE")` | `_emergencyResponder` initializer arg | `pauseDeposits`, `emergencyWithdraw`, `emergencyWithdrawAdapter`, `emergencyExcludeAdapter` (exclude-only), `forceRemoveAdapter`, `recoverRemovedAdapter` (into the exclusion record only), `shutdownVault`. `unpauseDeposits` and restoring an excluded adapter (`setAdapterAllowed(adapter, true)`) are `ADMIN_ROLE` only. |
| `KEEPER_ROLE` | `keccak256("KEEPER_ROLE")` | **Not granted at launch** | `rebalance` |

`ADMIN_ROLE` is its own admin (can grant/revoke itself). For the retired v1 vault, the constructor arg is the Safe multisig `0x88bA…75A0`. For the launch vaults, stage 11 moves `ADMIN_ROLE` to the timelock and `EMERGENCY_ROLE` to the independent emergency key.

### 3.3 Fixed constants (cannot be changed by any role)

These are `constant`s in the implementation's bytecode: never storage, never an initializer argument, never behind a setter. Behind a proxy constants stay constants ([ADR-0014](../adr/ADR-0014-governed-uups-upgrades-and-freeze.md) §2): no role, setter or initializer can change one. Only a new implementation can, and that upgrade sits in public view for the full timelock delay with withdrawals open and needs the layout gate and implementation review (ADR-0014, Consequences). After a freeze the value is fixed forever.

| Constant | Value | Meaning |
|---|---|---|
| `MAX_EXIT_FEE_BPS` | 100 | Exit fee ceiling — 1% |
| `MAX_ADAPTERS` | 20 | Maximum registered adapters |
| `MAX_BPS` | 10000 | Basis point denominator |
| `MAX_REBALANCE_BPS_CEILING` | 5000 | Keeper can never move more than 50% TVL per rebalance call |
| `MIN_REBALANCE_INTERVAL_FLOOR` | 1 hour | Rebalance cannot be called more frequently than once per hour |

### 3.4 State variables (governance-settable)

| Variable | Initial | Setter | Notes |
|---|---|---|---|
| `tvlCap` | initializer arg | `setTvlCap` (ADMIN), `restoreVault` (ADMIN) | Hard cap on `totalAssets`; `shutdownVault` sets to 0, `restoreVault(newTvlCap)` sets a fresh cap |
| `perDepositCap` | initializer arg | `setPerDepositCap` (ADMIN) | Per-call `deposit` ceiling |
| `exitFeeBps` | initializer arg (≤ 100) | `setExitFeeBps` (ADMIN) | Charged on redeem/withdraw; max 1% |
| `feeRecipient` | initializer arg | `setFeeRecipient` (ADMIN) | Receives exit fees |
| `adapterAllowed` | false for every address | `setAdapterAllowed` (ADMIN) | Exact adapter instances the Safe-governed admin process has approved. Setting `false` on an active adapter quarantines it: its balance leaves `totalAssets`, deposits and mints close, and keeper `rebalance` skips it (core 1788) |
| `adapterCodeHashAllowed` | false for every hash | `setAdapterCodeHashAllowed` (ADMIN) | Runtime bytecode hashes approved for adapter implementation identity checks |
| `shutdown` | `false` | `shutdownVault` (EMERGENCY), `restoreVault` (ADMIN) | While true, `deposit` reverts; recoverable — `restoreVault(newTvlCap)` (ADMIN) clears it and re-opens deposits |
| `maxRebalanceBpsPerCall` | 2500 (25%) | `setMaxRebalanceBpsPerCall` (ADMIN) | Throttle per `rebalance()` call |
| `minRebalanceInterval` | 12 hours | `setMinRebalanceInterval` (ADMIN) | Minimum time between rebalances |

Adapter onboarding is now a two-step Safe-governed process: governance first
approves both the exact adapter address and its runtime `codehash`, then calls
`addAdapter`. `addAdapter` also verifies the adapter reports this vault's USDC
asset through `USDC()` and this vault address through `VAULT()`. It refuses an
address that an active entry already holds (`AdapterAlreadyActive`, core 1789),
so one adapter balance is never counted twice in NAV. A re-add after
`removeAdapter` or `forceRemoveAdapter` is legal and appends a new entry. When the
force-removed entry still holds an open exclusion record, the re-add first moves
the adapter's whole balance into that record (`Restoration`, then `Restored`) and
reverts `AdapterNotEmpty` if the adapter cannot pay out, so the new entry starts
empty and NAV does not rise (security round 1). Deposit,
keeper rebalance, and admin rebalance allocation paths re-check eligibility
before USDC leaves the vault.

Revoking approval for an already-active adapter quarantines it (core 1788).
Its balance is excluded from `totalAssets`. While any active adapter is
ineligible, `maxDeposit` and `maxMint` return zero and `deposit` and `mint`
revert, so no one mints against the reduced NAV. Keeper `rebalance` never
pulls from a quarantined adapter. It also reverts while deposits are paused or
the vault is shut down, so it cannot re-deploy funds an emergency drain parked
idle. Withdrawals stay open and pay from eligible adapters and idle USDC.

Revoking approval also opens a record in the vault's `ExclusionLedger`
(`exclusionLedger()`) with a snapshot of every holder's shares (core 1820).
Every USDC later recovered from that adapter goes to the record, never to idle
NAV. The recovery paths are `emergencyWithdrawAdapter` and `emergencyWithdraw`
(EMERGENCY), `adminRebalance` (ADMIN), and restored eligibility, which first
drains the adapter into the record. These three need an ACTIVE entry. After a
force-remove the entry is inactive, and two paths remain:
`recoverRemovedAdapter(i, amount)` (EMERGENCY, security round 2) withdraws one
tranche of up to `amount` into the record, and a re-add drains the whole
remaining balance into it. The holders at the snapshot claim it pro
rata through `ExclusionLedger.claim`, which anyone may call for a holder. A
holder who exits during the exclusion is paid at the reduced NAV and keeps that
claim. Shares minted or bought later carry none, and the share price never
rises from a recovery. A redeem that would pay 0 USDC during the exclusion
reverts `ZeroPayoutDuringExclusion`. `removeAdapter` deactivates the drained entry
and closes its record. `forceRemoveAdapter` deactivates the entry without a
withdrawal: a funded entry with no record gets one (a snapshot of the supply at
that moment), and its record closes (`ForceRemoved`) only when the adapter
reports an empty balance. Otherwise the record stays open on the inactive index.
`recoverRemovedAdapter` credits it as the venue can pay, and closes it
(`ForceRemoved`) once the adapter reports an empty balance. A re-add of the same
address realises whatever is left into it, and reverts `AdapterNotEmpty` while
the venue cannot repay that remainder in one call. So the write-off moves no
value from exiters to the holders of the day (security round 1, SR-1012-5), and a
partly liquid venue no longer strands its liquid part (security round 2). `EMERGENCY_ROLE` can also open a record without the timelock:
`emergencyExcludeAdapter(i)` revokes the entry's allowance and opens its record in
one call. Run it before `emergencyWithdraw` when an adapter is illiquid, so the
drain of the healthy adapters does not let early redeemers take full NAV from idle.
Only `ADMIN_ROLE` restores the entry. A closed record stays claimable.

### 3.5 Adapter routing — deposit

`_routeDeposit` uses a two-pass algorithm:

**Pass 1 — fill deficits to `min(targetBps, capBps)`:**  
For each active adapter, compute `effectiveTarget = min(capBps, equalWeightBps)`. Allocate deficit up to remaining amount.

**Pass 2 — spread leftover into cap headroom:**  
Any funds not allocated in Pass 1 (e.g. when an adapter hits its `capBps`) are spread across adapters that still have cap headroom.

**A venue that refuses a supply (security round 2):** the lending adapters' `deploy(amount)` hands the USDC straight back to the vault when the venue refuses it for capacity (Aave supply cap reached or reserve frozen; MetaMorpho `AllCapsReached`; Comet supply paused) and emits `DeployRefused(amount, reason)`. The vault measures what each adapter kept by its own USDC balance, emits `Allocated` only for that, and pass 2 does not ask a refusing adapter again in the same call. What no adapter takes stays idle in NAV with `UnroutedDeposit`. So a full venue never reverts a deposit, a keeper `rebalance` or a router deposit with an rmUSDC leg.

**A venue that shuts withdrawals too (security round 3):** an Aave reserve that is paused or inactive, or a Comet with withdrawals paused, cannot pay out while NAV still counts the position at face. `AaveV3Adapter` and `CompoundV3Adapter` report it through `venueWithdrawable()` (`IVenueHealthAdapter`). While any active adapter reports false, `maxDeposit` and `maxMint` read 0, so a deposit reverts and the router skips the rmUSDC leg. The adapter's `deploy` reverts `VenueWithdrawalsClosed(reason)` instead of handing the slice back, so a keeper `rebalance` cannot turn a healthy venue's excess into idle either. Before this, a deposit minted at a NAV that counted the stuck balance, and its idle slice paid an informed holder's redeem at par while a later haircut fell on the holders who stayed. Tested by `RobotMoneyVaultRouteDeposit.t.sol::test_venueShutsWithdrawals_depositsCloseAndNoIdleFundsParExit`, `::test_venueShutsWithdrawals_adapterRevertsSoRebalanceIdlesNothing`, `PortfolioRouterLegAvailability.t.sol::test_RTR5_rmUsdcLegWithPausedLendingVenueIsSkipped` and, on the Twin chain, `VaultForkRegressions.t.sol::test_fork_venueHealth_pausedAaveReserveClosesDeposits`.

`targetBps` is `MAX_BPS / activeAdapterCount` — pure equal weight, recomputed each call. With 3 adapters: 3333 each.

### 3.6 Adapter routing — withdrawal

`_pullProportional` pulls from each active adapter in proportion to its current balance:

```
pull_i = assetsNeeded × adapterBalance_i / totalInAdapters
```

Dust from integer division is swept from `lastActiveIdx`. If total adapter balance is less than requested, it caps at what's available (no revert on shortfall — caller receives what exists).

### 3.7 Exit fee

- Charged on every `withdraw` and `redeem`. The live rmUSDC vault charges 25 bps (0.25%); the ceiling is `MAX_EXIT_FEE_BPS` = 100 (1%).
- `previewRedeem(shares)` → `gross × (1 − exitFeeBps/10000)` — returns **net** USDC.
- `previewWithdraw(assets)` → shares required for `assets` **net** — converts net to gross first (`assets × 10000 / (10000 − exitFeeBps)`), then shares.
- Fee is `safeTransfer`-ed to `feeRecipient` before the net amount goes to the receiver.
- `_withdraw` handles both `redeem` and `withdraw` paths via the same function — shares are burned, fee is separated from gross, fee transferred to recipient, net transferred to receiver.

### 3.8 Emergency functions

| Function | Role | Effect |
|---|---|---|
| `pauseDeposits()` | EMERGENCY | Sets `depositsPaused`. `deposit` and `mint` revert `DepositsArePaused()`. Emits `DepositsPaused(account)`. Withdrawals are never frozen, by anyone: the vault has no withdrawal-pause flag, and `maxRedeem`/`maxWithdraw` are never lowered by a pause (core 1494). |
| `unpauseDeposits()` | ADMIN (timelock) | Clears `depositsPaused` and emits `DepositsUnpaused(account)`. Also clears the deposit halt that `emergencyWithdraw`, `emergencyWithdrawAdapter` and `forceRemoveAdapter` set. |
| `emergencyWithdraw()` | EMERGENCY | Pauses deposits, then tries `withdraw(balance)` on every active adapter with a `try/catch` — failures are logged but do not revert |
| `emergencyWithdrawAdapter(i)` | EMERGENCY | Same for a single adapter index. Withdrawals stay open. |
| `emergencyExcludeAdapter(i)` | EMERGENCY | Revokes the active entry's allowance and opens its exclusion record (snapshot of the supply) in one call. Exclude-only: `setAdapterAllowed(adapter, true)` (ADMIN) restores it. Does not pause deposits; the exclusion itself closes them. |
| `forceRemoveAdapter(i)` | EMERGENCY | Marks adapter inactive regardless of balance and emits `AdapterForceRemoved(i, addr, lossAmount)`. A funded entry keeps an open exclusion record, so the balance stays owed to the holders of the moment; `recoverRemovedAdapter` or a later re-add pays it into that record. |
| `recoverRemovedAdapter(i, amount)` | EMERGENCY | Security round 2. For an inactive entry with an open exclusion record: withdraws up to `amount` (clamped to the adapter's balance) straight into the record (`EmergencyWithdrawAdapter` source) and closes it (`ForceRemoved`) once the adapter reports an empty balance. Reverts `AdapterNotFound` for an active entry and `NoOpenExclusion(i)` without a record. Ask for at most what the venue can pay: the adapter's `withdraw` reverts on a shortfall. Does not pause deposits. |
| `shutdownVault()` | EMERGENCY | Sets `shutdown = true`, `tvlCap = 0`. Deposits revert with `VaultShutdown()`; withdrawals continue. Recoverable by ADMIN via `restoreVault` (see below). |

`shutdownVault()` is not permanent. It is reversed by `restoreVault(uint256 newTvlCap)`,
an **ADMIN**-only recovery path. The asymmetry mirrors `pauseDeposits`/`unpauseDeposits`: a
compromised emergency hot key can DoS deposits, but only the higher-trust admin
role can re-open the vault. Because `shutdownVault` zeroes `tvlCap`, the admin
must supply a fresh cap rather than silently reusing a stale value:

| Function | Role | Effect |
|---|---|---|
| `restoreVault(uint256 newTvlCap)` | ADMIN | Reverts with `NotShutdown()` unless `shutdown == true`. Requires `newTvlCap > 0` (else `InvalidCap()`) and `perDepositCap <= newTvlCap` (else `InvalidParam()`). Clears `shutdown`, sets `tvlCap = newTvlCap`, emits `VaultRestored(newTvlCap)` and `TvlCapUpdated(old, newTvlCap)`. Deposits resume under the new cap. |

#### Emergency levers per vault and the adapter write-off rule (issue 1705)

One table names every emergency lever per vault: `scripts/deploy/stage-table.json` `vaults[].emergencyLevers`, each an `EMERGENCY_ROLE` function with no timelock (`scripts/deploy/stage-table.test.ts` fails when a vault contract gains or loses one). rmUSDC: `pauseDeposits`, `emergencyWithdraw`, `emergencyWithdrawAdapter`, `forceRemoveAdapter`, `shutdownVault`. rmPROTO, rmAGENT and rmRWA: `pauseDeposits`, `emergencyUnwind`, `emergencyUnwindWithOverride`, `shutdownVault`. None freezes a withdrawal.

The rule for the mainnet test (issue 1705 Q2 (a); narrowing the levers is decided before the final deployment):

- **Who writes off a position.** Only `EMERGENCY_ROLE` (the emergency key), through `forceRemoveAdapter` on rmUSDC. It drops the adapter from NAV and pauses deposits, so nobody buys shares at the written-down price. `ADMIN_ROLE` (the timelock) can only remove an empty adapter (`removeAdapter`). The baskets have no write-off lever: `removeAsset` (ADMIN) refuses a held asset.
- **Who recovers.** Only `ADMIN_ROLE`, the Safe through the timelock: it adds the adapter back (`addAdapter`) and reopens deposits (`unpauseDeposits`). The emergency key can do neither.
- **How a recovery is attributed.** Pro rata to whoever holds shares when it lands. A holder who exits during the write-off is paid at the reduced NAV and keeps no claim on the recovery. On a basket, a balance that reappears on a removed asset is swapped back into NAV by the permissionless `reabsorbRemovedAsset`, credited the same way.

`contracts/test/AdapterWriteOffRule.t.sol` shows the rmUSDC rule on a real vault.

#### 3.8.1 Pause names (core 1494)

Owner decision 2026-10-05: withdrawals are never frozen. A pause stops new deposits only, and the names say so. This is the one rename table. It covers RobotMoneyVault, the unified `Vault`, the BasketVault family (rmPROTO, rmAGENT, rmRWA), `RobotMoneyGateway` / `IGateway`, `VaultRegistry` and `PortfolioRouter`.

| Old name | New name | Where | On the v1 vault |
|---|---|---|---|
| `pause()` | `pauseDeposits()` | vaults (`EMERGENCY_ROLE`), gateway (`DEPOSIT_PAUSER_ROLE`) | v1 keeps `pause()`, which also freezes withdrawals |
| `unpause()` | `unpauseDeposits()` | vaults and gateway (`ADMIN_ROLE`, the timelock in production) | v1 keeps `unpause()` |
| `paused()` | `depositsPaused()` | vaults and gateway (view) | v1 keeps `paused()` and also has `depositsPaused()` |
| `PAUSER_ROLE` | `DEPOSIT_PAUSER_ROLE` (`keccak256("DEPOSIT_PAUSER_ROLE")`, a new hash) | gateway. The env var `PAUSER_ADDRESS` keeps its name and receives this role. | not a v1 vault name |
| `Paused(address)` / `Unpaused(address)`, `DepositsPausedChanged(bool)`, `DepositsPausedSet(bool)` | `DepositsPaused(address indexed)` / `DepositsUnpaused(address indexed)` | vaults and gateway (events) | v1 keeps `DepositsPausedChanged` |
| `EnforcedPause()`, vault error `DepositsPaused()`, gateway `PausedError()` | `DepositsArePaused()` | `deposit`, `mint` while paused | v1 keeps error `DepositsPaused()` |
| gateway `NotPaused()` | `DepositsNotPaused()` | gateway `unpauseDeposits()` when not paused | not a v1 vault name |
| `ExpectedPause()` | removed | BasketVault no longer inherits OZ Pausable | not a v1 vault name |
| `withdrawalsPaused`, `WithdrawalsPaused()`, `WithdrawalsPausedChanged`, `setWithdrawalsPaused` | deleted | no current vault has a withdrawal pause | v1 keeps `withdrawalsPaused()` |
| `VaultStatus.Paused` | `VaultStatus.DepositsPaused` (ordinal 1, unchanged) | `VaultRegistry` | not a v1 vault name |
| `VaultPausedForRedeem` | removed | `PortfolioRouter.redeemFor` redeems from a vault in every status | not a v1 vault name |

Emergency levers (`emergencyWithdraw`, `emergencyWithdrawAdapter`, `forceRemoveAdapter`, `emergencyUnwind`, `shutdownVault`) set a deposit halt or move funds to idle. They never block an exit.

**The v1 exception.** The deployed v1 RobotMoneyVault (`0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd`, Base mainnet) keeps its old code and the old names. Its v1 `pause()` also freezes withdrawals (it sets v1 `withdrawalsPaused`). Never call `pause()` on v1. The v1 vault has `paused()`, `depositsPaused()` and `withdrawalsPaused()`. Clients read `depositsPaused()`, which exists on v1 and on every current contract.

### 3.9 Rebalance

Two entry points:

- `rebalance()` — callable by ADMIN or KEEPER; throttled by `minRebalanceInterval`; capped at `maxRebalanceBpsPerCall`; pulls from over-allocated adapters, then re-routes idle balance.
- `adminRebalance(uint256[] calldata targetBalances)` — ADMIN only; bypasses throttle; accepts explicit per-adapter target balances.

Both emit `Rebalanced(totalMoved)` and update `lastRebalanceAt`.

Additional read-only helpers: `getAdapterDrift()`, `isRebalanceAvailable()`, `nextRebalanceAt()`.

### 3.10 Management fee

**There is no management fee in the vault contract.** The source contains no fee accrual, no `harvest()`, no `accrueFees()`, no timestamp-based skim. The only fee is the exit fee charged at redeem/withdraw time. The 2% annual management fee advertised on robotmoney.net is off-chain — likely via admin-initiated periodic USDC transfers from `feeRecipient` or from protocol revenue, not from the vault contract itself.

### 3.11 Upgrade and freeze (every proxied contract)

RobotMoneyVault, the three basket kinds, VaultRegistry, PortfolioRouter, ConsensusRecommendationReceipt and RouterGovernance (the vaults system), and RobotMoneyGateway (the rmpc gateway system, §1.1), each inherit `GovernedUUPS` (`contracts/lib/GovernedUUPS.sol`) and run behind their own `ERC1967Proxy` ([ADR-0014](../adr/ADR-0014-governed-uups-upgrades-and-freeze.md) §1). The upgrade and freeze rules live once, in the linked `GovernedUpgrade` library, which runs by DELEGATECALL in the proxy's storage (ERC-7201 namespace `robotmoney.storage.GovernedUUPS`). The storage-layout gate (`scripts/ci/check-core-storage-layout.sh`, ADR-0014 §5) pins each contract's layout. The surface is the same on all nine:

| Function | Caller | Notes |
|---|---|---|
| `initialize(…, upgradeTimelock_, upgradeMode_)` | the proxy constructor, once | Every former constructor argument, then the upgrade timelock (the CREATE2 address of the deployment's Safe-proposer `TimelockController`, `contracts/script/UpgradeAuthority.sol`; zero reverts `InvalidUpgradeTimelock`) and the `UpgradeMode` (`Upgradeable` or `FrozenAtDeploy`; `Undeclared` reverts `UpgradeModeUndeclared`). `FrozenAtDeploy` freezes inside the atomic initialization. A second call reverts. The implementation's constructor disables its own initializers. |
| `upgradeTimelock()` | view | The only account that may upgrade or freeze. Written once at initialization, no setter, not an AccessControl role: no grant, revoke, renounce or reinitializer moves it. |
| `upgradesFrozen()` | view | True once frozen. It never becomes false again. |
| `upgradeToAndCall(address newImplementation, bytes data)` | upgrade timelock only | Replace the implementation and, when `data` is not empty, run it (a reinitializer) in the same transaction. Only through an active proxy pointing at this implementation (`UUPSUnauthorizedCallContext` otherwise). Reverts `NotUpgradeTimelock(caller)` for anyone else (any role holder included), `UpgradesAreFrozen()` once frozen, and `ERC1967InvalidImplementation` for an implementation with no code or a wrong `proxiableUUID`. Scheduled through the Safe and the timelock. |
| `freezeUpgrades(address expectedImplementation, bytes32 expectedCodeHash)` | upgrade timelock only | Sets the frozen flag forever, disables every later initializer and reinitializer, and emits `UpgradesFrozen(proxy, implementation, codeHash)`. Reverts `FreezeTargetMismatch(live, liveCodeHash)` unless the live implementation and its runtime code hash equal the arguments, so a freeze queued before an intervening upgrade cannot lock in the other version, and `UpgradesAreFrozen()` when already frozen. Scheduled through the Safe and the timelock (`docs/operations/contract-release-runbooks.md` §4.12). |
| `proxiableUUID()` | view | UUPS: the ERC-1967 implementation slot. Reverts when called on anything but the implementation itself. |

A freeze never pauses or alters `redeem`, `withdraw` or `redeemInKind` (ADR-0014 §4; the freeze invariants in `smart-contract-invariants.md`).

**Retired storage slots.** Proxy layouts are append-only, so storage that lost its use stays in place under its original label and type. It is `internal`, never read and never written. `RobotMoneyGateway` keeps `icPolicy` (typed by an empty `IInvestmentCommitteePolicy` interface that exists only for this slot), `consensusReceipt` and `routerContract` (slot 2). The `AgentPolicy` struct keeps its withdraw fields (`assetRecipient`, `maxWithdrawPerPayment`, `maxWithdrawPerWindow`, `allowedSourceVaults`) as retired, unused members (owner decision 2026-10-20). The policy validator rejects any non-zero retired withdraw field: `assetRecipient`, `maxWithdrawPerPayment` and `maxWithdrawPerWindow` must be zero, `allowedSourceVaults` must be empty. No client reads the retired getters. `ConsensusRecommendationReceipt` keeps `gateway` and `icPolicy`. The layout snapshots for both contracts stay unchanged.

---

## 4. Adapter contracts

All three implement `IStrategyAdapter` (`contracts/interfaces/IStrategyAdapter.sol`):

```solidity
interface IStrategyAdapter {
    function deploy(uint256 amount) external;
    function withdraw(uint256 amount) external returns (uint256 actual);
    function totalAssets() external view returns (uint256);
    function sweepForeignToken(address token) external;
}
```

All three gate every value-moving function (`deploy`, `withdraw`) with `onlyVault` — a simple `msg.sender == VAULT` check against the immutable constructor argument.

All three expose public immutables: `USDC`, `VAULT`, and their protocol-specific contract (`MORPHO_VAULT`, `POOL`/`A_TOKEN`, `COMET`).

All three implement `sweepForeignToken` — the permissionless foreign-token quarantine sweep that enforces custody invariants INV-1/INV-2 (see `docs/prd.md` §12 — Security invariants). It moves only NON-protected tokens to the single hardcoded quarantine address (`ForeignTokenQuarantine.QUARANTINE`), reverting when `token` is USDC or the protocol receipt token. There is no `rescueTokens(token,to)` — the old arbitrary-recipient rescue function is deleted (INV-1: no admin/role/vault function routes a protocol or depositor asset to a caller-supplied recipient).

### 4.1 MorphoAdapter

Wraps `MORPHO_VAULT` (Gauntlet USDC Prime — an ERC-4626 vault).

- `deploy`: `safeIncreaseAllowance` → `MORPHO_VAULT.deposit(amount, address(this))` → clear residual allowance.
- `withdraw`: `MORPHO_VAULT.withdraw(amount, VAULT, address(this))` — Morpho sends USDC directly to `VAULT`.
- `totalAssets`: `MORPHO_VAULT.convertToAssets(MORPHO_VAULT.balanceOf(address(this)))` — live share-to-asset conversion.

### 4.2 AaveV3Adapter

Wraps Aave V3 Pool. Holds aTokens (rebasing ERC-20).

- `deploy`: `safeIncreaseAllowance` → `POOL.supply(USDC, amount, address(this), 0)` → clear residual allowance.
- `withdraw`: `POOL.withdraw(USDC, amount, VAULT)` — Aave sends USDC directly to `VAULT`. Reverts with `WithdrawShortfall` if actual < requested (excluding `type(uint256).max` withdrawals).
- `totalAssets`: `A_TOKEN.balanceOf(address(this))` — aToken balance is live underlying USDC.

### 4.3 CompoundV3Adapter

Wraps Compound V3 Comet (non-ERC-4626). `supply`/`withdraw` always operate on `msg.sender` — this means withdrawn USDC lands in the adapter, not the vault, so the adapter must forward it.

- `deploy`: `safeIncreaseAllowance` → `COMET.supply(USDC, amount)` → clear residual allowance.
- `withdraw`: `COMET.withdraw(USDC, amount)` — USDC lands at `address(this)` (adapter). Adapter computes `actual = postBalance − preBalance` and `safeTransfer`s it to `VAULT`. Reverts with `WithdrawShortfall` if actual < requested.
- `totalAssets`: `COMET.balanceOf(address(this))` — live underlying USDC with interest.

This design is the reason CompoundV3Adapter was compiled with `viaIR: true` — the pre/post balance pattern and inline SafeERC20 calls produce complex control flow that benefits from IR-based optimization.

---

## 5. Trust model (from source)

> This table covers contract-level trust assumptions confirmed from
> source. The full security taxonomy — execution, accounting,
> access, oracle, bridge, economic, dependency, monitoring,
> off-chain agent, dapp/web2, infrastructure, operational, and
> process — is in `docs/technical/security-model.md`.

| Risk | Mitigation (confirmed from source) |
|---|---|
| Admin abuse | AccessControl with `ADMIN_ROLE` self-admined; production admin is the Safe-run timelock. `MAX_EXIT_FEE_BPS = 100` is a `constant` ceiling (§3.3) — admin cannot set fees above 1%, and no role holds upgrade power (§3.11) |
| Emergency misuse | `EMERGENCY_ROLE` is separate from `ADMIN_ROLE`: the initializer grants `ADMIN_ROLE` to `_admin` and `EMERGENCY_ROLE` to `_emergencyResponder` (the retired v1 vault granted both to the same Safe in its constructor). Both roles can be revoked |
| Malicious adapter onboarding | `addAdapter` requires Safe-governed address approval, runtime `codehash` approval, and adapter `USDC()` / `VAULT()` compatibility checks. Allocation paths re-check the address allowlist before transferring USDC |
| Adapter loss | `forceRemoveAdapter` accepts loss explicitly; `emergencyWithdraw` uses `try/catch` so a broken adapter doesn't block others |
| Reentrancy | `nonReentrant` on `_deposit`, `_withdraw`, `rebalance`, `adminRebalance`, `emergencyWithdraw`, `emergencyWithdrawAdapter` |
| Upgradeability | The deployed 8453 contracts are direct and have no in-place upgrade path. The source (issue 1808) runs every core contract behind its own ERC-1967 proxy: only the Safe-controlled timelock (`upgradeTimelock()`, not a role) can upgrade or freeze; `freezeUpgrades(expectedImplementation, expectedCodeHash)` is one-way and bound to the reviewed implementation; the release mode is a required initializer argument (`Upgradeable` or `FrozenAtDeploy`, no default). Not deployed on 8453. See [ADR-0014](../adr/ADR-0014-governed-uups-upgrades-and-freeze.md) and `docs/technical/contract-upgradeability-plan.md` |
| Fee ceiling | `MAX_EXIT_FEE_BPS = 100` (1%) is an immutable constant. `setExitFeeBps` reverts above this |
| Rebalance throttle | Keeper-triggered rebalance is throttled: `MIN_REBALANCE_INTERVAL_FLOOR = 1 hour` and `MAX_REBALANCE_BPS_CEILING = 5000` (50%) are immutable floors/ceilings |
| Foreign-token quarantine (INV-1/INV-2) | Arbitrary-recipient rescue is deleted. `sweepForeignToken(token)` is permissionless and moves only NON-protected tokens to the hardcoded `ForeignTokenQuarantine.QUARANTINE` address (never a caller-supplied recipient). The vault sweep rejects `asset()` and `address(this)`; the BasketVault sweep additionally rejects every active/configured basket asset and re-absorbs removed-asset balances into NAV via `reabsorbRemovedAsset`; adapter sweeps reject USDC and the protocol receipt token |

---

## 6. Corrections to prior analysis

The original `smart-contracts.md` was inferred from ABIs. Several claims were wrong or incomplete; source resolves them:

| Prior claim | Actual (from source) |
|---|---|
| "Whether the vault is upgradeable is unknown" | Existing vault: no proxy — direct deployment confirmed. The source now deploys a governed UUPS proxy (issue 1808, ADR-0014); no proxied vault is live on 8453 |
| "Management fee accrual mechanism unknown (3 candidates)" | No on-chain management fee at all. Exit fee only |
| "Withdraw routing algorithm — proportional vs. greedy unknown" | Confirmed proportional: `pull_i = assetsNeeded × balance_i / total` |
| "targetBps is stored or derived — unknown" | Derived: `MAX_BPS / activeAdapterCount`. Not stored |
| "Admin write surface exists but selectors unknown" | Full setter surface confirmed: `setTvlCap`, `setPerDepositCap`, `setExitFeeBps`, `setFeeRecipient`, `addAdapter`, `removeAdapter`, `setAdapterCap`, rebalance controls |
| "Reentrancy guard usage unverified" | `nonReentrant` confirmed on deposit, withdraw, rebalance |
| "Adapter loss handling unknown" | Partial pull caps at available balance; `forceRemoveAdapter` accepts write-off |
| "KEEPER_ROLE not granted at launch" | Confirmed in constructor comment |
| "Two emergency switches: paused + shutdown" | Confirmed. Both stop deposits only (`depositsPaused`, core 1494). `shutdownVault` also zeroes `tvlCap` |
| "Adapter rebalancing — targetBps tiltable?" | No stored `targetBps`. `adminRebalance` accepts explicit targets as calldata; `rebalance()` always uses equal-weight |

---

## 7. Functions not exposed by historical client tooling

These exist in the source but were never called by the deprecated TypeScript CLI:

| Function | Role | Notes |
|---|---|---|
| `rebalance()` | ADMIN or KEEPER | Throttled rebalance |
| `adminRebalance(uint256[])` | ADMIN | Manual per-adapter target rebalance |
| `addAdapter(address, uint16)` | ADMIN | Register new adapter |
| `removeAdapter(uint256)` | ADMIN | Deactivate empty adapter |
| `setAdapterCap(uint256, uint16)` | ADMIN | Change per-adapter cap |
| `setAdapterMaxExposure(uint256, uint256)` | ADMIN | Set an active adapter's `maxExposure` (Morpho only; 0 = uncapped). Emits `AdapterMaxExposureSet` |
| `setMaxRebalanceBpsPerCall(uint16)` | ADMIN | Adjust rebalance throttle |
| `setMinRebalanceInterval(uint256)` | ADMIN | Adjust rebalance cooldown |
| `emergencyWithdraw()` | EMERGENCY | Pull all adapters |
| `emergencyWithdrawAdapter(uint256)` | EMERGENCY | Pull one adapter |
| `emergencyExcludeAdapter(uint256)` | EMERGENCY | Exclude one adapter from NAV and open its exclusion record (exclude-only) |
| `forceRemoveAdapter(uint256)` | EMERGENCY | Deactivate a broken adapter; its balance stays owed through an exclusion record |
| `recoverRemovedAdapter(uint256, uint256)` | EMERGENCY | Withdraw one tranche from a force-removed adapter into its open exclusion record |
| `shutdownVault()` | EMERGENCY | Halt deposits, zero `tvlCap` (recoverable by ADMIN via `restoreVault`) |
| `restoreVault(uint256)` | ADMIN | Reverse a shutdown and re-open deposits under a fresh TVL cap |
| `sweepForeignToken(address)` | permissionless | Quarantine a NON-protected foreign token to the fixed `QUARANTINE` address (INV-1/INV-2). Reverts for `asset()` / share token |
| `getAdapterDrift()` | view | Returns current/target/drift per adapter |
| `isRebalanceAvailable()` | view | Check rebalance cooldown |
| `nextRebalanceAt()` | view | Timestamp of next allowed rebalance |
| `activeAdapterCount()` | view | Count of active adapters |
| `currentTargetBps()` | view | Equal-weight target in bps |
| `isShutdown()` | view | Alias for `shutdown` state var |

Future client tooling should consider surfacing `getAdapterDrift()`, `isRebalanceAvailable()`, and `nextRebalanceAt()` — these are directly useful for treasury monitoring.

---

## 8. ERC-4626 share scale and inflation-attack mitigation

### 8.1 Virtual share offset

`RobotMoneyVault._decimalsOffset()` returns `18`. This configures OpenZeppelin's ERC-4626 virtual shares to `10^18` and virtual assets to `1`, using the formula:

```
shares = assets × (totalSupply + 10^18) / (totalAssets + 1)   [floor]
assets = shares × (totalAssets + 1) / (totalSupply + 10^18)   [floor]
```

With this offset the economic cost of a donation-based first-depositor inflation attack scales as `10^18` — an attacker would need to donate more than `10^18` times the virtual floor to manipulate the share price by even 1 unit. This is economically infeasible in practice.

### 8.2 Raw-share scale (for integrators)

The vault's share token reports `decimals() == 6` (matching USDC). The internal raw-share count is inflated by the `10^18` virtual factor:

| Operation | Fresh vault (no prior deposits) | Steady-state (balanced TVL) |
|---|---|---|
| `previewDeposit(1e6)` | `1e24` raw shares | ≈ `1e24` raw shares (ratio stays ~1e18 per USDC) |
| `previewMint(1e24)` | `1e6` USDC | ≈ `1e6` USDC |
| `previewRedeem(1e24)` | `1e6` USDC (minus exit fee) | ≈ `1e6` USDC (minus exit fee) |
| `previewWithdraw(1e6)` | ≈ `1e24` raw shares | ≈ `1e24` raw shares |

**Integrators must not assume raw share amounts equal asset amounts.** Always use `convertToShares` / `convertToAssets` for on-chain math. For display, divide `balanceOf(user)` by `10 ** vault.decimals()` (i.e. by `1e6`).

**`convertToAssets` ignores exit costs** (core 1795). It is the gross share of NAV: it leaves out the exit fee on both vault families and the `maxSlippageBps` floor a BasketVault applies to the swaps of a redeem. To show what a position is worth at exit, use `previewRedeem(shares)`, which a redeem pays at least. A 1 USDC round trip through rmAGENT on Deploy 2 read `convertToAssets` 0.055767, `previewRedeem` 0.052978, and the redeem paid 0.054092. The dapp position card and the explorer's `positions[].usdc_value` use `previewRedeem` (QA plan X8).

### 8.3 Admin seed deposit (deploy runbook)

**Before opening the vault to the public, the deployer MUST perform a seed deposit.**

Rationale: even with `_decimalsOffset() == 18`, a fresh vault with `totalSupply == 0` and `totalAssets == 0` has a share price backed only by virtual shares. The seed deposit ensures that real capital anchors the price before any public depositor arrives.

**Seed amount:** the stage sheet's `SEED_DEPOSIT_USDC` (6-decimal units, must be above 0). The decided production seed is 1 USDC (`1_000_000`), rmUSDC only (runbook D3, 2026-10-01). The baskets take no seed: the 18-decimal virtual share offset protects all four vaults (`scripts/deploy/stage-table.json` `vaults[].seed`, issue 1705 Q6).

**Initial deposit state, one rule for all three vaults** (`scripts/deploy/stage-table.json` `vaults[].deployPaused` and `unpauseInStage13`, issue 1705): all three vaults deploy paused, and stage 13 unpauses all three through the Safe and the timelock.

**Seed share receiver:** the sheet's `SHARE_RECEIVER_ADDRESS`, passed to the script as `SEED_SHARE_RECEIVER`. It is never zero and never the deployer or admin (the sheet's `ADMIN_ADDRESS` is the deployer, which holds admin until the timelock handover). The deployer holds no seed shares (core 1503, fixed on PR 1505).

**Steps:**

1. Deploy `RobotMoneyVault` (and adapter contracts).
2. Register at least one active adapter via `addAdapter`.
3. Approve the vault to spend the seed from the deployer address:
   ```solidity
   USDC.approve(address(vault), 1_000_000);
   ```
4. Call `vault.deposit(1_000_000, seedShareReceiver)` from the deployer account, so the shares are minted to `SEED_SHARE_RECEIVER`.
5. Verify `vault.totalAssets() >= 1_000_000 * 9_999 / 10_000`, `vault.totalSupply() > 0`, and `vault.balanceOf(deployer) == 0`.
6. Call `vault.pauseDeposits()` right after the seed (core 1710): rmUSDC deploys paused like the three basket vaults. The stage 13 `unpause-USDC` row, a Safe operation through the timelock, opens it.
7. Only after steps 1–6 are confirmed and stage 13 has run: the vault is open to the public (publish the vault address). The deploy authorizes no agent: each depositor authorizes its own.

All three vaults (rmUSDC, rmPROTO, rmRWA) deploy paused, and the Safe unpauses each one through the timelock in stage 13. The rule for each vault, with the seed, the router-eligibility source, the emergency levers and the registry-name source, is in `scripts/deploy/stage-table.json` `vaults[]` (issue 1705).

The seed deposit is not recoverable through normal channels (it is locked as vault shares). Consider it a permanent operational cost of the deployment. The seed share receiver holds the rmUSDC shares minted for the seed and can participate in future withdrawals.

**CI enforcement:** `contracts/script/DeployVault.s.sol` (the vault stage) encodes this runbook step as code: the `run()` (broadcast) entrypoint performs the seed deposit inline after adapter registration, and the new `runInProcessWithSeed()` variant does the same for fork tests. `contracts/test/DeploySeedDeposit.t.sol` (`DeploySeedDeposit`) is the fork-level CI gate — it asserts `vault.totalAssets()` keeps at least 99.99% of the seed, `vault.totalSupply() > 0`, that the receiver holds the seed shares and the deployer holds none, before any public deposit, and that the vault reads paused after the seed (core 1710). It is wired into the `forge-fork-vault-regressions` job in `.github/workflows/suite-01-02-forge-tests.yml`. (This is the fork gate: the job runs on the Twin chain, a pinned lazy fork of real Base state; ADR-0011 is superseded by the Twin chain, core 1498.)

---

## 9. VaultRegistry

### 9.1 Purpose and access model

`VaultRegistry` is the on-chain registry of authorized Robot Money vaults. It serves as the single source of truth for:

- **Vault discovery**: Clients (rmpc, dapp, indexer) enumerate all registered vaults via `listVaults()`.
- **Lifecycle status**: Each vault is marked `Active`, `DepositsPaused`, or `Retired` (withdraw-only); `PortfolioRouter` routes deposits only to `Active` vaults. `PortfolioRouter.redeemFor` redeems from a vault in every status (core 1494).
- **Router eligibility**: ADMIN_ROLE flags which vaults have cleared production-readiness gating (audit, oracle hardening) and may be weighted by `PortfolioRouter`. This flag is state, not a code variant—the same contracts deploy into test, demo, and mainnet; only the registry flag's value differs (per `docs/development/single-production-codebase.md`).

Access model: `ADMIN_ROLE` is self-administered (its own role-admin). The deployer is the initial admin.

### 9.2 Key functions

| Function | Role | Effect |
|---|---|---|
| `registerVault(address vault, VaultMetadata)` | ADMIN | Register a new vault with metadata (name, asset address). Vault starts `Active`. |
| `setVaultStatus(address vault, VaultStatus)` | ADMIN | Transition vault status (Active ↔ DepositsPaused ↔ Retired). No forced migration. No status blocks a redeem. |
| `setRouterEligible(address vault, bool eligible)` | ADMIN | Toggle whether PortfolioRouter may weight and allocate to this vault. |
| `setRouter(address newRouter)` | ADMIN | Link the PortfolioRouter whose default weight vector length is synchronized with router-eligible count (ADR-0002). |
| `listVaults()` | view | Return all registered vault addresses in registration order. |
| `isRouterEligible(address vault)` | view | Check whether a vault is marked router-eligible. |

### 9.3 Key invariants

- **Router-eligibility consistency** (ADR-0002): If a router is linked and carries a non-empty default weight vector, any `setRouterEligible` change that would alter the count reverts with `StaleDefaultWeightsLength`. This forces governance to update the router's default weights atomically with eligibility changes, preventing the router from pointing to stale-length weight vectors.
- **Vault address uniqueness**: `registerVault` reverts if a vault is already registered.
- **Registry state completeness**: All depositable vaults must be registered; the registry is the authoritative source.

---

## 9.1 PortfolioRouter

### 9.1.1 Purpose and deposit flow

`PortfolioRouter` is the outer allocation contract. It accepts USDC deposits and routes them proportionally across multiple active Robot Money vaults by default weights or by the weights of an applied consensus receipt. Depositors receive vault receipts directly.

**Deposit mechanics**: A user calls `deposit(uint256 amount, uint256[] minSharesPerLeg[])`. The router:
1. Reads the active weight vector (the applied receipt's weights if `votedWeightsActive`; otherwise default weights).
2. Marks each leg available or skipped (`_availabilityAndAmounts` / `_isDepositable`): a leg is available only when its registry status is `Active` and it is router-eligible.
3. Splits the full amount across the available legs only, pro rata by bps: `legAmount[i] = amount × weight[i] / availableBps`, where `availableBps` is the sum of the available legs' bps. The rounding remainder goes to the last available leg WITH NON-ZERO BPS, so it never lands on a 0 bps leg. Skipped legs get 0.
4. Calls `vault.deposit(legAmount[i], depositor)` for each available leg whose `legAmount` is non-zero (`_executeLeg`). A leg whose computed amount is 0 (a 0 bps weight, or a small weight that rounds to 0 on a tiny deposit) is skipped like an unavailable leg: no approval, no vault call, no event (issue 1746). Without this, one Active, eligible 0 bps leg such as rmAGENT (whose `deposit(0)` reverts) would revert the whole router deposit over the 9500/500/0/0 launch vector. `previewDeposit` reports such a leg as available with `legAmount` 0 and `estShares` 0.
5. Emits `RouterDeposit` per deposited leg and returns the shares minted per leg (0 for a skipped leg).

The legs that run execute atomically: if any of them reverts, the entire deposit reverts. No USDC is left with the router and none is returned to the user. If no leg is available, the deposit reverts `NoWeightsSet` and the revert undoes the USDC pull. If every computed leg amount is 0 (only a zero-amount deposit, or only 0 bps legs left available), the deposit reverts `NoFundedLeg` and calls no vault. The sum of the leg amounts always equals `amount`, so nothing is stranded. See "Routing eligibility" below and `docs/architecture.md` §4.2.1.

### 9.1.2 Weight vectors and governance integration

The router maintains two weight vectors:

- **Active weights**: Written by `setWeights(vaults, bps)`, gated by `WEIGHT_SETTER_ROLE`. While `votedWeightsActive` is true this vector is the source of truth. `RouterGovernance.applyReceipt` writes it (the `apply-receipt` govern row, core 1696).
- **Default weights**: Written by `setDefaultWeights(vaults, bps)` through `RouterGovernance.setDefaultWeights` (ADMIN_ROLE, held by the timelock), and by `migrateEligibility` through `applyMigrationDefaultWeights`. The router routes by it whenever `votedWeightsActive` is false. It is the fallback (ADR-0002). The `apply-receipt` govern row does not write it. Its length must equal `VaultRegistry.routerEligibleCount()`.

At deploy, `contracts/script/DeployPortfolioRouter.s.sol` marks rmUSDC router-eligible and writes the initial DEFAULT vector with `setDefaultWeights`: rmUSDC 10000 bps, the only router-eligible vault at that point. It never calls `setWeights`, so `votedWeightsActive` stays false from deploy (issue 1743). The basket stages then flip each basket eligible with one atomic `migrateEligibility`, which re-sets the default to the sheet's launch vector (`ROUTER_WEIGHTS`, rmUSDC 9500, rmPROTO 500, rmAGENT 0, rmRWA 0). The effective routing after the deploy is that launch vector, and the stage 12 verifier asserts both `votedWeightsActive()` false and `getEffectiveWeights()` equal to the sheet. A voted vector written at deploy would override every later default change. Nothing clears an active vector or resets it to the default (issue 1988): a newer receipt replaces it with `govern --row apply-receipt`.

The Safe multisig, through the TimelockController, is the only body that changes router weights. `PortfolioRouter.setWeights` is gated by `WEIGHT_SETTER_ROLE`, held by RouterGovernance, and stage 11 grants the timelock router `ADMIN_ROLE` only (core 1522, `docs/technical/governance-decisions.md` §3.6). The timelock reaches the weights through `RouterGovernance.applyReceipt`, gated by `RouterGovernance`'s own `WEIGHT_SETTER_ROLE`, which the timelock holds. `applyReceipt` calls `setWeights`.

`setWeights` and `setDefaultWeights` revert `DuplicateVault(vault)` when a vault appears twice in the list (security review 2026-10-12, finding 8).

#### Routing eligibility

A vault is **eligible for routing** only when its `VaultRegistry` status is `Active`, its registry router-eligible flag is set (`VaultRegistry.isRouterEligible`), and its `asset()` is the router's USDC (`PortfolioRouter.isRouterEligibleAndActive`).

- `setWeights`, `setDefaultWeights` and `applyMigrationDefaultWeights` call `_requireActiveAndEligible` for every listed vault, at any bps, 0 included. An ineligible or non-Active vault cannot be listed even at 0 bps, so it receives 0.
- At deposit time `_availabilityAndAmounts` skips each non-depositable leg and renormalises the full amount pro rata across the remaining legs. Nothing is left with the router or returned to the user. If no leg is depositable, `_depositTo` reverts `NoWeightsSet` and no USDC moves. An eligible leg whose computed amount is 0 is not called (issue 1746).
- Per-vault caps do not renormalise: `_executeLeg` reverts `VaultCapExceeded` for an over-cap leg, and the whole deposit reverts.
- `_executeLeg` re-checks registry status (`VaultNotActive`) and router eligibility (`_requireRouterEligible`) before each deposited leg, as defence in depth.
- A vault's own deposit gate counts too (QA plan D4). `_isDepositable` reads the vault's `maxDeposit`: a deposit pause (`BasketVault.depositsPaused`, the `EMERGENCY_ROLE` `pauseDeposits()`), `shutdown`, retirement, a full TVL cap or an open rmUSDC exclusion reads 0, and a reverting `maxDeposit` counts as 0. Each funded leg is then quoted with `previewDeposit` at its split amount. A reverting quote (rmAGENT on a stale price recorder) drops the leg, and the split reruns over the survivors. `previewDeposit` reports the same legs unavailable.
- A basket outside its ORA-4 band is skipped, not reverted: `BasketVault.previewDeposit` runs the same spot-versus-TWAP guard as `deposit` (security round 1), so the quote pass drops the leg. `maxDeposit` and `maxMint` do not run it and never revert.
- The rmUSDC allocator stops at a Morpho adapter's `maxExposure` and leaves what no adapter can take idle (`UnroutedDeposit`), so the exposure cap never reverts the rmUSDC leg (security round 1).
- A lending venue that refuses a supply (Aave supply cap or frozen reserve, MetaMorpho `AllCapsReached`, Comet supply pause) does not revert the rmUSDC leg either: the lending adapter hands the slice back and rmUSDC keeps it idle with `UnroutedDeposit` (security round 2, §3.5). A venue that shuts withdrawals too (Aave reserve paused or inactive, Comet withdraw pause) sets rmUSDC's `maxDeposit` to 0, so the router skips the leg (security round 3).
- A non-zero `minSharesPerLeg[i]` means "fund this leg". A leg the router would skip (unavailable, or computed amount 0) with a non-zero floor reverts the whole deposit `LegSkippedWithFloor(vault)` (security round 2). So a leg that turns unavailable after the caller previewed (rmUSDC reaching its TVL cap, a pause, an open exclusion, a basket leaving its ORA-4 band) never moves its share onto the other legs behind the caller's back. Clients pass 0 for the legs `previewDeposit` reports unavailable or unfunded.
- A leg whose views pass but whose `deposit` reverts still reverts the whole routed deposit `UsdcLegTransferFailed(vault)`. The case left is a basket's realised-swap slippage floor (`DepositBelowSlippageFloor`). The basket deploy script refuses a `NAV_DEVIATION_BPS` at or below any configured pool fee in bps, and rmAGENT's sheet value is 400 against the RM pool's 291 bps fee.

### 9.1.3 Caps and guards

| Guard | Function | Effect |
|---|---|---|
| Global cap | `setRouterCap(uint256)` | Hard ceiling on total USDC per deposit. 0 = uncapped. |
| Per-vault cap | `setVaultCap(address vault, uint256)` | Per-leg ceiling for a single vault. 0 = uncapped. |
| Slippage protection | `minSharesPerLeg[]` parameter to `deposit()` | Revert if any deposited leg returns fewer shares than specified. A skipped leg (unavailable, or computed amount 0) is never called and returns 0 shares, so its floor must be 0: a non-zero floor on it reverts `LegSkippedWithFloor(vault)` (security round 2). Before issue 1746 a 0 bps eligible leg was called with `deposit(0)`; before security round 2 a non-zero floor on a skipped leg was silently waived. |
| Redeem floor (QA plan D9, SR-M16) | `minAssetsPerLeg[]` parameter to `redeemFor()` | Revert `SlippageExceeded` if a leg pays less USDC than its floor; a floor of 0 sends none. A direct `vault.redeem` has no minimum-out, and a BasketVault's own sale floor follows a dragged TWAP (core 1793), so it pays under the holder's quote without reverting. A single-vault exit with a floor is the one-leg `redeemFor(holder, holder, [vault], [shares], [floor], deadline)`, after an approval of exactly `shares` to the router that the redeem spends to zero (the dapp Withdraw tab). The gateway has no withdrawal path and rmpc sends no withdrawal (owner decision 2026-10-19, issue 1889). Test: `PortfolioRouterRedeemFloor.t.sol::test_redeemFor_singleLegFloorBindsOnBasketVault`. |
| Asset verification | `VaultAssetMismatch` error | Revert if a vault's `asset()` is not the router's USDC. |
| Vault status check | `_isDepositable`; `VaultNotActive` error | A leg that is not `Active` in the registry (or not router-eligible) is skipped and its share renormalised. `_executeLeg` reverts `VaultNotActive` only if the status changed between the availability pass and the leg. |
| Per-leg transfer failure | `UsdcLegTransferFailed(address vault)` error | Wrap a reverting `vault.deposit()` (e.g. a USDC blacklist hit or fee-on-transfer failure) in a named per-leg error so callers can distinguish it from the generic custody check. |
| Donation-DoS snapshot | `usdcBalanceBefore` balance snapshot | Snapshot the router's USDC balance before pulling the caller's deposit so pre-existing donated USDC cannot trigger a false custody-invariant revert. |

### 9.1.4 Key functions

| Function | Role | Effect |
|---|---|---|
| `deposit(uint256 amount, uint256[] minSharesPerLeg)` | anyone | Skip non-depositable legs, split the full amount pro rata across the rest, call vault.deposit per leg, return shares per leg. All-or-revert across the legs that run; reverts `NoWeightsSet` when no leg is depositable. |
| `setWeights(address[] vaults, uint256[] bps)` | `WEIGHT_SETTER_ROLE` (RouterGovernance) | Set the active weight vector. Overwrites the current active weights and sets `votedWeightsActive = true`. Reverts `DuplicateVault` on a repeated vault. No function clears the active vector or resets it to the default: a newer receipt replaces it (issue 1988, ADR-0002). |
| `setDefaultWeights(address[] vaults, uint256[] bps)` | ADMIN | Update fallback weight vector. Reverts `DuplicateVault` on a repeated vault. |
| `setRouterCap(uint256)` | ADMIN | Set global deposit cap. |
| `setVaultCap(address, uint256)` | ADMIN | Set per-vault leg cap. |
| `previewDeposit(uint256 amount)` | view | Return per-vault estimated shares, weights, net amounts, and per-leg unavailable status without executing. |

### 9.1.5 Key invariants

- **Weight normalization**: Both active and default vectors must sum exactly to `BPS_DENOMINATOR` (10000). `setWeights` and `setDefaultWeights` revert if not.
- **All-or-revert / custody invariant**: No USDC is permanently stranded in the router. The router snapshots its USDC balance into `usdcBalanceBefore` before pulling the caller's deposit, then after all legs run requires the balance to return to that snapshot — reverting `UsdcCustodyInvariantViolated` if any leg accepted less than its allocated `legAmount`. Because the snapshot is taken before the caller's funds are pulled, any pre-existing donated USDC appears in both the before and after snapshots and cannot trigger a false revert (donation-DoS hardening).
- **Per-leg transfer failure**: When a single `vault.deposit()` reverts (e.g. a USDC blacklist hit or a fee-on-transfer failure), the router surfaces the named error `UsdcLegTransferFailed(address vault)` rather than the opaque `UsdcCustodyInvariantViolated` custody check, so off-chain handlers and auditors can decode the specific failing leg.
- **Vault asset consistency**: All weighted vaults must have `asset() == USDC` (the router's configured USDC address). Checked when a vector is written and again before each deposited leg.
- **No implicit fees**: The router charges no fees; all fees (exit fees on vaults, protocol fees) are handled at the vault layer.

---

## 9.2 RouterGovernance

### 9.2.1 Purpose and scope

`RouterGovernance` is the contract that holds `WEIGHT_SETTER_ROLE` on `PortfolioRouter` and the only path by which router weights change. The Safe multisig, through the TimelockController, is the only body that changes any Robot Money contract configuration, router weights included. `WEIGHT_SETTER_ROLE` is the only authority over router weights. It submits the Investment Committee's consensus receipt, and that submission is the rebalance: one timelock call, `RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps)`, releases the receipt and applies its weights (publish-contracts govern row `apply-receipt`, core 1696). There is no voting by token holders or anyone else: no voter set, no voting power, no quorum, no voting period, no execution delay, no propose, vote or execute.

`RouterGovernance` has no propose, vote or execute function and no voting event (issue 1698). The mainnet test deployment ran the earlier bytecode with voter addresses nobody holds. The final deployment's verifier asserts that the runtime code has no voting function.

**Design constraints** (docs/architecture.md §2.3):
- Controls router weights only; cannot govern vault internals, agent permissions, or protocol admin operations.
- Exposes the resulting weights for rmpc and dapp reads.
- `ADMIN_ROLE` and `WEIGHT_SETTER_ROLE` (both self-administered) are held by the timelock after stage 11; the deployer holds nothing.
- `RouterGovernance` holds router `ADMIN_ROLE`, router `WEIGHT_SETTER_ROLE` and a narrow release role on the receipt register (`RECEIPT_RELEASER_ROLE` or equivalent), so it can release a receipt in the same call that applies it. The receipt's `ADMIN_ROLE` is held by the timelock alone, which alone grants or revokes `RECEIPT_SUBMITTER_ROLE` (owner decision 2026-10-20; the deployed release v0.5.0 grants `RouterGovernance` the receipt `ADMIN_ROLE` instead).

### 9.2.2 Applying a receipt

1. **Record**: the receipt submitter records the consensus receipt directly with `ConsensusRecommendationReceipt.recordReceipt`. The call reverts `SubmitterNotAllowlisted()` unless the caller holds `RECEIPT_SUBMITTER_ROLE`, and the stored submitter is the caller. No gateway takes part (§1.1).
2. **Schedule**: the Safe schedules one timelock call: `RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps)` with the receipt's weight vector. The govern row checks before sending that the receipt is recorded, its digest equals `keccak256` of the payload, it is not yet released, the bps sum to 10000 and the vault list equals the registry's router-eligible list in order.
3. **Delay**: the timelock delay elapses (172800 s on 8453).
4. **Execute**: the Safe executes the call. `applyReceipt` checks that the receipt is recorded, not released and that `payloadDigest` equals the stored digest. It then calls `releaseReceipt(receiptId)` and `PortfolioRouter.setWeights(vaults, bps)` and emits `ReceiptApplied`. Release and weights land in one call; partial state is impossible.
5. **Read back**: the tool reads `isReleased(receiptId)`, `votedWeightsActive()` and the router's active and effective weights, and fails on any difference.

### 9.2.3 Key functions

| Function | Role | Effect |
|---|---|---|
| `applyReceipt(bytes32 receiptId, bytes32 payloadDigest, address[] vaults, uint256[] bps)` | WEIGHT_SETTER (timelock) | Release a recorded, unreleased receipt whose stored digest equals `payloadDigest`, then call `router.setWeights(vaults, bps)`, in one call. Sets the router's active vector. Emits `ReceiptApplied(receiptId, payloadDigest, vaults, bps)`. Reverts `ReceiptNotRecorded`, `ReceiptAlreadyReleased` or `PayloadDigestMismatch`; any router refusal reverts the whole call. |
| `setDefaultWeights(address[] vaults, uint256[] bps)` | ADMIN (timelock) | Forward to `router.setDefaultWeights`. The router checks the bps sum and that the length equals the registry's router-eligible count. Sets the fallback vector. |
| `currentWeights()` | view | The router's active weight vector (empty until a receipt is applied). |
| `router()`, `receipts()` | view | The immutable `PortfolioRouter` and `ConsensusRecommendationReceipt` addresses. |
| `ADMIN_ROLE`, `WEIGHT_SETTER_ROLE` | constants | Both self-administered. The constructor grants both to `_admin` (the deployer); the timelock stage hands both to the timelock. |

Errors: `ZeroAddress` (a zero constructor argument), `ReceiptNotRecorded(receiptId)`, `ReceiptAlreadyReleased(receiptId)`, `PayloadDigestMismatch(receiptId, stored, given)`.

### 9.2.4 Key invariants

- **One path to weights**: only the holder of `WEIGHT_SETTER_ROLE` can call `PortfolioRouter.setWeights`, and only the timelock can reach `RouterGovernance.applyReceipt` and its admin calls.
- **Atomic rebalance**: a receipt's release and its weights are one call.
- **Timelock delay enforcement**: no weight change lands before the timelock delay elapses.
- **No gateway dependency**: recording a receipt, applying it and setting default weights need no gateway deployed (§1.1).

---

## 9.3 BasketVault (base class) and subclasses

### 9.3.1 BasketVault: abstract USDC → basket

`BasketVault` is an abstract ERC-4626 contract that:
- Accepts USDC deposits and mints ERC-20 share tokens.
- Holds a basket of active ERC-20 assets (configured by ADMIN_ROLE).
- Splits each deposit equally across active basket assets via Uniswap V3 (or adapter-based) single-hop swaps.
- Values NAV (net asset value) in USDC using a Uniswap V3 TWAP (time-weighted arithmetic-mean tick) over a per-asset, admin-configurable window.
- Swaps each asset back to USDC proportionally on withdrawals.

**NAV calculation** (critical invariant): BasketVault reads TWAP data from `IUniswapV3Pool.observe(secondsAgo)` over the configured window. Slot0 is never consulted on hot paths, making NAV resistant to single-block manipulation. The pool's observation cardinality must be large enough to cover the configured window; otherwise `observe()` reverts ("OLD") and NAV reads fail closed. ADMIN_ROLE is expected to verify cardinality off-chain before raising the window.

### 9.3.2 Asset registry and swap adapters

BasketVault maintains an ordered list of active basket assets. Each asset has:

- **token**: ERC-20 address (e.g. wETH, cbBTC, USDC-alternative).
- **pool**: DEX pool pairing the asset with USDC (venue-specific).
- **swapFee**: Fee parameter (e.g. Uniswap V3 fee tier 0.01%, 0.05%, 0.30%, 1%).
- **adapter**: Optional swap-and-TWAP adapter. `address(0)` falls back to built-in Uniswap V3 routing via `SWAP_ROUTER` (for backward compatibility).
- **venue**: Human-readable enum (V3, V4 reserved and unused, Aerodrome) so governance and monitoring can inspect the DEX choice without decoding the adapter address.
- **active**: Flag toggled by ADMIN_ROLE.

**Swap adapters** (per docs/technical/real-four-vault-demo-seams.md §3, issue #553): Subclasses or ADMIN_ROLE can register custom swap adapters to route swaps through alternative DEXes. All adapters implement `IBasketSwapAdapter`, exposing `swap(inputAmount, minOutputAmount)` and `twapPrice(secondsAgo)` for pricing and swap execution. Three ship: `UniswapV3SwapAdapter`, `UniswapV4SwapAdapter` (core 1676) and `AerodromeSwapAdapter`. The deploy scripts (`BasketVaultDeployBase`) wire venues `UniswapV3` and `UniswapV4`; no deploy script registers `AerodromeSwapAdapter`. `UniswapV4SwapAdapter` swaps through the real V4 PoolManager (`unlock` callback, full PoolKey, hooks zero) and its `twapPrice` accepts only the pool's `UniswapV4PriceRecorder`: a permissionless, admin-free contract with a V3-shaped `observe()` that records the pool tick (one snapshot per block, lagged tick, a clamp of 10 ticks per second, stale after 1800 s). The original V4 adapters were deleted on core PR 1505 and rewritten for 1676; the V4 asset position adapter stays deleted (core 1677).

### 9.3.3 TWAP oracle configuration

| Config | Type | Min | Max | Default | Effect |
|---|---|---|---|---|---|
| `twapWindow` (per asset) | uint32 | `MIN_TWAP_WINDOW` (600s) | `MAX_TWAP_WINDOW` (86400s) | `DEFAULT_TWAP_WINDOW` (1800s) | Seconds of TWAP history for NAV and swap-minimum pricing. `setTwapWindow` refuses a window longer than the pool's observation history (`InsufficientObservationHistory(pool, window)`). |

Newly registered assets use `DEFAULT_TWAP_WINDOW` until ADMIN_ROLE raises or lowers the window per asset within `[MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]`. Governance cannot set a window the pool's oldest observation does not reach: such a window would make every NAV read revert and block every redeem (core 1494). See docs/technical/security-model.md §5 for TWAP-oracle failure modes and the emergency-unwind path.

### 9.3.4 Deposit and withdrawal flow

**Deposit**: `deposit(amount, receiver)` (ERC-4626 standard):
1. Check TVL and per-deposit caps.
2. Compute equal split across active assets: `assetAmount[i] = amount / activeAssetCount`.
3. For each active asset, swap USDC → asset via the adapter or SWAP_ROUTER, using TWAP-derived minimum output.
4. Mint ERC-4626 shares to the receiver: `shares = convertToShares(assets)`.

**Withdraw/Redeem** (ERC-4626 standard):
1. Redeem shares to compute USDC owed (ERC-4626 formula).
2. For each active asset, swap asset → USDC proportionally to the asset balance (pull necessary basket assets and swap back).
3. Charge exit fee (configurable up to `MAX_EXIT_FEE_BPS = 100`, i.e. 1%).
4. Deliver net USDC to the receiver.

### 9.3.5 Access control and emergency paths

| Role | Powers |
|---|---|
| ADMIN_ROLE | Add/remove/activate assets, set TWAP windows, adjust TVL and per-deposit caps, set exit fee (max 1%), set fee recipient, set max slippage, `unpauseDeposits()` (also clears the deposit halt `emergencyUnwind` sets), set the emergency-unwind guard. |
| EMERGENCY_ROLE | `pauseDeposits()` (blocks new deposits only; `redeem` stays open, core 1494), `shutdownVault()`, and `emergencyUnwind()` to liquidate the basket in a fast path if normal withdrawal is blocked (oracle failure, liquidity crash). Each leg is floored at its TWAP value less `maxSlippageBps`, or at the configured `minUsdcOut` when that is higher; with no oracle the configured floor is required. `emergencyUnwindWithOverride()` is oracle-independent and allowed only if loss is within `maxLossBps` of the configured `minUsdcOut`. |

### 9.3.6 Subclasses: ProtocolAssetVault, AgentTokenVault, RwaBasketVault

| Subclass | Share symbol | Basket composition | Status | Use case |
|---|---|---|---|---|
| **ProtocolAssetVault** | rmPROTO | Volatile protocol assets (wETH, cbBTC on Base). | Prototype (not audited) | Exposure to Base protocol ecosystem assets. |
| **AgentTokenVault** | rmAGENT | Retired (ADR-0017): withdraw-only on the live v0.5.0 line, not deployed by v0.6.0. The code stays for the retired vault and for any future agent-token vault. | Prototype (not audited) | Agent incentive and governance participation. |
| **RwaBasketVault** | rmRWA | deSPXA, one plain basket row. | Prototype (not audited) | Diversification into real-world collateral. |

All three subclasses inherit BasketVault behavior and are configured with:
- Vault name and share symbol.
- Max basket size (e.g. 10 assets for ProtocolAssetVault).
- Default slippage BPS (e.g. 100 BPS = 1% for ProtocolAssetVault).

### 9.3.7 Key invariants and constraints

- **Small basket positions (core 1778)**: a position worth a few cents can leave a basket leg of a handful of token base units (rmPROTO on Deploy 2: 31 cbBTC units). The pool's one-unit rounding then misses the 1 percent floor and the USDC `redeem` reverts `Too little received`. The supported exit is `redeemInKind(shares, receiver, owner)`, which pays the basket tokens and swaps nothing. The dapp shows this hint when a redeem simulation fails with that reason. The cause and the fix are in [redeem-gas-1482.md](redeem-gas-1482.md).
- **Dust legs (QA plan v1 D6, SR-L12)**: a basket leg whose TWAP sale floor (value × (1 − `maxSlippageBps`)) rounds to zero USDC units is dust, worth about one USDC unit or less. `redeem` and `emergencyUnwind` skip it, `removeAsset` accepts it, `reabsorbRemovedAsset` leaves it in place, and the USDC sell anchor does not refuse a redeem over it. Without this, one wei of RM sent after an unwind blocked `emergencyUnwind` and `removeAsset` (`AssetStillHeld`) forever, because the V4 adapter refuses a sale that pays zero. `removeAsset` prices a non-zero balance, so it fails closed while the oracle is down.
- **NAV closure on oracle failure**: If `observe()` reverts (cardinality too low for the configured window), NAV reads fail closed and normal deposits/withdrawals revert. `redeemInKind(shares, receiver, owner)` is the oracle-free holder exit (core 1665): pro-rata idle USDC and active basket tokens less `exitFeeBps`, no TWAP, no swap. Emergency unwind is the only escape path (ADMIN_ROLE must have pre-configured `emergencyUnwindGuard` with a fallback floor and loss tolerance). The Safe sets it through the timelock with `govern --row set-unwind-guard` (QA plan v1 D7), one round per basket in the stage 13 sitting, and the stage 12 verifier fails an open basket whose active asset reads a zero `minUsdcOut`.
- **Slippage protection**: Deposits and swaps enforce admin-set `maxSlippageBps` (max 500 BPS = 5%). ADMIN_ROLE may tighten but not exceed this hard ceiling.
- **Proportional withdrawal**: Withdrawals pull from each active asset proportionally to balance; no rebalancing occurs on withdrawal.
- **Equal-weight deposit split** (current): Each deposit splits equally across active assets. Future versions may allow weight vectors (not yet shipped).
- **No oracle-based frontrunning**: TWAP is arithmetic-mean tick over a window (not spot price), making it resistant to single-block manipulation on slow-moving assets.
- **Exit fee fixed ceiling**: Like RobotMoneyVault, `MAX_EXIT_FEE_BPS = 100` (1%) is a `constant` (ADR-0014 §2: constants stay constants); setters and `initialize` revert above this.

### 9.3.8 Deployed basket vaults

See §2.3 for mainnet and devnet addresses. All basket vaults are currently prototype/devnet; production deployment and mainnet routing through PortfolioRouter are planned per docs/prd.md §11.

---

## 10. References

- Source files: [`../../contracts/`](../../contracts/)
- BaseScan vault: https://basescan.org/address/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd
