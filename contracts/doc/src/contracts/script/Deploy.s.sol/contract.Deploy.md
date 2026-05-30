# Deploy
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/f8cc494733d881fe168b95aea3df5da6400c759b/contracts/script/Deploy.s.sol)

**Inherits:**
Script

**Title:**
Deploy

Foundry deploy script for the Robot Money gateway stack.
Deploys RobotMoneyVault wired to real Aave V3, Compound V3, and
Morpho strategy adapters (Base mainnet protocol addresses), a
RobotMoneyGateway bound to the vault, grants AGENT_ROLE to a
distinct EOA via `authorizeAgent`, asserts role-separation, and
writes a deployment JSON.
MockVault is NOT deployed by this script; it is only used by
gateway deposit-routing unit tests directly. See issue #277.
PassthroughAdapter is NOT registered by this script; it is
retained in the codebase for unit tests only. See issue #363.

Implements `docs/implementation-plan.md` §5 step 1–2 and
satisfies issue #10. Inputs are env-driven so the same script works
on Anvil, the docker devnet, and (with care) any throwaway L1.
Required env vars:
ADMIN_ADDRESS         — receives DEFAULT_ADMIN_ROLE + ADMIN_ROLE
PAUSER_ADDRESS        — receives PAUSER_ROLE (must differ from ADMIN)
AGENT_ADDRESS         — receives AGENT_ROLE  (must differ from both)
SHARE_RECEIVER_ADDRESS — recipient of minted rmUSDC shares
USDC_ADDRESS          — address of the USDC token to bind the
gateway to. The smoke-test devnet seeds the
canonical Base USDC into genesis alloc and
exports this address (see issue #255 and
`Fixture::fund_usdc` in the smoke-test
crate). Forge unit tests deploy a
`TestERC20` helper and pass its address
via `runInProcessWithUsdc`.
Optional env vars (with safe defaults):
AGENT_VALID_UNTIL               — uint64, default = block.timestamp + 30 days
AGENT_MAX_PER_PAYMENT           — uint256, default = 10_000 * 1e6 (USDC, 6dp)
AGENT_MAX_PER_WINDOW            — uint256, default = 100_000 * 1e6
AGENT_MAX_WITHDRAW_PER_PAYMENT  — uint256, default = 10_000 * 1e6 (shares, 6dp)
AGENT_MAX_WITHDRAW_PER_WINDOW   — uint256, default = 100_000 * 1e6
DEPLOYMENT_OUT         — output JSON path,
default = "deployments/<chain_id>.json"
USE_PASSTHROUGH_ADAPTER — bool, default = false.
When true, deploys a single `PassthroughAdapter`
instead of the three real protocol adapters.
Required on the Geth+Lighthouse smoke-test devnet
because that chain boots from a genesis snapshot
containing only warm-storage slots — real Aave,
Compound, and Morpho contracts have bytecode but
no on-chain state, so any call that returns a
uint256 (e.g. `balanceOf`) would be ABI-decoded
from an empty return and revert.  Set automatically
by the smoke-test Rust harness.


## Constants
### CANONICAL_BASE_USDC
Canonical Base mainnet USDC (FiatTokenProxy). The smoke-test
devnet seeds this address with real proxy storage + the
FiatTokenV2_2 implementation in genesis alloc.


```solidity
address public constant CANONICAL_BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```


### AAVE_V3_POOL
Aave V3 Pool on Base mainnet.


```solidity
address public constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5
```


### AAVE_V3_A_TOKEN
aBasUSDC — Aave V3 interest-bearing USDC receipt token on Base.


```solidity
address public constant AAVE_V3_A_TOKEN = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB
```


### MORPHO_GAUNTLET_USDC_PRIME
Morpho Gauntlet USDC Prime ERC-4626 vault on Base.


```solidity
address public constant MORPHO_GAUNTLET_USDC_PRIME = 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca
```


### COMPOUND_V3_COMET
Compound V3 (Comet) USDC market on Base.

Verified against `cast call <compound-adapter> "COMET()(address)"` on Base mainnet.
The previously used address 0xB125e6687D4313864e53df431d5425969c15eb28
(ending in 28) was a typo — the actual Comet ends in 2F.


```solidity
address public constant COMPOUND_V3_COMET = 0xb125E6687d4313864e53df431d5425969c15Eb2F
```


### DEFAULT_MAX_PER_PAYMENT
Default per-payment cap if `AGENT_MAX_PER_PAYMENT` is unset.


```solidity
uint256 public constant DEFAULT_MAX_PER_PAYMENT = 10_000 * 1e6
```


### DEFAULT_MAX_PER_WINDOW
Default per-window cap if `AGENT_MAX_PER_WINDOW` is unset.


```solidity
uint256 public constant DEFAULT_MAX_PER_WINDOW = 100_000 * 1e6
```


### DEFAULT_MAX_WITHDRAW_PER_PAYMENT
Default withdrawal per-payment cap if `AGENT_MAX_WITHDRAW_PER_PAYMENT` is unset.


```solidity
uint256 public constant DEFAULT_MAX_WITHDRAW_PER_PAYMENT = 10_000 * 1e6
```


### DEFAULT_MAX_WITHDRAW_PER_WINDOW
Default withdrawal per-window cap if `AGENT_MAX_WITHDRAW_PER_WINDOW` is unset.


```solidity
uint256 public constant DEFAULT_MAX_WITHDRAW_PER_WINDOW = 100_000 * 1e6
```


### DEFAULT_VALID_UNTIL_OFFSET
Default policy lifetime (30 days).


```solidity
uint64 public constant DEFAULT_VALID_UNTIL_OFFSET = 30 days
```


## Functions
### run

Forge broadcast entrypoint. Reads env vars, deploys all contracts, and writes a JSON file.


```solidity
function run() external returns (Deployed memory d);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`d`|`Deployed`|Struct containing all deployed contract addresses and key parameters.|


### runInProcess

In-process variant for forge tests. Caller sets up `vm.prank`
or test-account context. No JSON is written.


```solidity
function runInProcess() external returns (Deployed memory d);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`d`|`Deployed`|Struct containing all deployed contract addresses and key parameters.|


### runInProcessWith

Direct-parameter variant for forge tests. Skips env-var
resolution so a noisy host environment (or another test's
residual `vm.setEnv`) cannot pollute the inputs. The caller
must supply a deployed USDC token (typically a `TestERC20`).


```solidity
function runInProcessWith(
    address admin_,
    address pauser_,
    address agent_,
    address shareReceiver_,
    address usdc_
) external returns (Deployed memory d);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`admin_`|`address`|        Address to receive `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE`.|
|`pauser_`|`address`|       Address to receive `PAUSER_ROLE`.|
|`agent_`|`address`|        Address to receive `AGENT_ROLE`.|
|`shareReceiver_`|`address`|Address that will receive minted vault shares.|
|`usdc_`|`address`|         Address of the USDC token to bind to the gateway.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`d`|`Deployed`|Struct containing all deployed contract addresses and key parameters.|


### _readEnvParams


```solidity
function _readEnvParams() internal view returns (Params memory p);
```

### _approveAndRegisterAdapters


```solidity
function _approveAndRegisterAdapters(Deployed memory d) internal;
```

### _approveAdapter

Approves `adapter_` on `vault_` after asserting the no-proxy
invariant: the adapter's runtime bytecode must not contain a
`DELEGATECALL` opcode. This prevents a future proxy-backed
adapter from bypassing the codehash allowlist by hot-swapping
its implementation. See docs/technical/security-model.md and issue #448.


```solidity
function _approveAdapter(RobotMoneyVault vault_, address adapter_) internal;
```

### _doDeploy


```solidity
function _doDeploy(Params memory p) internal returns (Deployed memory d);
```

### _envOrDefault


```solidity
function _envOrDefault(string memory key, uint256 fallbackValue)
    internal
    view
    returns (uint256);
```

### _writeDeploymentJson


```solidity
function _writeDeploymentJson(Deployed memory d) internal;
```

## Structs
### Deployed
Result struct returned to in-process callers (e.g. forge tests).

`usdc` is the *address* of the externally-supplied USDC token
bound to the gateway. On the smoke-test devnet this is the
canonical Base USDC proxy seeded into genesis alloc; in forge
unit tests it is a `TestERC20` deployed by the caller.
`vault` is the deployed RobotMoneyVault (smoke-test devnet and
integration tests). For gateway unit tests that still need MockVault,
use the separate `MockVault` import directly.
`aaveAdapter`, `compoundAdapter`, and `morphoAdapter` are the
real protocol adapters registered with the vault at deploy time.
When `USE_PASSTHROUGH_ADAPTER=true` all three adapter fields point
to the same `PassthroughAdapter` instance (Geth devnet only — real
protocol contracts have no on-chain state there).


```solidity
struct Deployed {
    address usdc;
    RobotMoneyVault vault;
    AaveV3Adapter aaveAdapter;
    CompoundV3Adapter compoundAdapter;
    MorphoAdapter morphoAdapter;
    RobotMoneyGateway gateway;
    address admin;
    address pauser;
    address agent;
    address shareReceiver;
    bytes32 gatewayRuntimeHash;
    /// @dev True when deployed with `USE_PASSTHROUGH_ADAPTER=true`.
    ///      All three adapter fields share the same `PassthroughAdapter`
    ///      address; only one `addAdapter` call is needed.
    bool passthroughMode;
}
```

### Params

```solidity
struct Params {
    address admin;
    address pauser;
    address agent;
    address shareReceiver;
    uint64 validUntil;
    uint256 maxPerPayment;
    uint256 maxPerWindow;
    uint256 maxWithdrawPerPayment;
    uint256 maxWithdrawPerWindow;
    /// @dev Address of the USDC token to bind the gateway to. Must be
    ///      non-zero and have code deployed. The smoke-test devnet sets
    ///      this to the canonical Base USDC ([`CANONICAL_BASE_USDC`]);
    ///      forge unit tests deploy a `TestERC20` helper.
    address usdcAddress;
}
```

