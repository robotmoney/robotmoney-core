# DeployDemoExtraVaultsTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/829e61766b365e1704d8f027d8ca3d18f7ce4b26/contracts/test/DeployDemoExtraVaults.t.sol)

**Inherits:**
Test

Integration test for the demo seed path: after `DeployDemoExtraVaults`
runs, rmPROTO (issue #559), rmAGENT (issue #560), and rmRWA (issue #621)
are all router-eligible, the router carries a four-vault default weight
vector (primary 8500 bps + rmRWA/rmPROTO/rmAGENT at 500 bps each), and
a routed deposit reaches all four vaults.
ADR-0002; issues #559, #560, #621. Also: deSPXA RWA vault is registered
Active and router-eligible at 500 bps (ADR-0006 §1 amended 2026-06-05).


## State Variables
### script

```solidity
DeployDemoExtraVaults internal script
```


### usdc

```solidity
TestERC20 internal usdc
```


### registry

```solidity
VaultRegistry internal registry
```


### router

```solidity
PortfolioRouter internal router
```


### primaryVault

```solidity
RobotMoneyVault internal primaryVault
```


### admin

```solidity
address internal admin = address(this)
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _runScript


```solidity
function _runScript() internal returns (DeployDemoExtraVaults.Deployed memory d);
```

### test_demo_seed_populates_defaultWeights

After the demo seed runs, rmPROTO, rmAGENT, and rmRWA are all
router-eligible and the router default vector is a four-leg
8500/500/500/500 bps split (primary + rmRWA + rmPROTO + rmAGENT).
Registry router-eligible count = 4. Issue #621.


```solidity
function test_demo_seed_populates_defaultWeights() public;
```

### test_rmAGENT_is_router_eligible

rmAGENT is router-eligible after the demo seed (issue #560 AC1).


```solidity
function test_rmAGENT_is_router_eligible() public;
```

### test_rmAGENT_holds_three_token_basket

rmAGENT holds exactly BNKR/JUNO/RM — the three-token
real-asset basket (issue #560 AC1).


```solidity
function test_rmAGENT_holds_three_token_basket() public;
```

### test_rmAGENT_in_defaultWeights

rmAGENT appears in defaultWeights (issue #560 AC2).


```solidity
function test_rmAGENT_in_defaultWeights() public;
```

### test_rmAGENT_basket_tokens_have_correct_venues

The three basket tokens use the correct per-asset venues:
BNKR → V3, JUNO → V4, RM → Aerodrome (issue #560 AC1).


```solidity
function test_rmAGENT_basket_tokens_have_correct_venues() public;
```

### test_rmAGENT_deposit_increases_totalAssets_via_multi_dex

A direct deposit to rmAGENT after the demo seed increases
totalAssets via multi-DEX swaps across V3/V4/Aerodrome stubs
(issue #560 AC2 — routed deposit increases totalAssets).
The demo stub routers mint output tokens 1:1, so totalAssets
after deposit equals the deposited USDC (minus any USDC that
remains idle before the TWAP NAV read — here zero because all
USDC is swapped into basket tokens). The TWAP price from the
demo pool's MockPool-style stub returns a 1:1 price (tick=0),
so the share conversion is exact.


```solidity
function test_rmAGENT_deposit_increases_totalAssets_via_multi_dex() public;
```

### _assertBnkrAsset


```solidity
function _assertBnkrAsset(AgentTokenVault vault, DeployDemoExtraVaults.Deployed memory d)
    internal
    view;
```

### _assertJunoAsset


```solidity
function _assertJunoAsset(AgentTokenVault vault, DeployDemoExtraVaults.Deployed memory d)
    internal
    view;
```

### _assertRmAsset


```solidity
function _assertRmAsset(AgentTokenVault vault, DeployDemoExtraVaults.Deployed memory d)
    internal
    view;
```

### test_rmPROTO_is_router_eligible

AC#1 (issue #559): rmPROTO is router-eligible after the demo seed.


```solidity
function test_rmPROTO_is_router_eligible() public;
```

### test_rmPROTO_in_defaultWeights

AC#2 (issue #559): rmPROTO appears in the router defaultWeights vector.


```solidity
function test_rmPROTO_in_defaultWeights() public;
```

### test_rmPROTO_router_deposit_succeeds

AC#3 (issue #559): a router deposit succeeds end-to-end with
rmPROTO eligible — the DemoV3SwapRouter stub handles the V3 path.


```solidity
function test_rmPROTO_router_deposit_succeeds() public;
```

### test_rwaVault_is_Active_after_demo_seed

The deSPXA RWA vault (PRD §11.4) is registered Active after the
demo seed — no Paused placeholder remains (issue #562 AC1).


```solidity
function test_rwaVault_is_Active_after_demo_seed() public;
```

### test_rwaVault_is_router_eligible

The deSPXA RWA vault IS router-eligible at 500 bps per issue #621
(ADR-0006 §1 amended 2026-06-05 — product owner confirmed).


```solidity
function test_rwaVault_is_router_eligible() public;
```

### test_rwaVault_in_defaultWeights

The rmRWA vault IS included in the router defaultWeights vector at
500 bps (issue #621, ADR-0006 §1 amended 2026-06-05).


```solidity
function test_rwaVault_in_defaultWeights() public;
```

### test_four_vaults_all_active_with_nonzero_totalAssets

The full four-vault PRD §11 end state: after the demo seed, all
four vaults are registered Active, all four are router-eligible
(issue #621 — rmRWA is now router-eligible at 500 bps per ADR-0006
§1 amended 2026-06-05), and a single routed deposit via the default
8500/500/500/500 bps vector funds all four vaults. Every vault
reports non-zero `totalAssets`. This is the forge-layer mirror of
the smoke-test four-vault TVL invariant the dapp tiles depend on
(issues #592, #621).


```solidity
function test_four_vaults_all_active_with_nonzero_totalAssets() public;
```

### test_rwaVault_multi_deposit_does_not_overflow

Multiple sequential router deposits + direct RWA deposits must
not overflow uint256 in _convertToShares. Regression for the
DemoAerodromeRouter 1:1 swap bug: the old router minted deSPXA
1:1 with USDC atoms, but the Chronicle oracle prices deSPXA at
5000 USD each, so each deposit left totalAssets ~0 while
totalSupply grew exponentially. This caused MathOverflowedMulDiv
after ~7 deposits — the smoke-test devnet seeds 4 depositors x 2
paths (8 deposits into RWA), reliably hitting it.


```solidity
function test_rwaVault_multi_deposit_does_not_overflow() public;
```

### test_rwaVault_holds_deSPXA_asset_Aerodrome_venue

The rmRWA vault holds exactly one basket asset (deSPXA stub),
wired with Venue.Aerodrome and a ChronicleOracleAdapter. Issue #562 AC1.


```solidity
function test_rwaVault_holds_deSPXA_asset_Aerodrome_venue() public;
```

