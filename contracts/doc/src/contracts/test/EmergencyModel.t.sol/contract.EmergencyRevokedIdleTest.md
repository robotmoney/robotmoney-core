# EmergencyRevokedIdleTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/EmergencyModel.t.sol)

**Inherits:**
[EmergencyModelBase](/contracts/test/EmergencyModel.t.sol/abstract.EmergencyModelBase.md)


## Functions
### setUp


```solidity
function setUp() public;
```

### test_revoke_creditsRevokedIdle_andReducesMintDenominator

AC: draining an ADP-2 (allowlist-revoked, ineligible-but-active)
adapter credits `revokedIdle` with the recovered USDC, and a
subsequent deposit mints against the idle-EXCLUSIVE denominator
`taBefore - revokedIdle + 1` — recovered idle is NOT repriced onto
the new depositor. `redeployRevokedIdle` then decrements it.


```solidity
function test_revoke_creditsRevokedIdle_andReducesMintDenominator() public;
```

### test_redeployRevokedIdle_decrements

`redeployRevokedIdle` routes recovered idle back into the healthy
active set and decrements `revokedIdle` by the amount routed.


```solidity
function test_redeployRevokedIdle_decrements() public;
```

