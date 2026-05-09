# CompoundV3Adapter
[Git Source](https://github.com/lucky-tensor/robotmoney-skills/blob/b462a72b60a914ceeff6cdf3ad7148bfb0361abb/contracts/adapters/CompoundV3Adapter.sol)

**Inherits:**
[IStrategyAdapter](/contracts/interfaces/IStrategyAdapter.sol/interface.IStrategyAdapter.md)

**Title:**
CompoundV3Adapter

Strategy adapter that supplies USDC to Compound V3 (Comet) on Base.

Compound V3 is non-ERC-4626. The Comet contract is itself the cUSDCv3 token.
`supply` always credits msg.sender. `withdraw` always sends to msg.sender.
So this adapter must FORWARD withdrawn USDC to the vault.
`COMET.balanceOf(account)` returns live underlying USDC with interest applied.
Deployed: 0x8247da22a59fce074c102431048d0ce7294c2652 (Base mainnet)
Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun, viaIR=true


## State Variables
### USDC

```solidity
IERC20 public immutable USDC
```


### COMET

```solidity
IComet public immutable COMET
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
constructor(address comet_, address usdc_, address vault_) ;
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
`Comet.withdrawTo` returned fewer USDC than requested.


```solidity
error WithdrawShortfall(uint256 requested, uint256 actual);
```

### CannotRescueProtectedToken
`rescueToken` refused — the token is USDC or the Comet share (protected vault assets).


```solidity
error CannotRescueProtectedToken();
```

