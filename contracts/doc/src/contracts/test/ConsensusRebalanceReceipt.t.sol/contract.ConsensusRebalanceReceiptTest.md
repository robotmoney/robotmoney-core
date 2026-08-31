# ConsensusRebalanceReceiptTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/743c60bd2a8cdaa5170640645e0c5bf35685c012/contracts/test/ConsensusRebalanceReceipt.t.sol)

**Inherits:**
Test

**Title:**
ConsensusRebalanceReceiptTest

Full on-chain path for the consensus receipt anchor:
gateway → receipt contract → event, plus the signalling-only
boundary, the timelock-held `ADMIN_ROLE`, the 3-topic event limit,
and the anchoring-digest assertion that closes issue #1280.


## Constants
### VALID_CANONICAL

```solidity
string constant VALID_CANONICAL = "tests/fixtures/consensus-receipt.valid.canonical.txt"
```


### ESCAPING_CANONICAL

```solidity
string constant ESCAPING_CANONICAL = "tests/fixtures/consensus-receipt.escaping.canonical.txt"
```


### VALID_JSON

```solidity
string constant VALID_JSON = "tests/fixtures/consensus-receipt.valid.json"
```


### ESCAPING_JSON

```solidity
string constant ESCAPING_JSON = "tests/fixtures/consensus-receipt.escaping.json"
```


### ANCHOR_DIGEST

```solidity
string constant ANCHOR_DIGEST = "tests/fixtures/consensus-receipt.anchor-digest.json"
```


### RECEIPT_ID_DOMAIN
Receipt-id domain separator, pinned by
consensus-receipt.canonicalization.json#receipt_id_derivation.


```solidity
string constant RECEIPT_ID_DOMAIN = "robotmoney:consensus-receipt-id:v1\n"
```


### MIN_DELAY

```solidity
uint256 constant MIN_DELAY = 1 hours
```


### PAYLOAD_URI

```solidity
string constant PAYLOAD_URI = "https://robotmoney.net/api/swarm/receipts/session-1"
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


### submitter

```solidity
address submitter = address(0xB1)
```


### stranger

```solidity
address stranger = address(0xDEAD)
```


### proposer

```solidity
address proposer = address(0xC0)
```


### executor

```solidity
address executor = address(0xC1)
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


### receipts

```solidity
ConsensusRebalanceReceipt receipts
```


### timelock

```solidity
TimelockController timelock
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _goldenBytes

Read the committed golden canonical bytes exactly — trailing
newline included, nothing trimmed or re-encoded.


```solidity
function _goldenBytes(string memory path) internal view returns (bytes memory);
```

### _pinnedDigest

Read the pinned digest constant for `file` out of the core-only
sidecar. The constant is COMPARED against a freshly derived hash;
it is never the source of the value under test.


```solidity
function _pinnedDigest(uint256 goldenIndex)
    internal
    view
    returns (bytes32 digest, uint256 byteLength, string memory file);
```

### _receiptIdFor


```solidity
function _receiptIdFor(string memory receiptJsonPath) internal view returns (bytes32);
```

### _record


```solidity
function _record(bytes32 receiptId, bytes32 digest) internal returns (uint256);
```

### testDirectRecordReverts

A direct call to `recordReceipt` reverts even from the allowlisted
submitter: the gateway is the sole choke point.


```solidity
function testDirectRecordReverts() public;
```

### testDirectRecordFromTimelockReverts

Even an ADMIN_ROLE holder cannot bypass the gateway.


```solidity
function testDirectRecordFromTimelockReverts() public;
```

### testNonAgentCannotRecordViaGateway

A gateway caller without `AGENT_ROLE` is rejected by the gateway.


```solidity
function testNonAgentCannotRecordViaGateway() public;
```

### testSubmitterNotAllowlistedReverts

A gateway agent that is not on the IC allowlist is rejected by the
receipt contract — role administration stays on the IC policy.


```solidity
function testSubmitterNotAllowlistedReverts() public;
```

### testRecordRequiresConfiguredReceiptContract


```solidity
function testRecordRequiresConfiguredReceiptContract() public;
```

### testEmptyReceiptIdReverts


```solidity
function testEmptyReceiptIdReverts() public;
```

### testEmptyPayloadDigestReverts


```solidity
function testEmptyPayloadDigestReverts() public;
```

### testEmptyPayloadUriReverts


```solidity
function testEmptyPayloadUriReverts() public;
```

### testDuplicateReceiptIdReverts

One receipt per session per subject — the uniqueness property the
receipt-id derivation exists to enforce.


```solidity
function testDuplicateReceiptIdReverts() public;
```

### testAdminRoleHeldByTimelock

The timelock, and only the timelock, holds `ADMIN_ROLE`. The
deployer, the gateway and the protocol admin all do not.


```solidity
function testAdminRoleHeldByTimelock() public view;
```

### testReleaseRevertsUnlessRoutedThroughTimelock

Test plan 3: `ADMIN_ROLE` operations revert unless routed through
the timelock — and succeed when they are, only after `minDelay`.


```solidity
function testReleaseRevertsUnlessRoutedThroughTimelock() public;
```

### testDoubleReleaseReverts


```solidity
function testDoubleReleaseReverts() public;
```

### testReleaseUnknownReceiptReverts


```solidity
function testReleaseUnknownReceiptReverts() public;
```

### testRecordStoresEveryField


```solidity
function testRecordStoresEveryField() public;
```

### testUnreleasedReceiptNeverExpires

The never-released case (issue #1247 task 4.0, third question): an
unreleased receipt is a permanent public record. Nothing expires
it, nothing deletes it, and no on-chain state changes with time.


```solidity
function testUnreleasedReceiptNeverExpires() public;
```

### testEventsCarryNoIndexedSignatureParameter

AC3: no event may use an indexed signature parameter. The receipt
events carry no signature parameter at all — analyst signatures are
payload data, never event data — and both events stay within the
EVM's 3-topic non-anonymous limit, which a `uint8[64] indexed`
signature would blow past.


```solidity
function testEventsCarryNoIndexedSignatureParameter() public;
```

### testSignallingOnlyBoundary

AC1, mirroring `InvestmentCommitteePolicyTest.testSignallingOnlyBoundary`.
No path from any receipt entrypoint reaches `setWeights` or moves
value: the contract has no `receive`/`fallback`, no ERC-20 surface,
no router or governance selector, and its only state effect is an
append plus a boolean flip.


```solidity
function testSignallingOnlyBoundary() public;
```

### testComputeReceiptIdMatchesCanonicalizationContract

The receipt-id derivation implemented on chain must agree with
`consensus-receipt.canonicalization.json#receipt_id_derivation`,
computed here from the fixture's own `session_id` / `subject_id`.


```solidity
function testComputeReceiptIdMatchesCanonicalizationContract() public view;
```

### testAnchoringPathSubmitsTheGoldenDigest

AC11 + AC12 — the assertion `robotmoney-frontend` structurally
cannot make, because only this repo sees the transaction.
The digest is **derived** by hashing the committed golden bytes,
never transcribed. It is then compared with the pinned constant in
`consensus-receipt.anchor-digest.json` (so changing either side
alone turns this red), and finally asserted to be exactly what the
anchoring path carries: the `payloadDigest` in the emitted
`ReceiptRecorded` topic set and in the stored receipt.


```solidity
function testAnchoringPathSubmitsTheGoldenDigest() public;
```

### testAnchoringPathSubmitsTheEscapingGoldenDigest

AC13 — the non-ASCII conformance receipt gets the same treatment.
An ASCII-only digest check cannot detect a serializer that escapes
non-ASCII, U+2028, or the HTML-sensitive characters, and the two
most likely non-JS implementations each diverge that way BY
DEFAULT while still reproducing an all-ASCII golden exactly.


```solidity
function testAnchoringPathSubmitsTheEscapingGoldenDigest() public;
```

### testGoldensAnchorDistinctDigests

The two goldens are distinct receipts and must anchor distinct
digests — a serializer that collapsed them would pass a
single-fixture check.


```solidity
function testGoldensAnchorDistinctDigests() public view;
```

