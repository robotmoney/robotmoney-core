# VaultRegistryTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/cfe094f56f7148155d6999efbd87ac66367ad208/contracts/test/VaultRegistry.t.sol)

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

### test_setRouterEligible_tracksCount

setRouterEligible maintains `routerEligibleCount` as the number
of vaults currently flagged eligible.


```solidity
function test_setRouterEligible_tracksCount() public;
```

### test_setRouterEligible_blocks_stale_defaultWeights_length

With a linked router carrying a non-empty default weight vector,
a setRouterEligible change that would leave that vector with a
stale length reverts. An empty default vector is exempt, and a
re-set default that matches the new count is accepted.


```solidity
function test_setRouterEligible_blocks_stale_defaultWeights_length() public;
```

### test_setRouter_adminOnlyAndEmits

setRouter is gated by ADMIN_ROLE and emits RouterSet.


```solidity
function test_setRouter_adminOnlyAndEmits() public;
```

### test_setRouter_unlinkReverts_whenDefaultVectorNonEmpty

setRouter(address(0)) reverts with RouterUnlinkBlocked when the
currently-linked router still has a non-empty default weight
vector. ADR-0002 bypass-prevention.


```solidity
function test_setRouter_unlinkReverts_whenDefaultVectorNonEmpty() public;
```

### test_setRouter_unlink_succeedsWithNoDefaultVector

setRouter(address(0)) succeeds when no default weight vector is
set (initial deployment path).


```solidity
function test_setRouter_unlink_succeedsWithNoDefaultVector() public;
```

### test_setRouter_unlink_succeeds_whenNoPriorRouter

setRouter(address(0)) when no router was ever linked succeeds
unconditionally (idempotent unlink).


```solidity
function test_setRouter_unlink_succeeds_whenNoPriorRouter() public;
```

### test_setRouterEligible_noRouter_countUpdatesAndInvariantHolds

setRouterEligible() with router == address(0) (initial state,
no default vector configured) decrements routerEligibleCount
and leaves the stale-length invariant satisfied — there is no
default weight vector to protect. ADR-0002.


```solidity
function test_setRouterEligible_noRouter_countUpdatesAndInvariantHolds() public;
```

### test_bypassSequence_blockedAtUnlink

The full bypass sequence (setRouter(0) → revoke eligibility →
re-link) is blocked at the setRouter(0) step when a non-empty
default vector is present.


```solidity
function test_bypassSequence_blockedAtUnlink() public;
```

