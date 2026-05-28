# DeployDemoExtraVaults
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/d92dd042a375c2969be12630e370cd3c51b44d4e/contracts/script/DeployDemoExtraVaults.s.sol)

**Inherits:**
Script

**Title:**
DeployDemoExtraVaults

Demo-only deploy script that registers two additional ERC-4626
vaults plus a non-Active RWA/Thematic placeholder in
`VaultRegistry` and re-sets the router weight vector to a
non-degenerate three-way split.
Why this exists: the production basket vaults `ProtocolAssetVault`
and `AgentTokenVault` remain ADR-blocked (see
`docs/technical/basket-vault-gap-report.md` — they lack TWAP
hardening and slippage-bounded `previewRedeem`), so the demo cannot
seed them today. To still exercise the multi-vault router story end
to end (Portfolio Explorer, /v1/vaults TVL, Router Governance
weights) the demo registers two extra `RobotMoneyVault` instances
wired to `PassthroughAdapter` — the same adapter the smoke-test
devnet already uses for the primary vault. They are demo-only
stand-ins; no mainnet build runs this script.
Four-vault PRD conformance (issue #479): PRD §11 names four vault
categories — Stable Yield, Protocol Asset, Agent Token, and
RWA/Thematic. PRD §11.4 marks RWA/Thematic as Future / not
specified. To make the deployed vault set match the four-vault
catalog, this script also registers a single RWA/Thematic
placeholder. It is registered then set to a non-Active status
(Paused) and is never marked router-eligible, so `PortfolioRouter`
skips it (it is not in the weight vector) and the dapp renders it
as a Future / Coming-soon tile whose inactive state is read from
on-chain status, not a hard-coded flag. This is registry state, not
a code variant — single-production-codebase
(`docs/development/single-production-codebase.md`).
Required env vars:
ADMIN_ADDRESS      — receives ADMIN_ROLE on the new vaults and
must already hold ADMIN_ROLE on
VaultRegistry + PortfolioRouter
REGISTRY_ADDRESS   — deployed VaultRegistry
ROUTER_ADDRESS     — deployed PortfolioRouter
PRIMARY_VAULT      — RobotMoneyVault deployed by Deploy.s.sol
(kept in the weight vector with the largest
share)
USDC_ADDRESS       — ERC-20 asset every vault denominates in
WEIGHT_PRIMARY_BPS — bps for PRIMARY_VAULT in the new vector
WEIGHT_EXTRA1_BPS  — bps for the first extra vault
WEIGHT_EXTRA2_BPS  — bps for the second extra vault
(the three must sum to 10 000)
Optional env vars:
VAULT1_NAME        — registry name for the first extra vault
(default: "Robot Money Demo Vault A")
VAULT2_NAME        — registry name for the second extra vault
(default: "Robot Money Demo Vault B")
RWA_VAULT_NAME     — registry name for the RWA/Thematic
placeholder
(default: "Robot Money RWA / Thematic")
DEPLOYMENT_OUT     — output JSON path
(default: "deployments/demo-extra-vaults-<chain_id>.json")


## Constants
### DEFAULT_VAULT1_NAME
Default human-readable name for the first extra demo vault.


```solidity
string public constant DEFAULT_VAULT1_NAME = "Robot Money Demo Vault A"
```


### DEFAULT_VAULT2_NAME
Default human-readable name for the second extra demo vault.


```solidity
string public constant DEFAULT_VAULT2_NAME = "Robot Money Demo Vault B"
```


### DEFAULT_RWA_NAME
Default human-readable name for the RWA/Thematic placeholder
(issue #479, PRD §11.4). Future / not-specified vault category.


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


## Functions
### run

Forge broadcast entrypoint. Deploys two extra demo vaults +
passthrough adapters, registers them, attests them on the
router, and resets the router weight vector.


```solidity
function run() external returns (Deployed memory d);
```

### runInProcess

In-process entrypoint for forge tests. Runs the same deploy +
seed body as `run()` but without `vm.startBroadcast`, so the
caller (the test contract) is the broadcaster and must already
hold ADMIN_ROLE on the registry and router. No deployment JSON
is written. Used by `test_demo_seed_populates_defaultWeights`.


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

### _registerRwaPlaceholder

Deploy a bare RobotMoneyVault, register it, and set it to a
non-Active status so the Router skips it and the dapp marks it
Future. Router eligibility is left at the registry default
(`false`) — the placeholder is never opted in. Idempotent only at
registration; a re-run deploys a fresh vault address (demo seed
runs once against a fresh fork).


```solidity
function _registerRwaPlaceholder(VaultRegistry registry, Params memory p)
    internal
    returns (address rwaVault);
```

### _deployVault


```solidity
function _deployVault(Params memory p) internal returns (RobotMoneyVault);
```

### _wireAdapter


```solidity
function _wireAdapter(RobotMoneyVault vault_, address usdc_)
    internal
    returns (PassthroughAdapter adapter_);
```

### _setThreeWayWeights


```solidity
function _setThreeWayWeights(
    PortfolioRouter router,
    address primary,
    address extra1,
    address extra2,
    Params memory p
) internal;
```

### _setThreeWayDefaultWeights

Populate the router's default (below-quorum fallback) weight vector
with the same three-way split. ADR-0002: this is the vector the
router routes by — and the allocation surface renders — with no
governance activity.


```solidity
function _setThreeWayDefaultWeights(
    PortfolioRouter router,
    address primary,
    address extra1,
    address extra2,
    Params memory p
) internal;
```

### _approveAdapter

Approve `adapter_` on `vault_` matching Deploy.s.sol semantics:
assert no DELEGATECALL in adapter runtime, then allowlist address
and codehash.


```solidity
function _approveAdapter(RobotMoneyVault vault_, address adapter_) internal;
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

### _logResult


```solidity
function _logResult(Deployed memory d) internal view;
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
    address vault1;
    address vault2;
    address adapter1;
    address adapter2;
    uint256 weightPrimaryBps;
    uint256 weightExtra1Bps;
    uint256 weightExtra2Bps;
    /// @dev RWA/Thematic placeholder (issue #479). Registered non-Active
    ///      (Paused) and never router-eligible; not in the weight vector.
    address rwaVault;
}
```

### Params
Env-derived params bundled to keep `run()` locals below the
Solidity stack limit (16 slots, ~stack-too-deep).


```solidity
struct Params {
    address admin;
    address registry;
    address router;
    address primaryVault;
    address usdc;
    uint256 wPrimary;
    uint256 wExtra1;
    uint256 wExtra2;
    string name1;
    string name2;
    string rwaName;
}
```

