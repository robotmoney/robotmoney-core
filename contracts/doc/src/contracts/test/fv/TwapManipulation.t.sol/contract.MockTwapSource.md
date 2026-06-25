# MockTwapSource
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/565d7a4ab968179b6f0a1db9f9fe724a77abadce/contracts/test/fv/TwapManipulation.t.sol)

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

