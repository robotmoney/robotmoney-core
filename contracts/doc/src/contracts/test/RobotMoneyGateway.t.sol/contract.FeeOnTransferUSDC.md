# FeeOnTransferUSDC
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/0d868fe02e5cf19ce075213817ca84416ca13c09/contracts/test/RobotMoneyGateway.t.sol)

**Inherits:**
[TestERC20](/contracts/test/helpers/TestERC20.sol/contract.TestERC20.md)

Minimal fee-on-transfer token used to assert the gateway's
balance-delta defense (`FeeOnTransferDetected`). Charges 1% on transfer.


## Functions
### transfer


```solidity
function transfer(address to, uint256 amount) public override returns (bool);
```

### transferFrom


```solidity
function transferFrom(address from, address to, uint256 amount) public override returns (bool);
```

