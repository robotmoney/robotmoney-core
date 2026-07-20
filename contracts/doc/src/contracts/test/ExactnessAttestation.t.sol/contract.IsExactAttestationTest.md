# IsExactAttestationTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/01b59e20caa97f6392c68e2a81dce4c5d658f622/contracts/test/ExactnessAttestation.t.sol)

**Inherits:**
[ExactnessBase](/contracts/test/ExactnessAttestation.t.sol/abstract.ExactnessBase.md)


## Functions
### test_isExactAttestedAtAddAdapter_alongsideCodehashPinning

`isExact` is written at `addAdapter` in the same act that pins the
codehash + allowlist entry, and is what `getAdapterInfo` returns.


```solidity
function test_isExactAttestedAtAddAdapter_alongsideCodehashPinning() public;
```

### test_attestedExact_overridesAdapterSelfReportFalse

A liar adapter whose self-report is FALSE but attested TRUE keeps
the vault in EXACT mode: `allExact()` stays true and `withdraw()`
works at deposit/withdraw time — proving the vault never reads
`adapter.isExact()` (which is false) for the mode branch (C2).


```solidity
function test_attestedExact_overridesAdapterSelfReportFalse() public;
```

### test_attestedInexact_overridesAdapterSelfReportTrue

A liar adapter whose self-report is TRUE but attested FALSE puts
the vault in INEXACT mode: `allExact()` is false, `previewWithdraw`
reverts `RedeemOnly` and `maxWithdraw` is 0 — proving the vault
never reads `adapter.isExact()` (which is true) for the branch.


```solidity
function test_attestedInexact_overridesAdapterSelfReportTrue() public;
```

