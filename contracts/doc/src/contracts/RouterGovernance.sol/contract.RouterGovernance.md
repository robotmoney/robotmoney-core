# RouterGovernance
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/03e3eaf8da3896078274cb45e36fd811b4fed616/contracts/RouterGovernance.sol)

**Inherits:**
AccessControl

**Title:**
RouterGovernance

Admin-weighted MVP governance module that controls Portfolio Router
target weights. ADMIN_ROLE assigns voting power to addresses, creates
proposals, and executes after quorum is reached and the execution
delay elapses. This is an MVP mock — voting power is admin-assigned,
not derived from token holdings. Token-holder voting is a future goal.
Design constraints (docs/architecture.md §2.3):
- Controls router weights only; cannot govern vault internals,
agent permissions, or protocol admin operations.
- Exposes proposal state, vote tallies, cadence metadata, and
resulting weights for rmpc and dapp reads.
- One active proposal at a time (simple linear cadence).
Emits: `ProposalCreated`, `VoteCast`, `ProposalExecuted`, `WeightsApplied`.


## Constants
### ADMIN_ROLE
Grants voting power to addresses, creates proposals, sets params.


```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### BPS_DENOMINATOR
Basis-points denominator (10 000 = 100%).


```solidity
uint256 public constant BPS_DENOMINATOR = 10_000
```


### router
The Portfolio Router whose `setWeights` is called on execution.


```solidity
PortfolioRouter public immutable router
```


## State Variables
### votingPeriod
Duration of the voting period in seconds.


```solidity
uint64 public votingPeriod
```


### executionDelay
Delay from voting deadline to earliest execution timestamp, in seconds.


```solidity
uint64 public executionDelay
```


### quorumThreshold
Minimum voting power that must vote FOR to reach quorum.


```solidity
uint256 public quorumThreshold
```


### votingPower
Voting power per address. Assigned by ADMIN_ROLE.


```solidity
mapping(address => uint256) public votingPower
```


### totalVotingPower
Total voting power outstanding (sum of all assigned powers).


```solidity
uint256 public totalVotingPower
```


### _proposals
Proposals by id (1-indexed; id 0 is never used).


```solidity
mapping(uint256 => Proposal) private _proposals
```


### currentProposalId
Id of the currently active / queued / executed proposal.
0 = no proposal ever created.


```solidity
uint256 public currentProposalId
```


### _hasVoted
Vote tracking: proposalId -> voter -> voted.


```solidity
mapping(uint256 => mapping(address => bool)) private _hasVoted
```


## Functions
### constructor


```solidity
constructor(
    address _router,
    address _admin,
    uint64 _votingPeriod,
    uint64 _executionDelay,
    uint256 _quorumThreshold
) ;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`_router`|`address`|         Portfolio Router whose weights this contract controls.|
|`_admin`|`address`|          Address that receives ADMIN_ROLE.|
|`_votingPeriod`|`uint64`|   Duration of the voting period in seconds.|
|`_executionDelay`|`uint64`| Delay from voting end to earliest execution, in seconds.|
|`_quorumThreshold`|`uint256`|Minimum FOR voting power required for quorum.|


### setQuorumThreshold

Update the quorum threshold. Restricted to ADMIN_ROLE.


```solidity
function setQuorumThreshold(uint256 threshold) external onlyRole(ADMIN_ROLE);
```

### setVotingPeriod

Update the voting period. Restricted to ADMIN_ROLE.


```solidity
function setVotingPeriod(uint64 period) external onlyRole(ADMIN_ROLE);
```

### setExecutionDelay

Update the execution delay. Restricted to ADMIN_ROLE.


```solidity
function setExecutionDelay(uint64 delay) external onlyRole(ADMIN_ROLE);
```

### setVotingPower

Grant `power` voting weight to `voter`. Setting to 0 removes voting rights.
Restricted to ADMIN_ROLE.
NOTE: This is admin-assigned MVP governance — voting power is not derived
from token holdings. Token-holder voting is a future goal.


```solidity
function setVotingPower(address voter, uint256 power) external onlyRole(ADMIN_ROLE);
```

### setDefaultWeights

Set the router's default (below-quorum fallback) weight vector,
forwarding to `PortfolioRouter.setDefaultWeights`. This is the
on-chain vector the router routes by — and the public allocation
surface renders — whenever no proposal is active or the most
recent proposal failed quorum. A passed vote overrides it; the
default itself stays put as the post-vote fallback. Restricted to
ADMIN_ROLE (Safe -> Timelock -> ADMIN_ROLE). ADR-0002.
The router enforces: ADMIN_ROLE on the router (this contract must
hold it), bps sum == BPS_DENOMINATOR, and length == the
registry's router-eligible vault count.


```solidity
function setDefaultWeights(address[] calldata vaults, uint256[] calldata bps)
    external
    onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vaults`|`address[]`|Ordered vault address list.|
|`bps`|`uint256[]`|   Parallel weight array (must sum to BPS_DENOMINATOR).|


### clearVotedWeights

Clear the router's voted weight vector and revert routing to the
default vector. Intended for governance to fall back to the
default after the most recent proposal failed quorum. Restricted
to ADMIN_ROLE. ADR-0002.


```solidity
function clearVotedWeights() external onlyRole(ADMIN_ROLE);
```

### propose

Submit a new weight proposal. Restricted to ADMIN_ROLE.
Only one proposal may be active or queued at a time.
NOTE: Proposal creation is admin-only in this MVP mock.
Public proposal submission is a future goal.


```solidity
function propose(address[] calldata vaults, uint256[] calldata bps)
    external
    onlyRole(ADMIN_ROLE)
    returns (uint256 proposalId);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vaults`|`address[]`| Ordered vault address list.|
|`bps`|`uint256[]`|    Parallel weight array; must sum to BPS_DENOMINATOR.|


### vote

Cast a FOR vote on the currently active proposal.
Caller must have voting power assigned by ADMIN_ROLE.


```solidity
function vote(uint256 proposalId) external;
```

### execute

Execute a queued proposal — call `router.setWeights` with the
proposed weight vector. Anyone may call once quorum is reached
and the execution delay has elapsed.


```solidity
function execute(uint256 proposalId) external;
```

### proposalState

Return the current state of a proposal.


```solidity
function proposalState(uint256 proposalId) external view returns (ProposalState);
```

### activeProposal

Return the full proposal struct for inspection.


```solidity
function activeProposal()
    external
    view
    returns (
        uint256 id,
        address proposer,
        address[] memory vaults,
        uint256[] memory bps,
        uint64 votingDeadline,
        uint64 executableAfter,
        uint256 votesFor,
        bool executed
    );
```

### cadenceParams

Return cadence parameters in one call for rmpc/dapp reads.


```solidity
function cadenceParams()
    external
    view
    returns (
        uint64 _votingPeriod,
        uint64 _executionDelay,
        uint256 _quorumThreshold,
        uint256 _totalVotingPower
    );
```

### currentWeights

Return the current Portfolio Router weight vector directly.


```solidity
function currentWeights()
    external
    view
    returns (address[] memory vaults, uint256[] memory bps);
```

### hasVoted

Whether `voter` has already voted on `proposalId`.


```solidity
function hasVoted(uint256 proposalId, address voter) external view returns (bool);
```

### _state

Compute proposal state without requiring `id != 0`.


```solidity
function _state(uint256 proposalId) internal view returns (ProposalState);
```

## Events
### ProposalCreated
Emitted when a new weight proposal is created.


```solidity
event ProposalCreated(
    uint256 indexed proposalId,
    address indexed proposer,
    address[] vaults,
    uint256[] bps,
    uint64 votingDeadline
);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`proposalId`|`uint256`|    Sequential proposal id.|
|`proposer`|`address`|      Address that created the proposal.|
|`vaults`|`address[]`|        Proposed vault addresses.|
|`bps`|`uint256[]`|           Proposed weight bps (parallel to vaults).|
|`votingDeadline`|`uint64`|Block timestamp when voting ends.|

### VoteCast
Emitted when a voter casts a vote in favour.


```solidity
event VoteCast(
    uint256 indexed proposalId, address indexed voter, uint256 power, uint256 totalFor
);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`proposalId`|`uint256`|Proposal the vote was cast on.|
|`voter`|`address`|     Voter address.|
|`power`|`uint256`|     Voting power applied.|
|`totalFor`|`uint256`|  Running total of FOR votes after this cast.|

### ProposalExecuted
Emitted when a queued proposal is executed.


```solidity
event ProposalExecuted(uint256 indexed proposalId, address indexed executor);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`proposalId`|`uint256`|Executed proposal id.|
|`executor`|`address`|  Address that called `execute`.|

### WeightsApplied
Emitted when the router weight vector is updated by this contract.


```solidity
event WeightsApplied(uint256 indexed proposalId, address[] vaults, uint256[] bps);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`proposalId`|`uint256`|Source proposal.|
|`vaults`|`address[]`|    New vault address list.|
|`bps`|`uint256[]`|       New weight bps list (parallel to vaults).|

### QuorumThresholdSet
Emitted when the quorum threshold is changed.


```solidity
event QuorumThresholdSet(uint256 oldThreshold, uint256 newThreshold);
```

### VotingPeriodSet
Emitted when the voting period is changed.


```solidity
event VotingPeriodSet(uint64 oldPeriod, uint64 newPeriod);
```

### ExecutionDelaySet
Emitted when the execution delay is changed.


```solidity
event ExecutionDelaySet(uint64 oldDelay, uint64 newDelay);
```

### VotingPowerSet
Emitted when voting power is granted or revoked.


```solidity
event VotingPowerSet(address indexed voter, uint256 oldPower, uint256 newPower);
```

## Errors
### ZeroAddress

```solidity
error ZeroAddress();
```

### InvalidWeightSum

```solidity
error InvalidWeightSum();
```

### LengthMismatch

```solidity
error LengthMismatch();
```

### NoActiveProposal

```solidity
error NoActiveProposal();
```

### ProposalNotActive

```solidity
error ProposalNotActive();
```

### AlreadyVoted

```solidity
error AlreadyVoted();
```

### NoVotingPower

```solidity
error NoVotingPower();
```

### VotingStillOpen

```solidity
error VotingStillOpen();
```

### QuorumNotReached

```solidity
error QuorumNotReached();
```

### ExecutionDelayNotElapsed

```solidity
error ExecutionDelayNotElapsed();
```

### AlreadyExecuted

```solidity
error AlreadyExecuted();
```

### ProposalDefeated

```solidity
error ProposalDefeated();
```

### ActiveProposalExists

```solidity
error ActiveProposalExists();
```

## Structs
### Proposal

```solidity
struct Proposal {
    /// Sequential proposal id (1-indexed).
    uint256 id;
    /// Address that submitted the proposal.
    address proposer;
    /// Proposed vault address list (parallel to bps).
    address[] vaults;
    /// Proposed weight bps list (must sum to BPS_DENOMINATOR).
    uint256[] bps;
    /// Block timestamp when voting period ends.
    uint64 votingDeadline;
    /// Block timestamp after which the proposal may be executed
    /// (= votingDeadline + executionDelay).
    uint64 executableAfter;
    /// Total voting power cast in favour.
    uint256 votesFor;
    /// Whether the proposal has been executed.
    bool executed;
}
```

## Enums
### ProposalState

```solidity
enum ProposalState {
    /// Proposal is collecting votes.
    Active,
    /// Voting period ended; not enough votes reached quorum.
    Defeated,
    /// Quorum reached; waiting for execution delay to elapse.
    Queued,
    /// Executed: weights applied to the router.
    Executed
}
```

