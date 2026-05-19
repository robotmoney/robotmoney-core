# FeeOnTransferUSDC
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/cf6bd8ce521d7632792ea4ac955c7bf3ebf05be4/contracts/test/RobotMoneyGateway.t.sol)

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

