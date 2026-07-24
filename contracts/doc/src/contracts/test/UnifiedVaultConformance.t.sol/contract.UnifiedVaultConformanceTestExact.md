# UnifiedVaultConformanceTestExact
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/98e21fa6ee5c881534f0ec43b14cc042ef89ab9c/contracts/test/UnifiedVaultConformance.t.sol)

**Inherits:**
[UnifiedVaultConformanceBase](/contracts/test/UnifiedVaultConformance.t.sol/abstract.UnifiedVaultConformanceBase.md)


## State Variables
### adapter

```solidity
ConformanceExactAdapter internal adapter
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_composition_isExactMode


```solidity
function test_composition_isExactMode() public;
```

### test_previewDeposit_parity

`previewDeposit` equals the shares `deposit` actually mints, and
both equal OZ's floor conversion (exact composition, spec §5.2).


```solidity
function test_previewDeposit_parity() public;
```

### test_previewWithdraw_isLive_andParity

`previewWithdraw` is LIVE in exact mode and equals the shares
`withdraw` burns; the receiver gets exactly the requested net.


```solidity
function test_previewWithdraw_isLive_andParity() public;
```

### test_previewRedeem_parity_zeroFee

`previewRedeem` equals the assets `redeem` returns; with zero fee
it equals the gross conversion (exact composition).


```solidity
function test_previewRedeem_parity_zeroFee() public;
```

### test_maxViews_liveAndNonZero


```solidity
function test_maxViews_liveAndNonZero() public;
```

### test_maxWithdraw_roundTripNeverReverts_withFee

E-1 (classic ERC-4626 fee edge): `withdraw(maxWithdraw(owner))`
must never revert, even under a non-zero exit fee.


```solidity
function test_maxWithdraw_roundTripNeverReverts_withFee() public;
```

### test_feeBase_isGross_onWithdraw


```solidity
function test_feeBase_isGross_onWithdraw() public;
```

### test_feeBase_previewRedeem_isGrossMinusFee

`previewRedeem` in exact mode is gross-minus-fee (fee-on-gross).


```solidity
function test_feeBase_previewRedeem_isGrossMinusFee() public;
```

### testFuzz_depositRedeemRoundTrip_noProfit

SUP-3: an immediate deposit→redeem round trip cannot profit; with
zero fee on an exact set it returns exactly the principal.


```solidity
function testFuzz_depositRedeemRoundTrip_noProfit(uint256 assets) public;
```

### testFuzz_convertRoundTrip_flooredNoInflation

convert* rounding direction: shares→assets→shares never inflates.


```solidity
function testFuzz_convertRoundTrip_flooredNoInflation(uint256 assets) public;
```

