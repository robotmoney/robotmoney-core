# AgentTokenVaultTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/51bc4e0872e897b6ac297f478bbafc344398550d/contracts/test/AgentTokenVault.t.sol)

**Inherits:**
Test


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


### N
ADR-0001 revised 2026-06-02: three Base-liquid tokens {BNKR, JUNO, ROBOTMONEY}.


```solidity
uint256 internal constant N = 3
```


## State Variables
### SYMBOLS

```solidity
string[3] internal SYMBOLS = ["BNKR", "JUNO", "ROBOTMONEY"]
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
TestERC20[3] internal tokens
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

### _seedThreeTokenShortlist

Seed the vault with the three MVP tokens (ADR-0001 revised 2026-06-02:
{BNKR, JUNO, ROBOTMONEY}), in canonical order, each paired with USDC
via a 1:1 mock pool — mirrors the deploy seed.


```solidity
function _seedThreeTokenShortlist() internal;
```

### test_shortlist_seeded_with_three_mvp_tokens


```solidity
function test_shortlist_seeded_with_three_mvp_tokens() public view;
```

### test_shortlist_ordering_matches_config


```solidity
function test_shortlist_ordering_matches_config() public view;
```

### test_equal_weight_allocation_across_three_tokens


```solidity
function test_equal_weight_allocation_across_three_tokens() public;
```

### test_shortlist_mutation_admin_only


```solidity
function test_shortlist_mutation_admin_only() public;
```

### test_shortlist_mutation_rejected_for_non_admin


```solidity
function test_shortlist_mutation_rejected_for_non_admin() public;
```

### test_demo_seed_registers_agent_token_vault_with_shortlist

Exercises the real demo seed chain: DeployDemoExtraVaults.run()
deploys + seeds AgentTokenVault with the three MVP tokens and
registers it in VaultRegistry. Asserts the vault is reachable via
the same registry path the dapp uses and that shortlist() returns
the three-token list. AgentTokenVault must NOT be router-eligible.


```solidity
function test_demo_seed_registers_agent_token_vault_with_shortlist() public;
```

