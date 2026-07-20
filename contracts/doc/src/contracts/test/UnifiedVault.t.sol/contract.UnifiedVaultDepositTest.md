# UnifiedVaultDepositTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3d0125a0ee72af9f51ed36ec0b328a085a948116/contracts/test/UnifiedVault.t.sol)

**Inherits:**
[UnifiedVaultBase](/contracts/test/UnifiedVault.t.sol/abstract.UnifiedVaultBase.md)


## Functions
### setUp


```solidity
function setUp() public;
```

### test_firstDepositIntoCapFull_noUnderflow

AC: first deposit into a (nearly) cap-full adapter set with
`taBefore == 0` and `revokedIdle == 0` does NOT underflow the
`taBefore - revokedIdle + 1` denominator — it mints against the
realized delta (idle-and-continue), never reverts (A-H2).


```solidity
function test_firstDepositIntoCapFull_noUnderflow() public;
```

### test_idleInclusiveDenominator_noRoundTripProfit

AC (SUP-3 / C1): with pre-existing idle USDC backing existing
shares, the mint uses the idle-INCLUSIVE denominator `taBefore + 1`
(NOT the buggy `taBefore - idle + 1`), so a deposit+redeem round
trip cannot profit and existing holders are not diluted.


```solidity
function test_idleInclusiveDenominator_noRoundTripProfit() public;
```

### test_depositReturnsActualMintedShares

The deposit() override returns the ACTUAL minted shares (AZ-BSK-2),
which for an exact set equals OZ's `convertToShares` of the deposit.


```solidity
function test_depositReturnsActualMintedShares() public;
```

