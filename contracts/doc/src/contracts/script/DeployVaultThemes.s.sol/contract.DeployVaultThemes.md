# DeployVaultThemes
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/efa707be563fbb6d1823fd15d523cb09e2f05d55/contracts/script/DeployVaultThemes.s.sol)

**Inherits:**
Script

**Title:**
DeployVaultThemes

Parameterized per-theme deployer for the unified `Vault` (ADR-0010 §7,
spec §8). Exposes the theme matrix, the vault constructor call, the
variable-length adapter-set wiring, the rmAGENT per-theme
`TimelockController` handoff, and the rmRWA active-adapter-count cap.


## Constants
### DEFAULT_TVL_CAP
Default TVL cap: 10M USDC (6 decimals).


```solidity
uint256 public constant DEFAULT_TVL_CAP = 10_000_000 * 1e6
```


### DEFAULT_PER_DEPOSIT_CAP
Default per-deposit cap: 1M USDC (6 decimals).


```solidity
uint256 public constant DEFAULT_PER_DEPOSIT_CAP = 1_000_000 * 1e6
```


### DEFAULT_MAX_NAV_GROWTH_RATE_BPS
Default residual NAV-growth-rate cap (bps of checkpoint NAV per
hour). A concrete governance/tuning value (spec §10, still-open Q3);
a finite non-zero placeholder here — narrow before mainnet.


```solidity
uint256 public constant DEFAULT_MAX_NAV_GROWTH_RATE_BPS = 500
```


## Functions
### themeParams

The static parameter matrix for `t` (spec §8, table + M-A9).

`maxSlippageBps` / `maxActiveAdapters` are the load-bearing per-theme
divergences; `allExact` records the composition class (rmUSDC only).


```solidity
function themeParams(Theme t) public pure returns (ThemeParams memory p);
```

### deployThemeVault

Deploy the parameterized `Vault` for theme `t`. Pure construction —
no role-gated calls, so no broadcast/prank context is required. The
constructed vault grants `ADMIN_ROLE` to `admin` and starts with the
default `maxActiveAdapters == MAX_ADAPTERS`; `wireTheme` narrows it
to the theme cap (rmRWA → 1).


```solidity
function deployThemeVault(Theme t, VaultConfig memory cfg) public returns (Vault vault);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`t`|`Theme`|  The theme to deploy (supplies name/symbol/maxSlippage).|
|`cfg`|`VaultConfig`|The deployment-environment parameters (asset, caps, fee, NAV-growth cap, recipients, and the bootstrap `admin` that wires the adapters — a per-theme TimelockController for rmAGENT, see `deployAgentTimelock`; the operator/timelock otherwise).|


### wireTheme

Wire theme `t`'s VARIABLE-LENGTH adapter set into `vault` and narrow
the active-adapter cap, all as `admin` (the vault's `ADMIN_ROLE`
holder). Each adapter is put through the full eligibility gate:
`setAdapterAllowed` (instance allowlist) + `setAdapterCodeHashAllowed`
(codehash pin) + `addAdapter(adapter, capBps, isExact)`.

In-process / test path: pranks as `admin` so the vault sees the
ADMIN caller. Production wiring inside a broadcast uses
`wireThemeBroadcast` instead. `specs.length` MUST equal the theme's
expected adapter count and (for rmRWA) not exceed the cap of 1.


```solidity
function wireTheme(Vault vault, Theme t, address admin, AdapterSpec[] memory specs) public;
```

### wireThemeBroadcast

Broadcast variant of `wireTheme` for production `run*` flows where
`admin` is the broadcasting deployer/timelock.


```solidity
function wireThemeBroadcast(Vault vault, Theme t, AdapterSpec[] memory specs) public;
```

### _wireInner

The raw wiring — assumes the current caller context holds `ADMIN_ROLE`.


```solidity
function _wireInner(Vault vault, Theme t, AdapterSpec[] memory specs) internal;
```

### deployAgentTimelock

Deploy the per-theme `TimelockController` that serves as rmAGENT's
`ADMIN_ROLE` holder (ADR-0004 add/remove delays — spec §8, M-A9).
One `ADMIN_ROLE` on the vault cannot express per-theme delays, so
the timelock's `minDelay` encodes them and the vault sees a single
ADMIN held by this timelock.


```solidity
function deployAgentTimelock(uint256 minDelay, address proposer, address executor)
    public
    returns (TimelockController timelock);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`minDelay`|`uint256`|Minimum timelock delay (seconds) — the ADR-0004 add/remove delay (e.g. 48h). Distinct add-vs-remove delays need an operation-scoped delay; a single min-delay is the base case.|
|`proposer`|`address`|PROPOSER_ROLE holder (governance multisig in production).|
|`executor`|`address`|EXECUTOR_ROLE holder.|


### finalizeAdmin

Hand the vault's `ADMIN_ROLE` from the bootstrap operator to the
final admin (a per-theme `TimelockController` for rmAGENT), then
renounce the operator's role so the timelock is the sole ADMIN.
The last-admin floor (ACL-3) permits this: `newAdmin` is granted
BEFORE `oldAdmin` renounces, so the ADMIN count never hits zero.

In-process / test path (pranks as `oldAdmin`).


```solidity
function finalizeAdmin(Vault vault, address oldAdmin, address newAdmin) public;
```

### _finalizeInner

Raw handoff — assumes the caller context holds `oldAdmin`'s ADMIN_ROLE.


```solidity
function _finalizeInner(Vault vault, address oldAdmin, address newAdmin) internal;
```

### run

Forge broadcast entrypoint: deploy a single theme's `Vault` (theme
selected by the `THEME` env var: USDC|PROTO|AGENT|RWA) and narrow
its active-adapter cap. Adapter INSTANCE deployment + wiring is a
governed follow-up (their own scripts, then `wireThemeBroadcast`);
the registry/router eligibility interlock is Phase-6 (ADR-0010 §8).
Required env: THEME, USDC_ADDRESS, ADMIN_ADDRESS,
EMERGENCY_RESPONDER_ADDRESS. Optional: TVL_CAP, PER_DEPOSIT_CAP,
EXIT_FEE_BPS, MAX_NAV_GROWTH_RATE_BPS, FEE_RECIPIENT.


```solidity
function run() external returns (address vault);
```

### _themeFromEnv


```solidity
function _themeFromEnv() internal view returns (Theme);
```

### _envAddressOrDefault


```solidity
function _envAddressOrDefault(string memory key, address fallback_)
    internal
    view
    returns (address);
```

### _envUintOrDefault


```solidity
function _envUintOrDefault(string memory key, uint256 fallback_)
    internal
    view
    returns (uint256);
```

## Structs
### AdapterSpec
One adapter to register: its (pre-deployed, vault-bound) address,
its per-adapter `capBps` allocation weight, and the VAULT-ATTESTED
`isExact` flag ADMIN pins at `addAdapter` (spec §5.1, C2). The
array of these is the per-theme VARIABLE-LENGTH weight set.


```solidity
struct AdapterSpec {
    address adapter;
    uint16 capBps;
    bool isExact;
}
```

### VaultConfig
The non-theme (deployment-environment) parameters for a vault. Kept
as a struct so the `deployThemeVault` call site stays within the
non-`via_ir` stack limit this repo compiles under.


```solidity
struct VaultConfig {
    IERC20 usdc; // asset the vault denominates in
    uint256 tvlCap; // TVL ceiling (6-decimal USDC)
    uint256 perDepositCap; // per-deposit ceiling
    uint256 exitFeeBps; // exit fee (≤ 100)
    uint256 maxNavGrowthRateBps; // residual NAV-growth-rate cap (> 0)
    address feeRecipient; // exit-fee recipient
    address admin; // bootstrap ADMIN_ROLE holder (wires adapters)
    address emergency; // EMERGENCY_ROLE holder
}
```

### ThemeParams
Static per-theme parameters (spec §8 theme deployment table).


```solidity
struct ThemeParams {
    string name; // ERC-20 share name
    string symbol; // ERC-20 share symbol
    uint256 maxSlippageBps; // worst-case per-leg slippage bound
    uint256 maxActiveAdapters; // active-adapter-count cap (rmRWA = 1)
    uint256 expectedAdapters; // how many adapters the theme wires (doc/assert aid)
    bool allExact; // true only for the all-lending rmUSDC composition
}
```

## Enums
### Theme
The four unified-vault themes (ADR-0010 §7). Each is one `Vault`
deployment distinguished only by its parameters + adapter set.


```solidity
enum Theme {
    RM_USDC,
    RM_PROTO,
    RM_AGENT,
    RM_RWA
}
```

