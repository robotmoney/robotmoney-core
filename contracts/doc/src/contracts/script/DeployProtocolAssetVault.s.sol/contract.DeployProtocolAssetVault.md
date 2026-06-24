# DeployProtocolAssetVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/4b9f1e53ce2923a3a2346fb7de25157672f7633c/contracts/script/DeployProtocolAssetVault.s.sol)

**Inherits:**
Script

**Title:**
DeployProtocolAssetVault

Production deploy script for `ProtocolAssetVault` (PRD §11.2 — rmPROTO).
Deploys the vault, registers it in `VaultRegistry`, and emits the
deployed address. Router eligibility activation is intentionally
separated into `ActivateBasketVaultEligibility.s.sol`.
Required env vars:
ADMIN_ADDRESS              — receives ADMIN_ROLE on the vault and
must hold ADMIN_ROLE on VaultRegistry
EMERGENCY_RESPONDER_ADDRESS — receives EMERGENCY_ROLE on the vault;
use a distinct address from ADMIN_ADDRESS
in production for two-role key separation
SWAP_ROUTER                — Uniswap V3 SwapRouter02
USDC_ADDRESS               — ERC-20 asset the vault denominates in
Optional env vars:
REGISTRY_ADDRESS  — when set, the vault is registered here as
"Robot Money Protocol" (VaultMetadata.name)
TVL_CAP           — USDC TVL ceiling (default: 10_000_000 * 1e6)
PER_DEPOSIT_CAP   — USDC per-deposit ceiling (default: 1_000_000 * 1e6)
EXIT_FEE_BPS      — exit fee in basis points (default: 0)
FEE_RECIPIENT     — recipient for exit fees (default: ADMIN_ADDRESS)
DEPLOYMENT_OUT    — output JSON path
(default: deployments/protocol-asset-vault-<chain_id>.json)


## Constants
### DEFAULT_TVL_CAP
Default TVL cap: 10M USDC (6 decimals).


```solidity
uint256 public constant DEFAULT_TVL_CAP = 10_000_000 * 1e6
```


### DEFAULT_PER_DEPOSIT_CAP
Default per-deposit cap: 1M USDC (6 decimals).


```solidity
uint256 public constant DEFAULT_PER_DEPOSIT_CAP = 1_000_000 * 1e6
```


### VAULT_NAME
Vault name registered in VaultRegistry.


```solidity
string public constant VAULT_NAME = "Robot Money Protocol"
```


## Functions
### run

Forge broadcast entrypoint. Deploys the vault, optionally
registers it in VaultRegistry, and writes a deployment JSON.


```solidity
function run() external returns (Deployed memory d);
```

### runInProcessWith

In-process variant for forge tests. No broadcast, no JSON written.
Caller must ensure the call context holds ADMIN_ROLE on the registry
(or pass admin_ as the test contract so startPrank can be used).


```solidity
function runInProcessWith(
    address admin_,
    address emergencyResponder_,
    address swapRouter_,
    address usdc_,
    address registry_
) external returns (Deployed memory d);
```

### _deployAndRegister


```solidity
function _deployAndRegister(
    address admin,
    address emergencyResponder,
    address swapRouter,
    address usdc,
    uint256 tvlCap,
    uint256 perDepositCap,
    uint256 exitFeeBps,
    address feeRecipient
) internal returns (Deployed memory d);
```

### _registerIfAbsent

Register `vault` in the registry if not already present.
Caller must hold ADMIN_ROLE on the registry.


```solidity
function _registerIfAbsent(VaultRegistry registry, address vault, address asset) internal;
```

### _writeDeploymentJson


```solidity
function _writeDeploymentJson(Deployed memory d) internal;
```

### _envAddressOrDefault


```solidity
function _envAddressOrDefault(string memory key, address fallback_)
    internal
    view
    returns (address);
```

### _envUintOrDefault


```solidity
function _envUintOrDefault(string memory key, uint256 fallback_)
    internal
    view
    returns (uint256);
```

### _envStringOrDefault


```solidity
function _envStringOrDefault(string memory key, string memory fallback_)
    internal
    view
    returns (string memory);
```

## Structs
### Deployed
Result returned to in-process callers (e.g. forge tests).


```solidity
struct Deployed {
    address vault;
    address registry;
    bool registered;
}
```

