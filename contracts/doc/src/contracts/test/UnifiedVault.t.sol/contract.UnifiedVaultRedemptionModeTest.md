# UnifiedVaultRedemptionModeTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3d0125a0ee72af9f51ed36ec0b328a085a948116/contracts/test/UnifiedVault.t.sol)

**Inherits:**
[UnifiedVaultBase](/contracts/test/UnifiedVault.t.sol/abstract.UnifiedVaultBase.md)


## Constants
### EXIT_FEE_BPS

```solidity
uint256 internal constant EXIT_FEE_BPS = 50
```


### HAIRCUT_BPS

```solidity
uint256 internal constant HAIRCUT_BPS = 100
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_exactMode_allExactTrue


```solidity
function test_exactMode_allExactTrue() public;
```

### test_exactMode_withdrawViaPullProportional_feeOnGross


```solidity
function test_exactMode_withdrawViaPullProportional_feeOnGross() public;
```

### test_exactMode_redeemReturnsRealizedNet


```solidity
function test_exactMode_redeemReturnsRealizedNet() public;
```

### test_inexactMode_allExactFalse


```solidity
function test_inexactMode_allExactFalse() public;
```

### test_inexactMode_withdrawAndPreviewWithdrawRevertRedeemOnly


```solidity
function test_inexactMode_withdrawAndPreviewWithdrawRevertRedeemOnly() public;
```

### test_inexactMode_maxWithdrawIsZero_andMaxRedeemIsZero


```solidity
function test_inexactMode_maxWithdrawIsZero_andMaxRedeemIsZero() public;
```

### test_inexactMode_redeemReturnsRealizedProceeds_feeOnRealized


```solidity
function test_inexactMode_redeemReturnsRealizedProceeds_feeOnRealized() public;
```

### test_inexactMode_allFourPreviews

All four previews behave per composition in INEXACT mode.


```solidity
function test_inexactMode_allFourPreviews() public;
```

