# TestERC20
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/31a8dcee8651b68de6fb5481acf7c895437acde1/contracts/test/helpers/TestERC20.sol)

**Inherits:**
ERC20

**Title:**
TestERC20

Minimal 6-decimal ERC20 used as a USDC stand-in by forge unit tests.

Public, permissionless `mint`/`burn` — TEST FIXTURE ONLY. This contract
lives under `contracts/test/` and is never deployed by production
scripts. Production deploys bind the gateway to canonical Base USDC
via the `USDC_ADDRESS` env var (see `script/Deploy.s.sol`).


## Functions
### constructor


```solidity
constructor() ERC20("Test USDC", "tUSDC");
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

