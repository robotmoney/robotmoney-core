# VaultCodeSizeGuard
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/0323a6a1933c28f78d86d11fe930ae7c01c96ef8/contracts/test/VaultCodeSizeGuard.t.sol)

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

