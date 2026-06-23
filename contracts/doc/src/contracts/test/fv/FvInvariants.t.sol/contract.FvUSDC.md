# FvUSDC
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/c9e141ffcd1c066f8ea8438f58e57b245c4556f8/contracts/test/fv/FvInvariants.t.sol)

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

