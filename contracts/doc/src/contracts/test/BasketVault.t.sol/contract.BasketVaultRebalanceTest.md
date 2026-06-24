# BasketVaultRebalanceTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/895f74f9a312639869e61e1d4ba3dfce78950c03/contracts/test/BasketVault.t.sol)

**Inherits:**
Test


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


## State Variables
### usdc

```solidity
TestERC20 internal usdc
```


### tokenA

```solidity
TestERC20 internal tokenA
```


### tokenB

```solidity
TestERC20 internal tokenB
```


### router

```solidity
MockSwapRouter internal router
```


### poolA

```solidity
MockPool internal poolA
```


### poolB

```solidity
MockPool internal poolB
```


### vault

```solidity
BasketVaultHarness internal vault
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### emergencyResponder

```solidity
address internal emergencyResponder = makeAddr("emergencyResponder")
```


### depositor

```solidity
address internal depositor = makeAddr("depositor")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_rebalance_revertsWithNotImplemented


```solidity
function test_rebalance_revertsWithNotImplemented() public;
```

### test_rebalance_revertsForAnyCallerNotJustAdmin


```solidity
function test_rebalance_revertsForAnyCallerNotJustAdmin() public;
```

### test_deposit_emitsWeightSnapshot_singleAsset


```solidity
function test_deposit_emitsWeightSnapshot_singleAsset() public;
```

### test_deposit_emitsWeightSnapshot_twoAssets


```solidity
function test_deposit_emitsWeightSnapshot_twoAssets() public;
```

### test_previewDepositWeights_returnsActiveAssetsOnly


```solidity
function test_previewDepositWeights_returnsActiveAssetsOnly() public;
```

### test_previewDepositWeights_splitEquallyAcrossTwoAssets


```solidity
function test_previewDepositWeights_splitEquallyAcrossTwoAssets() public;
```

### test_previewDepositWeights_zeroAmountReturnsZeros


```solidity
function test_previewDepositWeights_zeroAmountReturnsZeros() public;
```

### test_realizedWeights_returnsZerosForNonDepositor


```solidity
function test_realizedWeights_returnsZerosForNonDepositor() public;
```

### test_realizedWeights_returnsEqualWeightsAfterEqualDeposit


```solidity
function test_realizedWeights_returnsEqualWeightsAfterEqualDeposit() public;
```

### test_realizedWeights_noActiveAssets_returnsEmpty


```solidity
function test_realizedWeights_noActiveAssets_returnsEmpty() public;
```

## Events
### WeightSnapshot

```solidity
event WeightSnapshot(
    address indexed depositor, address[] assets, uint256[] bpsWeights, uint256 timestamp
);
```

