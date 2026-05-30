# GatewayCommitRevealTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e30069c8df8fc8c637d65bc2f991adfaf60a1079/contracts/test/RobotMoneyGateway.t.sol)

**Inherits:**
Test


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


### agent

```solidity
address internal agent = makeAddr("agent")
```


### depositor

```solidity
address internal depositor = makeAddr("depositor")
```


### shareReceiver

```solidity
address internal shareReceiver = makeAddr("shareReceiver")
```


### agentRole

```solidity
bytes32 internal agentRole
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _defaultPolicy


```solidity
function _defaultPolicy() internal view returns (IGateway.AgentPolicy memory);
```

### _commitHash

Helper: build the commit hash the same way the gateway does.


```solidity
function _commitHash(address agentAddr, address committer, bytes32 salt)
    internal
    pure
    returns (bytes32);
```

### test_commitReveal_happyPath_authorizesAgent

AC: valid commit followed by valid reveal (at least 1 block later)
succeeds and sets agentOwner correctly.


```solidity
function test_commitReveal_happyPath_authorizesAgent() public;
```

### test_revealAuthorization_revertsWithoutPriorCommit

AC: reveal without a prior commit reverts CommitmentNotFound.


```solidity
function test_revealAuthorization_revertsWithoutPriorCommit() public;
```

### test_revealAuthorization_revertsOnWrongSalt

AC: reveal with wrong salt reverts CommitmentNotFound (hash mismatch
means no matching commitment exists).


```solidity
function test_revealAuthorization_revertsOnWrongSalt() public;
```

### test_revealAuthorization_revertsFromDifferentAddress

AC: reveal from a different address than the committer reverts.
(The hash includes msg.sender so a different caller produces a
different hash → CommitmentNotFound.)


```solidity
function test_revealAuthorization_revertsFromDifferentAddress() public;
```

### test_revealAuthorization_revertsAfterExpiry

AC: reveal after COMMIT_EXPIRY_BLOCKS reverts CommitmentExpired.


```solidity
function test_revealAuthorization_revertsAfterExpiry() public;
```

### test_revealAuthorization_revertsInSameBlock

AC: reveal in the same block as the commit reverts CommitmentTooRecent.


```solidity
function test_revealAuthorization_revertsInSameBlock() public;
```

### test_revealAuthorization_frontRunnerBlockedByAlreadyOwned

AC: front-runner committing for same agent after legitimate commit
cannot reveal (msg.sender mismatch means a different hash is used).
Alice commits legitimately; Bob then commits a commitment binding
himself to the same agent. Bob's reveal uses his own hash and
succeeds from his perspective, but because each committer's hash
independently encodes the committer, Bob authorizing the same agent
address is blocked by AgentAlreadyOwned if Alice reveals first,
and Bob's commitment simply uses a different hash than Alice's.
This test verifies that when Alice reveals first she wins, and Bob's
subsequent reveal is blocked by AgentAlreadyOwned.


```solidity
function test_revealAuthorization_frontRunnerBlockedByAlreadyOwned() public;
```

### test_commitAuthorization_emitsEvent

Verify commitAuthorization emits CommitSubmitted with correct fields.


```solidity
function test_commitAuthorization_emitsEvent() public;
```

