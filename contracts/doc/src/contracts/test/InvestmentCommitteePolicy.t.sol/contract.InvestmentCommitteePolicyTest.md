# InvestmentCommitteePolicyTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/0d868fe02e5cf19ce075213817ca84416ca13c09/contracts/test/InvestmentCommitteePolicy.t.sol)

**Inherits:**
Test


## Constants
### VOTE_JSON_HASH

```solidity
bytes32 constant VOTE_JSON_HASH = keccak256("valid-vote-json")
```


### PROMPT_HASH

```solidity
bytes32 constant PROMPT_HASH = keccak256("prompt-v1")
```


### INPUTS_DIGEST

```solidity
bytes32 constant INPUTS_DIGEST = keccak256("inputs-2026-06-23")
```


## State Variables
### ic

```solidity
InvestmentCommitteePolicy public ic
```


### gw

```solidity
MockGateway public gw
```


### admin

```solidity
address admin = address(0xA0)
```


### agent1

```solidity
address agent1 = address(0xA1)
```


### agent2

```solidity
address agent2 = address(0xA2)
```


### vault1

```solidity
address vault1 = address(0xB1)
```


### notGateway

```solidity
address notGateway = address(0xDEAD)
```


## Functions
### _defaultParams


```solidity
function _defaultParams() internal view returns (InvestmentCommitteePolicy.VoteParams memory);
```

### setUp


```solidity
function setUp() public;
```

### testRegisterAgent


```solidity
function testRegisterAgent() public view;
```

### testRegisterAgentEmitsEvent


```solidity
function testRegisterAgentEmitsEvent() public;
```

### testRegisterAgentRevertsIfNotAdmin


```solidity
function testRegisterAgentRevertsIfNotAdmin() public;
```

### testRegisterAgentRevertsOnZeroAddress


```solidity
function testRegisterAgentRevertsOnZeroAddress() public;
```

### testRevokeAgent


```solidity
function testRevokeAgent() public;
```

### testRevokeAgentEmitsEvent


```solidity
function testRevokeAgentEmitsEvent() public;
```

### testRevokeAgentRevertsIfNotAdmin


```solidity
function testRevokeAgentRevertsIfNotAdmin() public;
```

### testSubmitVoteRevertsIfCallerNotGateway

AC-1: committee actions revert unless routed through RobotMoneyGateway.


```solidity
function testSubmitVoteRevertsIfCallerNotGateway() public;
```

### testSubmitVoteRevertsIfCalledDirectlyByAgent

AC-1: direct call from agent (not via gateway) reverts.


```solidity
function testSubmitVoteRevertsIfCalledDirectlyByAgent() public;
```

### testSubmitVoteHappyPath


```solidity
function testSubmitVoteHappyPath() public;
```

### testSubmitVoteEmitsEvent


```solidity
function testSubmitVoteEmitsEvent() public;
```

### testMultipleVotesAccumulate


```solidity
function testMultipleVotesAccumulate() public;
```

### testLatestVoteByAgentReturnsMaxUintWhenNone


```solidity
function testLatestVoteByAgentReturnsMaxUintWhenNone() public view;
```

### testSubmitVoteRevertsForNonAllowlistedAgent


```solidity
function testSubmitVoteRevertsForNonAllowlistedAgent() public;
```

### testSubmitVoteRevertsAfterRevoke


```solidity
function testSubmitVoteRevertsAfterRevoke() public;
```

### testSubmitVoteRevertsOnEmptyHash


```solidity
function testSubmitVoteRevertsOnEmptyHash() public;
```

### testSubmitVoteRevertsOnWeightOver10000


```solidity
function testSubmitVoteRevertsOnWeightOver10000() public;
```

### testSubmitVoteRevertsOnConfidenceOver100


```solidity
function testSubmitVoteRevertsOnConfidenceOver100() public;
```

### testSubmitVoteRevertsOnEmptyRationaleUri


```solidity
function testSubmitVoteRevertsOnEmptyRationaleUri() public;
```

### testSubmitVoteRevertsOnZeroVaultAddress


```solidity
function testSubmitVoteRevertsOnZeroVaultAddress() public;
```

### testSignallingOnlyBoundary

AC-4: InvestmentCommitteePolicy grants no treasury-spend or
auto-apply authority. It holds no ERC-20 interface, cannot call
`deposit()`, and has no function that mutates router weights.
This test asserts the property structurally: any ETH sent to
the contract reverts (no `receive`/`fallback`), and the contract
bytecode contains none of the function selectors for
`RouterGovernance.execute(uint256)` (0x168e3b1f),
`RobotMoneyGateway.deposit(...)`, or ERC-20 `transfer`.


```solidity
function testSignallingOnlyBoundary() public;
```

