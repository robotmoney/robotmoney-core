# V2MigrationIntegrationTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/227c9c7cc512f0fdf37c470efb82ef9cefda1bf9/contracts/test/V2MigrationIntegration.t.sol)

**Inherits:**
Test


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


### DEPOSIT

```solidity
uint256 internal constant DEPOSIT = 100 * ONE_USDC
```


## State Variables
### usdc

```solidity
MigUsdc internal usdc
```


### registry

```solidity
VaultRegistry internal registry
```


### router

```solidity
PortfolioRouter internal router
```


### v1a

```solidity
MigVault internal v1a
```


### v1b

```solidity
MigVault internal v1b
```


### v2a

```solidity
MigVault internal v2a
```


### v2b

```solidity
MigVault internal v2b
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### legacyDepositor

```solidity
address internal legacyDepositor = makeAddr("legacyDepositor")
```


### newDepositor

```solidity
address internal newDepositor = makeAddr("newDepositor")
```


## Functions
### setUp

Stand up the DEV deployment with the v1 set online: registry + router
linked, v1a/v1b registered + router-eligible, and a full-length
(length-2) default weight vector spanning the v1 set. This is the
steady state the migration starts from.


```solidity
function setUp() public;
```

### test_migration_registerEligibleWeightsRetire_ordering

The full migration ordering on dev: register the v2 set, make it
router-eligible via the atomic interlock while migrating the
default weight vector to span v2, then prove the router actually
allocates a deposit across the v2 set with consistent
eligibility/weights. Also drives retire() last so the ordering
register -> eligible -> weights -> retire is executed end to end.


```solidity
function test_migration_registerEligibleWeightsRetire_ordering() public;
```

### test_retiredV1_honorsRedemptions_noAssistedMigration

A retired v1 vault still honors redemptions indefinitely
(ADR-0009): the holder redeems both directly on the vault and
through the router, and no admin/contract path ever moved the
holder's funds. Runs the register/eligible/weights migration first
so retirement happens against a fully-migrated dev deployment.


```solidity
function test_retiredV1_honorsRedemptions_noAssistedMigration() public;
```

### test_retiredV1_blocksNewDeposits

A retired v1 vault rejects NEW deposits at the vault itself
(deposit-halt) and at the router (non-Active status), so
retirement is genuinely withdraw-only — the withdraw path proven
open above is the ONLY path that remains.


```solidity
function test_retiredV1_blocksNewDeposits() public;
```

### test_migration_votedWeightsSpanV2Set

Beyond the default (below-quorum) vector, the governance-voted
weight vector migrates to the v2 set too: after `setWeights` on
the v2 set, the router routes a deposit by the voted weights.


```solidity
function test_migration_votedWeightsSpanV2Set() public;
```

### _migrateToV2

Run the full atomic eligibility+weights migration from the v1 set to
the v2 set (steps 1–3 of the ordering), leaving the default vector
spanning exactly {v2a, v2b}. Shared by the retirement-focused tests.


```solidity
function _migrateToV2() internal;
```

### _assertInvariant

The ADR-0002 length invariant: the router's default vector length
always equals the registry's router-eligible count. Never observed
inconsistent across the atomic migration.


```solidity
function _assertInvariant(uint256 expected) internal view;
```

### _fundApprove


```solidity
function _fundApprove(address user, uint256 amount) internal;
```

### _meta


```solidity
function _meta(string memory name) internal view returns (VaultRegistry.VaultMetadata memory);
```

### _vaults2


```solidity
function _vaults2(address a, address b) internal pure returns (address[] memory v);
```

### _vaults3


```solidity
function _vaults3(address a, address b, address c) internal pure returns (address[] memory v);
```

### _vaults4


```solidity
function _vaults4(address a, address b, address c, address d)
    internal
    pure
    returns (address[] memory v);
```

### _bps2


```solidity
function _bps2(uint256 a, uint256 b) internal pure returns (uint256[] memory bps);
```

### _bps3


```solidity
function _bps3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory bps);
```

### _bps4


```solidity
function _bps4(uint256 a, uint256 b, uint256 c, uint256 d)
    internal
    pure
    returns (uint256[] memory bps);
```

