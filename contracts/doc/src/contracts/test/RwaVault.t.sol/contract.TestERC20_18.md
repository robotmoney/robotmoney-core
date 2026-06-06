# TestERC20_18
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/9e808f2f7800c85e3ff24c369198d3b25293db1f/contracts/test/RwaVault.t.sol)

**Inherits:**
ERC20

18-decimal ERC-20 test token. Mirrors real deSPXA decimals.
deSPXA (and most Centrifuge RWA tokens) use 18 decimals on Base.


## Functions
### constructor


```solidity
constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_);
```

### decimals


```solidity
function decimals() public pure override returns (uint8);
```

### mint


```solidity
function mint(address to, uint256 amount) external;
```

### burn


```solidity
function burn(address from, uint256 amount) external;
```

