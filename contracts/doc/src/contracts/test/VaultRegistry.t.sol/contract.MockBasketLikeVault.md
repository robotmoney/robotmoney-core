# MockBasketLikeVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/174c53454088cd318240a18aade465c225fdb078/contracts/test/VaultRegistry.t.sol)

Simulates the registry-gated retire pattern implemented by BasketVault
(FS-VLT-19): retire()/unretire() are only callable by the linked
registry, and they set/clear a `depositsPaused` flag. Used to assert
that VaultRegistry.retire(basketVaultAddress) completes without revert
when the vault has called setRegistry with the registry's address.


## State Variables
### registry

```solidity
address public registry
```


### depositsPaused

```solidity
bool public depositsPaused
```


## Functions
### setRegistry


```solidity
function setRegistry(address reg) external;
```

### retire


```solidity
function retire() external;
```

### unretire


```solidity
function unretire() external;
```

## Errors
### OnlyRegistry

```solidity
error OnlyRegistry();
```

