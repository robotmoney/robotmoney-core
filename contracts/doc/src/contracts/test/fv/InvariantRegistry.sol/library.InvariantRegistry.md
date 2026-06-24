# InvariantRegistry
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a2a6d8e4e2a61d93030482a63145fd865f67cc02/contracts/test/fv/InvariantRegistry.sol)


## Functions
### entries

The full catalogue. Order mirrors the spec's section order. NEVER
reorder-and-renumber; append-only like the spec's IDs.


```solidity
function entries() internal pure returns (Entry[] memory e);
```

### get

Look up a single entry by ID; reverts if absent.


```solidity
function get(string memory id) internal pure returns (Entry memory);
```

## Structs
### Entry

```solidity
struct Entry {
    string id; // stable invariant ID, e.g. "INV-1"
    Status status; // HOLDS or RED
    string strategy; // declared FV strategy (mirrors the spec)
    uint256 remediationIssue; // downstream remediation issue for RED entries; 0 otherwise
}
```

## Enums
### Status

```solidity
enum Status {
    HOLDS, // spec ✅/🟢/🟡/⚪ — a passing (or trivially-passing) FV test exists
    RED // spec 🔴 — currently breakable; FV test skipped until remediation lands
}
```

