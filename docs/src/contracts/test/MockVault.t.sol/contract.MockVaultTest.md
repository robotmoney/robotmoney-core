# MockVaultTest
[Git Source](https://github.com/lucky-tensor/robotmoney-skills/blob/b462a72b60a914ceeff6cdf3ad7148bfb0361abb/contracts/test/MockVault.t.sol)

**Inherits:**
Test


## State Variables
### usdc

```solidity
MockUSDC internal usdc
```


### vault

```solidity
MockVault internal vault
```


### alice

```solidity
address internal alice = makeAddr("alice")
```


### bob

```solidity
address internal bob = makeAddr("bob")
```


### receiver

```solidity
address internal receiver = makeAddr("receiver")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_metadata


```solidity
function test_metadata() public view;
```

### test_deposit_oneToOneShares_routesToReceiver


```solidity
function test_deposit_oneToOneShares_routesToReceiver() public;
```

### test_deposit_revertsWithoutAllowance


```solidity
function test_deposit_revertsWithoutAllowance() public;
```

### test_deposit_revertsOnZeroAmount


```solidity
function test_deposit_revertsOnZeroAmount() public;
```

### test_deposit_revertsOnZeroReceiver


```solidity
function test_deposit_revertsOnZeroReceiver() public;
```

### test_deposit_multipleAgentsAccumulate


```solidity
function test_deposit_multipleAgentsAccumulate() public;
```

### test_emitsDepositEvent


```solidity
function test_emitsDepositEvent() public;
```

### testFuzz_deposit_oneToOne


```solidity
function testFuzz_deposit_oneToOne(uint96 amount) public;
```

