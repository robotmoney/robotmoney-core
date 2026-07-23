# UniV4PositionMockVault
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/590a2c3bf7bb1b2abde217714163eb9576c910c7/contracts/test/UniswapV4AssetPositionAdapter.t.sol)

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
    UniswapV4AssetPositionAdapter adapter,
    IERC20 usdc,
    uint256 usdcIn,
    uint256 minValueOut
) external returns (uint256);
```

### callWithdraw


```solidity
function callWithdraw(
    UniswapV4AssetPositionAdapter adapter,
    uint256 usdcWanted,
    uint256 minUsdcOut
) external returns (uint256);
```

