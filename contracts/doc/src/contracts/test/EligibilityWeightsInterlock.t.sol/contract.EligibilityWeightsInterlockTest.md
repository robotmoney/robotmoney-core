# EligibilityWeightsInterlockTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/1a25788704e847c258d9460b66a6534bffb0b77e/contracts/test/EligibilityWeightsInterlock.t.sol)

**Inherits:**
Test


## State Variables
### usdc

```solidity
MockUsdc internal usdc
```


### registry

```solidity
VaultRegistry internal registry
```


### router

```solidity
PortfolioRouter internal router
```


### registryAdmin

```solidity
address internal registryAdmin = makeAddr("registryAdmin")
```


### routerAdmin

```solidity
address internal routerAdmin = makeAddr("routerAdmin")
```


### stranger

```solidity
address internal stranger = makeAddr("stranger")
```


### vaultA

```solidity
MockVault internal vaultA
```


### vaultB

```solidity
MockVault internal vaultB
```


### vaultC

```solidity
MockVault internal vaultC
```


### vaultD

```solidity
MockVault internal vaultD
```


### vaultE

```solidity
MockVault internal vaultE
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_deadlock_everyEligibilityFlipReverts

With 4 eligible vaults and a length-4 default vector, EVERY
single non-atomic eligibility change reverts
StaleDefaultWeightsLength — both making a fifth vault eligible
(count would rise to 5) and revoking one (count would fall to 3).
Every escape is closed, so migration deadlocks. (H-A1)


```solidity
function test_deadlock_everyEligibilityFlipReverts() public;
```

### test_migrateEligibility_addsVaultAtomically

The atomic entry point flips eligibility AND sets the new
full-length default vector in one call, without reverting, and
the count==length invariant holds afterwards.


```solidity
function test_migrateEligibility_addsVaultAtomically() public;
```

### test_migrateEligibility_removesVaultAtomically

The same atomic entry point also revokes eligibility while
shrinking the default vector in one call — the other deadlocked
direction.


```solidity
function test_migrateEligibility_removesVaultAtomically() public;
```

### test_migrateEligibility_rejectsPartialUpdate

A partial update — flipping eligibility while supplying a default
vector whose length disagrees with the post-flip count — is
rejected by the router's length check and reverts the WHOLE
transaction, leaving no stale state behind.


```solidity
function test_migrateEligibility_rejectsPartialUpdate() public;
```

### test_applyMigrationDefaultWeights_onlyRegistry

The router's registry-only weight setter cannot be called by
anyone but the linked registry — it carries no independent
authority and reverts OnlyRegistry for every other caller.


```solidity
function test_applyMigrationDefaultWeights_onlyRegistry() public;
```

### test_migrateEligibility_requiresLinkedRouter

`migrateEligibility` requires a linked router; with none, it
reverts RouterNotLinked (use plain setRouterEligible instead).


```solidity
function test_migrateEligibility_requiresLinkedRouter() public;
```

### _meta


```solidity
function _meta(string memory name) internal view returns (VaultRegistry.VaultMetadata memory);
```

### _fourVaults


```solidity
function _fourVaults() internal view returns (address[] memory vaults);
```

### _fourBps


```solidity
function _fourBps() internal pure returns (uint256[] memory bps);
```

### _fiveVaults


```solidity
function _fiveVaults() internal view returns (address[] memory vaults);
```

### _fiveBps


```solidity
function _fiveBps() internal pure returns (uint256[] memory bps);
```

