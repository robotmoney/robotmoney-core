# FvUSDC
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a1b6b48f865d2de1de96090713e0f0b3ad707db7/contracts/test/fv/FvInvariants.t.sol)

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

