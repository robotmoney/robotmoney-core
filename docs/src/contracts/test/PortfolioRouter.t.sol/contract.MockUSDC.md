# MockUSDC
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/60eddc5d5c695082281a4a0584160a58dfe2e50e/contracts/test/PortfolioRouter.t.sol)

**Inherits:**
ERC20

Minimal ERC-20 USDC mock (6 decimals).


## Functions
### constructor


```solidity
constructor() ERC20("USD Coin", "USDC");
```

### decimals


```solidity
function decimals() public pure override returns (uint8);
```

### mint


```solidity
function mint(address to, uint256 amount) external;
```

