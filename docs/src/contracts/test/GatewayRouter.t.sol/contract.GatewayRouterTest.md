# GatewayRouterTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e7a2933e057a3f91470ea3808b683595abe0b3d0/contracts/test/GatewayRouter.t.sol)

**Inherits:**
Test

**Title:**
GatewayRouterTest

Tests for gateway.depositTo routing through the PortfolioRouter.
Covers: AC1 (router deposit), AC2 (policy restriction), AC3 (invalid
destination), AC4 (AgentDepositRouted event), AC5 (single-vault path
unaffected).


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


### MAX_PER_PAYMENT

```solidity
uint256 internal constant MAX_PER_PAYMENT = 1_000 * ONE_USDC
```


### MAX_PER_WINDOW

```solidity
uint256 internal constant MAX_PER_WINDOW = 5_000 * ONE_USDC
```


## State Variables
### usdc

```solidity
TestERC20 internal usdc
```


### vault

```solidity
MockVault internal vault
```


### registry

```solidity
VaultRegistry internal registry
```


### vaultA

```solidity
RouterMockVault internal vaultA
```


### vaultB

```solidity
RouterMockVault internal vaultB
```


### router

```solidity
PortfolioRouter internal router
```


### gateway

```solidity
RobotMoneyGateway internal gateway
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


### otherAgent

```solidity
address internal otherAgent = makeAddr("otherAgent")
```


### depositor

```solidity
address internal depositor = makeAddr("depositor")
```


### shareReceiver

```solidity
address internal shareReceiver = makeAddr("shareReceiver")
```


### stranger

```solidity
address internal stranger = makeAddr("stranger")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _policyWithRouter


```solidity
function _policyWithRouter() internal view returns (IGateway.AgentPolicy memory);
```

### _policyWithVaultOnly


```solidity
function _policyWithVaultOnly() internal view returns (IGateway.AgentPolicy memory);
```

### _policyOpenDestinations


```solidity
function _policyOpenDestinations() internal view returns (IGateway.AgentPolicy memory);
```

### _authorize


```solidity
function _authorize(address who, IGateway.AgentPolicy memory p) internal;
```

### _fundAndApprove


```solidity
function _fundAndApprove(address who, uint256 amt) internal;
```

### test_gatewayRouter_constructor_wiresRouter

Verify router is wired into the gateway.


```solidity
function test_gatewayRouter_constructor_wiresRouter() public view;
```

### test_gatewayRouter_constructor_noRouter_returnsZero

A gateway deployed without a router address returns zero.


```solidity
function test_gatewayRouter_constructor_noRouter_returnsZero() public;
```

### test_depositTo_router_happyPath_proportionalReceipts

AC1: Agent with router-allowed policy calls depositTo(router) and
receives proportional vault receipts split across vaultA and vaultB.


```solidity
function test_depositTo_router_happyPath_proportionalReceipts() public;
```

### test_depositTo_router_slippageReverts

AC1: slippage protection: when minSharesPerLeg is set and the vault
returns fewer shares than the minimum, the whole call reverts.


```solidity
function test_depositTo_router_slippageReverts() public;
```

### test_depositTo_router_revertsWhenNotInAllowedDestinations

AC2: Agent whose allowedDestinations contains only the vault cannot
call depositTo with destination=router.


```solidity
function test_depositTo_router_revertsWhenNotInAllowedDestinations() public;
```

### test_depositTo_openDestinations_allowsVaultAndRouter

AC2: An agent with an open allowedDestinations list (empty array) can
route to either the pinned vault or the router.


```solidity
function test_depositTo_openDestinations_allowsVaultAndRouter() public;
```

### test_depositTo_revertsOnArbitraryDestination

AC3: Destination that is neither a registered vault nor the router
reverts with InvalidDestination.


```solidity
function test_depositTo_revertsOnArbitraryDestination() public;
```

### test_depositTo_revertsWhenRouterNotConfigured

AC3: When router is address(0) (no router configured), attempting to
call depositTo with any destination that is not the pinned vault reverts.


```solidity
function test_depositTo_revertsWhenRouterNotConfigured() public;
```

### _findRoutedEvent

Helper: search recorded logs for AgentDepositRouted and return the log
index if found, or type(uint256).max if not found.


```solidity
function _findRoutedEvent(Vm.Log[] memory logs) internal view returns (uint256);
```

### test_depositTo_router_emitsAgentDepositRoutedEvent

AC4: AgentDepositRouted event includes router address and per-leg share
amounts when routing through the router.


```solidity
function test_depositTo_router_emitsAgentDepositRoutedEvent() public;
```

### _assertRoutedEventData

Decode and assert non-indexed fields of an AgentDepositRouted log.


```solidity
function _assertRoutedEventData(bytes memory data, uint256 expectedAmount) internal view;
```

### test_deposit_singleVault_unaffectedByRouter

AC5: The original `deposit()` call to the pinned vault still works
correctly when a router is configured.


```solidity
function test_deposit_singleVault_unaffectedByRouter() public;
```

### test_depositTo_vaultDestination_routesToPinnedVault

AC5: depositTo with destination=vault routes correctly to the pinned
vault and emits AgentDeposit (not AgentDepositRouted).


```solidity
function test_depositTo_vaultDestination_routesToPinnedVault() public;
```

### test_depositTo_revertsOnZeroAmount

depositTo enforces zero-amount check.


```solidity
function test_depositTo_revertsOnZeroAmount() public;
```

### test_depositTo_revertsOnDeadlineTooFar

depositTo enforces deadline too far.


```solidity
function test_depositTo_revertsOnDeadlineTooFar() public;
```

### test_depositTo_revertsOnExpiredPolicy

depositTo enforces expired policy.


```solidity
function test_depositTo_revertsOnExpiredPolicy() public;
```

### test_depositTo_revertsWhenPaused

depositTo enforces the paused check.


```solidity
function test_depositTo_revertsWhenPaused() public;
```

### test_depositTo_revertsOnPerPaymentCapExceeded

depositTo enforces per-payment cap.


```solidity
function test_depositTo_revertsOnPerPaymentCapExceeded() public;
```

### test_depositTo_revertsOnExpiredDeadline

depositTo enforces deadline bounds.


```solidity
function test_depositTo_revertsOnExpiredDeadline() public;
```

### test_depositTo_revertsOnReplay

depositTo enforces idempotency.


```solidity
function test_depositTo_revertsOnReplay() public;
```

### test_depositTo_revertsOnWindowCapExceeded

depositTo enforces window cap.


```solidity
function test_depositTo_revertsOnWindowCapExceeded() public;
```

### test_depositTo_revertsForUnauthorizedCaller

depositTo requires AGENT_ROLE.


```solidity
function test_depositTo_revertsForUnauthorizedCaller() public;
```

### test_depositTo_routerPath_revertsOnUsdcCustodyInvariant

`depositTo` router path: post-call USDC custody invariant — a router
that under-pulls USDC leaves the gateway holding leftover stablecoin.


```solidity
function test_depositTo_routerPath_revertsOnUsdcCustodyInvariant() public;
```

### test_depositTo_revertsOnFeeOnTransferToken

`depositTo` detects fee-on-transfer tokens just like `deposit`.


```solidity
function test_depositTo_revertsOnFeeOnTransferToken() public;
```

### test_depositTo_vaultPath_revertsOnPreCallShareCustody

`depositTo` vault path: pre-call share custody invariant — gateway must
hold zero shares of the destination vault before the call.


```solidity
function test_depositTo_vaultPath_revertsOnPreCallShareCustody() public;
```

### test_depositTo_vaultPath_revertsOnPostCallShareCustody

`depositTo` vault path: post-call share custody invariant —
a vault that leaks shares back to the gateway trips the invariant.


```solidity
function test_depositTo_vaultPath_revertsOnPostCallShareCustody() public;
```

### test_depositTo_vaultPath_revertsOnPostCallUsdcCustody

`depositTo` vault path: post-call USDC custody invariant — a vault that
under-pulls USDC leaves the gateway holding leftover stablecoin.


```solidity
function test_depositTo_vaultPath_revertsOnPostCallUsdcCustody() public;
```

