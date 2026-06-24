# ReentrantVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/5a164c31574dc88f5c31048af5cc49fb7a941a1f/contracts/test/RobotMoneyGateway.t.sol)

**Inherits:**
[MockVault](/contracts/gateway/MockVault.sol/contract.MockVault.md)

Vault that attempts to re-enter `gateway.deposit()` during its own
`deposit()` call, simulating a malicious/compromised vault reentrant
callback. Expects the `nonReentrant` guard to block the second entry.


## State Variables
### gateway

```solidity
RobotMoneyGateway public gateway
```


### attackArmed

```solidity
bool public attackArmed
```


### reentrantOrderId

```solidity
bytes32 public reentrantOrderId
```


### reentrantAmount

```solidity
uint256 public reentrantAmount
```


### reentrantDeadline

```solidity
uint64 public reentrantDeadline
```


### reentrantIdemKey

```solidity
bytes32 public reentrantIdemKey
```


## Functions
### constructor


```solidity
constructor(address asset_) MockVault(asset_);
```

### setGateway


```solidity
function setGateway(RobotMoneyGateway gw) external;
```

### armAttack


```solidity
function armAttack(bytes32 orderId, uint256 amount, uint64 deadline, bytes32 idemKey) external;
```

### deposit


```solidity
function deposit(uint256 assets, address receiver) external override returns (uint256 shares);
```

