# AdapterDelegatecallGuardTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/60eddc5d5c695082281a4a0584160a58dfe2e50e/contracts/test/AdapterDelegatecallGuard.t.sol)

**Inherits:**
Test


## State Variables
### guard

```solidity
GuardHarness internal guard
```


### usdc

```solidity
address internal usdc = makeAddr("usdc")
```


### vaultAddr

```solidity
address internal vaultAddr = makeAddr("vault")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_requireNoDelegatecall_revertsForProxyAdapter


```solidity
function test_requireNoDelegatecall_revertsForProxyAdapter() public;
```

### test_requireNoDelegatecall_passesForAaveAdapter


```solidity
function test_requireNoDelegatecall_passesForAaveAdapter() public;
```

### test_requireNoDelegatecall_passesForCompoundAdapter


```solidity
function test_requireNoDelegatecall_passesForCompoundAdapter() public;
```

### test_requireNoDelegatecall_passesForMorphoAdapter


```solidity
function test_requireNoDelegatecall_passesForMorphoAdapter() public;
```

### test_requireNoDelegatecall_passesForPassthroughAdapter


```solidity
function test_requireNoDelegatecall_passesForPassthroughAdapter() public;
```

### test_containsDelegatecall_skipsPushImmediate

Bytecode `PUSH1 0xF4 STOP` contains byte `0xF4` but only as the
immediate of a `PUSH1`, not as an opcode. The scan must skip it.


```solidity
function test_containsDelegatecall_skipsPushImmediate() public view;
```

### test_containsDelegatecall_detectsBareOpcode

Bytecode `STOP DELEGATECALL` should be detected.


```solidity
function test_containsDelegatecall_detectsBareOpcode() public view;
```

### test_containsDelegatecall_skipsPush32Immediate

`PUSH32 <31 bytes> 0xF4` — the trailing `0xF4` is still immediate
data for the PUSH32 and must not be flagged.


```solidity
function test_containsDelegatecall_skipsPush32Immediate() public view;
```

