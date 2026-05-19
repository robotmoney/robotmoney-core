# MockUsdc
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/cf6bd8ce521d7632792ea4ac955c7bf3ebf05be4/contracts/test/RouterGovernance.t.sol)

**Inherits:**
ERC20

Minimal ERC-20 USDC mock (6 decimals) for the router.


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

