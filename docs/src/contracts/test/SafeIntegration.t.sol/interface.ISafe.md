# ISafe
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/60eddc5d5c695082281a4a0584160a58dfe2e50e/contracts/test/SafeIntegration.t.sol)

**Title:**
ISafe — minimal interface for the Safe (Gnosis Safe) multisig contract.

Only the functions required by the integration test suite are listed.
The canonical Safe ABI is available at https://github.com/safe-global/safe-smart-account.


## Functions
### getThreshold

Returns the current threshold required for a Safe transaction.


```solidity
function getThreshold() external view returns (uint256);
```

### getOwners

Returns the list of current Safe owners.


```solidity
function getOwners() external view returns (address[] memory);
```

### execTransaction

Execute a transaction signed by `threshold` or more owners.
Signature encoding for the EIP-712 `SafeMessage` / `SafeTx` type is
described in https://docs.safe.global/advanced/smart-account-signatures.
For Forge unit tests we use `eth_sign` / `contract` signature types.


```solidity
function execTransaction(
    address to,
    uint256 value,
    bytes calldata data,
    uint8 operation,
    uint256 safeTxGas,
    uint256 baseGas,
    uint256 gasPrice,
    address gasToken,
    address payable refundReceiver,
    bytes memory signatures
) external payable returns (bool success);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`to`|`address`|            Target address.|
|`value`|`uint256`|         Ether value to forward.|
|`data`|`bytes`|          Calldata.|
|`operation`|`uint8`|     0 = CALL, 1 = DELEGATECALL.|
|`safeTxGas`|`uint256`|     Gas for the inner call (0 = use all).|
|`baseGas`|`uint256`|       Gas for data / refund handling (0).|
|`gasPrice`|`uint256`|      Gas price for refund (0 = no refund).|
|`gasToken`|`address`|      ERC-20 gas token address (0 = ETH).|
|`refundReceiver`|`address payable`|Refund recipient (0 = tx.origin).|
|`signatures`|`bytes`|    Packed signature bytes (65 bytes per owner, sorted ascending by owner).|


### getTransactionHash

Returns the EIP-712 hash of `SafeTx` that owners must sign.


```solidity
function getTransactionHash(
    address to,
    uint256 value,
    bytes calldata data,
    uint8 operation,
    uint256 safeTxGas,
    uint256 baseGas,
    uint256 gasPrice,
    address gasToken,
    address payable refundReceiver,
    uint256 _nonce
) external view returns (bytes32);
```

### nonce

Returns the on-chain nonce (number of executed transactions).


```solidity
function nonce() external view returns (uint256);
```

