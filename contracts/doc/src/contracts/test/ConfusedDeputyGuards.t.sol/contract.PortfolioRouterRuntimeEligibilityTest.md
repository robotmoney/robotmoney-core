# PortfolioRouterRuntimeEligibilityTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/9eed07634921aa5428fc9e4e6b0452434840368d/contracts/test/ConfusedDeputyGuards.t.sol)

**Inherits:**
Test

**Title:**
PortfolioRouterRuntimeEligibilityTest

Pins invariant 11: a vault that became ineligible after being weighted
cannot receive USDC at deposit time (runtime re-check via
_requireRouterEligible inside _executeLegs).


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


### registry

```solidity
VaultRegistry internal registry
```


### router

```solidity
PortfolioRouter internal router
```


### vaultA

```solidity
MockVault internal vaultA
```


### admin

```solidity
address internal admin = makeAddr("admin")
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

### test_invariant11_deposit_revertsIfVaultLosesEligibilityAfterWeighting

A vault that loses router-eligibility after being weighted must
not receive USDC at deposit time. _requireRouterEligible is called
inside _executeLegs on every leg, blocking ineligible vaults even
when they are still in the weight vector.


```solidity
function test_invariant11_deposit_revertsIfVaultLosesEligibilityAfterWeighting() public;
```

### test_invariant11b_setWeights_rejectsIneligibleVault

setWeights rejects a vault that is not router-eligible, preventing
ineligible vaults from ever entering the weight vector in the first
place (configuration-time check complements the runtime check).


```solidity
function test_invariant11b_setWeights_rejectsIneligibleVault() public;
```

