# DeployDemoUniswapV3Stubs
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/cfe094f56f7148155d6999efbd87ac66367ad208/contracts/script/DeployDemoUniswapV3Stubs.s.sol)

**Inherits:**
Script

**Title:**
DeployDemoUniswapV3Stubs

Demo-only deploy script that creates four `UniswapV3PoolSlot0Stub`
instances on the smoke-test devnet, one per landing-page price-strip
pair:
- ETH/USD   (sqrtPriceX96 ≈ $2 500, token0=WETH-18, token1=USDC-6)
- wETH/USDC (same sqrtPriceX96, separate address for dex-pools.json
completeness)
- cbBTC/USDC (sqrtPriceX96 ≈ $60 000, token0=cbBTC-8, token1=USDC-6)
- wSOL/USDC  (sqrtPriceX96 ≈ $150,    token0=wSOL-9,  token1=USDC-6)
Uses the Arachnid deterministic-deployment-proxy (address
0x4e59b44847b379578588920cA78FbF26c0B4956C, pre-installed in the
devnet genesis via `genesis_alloc.rs`) with fixed salts so the
deployed addresses are **deterministic** and pre-committed in
`config/dex-pools.json::devnet.pools` and
`testing/ethereum-testnet/config/expected-prices.json`.
Required env vars: none (all seeds are hardcoded).
Optional env vars:
DEPLOYMENT_OUT — output JSON path
(default: "deployments/demo-uniswap-v3-stubs-<chain_id>.json")
NEVER use on a real chain.  Demo/devnet only.


## Constants
### ARACHNID_FACTORY
Arachnid deterministic-deployment-proxy.
Pre-installed at genesis by genesis_alloc::ARACHNID_FACTORY_ADDR.


```solidity
address internal constant ARACHNID_FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C
```


### SQRT_PRICE_ETH_USD

```solidity
uint160 internal constant SQRT_PRICE_ETH_USD = 3_961_408_125_713_217_069_514_752
```


### SQRT_PRICE_CBBTC_USDC

```solidity
uint160 internal constant SQRT_PRICE_CBBTC_USDC = 1_940_685_714_182_491_821_455_964_110_848
```


### SQRT_PRICE_WSOL_USDC

```solidity
uint160 internal constant SQRT_PRICE_WSOL_USDC = 30_684_935_396_836_053_642_039_525_376
```


### SALT_ETH_USD

```solidity
bytes32 internal constant SALT_ETH_USD =
    0x0000000000000000000000000000000000000000000000000000000000000001
```


### SALT_WETH_USDC

```solidity
bytes32 internal constant SALT_WETH_USDC =
    0x0000000000000000000000000000000000000000000000000000000000000002
```


### SALT_CBBTC_USDC

```solidity
bytes32 internal constant SALT_CBBTC_USDC =
    0x0000000000000000000000000000000000000000000000000000000000000003
```


### SALT_WSOL_USDC

```solidity
bytes32 internal constant SALT_WSOL_USDC =
    0x0000000000000000000000000000000000000000000000000000000000000004
```


## Functions
### run

Forge broadcast entrypoint.


```solidity
function run() external returns (Deployed memory d);
```

### _doDeploy

Deploy all four stubs via the Arachnid CREATE2 factory.


```solidity
function _doDeploy() internal returns (Deployed memory d);
```

### _deployViaFactory

Deploy `UniswapV3PoolSlot0Stub(sqrtPriceX96)` via the Arachnid
factory at `ARACHNID_FACTORY` with the given `salt`.
Calldata layout: `salt (32 bytes) ++ initcode`.
Returns the deterministic CREATE2 address.


```solidity
function _deployViaFactory(bytes32 salt, uint160 sqrtPriceX96)
    internal
    returns (address deployed);
```

### _logResult


```solidity
function _logResult(Deployed memory d) internal pure;
```

### _writeDeploymentJson


```solidity
function _writeDeploymentJson(Deployed memory d) internal;
```

## Structs
### Deployed
Result struct returned to in-process callers and written to JSON.


```solidity
struct Deployed {
    address ethUsd;
    address wethUsdc;
    address cbbtcUsdc;
    address wsolUsdc;
}
```

