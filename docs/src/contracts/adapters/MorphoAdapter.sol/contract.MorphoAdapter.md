# MorphoAdapter
[Git Source](https://github.com/lucky-tensor/robotmoney-skills/blob/b462a72b60a914ceeff6cdf3ad7148bfb0361abb/contracts/adapters/MorphoAdapter.sol)

**Inherits:**
[IStrategyAdapter](/contracts/interfaces/IStrategyAdapter.sol/interface.IStrategyAdapter.md)

Wraps the Morpho Gauntlet USDC Prime vault on Base.

MORPHO_VAULT is itself an ERC-4626 vault; shares are held by this adapter.
Deployed: 0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9 (Base mainnet)
Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun


## State Variables
### MORPHO_VAULT

```solidity
IERC4626 public immutable MORPHO_VAULT
```


### USDC

```solidity
IERC20 public immutable USDC
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
constructor(address morphoVault_, address usdc_, address vault_) ;
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

### CannotRescueProtectedToken
`rescueToken` refused — the token is USDC or the Morpho vault share (protected vault assets).


```solidity
error CannotRescueProtectedToken();
```

### ZeroAddress
Constructor passed `address(0)` for one of the immutable addresses.


```solidity
error ZeroAddress();
```

