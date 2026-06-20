# MockRetirableVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/09c1813279f1fa827a425df89836eb093cfa67e8/contracts/test/VaultRegistry.t.sol)

Minimal stand-in for `RobotMoneyVault` exposing the deposit-halt legs
(`retire`/`unretire`) the registry's unified governance `retire`
action drives. Records whether each was called so the registry test
can assert the cross-contract call landed.


## State Variables
### retiredCalled

```solidity
bool public retiredCalled
```


### unretiredCalled

```solidity
bool public unretiredCalled
```


## Functions
### retire


```solidity
function retire() external;
```

### unretire


```solidity
function unretire() external;
```

