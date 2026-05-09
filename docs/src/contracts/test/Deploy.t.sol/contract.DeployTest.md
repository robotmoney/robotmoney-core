# DeployTest
[Git Source](https://github.com/lucky-tensor/robotmoney-skills/blob/b462a72b60a914ceeff6cdf3ad7148bfb0361abb/contracts/test/Deploy.t.sol)

**Inherits:**
Test

Exercises the deploy script in-process and asserts the post-deploy
invariants the operator and downstream tooling rely on (issue #10).


## State Variables
### script

```solidity
Deploy internal script
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


### shareReceiver

```solidity
address internal shareReceiver = makeAddr("shareReceiver")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_deploy_wiresUsdcVaultAndAdminPauserRoles


```solidity
function test_deploy_wiresUsdcVaultAndAdminPauserRoles() public;
```

### test_deploy_authorizesAgentWithSanePolicy


```solidity
function test_deploy_authorizesAgentWithSanePolicy() public;
```

### test_deploy_mintsTestUsdcToAgent


```solidity
function test_deploy_mintsTestUsdcToAgent() public;
```

### test_deploy_grantingAgentRoleToAdminReverts


```solidity
function test_deploy_grantingAgentRoleToAdminReverts() public;
```

### test_deploy_grantingAgentRoleToPauserReverts


```solidity
function test_deploy_grantingAgentRoleToPauserReverts() public;
```

### test_deploy_revertsWhenAdminEqualsPauser


```solidity
function test_deploy_revertsWhenAdminEqualsPauser() public;
```

### test_deploy_revertsWhenAdminEqualsAgent


```solidity
function test_deploy_revertsWhenAdminEqualsAgent() public;
```

### test_deploy_revertsWhenPauserEqualsAgent


```solidity
function test_deploy_revertsWhenPauserEqualsAgent() public;
```

### test_deploy_envDriven_runInProcessSucceeds


```solidity
function test_deploy_envDriven_runInProcessSucceeds() public;
```

