# CustodyHandler
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/9f4d89b73f3bc3e6fe6c5dd86696328d5a028502/contracts/test/CustodyInvariant.t.sol)

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
constructor(RobotMoneyVault vault_, InvUSDC usdc_, InvForeignToken foreign_) ;
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

