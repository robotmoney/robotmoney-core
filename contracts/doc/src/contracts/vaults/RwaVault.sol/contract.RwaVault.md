# RwaVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/04ed1dbad12586b776088eccf72044b65f6c4cc3/contracts/vaults/RwaVault.sol)

**Inherits:**
[BasketVault](/contracts/vaults/BasketVault.sol/abstract.BasketVault.md)

**Title:**
RwaVault

ERC-4626 USDC vault holding Centrifuge deSPXA (tokenised S&P 500)
on Base. Depositors receive rmRWA shares representing proportional
NAV exposure to deSPXA. Prices are sourced from a Chronicle on-chain
push oracle (not an Aerodrome TWAP). Entry and exit are via the
Aerodrome secondary market swap ONLY.
## deSPXA asset constraints (ADR-0006)
1. **No primary ERC-7540 redemption.** deSPXA primary NAV redeem
requires KYC through the Centrifuge V3 operator, which a permissionless
smart-contract vault cannot satisfy. This is a permanent non-goal.
2. **Chronicle NAV oracle.** Aerodrome spot prices are unsuitable
for thin RWA liquidity. Chronicle provides signed, push-updated
NAV prices on behalf of the issuer. The oracle heartbeat (default
24 h) is enforced: price-sensitive operations revert with
`StalePriceFeed` if the feed has not been updated within that window.
3. **Issuer freeze-control risk.** The deSPXA issuer may freeze
transfers at any time. See the warning block at the top of this file.
4. **Aerodrome secondary swap only.** The `ChronicleOracleAdapter`
handles both Aerodrome routing and Chronicle pricing in a single
IBasketSwapAdapter implementation.
## Single-asset basket
RwaVault holds exactly one basket asset: deSPXA. ADMIN_ROLE calls
`addAsset(deSPXA, pool, 0, chronicleAdapter)` once after deployment.
`maxAssets()` is 1 to enforce this constraint and prevent accidental
multi-asset dilution.
## Address pinning (Base mainnet)
All production addresses are pinned in `config/dex-pools.json` and
the deployment script. The canonical values at the time of this issue:
| Item                           | Address                                    |
| ------------------------------ | ------------------------------------------ |
| deSPXA ERC-20 (Base)           | 0x1c0375688De2e7e8f83DB30A91aD8f9e31e4A4A |
| Aerodrome deSPXA/USDC pool     | 0xd53bF0FcE8E80a2f28c17Ef22FcBfB9b8FC8b6A |
| Aerodrome Router (Base)        | 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43 |
| Aerodrome Factory (Base)       | 0x420DD381b31aEf6683db6B902084cB0FFECe40Da |
| Chronicle deSPXA/USD feed      | 0xc9Bc046d3a832f5Fb5cf24e8cb7Bb15Fe6F1b9e |
NOTE: These addresses are pinned from ADR-0006 research. Verify
against live Base mainnet state (Basescan, Aerodrome Factory) before
deploying. A mismatch renders the vault non-functional in a way that
fork tests cannot detect.
## Risk label: RWA (tokenised real-world asset)
- Price tracks S&P 500 NAV; may deviate from Aerodrome spot.
- Issuer freeze-control risk (see ADR-0006 §4).
- Chronicle feed staleness halts deposits/withdrawals.
- Aerodrome liquidity may be thin; large redemptions will be rejected
by the slippage cap.
Base mainnet SwapRouter02 (Uniswap V3, used as constructor stub only):
0x2626664c2603336E57B271c5C0b26F421741e481


## Constants
### _MAX_ASSETS
Maximum basket size: exactly one RWA asset (deSPXA). Prevents
accidental multi-asset dilution via addAsset after construction.


```solidity
uint256 private constant _MAX_ASSETS = 1
```


### _DEFAULT_SLIPPAGE_BPS
Default maximum swap slippage in basis points (50 bps = 0.5%).
Tighter than other vaults because slippage is anchored to the
Chronicle NAV price, not an Aerodrome TWAP. See ADR-0006 §3.


```solidity
uint256 private constant _DEFAULT_SLIPPAGE_BPS = 50
```


### MAX_HEARTBEAT
Maximum permitted heartbeat in seconds. Prevents ADMIN_ROLE
from setting an arbitrarily long window that would allow a stale
price to be used for days.


```solidity
uint256 public constant MAX_HEARTBEAT = 48 hours
```


### DEFAULT_HEARTBEAT
Default Chronicle heartbeat window. If the oracle has not been
updated within this window, `StalePriceFeed` is raised on all
price-sensitive operations (deposit, redeem, totalAssets).


```solidity
uint256 public constant DEFAULT_HEARTBEAT = 24 hours
```


### CHRONICLE
Chronicle NAV oracle for deSPXA. Immutable — the oracle cannot
be swapped out post-deployment without redeploying the vault.


```solidity
IChronicleOracle public immutable CHRONICLE
```


## State Variables
### oracleHeartbeat
Staleness heartbeat window in seconds. Oracle-dependent operations
revert with `StalePriceFeed` if the feed age exceeds this value.
Admin-settable within [1 hour, MAX_HEARTBEAT].


```solidity
uint256 public oracleHeartbeat
```


### emergencyUnwindStaleOverride
When true, EMERGENCY_ROLE may call emergencyUnwind and
emergencyUnwindWithOverride even if the Chronicle feed is stale.
Defaults to false, which causes emergency unwind to revert with
`StalePriceFeed` when the oracle has not been updated within
`oracleHeartbeat`.


```solidity
bool public emergencyUnwindStaleOverride
```


## Functions
### constructor


```solidity
constructor(
    IERC20 usdc_,
    ISwapRouter swapRouter_,
    IChronicleOracle chronicle_,
    uint256 tvlCap_,
    uint256 perDepositCap_,
    uint256 exitFeeBps_,
    address feeRecipient_,
    address admin_,
    address emergencyResponder_
)
    BasketVault(
        "Robot Money RWA",
        "rmRWA",
        usdc_,
        swapRouter_,
        tvlCap_,
        perDepositCap_,
        exitFeeBps_,
        _DEFAULT_SLIPPAGE_BPS,
        feeRecipient_,
        admin_,
        emergencyResponder_
    );
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`usdc_`|`IERC20`|             USDC token address (6-decimal ERC-20).|
|`swapRouter_`|`ISwapRouter`|       Uniswap V3 SwapRouter (stub — not used for RWA swaps; all swaps go through ChronicleOracleAdapter/Aerodrome).|
|`chronicle_`|`IChronicleOracle`|        Chronicle NAV oracle for deSPXA on Base.|
|`tvlCap_`|`uint256`|           Maximum USDC TVL the vault will accept (6-dec units).|
|`perDepositCap_`|`uint256`|    Maximum USDC per single deposit (6-dec units).|
|`exitFeeBps_`|`uint256`|       Exit fee in basis points (≤ MAX_EXIT_FEE_BPS = 100).|
|`feeRecipient_`|`address`|     Address that receives exit fees.|
|`admin_`|`address`|            Receives ADMIN_ROLE.|
|`emergencyResponder_`|`address`|Receives EMERGENCY_ROLE.|


### maxAssets

Subclasses declare the maximum number of assets in the basket.


```solidity
function maxAssets() public pure override returns (uint256);
```

### totalAssets

USDC value of all held assets. Reverts if the Chronicle feed is
stale AND the vault still holds a priced RWA token.

Overrides BasketVault.totalAssets() to enforce the staleness check
before any TWAP/oracle read. BasketVault.totalAssets() delegates
pricing to the per-asset adapter (ChronicleOracleAdapter), which reads
Chronicle. We check freshness here, at the vault level, so callers
get a typed `StalePriceFeed` error rather than an opaque revert from
deep in the adapter.
NC-1 / SUP-5 short-circuit: the freshness gate only applies when the
vault actually holds a priced RWA balance. After an emergency unwind
to idle USDC the basket holds zero RWA, so NAV is exactly the idle USDC
and no oracle read is required. Gating the check on `_holdsPricedRwa()`
keeps ORA-2 (fail-closed) intact for every priced read while letting a
holder redeem already-safe idle USDC even when the feed is stale —
otherwise the unconditional revert traps safe funds with no
permissionless exit (audit 2026-06-19 NC-1).


```solidity
function totalAssets() public view override returns (uint256);
```

### _holdsPricedRwa

True when the vault holds a non-zero balance of any active basket
asset (the priced RWA token). When false, `totalAssets()` is exactly
the idle USDC balance and needs no oracle read, so freshness is
short-circuited for the idle-USDC redemption path (SUP-5).


```solidity
function _holdsPricedRwa() internal view returns (bool);
```

### _checkOracleFreshness

Reverts with `StalePriceFeed` if the Chronicle feed has not been
updated within `oracleHeartbeat` seconds.

Called by totalAssets() (and therefore by all ERC-4626 deposit/redeem
paths that price shares). Any price-sensitive operation halts when the
feed is stale, consistent with the "fail closed" philosophy in ADR-0006 §2.


```solidity
function _checkOracleFreshness() internal view;
```

### setEmergencyUnwindStaleOverride

Allow (true) or forbid (false, default) emergency unwind when the
Chronicle feed is stale.

ACL-5 / F-08: gated to `ADMIN_ROLE` — a strictly higher-trust tier than
the `EMERGENCY_ROLE` that executes `emergencyUnwind`. Selling RWA at an
unverifiable (stale) NAV requires two distinct authorities: ADMIN_ROLE
arms the stale-override, EMERGENCY_ROLE runs the unwind. A single
compromised emergency hot key can no longer both authorise stale pricing
and dump the basket against it (audit 2026-06-19 F-08).


```solidity
function setEmergencyUnwindStaleOverride(bool allowed_) external onlyRole(ADMIN_ROLE);
```

### emergencyUnwind

Emergency unwind with Chronicle staleness gate.

Reverts with `StalePriceFeed` when the feed is stale, unless
`emergencyUnwindStaleOverride` has been set to true by EMERGENCY_ROLE.


```solidity
function emergencyUnwind() public override onlyRole(EMERGENCY_ROLE);
```

### emergencyUnwindWithOverride

High-risk emergency unwind with Chronicle staleness gate.

Reverts with `StalePriceFeed` when the feed is stale, unless
`emergencyUnwindStaleOverride` has been set to true by EMERGENCY_ROLE.


```solidity
function emergencyUnwindWithOverride(address[] calldata tokens)
    public
    override
    onlyRole(EMERGENCY_ROLE);
```

### setOracleHeartbeat

Update the Chronicle staleness heartbeat. Restricted to ADMIN_ROLE.


```solidity
function setOracleHeartbeat(uint256 heartbeat_) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`heartbeat_`|`uint256`|New heartbeat in seconds. Must be in [1 hour, MAX_HEARTBEAT].|


## Events
### OracleHeartbeatUpdated
Emitted when ADMIN_ROLE updates the oracle staleness heartbeat.


```solidity
event OracleHeartbeatUpdated(uint256 oldHeartbeat, uint256 newHeartbeat);
```

### EmergencyUnwindStaleOverrideUpdated
Emitted when EMERGENCY_ROLE toggles the stale-price override flag.


```solidity
event EmergencyUnwindStaleOverrideUpdated(bool allowed);
```

## Errors
### StalePriceFeed
Raised when the Chronicle feed has not been updated within `heartbeat`
seconds. Deposits, withdrawals, and totalAssets all halt until the feed
is refreshed by Chronicle's keeper network. This is a deliberate
conservative choice — using a stale NAV price silently is worse than
halting operations temporarily. See ADR-0006 §2.


```solidity
error StalePriceFeed(uint256 updatedAt, uint256 heartbeat);
```

### InvalidHeartbeat
Raised when ADMIN_ROLE attempts to set a heartbeat outside the
permitted range [1 hour, MAX_HEARTBEAT].


```solidity
error InvalidHeartbeat(uint256 heartbeat);
```

