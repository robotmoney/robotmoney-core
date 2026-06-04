# DeployDemoExtraVaultsTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/39467bf9ff113c7821b3343e7468c20f3d3ee5af/contracts/test/DeployDemoExtraVaults.t.sol)

**Inherits:**
Test

Integration test for the demo seed path: after `DeployDemoExtraVaults`
runs, rmAGENT is router-eligible with BNKR/JUNO/ROBOTMONEY basket,
the router carries a two-vault default weight vector (primary + rmAGENT),
and a routed deposit reaches both vaults. ADR-0002; issue #560.
Also: deSPXA RWA vault is registered Active and NOT router-eligible
(direct-seed-only per ADR-0006; issue #562).


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

After the demo seed runs, rmAGENT is router-eligible and the
router default vector is a two-leg 50/50 split between primary and
rmAGENT. Registry router-eligible count = 2.


```solidity
function test_demo_seed_populates_defaultWeights() public;
```

### test_rmAGENT_is_router_eligible

rmAGENT is router-eligible after the demo seed (issue #560 AC1).


```solidity
function test_rmAGENT_is_router_eligible() public;
```

### test_rmAGENT_holds_three_token_basket

rmAGENT holds exactly BNKR/JUNO/ROBOTMONEY — the three-token
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
BNKR → V3, JUNO → V4, ROBOTMONEY → Aerodrome (issue #560 AC1).


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

### _assertRobotmoneyAsset


```solidity
function _assertRobotmoneyAsset(AgentTokenVault vault, DeployDemoExtraVaults.Deployed memory d)
    internal
    view;
```

### test_rwaVault_is_Active_after_demo_seed

The deSPXA RWA vault (PRD §11.4) is registered Active after the
demo seed — no Paused placeholder remains (issue #562 AC1).


```solidity
function test_rwaVault_is_Active_after_demo_seed() public;
```

### test_rwaVault_is_not_router_eligible

The deSPXA RWA vault is NOT router-eligible per ADR-0006 §1
(direct-seed-only; Chronicle oracle gates totalAssets). Issue #562 AC2.


```solidity
function test_rwaVault_is_not_router_eligible() public;
```

### test_rwaVault_not_in_defaultWeights

The rmRWA vault is NOT included in the router defaultWeights vector
(only primary + rmAGENT are in the 50/50 split). Issue #562 AC2.


```solidity
function test_rwaVault_not_in_defaultWeights() public;
```

### test_rwaVault_holds_deSPXA_asset_Aerodrome_venue

The rmRWA vault holds exactly one basket asset (deSPXA stub),
wired with Venue.Aerodrome and a ChronicleOracleAdapter. Issue #562 AC1.


```solidity
function test_rwaVault_holds_deSPXA_asset_Aerodrome_venue() public;
```

