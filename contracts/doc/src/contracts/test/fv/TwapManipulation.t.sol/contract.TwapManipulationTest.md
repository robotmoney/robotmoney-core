# TwapManipulationTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/9912e66cc064941cf391031069c85d740fd52944/contracts/test/fv/TwapManipulation.t.sol)

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
function test_ORA7_independentFloorBoundsLossUnderManipulation() public;
```

