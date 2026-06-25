# InvestmentCommitteePolicy
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/565d7a4ab968179b6f0a1db9f9fe724a77abadce/contracts/gateway/InvestmentCommitteePolicy.sol)

**Inherits:**
AccessControl, ReentrancyGuard

**Title:**
InvestmentCommitteePolicy

Registry of admin-allowlisted committee agents and their signed
allocation votes over the existing four-vault model.
Design constraints (docs/product/20260623-product-proposal-investment-committee-v0.md §3):
- All committee actions are **signalling only**: no treasury spend, no
direct router-weight mutation. See `testSignallingOnlyBoundary`.
- Membership is admin-gated. ADMIN_ROLE allowlists agents; permissionless
onboarding is v1+.
- All writes (register / vote) must pass through the RobotMoneyGateway
(the `onlyGateway` modifier). The committee does not get a side channel.
- Votes are recorded on-chain by their schema-validated JSON hash plus the
full fixed-shape fields so third-party consumers can reconstruct audit
trails without re-reading the gateway.
Vote JSON schema (committed at tests/fixtures/committee-vote.schema.json):
agent_id, vault, stance, target_weight_bps, confidence, rationale_uri,
prompt_hash, inputs_digest, timestamp, schema_version.
Emits: `AgentRegistered`, `AgentRevoked`, `VoteSubmitted`.


## Constants
### ADMIN_ROLE
Grants/revokes COMMITTEE_AGENT_ROLE; revokeAgent; addGateway.


```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### COMMITTEE_AGENT_ROLE
Held by allowlisted committee agent addresses.


```solidity
bytes32 public constant COMMITTEE_AGENT_ROLE = keccak256("COMMITTEE_AGENT_ROLE")
```


### gateway
The RobotMoneyGateway address. All committee writes must originate here.


```solidity
address public immutable gateway
```


## State Variables
### agentId
Human-readable label for each registered agent.


```solidity
mapping(address => string) public agentId
```


### _votes
Ordered list of all submitted votes (append-only).


```solidity
Vote[] private _votes
```


## Functions
### constructor


```solidity
constructor(address admin_, address gateway_) ;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`admin_`|`address`|   Address granted DEFAULT_ADMIN_ROLE and ADMIN_ROLE.|
|`gateway_`|`address`| Address of the deployed RobotMoneyGateway.|


### onlyGateway

Reverts unless `msg.sender` is the registered RobotMoneyGateway.
This is the primary defence ensuring every committee action passes
through the gateway's agent-policy enforcement layer.


```solidity
modifier onlyGateway() ;
```

### registerAgent

Allowlist a committee agent. Only ADMIN_ROLE.


```solidity
function registerAgent(address agent, string calldata agentId_) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`|   Address to grant COMMITTEE_AGENT_ROLE.|
|`agentId_`|`string`|Human-readable label (e.g. "athena-v1", "robot-money", "woon").|


### revokeAgent

Remove a committee agent from the allowlist. Only ADMIN_ROLE.


```solidity
function revokeAgent(address agent) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`|Address to revoke COMMITTEE_AGENT_ROLE from.|


### submitVote

Submit a signed allocation vote for a vault.
Must be called via the RobotMoneyGateway (`onlyGateway`).


```solidity
function submitVote(VoteParams calldata p)
    external
    onlyGateway
    nonReentrant
    returns (uint256 voteId);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`p`|`VoteParams`|   All vote fields packed into a `VoteParams` struct to keep the stack frame within the EVM's 16-slot limit.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`voteId`|`uint256`| Index of the newly appended vote.|


### voteCount

Total number of submitted votes.


```solidity
function voteCount() external view returns (uint256);
```

### getVote

Retrieve a single vote by index.


```solidity
function getVote(uint256 voteId) external view returns (Vote memory);
```

### latestVoteByAgent

Latest vote index for a given agent, or type(uint256).max if none.


```solidity
function latestVoteByAgent(address agent) external view returns (uint256);
```

## Events
### AgentRegistered
Emitted when ADMIN_ROLE registers a committee agent.


```solidity
event AgentRegistered(address indexed agent, string agentId);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`|   The newly allowlisted agent address.|
|`agentId`|`string`| Human-readable identifier for the agent (e.g. "athena-v1").|

### AgentRevoked
Emitted when ADMIN_ROLE revokes a committee agent.


```solidity
event AgentRevoked(address indexed agent);
```

### VoteSubmitted
Emitted when an allowlisted agent submits a signed vote.


```solidity
event VoteSubmitted(
    uint256 indexed voteId,
    address indexed agent,
    address indexed vault,
    Stance stance,
    uint16 targetWeightBps,
    uint8 confidence,
    string rationaleUri,
    bytes32 voteJsonHash,
    uint64 timestamp
);
```

## Errors
### ZeroAddress
Constructor passed `address(0)` for admin or gateway.


```solidity
error ZeroAddress();
```

### CallerNotGateway
Caller is not the registered RobotMoneyGateway.


```solidity
error CallerNotGateway();
```

### AgentNotAllowlisted
`submitVote` called by an address without COMMITTEE_AGENT_ROLE.


```solidity
error AgentNotAllowlisted();
```

### EmptyVoteHash
`submitVote` called with an empty `voteJsonHash`.


```solidity
error EmptyVoteHash();
```

### InvalidStance
`submitVote` called with an invalid stance (must be 0/1/2).


```solidity
error InvalidStance();
```

### WeightExceedsBps
`submitVote` called with `targetWeightBps > 10_000`.


```solidity
error WeightExceedsBps();
```

### ConfidenceOutOfRange
`submitVote` called with `confidence > 100`.


```solidity
error ConfidenceOutOfRange();
```

### EmptyRationaleUri
`submitVote` called with an empty `rationaleUri`.


```solidity
error EmptyRationaleUri();
```

### ZeroVaultAddress
`submitVote` called with an empty `vault` address.


```solidity
error ZeroVaultAddress();
```

## Structs
### Vote
A single on-chain vote record.


```solidity
struct Vote {
    address agent;
    address vault;
    Stance stance;
    uint16 targetWeightBps;
    uint8 confidence;
    string rationaleUri;
    bytes32 voteJsonHash;
    bytes32 promptHash;
    bytes32 inputsDigest;
    string schemaVersion;
    uint64 timestamp;
    uint64 submittedAt;
}
```

**Properties**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`|           Address of the committee agent.|
|`vault`|`address`|           Target vault address (one of the four PRD §11 vaults).|
|`stance`|`Stance`|          Overweight / Neutral / Underweight.|
|`targetWeightBps`|`uint16`| Target allocation weight in basis points (0–10 000).|
|`confidence`|`uint8`|      Confidence score 0–100.|
|`rationaleUri`|`string`|    Public URI to the narrative CoT / memo (gist, pastebin, etc.).|
|`voteJsonHash`|`bytes32`|    keccak256 of the full vote JSON (schema-validated off-chain).|
|`promptHash`|`bytes32`|      keccak256 of the agent prompt used.|
|`inputsDigest`|`bytes32`|    keccak256 of the inputs consumed.|
|`schemaVersion`|`string`|   Vote JSON schema version string (e.g. "1.0").|
|`timestamp`|`uint64`|       Unix seconds when the vote was formed (agent-supplied).|
|`submittedAt`|`uint64`|     Block timestamp when the vote was registered on-chain.|

### VoteParams
Calldata bundle for `submitVote`. Passed as a struct to keep
the stack frame below the EVM's 16-slot limit.


```solidity
struct VoteParams {
    address agent;
    address vault;
    Stance stance;
    uint16 targetWeightBps;
    uint8 confidence;
    string rationaleUri;
    bytes32 voteJsonHash;
    bytes32 promptHash;
    bytes32 inputsDigest;
    string schemaVersion;
    uint64 timestamp;
}
```

## Enums
### Stance
Allocation stance for a single vault.

Must remain 3 values in this order — the Rust ABI binding and the
vote JSON schema both encode Overweight=0, Neutral=1, Underweight=2.


```solidity
enum Stance {
    Overweight,
    Neutral,
    Underweight
}
```

