# AeroPositionMockVault
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/d740448a2c3c14fa0c325f99c0cf5fb21593c110/contracts/test/AerodromeAssetPositionAdapter.t.sol)

Minimal vault harness: answers `hasRole(ADMIN_ROLE, .)` for the adapter's
onlyVaultAdmin setters and relays deploy/withdraw as the bound VAULT
(msg.sender == this) after funding the adapter with USDC. TEST FIXTURE.


## Constants
### ADMIN_ROLE

```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


## State Variables
### _roles

```solidity
mapping(bytes32 => mapping(address => bool)) internal _roles
```


## Functions
### grantRole


```solidity
function grantRole(bytes32 role, address account) external;
```

### hasRole


```solidity
function hasRole(bytes32 role, address account) external view returns (bool);
```

### callDeploy

Mirror the vault choreography: transfer USDC to the adapter first,
then call deploy (spec §2.2, same as v1 `_allocateTo`).


```solidity
function callDeploy(
    AerodromeAssetPositionAdapter adapter,
    IERC20 usdc,
    uint256 usdcIn,
    uint256 minValueOut
) external returns (uint256);
```

### callWithdraw


```solidity
function callWithdraw(
    AerodromeAssetPositionAdapter adapter,
    uint256 usdcWanted,
    uint256 minUsdcOut
) external returns (uint256);
```

