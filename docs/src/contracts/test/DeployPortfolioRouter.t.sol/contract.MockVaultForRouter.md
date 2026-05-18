# MockVaultForRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/49fdc0c3c31bec47921788de2ceaba90e0447685/contracts/test/DeployPortfolioRouter.t.sol)

Minimal ERC-4626-shaped mock vault for router weight tests.
Only implements the subset required by PortfolioRouter.setWeights
(which calls registry.getVault to validate, not the vault itself).


