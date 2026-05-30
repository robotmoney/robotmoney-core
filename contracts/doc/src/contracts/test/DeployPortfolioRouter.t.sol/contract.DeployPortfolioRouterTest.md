# DeployPortfolioRouterTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/d6ea170b5db4fe1e5559433d38b4563ca140fbfc/contracts/test/DeployPortfolioRouter.t.sol)

**Inherits:**
Test

Exercises DeployPortfolioRouter in-process and asserts post-deploy
invariants the smoke-test and downstream tooling rely on.


## State Variables
### script

```solidity
DeployPortfolioRouter internal script
```


### registryScript

```solidity
DeployVaultRegistry internal registryScript
```


### usdc

```solidity
TestERC20 internal usdc
```


### registry

```solidity
VaultRegistry internal registry
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### vault

```solidity
address internal vault
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_deploy_routerDeployed

Deploy deploys a router with the correct constructor args.


```solidity
function test_deploy_routerDeployed() public;
```

### test_deploy_adminHasRole

Admin holds ADMIN_ROLE on the newly deployed router.


```solidity
function test_deploy_adminHasRole() public;
```

### test_deploy_initialWeightsSet

Initial weights are 10 000 bps to RobotMoneyVault.


```solidity
function test_deploy_initialWeightsSet() public;
```

### test_deploy_emitsWeightsSet

setWeights emits WeightsSet event with the correct args.


```solidity
function test_deploy_emitsWeightsSet() public;
```

### test_deploy_structFieldsMatchInputs

Returned struct fields match input parameters.


```solidity
function test_deploy_structFieldsMatchInputs() public;
```

### test_deploy_revertsOnZeroAdmin


```solidity
function test_deploy_revertsOnZeroAdmin() public;
```

### test_deploy_revertsOnZeroRegistry


```solidity
function test_deploy_revertsOnZeroRegistry() public;
```

### test_deploy_revertsOnZeroVault


```solidity
function test_deploy_revertsOnZeroVault() public;
```

### test_deploy_revertsOnZeroUsdc


```solidity
function test_deploy_revertsOnZeroUsdc() public;
```

### test_deploy_revertsOnUnregisteredVault

Deploying with a vault not in the registry reverts (setWeights
calls registry.getVault which reverts with NotRegistered).


```solidity
function test_deploy_revertsOnUnregisteredVault() public;
```

