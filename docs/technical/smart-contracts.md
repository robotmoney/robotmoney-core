# Robot Money — Smart Contract Reference

> This is a hand-curated overview (system diagram, roles, caps, and how the
> pieces fit). For the generated per-contract / per-symbol NatSpec reference,
> see `contracts/doc/` (produced by `forge doc`).

> Scope: verified source code for all Robot Money smart contracts deployed on Base mainnet. The main production vaults are RobotMoneyVault and the basket-vault family (BasketVault base class with ProtocolAssetVault, AgentTokenVault, and RwaVault subclasses). Allocation and governance infrastructure includes VaultRegistry, PortfolioRouter, and RouterGovernance. All contracts are verified on BaseScan. Source files are in `contracts/` at the repo root. Compiler: `v0.8.24+commit.e11b9ed9`, optimization 200 runs, EVM Cancun. The previous version of this document was a reverse-engineering exercise from ABIs; this version is authoritative from source.

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
        │                   │ │ • RwaVault       │ │   from Router- │
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
        │              ADMIN_ROLE (MVP → token-holder voting future)   │
        └────────────────────────────────────────────────────────────────┘
```

**Allocation flow**: Humans and agents deposit USDC either directly to a vault (RobotMoneyVault or a BasketVault) or through PortfolioRouter, which splits the deposit across multiple vaults by admin-set or governance-voted weights. VaultRegistry provides the single source of truth for vault discovery and router eligibility. RouterGovernance (MVP) creates and executes weight proposals.

---

## 2. Deployed addresses (Base mainnet, chain id 8453)

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
| BasketVault (base) | Abstract ERC-4626 USDC → basket asset mix. Subclassed by ProtocolAssetVault, AgentTokenVault, RwaVault. | `contracts/vaults/BasketVault.sol` | N/A (abstract) |
| ProtocolAssetVault | USDC → wETH, cbBTC, wSOL, etc. (volatile protocol assets) | `contracts/vaults/ProtocolAssetVault.sol` | (devnet in demo) |
| AgentTokenVault | USDC → RM governance and agent-earned tokens | `contracts/vaults/AgentTokenVault.sol` | (devnet in demo) |
| RwaVault | USDC → real-world asset tokens | `contracts/vaults/RwaVault.sol` | (devnet in demo) |

### 2.4 Admin and fee recipient

| Account | Address |
|---|---|
| Admin / fee recipient (Safe) | [`0x88bA7364cC6cE5054981d571b33f8fb3E91475A0`](https://basescan.org/address/0x88bA7364cC6cE5054981d571b33f8fb3E91475A0) |

**Notes:**
- RobotMoneyVault and its adapters are direct (non-proxy) deployments on mainnet. CompoundV3Adapter was compiled with `viaIR: true`; the others were not.
- VaultRegistry, PortfolioRouter, RouterGovernance, and basket vaults are currently deployed on devnet with demo seeded state; mainnet deployment is planned per docs/prd.md §11 ("Four-vault demo initiative").
- Basket vault mainnet addresses are intentionally excluded here (out of scope); they will be added once they reach production status and mainnet deployment.

---

## 3. RobotMoneyVault

### 3.1 Inheritance

```
RobotMoneyVault
  ├── ERC4626   (OpenZeppelin v5 — ERC-20 shares + ERC-4626 accounting)
  ├── AccessControl (three roles: ADMIN, EMERGENCY, KEEPER)
  ├── Pausable
  └── ReentrancyGuard
```

### 3.2 Access control roles

| Role | Keccak | Granted at deploy | Powers |
|---|---|---|---|
| `ADMIN_ROLE` | `keccak256("ADMIN_ROLE")` | `_admin` constructor arg | Add/remove/reconfigure adapters, set caps/fees, `rescueTokens`, `rebalance`, `adminRebalance`, `setMaxRebalanceBps`, `setMinRebalanceInterval` |
| `EMERGENCY_ROLE` | `keccak256("EMERGENCY_ROLE")` | `_admin` constructor arg | `pause`, `unpause`, `emergencyWithdraw`, `emergencyWithdrawAdapter`, `forceRemoveAdapter`, `shutdownVault` |
| `KEEPER_ROLE` | `keccak256("KEEPER_ROLE")` | **Not granted at launch** | `rebalance` |

`ADMIN_ROLE` is its own admin (can grant/revoke itself). In production, the constructor arg is the Safe multisig `0x88bA…75A0`.

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

- Charged on every `withdraw` and `redeem`.
- `previewRedeem(shares)` → `gross × (1 − exitFeeBps/10000)` — returns **net** USDC.
- `previewWithdraw(assets)` → shares required for `assets` **net** — converts net to gross first (`assets × 10000 / (10000 − exitFeeBps)`), then shares.
- Fee is `safeTransfer`-ed to `feeRecipient` before the net amount goes to the receiver.
- `_withdraw` handles both `redeem` and `withdraw` paths via the same function — shares are burned, fee is separated from gross, fee transferred to recipient, net transferred to receiver.

### 3.8 Emergency functions

| Function | Role | Effect |
|---|---|---|
| `pause()` | EMERGENCY | `whenNotPaused` blocks `deposit`, `withdraw`, `redeem`, `rebalance` |
| `unpause()` | EMERGENCY | Reverses pause |
| `emergencyWithdraw()` | EMERGENCY | Pauses vault, then tries `withdraw(balance)` on every active adapter with a `try/catch` — failures are logged but do not revert |
| `emergencyWithdrawAdapter(i)` | EMERGENCY | Same for a single adapter index |
| `forceRemoveAdapter(i)` | EMERGENCY | Marks adapter inactive regardless of balance (accepts loss) — emits `AdapterForceRemoved(i, addr, lossAmount)` |
| `shutdownVault()` | EMERGENCY | Sets `shutdown = true`, `tvlCap = 0`. Deposits revert with `VaultShutdown()`; withdrawals continue. Recoverable by ADMIN via `restoreVault` (see below). |

`shutdownVault()` is not permanent. It is reversed by `restoreVault(uint256 newTvlCap)`,
an **ADMIN**-only recovery path. The asymmetry mirrors `pause`/`unpause`: a
compromised emergency hot key can DoS deposits, but only the higher-trust admin
role can re-open the vault. Because `shutdownVault` zeroes `tvlCap`, the admin
must supply a fresh cap rather than silently reusing a stale value:

| Function | Role | Effect |
|---|---|---|
| `restoreVault(uint256 newTvlCap)` | ADMIN | Reverts with `NotShutdown()` unless `shutdown == true`. Requires `newTvlCap > 0` (else `InvalidCap()`) and `perDepositCap <= newTvlCap` (else `InvalidParam()`). Clears `shutdown`, sets `tvlCap = newTvlCap`, emits `VaultRestored(newTvlCap)` and `TvlCapUpdated(old, newTvlCap)`. Deposits resume under the new cap. |

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
    function rescueTokens(address token, address to) external;
}
```

All three gate every mutating function with `onlyVault` — a simple `msg.sender == VAULT` check against the immutable constructor argument.

All three expose public immutables: `USDC`, `VAULT`, and their protocol-specific contract (`MORPHO_VAULT`, `POOL`/`A_TOKEN`, `COMET`).

All three implement `rescueTokens` that explicitly protects USDC and the protocol receipt token from being swept.

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
| Token rescue | `rescueTokens` on vault explicitly rejects `asset()` and `address(this)`. Adapter `rescueTokens` rejects USDC and the protocol receipt token |

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
| "Two emergency switches: paused + shutdown" | Confirmed. `shutdownVault` also zeroes `tvlCap` |
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
| `rescueTokens(address, address)` | ADMIN | Sweep non-USDC tokens |
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

**Minimum seed amount:** 1,000 USDC (1,000 × 10^6 = `1_000_000_000`).

**Steps:**

1. Deploy `RobotMoneyVault` (and adapter contracts).
2. Register at least one active adapter via `addAdapter`.
3. Approve the vault to spend USDC from the admin/deployer address:
   ```solidity
   USDC.approve(address(vault), 1_000_000_000);
   ```
4. Call `vault.deposit(1_000_000_000, adminAddress)` from the admin/deployer account.
5. Verify `vault.totalAssets() >= 1_000_000_000` and `vault.totalSupply() > 0`.
6. Only after steps 1–5 are confirmed: open the vault to the public (e.g. increase `tvlCap`, publish the vault address, authorize agents).

The seed deposit is not recoverable through normal channels (it is locked as vault shares). Consider it a permanent operational cost of the deployment. The seeding admin receives rmUSDC shares proportional to the seed and can participate in future withdrawals.

**CI enforcement:** `contracts/script/Deploy.s.sol` encodes this runbook step as code: the `run()` (broadcast) entrypoint performs the seed deposit inline after adapter registration, and the new `runInProcessWithSeed()` variant does the same for fork tests. `contracts/test/DeploySeedDeposit.t.sol` (`DeploySeedDeposit`) is the fork-level CI gate — it asserts `vault.totalAssets() >= 1_000_000_000` and `vault.totalSupply() > 0` before any public deposit and is wired into the `forge-fork-vault-regressions` job in `.github/workflows/suite-01-02-forge-tests.yml`.

---

## 9. VaultRegistry

### 9.1 Purpose and access model

`VaultRegistry` is the on-chain registry of authorized Robot Money vaults. It serves as the single source of truth for:

- **Vault discovery**: Clients (rmpc, dapp, indexer) enumerate all registered vaults via `listVaults()`.
- **Lifecycle status**: Each vault is marked `Active`, `Paused`, or `Retired` (withdraw-only); `PortfolioRouter` routes deposits only to `Active` vaults.
- **Router eligibility**: ADMIN_ROLE flags which vaults have cleared production-readiness gating (audit, oracle hardening) and may be weighted by `PortfolioRouter`. This flag is state, not a code variant—the same contracts deploy into test, demo, and mainnet; only the registry flag's value differs (per `docs/development/single-production-codebase.md`).

Access model: `ADMIN_ROLE` is self-administered (its own role-admin). The deployer is the initial admin.

### 9.2 Key functions

| Function | Role | Effect |
|---|---|---|
| `registerVault(address vault, VaultMetadata)` | ADMIN | Register a new vault with metadata (name, asset address). Vault starts `Active`. |
| `setVaultStatus(address vault, VaultStatus)` | ADMIN | Transition vault status (Active ↔ Paused ↔ Retired). No forced migration; retiring is withdraw-only. |
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
2. Checks VaultRegistry for vault status and router eligibility.
3. Computes USDC leg amounts: `legAmount[i] = amount × weight[i] / 10000`.
4. Calls `vault.deposit(legAmount[i], depositor)` for each leg.
5. Emits `RouterDeposit` per leg and returns arrays of vault addresses and shares minted.

All legs execute atomically; if any leg reverts, the entire deposit reverts (all-or-revert).

### 9.1.2 Weight vectors and governance integration

The router maintains two weight vectors:

- **Voted weights**: Set by `RouterGovernance` on proposal execution via `setWeights(vaults, bps)`. Only one governance proposal active at a time. If the voted vector is active, it is the source of truth.
- **Default weights**: Admin-set fallback via `setDefaultWeights(vaults, bps)`. Used when no voted proposal is active (`votedWeightsActive = false`). Survives proposal execution unchanged, providing a below-quorum safety fallback (ADR-0002).

The router never deposits into an ineligible vault: before each leg, it checks `VaultRegistry.isRouterEligible(vault)`.

### 9.1.3 Caps and guards

| Guard | Function | Effect |
|---|---|---|
| Global cap | `setRouterCap(uint256)` | Hard ceiling on total USDC per deposit. 0 = uncapped. |
| Per-vault cap | `setVaultCap(address vault, uint256)` | Per-leg ceiling for a single vault. 0 = uncapped. |
| Slippage protection | `minSharesPerLeg[]` parameter to `deposit()` | Revert if any leg returns fewer shares than specified. |
| Asset verification | `VaultAssetMismatch` error | Revert if a vault's `asset()` is not the router's USDC. |
| Vault status check | `VaultNotActive` error | Revert if any leg is not `Active` in the registry. |

### 9.1.4 Key functions

| Function | Role | Effect |
|---|---|---|
| `deposit(uint256 amount, uint256[] minSharesPerLeg)` | anyone | Split amount by active weights, call vault.deposit per leg, return shares per leg. All-or-revert. |
| `setWeights(address[] vaults, uint256[] bps)` | called by RouterGovernance only | Set voted weight vector. Overwrites current voted weights and sets `votedWeightsActive = true`. |
| `clearVotedWeights()` | ADMIN | Deactivate the voted vector; revert to default weights. |
| `setDefaultWeights(address[] vaults, uint256[] bps)` | ADMIN | Update fallback weight vector. |
| `setRouterCap(uint256)` | ADMIN | Set global deposit cap. |
| `setVaultCap(address, uint256)` | ADMIN | Set per-vault leg cap. |
| `previewDeposit(uint256 amount)` | view | Return per-vault estimated shares, weights, net amounts, and per-leg unavailable status without executing. |

### 9.1.5 Key invariants

- **Weight normalization**: Both voted and default vectors must sum exactly to `BPS_DENOMINATOR` (10000). `setWeights` and `setDefaultWeights` revert if not.
- **All-or-revert**: No USDC is permanently stranded in the router; if any leg undershoots its target, the entire deposit reverts with `UsdcCustodyInvariantViolated`.
- **Vault asset consistency**: All weighted vaults must have `asset() == USDC` (the router's configured USDC address). Checked before each deposit.
- **No implicit fees**: The router charges no fees; all fees (exit fees on vaults, protocol fees) are handled at the vault layer.

---

## 9.2 RouterGovernance

### 9.2.1 Purpose and MVP scope

`RouterGovernance` is the MVP governance module that controls `PortfolioRouter` weight changes. It creates weight proposals, accepts votes from ADMIN_ROLE-assigned voting power (not token holders; token-holder voting is a future goal), and executes once the voting period ends and quorum is reached after a configured execution delay.

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
- **venue**: Human-readable enum (V3, V4, Aerodrome) so governance and monitoring can inspect the DEX choice without decoding the adapter address.
- **active**: Flag toggled by ADMIN_ROLE.

**Swap adapters** (per docs/technical/real-four-vault-demo-seams.md §3, issue #553): Subclasses or ADMIN_ROLE can register custom swap adapters to route swaps through alternative DEXes (Uniswap V4, Aerodrome CL, etc.). All adapters implement `IBasketSwapAdapter`, exposing `swap(inputAmount, minOutputAmount)` and `twapPrice(secondsAgo)` for pricing and swap execution.

### 9.3.3 TWAP oracle configuration

| Config | Type | Min | Max | Default | Effect |
|---|---|---|---|---|---|
| `twapWindow` (per asset) | uint32 | `MIN_TWAP_WINDOW` (600s) | `MAX_TWAP_WINDOW` (86400s) | `DEFAULT_TWAP_WINDOW` (1800s) | Seconds of TWAP history for NAV and swap-minimum pricing. |

Newly registered assets use `DEFAULT_TWAP_WINDOW` until ADMIN_ROLE raises or lowers the window per asset within `[MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]`. See docs/technical/security-model.md §5 for TWAP-oracle failure modes and the emergency-unwind path.

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
| ADMIN_ROLE | Add/remove/activate assets, set TWAP windows, adjust TVL and per-deposit caps, set exit fee (max 1%), set fee recipient, set max slippage, pause deposits, trigger emergency-unwind. |
| EMERGENCY_ROLE | `emergencyUnwind()` to liquidate the basket in a lossy, fast path (no slippage limit) if normal withdrawal is blocked (oracle failure, liquidity crash). Override allowed only if loss is within `maxLossBps` of the oracle-derived floor. |

### 9.3.6 Subclasses: ProtocolAssetVault, AgentTokenVault, RwaVault

| Subclass | Share symbol | Basket composition | Status | Use case |
|---|---|---|---|---|
| **ProtocolAssetVault** | rmPROTO | Volatile protocol assets (wETH, cbBTC, wSOL on Base). | Prototype (not audited) | Exposure to Base protocol ecosystem assets. |
| **AgentTokenVault** | rmAGT | RM governance token and agent-earned tokens. | Prototype (not audited) | Agent incentive and governance participation. |
| **RwaVault** | rmRWA | Real-world asset tokens. | Prototype (not audited) | Diversification into real-world collateral. |

All three subclasses inherit BasketVault behavior and are configured with:
- Vault name and share symbol.
- Max basket size (e.g. 10 assets for ProtocolAssetVault).
- Default slippage BPS (e.g. 100 BPS = 1% for ProtocolAssetVault).

### 9.3.7 Key invariants and constraints

- **NAV closure on oracle failure**: If `observe()` reverts (cardinality too low for the configured window), NAV reads fail closed and normal deposits/withdrawals revert. Emergency unwind is the only escape path (ADMIN_ROLE must have pre-configured `emergencyUnwindGuard` with a fallback floor and loss tolerance).
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
