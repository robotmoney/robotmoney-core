# ActivateBasketVaultEligibilityTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/41d10069f3131869b5f2aee11bc920913e4ab3a6/contracts/test/ActivateBasketVaultEligibility.t.sol)

**Inherits:**
Test

Tests for ActivateBasketVaultEligibility.s.sol.
The acceptance criteria (issue #692):
- Reverts when `BASKET_VAULT_AUDIT_COMPLETE` is not set (passed as false).
- Succeeds with `isRouterEligible` returning true for both vaults when
`BASKET_VAULT_AUDIT_COMPLETE` is set to "true".
Uses `runInProcessWith(auditComplete=true/false)` to exercise both paths
without requiring env var manipulation inside forge tests.


## State Variables
### script

```solidity
ActivateBasketVaultEligibility internal script
```


### usdc

```solidity
TestERC20 internal usdc
```


### registry

```solidity
VaultRegistry internal registry
```


### admin

```solidity
address internal admin = address(this)
```


### protocolVault

```solidity
address internal protocolVault
```


### agentVault

```solidity
address internal agentVault
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_reverts_when_auditComplete_false

The activation script reverts when auditComplete is false.
This exercises the safety gate that prevents accidental activation
before the Architecture §4.1 certification checklist is satisfied.


```solidity
function test_reverts_when_auditComplete_false() public;
```

### test_vaults_stay_ineligible_when_gate_reverts

Both vaults remain ineligible after the gated revert.


```solidity
function test_vaults_stay_ineligible_when_gate_reverts() public;
```

### test_activates_both_vaults_when_auditComplete_true

Both vaults become router-eligible after successful activation.
The test contract is admin (setUp set admin = address(this) and
deployed registry with that admin), so no prank is needed.


```solidity
function test_activates_both_vaults_when_auditComplete_true() public;
```

### test_returned_struct_matches_inputs

The returned struct contains the correct vault addresses.


```solidity
function test_returned_struct_matches_inputs() public;
```

### test_routerEligibleCount_increments_by_two

`routerEligibleCount` increments by 2 after activating both vaults.


```solidity
function test_routerEligibleCount_increments_by_two() public;
```

### test_reverts_on_zero_registry


```solidity
function test_reverts_on_zero_registry() public;
```

### test_reverts_on_zero_protocolVault


```solidity
function test_reverts_on_zero_protocolVault() public;
```

### test_reverts_on_zero_agentVault


```solidity
function test_reverts_on_zero_agentVault() public;
```

