# DeployAgentTokenVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/8fe82accd34499f358df165500b889c234fe064a/contracts/script/DeployAgentTokenVault.s.sol)

**Inherits:**
Script

**Title:**
DeployAgentTokenVault

Deploys `AgentTokenVault` and seeds it with the active three-token
demo shortlist: BNKR, JUNO, RM. Token, pool, adapter, and
venue data are read from `config/agent-token-shortlist.json`; no
token address is hardcoded in Solidity source.
Chain selection: `block.chainid == 8453` (Base mainnet) reads the
`mainnet` block of the config. Any other chain id reads stand-in
ERC20 + pool addresses from `DEVNET_AGENT_TOKEN_<SYMBOL>` /
`DEVNET_AGENT_POOL_<SYMBOL>` / `DEVNET_AGENT_FEE_<SYMBOL>` /
`DEVNET_AGENT_ADAPTER_<SYMBOL>` env
overrides, matching the single-production-codebase principle: the
same script ships everywhere, only the address source differs.
Required env vars:
ADMIN_ADDRESS              — receives ADMIN_ROLE on the vault and
must hold ADMIN_ROLE on VaultRegistry
EMERGENCY_RESPONDER_ADDRESS — receives EMERGENCY_ROLE on the vault
(hot key for rapid unwind/shutdown);
use a distinct address from ADMIN_ADDRESS
in production for two-role key separation
SWAP_ROUTER                — Uniswap V3 SwapRouter02
USDC_ADDRESS               — ERC-20 asset the vault denominates in
Optional env vars:
REGISTRY_ADDRESS  — when set, the vault is registered here as
"Robot Money Agent Tokens" (the same path the
demo seed and dapp Portfolio Explorer use)
CONFIG_PATH       — shortlist config path
(default: config/agent-token-shortlist.json)
DEPLOYMENT_OUT    — output JSON path
(default: deployments/agent-token-vault-<chain_id>.json)


## Constants
### TVL_CAP
TVL/per-deposit caps mirrored from the other demo vaults.


```solidity
uint256 public constant TVL_CAP = 10_000_000 * 1e6
```


### PER_DEPOSIT_CAP

```solidity
uint256 public constant PER_DEPOSIT_CAP = 1_000_000 * 1e6
```


## State Variables
### SYMBOLS
Active shortlist symbols in deploy order.
Ordering is load-bearing: AgentTokenVault.shortlist() returns
tokens in this order, and the dapp/tests assert on it.


```solidity
string[3] internal SYMBOLS = ["BNKR", "JUNO", "RM"]
```


## Functions
### run

Broadcast entrypoint. Deploys the vault, seeds the three-token
shortlist, optionally registers it, and writes a deployment JSON.


```solidity
function run() external returns (Deployed memory d);
```

### _deployAndSeed

Deploys the vault, adds each shortlist asset (in config order), and
registers the vault if REGISTRY_ADDRESS is set.


```solidity
function _deployAndSeed(
    address admin,
    address emergencyResponder,
    address swapRouter,
    address usdc,
    Entry[3] memory entries
) internal returns (Deployed memory d);
```

### _resolveShortlist

Resolve the three shortlist entries from config (mainnet) or env
overrides (devnet), selected by chain id.


```solidity
function _resolveShortlist() internal view returns (Entry[3] memory entries);
```

### _venueFromString


```solidity
function _venueFromString(string memory value) internal pure returns (BasketVault.Venue);
```

### _readConfig


```solidity
function _readConfig() internal view returns (string memory);
```

### _registerIfAbsent


```solidity
function _registerIfAbsent(VaultRegistry registry, address vault, address asset) internal;
```

### _writeDeploymentJson


```solidity
function _writeDeploymentJson(Deployed memory d) internal;
```

### _envAddressOrZero


```solidity
function _envAddressOrZero(string memory key) internal view returns (address);
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
### Entry
A single resolved shortlist entry.


```solidity
struct Entry {
    string symbol;
    address token;
    address pool;
    uint24 swapFee;
    address adapter;
    BasketVault.Venue venue;
}
```

### Deployed
Result returned to in-process callers (e.g. forge tests).


```solidity
struct Deployed {
    address vault;
    address[] tokens;
    /// @dev True when the vault was registered in VaultRegistry during this
    ///      run (REGISTRY_ADDRESS was set and the vault was not already
    ///      registered). Router eligibility is NOT activated here — see
    ///      ActivateBasketVaultEligibility.s.sol.
    bool registered;
}
```

