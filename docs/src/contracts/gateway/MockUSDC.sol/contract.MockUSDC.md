# MockUSDC
[Git Source](https://github.com/lucky-tensor/robotmoney-skills/blob/b462a72b60a914ceeff6cdf3ad7148bfb0361abb/contracts/gateway/MockUSDC.sol)

**Inherits:**
ERC20

**Title:**
MockUSDC

6-decimal ERC20 used as a USDC stand-in by the gateway test suite.

Public, permissionless `mint` — this is a TEST FIXTURE only. Do not deploy
to mainnet under any circumstance.


## Functions
### constructor


```solidity
constructor() ERC20("Mock USDC", "mUSDC");
```

### decimals

USDC uses 6 decimals; mirror that for parity with the real token.


```solidity
function decimals() public pure override returns (uint8);
```

### mint

Mint test tokens to any address. No access control by design.


```solidity
function mint(address to, uint256 amount) external;
```

### burn

Burn test tokens from any address. No access control by design.


```solidity
function burn(address from, uint256 amount) external;
```

