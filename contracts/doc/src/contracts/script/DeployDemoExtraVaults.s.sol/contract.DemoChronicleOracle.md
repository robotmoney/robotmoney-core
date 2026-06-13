# DemoChronicleOracle
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/eddfc6a75fd5558f18f4c48ae13aa1c3278c17e6/contracts/script/DeployDemoExtraVaults.s.sol)

**Inherits:**
[IChronicleOracle](/contracts/interfaces/IChronicleOracle.sol/interface.IChronicleOracle.md)

Minimal Chronicle oracle stub for the RWA vault devnet demo.
Always returns a fresh price (current block.timestamp) so the
staleness check in RwaVault._checkOracleFreshness() never reverts
during demo deploys. The price is set to 5000 USD/deSPXA (5000e18)
as a plausible S&P 500 NAV reference. Demo-only; never deployed on mainnet.


## Constants
### DEMO_PRICE
Latest price in 18-decimal WAD format (1e18 = 1 USD).
Initialised to 5000 USD/deSPXA — a plausible S&P 500 NAV.


```solidity
uint256 public constant DEMO_PRICE = 5_000e18
```


## Functions
### latestAnswer

Latest price returned by this stub oracle.


```solidity
function latestAnswer() external pure returns (uint256);
```

### latestTimestamp

Returns `block.timestamp` so the staleness check always passes.
Demo-only; a real Chronicle feed updates asynchronously.


```solidity
function latestTimestamp() external view returns (uint256);
```

