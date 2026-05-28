# DeployDemoExtraVaultsTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e725858583e4c0e5819bd858f896d04ded40bdb7/contracts/test/DeployDemoExtraVaults.t.sol)

**Inherits:**
Test

Integration test for the demo seed path: after `DeployDemoExtraVaults`
runs, the router carries a non-empty default (below-quorum fallback)
weight vector spanning the three demo vaults, and `previewDeposit`
routes by that vector with no governance activity. ADR-0002.


## Constants
### W_PRIMARY

```solidity
uint256 constant W_PRIMARY = 5_000
```


### W_EXTRA1

```solidity
uint256 constant W_EXTRA1 = 3_000
```


### W_EXTRA2

```solidity
uint256 constant W_EXTRA2 = 2_000
```


## State Variables
### script

```solidity
DeployDemoExtraVaults internal script
```


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


### primaryVault

```solidity
RobotMoneyVault internal primaryVault
```


### admin

```solidity
address internal admin = address(this)
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_demo_seed_populates_defaultWeights

After the demo seed runs, the router's default weight vector is
the non-empty three-way split, and `previewDeposit` with no
governance activity (voted vector inactive) routes by it.


```solidity
function test_demo_seed_populates_defaultWeights() public;
```

