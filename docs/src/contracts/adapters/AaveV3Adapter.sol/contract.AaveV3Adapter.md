# AaveV3Adapter
[Git Source](https://github.com/lucky-tensor/robotmoney-skills/blob/b462a72b60a914ceeff6cdf3ad7148bfb0361abb/contracts/adapters/AaveV3Adapter.sol)

**Inherits:**
[IStrategyAdapter](/contracts/interfaces/IStrategyAdapter.sol/interface.IStrategyAdapter.md)

**Title:**
AaveV3Adapter

Strategy adapter that supplies USDC to Aave V3 Pool on Base.

aTokens are rebasing — `A_TOKEN.balanceOf(this)` returns live underlying with accrued interest.
Aave's `Pool.withdraw` sends USDC directly to the `to` address (we pass VAULT) — clean, no hop.
Deployed: 0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea (Base mainnet)
Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun


## State Variables
### USDC

```solidity
IERC20 public immutable USDC
```


### A_TOKEN

```solidity
IERC20 public immutable A_TOKEN
```


### POOL

```solidity
IAavePool public immutable POOL
```


### VAULT

```solidity
address public immutable VAULT
```


## Functions
### onlyVault


```solidity
modifier onlyVault() ;
```

### constructor


```solidity
constructor(address pool_, address usdc_, address aToken_, address vault_) ;
```

### deploy


```solidity
function deploy(uint256 amount) external onlyVault;
```

### withdraw


```solidity
function withdraw(uint256 amount) external onlyVault returns (uint256);
```

### totalAssets


```solidity
function totalAssets() external view returns (uint256);
```

### rescueTokens


```solidity
function rescueTokens(address token, address to) external onlyVault;
```

## Errors
### OnlyVault
Caller is not the configured `VAULT` address.


```solidity
error OnlyVault();
```

### ZeroAddress
Constructor passed `address(0)` for one of the immutable addresses.


```solidity
error ZeroAddress();
```

### WithdrawShortfall
`Pool.withdraw` returned fewer USDC than requested.


```solidity
error WithdrawShortfall(uint256 requested, uint256 actual);
```

### CannotRescueProtectedToken
`rescueToken` refused — the token is USDC or the aToken (protected vault assets).


```solidity
error CannotRescueProtectedToken();
```

