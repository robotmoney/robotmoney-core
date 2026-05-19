# RouterGovernanceTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e7a2933e057a3f91470ea3808b683595abe0b3d0/contracts/test/RouterGovernance.t.sol)

**Inherits:**
Test


## Constants
### VOTING_PERIOD

```solidity
uint64 constant VOTING_PERIOD = 1 days
```


### EXECUTION_DELAY

```solidity
uint64 constant EXECUTION_DELAY = 1 days
```


### QUORUM_THRESHOLD

```solidity
uint256 constant QUORUM_THRESHOLD = 510_000e18
```


### ALICE_POWER

```solidity
uint256 constant ALICE_POWER = 600_000e18
```


### BOB_POWER

```solidity
uint256 constant BOB_POWER = 200_000e18
```


### CAROL_POWER

```solidity
uint256 constant CAROL_POWER = 200_000e18
```


## State Variables
### usdc

```solidity
MockUsdc internal usdc
```


### registry

```solidity
VaultRegistry internal registry
```


### router

```solidity
PortfolioRouter internal router
```


### gov

```solidity
RouterGovernance internal gov
```


### govAdmin

```solidity
address internal govAdmin = makeAddr("govAdmin")
```


### routerAdmin

```solidity
address internal routerAdmin = makeAddr("routerAdmin")
```


### registryAdmin

```solidity
address internal registryAdmin = makeAddr("registryAdmin")
```


### alice

```solidity
address internal alice = makeAddr("alice")
```


### bob

```solidity
address internal bob = makeAddr("bob")
```


### carol

```solidity
address internal carol = makeAddr("carol")
```


### stranger

```solidity
address internal stranger = makeAddr("stranger")
```


### vaultA

```solidity
MockGovVault internal vaultA
```


### vaultB

```solidity
MockGovVault internal vaultB
```


### metaA

```solidity
VaultRegistry.VaultMetadata internal metaA
```


### metaB

```solidity
VaultRegistry.VaultMetadata internal metaB
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _proposeValid

Build a valid 60/40 proposal and submit it from govAdmin.


```solidity
function _proposeValid() internal returns (uint256 proposalId);
```

### test_constructor_revertsOnZeroRouter


```solidity
function test_constructor_revertsOnZeroRouter() public;
```

### test_constructor_revertsOnZeroAdmin


```solidity
function test_constructor_revertsOnZeroAdmin() public;
```

### test_constructor_storesParams


```solidity
function test_constructor_storesParams() public view;
```

### test_constructor_adminRoleGranted


```solidity
function test_constructor_adminRoleGranted() public view;
```

### test_setVotingPower_setsAndTracksTotal


```solidity
function test_setVotingPower_setsAndTracksTotal() public view;
```

### test_setVotingPower_revertsOnZeroAddress


```solidity
function test_setVotingPower_revertsOnZeroAddress() public;
```

### test_setVotingPower_revertsForNonAdmin


```solidity
function test_setVotingPower_revertsForNonAdmin() public;
```

### test_propose_successfulCreation


```solidity
function test_propose_successfulCreation() public;
```

### test_propose_emitsProposalCreated


```solidity
function test_propose_emitsProposalCreated() public;
```

### test_propose_revertsForNonAdmin


```solidity
function test_propose_revertsForNonAdmin() public;
```

### test_propose_revertsOnInvalidWeightSum


```solidity
function test_propose_revertsOnInvalidWeightSum() public;
```

### test_propose_revertsOnLengthMismatch


```solidity
function test_propose_revertsOnLengthMismatch() public;
```

### test_propose_revertsIfAlreadyActive


```solidity
function test_propose_revertsIfAlreadyActive() public;
```

### test_propose_allowsNewProposalAfterDefeated


```solidity
function test_propose_allowsNewProposalAfterDefeated() public;
```

### test_vote_success


```solidity
function test_vote_success() public;
```

### test_vote_emitsVoteCast


```solidity
function test_vote_emitsVoteCast() public;
```

### test_vote_revertsOnDoubleVote


```solidity
function test_vote_revertsOnDoubleVote() public;
```

### test_vote_revertsAfterVotingPeriod


```solidity
function test_vote_revertsAfterVotingPeriod() public;
```

### test_vote_revertsOnNonExistentProposal


```solidity
function test_vote_revertsOnNonExistentProposal() public;
```

### test_vote_revertsIfNoVotingPower


```solidity
function test_vote_revertsIfNoVotingPower() public;
```

### test_vote_multipleVotersAccumulate


```solidity
function test_vote_multipleVotersAccumulate() public;
```

### test_proposalState_activeBeforeVotingDeadline


```solidity
function test_proposalState_activeBeforeVotingDeadline() public;
```

### test_proposalState_defeatedWhenNoQuorum


```solidity
function test_proposalState_defeatedWhenNoQuorum() public;
```

### test_proposalState_queuedWhenQuorumReached


```solidity
function test_proposalState_queuedWhenQuorumReached() public;
```

### test_proposalState_executedAfterExecution


```solidity
function test_proposalState_executedAfterExecution() public;
```

### test_proposalState_revertsOnNonExistent


```solidity
function test_proposalState_revertsOnNonExistent() public;
```

### test_execute_success


```solidity
function test_execute_success() public;
```

### test_execute_emitsProposalExecuted


```solidity
function test_execute_emitsProposalExecuted() public;
```

### test_execute_revertsBeforeVotingEnds


```solidity
function test_execute_revertsBeforeVotingEnds() public;
```

### test_execute_revertsBeforeExecutionDelay


```solidity
function test_execute_revertsBeforeExecutionDelay() public;
```

### test_execute_revertsIfQuorumNotReached


```solidity
function test_execute_revertsIfQuorumNotReached() public;
```

### test_execute_revertsIfAlreadyExecuted


```solidity
function test_execute_revertsIfAlreadyExecuted() public;
```

### test_cadenceParams_returnsStoredValues


```solidity
function test_cadenceParams_returnsStoredValues() public view;
```

### test_currentWeights_returnsRouterWeights


```solidity
function test_currentWeights_returnsRouterWeights() public;
```

### test_hasVoted_tracksVoterState


```solidity
function test_hasVoted_tracksVoterState() public;
```

### test_fullGovernanceRoundTrip


```solidity
function test_fullGovernanceRoundTrip() public;
```

