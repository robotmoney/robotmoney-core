# DeployAssertionsTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/9912e66cc064941cf391031069c85d740fd52944/contracts/test/fv/DeployAssertions.t.sol)

**Inherits:**
Test


## Functions
### _contains

Naive substring scan (same pattern as CustodyInvariantGuard.t.sol).


```solidity
function _contains(string memory haystack, string memory needle) internal pure returns (bool);
```

### test_ACL1_eoaHoldsNoPrivilegedRoleAfterHandover

ACL-1 (RED, F-01): after deployment handover, no EOA holds any
privileged role. On current HEAD the deployer EOA keeps Gateway
DEFAULT_ADMIN_ROLE + every vault EMERGENCY_ROLE, and the deploy
script only revokes ADMIN_ROLE. When #965 completes the handover,
remove the skip and assert the EOA holds none of
{DEFAULT_ADMIN_ROLE, ADMIN_ROLE, EMERGENCY_ROLE, PAUSER_ROLE} on
the gateway and every vault.


```solidity
function test_ACL1_eoaHoldsNoPrivilegedRoleAfterHandover() public;
```

### test_ORA3_addAssetRevertsOnPoolMismatch

ORA-3 (RED, F-09): BasketVault.addAsset reverts when the configured
execution pool (derived from swapFee) does not equal the TWAP
pricing pool. On current HEAD addAsset performs NO such equality
check. When #966 adds it, remove the skip and assert addAsset
reverts on a pool/fee mismatch.


```solidity
function test_ORA3_addAssetRevertsOnPoolMismatch() public;
```

### test_ORA6_chronicleAdapterDecimalsAssumptionIsDocumented

ORA-6 (HOLDS — 🟡 TRUSTED, F-17): documents the current decimals
trust assumption. The ChronicleOracleAdapter hardcodes the
1e12 = 10^(18-6) scale, correct only while the priced asset is
18-dec and USDC is 6-dec. This passing static-guard pins that the
hardcoded constant is still present (so a silent decimals change is
caught) and marks the seam where #966 would add the dynamic
`decimals()==18 && usdc.decimals()==6` constructor assertion.


```solidity
function test_ORA6_chronicleAdapterDecimalsAssumptionIsDocumented() public view;
```

