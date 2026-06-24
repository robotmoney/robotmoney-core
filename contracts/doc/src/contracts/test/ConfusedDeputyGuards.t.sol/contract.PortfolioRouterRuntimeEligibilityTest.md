# PortfolioRouterRuntimeEligibilityTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/5a164c31574dc88f5c31048af5cc49fb7a941a1f/contracts/test/ConfusedDeputyGuards.t.sol)

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

### test_invariant11_deposit_skipsVaultThatLosesEligibilityAfterWeighting

A vault that loses router-eligibility after being weighted must
never receive USDC at deposit time. With skip-and-renormalise
(RTR-5 / F-13) the ineligible leg is skipped; here it is the ONLY
weighted vault, so the basket is consistently unavailable —
previewDeposit reports the single leg unavailable and deposit
reverts `NoWeightsSet` rather than routing USDC into the ineligible
vault. Either way the ineligible vault is never funded (invariant 11).


```solidity
function test_invariant11_deposit_skipsVaultThatLosesEligibilityAfterWeighting() public;
```

### test_invariant11b_setWeights_rejectsIneligibleVault

setWeights rejects a vault that is not router-eligible, preventing
ineligible vaults from ever entering the weight vector in the first
place (configuration-time check complements the runtime check).


```solidity
function test_invariant11b_setWeights_rejectsIneligibleVault() public;
```

