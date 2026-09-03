# UniswapV4RouterEligibilityIntegrationTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/9d44925e7f2d8ec82bb94d1c746bf6b613ca9d11/contracts/test/UniswapV4RouterEligibilityIntegration.t.sol)

**Inherits:**
Test

Proves `UniswapV4AssetPositionAdapter` is router-eligible against the
REAL `Vault` + `VaultRegistry` + `PortfolioRouter` stack, not just the
mock-vault mechanics harness (#1186).


## Constants
### FEE

```solidity
uint24 internal constant FEE = 3000
```


### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


## State Variables
### usdc

```solidity
TestERC20 internal usdc
```


### token

```solidity
UniV4PositionMockToken18 internal token
```


### venue

```solidity
UniV4PositionMockVenue internal venue
```


### pool

```solidity
UniV4PositionMockPool internal pool
```


### vault

```solidity
Vault internal vault
```


### registry

```solidity
VaultRegistry internal registry
```


### router

```solidity
PortfolioRouter internal router
```


### adapter

```solidity
UniswapV4AssetPositionAdapter internal adapter
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


### depositor

```solidity
address internal depositor = makeAddr("depositor")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_setWeights_revertsBeforeRouterEligible

The registry gate is load-bearing: an unregistered-eligible
vault cannot enter the router's weight vector at all.


```solidity
function test_setWeights_revertsBeforeRouterEligible() public;
```

### test_deposit_throughRouter_deploysIntoV4Adapter

Once router-eligible, a real deposit routes through
PortfolioRouter -> Vault -> UniswapV4AssetPositionAdapter.deploy(),
exercising the ORA-4 TWAP-deviation guard on a genuine deploy path
(not the UniV4PositionMockVault stub) and minting real vault shares
to the depositor.


```solidity
function test_deposit_throughRouter_deploysIntoV4Adapter() public;
```

