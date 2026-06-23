# ERC4626PreconditionChecks
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a7ac64337cc2843fe9fad5c808ffb035e51d4697/contracts/test/ERC4626PreconditionChecks.t.sol)

**Inherits:**
Test

**Title:**
ERC4626PreconditionChecks

Suite-19 precondition gate. For every `exitFeeBps` tier
(0, 30, 100) × adapter (aave, compound, morpho)
this asserts the vault's structural ERC-4626 preconditions on a
freshly-deployed, empty vault: `asset()`, `decimals()`, and the
empty-vault share-price invariants. The CI matrix re-runs this
contract once per `EXIT_FEE_BPS` value; the hardcoded per-tier
tests additionally cover all three tiers in a single local run.

INTENTIONALLY-SKIPPED a16z erc4626-tests properties under non-zero
exit fees. The a16z `ERC4626Test` property suite assumes a vanilla,
fee-free vault. RobotMoneyVault charges an exit fee on the
redeem/withdraw path (`_grossToNet`/`_netToGross`), which breaks the
following vanilla properties for `exitFeeBps > 0`:
- `test_previewRedeem`  — `previewRedeem(s)` returns net-of-fee
assets, strictly below the vanilla `convertToAssets(s)`.
- `test_previewWithdraw` — `previewWithdraw(a)` grosses the request
up by the fee, so it exceeds the vanilla share count.
- `test_redeem` / `test_withdraw` round-trip parity — a
deposit→redeem round trip returns less than it put in by exactly
the exit fee, so `preview ↔ actual` parity holds but
`convertTo* ↔ redeem/withdraw` parity does not.
The deposit/mint side (`previewDeposit`, `previewMint`,
`convertToShares`, `convertToAssets`) carries no fee and remains
fully conformant, so those invariants are asserted below for every
tier. The exit-fee adjustment on the redeem path is asserted
explicitly rather than via the vanilla a16z property.


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


### OFFSET

```solidity
uint256 internal constant OFFSET = 18
```


### VIRTUAL_SHARES

```solidity
uint256 internal constant VIRTUAL_SHARES = 10 ** OFFSET
```


### MAX_BPS

```solidity
uint16 internal constant MAX_BPS = 10000
```


### MAX_EXIT_FEE_BPS

```solidity
uint16 internal constant MAX_EXIT_FEE_BPS = 100
```


### POOL_STUB

```solidity
address internal constant POOL_STUB = address(0xA00E)
```


## Functions
### test_preconditions_exitFee0


```solidity
function test_preconditions_exitFee0() public;
```

### test_preconditions_exitFee30


```solidity
function test_preconditions_exitFee30() public;
```

### test_preconditions_exitFee100


```solidity
function test_preconditions_exitFee100() public;
```

### test_preconditions_matrixEnvTier

Mirrors the CI matrix: reads `EXIT_FEE_BPS` (default 0) so each
matrix shard exercises the precondition gate with its own tier.


```solidity
function test_preconditions_matrixEnvTier() public;
```

### _runAdapterMatrix


```solidity
function _runAdapterMatrix(uint256 exitFeeBps) internal;
```

### _assertPreconditions


```solidity
function _assertPreconditions(AdapterKind kind, uint256 exitFeeBps) internal;
```

### _deployVaultWithAdapter


```solidity
function _deployVaultWithAdapter(AdapterKind kind, uint256 exitFeeBps)
    internal
    returns (RobotMoneyVault vault, TestERC20 usdc);
```

### _deployAdapter


```solidity
function _deployAdapter(AdapterKind kind, RobotMoneyVault vault, TestERC20 usdc)
    internal
    returns (address);
```

## Enums
### AdapterKind

```solidity
enum AdapterKind {
    Aave,
    Compound,
    Morpho
}
```

