# AgentTokenVaultGovernanceTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/8fe82accd34499f358df165500b889c234fe064a/contracts/test/AgentTokenVault.t.sol)

**Inherits:**
Test


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


### ADD_DELAY

```solidity
uint256 internal constant ADD_DELAY = 48 hours
```


### REMOVE_DELAY

```solidity
uint256 internal constant REMOVE_DELAY = 24 hours
```


## State Variables
### usdc

```solidity
TestERC20 internal usdc
```


### router

```solidity
RecordingSwapRouter internal router
```


### vault

```solidity
AgentTokenVault internal vault
```


### timelock

```solidity
TimelockController internal timelock
```


### safe

```solidity
address internal safe
```


### signer

```solidity
address internal signer = makeAddr("signer")
```


### stranger

```solidity
address internal stranger = makeAddr("stranger")
```


### tokenA

```solidity
TestERC20 internal tokenA
```


### tokenB

```solidity
TestERC20 internal tokenB
```


### poolA

```solidity
MockPool internal poolA
```


### poolB

```solidity
MockPool internal poolB
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _scheduleAddAsset


```solidity
function _scheduleAddAsset(address token_, address pool_, uint24 fee_, bytes32 salt_)
    internal
    returns (bytes32 opId);
```

### _executeAddAsset


```solidity
function _executeAddAsset(address token_, address pool_, uint24 fee_, bytes32 salt_) internal;
```

### _scheduleRemoveAsset


```solidity
function _scheduleRemoveAsset(uint256 index_, bytes32 salt_) internal returns (bytes32 opId);
```

### _executeRemoveAsset


```solidity
function _executeRemoveAsset(uint256 index_, bytes32 salt_) internal;
```

### test_governance_timelocked_addAsset_executes_after_delay

A timelock-routed addAsset queued with the Safe proposer and
executed after SHORTLIST_ADD_DELAY successfully adds the token.


```solidity
function test_governance_timelocked_addAsset_executes_after_delay() public;
```

### test_governance_timelocked_removeAsset_executes_after_delay

A timelock-routed removeAsset queued and executed after the delay
deactivates the token. Vault must hold zero of the token to remove.


```solidity
function test_governance_timelocked_removeAsset_executes_after_delay() public;
```

### test_governance_veto_cancels_pending_addAsset

Any canceller may cancel a queued addAsset before execution.
After cancellation the operation cannot be executed.


```solidity
function test_governance_veto_cancels_pending_addAsset() public;
```

### test_governance_safe_can_cancel_own_proposal

The Safe itself (proposer/executor) can also cancel a queued change.


```solidity
function test_governance_safe_can_cancel_own_proposal() public;
```

### test_governance_direct_addAsset_rejected_for_stranger

A stranger cannot call addAsset directly on the vault because
ADMIN_ROLE is now held by the timelock, not an EOA.


```solidity
function test_governance_direct_addAsset_rejected_for_stranger() public;
```

### test_governance_direct_removeAsset_rejected_for_stranger

A stranger cannot call removeAsset directly because ADMIN_ROLE is
held by the timelock.


```solidity
function test_governance_direct_removeAsset_rejected_for_stranger() public;
```

### test_governance_non_proposer_cannot_schedule_shortlist_change

A non-proposer cannot queue a shortlist change via the timelock.


```solidity
function test_governance_non_proposer_cannot_schedule_shortlist_change() public;
```

### test_governance_addAsset_rejects_low_cardinality_pool

addAsset reverts when the pool has insufficient observation
cardinality (the on-chain component of the ADR-0004 liquidity/oracle gate).


```solidity
function test_governance_addAsset_rejects_low_cardinality_pool() public;
```

### test_governance_addAsset_rejects_wrong_pool_pair

addAsset reverts when the pool does not pair the token with USDC.


```solidity
function test_governance_addAsset_rejects_wrong_pool_pair() public;
```

