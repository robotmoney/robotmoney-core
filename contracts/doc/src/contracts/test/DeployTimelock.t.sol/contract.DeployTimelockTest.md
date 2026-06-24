# DeployTimelockTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/fb9985be700340695a515ae6d42f97a508023e8d/contracts/test/DeployTimelock.t.sol)

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
Unified governance `retire()` (DI-2, decision #925; docs/architecture.md §4.7)
is a governance-tier action gated by this same TimelockController (the timelock
holds ADMIN_ROLE on VaultRegistry and RobotMoneyVault — asserted by the AC1
tests below). The `test_retire_*` / `test_shutdownVault_unchanged_*` tests in
the "#942" section prove the retire action is reachable ONLY via the
schedule → mine delay → execute path, reverts on a direct ADMIN_ROLE EOA call,
atomically flips registry status `Retired` + the vault deposit-halt in one
executed call, and leaves the emergency `shutdownVault` overlay unchanged.


## Constants
### ADMIN_ROLE

```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### EMERGENCY_ROLE

```solidity
bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE")
```


### AGENT_ROLE

```solidity
bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE")
```


### DEFAULT_ADMIN_ROLE

```solidity
bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00
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


### emergency

```solidity
address internal emergency = makeAddr("emergency")
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

### test_INV3_setFeeRecipient_directHotKeyCallReverts

INV-3: a direct (non-timelock) setFeeRecipient call from the Safe
hot key reverts — the Safe holds PROPOSER/EXECUTOR on the timelock,
not ADMIN_ROLE on the vault.


```solidity
function test_INV3_setFeeRecipient_directHotKeyCallReverts() public;
```

### test_INV3_setExitFeeBps_directHotKeyCallReverts

INV-3: a direct (non-timelock) setExitFeeBps call from the Safe hot
key reverts for the same reason.


```solidity
function test_INV3_setExitFeeBps_directHotKeyCallReverts() public;
```

### test_INV3_setFeeRecipient_succeedsViaTimelock

INV-3: setFeeRecipient succeeds ONLY when routed through the
TimelockController (schedule → delay → execute).


```solidity
function test_INV3_setFeeRecipient_succeedsViaTimelock() public;
```

### test_INV3_setExitFeeBps_succeedsViaTimelock

INV-3: setExitFeeBps succeeds ONLY when routed through the
TimelockController.


```solidity
function test_INV3_setExitFeeBps_succeedsViaTimelock() public;
```

### test_AC3_setQuarantineAddress_directHotKeyCallReverts

AC3: a direct (non-timelock) setQuarantineAddress call from the
Safe hot key reverts — the Safe holds only PROPOSER/EXECUTOR on
the timelock, not ADMIN_ROLE on the vault.


```solidity
function test_AC3_setQuarantineAddress_directHotKeyCallReverts() public;
```

### test_AC3_setQuarantineAddress_succeedsViaTimelock

AC3: setQuarantineAddress succeeds ONLY when routed through the
TimelockController (schedule → delay → execute). After the update,
foreign-token sweeps on the vault go to the new address, not the
old constant — proving the governed quarantine model is end-to-end.


```solidity
function test_AC3_setQuarantineAddress_succeedsViaTimelock() public;
```

### _registerVaultViaTimelock

Register a vault through the timelock so later retire() tests have a
registered target. Returns nothing — registers `address(vault)`.


```solidity
function _registerVaultViaTimelock() internal;
```

### test_retire_directHotKeyCallReverts

#942 AC2: a direct (non-timelock) retire() call from the Safe hot
key reverts — the Safe holds PROPOSER/EXECUTOR on the timelock, not
ADMIN_ROLE on the registry.


```solidity
function test_retire_directHotKeyCallReverts() public;
```

### test_retire_directStrangerCallReverts

#942 AC2: a stranger EOA likewise cannot call retire().


```solidity
function test_retire_directStrangerCallReverts() public;
```

### test_retire_succeedsViaTimelock_atomicallyHaltsDeposits

#942 AC3: retire() routed through the TimelockController (schedule →
delay → execute) atomically sets registry status to `Retired` AND
halts vault deposits in one transaction. Pre-delay execution must
revert, proving the action is reachable only after the delay.


```solidity
function test_retire_succeedsViaTimelock_atomicallyHaltsDeposits() public;
```

### test_shutdownVault_unchanged_makesNoRegistryChange

#942: `shutdownVault` is unchanged — still EMERGENCY-tier,
vault-only, with NO registry state change. After the #965/F-01
handover the vault's EMERGENCY_ROLE is held by the independent
`emergency` hot key (NOT the deployer/script and NOT the timelock);
exercising it directly proves the emergency overlay still works and
touches no registry state.


```solidity
function test_shutdownVault_unchanged_makesNoRegistryChange() public;
```

### test_ACL1_timelockHoldsGatewayRootAfterHandover

ACL-1: the Timelock receives BOTH ADMIN_ROLE and DEFAULT_ADMIN_ROLE
on the Gateway (so it can rotate roles / authorizeAgent), and holds
ADMIN_ROLE on the vault.


```solidity
function test_ACL1_timelockHoldsGatewayRootAfterHandover() public view;
```

### test_ACL1_vaultEmergencyRoleHeldByIndependentHotKey

AC: the vault EMERGENCY_ROLE is held by the independent hot key
(not the timelock — emergency response stays a fast hot-key path).


```solidity
function test_ACL1_vaultEmergencyRoleHeldByIndependentHotKey() public view;
```

### test_ACL1_agentRoleRemainsGrantableByTimelockAfterRevoke

Fix-interaction (F-01): AGENT_ROLE's admin is ADMIN_ROLE, so after
the DEFAULT_ADMIN_ROLE revoke the Timelock (ADMIN_ROLE) can still
grant AGENT_ROLE directly. Proves the revoke did not brick agent
onboarding.


```solidity
function test_ACL1_agentRoleRemainsGrantableByTimelockAfterRevoke() public;
```

### test_ACL1_timelockCanAuthorizeAgentAfterHandover

AC: the Timelock can `authorizeAgent` on the Gateway post-handover
(the gateway-native onboarding path, now ADMIN_ROLE-gated).


```solidity
function test_ACL1_timelockCanAuthorizeAgentAfterHandover() public;
```

### test_ACL1_directAuthorizeAgentFromHotKeyReverts

AC: a hot key (the Safe) that holds neither DEFAULT_ADMIN_ROLE nor
ADMIN_ROLE on the Gateway cannot directly authorizeAgent — only the
timelock-routed path works. Guards the role gate post-handover.


```solidity
function test_ACL1_directAuthorizeAgentFromHotKeyReverts() public;
```

### test_ACL1_nakedDefaultAdminRevoke_bricksAgentRoleWithoutReadmin

Negative regression for the fix-interaction warning: a NAKED
DEFAULT_ADMIN_ROLE revoke that did NOT redirect AGENT_ROLE's admin
to ADMIN_ROLE would leave AGENT_ROLE ungrantable forever. We build
a throwaway gateway whose AGENT_ROLE admin is the default
(DEFAULT_ADMIN_ROLE), revoke that root from the only holder, and
assert AGENT_ROLE can no longer be granted — proving the
constructor's `_setRoleAdmin(AGENT_ROLE, ADMIN_ROLE)` is what keeps
the real gateway safe.


```solidity
function test_ACL1_nakedDefaultAdminRevoke_bricksAgentRoleWithoutReadmin() public;
```

### _agentPolicy

Minimal active AgentPolicy used by the authorize tests.


```solidity
function _agentPolicy() internal returns (IGateway.AgentPolicy memory p);
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

