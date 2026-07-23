# DeSpxaFreezableToken18
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/20a28674ed248f52a2865a2d77d65dc7c7a00bed/contracts/test/DeSpxaAssetPositionAdapter.t.sol)

**Inherits:**
ERC20

deSPXA stand-in that reverts real (non-mint/non-burn) transfers while
`frozen`, modeling the issuer freeze-control risk in ADR-0006 §3. Mint
and burn (from/to == address(0)) are always allowed so test setup can
fund balances even while frozen. TEST FIXTURE.


## State Variables
### frozen

```solidity
bool public frozen
```


## Functions
### constructor


```solidity
constructor() ERC20("Freezable deSPXA", "fDESPXA");
```

### mint


```solidity
function mint(address to, uint256 amount) external;
```

### setFrozen


```solidity
function setFrozen(bool frozen_) external;
```

### _update


```solidity
function _update(address from, address to, uint256 value) internal override;
```

## Errors
### TransfersFrozen

```solidity
error TransfersFrozen();
```

