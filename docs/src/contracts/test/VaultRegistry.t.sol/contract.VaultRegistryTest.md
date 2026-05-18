# VaultRegistryTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/31a8dcee8651b68de6fb5481acf7c895437acde1/contracts/test/VaultRegistry.t.sol)

**Inherits:**
Test


## State Variables
### registry

```solidity
VaultRegistry internal registry
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### stranger

```solidity
address internal stranger = makeAddr("stranger")
```


### vault1

```solidity
address internal vault1 = makeAddr("vault1")
```


### vault2

```solidity
address internal vault2 = makeAddr("vault2")
```


### vault3

```solidity
address internal vault3 = makeAddr("vault3")
```


### meta1

```solidity
VaultRegistry.VaultMetadata internal meta1 = VaultRegistry.VaultMetadata({
    name: "Robot Money USDC",
    asset: makeAddr("usdc"),
    registeredAt: 0 // populated by contract, ignored in fixture
})
```


### meta2

```solidity
VaultRegistry.VaultMetadata internal meta2 = VaultRegistry.VaultMetadata({
    name: "Robot Money ETH", asset: makeAddr("weth"), registeredAt: 0
})
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_constructor_revertsOnZeroAdmin


```solidity
function test_constructor_revertsOnZeroAdmin() public;
```

### test_constructor_grantsAdminRole


```solidity
function test_constructor_grantsAdminRole() public view;
```

### test_constructor_vaultCountIsZero


```solidity
function test_constructor_vaultCountIsZero() public view;
```

### test_registerVault_succeeds


```solidity
function test_registerVault_succeeds() public;
```

### test_registerVault_emitsVaultRegistered


```solidity
function test_registerVault_emitsVaultRegistered() public;
```

### test_registerVault_setsActiveStatus


```solidity
function test_registerVault_setsActiveStatus() public;
```

### test_registerVault_storesMetadata


```solidity
function test_registerVault_storesMetadata() public;
```

### test_registerVault_multipleVaults_registrationOrder


```solidity
function test_registerVault_multipleVaults_registrationOrder() public;
```

### test_registerVault_revertsOnZeroAddress


```solidity
function test_registerVault_revertsOnZeroAddress() public;
```

### test_registerVault_revertsOnDuplicate


```solidity
function test_registerVault_revertsOnDuplicate() public;
```

### test_registerVault_revertsForUnauthorizedCaller


```solidity
function test_registerVault_revertsForUnauthorizedCaller() public;
```

### test_setVaultStatus_toPaused


```solidity
function test_setVaultStatus_toPaused() public;
```

### test_setVaultStatus_toRetired


```solidity
function test_setVaultStatus_toRetired() public;
```

### test_setVaultStatus_activeAfterPaused


```solidity
function test_setVaultStatus_activeAfterPaused() public;
```

### test_setVaultStatus_emitsVaultStatusChanged


```solidity
function test_setVaultStatus_emitsVaultStatusChanged() public;
```

### test_setVaultStatus_revertsForNotRegistered


```solidity
function test_setVaultStatus_revertsForNotRegistered() public;
```

### test_setVaultStatus_revertsForUnauthorizedCaller


```solidity
function test_setVaultStatus_revertsForUnauthorizedCaller() public;
```

### test_getVault_revertsForNotRegistered


```solidity
function test_getVault_revertsForNotRegistered() public;
```

### test_listVaults_emptyInitially


```solidity
function test_listVaults_emptyInitially() public view;
```

### test_listVaults_lengthMatchesVaultCount_after_multiple


```solidity
function test_listVaults_lengthMatchesVaultCount_after_multiple() public;
```

### testFuzz_listVaultsLength_equalsVaultCount

Registers `n` distinct vaults and asserts `listVaults().length == vaultCount()`.


```solidity
function testFuzz_listVaultsLength_equalsVaultCount(uint8 n) public;
```

