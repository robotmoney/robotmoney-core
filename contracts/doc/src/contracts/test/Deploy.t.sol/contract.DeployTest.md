# DeployTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/cf8a75c9169f98b8e30f0ad4e13af73b36f22bc7/contracts/test/Deploy.t.sol)

**Inherits:**
Test

Exercises the deploy script in-process and asserts the post-deploy
invariants the operator and downstream tooling rely on (issue #10).
The script deploys RobotMoneyVault + AaveV3Adapter + CompoundV3Adapter
+ MorphoAdapter (issue #363) instead of MockVault or PassthroughAdapter.
MockVault and PassthroughAdapter are retained only for their own unit
tests.  The script always binds the gateway to an externally-supplied
USDC token; this test deploys a `TestERC20` helper and passes its
address in.  The smoke-test devnet does the same with the canonical
Base USDC proxy seeded into genesis alloc (issue #255).
Note: adapter constructors only check for address(0) — they do NOT
require the protocol contracts to have bytecode. The in-process test
therefore succeeds even though AAVE_V3_POOL et al. are not deployed
in the forge unit-test environment. Actual protocol interaction is
tested by the fork regression suite (VaultForkRegressions.t.sol) and
the fork-e2e-rust harness.


## State Variables
### script

```solidity
Deploy internal script
```


### usdc

```solidity
TestERC20 internal usdc
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

### _run


```solidity
function _run() internal returns (Deploy.Deployed memory);
```

### test_deploy_wiresUsdcVaultAndAdminPauserRoles


```solidity
function test_deploy_wiresUsdcVaultAndAdminPauserRoles() public;
```

### test_deploy_authorizesAgentWithSanePolicy


```solidity
function test_deploy_authorizesAgentWithSanePolicy() public;
```

### test_deploy_doesNotMintToAgent


```solidity
function test_deploy_doesNotMintToAgent() public;
```

### test_deploy_revertsWhenUsdcAddressZero


```solidity
function test_deploy_revertsWhenUsdcAddressZero() public;
```

### test_deploy_revertsWhenUsdcAddressHasNoCode


```solidity
function test_deploy_revertsWhenUsdcAddressHasNoCode() public;
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

