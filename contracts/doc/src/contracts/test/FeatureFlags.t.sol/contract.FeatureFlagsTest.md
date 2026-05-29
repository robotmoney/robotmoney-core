# FeatureFlagsTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/cf8a75c9169f98b8e30f0ad4e13af73b36f22bc7/contracts/test/FeatureFlags.t.sol)

**Inherits:**
Test


## Functions
### test_isEnabled_flagZero


```solidity
function test_isEnabled_flagZero() public pure;
```

### test_isEnabled_flagOne


```solidity
function test_isEnabled_flagOne() public pure;
```

### test_isEnabled_flagTwo


```solidity
function test_isEnabled_flagTwo() public pure;
```

### test_isEnabled_allFlagsOn


```solidity
function test_isEnabled_allFlagsOn() public pure;
```

### test_isEnabled_emptyBitmap


```solidity
function test_isEnabled_emptyBitmap() public pure;
```

### test_set_and_clear_roundtrip


```solidity
function test_set_and_clear_roundtrip() public pure;
```

### test_clear_doesNotAffectOtherFlags


```solidity
function test_clear_doesNotAffectOtherFlags() public pure;
```

### testFuzz_isEnabled_bit0

Any bitmap with bit 0 set must report MULTI_VAULT_ENABLED as true,
regardless of the other bits.


```solidity
function testFuzz_isEnabled_bit0(uint256 bitmap) public pure;
```

### testFuzz_isEnabled_bit0Off


```solidity
function testFuzz_isEnabled_bit0Off(uint256 bitmap) public pure;
```

### test_flagIdConstants


```solidity
function test_flagIdConstants() public pure;
```

