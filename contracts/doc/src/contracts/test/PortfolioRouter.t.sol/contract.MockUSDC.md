# MockUSDC
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/715cd4b73a878654e7e004c208f153b328046fcf/contracts/test/PortfolioRouter.t.sol)

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

