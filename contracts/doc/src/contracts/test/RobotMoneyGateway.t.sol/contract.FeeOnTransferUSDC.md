# FeeOnTransferUSDC
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/f6c8b468bb5448ecb94913113b3bd7ba124894db/contracts/test/RobotMoneyGateway.t.sol)

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

