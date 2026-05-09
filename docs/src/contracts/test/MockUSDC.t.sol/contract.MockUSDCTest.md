# MockUSDCTest
[Git Source](https://github.com/lucky-tensor/robotmoney-skills/blob/b462a72b60a914ceeff6cdf3ad7148bfb0361abb/contracts/test/MockUSDC.t.sol)

**Inherits:**
Test


## State Variables
### usdc

```solidity
MockUSDC internal usdc
```


### alice

```solidity
address internal alice = makeAddr("alice")
```


### bob

```solidity
address internal bob = makeAddr("bob")
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

### test_mint_increasesBalanceAndSupply


```solidity
function test_mint_increasesBalanceAndSupply() public;
```

### test_mint_isPermissionless


```solidity
function test_mint_isPermissionless() public;
```

### test_transfer


```solidity
function test_transfer() public;
```

### test_approveAndTransferFrom


```solidity
function test_approveAndTransferFrom() public;
```

### testFuzz_mint


```solidity
function testFuzz_mint(address to, uint128 amount) public;
```

