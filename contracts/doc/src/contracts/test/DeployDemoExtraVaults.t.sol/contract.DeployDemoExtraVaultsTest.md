# DeployDemoExtraVaultsTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/17d3c27bc19dd2e7dd9dd09c12e0fb0b8179d593/contracts/test/DeployDemoExtraVaults.t.sol)

**Inherits:**
Test

Integration test for the demo seed path: after `DeployDemoExtraVaults`
runs, the router carries a non-empty default (below-quorum fallback)
weight vector pointing at the primary vault, and `previewDeposit`
routes by it with no governance activity. ADR-0002.


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
a single-leg pointing at the primary vault (the only PRD §11
router-eligible vault; basket vaults stay gap-blocked), and
`previewDeposit` with no governance activity routes the full
deposit there.


```solidity
function test_demo_seed_populates_defaultWeights() public;
```

