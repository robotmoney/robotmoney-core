# AccessRolesTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/75c9d821b281975c99c1bcf5090a766acfe071b0/contracts/test/AccessRoles.t.sol)

**Inherits:**
Test


## State Variables
### roles

```solidity
AccessRolesHarness internal roles
```


### ADMIN

```solidity
bytes32 internal ADMIN
```


### PAUSER

```solidity
bytes32 internal PAUSER
```


### AGENT

```solidity
bytes32 internal AGENT
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### pauser

```solidity
address internal pauser = makeAddr("pauser")
```


### agent

```solidity
address internal agent = makeAddr("agent")
```


### stranger

```solidity
address internal stranger = makeAddr("stranger")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_adminRole_isKeccakOfName


```solidity
function test_adminRole_isKeccakOfName() public view;
```

### test_pauserRole_isKeccakOfName


```solidity
function test_pauserRole_isKeccakOfName() public view;
```

### test_agentRole_isKeccakOfName


```solidity
function test_agentRole_isKeccakOfName() public view;
```

### test_allRoleIds_areDistinct


```solidity
function test_allRoleIds_areDistinct() public view;
```

### test_grantAgent_revertsIfAlreadyAdmin


```solidity
function test_grantAgent_revertsIfAlreadyAdmin() public;
```

### test_grantAgent_revertsIfAlreadyPauser


```solidity
function test_grantAgent_revertsIfAlreadyPauser() public;
```

### test_grantAdmin_revertsIfAlreadyAgent


```solidity
function test_grantAdmin_revertsIfAlreadyAgent() public;
```

### test_grantPauser_revertsIfAlreadyAgent


```solidity
function test_grantPauser_revertsIfAlreadyAgent() public;
```

### test_grantAgent_succeedsForFreshAccount


```solidity
function test_grantAgent_succeedsForFreshAccount() public;
```

### test_grantPauser_revertsIfAlreadyAdmin

Pauser key compromise must not also confer admin powers
(and vice versa). The audit (H1) flagged that the previous
implementation permitted this overlap.


```solidity
function test_grantPauser_revertsIfAlreadyAdmin() public;
```

### test_grantAdmin_revertsIfAlreadyPauser


```solidity
function test_grantAdmin_revertsIfAlreadyPauser() public;
```

### test_adminAndPauser_cannotCoexistOnSameAccount


```solidity
function test_adminAndPauser_cannotCoexistOnSameAccount() public;
```

### test_assertRoleSeparation_passesForAdminOnly


```solidity
function test_assertRoleSeparation_passesForAdminOnly() public view;
```

### test_assertRoleSeparation_passesForFreshAccount


```solidity
function test_assertRoleSeparation_passesForFreshAccount() public view;
```

### test_assertRoleSeparation_passesForAgentOnly


```solidity
function test_assertRoleSeparation_passesForAgentOnly() public;
```

### test_assertRoleSeparation_revertsOnAdminPauserOverlap


```solidity
function test_assertRoleSeparation_revertsOnAdminPauserOverlap() public;
```

### test_assertRoleSeparation_revertsOnAgentAdminOverlap


```solidity
function test_assertRoleSeparation_revertsOnAgentAdminOverlap() public;
```

### test_grantRole_unauthorizedCaller_reverts


```solidity
function test_grantRole_unauthorizedCaller_reverts() public;
```

