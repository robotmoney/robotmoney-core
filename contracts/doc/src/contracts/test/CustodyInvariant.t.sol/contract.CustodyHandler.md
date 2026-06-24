# CustodyHandler
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/c509d0100d3df416d312069339974e56f8ecce75/contracts/test/CustodyInvariant.t.sol)

**Inherits:**
Test

Bounded handler exercising the vault's custody surface from many actors.


## Constants
### vault

```solidity
RobotMoneyVault public immutable vault
```


### usdc

```solidity
InvUSDC public immutable usdc
```


### foreign

```solidity
InvForeignToken public immutable foreign
```


### admin

```solidity
address public immutable admin
```


### ONE_USDC

```solidity
uint256 public constant ONE_USDC = 1e6
```


### MAX_DEPOSIT

```solidity
uint256 public constant MAX_DEPOSIT = 1_000_000 * 1e6
```


## State Variables
### actors

```solidity
address[] public actors
```


### currentActor

```solidity
address internal currentActor
```


## Functions
### useActor


```solidity
modifier useActor(uint256 seed) ;
```

### constructor


```solidity
constructor(RobotMoneyVault vault_, InvUSDC usdc_, InvForeignToken foreign_, address admin_) ;
```

### deposit


```solidity
function deposit(uint256 seed, uint256 amount) external useActor(seed);
```

### withdraw


```solidity
function withdraw(uint256 seed, uint256 shares) external useActor(seed);
```

### donateUsdc

Protocol-asset donation: credit USDC straight to the vault (idle NAV).


```solidity
function donateUsdc(uint256 amount) external;
```

### sweepForeign

A foreign token lands on the vault, then anyone sweeps it.


```solidity
function sweepForeign(uint256 amount) external;
```

### actorCount


```solidity
function actorCount() external view returns (uint256);
```

### actorAt


```solidity
function actorAt(uint256 i) external view returns (address);
```

### handler_rebalance

Equal-weight rebalance across the two active adapters, then a
post-condition check that the vault routed every idle USDC back
out (router/idle custody == 0 when adapters can absorb it).

Warps past `minRebalanceInterval` and pranks `admin` (rebalance is
ADMIN_ROLE/KEEPER_ROLE gated) so the throttle does not make every
call a no-op revert. `setMaxRebalanceBpsPerCall(MAX_..._CEILING)` is
done once in setUp so a single call can move a meaningful slice.


```solidity
function handler_rebalance(uint256 seed) external;
```

### handler_removeAndReabsorb

Graceful adapter removal with reabsorb-to-idle: drain an adapter
(assets flow back to idle, NAV preserved), donate USDC so NAV
strictly rises, deactivate the now-empty adapter, then assert the
removed adapter holds zero balance.

Uses EMERGENCY `emergencyWithdrawAdapter` (graceful reabsorb to idle)
+ ADMIN `removeAdapter` — the production analogue of "remove a basket
asset and re-absorb it". Never calls `forceRemoveAdapter` here so the
NAV floor below is not broken by an intentional loss.


```solidity
function handler_removeAndReabsorb(uint256 seed) external;
```

### handler_routerZeroBalance

Drive the vault to a router/adapter-zero-balance state by draining
every active adapter to idle, then assert deposit / redeem /
totalAssets accounting still holds with no adapter custody out.

`emergencyWithdrawAdapter` reabsorbs to idle (no loss); after it the
summed adapter custody is zero and totalAssets equals the vault's own
idle USDC balance.


```solidity
function handler_routerZeroBalance(uint256) external;
```

### _hasActiveAdapter

True if at least one registered adapter is still active.


```solidity
function _hasActiveAdapter() internal view returns (bool);
```

### _activeAdapterTally

Count of currently active adapters.


```solidity
function _activeAdapterTally() internal view returns (uint256 tally);
```

