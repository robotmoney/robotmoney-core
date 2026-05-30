# ISafeProxyFactory
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/5e0758d2049cf2770fbcc743d358f5172be4f30a/contracts/test/SafeIntegration.t.sol)

**Title:**
ISafeProxyFactory — minimal interface for Safe{Wallet} ProxyFactory.

Address on Base mainnet (and many networks): 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67.


## Functions
### createProxyWithNonce

Deploy a new SafeProxy and call `initializer` on the singleton.


```solidity
function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
    external
    returns (address proxy);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`singleton`|`address`|   The Safe singleton (implementation) address.|
|`initializer`|`bytes`| `setup(...)` calldata.|
|`saltNonce`|`uint256`|   Salt for CREATE2 (allows deterministic addresses).|


