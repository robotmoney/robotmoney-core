# FeeOnTransferUSDC
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/49fdc0c3c31bec47921788de2ceaba90e0447685/contracts/test/RobotMoneyGateway.t.sol)

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

