# DemoRwaAerodromeRouter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3da70a180fe71635ce61a9d127b7f2d7f7b3cbf5/contracts/script/DeployDemoExtraVaults.s.sol)

Price-aware Aerodrome router stub for the RWA vault demo.
Unlike DemoAerodromeRouter (which swaps 1:1), this stub mirrors the
ChronicleOracleAdapter conversion formula so that `totalAssets` stays
in sync with `totalSupply` after every deposit. Without this, each
deposit into the RWA vault would leave near-zero USDC-denominated
assets in the vault (because the Chronicle oracle values deSPXA at
5000 USDC each, not 1:1), causing exponential share inflation that
overflows uint256 after a handful of deposits.
Conversion mirrors ChronicleOracleAdapter exactly:
USDC → RWA: amountOut = (amountIn * 1e12) * WAD / DEMO_PRICE
RWA → USDC: amountOut = amountIn * DEMO_PRICE / (WAD * 1e12)
Demo-only; never deployed on mainnet.


## Constants
### DEMO_PRICE
Must match DemoChronicleOracle.DEMO_PRICE so swaps are consistent
with the oracle NAV. 5000 USD per deSPXA in 18-decimal WAD format.


```solidity
uint256 public constant DEMO_PRICE = 5_000e18
```


### WAD

```solidity
uint256 private constant WAD = 1e18
```


### USDC

```solidity
address public immutable USDC
```


## Functions
### constructor


```solidity
constructor(address usdc_) ;
```

### swapExactTokensForTokens


```solidity
function swapExactTokensForTokens(
    uint256 amountIn,
    uint256, /* amountOutMin */
    IAerodromeRouter.Route[] calldata routes,
    address to,
    uint256 /* deadline */
) external returns (uint256[] memory amounts);
```

### defaultFactory


```solidity
function defaultFactory() external pure returns (address);
```

