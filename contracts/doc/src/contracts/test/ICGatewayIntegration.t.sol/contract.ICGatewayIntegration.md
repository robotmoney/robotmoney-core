# ICGatewayIntegration
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/b58df0d9705fd40d8110bd43d533f82a20b8ace3/contracts/test/ICGatewayIntegration.t.sol)

**Inherits:**
Test

**Title:**
ICGatewayIntegration

Integration tests verifying the full on-chain path:
gateway → IC contract → event emitted (issue #1049 acceptance criteria).
Three tests cover all three ACs:
1. gateway-routed `committeeRegister` reaches IC and emits `AgentRegistered`
2. gateway-routed `committeeVoteSubmit` reaches IC and emits `VoteSubmitted`
3. direct (non-gateway) call to IC `registerAgent` reverts


## Constants
### VOTE_JSON_HASH

```solidity
bytes32 constant VOTE_JSON_HASH = keccak256("vote-json-integration")
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
### admin

```solidity
address admin = address(0xA0)
```


### pauser

```solidity
address pauser = address(0xA1)
```


### shareReceiver

```solidity
address shareReceiver = address(0xA2)
```


### committeeAgent

```solidity
address committeeAgent = address(0xB1)
```


### vaultAddr

```solidity
address vaultAddr = address(0xC1)
```


### usdc

```solidity
TestERC20 usdc
```


### vault

```solidity
MockVault vault
```


### gateway

```solidity
RobotMoneyGateway gateway
```


### ic

```solidity
InvestmentCommitteePolicy ic
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _defaultVoteParams


```solidity
function _defaultVoteParams()
    internal
    view
    returns (IInvestmentCommitteePolicy.VoteParams memory);
```

### test_gatewayRoutedRegister_emitsAgentRegistered

AC-1 (issue #1049): `gateway.committeeRegister` → IC `registerAgent`
→ `AgentRegistered` event emitted with the correct args.
Proves the full on-chain path gateway → IC contract → event.


```solidity
function test_gatewayRoutedRegister_emitsAgentRegistered() public;
```

### test_gatewayRoutedVoteSubmit_emitsVoteSubmitted

AC-2 (issue #1049): `gateway.committeeVoteSubmit` → IC `submitVote`
→ `VoteSubmitted` event emitted with the correct args.
Proves the full on-chain path gateway → IC contract → event.


```solidity
function test_gatewayRoutedVoteSubmit_emitsVoteSubmitted() public;
```

### test_directCallToICRegister_reverts

AC-3 (issue #1049): direct call to IC `registerAgent` by an address
that does not hold IC's ADMIN_ROLE reverts. The committee agent holds
AGENT_ROLE on the gateway but not ADMIN_ROLE on the IC contract, so a
direct bypass attempt is rejected — the gateway is the only path.


```solidity
function test_directCallToICRegister_reverts() public;
```

### test_directCallToICRegister_byAgent_reverts

Complementary revert test: even an AGENT_ROLE holder on the gateway
cannot bypass the gateway to call IC registerAgent directly — role
separation ensures the agent has no IC admin privileges.


```solidity
function test_directCallToICRegister_byAgent_reverts() public;
```

### test_committeeRegister_revertsWhenICPolicyNotSet

Proves the `ICPolicyNotSet` guard on `committeeRegister` fires when
the gateway's `icPolicy` slot is empty.  A freshly-deployed gateway
with no `setICPolicy` call has `icPolicy == address(0)`.


```solidity
function test_committeeRegister_revertsWhenICPolicyNotSet() public;
```

### test_committeeVoteSubmit_revertsWhenICPolicyNotSet

Proves the `ICPolicyNotSet` guard on `committeeVoteSubmit` fires when
the gateway's `icPolicy` slot is empty.


```solidity
function test_committeeVoteSubmit_revertsWhenICPolicyNotSet() public;
```

