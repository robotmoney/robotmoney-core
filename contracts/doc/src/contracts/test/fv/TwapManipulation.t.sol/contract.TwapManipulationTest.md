# TwapManipulationTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/04ed1dbad12586b776088eccf72044b65f6c4cc3/contracts/test/fv/TwapManipulation.t.sol)

**Inherits:**
Test


## State Variables
### twap

```solidity
MockTwapSource internal twap
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_ORA7_derivedFloorTracksManipulatedTwap

Demonstrates the ORA-7 structural defect on the model: a floor
DERIVED from the TWAP tracks the TWAP, so manipulating the TWAP
loosens the floor by the same factor (no independent protection).
This is a passing characterization test (it asserts the *defect*
relationship the fix must break), not the invariant itself.


```solidity
function test_ORA7_derivedFloorTracksManipulatedTwap() public;
```

### test_ORA7_independentFloorBoundsLossUnderManipulation

ORA-7 (RED): under any TWAP manipulation, realized loss to the vault
stays bounded by an absolute, TWAP-INDEPENDENT floor. Fails on
current HEAD because `_slippageFloor → _twapUsdcValue` is the NAV
TWAP itself (no independent backstop). When #966 introduces an
independent floor, remove the skip and assert loss ≤ that floor
across a fuzzed manipulation magnitude.


```solidity
function test_ORA7_independentFloorBoundsLossUnderManipulation(uint16 manipBps) public;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`manipBps`|`uint16`|  The manipulation magnitude applied to the observed TWAP between sign and execute, in basis points of the honest quote (0..MAX_BPS-1, i.e. up to a ~100% downward skew).|


### Math_min


```solidity
function Math_min(uint256 a, uint256 b) internal pure returns (uint256);
```

