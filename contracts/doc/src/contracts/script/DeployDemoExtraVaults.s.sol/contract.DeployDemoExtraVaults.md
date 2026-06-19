# DeployDemoExtraVaults
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/b26f69ebc017ed65ec1995613224744c7754ee26/contracts/script/DeployDemoExtraVaults.s.sol)

**Inherits:**
Script

**Title:**
DeployDemoExtraVaults

Demo-only deploy script that aligns the devnet vault set with the
four-vault PRD §11 catalog: Stable Yield (deployed by Deploy.s.sol),
Protocol Asset, Agent Token, and the real deSPXA RWA vault (ADR-0006).
Registers all three additions in `VaultRegistry`, seeds the basket
vaults with devnet stand-in tokens, seeds the RWA vault with the
deSPXA stub + Chronicle oracle stub, and resets the router weight
vector to a four-vault 8500/500/500/500 bps split.
Why this exists: to exercise the full PRD vault catalog end to end
(Portfolio Explorer, /v1/vaults TVL, Router Governance weights) the
demo seed deploys the same vault classes the PRD names — no generic
stand-in clones. `ProtocolAssetVault` and `AgentTokenVault` carry
devnet basket stubs; `RwaVault` (PRD §11.4) holds the deSPXA stub
+ a demo Chronicle oracle that always returns a fresh price.
Router eligibility (issues #559, #560, #621, ADR-0006 §1 as amended):
- rmPROTO (§11.2) is router-eligible (issue #559). DemoV3SwapRouter
stubs satisfy the V3 deposit path on devnet. 500 bps leg.
- rmAGENT (§11.3) is router-eligible (issue #560). Multi-DEX stubs
(V3/V4/Aerodrome) satisfy all three deposit legs on devnet. 500 bps.
- rmRWA (§11.4) is router-eligible at 500 bps (issue #621, ADR-0006
§1 amended 2026-06-05 — product owner confirmed). The Aerodrome
swap stub and demo Chronicle oracle satisfy the deposit path on devnet.
- The primary `RobotMoneyVault` (§11.1) holds 8500 bps (~85%).
- Default + voted weight vectors: 8500 / 500 / 500 / 500 bps
(primary / rmRWA / rmPROTO / rmAGENT) summing to 10 000 bps.
Required env vars:
ADMIN_ADDRESS               — receives ADMIN_ROLE on the new vaults
and must already hold ADMIN_ROLE on
VaultRegistry + PortfolioRouter
EMERGENCY_RESPONDER_ADDRESS — receives EMERGENCY_ROLE on the basket
vaults (hot key for rapid unwind);
use a distinct address from ADMIN_ADDRESS
in production for two-role key separation
REGISTRY_ADDRESS            — deployed VaultRegistry
ROUTER_ADDRESS              — deployed PortfolioRouter
PRIMARY_VAULT               — RobotMoneyVault deployed by Deploy.s.sol
(~3334 bps in the default weight vector)
USDC_ADDRESS                — ERC-20 asset every vault denominates in
Optional env vars:
SWAP_ROUTER        — Uniswap V3 SwapRouter02 address for the
basket vaults (defaults to Base mainnet)
RWA_VAULT_NAME     — registry name for the RWA vault
(default: "Robot Money RWA / Thematic")
DEPLOYMENT_OUT     — output JSON path
(default: "deployments/demo-extra-vaults-<chain_id>.json")


## Constants
### DEMO_AGENT_BNKR_FEE
Swap fee tier for BNKR (Uniswap V3, 1% pool tier — illiquid agent token).


```solidity
uint24 internal constant DEMO_AGENT_BNKR_FEE = 10_000
```


### DEMO_AGENT_JUNO_FEE
Swap fee tier for JUNO (Uniswap V4, 1% pool tier).


```solidity
uint24 internal constant DEMO_AGENT_JUNO_FEE = 10_000
```


### DEMO_AGENT_RM_FEE
Swap fee tier for RM (Aerodrome — fee param unused by adapter
but kept for interface uniformity; 1% matches the illiquid stance).


```solidity
uint24 internal constant DEMO_AGENT_RM_FEE = 10_000
```


### DEMO_PROTOCOL_SWAP_FEE
Swap fee tier for the protocol-asset basket stubs (mainnet wETH
pools commonly use 0.05%; matches the 1% default-slippage stance
on `ProtocolAssetVault` headroom).


```solidity
uint24 internal constant DEMO_PROTOCOL_SWAP_FEE = 500
```


### DEFAULT_RWA_NAME
Default human-readable name for the RWA/Thematic placeholder
(PRD §11.4). Future / not-specified vault category.


```solidity
string public constant DEFAULT_RWA_NAME = "Robot Money RWA / Thematic"
```


### DEMO_TVL_CAP
TVL cap mirrored from Deploy.s.sol (10M USDC) — demo vaults
carry the same caps as the primary so the harness can fund any
scenario without per-vault tuning.


```solidity
uint256 public constant DEMO_TVL_CAP = 10_000_000 * 1e6
```


### DEMO_PER_DEPOSIT_CAP
Per-deposit cap mirrored from Deploy.s.sol (1M USDC).


```solidity
uint256 public constant DEMO_PER_DEPOSIT_CAP = 1_000_000 * 1e6
```


### DEFAULT_SWAP_ROUTER
Base mainnet Uniswap V3 SwapRouter02 — default basket-vault swap
router when SWAP_ROUTER is unset (mirrors the basket vaults).


```solidity
address internal constant DEFAULT_SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481
```


## State Variables
### AGENT_SYMBOLS
Real four-vault demo agent-token symbols: BNKR (V3), JUNO (V4),
RM (V4/Aerodrome). Three-token basket per issue #560.


```solidity
string[3] internal AGENT_SYMBOLS = ["BNKR", "JUNO", "RM"]
```


### PROTOCOL_SYMBOLS
ProtocolAssetVault basket symbols (PRD §11.2 — wETH, cbBTC, wSOL).


```solidity
string[3] internal PROTOCOL_SYMBOLS = ["wETH", "cbBTC", "wSOL"]
```


## Functions
### run

Forge broadcast entrypoint. Deploys ProtocolAssetVault,
AgentTokenVault, the RWA placeholder; registers all three;
seeds the two basket vaults; resets the router weight vector.


```solidity
function run() external returns (Deployed memory d);
```

### runInProcess

In-process entrypoint for forge tests. Runs the same deploy +
seed body as `run()` but without `vm.startBroadcast`, so the
caller (the test contract) is the broadcaster and must already
hold ADMIN_ROLE on the registry and router. No deployment JSON
is written.


```solidity
function runInProcess(Params memory p) external returns (Deployed memory d);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`p`|`Params`|Fully-formed params (no env reads).|


### _readParams


```solidity
function _readParams() internal view returns (Params memory p);
```

### _doDeploy

Caller must hold ADMIN_ROLE on registry + router via broadcast
key. Splits the body of `run()` so the locals stay below the
stack-too-deep limit.


```solidity
function _doDeploy(Params memory p) internal returns (Deployed memory d);
```

### _assertTickMathLinkIntegrity

Assert the TickMath library link integrity for all four basket-family
vaults (finding L3-D1). Each vault exposes the linked library address
via `tickMathLibrary()`; the primary `RobotMoneyVault` does not use
TickMath and is excluded.
The audited reference is the TickMath library linked into THIS deploy
script (`address(TickMath)`): the script and the vault contracts are
compiled and linked together in the same artifact set, so a correctly
linked vault must point at the identical library instance with the
identical runtime codehash. Comparing against the script's own linked
library — rather than a hardcoded codehash — keeps the check robust
across compiler/metadata variance while still failing closed on a
mislink. Checks, per vault:
1. linked address is non-zero and has non-empty runtime code;
2. linked address equals the script's canonical `address(TickMath)`;
3. linked runtime codehash equals the canonical library's codehash;
4. `totalAssets()` does not revert and is within a sane USDC range.
A deliberately wrong/zero linked address fails check 1/2/3.


```solidity
function _assertTickMathLinkIntegrity(
    address protocolVault,
    address rwaVault,
    address agentVault
) internal view;
```

### _deployVaults

Phase 1: deploy all vaults, stubs, and adapters.
Returns addresses bundled in `_VaultAddrs` to keep the caller
stack under 16 slots.
Router stubs + swap adapters (V3/V4/Aerodrome) are collapsed into
a single `AgentBasketStubDeployer` CREATE to minimise on-chain tx
count and keep smoke-test devnet boot under the 30m CI budget.


```solidity
function _deployVaults(Params memory p) internal returns (_VaultAddrs memory v);
```

### _wireAndRegister

Phase 2: seed baskets, register vaults, set router eligibility
and weights. Separated from `_deployVaults` to avoid stack-too-deep.


```solidity
function _wireAndRegister(Params memory p, _VaultAddrs memory v)
    internal
    returns (Deployed memory d);
```

### _seedProtocolAssetVault

Wire the three PRD §11.2 basket symbols into the pre-built
`ProtocolAssetVault` via `addAsset`. Tokens + USDC pool stubs were
already created inside `ProtocolBasketStubDeployer`. The vault's
ADMIN_ROLE is held by p.admin, so addAsset succeeds on the
script broadcast key.


```solidity
function _seedProtocolAssetVault(ProtocolAssetVault vault, ProtocolBasketStubDeployer seeder)
    internal
    returns (address[] memory tokens);
```

### _seedAgentTokenVault

Wire the three real-asset demo tokens into the pre-built
`AgentTokenVault` via `addAsset` with per-asset venue selection:
index 0: BNKR  — Venue.V3  (built-in SWAP_ROUTER, adapter = address(0))
index 1: JUNO  — Venue.V4  (UniswapV4SwapAdapter)
index 2: RM — Venue.Aerodrome (AerodromeSwapAdapter)
Tokens + USDC pool stubs were already created inside
`AgentBasketStubDeployer`. Demo pools satisfy the cardinality and
liquidity gates in BasketVault.addAsset via stub returns.


```solidity
function _seedAgentTokenVault(
    AgentTokenVault vault,
    AgentBasketStubDeployer seeder,
    address v4AdapterAddr,
    address aeroAdapterAddr
) internal returns (address[] memory tokens);
```

### _seedRwaVault

Wire the deSPXA stand-in asset into the pre-built `RwaVault` via
`addAsset`. The ChronicleOracleAdapter (already deployed inside
`DemoRwaStubDeployer`) is passed as the per-asset adapter with
Venue.Aerodrome so BasketVault routes swaps through it. The fee
param is 0 — Aerodrome derives fee from the pool config, not the
adapter. The pool stub satisfies cardinality + liquidity gates.
Per ADR-0006 §1, the vault is seeded once (maxAssets = 1).


```solidity
function _seedRwaVault(RwaVault vault, DemoRwaStubDeployer seeder) internal;
```

### _applyFourVaultWeights

Refresh both the voted weight vector (used by the AC3 smoke test
which reads `getWeights()`) and the on-chain default (below-quorum
fallback, ADR-0002). All four router-eligible vaults: primary (§11.1),
rmRWA (§11.4, issue #621), rmPROTO (§11.2, issue #559), and rmAGENT
(§11.3, issue #560). Conservative stablecoin-heavy split:
8500 / 500 / 500 / 500 bps = 10 000 total.


```solidity
function _applyFourVaultWeights(
    PortfolioRouter router,
    address primary,
    address rwaVault,
    address proto,
    address agentVault
) internal;
```

### _registerIfAbsent

Register `vault` in `registry` if not already present. Returns
true if registration happened, false if already there.


```solidity
function _registerIfAbsent(
    VaultRegistry registry,
    address vault,
    address asset,
    string memory vaultName
) internal returns (bool registered);
```

### _envStringOrDefault


```solidity
function _envStringOrDefault(string memory key, string memory fallback_)
    internal
    view
    returns (string memory);
```

### _envAddressOrDefault


```solidity
function _envAddressOrDefault(string memory key, address fallback_)
    internal
    view
    returns (address);
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
Result struct returned to in-process callers (e.g. forge tests).


```solidity
struct Deployed {
    /// @dev `ProtocolAssetVault` (PRD §11.2, rmPROTO). Registered Active and
    ///      router-eligible (issue #559). Included in the default + voted weight
    ///      vectors at 3 333 bps (~33% of routed deposits).
    address protocolVault;
    /// @dev Devnet stand-in ERC20 addresses seeded into ProtocolAssetVault.
    address[] protocolTokens;
    /// @dev `AgentTokenVault` (PRD §11.3). Registered Active AND router-eligible
    ///      (BNKR/V3, JUNO/V4, RM/Aerodrome). Included in defaultWeights.
    address agentTokenVault;
    /// @dev Devnet stand-in ERC20 addresses seeded into AgentTokenVault
    ///      (three real-asset demo stubs: BNKR, JUNO, RM).
    address[] agentTokens;
    /// @dev `RwaVault` (PRD §11.4, deSPXA). Registered Active AND router-eligible at
    ///      500 bps (issue #621, ADR-0006 §1 amended 2026-06-05). The Aerodrome swap
    ///      stub and demo Chronicle oracle satisfy the deposit path on devnet.
    address rwaVault;
    /// @dev UniswapV4SwapAdapter deployed for JUNO (Venue.V4).
    address v4Adapter;
    /// @dev AerodromeSwapAdapter deployed for RM (Venue.Aerodrome).
    address aeroAdapter;
}
```

### Params
Env-derived params bundled to keep `run()` locals below the
Solidity stack limit (16 slots, ~stack-too-deep).


```solidity
struct Params {
    address admin;
    /// @dev Receives EMERGENCY_ROLE on each basket vault. Distinct from
    ///      admin in production (two-role key separation, issue #506).
    address emergencyResponder;
    address registry;
    address router;
    address primaryVault;
    address usdc;
    // Uniswap V3 SwapRouter02 for the basket vaults. On devnet no swaps run
    // during seed (only addAsset + register), so a non-functional address
    // is acceptable; defaults to the Base mainnet SwapRouter02.
    address swapRouter;
    string rwaName;
}
```

### _VaultAddrs
Intermediate struct for vault + stub addresses, used to pass
results from `_deployVaults` to `_wireAndRegister` without
exceeding the 16-slot Solidity stack limit.


```solidity
struct _VaultAddrs {
    address protocolVault;
    address rwaVault;
    address agentVault;
    address v4Adapter;
    address aeroAdapter;
    address agentStubs; // AgentBasketStubDeployer
    address protocolStubs; // ProtocolBasketStubDeployer
    address rwaStubs; // DemoRwaStubDeployer
}
```

