# AgentTokenVaultTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/e87e3c25f878d584d0de1f966dcf456f62dad87a/contracts/test/AgentTokenVault.t.sol)

**Inherits:**
Test


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


### N

```solidity
uint256 internal constant N = 6
```


## State Variables
### SYMBOLS

```solidity
string[6] internal SYMBOLS = ["JUNO", "RM", "BANKR", "ZYFAI", "GIZA", "DEUS"]
```


### usdc

```solidity
TestERC20 internal usdc
```


### router

```solidity
RecordingSwapRouter internal router
```


### vault

```solidity
AgentTokenVault internal vault
```


### tokens

```solidity
TestERC20[6] internal tokens
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### stranger

```solidity
address internal stranger = makeAddr("stranger")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _seedSixTokenShortlist

Seed the vault with the six MVP tokens, in canonical order, each
paired with USDC via a 1:1 mock pool — mirrors the deploy seed.


```solidity
function _seedSixTokenShortlist() internal;
```

### test_shortlist_seeded_with_six_mvp_tokens


```solidity
function test_shortlist_seeded_with_six_mvp_tokens() public view;
```

### test_shortlist_ordering_matches_config


```solidity
function test_shortlist_ordering_matches_config() public view;
```

### test_equal_weight_allocation_across_six_tokens


```solidity
function test_equal_weight_allocation_across_six_tokens() public;
```

### test_shortlist_mutation_admin_only


```solidity
function test_shortlist_mutation_admin_only() public;
```

### test_shortlist_mutation_rejected_for_non_admin


```solidity
function test_shortlist_mutation_rejected_for_non_admin() public;
```

### test_governance_shortlist_add_delay_is_48h


```solidity
function test_governance_shortlist_add_delay_is_48h() public view;
```

### test_governance_shortlist_remove_delay_is_24h


```solidity
function test_governance_shortlist_remove_delay_is_24h() public view;
```

### test_demo_seed_registers_agent_token_vault_with_shortlist

Exercises the real demo seed chain: DeployDemoExtraVaults.run()
deploys + seeds AgentTokenVault with the three real-asset demo
tokens (BNKR/V3, JUNO/V4, RM/Aerodrome), registers it in
VaultRegistry, and makes it router-eligible (issue #560).
The vault is reachable via the same registry path the dapp uses.


```solidity
function test_demo_seed_registers_agent_token_vault_with_shortlist() public;
```

