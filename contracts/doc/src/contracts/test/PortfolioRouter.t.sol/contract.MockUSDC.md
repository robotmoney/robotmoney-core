# MockUSDC
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/423bf4aec8aba7d6c7cd55373bad56163e077782/contracts/test/PortfolioRouter.t.sol)

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

