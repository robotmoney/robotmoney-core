# FvUSDC
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/f6c8b468bb5448ecb94913113b3bd7ba124894db/contracts/test/fv/FvInvariants.t.sol)

**Inherits:**
ERC20

Minimal USDC for the router-deposit FV harness.


## Functions
### constructor


```solidity
constructor() ERC20("FV USDC", "fvUSDC");
```

### decimals


```solidity
function decimals() public pure override returns (uint8);
```

### mint


```solidity
function mint(address to, uint256 amount) external;
```

