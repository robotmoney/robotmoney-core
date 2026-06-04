# DeployDemoExtraVaultsTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/23bb26853ebab25914ee89c1967707490ad65007/contracts/test/DeployDemoExtraVaults.t.sol)

**Inherits:**
Test

Integration test for the demo seed path: after `DeployDemoExtraVaults`
runs, rmAGENT is router-eligible with BNKR/JUNO/ROBOTMONEY basket,
the router carries a two-vault default weight vector (primary + rmAGENT),
and a routed deposit reaches both vaults. ADR-0002; issue #560.


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

