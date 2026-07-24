# VaultCodeSizeGuard
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/98e21fa6ee5c881534f0ec43b14cc042ef89ab9c/contracts/test/VaultCodeSizeGuard.t.sol)

**Inherits:**
Test

**Title:**
VaultCodeSizeGuard

Asserts every deployable vault's runtime bytecode stays under the
EIP-170 24576-byte limit.
Why this exists: Foundry's test/script EVM raises the contract-size
limit, so an oversize vault passes every unit/invariant/fork test and
even the deploy *simulation*, yet reverts when actually broadcast to a
real EIP-170 chain (Base mainnet, or the Geth smoke-test devnet). That
is exactly how RwaVault (24834) and AgentTokenVault (25241) became
undeployable without any test catching it (issue #865). This guard
reads the compiled artifact size directly so the limit is enforced
regardless of the test EVM's relaxed limit.


## Constants
### EIP170_LIMIT
EIP-170 maximum contract runtime bytecode size, in bytes.


```solidity
uint256 internal constant EIP170_LIMIT = 24576
```


## Functions
### _assertUnderLimit


```solidity
function _assertUnderLimit(string memory artifact) internal;
```

### test_RobotMoneyVault_underEip170


```solidity
function test_RobotMoneyVault_underEip170() public;
```

### test_ProtocolAssetVault_underEip170


```solidity
function test_ProtocolAssetVault_underEip170() public;
```

### test_RwaVault_underEip170


```solidity
function test_RwaVault_underEip170() public;
```

### test_AgentTokenVault_underEip170


```solidity
function test_AgentTokenVault_underEip170() public;
```

### test_UnifiedVault_underEip170


```solidity
function test_UnifiedVault_underEip170() public;
```

### test_AaveV3Adapter_underEip170


```solidity
function test_AaveV3Adapter_underEip170() public;
```

### test_CompoundV3Adapter_underEip170


```solidity
function test_CompoundV3Adapter_underEip170() public;
```

### test_MorphoAdapter_underEip170


```solidity
function test_MorphoAdapter_underEip170() public;
```

### test_UniswapV3AssetPositionAdapter_underEip170


```solidity
function test_UniswapV3AssetPositionAdapter_underEip170() public;
```

### test_UniswapV4AssetPositionAdapter_underEip170


```solidity
function test_UniswapV4AssetPositionAdapter_underEip170() public;
```

### test_AerodromeAssetPositionAdapter_underEip170


```solidity
function test_AerodromeAssetPositionAdapter_underEip170() public;
```

### test_DeSpxaAssetPositionAdapter_underEip170


```solidity
function test_DeSpxaAssetPositionAdapter_underEip170() public;
```

### test_UniswapV3SwapAdapter_underEip170


```solidity
function test_UniswapV3SwapAdapter_underEip170() public;
```

### test_UniswapV4SwapAdapter_underEip170


```solidity
function test_UniswapV4SwapAdapter_underEip170() public;
```

### test_AerodromeSwapAdapter_underEip170


```solidity
function test_AerodromeSwapAdapter_underEip170() public;
```

### test_ChronicleOracleAdapter_underEip170


```solidity
function test_ChronicleOracleAdapter_underEip170() public;
```

