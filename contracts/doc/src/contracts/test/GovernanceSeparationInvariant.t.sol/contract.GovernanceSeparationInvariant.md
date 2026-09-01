# GovernanceSeparationInvariant
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/0d39e859fbb2922c60896943bd63db1eb082a5df/contracts/test/GovernanceSeparationInvariant.t.sol)

**Inherits:**
Test

**Title:**
GovernanceSeparationInvariant

Verifies the §3.4 decision that the committee and the
RouterGovernance voter set are separate bodies: no address may
hold both `COMMITTEE_AGENT_ROLE` on the InvestmentCommitteePolicy
and non-zero voting power on `RouterGovernance`.
The two bodies are separately administered (committee agents are
allowlisted through the IC policy's `COMMITTEE_AGENT_ROLE`;
governance voters are given power by `ADMIN_ROLE` via
`RouterGovernance.setVotingPower`). There is deliberately no
on-chain link between them — INV-4's signalling-only boundary
(`docs/prd.md` §12) is a *control*, not a label, precisely because
the parties that recommend and the parties that approve never
overlap. The invariant asserted here is a deployment-level
invariant over that live state.
It is a security-model change (requiring a new ADR against INV-4)
to grant a committee agent voting power or to grant a voter the
COMMITTEE_AGENT_ROLE, so this test fails loudly if that overlap
ever appears in the configured topology. It also pins that the
approving body's quorum reflects a real (< total voter power)
threshold rather than the MVP default of one, resolving the §3.4
open concern.


## Constants
### VOTER_POWER

```solidity
uint256 internal constant VOTER_POWER = 100e18
```


### VOTING_PERIOD

```solidity
uint64 internal constant VOTING_PERIOD = 1 days
```


### EXECUTION_DELAY

```solidity
uint64 internal constant EXECUTION_DELAY = 1 days
```


### QUORUM_THRESHOLD

```solidity
uint256 internal constant QUORUM_THRESHOLD = 250e18
```


## State Variables
### admin

```solidity
address internal admin = makeAddr("admin")
```


### committeeAthena

```solidity
address internal committeeAthena = makeAddr("committee-athena")
```


### committeeRobotMoney

```solidity
address internal committeeRobotMoney = makeAddr("committee-robotmoney")
```


### committeeWoon

```solidity
address internal committeeWoon = makeAddr("committee-woon")
```


### voter1

```solidity
address internal voter1 = makeAddr("gov-voter-1")
```


### voter2

```solidity
address internal voter2 = makeAddr("gov-voter-2")
```


### voter3

```solidity
address internal voter3 = makeAddr("gov-voter-3")
```


### intruder

```solidity
address internal intruder = makeAddr("intruder")
```


### ic

```solidity
InvestmentCommitteePolicy internal ic
```


### gov

```solidity
RouterGovernance internal gov
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _separationHolds

True iff no address holds both COMMITTEE_AGENT_ROLE and non-zero
RouterGovernance voting power. Written as a predicate so the whole
topology can be swept in one place.


```solidity
function _separationHolds() internal view returns (bool);
```

### _overlap

True iff `account` has COMMITTEE_AGENT_ROLE AND non-zero power.


```solidity
function _overlap(bytes32 committeeRole, address account) internal view returns (bool);
```

### test_committeeAgentsHaveNoVotingPower

The configured committee agents hold COMMITTEE_AGENT_ROLE but
have ZERO voting power.


```solidity
function test_committeeAgentsHaveNoVotingPower() public view;
```

### test_votersAreNotCommitteeAgents

The configured governance voters hold non-zero power but do NOT
hold COMMITTEE_AGENT_ROLE.


```solidity
function test_votersAreNotCommitteeAgents() public view;
```

### test_committeeHoldersAreRecognisedByPolicy

No committee agent holds COMMITTEE_AGENT_ROLE. It is a
security-model change (new ADR against INV-4) for a committee
agent to hold voting power, so the mutually-exclusive membership
is asserted directly.


```solidity
function test_committeeHoldersAreRecognisedByPolicy() public view;
```

### test_separationInvariantHolds

The full configured topology satisfies the separation invariant.


```solidity
function test_separationInvariantHolds() public view;
```

### test_invariantFlagsCommitteeAgentWithVotingPower

A committee agent who receives voting power (a security-model
change needing an ADR against INV-4) is flagged by the
invariant. This asserts the predicate catches the overlap it is
supposed to prevent; it mutates only the test's own live state,
never the shipped topology.


```solidity
function test_invariantFlagsCommitteeAgentWithVotingPower() public;
```

### test_invariantFlagsVoterGivenCommitteeRole

A voter who is additionally granted COMMITTEE_AGENT_ROLE (a
security-model change) is flagged by the invariant.


```solidity
function test_invariantFlagsVoterGivenCommitteeRole() public;
```

### test_quorumReflectsTheVoterSet

The approving body's quorum is a meaningful fraction of the
voter set, not the single-voter MVP default of 1 — resolving the
§3.4 open concern ("the approving body's quorum is currently
1"). One voter with any nonzero power can no longer carry a
weight proposal.


```solidity
function test_quorumReflectsTheVoterSet() public view;
```

