# ConsensusRecommendationReceipt
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/2a9fcb34331b03f9e13845e26eac35a6f0cc7642/contracts/gateway/ConsensusRecommendationReceipt.sol)

**Inherits:**
AccessControl, ReentrancyGuard, [IConsensusRecommendationReceipt](/contracts/gateway/interfaces/IConsensusRecommendationReceipt.sol/interface.IConsensusRecommendationReceipt.md)

**Title:**
ConsensusRecommendationReceipt

On-chain commitment register for the swarm's consensus
recommendation receipts. Stores a `receiptId`, the `keccak256` of the receipt's
canonical bytes, and the public URI serving those exact bytes.
Why the anchor exists (docs/product/…-investment-committee-v0.md §2.1): a
signed receipt published only at an RM-controlled URL can still be silently
suppressed by RM. The on-chain commitment is what makes the record
censorship-resistant. **That property lands at mainnet deployment, not at
v0.1's devnet proof of the mechanism** — no surface may describe the record
as tamper-proof in the present tense before then.
Design constraints, settled by issue #1247 task 4.0 and recorded in
`docs/architecture.md` §4.9:
- **Signalling only.** No treasury spend, no router-weight mutation, no
`receive`/`fallback`, no ERC-20 surface, no call into any vault or router.
INV-4 (`docs/prd.md` §12). Enforced by `testSignallingOnlyBoundary`.
- **One submitter, one write.** The rejected multi-signer design's
`consensusSubmitSignature` does not survive: a one-shot `recordReceipt`
replaces it. Analyst ed25519 signatures are payload data verified
off-chain; the EVM has no ed25519 precompile and ADR-0012 §5 closes that
seam. The chain proves the committee produced the recommendation and that
one submitter attested to it — never that each named analyst signed.
- **No contract expiry.** The 7-day `deadline` window collapses to zero: it
bounded a multi-party signature-collection window that no longer exists.
Staleness is a property of the recommendation, derived off-chain from the
payload's `created_at`. An unreleased receipt stays an immutable public
record forever; nothing deletes it or changes its on-chain state.
- **Role administration stays on one contract.** There is no second agent
registry: submitters are gated by `COMMITTEE_AGENT_ROLE` on the shipped
`InvestmentCommitteePolicy`.
- `ADMIN_ROLE` is held by the `TimelockController` (INV-3).
Payload contract: `tests/fixtures/consensus-receipt.schema.json` and
`consensus-receipt.canonicalization.json`, byte-identical to
`contract/src/__fixtures__/` in `robotmoney-frontend`.
Emits: `ReceiptRecorded`, `ReceiptReleased`.


## Constants
### ADMIN_ROLE
Releases receipts. Held by the `TimelockController` (INV-3).


```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### COMMITTEE_AGENT_ROLE
Mirror of `InvestmentCommitteePolicy.COMMITTEE_AGENT_ROLE`. This
contract keeps no agent registry of its own — membership is read
from the IC policy so role administration stays on one contract.


```solidity
bytes32 public constant COMMITTEE_AGENT_ROLE = keccak256("COMMITTEE_AGENT_ROLE")
```


### RECEIPT_ID_DOMAIN
Domain separator for the receipt-id preimage, pinned by
`consensus-receipt.canonicalization.json#receipt_id_derivation`.


```solidity
string internal constant RECEIPT_ID_DOMAIN = "robotmoney:consensus-receipt-id:v1\n"
```


### gateway
The RobotMoneyGateway. All receipt writes must originate here.


```solidity
address public immutable gateway
```


### icPolicy
The InvestmentCommitteePolicy whose `COMMITTEE_AGENT_ROLE` gates submitters.


```solidity
address public immutable icPolicy
```


## State Variables
### _receipts
Append-only receipt log.


```solidity
Receipt[] private _receipts
```


### _indexPlusOne
`receiptId` → 1-based index into `_receipts` (0 means absent).


```solidity
mapping(bytes32 => uint256) private _indexPlusOne
```


## Functions
### constructor


```solidity
constructor(address admin_, address gateway_, address icPolicy_) ;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`admin_`|`address`|    Address granted `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE`. In every non-test deployment this is the `TimelockController` (INV-3).|
|`gateway_`|`address`|  Deployed `RobotMoneyGateway`; sole permitted writer.|
|`icPolicy_`|`address`| Deployed `InvestmentCommitteePolicy`; the single source of `COMMITTEE_AGENT_ROLE` membership.|


### onlyGateway

Reverts unless `msg.sender` is the registered RobotMoneyGateway.


```solidity
modifier onlyGateway() ;
```

### recordReceipt

Record an unreleased consensus-receipt commitment.
Must be called via the RobotMoneyGateway (`onlyGateway`).


```solidity
function recordReceipt(
    address submitter,
    bytes32 receiptId,
    bytes32 payloadDigest,
    string calldata payloadUri
) external onlyGateway nonReentrant returns (uint256 index);
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
function releaseReceipt(bytes32 receiptId) external onlyRole(ADMIN_ROLE) nonReentrant;
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

