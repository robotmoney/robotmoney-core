# CustodyInvariantGuardTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a7ac64337cc2843fe9fad5c808ffb035e51d4697/contracts/test/CustodyInvariantGuard.t.sol)

**Inherits:**
Test


## Functions
### _productionSources

Every production source file (NOT under contracts/test or
contracts/doc). Kept as an explicit list so the guard is
deterministic and a newly-added contract is a deliberate edit here.


```solidity
function _productionSources() internal pure returns (string[] memory paths);
```

### _contains

True if `haystack` contains `needle` (naive substring scan).


```solidity
function _contains(string memory haystack, string memory needle) internal pure returns (bool);
```

### test_INV1_noArbitraryRecipientRescueFunctions

INV-1: no production source declares an arbitrary-recipient
rescue function. `rescueTokens`/`rescueUsdc` are deleted, and the
IStrategyAdapter interface no longer declares them.


```solidity
function test_INV1_noArbitraryRecipientRescueFunctions() public view;
```

### test_INV2_sweepForeignTokenReplacesRescue

INV-2: every balance-holding production contract that previously
exposed a rescue function now exposes the permissionless
`sweepForeignToken(token)` quarantine sweep instead.


```solidity
function test_INV2_sweepForeignTokenReplacesRescue() public view;
```

### test_quarantineDestinationIsConstant

INV-1/INV-2: the quarantine destination is a hardcoded constant in
the shared library, so no role or caller can steer the sweep.


```solidity
function test_quarantineDestinationIsConstant() public view;
```

### test_prdDocumentsSecurityInvariants

The PRD documents the three invariants (docs-first gate).


```solidity
function test_prdDocumentsSecurityInvariants() public view;
```

