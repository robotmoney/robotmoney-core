# Robot Money — Smart Contract Reference

> Scope: verified source code for the four Robot Money contracts deployed on Base mainnet. All contracts are verified on BaseScan. Source files are in `contracts/` at the repo root. Compiler: `v0.8.24+commit.e11b9ed9`, optimization 200 runs, EVM Cancun. The previous version of this document was a reverse-engineering exercise from ABIs; this version is authoritative from source.

---

## 1. System overview

```
                   ┌─────────────────────────────────────────────┐
                   │             RobotMoneyVault                 │
                   │   ERC-4626 · AccessControl · Pausable       │
                   │   ReentrancyGuard                           │
                   │                                             │
                   │   asset = USDC (6 dec), share = rmUSDC      │
                   │   tvlCap · perDepositCap · exitFeeBps ≤ 100 │
                   │   ADMIN_ROLE · EMERGENCY_ROLE · KEEPER_ROLE │
                   └──┬───────────────┬───────────────┬──────────┘
                      │  IStrategyAdapter interface   │
                      │                               │
                ┌─────▼─────┐   ┌─────▼─────┐   ┌───▼────────────┐
                │  Morpho   │   │  Aave V3  │   │  Compound V3   │
                │  Adapter  │   │  Adapter  │   │   Adapter      │
                └─────┬─────┘   └─────┬─────┘   └────────────────┘
                      │               │               │
                ┌─────▼─────┐   ┌─────▼─────┐   ┌───▼────────────┐
                │ Gauntlet  │   │ Aave Pool │   │   Comet        │
                │ USDC Prime│   │  (USDC)   │   │  (cUSDCv3)     │
                └───────────┘   └───────────┘   └────────────────┘
```

The basket leg (VIRTUAL / ROBOT / BNKR / JUNO / ZFI / GIZA) is **not** a contract — it is client-side Uniswap routing. The vault knows nothing about the basket.

---

## 2. Deployed addresses (Base mainnet, chain id 8453)

| Contract | Address | Source file |
|---|---|---|
| RobotMoneyVault | [`0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd`](https://basescan.org/address/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd) | `contracts/RobotMoneyVault.sol` |
| MorphoAdapter | [`0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9`](https://basescan.org/address/0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9) | `contracts/adapters/MorphoAdapter.sol` |
| AaveV3Adapter | [`0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea`](https://basescan.org/address/0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea) | `contracts/adapters/AaveV3Adapter.sol` |
| CompoundV3Adapter | [`0x8247da22a59fce074c102431048d0ce7294c2652`](https://basescan.org/address/0x8247da22a59fce074c102431048d0ce7294c2652) | `contracts/adapters/CompoundV3Adapter.sol` |
| Admin / fee recipient (Safe) | [`0x88bA7364cC6cE5054981d571b33f8fb3E91475A0`](https://basescan.org/address/0x88bA7364cC6cE5054981d571b33f8fb3E91475A0) | — |

All four contracts are direct (non-proxy) deployments. CompoundV3Adapter was compiled with `viaIR: true`; the others were not.

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
| `tvlCap` | constructor arg | `setTvlCap` (ADMIN) | Hard cap on `totalAssets`; `shutdownVault` sets to 0 |
| `perDepositCap` | constructor arg | `setPerDepositCap` (ADMIN) | Per-call `deposit` ceiling |
| `exitFeeBps` | constructor arg (≤ 100) | `setExitFeeBps` (ADMIN) | Charged on redeem/withdraw; max 1% |
| `feeRecipient` | constructor arg | `setFeeRecipient` (ADMIN) | Receives exit fees |
| `shutdown` | `false` | `shutdownVault` (EMERGENCY) | **Irreversible** — once true, `deposit` always reverts |
| `maxRebalanceBpsPerCall` | 2500 (25%) | `setMaxRebalanceBpsPerCall` (ADMIN) | Throttle per `rebalance()` call |
| `minRebalanceInterval` | 12 hours | `setMinRebalanceInterval` (ADMIN) | Minimum time between rebalances |

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
| `shutdownVault()` | EMERGENCY | Sets `shutdown = true`, `tvlCap = 0`. Irreversible. Deposits revert with `VaultShutdown()`. Withdrawals continue. |

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
> process — is in `docs/security-model.md`.

| Risk | Mitigation (confirmed from source) |
|---|---|
| Admin abuse | AccessControl with `ADMIN_ROLE` self-admined; production admin is a Safe multisig. `MAX_EXIT_FEE_BPS = 100` is an immutable ceiling — admin cannot set fees above 1% |
| Emergency misuse | `EMERGENCY_ROLE` is separate from `ADMIN_ROLE` and initially held by the same Safe multisig (both granted in constructor). Both roles can be revoked |
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
| `shutdownVault()` | EMERGENCY | Irreversible deposit kill |
| `rescueTokens(address, address)` | ADMIN | Sweep non-USDC tokens |
| `getAdapterDrift()` | view | Returns current/target/drift per adapter |
| `isRebalanceAvailable()` | view | Check rebalance cooldown |
| `nextRebalanceAt()` | view | Timestamp of next allowed rebalance |
| `activeAdapterCount()` | view | Count of active adapters |
| `currentTargetBps()` | view | Equal-weight target in bps |
| `isShutdown()` | view | Alias for `shutdown` state var |

Future client tooling should consider surfacing `getAdapterDrift()`, `isRebalanceAvailable()`, and `nextRebalanceAt()` — these are directly useful for treasury monitoring.

---

## 8. References

- Source files: [`../../contracts/`](../../contracts/)
- BaseScan vault: https://basescan.org/address/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd
