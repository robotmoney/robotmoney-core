# MockVaultForRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/1421cc6201de54f6b9e3c222f9419f45c65b6f43/contracts/test/DeployPortfolioRouter.t.sol)

Minimal ERC-4626-shaped mock vault for router weight tests.
Only implements the subset required by PortfolioRouter.setWeights
(which calls registry.getVault to validate, not the vault itself).


