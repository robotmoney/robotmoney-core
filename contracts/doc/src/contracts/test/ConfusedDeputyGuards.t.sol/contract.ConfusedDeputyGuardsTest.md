# ConfusedDeputyGuardsTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/eddfc6a75fd5558f18f4c48ae13aa1c3278c17e6/contracts/test/ConfusedDeputyGuards.t.sol)

**Inherits:**
Test

**Title:**
ConfusedDeputyGuardsTest

Pins every authority invariant from the confused-deputy audit. Each
test name maps to a numbered invariant in the audit artifact §5.


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


### MAX_PER_PAYMENT

```solidity
uint256 internal constant MAX_PER_PAYMENT = 1_000 * ONE_USDC
```


### MAX_PER_WINDOW

```solidity
uint256 internal constant MAX_PER_WINDOW = 5_000 * ONE_USDC
```


## State Variables
### usdc

```solidity
TestERC20 internal usdc
```


### vault

```solidity
MockVault internal vault
```


### gateway

```solidity
RobotMoneyGateway internal gateway
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### pauser

```solidity
address internal pauser = makeAddr("pauser")
```


### depositor

```solidity
address internal depositor = makeAddr("depositor")
```


### agent

```solidity
address internal agent = makeAddr("agent")
```


### otherDepositor

```solidity
address internal otherDepositor = makeAddr("otherDepositor")
```


### otherAgent

```solidity
address internal otherAgent = makeAddr("otherAgent")
```


### shareReceiver

```solidity
address internal shareReceiver = makeAddr("shareReceiver")
```


### attacker

```solidity
address internal attacker = makeAddr("attacker")
```


### attackerReceiver

```solidity
address internal attackerReceiver = makeAddr("attackerReceiver")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _policy


```solidity
function _policy(address shareReceiver_) internal view returns (IGateway.AgentPolicy memory);
```

### _authorize


```solidity
function _authorize(address owner_, address agent_, IGateway.AgentPolicy memory p) internal;
```

### _fund


```solidity
function _fund(address who, uint256 amt) internal;
```

### test_invariant1_deposit_sharesGoToPolicyReceiver

Deposit sends shares to policy.shareReceiver, not to any address
the agent caller might supply via calldata or other means.
There is no `recipient` calldata parameter in deposit() — this test
confirms shares land at the policy-registered receiver even when a
different EOA is funding the deposit.


```solidity
function test_invariant1_deposit_sharesGoToPolicyReceiver() public;
```

### test_invariant2_withdraw_assetsGoToPolicyAssetRecipient

withdraw() forwards USDC only to policy.assetRecipient. There is
no calldata receiver parameter the agent can supply.


```solidity
function test_invariant2_withdraw_assetsGoToPolicyAssetRecipient() public;
```

### test_invariant3_depositTo_rejectsUnlistedDestination

depositTo rejects any destination not in policy.allowedDestinations.
An attacker cannot redirect funds to an arbitrary vault by
supplying a foreign destination address.


```solidity
function test_invariant3_depositTo_rejectsUnlistedDestination() public;
```

### test_invariant4_withdraw_rejectsForeignSourceVault

withdraw() rejects any sourceVault != gateway's pinned vault.
An attacker cannot supply a foreign vault address to bypass
the asset-redemption rail.


```solidity
function test_invariant4_withdraw_rejectsForeignSourceVault() public;
```

### test_invariant5_setPolicy_requiresAgentOwner

A third party cannot update another depositor's agent policy.
setPolicy must revert with NotAgentOwner when the caller is not
the recorded agentOwner.


```solidity
function test_invariant5_setPolicy_requiresAgentOwner() public;
```

### test_invariant6_revokeAgent_requiresAgentOwner

A third party cannot revoke another depositor's agent.


```solidity
function test_invariant6_revokeAgent_requiresAgentOwner() public;
```

### test_invariant7_authorizeAgent_rejectsDoubleRegistration

authorizeAgent on an already-owned agent reverts AgentAlreadyOwned.
A second caller cannot steal ownership of an existing agent.


```solidity
function test_invariant7_authorizeAgent_rejectsDoubleRegistration() public;
```

### test_invariant7b_agentOwner_boundToFirstDepositor

agentOwner[agent] is set to msg.sender at first authorize and
can only change via the recorded owner calling revokeAgent.


```solidity
function test_invariant7b_agentOwner_boundToFirstDepositor() public;
```

