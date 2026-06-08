# DemoBasketToken
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/6972e43c539056c14fd6b78d1bee27347622bb81/contracts/script/DeployDemoExtraVaults.s.sol)

**Inherits:**
ERC20

Demo-only stand-in ERC20 for the basket-vault devnet seeds. The
devnet has no real liquidity for the PRD §11.2 protocol basket
(wETH, cbBTC, wSOL) or the §11.3 agent shortlist; this fills both
baskets so `BasketVault.addAsset` can wire entries and the dapp can
enumerate them. Never deployed on mainnet (this script is demo-only).


## Functions
### constructor


```solidity
constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_);
```

### mint

Permissionless mint used by demo router stubs to simulate swap output.
Demo-only; never deployed on mainnet.


```solidity
function mint(address to, uint256 amount) external;
```

