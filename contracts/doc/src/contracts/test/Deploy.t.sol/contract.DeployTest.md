# DeployTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/8fe82accd34499f358df165500b889c234fe064a/contracts/test/Deploy.t.sol)

**Inherits:**
Test

Exercises the deploy script in-process and asserts the post-deploy
invariants the operator and downstream tooling rely on (issue #10).
The script deploys RobotMoneyVault + AaveV3Adapter + CompoundV3Adapter
+ MorphoAdapter (issue #363) instead of MockVault.
MockVault is retained only for its own unit
tests.  The script always binds the gateway to an externally-supplied
USDC token; this test deploys a `TestERC20` helper and passes its
address in.  The smoke-test devnet does the same with the canonical
Base USDC proxy seeded into genesis alloc (issue #255).
Note: adapter constructors only check for address(0) — they do NOT
require the protocol contracts to have bytecode. The in-process test
therefore succeeds even though AAVE_V3_POOL et al. are not deployed
in the forge unit-test environment. Actual protocol interaction is
tested by the fork regression suite (VaultForkRegressions.t.sol) and
the fork-e2e-rust harness.


## Constants
### TICKMATH_AUDITED_CODEHASH
Audited runtime codehash of the canonical `TickMath` library,
pinned identically to both deploy scripts. If this drifts, the
library or compiler settings changed and the deploy-time
assertion in `Deploy.s.sol` / `DeployDemoExtraVaults.s.sol` must
be re-pinned.


```solidity
bytes32 internal constant TICKMATH_AUDITED_CODEHASH =
    0x1201c85bdae3b953cb38d7ae72ab099c55bc602a8c68b46cd649e8e38fdb875e
```


## State Variables
### script

```solidity
Deploy internal script
```


### usdc

```solidity
TestERC20 internal usdc
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### pauser

```solidity
address internal pauser = makeAddr("pauser")
```


### agent

```solidity
address internal agent = makeAddr("agent")
```


### shareReceiver

```solidity
address internal shareReceiver = makeAddr("shareReceiver")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _run


```solidity
function _run() internal returns (Deploy.Deployed memory);
```

### test_deploy_wiresUsdcVaultAndAdminPauserRoles


```solidity
function test_deploy_wiresUsdcVaultAndAdminPauserRoles() public;
```

### test_deploy_wiresThreeDistinctRealAdapterAddresses

The production deploy path wires exactly three DISTINCT real
adapter addresses — no single-address aliasing. This is the
regression guard for the removed test-only no-yield deploy hatch
(issue #912), which used to alias all three typed adapter fields
to one no-yield adapter instance. `runInProcessWith` shares the
same `_doDeploy` adapter-construction code path as the broadcast
`run()` entrypoint, so this exercises the `run()`-equivalent
wiring.


```solidity
function test_deploy_wiresThreeDistinctRealAdapterAddresses() public;
```

### test_deploy_authorizesAgentWithSanePolicy


```solidity
function test_deploy_authorizesAgentWithSanePolicy() public;
```

### test_deploy_doesNotMintToAgent


```solidity
function test_deploy_doesNotMintToAgent() public;
```

### test_deploy_revertsWhenUsdcAddressZero


```solidity
function test_deploy_revertsWhenUsdcAddressZero() public;
```

### test_deploy_revertsWhenUsdcAddressHasNoCode


```solidity
function test_deploy_revertsWhenUsdcAddressHasNoCode() public;
```

### test_deploy_grantingAgentRoleToAdminReverts


```solidity
function test_deploy_grantingAgentRoleToAdminReverts() public;
```

### test_deploy_grantingAgentRoleToPauserReverts


```solidity
function test_deploy_grantingAgentRoleToPauserReverts() public;
```

### test_deploy_revertsWhenAdminEqualsPauser


```solidity
function test_deploy_revertsWhenAdminEqualsPauser() public;
```

### test_deploy_revertsWhenAdminEqualsAgent


```solidity
function test_deploy_revertsWhenAdminEqualsAgent() public;
```

### test_deploy_revertsWhenPauserEqualsAgent


```solidity
function test_deploy_revertsWhenPauserEqualsAgent() public;
```

### test_deploy_seedDepositAmount_isOneThousandUsdc

SEED_DEPOSIT_AMOUNT constant equals 1,000 USDC (1_000_000_000 wei).
This is a pure unit check — no protocol interaction required.
The fork-level post-conditions are in DeploySeedDeposit.t.sol.


```solidity
function test_deploy_seedDepositAmount_isOneThousandUsdc() public view;
```

### test_deploy_envDriven_runInProcessSucceeds


```solidity
function test_deploy_envDriven_runInProcessSucceeds() public;
```

### _deployBasketVault

Deploy a representative basket-family vault (uses the TickMath link)
with no real swap router; totalAssets() with an empty basket returns
the vault's USDC balance and never touches TickMath, so it is a
non-reverting in-range probe.


```solidity
function _deployBasketVault() internal returns (BasketVault);
```

### test_tickMathLink_codehashMatchesAudited_andTotalAssetsInRange

The linked TickMath library has non-empty code and a runtime
codehash equal to the audited artifact, and the basket vault's
totalAssets() is non-reverting and in range. This is the positive
arm of the deploy-time assertion.


```solidity
function test_tickMathLink_codehashMatchesAudited_andTotalAssetsInRange() public;
```

### test_tickMathLink_deployAssertsCanonicalLibrary

The Deploy.s.sol deploy path asserts TickMath canonicality: a
successful in-process deploy implies the linked library's codehash
equals the audited constant (the assertion runs inside _doDeploy).


```solidity
function test_tickMathLink_deployAssertsCanonicalLibrary() public;
```

### test_tickMathLink_wrongOrZeroAddressFailsCodehashCheck

A deliberately wrong (and a zero) linked-library address fails the
same codehash check the deploy assertion enforces. Proves the
assertion is not vacuous — a mislinked library does not pass.


```solidity
function test_tickMathLink_wrongOrZeroAddressFailsCodehashCheck() public;
```

### test_tickMathLink_deployAssertionRevertsOnMislink

The actual DeployDemoExtraVaults TickMath link-integrity assertion
reverts when a vault links a zero (no-code) or wrong (non-TickMath)
library — proving the deploy assertion fails closed on mislink.


```solidity
function test_tickMathLink_deployAssertionRevertsOnMislink() public;
```

