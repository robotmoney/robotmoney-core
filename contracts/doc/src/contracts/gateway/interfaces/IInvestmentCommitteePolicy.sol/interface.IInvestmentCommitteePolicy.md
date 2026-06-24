# IInvestmentCommitteePolicy
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/5f3ed0a39e045bd3fe3f3f4a024d482bf1b89ff8/contracts/gateway/interfaces/IInvestmentCommitteePolicy.sol)

**Title:**
IInvestmentCommitteePolicy

Interface for the InvestmentCommitteePolicy contract.
Design constraints (docs/product/20260623-product-proposal-investment-committee-v0.md §3):
- All committee actions are **signalling only**: no treasury spend, no direct
router-weight mutation.
- Membership is admin-gated (ADMIN_ROLE). Permissionless onboarding is v1+.
- All writes (register / voteSubmit) must be called through the
RobotMoneyGateway (enforced by the `onlyGateway` modifier on the
implementation).


## Functions
### registerAgent

Allowlist a committee agent. Only ADMIN_ROLE.


```solidity
function registerAgent(address agent, string calldata agentId_) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`|   Address to grant COMMITTEE_AGENT_ROLE.|
|`agentId_`|`string`|Human-readable label (e.g. "athena-v1").|


### revokeAgent

Remove a committee agent from the allowlist. Only ADMIN_ROLE.


```solidity
function revokeAgent(address agent) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`agent`|`address`|Address to revoke COMMITTEE_AGENT_ROLE from.|


### submitVote

Submit a signed allocation vote for a vault.
Must be called via the RobotMoneyGateway.


```solidity
function submitVote(VoteParams calldata p) external returns (uint256 voteId);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`p`|`VoteParams`|All vote fields packed into a `VoteParams` struct.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`voteId`|`uint256`|Index of the newly appended vote.|


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

### gateway

The RobotMoneyGateway address. All committee writes must originate here.


```solidity
function gateway() external view returns (address);
```

### agentId

Human-readable label for each registered agent.


```solidity
function agentId(address agent) external view returns (string memory);
```

## Events
### AgentRegistered
Emitted when ADMIN_ROLE registers a committee agent.


```solidity
event AgentRegistered(address indexed agent, string agentId);
```

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

```solidity
error ZeroAddress();
```

### CallerNotGateway

```solidity
error CallerNotGateway();
```

### AgentNotAllowlisted

```solidity
error AgentNotAllowlisted();
```

### EmptyVoteHash

```solidity
error EmptyVoteHash();
```

### InvalidStance

```solidity
error InvalidStance();
```

### WeightExceedsBps

```solidity
error WeightExceedsBps();
```

### ConfidenceOutOfRange

```solidity
error ConfidenceOutOfRange();
```

### EmptyRationaleUri

```solidity
error EmptyRationaleUri();
```

### ZeroVaultAddress

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

### VoteParams
Calldata bundle for `submitVote`.


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

