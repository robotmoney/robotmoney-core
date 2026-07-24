# PerThemeDeployTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/f0d5e0cc4ed74e32f7ff690ebf3edb2b2848abdd/contracts/test/PerThemeDeploy.t.sol)

**Inherits:**
Test


## Constants
### TVL_CAP

```solidity
uint256 internal constant TVL_CAP = 10_000_000 * 1e6
```


### PER_DEPOSIT_CAP

```solidity
uint256 internal constant PER_DEPOSIT_CAP = 1_000_000 * 1e6
```


### NAV_GROWTH_BPS

```solidity
uint256 internal constant NAV_GROWTH_BPS = 500
```


## State Variables
### deployer

```solidity
DeployVaultThemes internal deployer
```


### usdc

```solidity
TestERC20 internal usdc
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### emergency

```solidity
address internal emergency = makeAddr("emergency")
```


### feeRecipient

```solidity
address internal feeRecipient = makeAddr("feeRecipient")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _deployVault


```solidity
function _deployVault(DeployVaultThemes.Theme t) internal returns (Vault v);
```

### _specs

Build a variable-length adapter set for `v`: one mock adapter per
`(capBps, isExact)` pair, each bound to the vault.


```solidity
function _specs(Vault v, uint16[] memory caps, bool[] memory exacts)
    internal
    returns (DeployVaultThemes.AdapterSpec[] memory specs);
```

### _assertAdapterSet

Assert the vault's registered adapter set matches `specs` exactly:
count, per-adapter address, weight (`capBps`), attested `isExact`,
and active flag.


```solidity
function _assertAdapterSet(Vault v, DeployVaultThemes.AdapterSpec[] memory specs)
    internal
    view;
```

### test_rmUsdc_deploysExactLendingSet


```solidity
function test_rmUsdc_deploysExactLendingSet() public;
```

### test_rmProto_deploysInexactV3Set


```solidity
function test_rmProto_deploysInexactV3Set() public;
```

### test_rmAgent_deploysMixedSetWithTimelockAdmin


```solidity
function test_rmAgent_deploysMixedSetWithTimelockAdmin() public;
```

### test_rmRwa_deploysSingleAdapterAndEnforcesCapOfOne


```solidity
function test_rmRwa_deploysSingleAdapterAndEnforcesCapOfOne() public;
```

### _assertWireCountMatchesExpected

After a correctly-counted wiring, the vault's active adapter count
equals the theme's `expectedAdapters` — the field is now read and
enforced, not a write-only doc aid.


```solidity
function _assertWireCountMatchesExpected(DeployVaultThemes.Theme t) internal;
```

### test_rmUsdc_wireCountMatchesExpected


```solidity
function test_rmUsdc_wireCountMatchesExpected() public;
```

### test_rmProto_wireCountMatchesExpected


```solidity
function test_rmProto_wireCountMatchesExpected() public;
```

### test_rmAgent_wireCountMatchesExpected


```solidity
function test_rmAgent_wireCountMatchesExpected() public;
```

### test_rmRwa_wireCountMatchesExpected


```solidity
function test_rmRwa_wireCountMatchesExpected() public;
```

### _assertWireWrongCountReverts

A wiring whose adapter count differs from `expectedAdapters` reverts
`AdapterCountMismatch` — the documented spec §8 MUST-invariant is now
an in-code guarantee for every theme, not just rmRWA's incidental cap.


```solidity
function _assertWireWrongCountReverts(DeployVaultThemes.Theme t, uint256 wrong) internal;
```

### test_rmUsdc_wireWrongCountReverts


```solidity
function test_rmUsdc_wireWrongCountReverts() public;
```

### test_rmProto_wireWrongCountReverts


```solidity
function test_rmProto_wireWrongCountReverts() public;
```

### test_rmAgent_wireWrongCountReverts


```solidity
function test_rmAgent_wireWrongCountReverts() public;
```

### test_rmRwa_wireWrongCountReverts


```solidity
function test_rmRwa_wireWrongCountReverts() public;
```

### test_weightArrayLengthVariesPerTheme


```solidity
function test_weightArrayLengthVariesPerTheme() public;
```

### _wireLenFor

Deploy `t`, wire `n` equal-weight adapters, return the resulting active
count (== the wired weight-array length).


```solidity
function _wireLenFor(DeployVaultThemes.Theme t, uint256 n, bool exact)
    internal
    returns (uint256);
```

