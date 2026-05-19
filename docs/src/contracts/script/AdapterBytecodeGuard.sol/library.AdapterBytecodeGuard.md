# AdapterBytecodeGuard
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/60eddc5d5c695082281a4a0584160a58dfe2e50e/contracts/script/AdapterBytecodeGuard.sol)

**Title:**
AdapterBytecodeGuard

Deploy-time / test-time invariant that approved RobotMoneyVault
strategy adapters are direct deployments whose runtime bytecode
contains no `DELEGATECALL` opcode.

Motivation: `RobotMoneyVault._requireAdapterEligible` pins an
adapter's *bytecode codehash* in the allowlist. If a future adapter
were deployed behind a minimal delegatecall proxy, the pinned hash
would cover the proxy bytecode only and the implementation could
be hot-swapped without violating the allowlist. The current
production set (Aave V3, Compound V3, Morpho, Passthrough) is
direct-deployed and has no `DELEGATECALL` in its runtime bytecode.
This guard enforces that invariant on every adapter the deploy
script approves, and is exercised by a contrived-proxy regression
test (`AdapterDelegatecallGuard.t.sol`).
The scan is opcode-aware: PUSH1..PUSH32 immediate data is skipped
so a `0xF4` byte embedded in a constant cannot trigger a false
positive. EOF / Cancun introduce no new variants that affect this
check (existing `DELEGATECALL` opcode == `0xF4`).


## Constants
### OP_DELEGATECALL
EVM opcode for `DELEGATECALL`.


```solidity
uint8 internal constant OP_DELEGATECALL = 0xF4
```


### OP_PUSH1
First PUSH opcode (`PUSH1`).


```solidity
uint8 internal constant OP_PUSH1 = 0x60
```


### OP_PUSH32
Last PUSH opcode (`PUSH32`).


```solidity
uint8 internal constant OP_PUSH32 = 0x7F
```


## Functions
### containsDelegatecall

Returns true if `code` contains the `DELEGATECALL` opcode
outside of PUSH immediate data and outside the trailing
Solidity CBOR metadata blob.


```solidity
function containsDelegatecall(bytes memory code) internal pure returns (bool);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`code`|`bytes`|Runtime bytecode of the candidate adapter.|


### requireNoDelegatecall

Reverts with `AdapterContainsDelegatecall` if `adapter`'s
runtime bytecode contains a `DELEGATECALL` opcode.


```solidity
function requireNoDelegatecall(address adapter) internal view;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`adapter`|`address`|Address of the contract to scan.|


### _scan

Opcode-aware linear scan of `code` with Solidity metadata
stripping. Returns `(true, i)` for the first `DELEGATECALL`
opcode found outside PUSH immediate data.
Solidity appends a CBOR metadata blob to the runtime bytecode
followed by a 2-byte big-endian length. Those bytes are not
executable code and may contain arbitrary IPFS / solc hash
bytes including `0xF4`, so the scan must stop at the metadata
boundary to avoid false positives.


```solidity
function _scan(bytes memory code) private pure returns (bool, uint256);
```

### _codeLengthWithoutMetadata

Returns the length of `code` with the trailing Solidity CBOR
metadata blob stripped. If the last two bytes do not encode a
plausible metadata length, the full length is returned.


```solidity
function _codeLengthWithoutMetadata(bytes memory code) private pure returns (uint256);
```

## Errors
### AdapterContainsDelegatecall
Thrown when an approved adapter's runtime bytecode contains
the `DELEGATECALL` opcode, which would let the allowlist be
bypassed by hot-swapping a proxy's implementation.


```solidity
error AdapterContainsDelegatecall(address adapter, uint256 position);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`adapter`|`address`|  The adapter address that failed the scan.|
|`position`|`uint256`| Byte index of the `0xF4` opcode in the runtime bytecode.|

