# MockVaultForRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/31a8dcee8651b68de6fb5481acf7c895437acde1/contracts/test/DeployPortfolioRouter.t.sol)

Minimal ERC-4626-shaped mock vault for router weight tests.
Only implements the subset required by PortfolioRouter.setWeights
(which calls registry.getVault to validate, not the vault itself).


