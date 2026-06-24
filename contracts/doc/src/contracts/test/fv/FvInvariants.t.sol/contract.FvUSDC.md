# FvUSDC
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/895f74f9a312639869e61e1d4ba3dfce78950c03/contracts/test/fv/FvInvariants.t.sol)

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

