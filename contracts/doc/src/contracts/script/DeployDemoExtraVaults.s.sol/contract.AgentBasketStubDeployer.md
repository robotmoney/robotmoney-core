# AgentBasketStubDeployer
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/f39b06a56217d7376251b1403dc50b5a82486455/contracts/script/DeployDemoExtraVaults.s.sol)

One-shot batch deployer for the AgentTokenVault devnet basket
stand-ins (PRD §11.3 — BNKR/JUNO/ROBOTMONEY, three real-asset demo tokens)
AND the per-asset swap router stubs + adapters. Its constructor performs
all 11 sub-CREATEs in a single broadcaster transaction:
- 3 × DemoBasketToken (BNKR, JUNO, ROBOTMONEY)
- 3 × DemoUsdcPool
- DemoV3SwapRouter (BNKR built-in path)
- DemoV4SwapRouter (JUNO V4 path)
- DemoAerodromeRouter (ROBOTMONEY Aerodrome path)
- UniswapV4SwapAdapter (JUNO)
- AerodromeSwapAdapter (ROBOTMONEY)
Collapsed into one broadcaster CREATE to minimize on-chain tx count
and keep smoke-test devnet boot inside the 30m CI budget. Demo-only.


## State Variables
### tokens

```solidity
DemoBasketToken[3] public tokens
```


### pools

```solidity
DemoUsdcPool[3] public pools
```


### v3Router

```solidity
address public v3Router
```


### v4Adapter

```solidity
address public v4Adapter
```


### aeroAdapter

```solidity
address public aeroAdapter
```


### AGENT_SYMBOLS_3

```solidity
string[3] internal AGENT_SYMBOLS_3 = ["BNKR", "JUNO", "ROBOTMONEY"]
```


## Functions
### constructor


```solidity
constructor(address usdc) ;
```

