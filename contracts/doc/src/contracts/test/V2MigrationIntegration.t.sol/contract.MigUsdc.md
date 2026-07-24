# MigUsdc
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/227c9c7cc512f0fdf37c470efb82ef9cefda1bf9/contracts/test/V2MigrationIntegration.t.sol)

**Inherits:**
ERC20

Minimal ERC-20 USDC mock (6 decimals) with an open mint for funding.


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

