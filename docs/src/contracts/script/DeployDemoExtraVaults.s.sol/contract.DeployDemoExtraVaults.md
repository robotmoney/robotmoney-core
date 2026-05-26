# DeployDemoExtraVaults
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/650eae7f20b3e7fed3aa1cae2b88693317d3757b/contracts/script/DeployDemoExtraVaults.s.sol)

**Inherits:**
Script

**Title:**
DeployDemoExtraVaults

Demo-only deploy script that registers two additional ERC-4626
vaults in `VaultRegistry` and re-sets the router weight vector to
a non-degenerate three-way split.
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
}
```

