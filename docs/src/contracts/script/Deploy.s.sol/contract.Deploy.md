# Deploy
[Git Source](https://github.com/lucky-tensor/robotmoney-skills/blob/b462a72b60a914ceeff6cdf3ad7148bfb0361abb/contracts/script/Deploy.s.sol)

**Inherits:**
Script

**Title:**
Deploy

Foundry deploy script for the MVP RobotMoney gateway stack.
Deploys MockUSDC + MockVault + RobotMoneyGateway, grants AGENT_ROLE
to a distinct EOA via `authorizeAgent`, asserts role-separation,
mints test USDC to the agent, and writes a deployment JSON.

Implements `docs/implementation-plan.md` §5 step 1–2 and
satisfies issue #10. Inputs are env-driven so the same script works
on Anvil, the docker devnet, and (with care) any throwaway L1.
Required env vars:
ADMIN_ADDRESS         — receives DEFAULT_ADMIN_ROLE + ADMIN_ROLE
PAUSER_ADDRESS        — receives PAUSER_ROLE (must differ from ADMIN)
AGENT_ADDRESS         — receives AGENT_ROLE  (must differ from both)
SHARE_RECEIVER_ADDRESS — recipient of minted rmUSDC shares
Optional env vars (with safe defaults):
AGENT_VALID_UNTIL      — uint64, default = block.timestamp + 30 days
AGENT_MAX_PER_PAYMENT  — uint256, default = 10_000 * 1e6 (USDC, 6dp)
AGENT_MAX_PER_WINDOW   — uint256, default = 100_000 * 1e6
AGENT_USDC_MINT        — uint256, default = 1_000_000 * 1e6
DEPLOYMENT_OUT         — output JSON path,
default = "deployments/<chain_id>.json"


## State Variables
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


### DEFAULT_AGENT_USDC_MINT
Default agent test-USDC mint amount.


```solidity
uint256 public constant DEFAULT_AGENT_USDC_MINT = 1_000_000 * 1e6
```


### DEFAULT_VALID_UNTIL_OFFSET
Default policy lifetime (30 days).


```solidity
uint64 public constant DEFAULT_VALID_UNTIL_OFFSET = 30 days
```


## Functions
### run

Forge entrypoint. Wraps `runDeploy` in a `vm.startBroadcast`
session driven by `--private-key` / `--sender`.


```solidity
function run() external returns (Deployed memory d);
```

### runInProcess

In-process variant for forge tests. Caller sets up `vm.prank`
or test-account context. No JSON is written.


```solidity
function runInProcess() external returns (Deployed memory d);
```

### runInProcessWith

Direct-parameter variant for forge tests. Skips env-var
resolution so a noisy host environment (or another test's
residual `vm.setEnv`) cannot pollute the inputs.


```solidity
function runInProcessWith(
    address admin_,
    address pauser_,
    address agent_,
    address shareReceiver_
) external returns (Deployed memory d);
```

### _readEnvParams


```solidity
function _readEnvParams() internal view returns (Params memory p);
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


```solidity
struct Deployed {
    MockUSDC usdc;
    MockVault vault;
    RobotMoneyGateway gateway;
    address admin;
    address pauser;
    address agent;
    address shareReceiver;
    bytes32 gatewayRuntimeHash;
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
    uint256 usdcMint;
}
```

