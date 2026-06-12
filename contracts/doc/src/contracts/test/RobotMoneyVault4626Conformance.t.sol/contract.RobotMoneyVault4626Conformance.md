# RobotMoneyVault4626Conformance
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/eddfc6a75fd5558f18f4c48ae13aa1c3278c17e6/contracts/test/RobotMoneyVault4626Conformance.t.sol)

**Inherits:**
ERC4626Test

**Title:**
RobotMoneyVault4626Conformance

Property-based ERC-4626 conformance tests for RobotMoneyVault, built on
the a16z `erc4626-tests` suite.

Configured for the *vanilla* ERC-4626 surface: `exitFeeBps == 0` so that
`preview*` ↔ `redeem`/`withdraw` parity holds without fee adjustment. A
single `PassthroughAdapter` is registered with a 100% cap so that
`_deposit`'s `NoActiveAdapters` guard passes and yield can be simulated
by minting to the vault's idle balance (counted by `totalAssets()`).
Direct invocation must skip the deprecated `testFail_*` names that the
a16z suite still ships (modern forge rejects them and aborts the
whole contract). CI (suite-01-02-forge-tests.yml) passes the same
filter globally for `forge test` and `forge coverage`:
forge test --match-contract RobotMoneyVault4626Conformance \
--no-match-test "^testFail_"


## Functions
### setUp


```solidity
function setUp() public override;
```

