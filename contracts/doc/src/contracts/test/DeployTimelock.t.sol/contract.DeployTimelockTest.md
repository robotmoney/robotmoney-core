# DeployTimelockTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/0e0f94d96bb3900f4fd22dd5ae7b5741099dfdba/contracts/test/DeployTimelock.t.sol)

**Inherits:**
Test

Fork-style unit tests for DeployTimelock.s.sol (issue #414).
These tests run in-process using Forge cheatcodes so they do not
require a live fork RPC. They exercise all six acceptance-criteria
scenarios:
AC1  TimelockController holds ADMIN_ROLE on all five contracts.
AC2  Direct ADMIN_ROLE call from Safe EOA reverts with
AccessControlUnauthorizedAccount.
AC3  TimelockController-routed call (schedule → mine delay → execute)
mines and executes the operation successfully.
AC4  Pre-delay execute reverts.
AC5  TimelockController.getMinDelay() is verifiable on-chain.
AC6  ADMIN_ROLE grant routed through Timelock succeeds.


## Constants
### ADMIN_ROLE

```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### MIN_DELAY

```solidity
uint256 public constant MIN_DELAY = 2 days
```


## State Variables
### admin

```solidity
address internal admin = makeAddr("admin")
```


### safe

```solidity
address internal safe
```


### stranger

```solidity
address internal stranger = makeAddr("stranger")
```


### newAdmin

```solidity
address internal newAdmin = makeAddr("newAdmin")
```


### usdc

```solidity
TestERC20 internal usdc
```


### vault

```solidity
RobotMoneyVault internal vault
```


### gateway

```solidity
RobotMoneyGateway internal gateway
```


### registry

```solidity
VaultRegistry internal registry
```


### router

```solidity
PortfolioRouter internal router
```


### governance

```solidity
RouterGovernance internal governance
```


### script

```solidity
DeployTimelock internal script
```


### d

```solidity
DeployTimelock.Deployed internal d
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_timelock_holdsAdminRoleOnRegistry

After DeployTimelock, the TimelockController holds ADMIN_ROLE on
each contract.


```solidity
function test_timelock_holdsAdminRoleOnRegistry() public view;
```

### test_timelock_holdsAdminRoleOnRouter


```solidity
function test_timelock_holdsAdminRoleOnRouter() public view;
```

### test_timelock_holdsAdminRoleOnGovernance


```solidity
function test_timelock_holdsAdminRoleOnGovernance() public view;
```

### test_timelock_holdsAdminRoleOnVault

After DeployTimelock, the TimelockController holds ADMIN_ROLE on
the real RobotMoneyVault instance (not a registry placeholder).


```solidity
function test_timelock_holdsAdminRoleOnVault() public view;
```

### test_timelock_holdsAdminRoleOnGateway

After DeployTimelock, the TimelockController holds ADMIN_ROLE on
the real RobotMoneyGateway instance (not a registry placeholder).


```solidity
function test_timelock_holdsAdminRoleOnGateway() public view;
```

### test_deployer_noLongerHasAdminRoleOnRegistry

After role transfer, the deployer (admin EOA) no longer holds
ADMIN_ROLE on any contract.


```solidity
function test_deployer_noLongerHasAdminRoleOnRegistry() public view;
```

### test_deployer_noLongerHasAdminRoleOnRouter


```solidity
function test_deployer_noLongerHasAdminRoleOnRouter() public view;
```

### test_deployer_noLongerHasAdminRoleOnGovernance


```solidity
function test_deployer_noLongerHasAdminRoleOnGovernance() public view;
```

### test_safe_holdsProposerRole


```solidity
function test_safe_holdsProposerRole() public view;
```

### test_safe_holdsExecutorRole


```solidity
function test_safe_holdsExecutorRole() public view;
```

### test_directAdminCall_revertsFromSafe

A direct call to setVaultStatus from the Safe (which previously
held ADMIN_ROLE) must revert with AccessControlUnauthorizedAccount
now that ADMIN_ROLE is held by the TimelockController.
We use registerVault as a representative ADMIN_ROLE gated call
on VaultRegistry. setVaultStatus requires the vault to be registered
first; registerVault is simpler to use here.


```solidity
function test_directAdminCall_revertsFromSafe() public;
```

### test_directAdminCall_revertsFromStranger

Any random EOA that never held ADMIN_ROLE also cannot call
ADMIN_ROLE gated functions.


```solidity
function test_directAdminCall_revertsFromStranger() public;
```

### test_timelockRouted_registerVault_succeedsAfterDelay

Schedule a registerVault call through TimelockController, assert
pre-delay execute reverts, mine the delay, then execute and verify
the vault is registered.


```solidity
function test_timelockRouted_registerVault_succeedsAfterDelay() public;
```

### test_getMinDelay_returnsConfiguredValue


```solidity
function test_getMinDelay_returnsConfiguredValue() public view;
```

### test_timelockRouted_adminRoleGrant_succeedsAfterDelay

Schedule an ADMIN_ROLE grant for a new address through the
TimelockController, mine the delay, execute, and verify the
new address has ADMIN_ROLE on VaultRegistry.


```solidity
function test_timelockRouted_adminRoleGrant_succeedsAfterDelay() public;
```

### test_deploy_revertsOnZeroSafe


```solidity
function test_deploy_revertsOnZeroSafe() public;
```

### test_deploy_revertsOnZeroMinDelay


```solidity
function test_deploy_revertsOnZeroMinDelay() public;
```

### test_deploy_revertsWhenSafeIsEOA

DeployTimelock.s.sol aborts when SAFE_ADDRESS has no deployed code.

We pass a freshly-minted address that has no bytecode.  The script's
new `code.length` guard should revert before attempting any state writes.


```solidity
function test_deploy_revertsWhenSafeIsEOA() public;
```

### test_deploy_revertsWhenSafeThresholdTooLow

DeployTimelock.s.sol aborts when the Safe at SAFE_ADDRESS has threshold < 2.

We deploy a `MockLowThresholdSafe` that returns `1` from `getThreshold()`.
Passing a 1-of-N Safe as PROPOSER would reduce multisig security to a
single-key model.


```solidity
function test_deploy_revertsWhenSafeThresholdTooLow() public;
```

