# VaultFamilyInvariantsTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/2b01a1006295a36fa4f656f7aeda0a98b3de7411/contracts/test/VaultFamilyInvariants.t.sol)

**Inherits:**
Test

**Title:**
VaultFamilyInvariantsTest

Family-wide invariants that must hold identically across every
vault type, so a new vault type that omits either invariant fails
CI rather than silently diverging (issue #1284).


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


## State Variables
### admin

```solidity
address internal admin = makeAddr("famAdmin")
```


### emergencyResponder

```solidity
address internal emergencyResponder = makeAddr("famEmergency")
```


### feeRecipient

```solidity
address internal feeRecipient = makeAddr("famFeeRecipient")
```


## Functions
### _assertLastAdminFloorHolds

Reused for every vault-family member: the sole `ADMIN_ROLE` holder
cannot renounce or be revoked, but rotating to a second admin
first still works (the floor blocks only the last-holder
transition, not admin rotation).


```solidity
function _assertLastAdminFloorHolds(IAccessControl v, address soleAdmin) internal;
```

### _deployRobotMoneyVault


```solidity
function _deployRobotMoneyVault() internal returns (RobotMoneyVault);
```

### _deployVault


```solidity
function _deployVault() internal returns (Vault);
```

### _deployRwaVault


```solidity
function _deployRwaVault() internal returns (RwaVault);
```

### _deployAgentTokenVault


```solidity
function _deployAgentTokenVault() internal returns (AgentTokenVault);
```

### _deployProtocolAssetVault


```solidity
function _deployProtocolAssetVault() internal returns (ProtocolAssetVault);
```

### test_lastAdminFloor_holdsAcrossVaultFamily

Enumerates every vault type in `contracts/` and asserts the
last-admin floor holds on each. A new vault type added to the
family without inheriting `AdminFloorAccessControlCounter`
must be added here too — see the negative self-test below for
what happens when a type is missing the floor.


```solidity
function test_lastAdminFloor_holdsAcrossVaultFamily() public;
```

### test_lastAdminFloor_negativeSelfTest_unprotectedStubHasNoFloor

Negative self-test (Test Plan): a stub "vault" that forgets to
inherit the shared floor lets its last admin renounce/be
revoked successfully — the opposite of every real family
member above. Proves `_assertLastAdminFloorHolds` is not
vacuously true: plugging this stub into it would fail exactly
where a real vault type missing the floor would be caught
(RobotMoneyVault itself, before this issue's fix, behaved
exactly like this stub).


```solidity
function test_lastAdminFloor_negativeSelfTest_unprotectedStubHasNoFloor() public;
```

### _setupRetiredRmVault


```solidity
function _setupRetiredRmVault(address registry, address depositor)
    internal
    returns (RmFixture memory f);
```

### _setupRetiredBasketVault


```solidity
function _setupRetiredBasketVault(address registry, address depositor)
    internal
    returns (BasketFixture memory f);
```

### test_retirementContract_agreesBetweenRobotMoneyVaultAndBasketVault

RobotMoneyVault and BasketVault model retirement with a
dedicated `retired` flag kept separate from the emergency
pause path. This test drives both families through the SAME
`IRetirableVault` entry points (`retire()`/`unretire()`, called
by the same linked registry) and asserts they agree on the
observable contract: deposits close, `retired()` flips true,
and ERC-4626 `redeem()` stays open (ADR-0009) throughout.


```solidity
function test_retirementContract_agreesBetweenRobotMoneyVaultAndBasketVault() public;
```

## Structs
### RmFixture

```solidity
struct RmFixture {
    RobotMoneyVault vault;
    uint256 shares;
}
```

### BasketFixture

```solidity
struct BasketFixture {
    AgentTokenVault vault;
    MockSwapRouter router;
    TestERC20 usdc;
    uint256 shares;
}
```

