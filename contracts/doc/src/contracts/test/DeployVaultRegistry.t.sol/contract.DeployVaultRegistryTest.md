# DeployVaultRegistryTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/cf8a75c9169f98b8e30f0ad4e13af73b36f22bc7/contracts/test/DeployVaultRegistry.t.sol)

**Inherits:**
Test

Exercises DeployVaultRegistry in-process and asserts the post-deploy
invariants the smoke-test and downstream tooling rely on.


## State Variables
### script

```solidity
DeployVaultRegistry internal script
```


### usdc

```solidity
TestERC20 internal usdc
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### vault

```solidity
address internal vault = makeAddr("vault")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_deploy_registersVault

Deploy deploys a registry and registers the vault.


```solidity
function test_deploy_registersVault() public;
```

### test_deploy_emitsVaultRegistered

Registry emits VaultRegistered for RobotMoneyVault.


```solidity
function test_deploy_emitsVaultRegistered() public;
```

### test_deploy_vaultIsActive

Registered vault has Active status immediately.


```solidity
function test_deploy_vaultIsActive() public;
```

### test_deploy_metadataStoredCorrectly

Metadata stored matches what was passed in.


```solidity
function test_deploy_metadataStoredCorrectly() public;
```

### test_deploy_adminAddressSet

Admin address returned matches what was passed in.


```solidity
function test_deploy_adminAddressSet() public;
```

### test_deploy_idempotent_noRevertOnDuplicate

Re-running with the same vault does not revert and does not
emit a duplicate VaultRegistered event.
The idempotency guard is exercised by calling runInProcessWith
twice on the same registry instance via a custom helper that
calls _registerIfAbsent directly.


```solidity
function test_deploy_idempotent_noRevertOnDuplicate() public;
```

### test_deploy_revertsOnZeroAdmin


```solidity
function test_deploy_revertsOnZeroAdmin() public;
```

### test_deploy_revertsOnZeroVault


```solidity
function test_deploy_revertsOnZeroVault() public;
```

### test_deploy_revertsOnZeroAsset


```solidity
function test_deploy_revertsOnZeroAsset() public;
```

