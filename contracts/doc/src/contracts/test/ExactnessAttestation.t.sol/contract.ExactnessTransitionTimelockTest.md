# ExactnessTransitionTimelockTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/01b59e20caa97f6392c68e2a81dce4c5d658f622/contracts/test/ExactnessAttestation.t.sol)

**Inherits:**
[ExactnessBase](/contracts/test/ExactnessAttestation.t.sol/abstract.ExactnessBase.md)


## State Variables
### registry

```solidity
VaultRegistry internal registry
```


## Functions
### setUp


```solidity
function setUp() public override;
```

### _newInexact


```solidity
function _newInexact() internal returns (SelfReportLiarAdapter a);
```

### test_sameClassExactAdd_needsNoArm_staysAllExact

A same-class add (a second EXACT adapter to an all-exact vault)
needs no arm, keeps `allExact()` true, and fires no transition.


```solidity
function test_sameClassExactAdd_needsNoArm_staysAllExact() public;
```

### test_firstInexactAdd_revertsWithoutArm

Adding the first inexact adapter to an operating all-exact vault
reverts when the transition was never armed.


```solidity
function test_firstInexactAdd_revertsWithoutArm() public;
```

### test_firstInexactAdd_revertsBeforeDelayElapses

Even once armed, the flip reverts until `EXACTNESS_TRANSITION_DELAY`
has elapsed.


```solidity
function test_firstInexactAdd_revertsBeforeDelayElapses() public;
```

### test_firstInexactAdd_succeedsAfterDelay_emitsEvent_flipsAllExact

After the delay elapses the flip lands: it emits
`ExactnessTransition(true, false, adapter)`, flips `allExact()`
to false, and the registry-visible flag mirrors the new class.


```solidity
function test_firstInexactAdd_succeedsAfterDelay_emitsEvent_flipsAllExact() public;
```

### test_registryVisibleFlag_matchesVaultAllExact

The registry-visible flag tracks the vault's live class before and
after the flip (read-through, so it can never drift).


```solidity
function test_registryVisibleFlag_matchesVaultAllExact() public;
```

## Events
### ExactnessTransition

```solidity
event ExactnessTransition(bool wasAllExact, bool nowAllExact, address indexed adapter);
```

