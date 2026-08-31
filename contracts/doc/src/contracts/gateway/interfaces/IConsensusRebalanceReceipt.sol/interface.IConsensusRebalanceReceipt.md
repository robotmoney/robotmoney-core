# IConsensusRebalanceReceipt
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/743c60bd2a8cdaa5170640645e0c5bf35685c012/contracts/gateway/interfaces/IConsensusRebalanceReceipt.sol)

**Title:**
IConsensusRebalanceReceipt

Interface for the ConsensusRebalanceReceipt contract.
Design constraints (docs/architecture.md §4.9, settled by issue #1247 task 4.0):
- **Signalling only.** Recording or releasing a receipt moves no value and
sets no router weight. INV-4 (`docs/prd.md` §12).
- **One submitter attests for the committee.** There is no
`consensusSubmitSignature`: the analysts' ed25519 signatures ride inside
the payload as data verified off-chain (ADR-0012 §5). `recordReceipt` is
the single one-shot write.
- **No contract expiry.** The rejected multi-signer design's 7-day window is
deleted, not repurposed. Staleness is derived off-chain from the payload's
`created_at`.
- `recordReceipt` is `onlyGateway`; `releaseReceipt` is `ADMIN_ROLE`, which
the `TimelockController` holds (INV-3).


## Functions
### recordReceipt

Record an unreleased consensus-receipt commitment.
Must be called via the RobotMoneyGateway (`onlyGateway`).


```solidity
function recordReceipt(
    address submitter,
    bytes32 receiptId,
    bytes32 payloadDigest,
    string calldata payloadUri
) external returns (uint256 index);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`submitter`|`address`|    Committee agent that attested (the gateway's `msg.sender`).|
|`receiptId`|`bytes32`|    Unique receipt id; see `computeReceiptId`.|
|`payloadDigest`|`bytes32`|`keccak256` of the receipt's canonical bytes.|
|`payloadUri`|`string`|   Public route serving those exact bytes.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`index`|`uint256`|Index of the newly appended receipt.|


### releaseReceipt

Release a recorded receipt. `ADMIN_ROLE` only (the timelock).
Signalling only — see INV-4.


```solidity
function releaseReceipt(bytes32 receiptId) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`receiptId`|`bytes32`|The receipt to release.|


### receiptCount

Total number of recorded receipts.


```solidity
function receiptCount() external view returns (uint256);
```

### getReceipt

Retrieve a receipt by append index.


```solidity
function getReceipt(uint256 index) external view returns (Receipt memory);
```

### getReceiptById

Retrieve a receipt by its id. Reverts with `ReceiptNotFound`.


```solidity
function getReceiptById(bytes32 receiptId) external view returns (Receipt memory);
```

### isRecorded

Whether `receiptId` has been recorded.


```solidity
function isRecorded(bytes32 receiptId) external view returns (bool);
```

### isReleased

Whether `receiptId` has been released. False when not recorded.


```solidity
function isReleased(bytes32 receiptId) external view returns (bool);
```

### computeReceiptId

The receipt-id derivation pinned by
`tests/fixtures/consensus-receipt.canonicalization.json#receipt_id_derivation`:
`keccak256("robotmoney:consensus-receipt-id:v1\n" + session_id + "\n" + subject_id)`.


```solidity
function computeReceiptId(string calldata sessionId, string calldata subjectId)
    external
    pure
    returns (bytes32);
```

### gateway

The RobotMoneyGateway. All receipt writes must originate here.


```solidity
function gateway() external view returns (address);
```

### icPolicy

The InvestmentCommitteePolicy whose `COMMITTEE_AGENT_ROLE` gates submitters.


```solidity
function icPolicy() external view returns (address);
```

## Events
### ReceiptRecorded
Emitted when a committee submitter records a receipt commitment.

Exactly three indexed parameters (the EVM's non-anonymous limit).
No parameter is an analyst signature — the payload signatures are
never event data, on-chain or indexed. See issue #1247 AC3.


```solidity
event ReceiptRecorded(
    bytes32 indexed receiptId,
    address indexed submitter,
    uint256 indexed index,
    bytes32 payloadDigest,
    string payloadUri,
    uint64 recordedAt
);
```

### ReceiptReleased
Emitted when `ADMIN_ROLE` releases a recorded receipt.

Signalling only: sets `released = true` and emits. No fund movement,
no `setWeights` call (INV-4).


```solidity
event ReceiptReleased(bytes32 indexed receiptId, address indexed releasedBy, uint64 releasedAt);
```

## Errors
### ZeroAddress
Constructor passed `address(0)`.


```solidity
error ZeroAddress();
```

### CallerNotGateway
Caller is not the registered RobotMoneyGateway.


```solidity
error CallerNotGateway();
```

### SubmitterNotAllowlisted
Submitter does not hold `COMMITTEE_AGENT_ROLE` on the IC policy.


```solidity
error SubmitterNotAllowlisted();
```

### EmptyReceiptId
`receiptId` was `bytes32(0)`.


```solidity
error EmptyReceiptId();
```

### EmptyPayloadDigest
`payloadDigest` was `bytes32(0)`.


```solidity
error EmptyPayloadDigest();
```

### EmptyPayloadUri
`payloadUri` was the empty string.


```solidity
error EmptyPayloadUri();
```

### ReceiptAlreadyRecorded
`receiptId` has already been recorded — one receipt per session per subject.


```solidity
error ReceiptAlreadyRecorded();
```

### ReceiptNotFound
`receiptId` has never been recorded.


```solidity
error ReceiptNotFound();
```

### ReceiptAlreadyReleased
`receiptId` has already been released.


```solidity
error ReceiptAlreadyReleased();
```

## Structs
### Receipt
A single on-chain consensus-receipt commitment.


```solidity
struct Receipt {
    bytes32 receiptId;
    bytes32 payloadDigest;
    string payloadUri;
    address submitter;
    uint64 recordedAt;
    uint64 releasedAt;
    bool released;
}
```

**Properties**

|Name|Type|Description|
|----|----|-----------|
|`receiptId`|`bytes32`|    `keccak256` of the receipt-id preimage (see `computeReceiptId`). Unique per session per subject.|
|`payloadDigest`|`bytes32`|`keccak256` of the receipt's canonical bytes, per `tests/fixtures/consensus-receipt.canonicalization.json`.|
|`payloadUri`|`string`|   Stable public route serving those exact bytes.|
|`submitter`|`address`|    Committee agent EOA that attested for the committee.|
|`recordedAt`|`uint64`|   Block timestamp of `recordReceipt`.|
|`releasedAt`|`uint64`|   Block timestamp of `releaseReceipt`, or 0.|
|`released`|`bool`|     Whether an admin has released the receipt.|

