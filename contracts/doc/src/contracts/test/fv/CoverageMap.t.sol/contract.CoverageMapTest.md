# CoverageMapTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/174c53454088cd318240a18aade465c225fdb078/contracts/test/fv/CoverageMap.t.sol)

**Inherits:**
Test


## Constants
### SPEC

```solidity
string internal constant SPEC = "docs/technical/smart-contract-invariants.md"
```


### HEADING
Heading marker that precedes every invariant ID in the spec.


```solidity
bytes internal constant HEADING = bytes("> **`")
```


## Functions
### test_specAndRegistryAreInBijection

AC1: every invariant ID in the spec has exactly one registry entry,
and every registry entry corresponds to a spec ID. Fails CI if the
two sets diverge in either direction.


```solidity
function test_specAndRegistryAreInBijection() public view;
```

### test_everyRedEntryNamesRemediationIssue

Every RED registry entry names a remediation issue; every HOLDS
entry has none. Guards the invariant that an expected-fail test can
always tell its downstream issue which test to flip green.


```solidity
function test_everyRedEntryNamesRemediationIssue() public pure;
```

### test_negativeFixture_unmappedSpecIdIsDetected

Proves the coverage gate actually bites: an ID that exists in a
(simulated) spec but NOT in the registry must be reported as
unmapped. We feed the parser a synthetic spec fragment containing a
never-registered ID and assert the registry does not cover it — the
exact failure mode test_specAndRegistryAreInBijection would raise.


```solidity
function test_negativeFixture_unmappedSpecIdIsDetected() public pure;
```

### _parseSpecIds

Extract every invariant ID that starts a `> **\`ID\`` heading line.
Scans for the HEADING marker and reads the run of characters up to the
closing backtick. Returns IDs in document order (no dedup — duplicates
would be a spec bug the cardinality check then surfaces).


```solidity
function _parseSpecIds(string memory spec) internal pure returns (string[] memory ids);
```

### _isInvariantId

True for IDs of the shape LETTERS "-" DIGITS (e.g. "INV-1", "ORA-7").
Rejects the spec's literal `ID` placeholder and any other non-ID
backtick heading.


```solidity
function _isInvariantId(bytes memory id) internal pure returns (bool);
```

### _matchesAt


```solidity
function _matchesAt(bytes memory hay, bytes memory needle, uint256 at)
    internal
    pure
    returns (bool);
```

### _registryHas


```solidity
function _registryHas(InvariantRegistry.Entry[] memory reg, string memory id)
    internal
    pure
    returns (bool);
```

### _arrayHas


```solidity
function _arrayHas(string[] memory arr, string memory id) internal pure returns (bool);
```

