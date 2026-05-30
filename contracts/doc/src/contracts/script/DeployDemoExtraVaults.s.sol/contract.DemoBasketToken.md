# DemoBasketToken
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/1e53296ac7c3def2e7f1ed72fa72a5873c593969/contracts/script/DeployDemoExtraVaults.s.sol)

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

