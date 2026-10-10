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
        │ • Morpho Adapter  │ │   Vault          │ │ • Reads weights│
        │ • Aave Adapter    │ │ • AgentToken     │ │   from Registry│
        │ • Compound Adapter│ │   Vault          │ │ • Reads votes  │
        │                   │ │ • RwaBasketVault │ │   from Router- │
        │ ERC-4626 shares   │ │                  │ │   Governance   │
        │ (rmUSDC)          │ │ ERC-4626 shares  │ │                │
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
        │              • Proposal lifecycle                              │
        │              • Vote tabulation                                 │
        │              • Weight execution to PortfolioRouter            │
        │              • Admin-assigned voting power (MVP)              │
        │                                                               │
        │              ADMIN_ROLE (no token-based governance)          │
        └────────────────────────────────────────────────────────────────┘
```

**Allocation flow**: Humans and agents deposit USDC either directly to a vault (RobotMoneyVault or a BasketVault) or through PortfolioRouter, which splits the deposit across multiple vaults by admin-set or governance-voted weights. VaultRegistry provides the single source of truth for vault discovery and router eligibility. RouterGovernance (MVP) creates and executes weight proposals.

---

## 2. Deployed addresses (Base mainnet, chain id 8453)

> **Retired v1, tests never read it.** The addresses in this section document the retired v1 production deployment for history only. No test, script or CI job reads the live v1 vault. Every test deploys its own vault from our scripts onto the Twin chain (a pinned lazy fork of real Base state, core 1498, 1496).

> **v1 vault control status (default pending owner confirmation).** The v1
> vault was deployed with the Safe `0x88bA…75A0` as the `_admin` constructor
> argument (§2.4, §5 role table), so its `ADMIN_ROLE` and `EMERGENCY_ROLE` follow
> that constructor argument, not a `TimelockController`. `DeployTimelock.s.sol`
> hands over only the vaults listed in `VAULT_ADDRESSES` for the launch run, and
> the launch plan (devops issue 72) deploys four new vaults (rmUSDC, rmPROTO,
> rmAGENT, rmRWA) behind the timelock. Whether to migrate the v1 vault behind a
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
| AgentTokenVault | USDC → RM, the live ROBOTMONEY token `0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3` (nothing deploys an RM mock). RM's venue is decided (owner, 2026-10-08; supersedes 2026-10-06): the Uniswap V4 RM/USDC pool with fee 2.91% (id `0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391`), traded through `UniswapV4SwapAdapter` and priced by the permissionless `UniswapV4PriceRecorder` (sufficient for the Base mainnet test, not the final deployment; `perDepositCap` and `tvlCap` stay below the pool depth). RM is the only entry in `config/agent-token-shortlist.json` (core 1554), pinned by token code hash | `contracts/vaults/AgentTokenVault.sol` | set at the mainnet deploy |
| RwaBasketVault | USDC → deSPXA, a plain basket row priced from its fee 500 pool TWAP | `contracts/vaults/RwaBasketVault.sol` | set at the mainnet deploy |

### 2.4 Admin and fee recipient

| Account | Address |
|---|---|
| Admin / fee recipient (Safe) | [`0x88bA7364cC6cE5054981d571b33f8fb3E91475A0`](https://basescan.org/address/0x88bA7364cC6cE5054981d571b33f8fb3E91475A0) |

**Notes:**
- RobotMoneyVault and its adapters are direct (non-proxy) deployments on mainnet. CompoundV3Adapter was compiled with `viaIR: true`; the others were not.
- VaultRegistry, PortfolioRouter, RouterGovernance, and basket vaults are deployed to Base mainnet by the publish-contracts CLI (`publish-contracts/`). The demo deploy path is retired.
- Basket vault mainnet addresses are intentionally excluded here (out of scope); they will be added once they reach production status and mainnet deployment.

---

## 3. RobotMoneyVault

### 3.1 Inheritance

```
RobotMoneyVault
  ├── ERC4626   (OpenZeppelin v5 — ERC-20 shares + ERC-4626 accounting)
  ├── AccessControl (three roles: ADMIN, EMERGENCY, KEEPER)
  └── ReentrancyGuard
```

The deposit pause is the vault's own `depositsPaused` flag, not OZ Pausable (core 1494). The deployed v1 vault predates this and still inherits OZ Pausable.

### 3.2 Access control roles

| Role | Keccak | Granted at deploy | Powers |
|---|---|---|---|
| `ADMIN_ROLE` | `keccak256("ADMIN_ROLE")` | `_admin` constructor arg | Add/remove/reconfigure adapters, set caps/fees (governance-gated, INV-3: ADMIN_ROLE is held by the TimelockController on the launch vaults; the retired v1 vault is the exception, see §2), `rebalance`, `adminRebalance`, `setMaxRebalanceBps`, `setMinRebalanceInterval`. **No** `rescueTokens` — arbitrary-recipient rescue is deleted (INV-1); the only token movement is the permissionless `sweepForeignToken` |
| `EMERGENCY_ROLE` | `keccak256("EMERGENCY_ROLE")` | `_admin` constructor arg | `pauseDeposits`, `emergencyWithdraw`, `emergencyWithdrawAdapter`, `forceRemoveAdapter`, `shutdownVault`. `unpauseDeposits` is `ADMIN_ROLE` only. |
| `KEEPER_ROLE` | `keccak256("KEEPER_ROLE")` | **Not granted at launch** | `rebalance` |

`ADMIN_ROLE` is its own admin (can grant/revoke itself). For the retired v1 vault, the constructor arg is the Safe multisig `0x88bA…75A0`. For the launch vaults, stage 11 moves `ADMIN_ROLE` to the timelock and `EMERGENCY_ROLE` to the independent emergency key.

### 3.3 Immutable constants (cannot be changed by any role)

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
| `tvlCap` | constructor arg | `setTvlCap` (ADMIN), `restoreVault` (ADMIN) | Hard cap on `totalAssets`; `shutdownVault` sets to 0, `restoreVault(newTvlCap)` sets a fresh cap |
| `perDepositCap` | constructor arg | `setPerDepositCap` (ADMIN) | Per-call `deposit` ceiling |
| `exitFeeBps` | constructor arg (≤ 100) | `setExitFeeBps` (ADMIN) | Charged on redeem/withdraw; max 1% |
| `feeRecipient` | constructor arg | `setFeeRecipient` (ADMIN) | Receives exit fees |
| `adapterAllowed` | false for every address | `setAdapterAllowed` (ADMIN) | Exact adapter instances the Safe-governed admin process has approved for onboarding and future allocation |
| `adapterCodeHashAllowed` | false for every hash | `setAdapterCodeHashAllowed` (ADMIN) | Runtime bytecode hashes approved for adapter implementation identity checks |
| `shutdown` | `false` | `shutdownVault` (EMERGENCY), `restoreVault` (ADMIN) | While true, `deposit` reverts; recoverable — `restoreVault(newTvlCap)` (ADMIN) clears it and re-opens deposits |
| `maxRebalanceBpsPerCall` | 2500 (25%) | `setMaxRebalanceBpsPerCall` (ADMIN) | Throttle per `rebalance()` call |
| `minRebalanceInterval` | 12 hours | `setMinRebalanceInterval` (ADMIN) | Minimum time between rebalances |

Adapter onboarding is now a two-step Safe-governed process: governance first
approves both the exact adapter address and its runtime `codehash`, then calls
`addAdapter`. `addAdapter` also verifies the adapter reports this vault's USDC
asset through `USDC()` and this vault address through `VAULT()`. Deposit,
keeper rebalance, and admin rebalance allocation paths re-check eligibility
before USDC leaves the vault; emergency withdrawal and force removal remain
available for already-active adapters after approval is revoked.

### 3.5 Adapter routing — deposit

`_routeDeposit` uses a two-pass algorithm:

**Pass 1 — fill deficits to `min(targetBps, capBps)`:**  
For each active adapter, compute `effectiveTarget = min(capBps, equalWeightBps)`. Allocate deficit up to remaining amount.

**Pass 2 — spread leftover into cap headroom:**  
Any funds not allocated in Pass 1 (e.g. when an adapter hits its `capBps`) are spread across adapters that still have cap headroom.

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
| `unpauseDeposits()` | ADMIN (timelock) | Clears `depositsPaused` and emits `DepositsUnpaused(account)`. Also clears the deposit halt the three functions below set. |
| `emergencyWithdraw()` | EMERGENCY | Pauses deposits, then tries `withdraw(balance)` on every active adapter with a `try/catch` — failures are logged but do not revert |
| `emergencyWithdrawAdapter(i)` | EMERGENCY | Same for a single adapter index. Withdrawals stay open. |
| `forceRemoveAdapter(i)` | EMERGENCY | Marks adapter inactive regardless of balance (accepts loss) — emits `AdapterForceRemoved(i, addr, lossAmount)` |
| `shutdownVault()` | EMERGENCY | Sets `shutdown = true`, `tvlCap = 0`. Deposits revert with `VaultShutdown()`; withdrawals continue. Recoverable by ADMIN via `restoreVault` (see below). |

`shutdownVault()` is not permanent. It is reversed by `restoreVault(uint256 newTvlCap)`,
an **ADMIN**-only recovery path. The asymmetry mirrors `pauseDeposits`/`unpauseDeposits`: a
compromised emergency hot key can DoS deposits, but only the higher-trust admin
role can re-open the vault. Because `shutdownVault` zeroes `tvlCap`, the admin
must supply a fresh cap rather than silently reusing a stale value:

| Function | Role | Effect |
|---|---|---|
| `restoreVault(uint256 newTvlCap)` | ADMIN | Reverts with `NotShutdown()` unless `shutdown == true`. Requires `newTvlCap > 0` (else `InvalidCap()`) and `perDepositCap <= newTvlCap` (else `InvalidParam()`). Clears `shutdown`, sets `tvlCap = newTvlCap`, emits `VaultRestored(newTvlCap)` and `TvlCapUpdated(old, newTvlCap)`. Deposits resume under the new cap. |

#### 3.8.1 Pause names (core 1494)

Owner decision 2026-10-05: withdrawals are never frozen. A pause stops new deposits only, and the names say so. This is the one rename table. It covers RobotMoneyVault, the unified `Vault`, the BasketVault family (rmPROTO, rmAGENT, rmRWA), `RobotMoneyGateway` / `IGateway`, `VaultRegistry` and `PortfolioRouter`.

| Old name | New name | Where | On the v1 vault |
|---|---|---|---|
| `pause()` | `pauseDeposits()` | vaults (`EMERGENCY_ROLE`), gateway (`DEPOSIT_PAUSER_ROLE`) | v1 keeps `pause()`, which also freezes withdrawals |
| `unpause()` | `unpauseDeposits()` | vaults and gateway (`ADMIN_ROLE`, the timelock in production) | v1 keeps `unpause()` |
| `paused()` | `depositsPaused()` | vaults and gateway (view) | v1 keeps `paused()` and also has `depositsPaused()` |
| `PAUSER_ROLE` | `DEPOSIT_PAUSER_ROLE` (`keccak256("DEPOSIT_PAUSER_ROLE")`, a new hash) | gateway. The env var `PAUSER_ADDRESS` keeps its name and receives this role. | not a v1 vault name |
| `Paused(address)` / `Unpaused(address)`, `DepositsPausedChanged(bool)`, `DepositsPausedSet(bool)` | `DepositsPaused(address indexed)` / `DepositsUnpaused(address indexed)` | vaults and gateway (events) | v1 keeps `DepositsPausedChanged` |
| `EnforcedPause()`, vault error `DepositsPaused()`, gateway `PausedError()` | `DepositsArePaused()` | `deposit`, `mint`, `depositTo` while paused | v1 keeps error `DepositsPaused()` |
| gateway `NotPaused()` | `DepositsNotPaused()` | gateway `unpauseDeposits()` when not paused | not a v1 vault name |
| `ExpectedPause()` | removed | BasketVault no longer inherits OZ Pausable | not a v1 vault name |
| `withdrawalsPaused`, `WithdrawalsPaused()`, `WithdrawalsPausedChanged`, `setWithdrawalsPaused` | deleted | no current vault has a withdrawal pause | v1 keeps `withdrawalsPaused()` |
| `VaultStatus.Paused` | `VaultStatus.DepositsPaused` (ordinal 1, unchanged) | `VaultRegistry` | not a v1 vault name |
| `VaultPausedForRedeem` | removed | `PortfolioRouter.redeemFor` redeems from a vault in every status | not a v1 vault name |

Gateway `withdraw` and `withdrawFromRouter` do not read the pause. Emergency levers (`emergencyWithdraw`, `emergencyWithdrawAdapter`, `forceRemoveAdapter`, `emergencyUnwind`, `shutdownVault`) set a deposit halt or move funds to idle. They never block an exit.

**The v1 exception.** The deployed v1 RobotMoneyVault (`0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd`, Base mainnet) keeps its old code and the old names. Its v1 `pause()` also freezes withdrawals (it sets v1 `withdrawalsPaused`). Never call `pause()` on v1. The v1 vault has `paused()`, `depositsPaused()` and `withdrawalsPaused()`. Clients read `depositsPaused()`, which exists on v1 and on every current contract.

### 3.9 Rebalance

Two entry points:

- `rebalance()` — callable by ADMIN or KEEPER; throttled by `minRebalanceInterval`; capped at `maxRebalanceBpsPerCall`; pulls from over-allocated adapters, then re-routes idle balance.
- `adminRebalance(uint256[] calldata targetBalances)` — ADMIN only; bypasses throttle; accepts explicit per-adapter target balances.

Both emit `Rebalanced(totalMoved)` and update `lastRebalanceAt`.

Additional read-only helpers: `getAdapterDrift()`, `isRebalanceAvailable()`, `nextRebalanceAt()`.

### 3.10 Management fee

**There is no management fee in the vault contract.** The source contains no fee accrual, no `harvest()`, no `accrueFees()`, no timestamp-based skim. The only fee is the exit fee charged at redeem/withdraw time. The 2% annual management fee advertised on robotmoney.net is off-chain — likely via admin-initiated periodic USDC transfers from `feeRecipient` or from protocol revenue, not from the vault contract itself.

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
| Admin abuse | AccessControl with `ADMIN_ROLE` self-admined; production admin is a Safe multisig. `MAX_EXIT_FEE_BPS = 100` is an immutable ceiling — admin cannot set fees above 1% |
| Emergency misuse | `EMERGENCY_ROLE` is separate from `ADMIN_ROLE` and initially held by the same Safe multisig (both granted in constructor). Both roles can be revoked |
| Malicious adapter onboarding | `addAdapter` requires Safe-governed address approval, runtime `codehash` approval, and adapter `USDC()` / `VAULT()` compatibility checks. Allocation paths re-check the address allowlist before transferring USDC |
| Adapter loss | `forceRemoveAdapter` accepts loss explicitly; `emergencyWithdraw` uses `try/catch` so a broken adapter doesn't block others |
| Reentrancy | `nonReentrant` on `_deposit`, `_withdraw`, `rebalance`, `adminRebalance`, `emergencyWithdraw`, `emergencyWithdrawAdapter` |
| Upgradeability | None — all four contracts are direct, non-proxy deployments. No upgrade path exists |
| Fee ceiling | `MAX_EXIT_FEE_BPS = 100` (1%) is an immutable constant. `setExitFeeBps` reverts above this |
| Rebalance throttle | Keeper-triggered rebalance is throttled: `MIN_REBALANCE_INTERVAL_FLOOR = 1 hour` and `MAX_REBALANCE_BPS_CEILING = 5000` (50%) are immutable floors/ceilings |
| Foreign-token quarantine (INV-1/INV-2) | Arbitrary-recipient rescue is deleted. `sweepForeignToken(token)` is permissionless and moves only NON-protected tokens to the hardcoded `ForeignTokenQuarantine.QUARANTINE` address (never a caller-supplied recipient). The vault sweep rejects `asset()` and `address(this)`; the BasketVault sweep additionally rejects every active/configured basket asset and re-absorbs removed-asset balances into NAV via `reabsorbRemovedAsset`; adapter sweeps reject USDC and the protocol receipt token |

---

## 6. Corrections to prior analysis

The original `smart-contracts.md` was inferred from ABIs. Several claims were wrong or incomplete; source resolves them:

| Prior claim | Actual (from source) |
|---|---|
| "Whether the vault is upgradeable is unknown" | No proxy — direct deployment confirmed |
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
| `setMaxRebalanceBpsPerCall(uint16)` | ADMIN | Adjust rebalance throttle |
| `setMinRebalanceInterval(uint256)` | ADMIN | Adjust rebalance cooldown |
| `emergencyWithdraw()` | EMERGENCY | Pull all adapters |
| `emergencyWithdrawAdapter(uint256)` | EMERGENCY | Pull one adapter |
| `forceRemoveAdapter(uint256)` | EMERGENCY | Write off a broken adapter |
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

### 8.3 Admin seed deposit (deploy runbook)

**Before opening the vault to the public, the deployer MUST perform a seed deposit.**

Rationale: even with `_decimalsOffset() == 18`, a fresh vault with `totalSupply == 0` and `totalAssets == 0` has a share price backed only by virtual shares. The seed deposit ensures that real capital anchors the price before any public depositor arrives.

**Seed amount:** the stage sheet's `SEED_DEPOSIT_USDC` (6-decimal units, must be above 0). The decided production seed is 1 USDC (`1_000_000`), rmUSDC only (runbook D3, 2026-10-01).

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

`PortfolioRouter` is the outer allocation contract. It accepts USDC deposits and routes them proportionally across multiple active Robot Money vaults by admin-set or governance-voted weights. Depositors receive vault receipts directly.

**Deposit mechanics**: A user calls `deposit(uint256 amount, uint256[] minSharesPerLeg[])`. The router:
1. Reads the active weight vector (voted weights if active; otherwise default weights).
2. Marks each leg available or skipped (`_availabilityAndAmounts` / `_isDepositable`): a leg is available only when its registry status is `Active` and it is router-eligible.
3. Splits the full amount across the available legs only, pro rata by bps: `legAmount[i] = amount × weight[i] / availableBps`, where `availableBps` is the sum of the available legs' bps. The rounding remainder goes to the last available leg WITH NON-ZERO BPS, so it never lands on a 0 bps leg. Skipped legs get 0.
4. Calls `vault.deposit(legAmount[i], depositor)` for each available leg whose `legAmount` is non-zero (`_executeLeg`). A leg whose computed amount is 0 (a 0 bps weight, or a small weight that rounds to 0 on a tiny deposit) is skipped like an unavailable leg: no approval, no vault call, no event (issue 1746). Without this, one Active, eligible 0 bps leg such as rmAGENT (whose `deposit(0)` reverts) would revert the whole router deposit over the 9500/500/0/0 launch vector. `previewDeposit` reports such a leg as available with `legAmount` 0 and `estShares` 0.
5. Emits `RouterDeposit` per deposited leg and returns the shares minted per leg (0 for a skipped leg).

The legs that run execute atomically: if any of them reverts, the entire deposit reverts. No USDC is left with the router and none is returned to the user. If no leg is available, the deposit reverts `NoWeightsSet` and the revert undoes the USDC pull. If every computed leg amount is 0 (only a zero-amount deposit, or only 0 bps legs left available), the deposit reverts `NoFundedLeg` and calls no vault. The sum of the leg amounts always equals `amount`, so nothing is stranded. See "Routing eligibility" below and `docs/architecture.md` §4.2.1.

### 9.1.2 Weight vectors and governance integration

The router maintains two weight vectors:

- **Voted weights**: Set by `RouterGovernance` on proposal execution via `setWeights(vaults, bps)`. Only one governance proposal active at a time. If the voted vector is active, it is the source of truth.
- **Default weights**: Admin-set fallback via `setDefaultWeights(vaults, bps)`. Used when no voted proposal is active (`votedWeightsActive = false`). Survives proposal execution unchanged, providing a below-quorum safety fallback (ADR-0002). Its length must equal `VaultRegistry.routerEligibleCount()`.

At deploy, `contracts/script/DeployPortfolioRouter.s.sol` marks rmUSDC router-eligible and writes the initial DEFAULT vector with `setDefaultWeights`: rmUSDC 10000 bps, the only router-eligible vault at that point. It never calls `setWeights`, so `votedWeightsActive` stays false from deploy (issue 1743). The basket stages then flip each basket eligible with one atomic `migrateEligibility`, which re-sets the default to the sheet's launch vector (`ROUTER_WEIGHTS`, rmUSDC 9500, rmPROTO 500, rmAGENT 0, rmRWA 0). The effective routing after the deploy is that launch vector, and the stage 12 verifier asserts both `votedWeightsActive()` false and `getEffectiveWeights()` equal to the sheet. A voted vector written at deploy would override every later default, so a receipt-driven `setDefaultWeights` would not change routing; a router that already carries one is cleared with `govern --row clear-voted-weights` (`RouterGovernance.clearVotedWeights()`, `ADMIN_ROLE`).

The timelock may set default weights only. Active weights come only from RouterGovernance votes: `PortfolioRouter.setWeights` is gated by `WEIGHT_SETTER_ROLE`, held by RouterGovernance, and stage 11 grants the timelock `ADMIN_ROLE` only (core 1522, `docs/technical/governance-decisions.md` §3.6).

#### Routing eligibility

A vault is **eligible for routing** only when its `VaultRegistry` status is `Active`, its registry router-eligible flag is set (`VaultRegistry.isRouterEligible`), and its `asset()` is the router's USDC (`PortfolioRouter.isRouterEligibleAndActive`).

- `setWeights`, `setDefaultWeights` and `applyMigrationDefaultWeights` call `_requireActiveAndEligible` for every listed vault, at any bps, 0 included. An ineligible or non-Active vault cannot be listed even at 0 bps, so it receives 0.
- At deposit time `_availabilityAndAmounts` skips each non-depositable leg and renormalises the full amount pro rata across the remaining legs. Nothing is left with the router or returned to the user. If no leg is depositable, `_depositTo` reverts `NoWeightsSet` and no USDC moves. An eligible leg whose computed amount is 0 is not called (issue 1746).
- Per-vault caps do not renormalise: `_executeLeg` reverts `VaultCapExceeded` for an over-cap leg, and the whole deposit reverts.
- `_executeLeg` re-checks registry status (`VaultNotActive`) and router eligibility (`_requireRouterEligible`) before each deposited leg, as defence in depth.
- **Known gap:** `_isDepositable` does not read a vault's own deposit pause (`BasketVault.depositsPaused`, the `EMERGENCY_ROLE` `pauseDeposits()`, `shutdown`, or `maxDeposit == 0`). A registry-Active, router-eligible vault with deposits paused stays in the available set, its `vault.deposit` reverts, and the whole routed deposit reverts `UsdcLegTransferFailed(vault)`. Not fixed yet.

### 9.1.3 Caps and guards

| Guard | Function | Effect |
|---|---|---|
| Global cap | `setRouterCap(uint256)` | Hard ceiling on total USDC per deposit. 0 = uncapped. |
| Per-vault cap | `setVaultCap(address vault, uint256)` | Per-leg ceiling for a single vault. 0 = uncapped. |
| Slippage protection | `minSharesPerLeg[]` parameter to `deposit()` | Revert if any deposited leg returns fewer shares than specified. The floor is NOT enforced on a skipped leg (unavailable, or computed amount 0): it is never called and returns 0 shares. Before issue 1746 a 0 bps eligible leg was called with `deposit(0)` and a non-zero floor on it tripped. |
| Asset verification | `VaultAssetMismatch` error | Revert if a vault's `asset()` is not the router's USDC. |
| Vault status check | `_isDepositable`; `VaultNotActive` error | A leg that is not `Active` in the registry (or not router-eligible) is skipped and its share renormalised. `_executeLeg` reverts `VaultNotActive` only if the status changed between the availability pass and the leg. |
| Per-leg transfer failure | `UsdcLegTransferFailed(address vault)` error | Wrap a reverting `vault.deposit()` (e.g. a USDC blacklist hit or fee-on-transfer failure) in a named per-leg error so callers can distinguish it from the generic custody check. |
| Donation-DoS snapshot | `usdcBalanceBefore` balance snapshot | Snapshot the router's USDC balance before pulling the caller's deposit so pre-existing donated USDC cannot trigger a false custody-invariant revert. |

### 9.1.4 Key functions

| Function | Role | Effect |
|---|---|---|
| `deposit(uint256 amount, uint256[] minSharesPerLeg)` | anyone | Skip non-depositable legs, split the full amount pro rata across the rest, call vault.deposit per leg, return shares per leg. All-or-revert across the legs that run; reverts `NoWeightsSet` when no leg is depositable. |
| `setWeights(address[] vaults, uint256[] bps)` | RouterGovernance only (not yet implemented: core #1522; today router `ADMIN_ROLE`) | Set voted weight vector. Overwrites current voted weights and sets `votedWeightsActive = true`. |
| `clearVotedWeights()` | ADMIN | Deactivate the voted vector; revert to default weights. |
| `setDefaultWeights(address[] vaults, uint256[] bps)` | ADMIN | Update fallback weight vector. |
| `setRouterCap(uint256)` | ADMIN | Set global deposit cap. |
| `setVaultCap(address, uint256)` | ADMIN | Set per-vault leg cap. |
| `previewDeposit(uint256 amount)` | view | Return per-vault estimated shares, weights, net amounts, and per-leg unavailable status without executing. |

### 9.1.5 Key invariants

- **Weight normalization**: Both voted and default vectors must sum exactly to `BPS_DENOMINATOR` (10000). `setWeights` and `setDefaultWeights` revert if not.
- **All-or-revert / custody invariant**: No USDC is permanently stranded in the router. The router snapshots its USDC balance into `usdcBalanceBefore` before pulling the caller's deposit, then after all legs run requires the balance to return to that snapshot — reverting `UsdcCustodyInvariantViolated` if any leg accepted less than its allocated `legAmount`. Because the snapshot is taken before the caller's funds are pulled, any pre-existing donated USDC appears in both the before and after snapshots and cannot trigger a false revert (donation-DoS hardening).
- **Per-leg transfer failure**: When a single `vault.deposit()` reverts (e.g. a USDC blacklist hit or a fee-on-transfer failure), the router surfaces the named error `UsdcLegTransferFailed(address vault)` rather than the opaque `UsdcCustodyInvariantViolated` custody check, so off-chain handlers and auditors can decode the specific failing leg.
- **Vault asset consistency**: All weighted vaults must have `asset() == USDC` (the router's configured USDC address). Checked when a vector is written and again before each deposited leg.
- **No implicit fees**: The router charges no fees; all fees (exit fees on vaults, protocol fees) are handled at the vault layer.

---

## 9.2 RouterGovernance

### 9.2.1 Purpose and MVP scope

`RouterGovernance` is the MVP governance module that controls `PortfolioRouter` weight changes. It creates weight proposals, accepts votes from ADMIN_ROLE-assigned voting power (not token holders; there is no token-based governance), and executes once the voting period ends and quorum is reached after a configured execution delay.

**Design constraints** (docs/architecture.md §2.3):
- Controls router weights only; cannot govern vault internals, agent permissions, or protocol admin operations.
- Exposes proposal state, vote tallies, cadence metadata, and resulting weights for rmpc and dapp reads.
- One active proposal at a time (simple linear cadence).

### 9.2.2 Proposal lifecycle

1. **Propose** (ADMIN_ROLE): `propose(vaults[], bps[])` creates a new proposal and returns its `proposalId`. Voting starts immediately. The proposal's snapshot block captures voting power; votes cast mid-proposal use checkpointed power at that block.
2. **Vote** (assigned voter): Voters with non-zero voting power call `vote(proposalId)` during the voting window. One vote per voter per proposal (no vote changing).
3. **Defeated** or **Queued**: After the voting period (admin-set duration) expires, the proposal is either `Defeated` (did not reach quorum) or `Queued` (quorum reached, awaiting execution delay).
4. **Execute** (anyone): After the execution delay elapses, anyone calls `execute(proposalId)`, which calls `router.setWeights(...)` with the proposal's vaults and bps.
5. **Executed** or **Cancelled**: The proposal is marked executed, or ADMIN_ROLE can cancel before execution.

### 9.2.3 Voting power and checkpoints

- ADMIN_ROLE assigns voting power to addresses via `setVotingPower(address, uint256)`.
- Voting power is stored as a history of checkpoints `(block, power)`, enabling `getPastVotes(address, blockNumber)` to read power as of the proposal's snapshot block.
- Total voting power is the sum of all assigned powers (`totalVotingPower`).
- Quorum is a fixed threshold: `propose` snapshots the current `quorumThreshold` at proposal time, preventing retroactive defeats or passages if the threshold changes.

### 9.2.4 Key functions

| Function | Role | Effect |
|---|---|---|
| `propose(address[] vaults, uint256[] bps)` | ADMIN | Create a new proposal (only one active/queued at a time) and return its `proposalId`. Validates the weight sum and per-vault router eligibility. Snapshot quorum and voting power block. Start voting period. |
| `vote(uint256 proposalId)` | voting power holder | Cast one vote FOR the proposal. Uses checkpointed power at proposal's snapshot block. |
| `execute(uint256 proposalId)` | anyone | If quorum reached and voting period + execution delay have elapsed, execute via `router.setWeights(...)`. `nonReentrant`. |
| `cancel(uint256 proposalId)` | ADMIN | Cancel any non-executed proposal before execution. Emit `ProposalCancelled`. |
| `setVotingPower(address voter, uint256 power)` | ADMIN | Assign voting power to a voter. Pushes a checkpoint if power changes. |
| `setQuorumThreshold(uint256)` | ADMIN | Set minimum voting power needed for quorum. New proposals use the updated threshold. |
| `setVotingPeriod(uint64 seconds)` | ADMIN | Set voting window duration. Minimum `MIN_VOTING_PERIOD` (1 hour). |
| `setExecutionDelay(uint64 seconds)` | ADMIN | Set delay from voting deadline to earliest execution. Minimum `MIN_EXECUTION_DELAY` (1 hour). |
| `activeProposal()` | view | Return the single active/queued proposal's full state: id, proposer, vaults, bps, deadlines, vote tally, snapshot quorum, and executed/cancelled flags. Reverts if no proposal exists. |
| `proposalState(uint256 proposalId)` | view | Return the proposal's `ProposalState` enum (Active, Defeated, Queued, Executed, Cancelled). |

### 9.2.5 Key invariants

- **One active proposal at a time**: `propose` reverts if a proposal is already active or queued (not yet executed or cancelled).
- **Voting power snapshot immutability**: A proposal's quorum threshold and vote snapshot block are set at proposal time and never change, even if governance parameters are updated later.
- **No vote changing**: A voter can vote once per proposal; `vote` reverts if the voter has already voted.
- **Execution delay enforcement**: A proposal cannot execute until the voting period ends and the execution delay elapses.

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
| EMERGENCY_ROLE | `pauseDeposits()` (blocks new deposits only; `redeem` stays open, core 1494), `shutdownVault()`, and `emergencyUnwind()` to liquidate the basket in a lossy, fast path (no slippage limit) if normal withdrawal is blocked (oracle failure, liquidity crash). Override allowed only if loss is within `maxLossBps` of the oracle-derived floor. |

### 9.3.6 Subclasses: ProtocolAssetVault, AgentTokenVault, RwaBasketVault

| Subclass | Share symbol | Basket composition | Status | Use case |
|---|---|---|---|---|
| **ProtocolAssetVault** | rmPROTO | Volatile protocol assets (wETH, cbBTC on Base). | Prototype (not audited) | Exposure to Base protocol ecosystem assets. |
| **AgentTokenVault** | rmAGENT | RM, the live ROBOTMONEY token. Other agent tokens (BNKR, JUNO) are added later through the timelock. | Prototype (not audited) | Agent incentive and governance participation. |
| **RwaBasketVault** | rmRWA | deSPXA, one plain basket row. | Prototype (not audited) | Diversification into real-world collateral. |

All three subclasses inherit BasketVault behavior and are configured with:
- Vault name and share symbol.
- Max basket size (e.g. 10 assets for ProtocolAssetVault).
- Default slippage BPS (e.g. 100 BPS = 1% for ProtocolAssetVault).

### 9.3.7 Key invariants and constraints

- **NAV closure on oracle failure**: If `observe()` reverts (cardinality too low for the configured window), NAV reads fail closed and normal deposits/withdrawals revert. `redeemInKind(shares, receiver, owner)` is the oracle-free holder exit (core 1665): pro-rata idle USDC and active basket tokens less `exitFeeBps`, no TWAP, no swap. Emergency unwind is the only escape path (ADMIN_ROLE must have pre-configured `emergencyUnwindGuard` with a fallback floor and loss tolerance).
- **Slippage protection**: Deposits and swaps enforce admin-set `maxSlippageBps` (max 500 BPS = 5%). ADMIN_ROLE may tighten but not exceed this hard ceiling.
- **Proportional withdrawal**: Withdrawals pull from each active asset proportionally to balance; no rebalancing occurs on withdrawal.
- **Equal-weight deposit split** (current): Each deposit splits equally across active assets. Future versions may allow weight vectors (not yet shipped).
- **No oracle-based frontrunning**: TWAP is arithmetic-mean tick over a window (not spot price), making it resistant to single-block manipulation on slow-moving assets.
- **Exit fee immutable ceiling**: Like RobotMoneyVault, `MAX_EXIT_FEE_BPS = 100` (1%) is immutable; setters revert above this.

### 9.3.8 Deployed basket vaults

See §2.3 for mainnet and devnet addresses. All basket vaults are currently prototype/devnet; production deployment and mainnet routing through PortfolioRouter are planned per docs/prd.md §11.

---

## 10. References

- Source files: [`../../contracts/`](../../contracts/)
- BaseScan vault: https://basescan.org/address/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd
