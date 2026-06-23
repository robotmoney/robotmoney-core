# MockTwapSource
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a7ac64337cc2843fe9fad5c808ffb035e51d4697/contracts/test/fv/TwapManipulation.t.sol)

Mock manipulable TWAP source: a settable USDC-value per unit so a test can
skew the "oracle" the vault would price against and derive its floor from.


## State Variables
### usdcValuePerUnit

```solidity
uint256 public usdcValuePerUnit
```


## Functions
### set


```solidity
function set(uint256 v) external;
```

### quote


```solidity
function quote(uint256 units) external view returns (uint256);
```

