# DeployProtocolAssetVaultTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/0d868fe02e5cf19ce075213817ca84416ca13c09/contracts/test/DeployProtocolAssetVault.t.sol)

**Inherits:**
Test

Tests for DeployProtocolAssetVault.s.sol.
Acceptance criteria (issue #692):
- Script deploys ProtocolAssetVault with a non-zero address.
- Vault is registered in VaultRegistry when REGISTRY_ADDRESS is provided.
- Script does NOT call setRouterEligible (vault stays ineligible after deploy).
- Zero-address guards on required parameters revert with expected messages.


## State Variables
### script

```solidity
DeployProtocolAssetVault internal script
```


### usdc

```solidity
TestERC20 internal usdc
```


### swapRouter

```solidity
StubSwapRouter internal swapRouter
```


### registry

```solidity
VaultRegistry internal registry
```


### admin

```solidity
address internal admin = address(this)
```


### emergencyResponder

```solidity
address internal emergencyResponder = makeAddr("emergencyResponder")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_deploy_vaultAddressNonZero

Vault address is non-zero after deploy without registry.


```solidity
function test_deploy_vaultAddressNonZero() public;
```

### test_deploy_notRegisteredWhenNoRegistry

Without REGISTRY_ADDRESS, registered flag is false.


```solidity
function test_deploy_notRegisteredWhenNoRegistry() public;
```

### test_deploy_registersVaultInRegistry

Vault is registered in VaultRegistry when registry is provided.


```solidity
function test_deploy_registersVaultInRegistry() public;
```

### test_deploy_metadataStoredCorrectly

Vault metadata stored in registry matches expected values.


```solidity
function test_deploy_metadataStoredCorrectly() public;
```

### test_deploy_vaultIsActiveAfterRegistration

Vault has Active status immediately after registration.


```solidity
function test_deploy_vaultIsActiveAfterRegistration() public;
```

### test_deploy_doesNotSetRouterEligible

The deploy script must NOT call setRouterEligible. Router
eligibility activation is separated into
ActivateBasketVaultEligibility.s.sol and is gated behind the
BASKET_VAULT_AUDIT_COMPLETE env flag.


```solidity
function test_deploy_doesNotSetRouterEligible() public;
```

### test_deploy_vaultAssetIsUsdc

Vault's ERC-4626 asset() returns the configured USDC address.


```solidity
function test_deploy_vaultAssetIsUsdc() public;
```

### test_deploy_adminHoldsAdminRole

Admin holds ADMIN_ROLE on the deployed vault.


```solidity
function test_deploy_adminHoldsAdminRole() public;
```

### test_reverts_on_zero_admin


```solidity
function test_reverts_on_zero_admin() public;
```

### test_reverts_on_zero_emergencyResponder


```solidity
function test_reverts_on_zero_emergencyResponder() public;
```

### test_reverts_on_zero_swapRouter


```solidity
function test_reverts_on_zero_swapRouter() public;
```

### test_reverts_on_zero_usdc


```solidity
function test_reverts_on_zero_usdc() public;
```

