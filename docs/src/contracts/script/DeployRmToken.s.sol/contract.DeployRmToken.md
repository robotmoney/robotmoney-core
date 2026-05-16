# DeployRmToken
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/1421cc6201de54f6b9e3c222f9419f45c65b6f43/contracts/script/DeployRmToken.s.sol)

**Inherits:**
Script

**Title:**
DeployRmToken

Foundry deploy script for the RmToken ERC-20 contract.
Deploys RmToken, minting the entire initial supply to the harness
EOA (or a configured initial holder), and writes a deployment JSON
readable by the smoke-test fixture.
Required env vars:
INITIAL_HOLDER      — address that receives the entire initial supply
Optional env vars:
RM_TOKEN_NAME       — token name (default: "Robot Money Token")
RM_TOKEN_SYMBOL     — token symbol (default: "RM")
RM_TOKEN_SUPPLY     — initial supply in base units (default: 1_000_000 * 10^18)
DEPLOYMENT_OUT      — path for the output JSON
(default: "deployments/rm-token-<chain_id>.json")


## Constants
### DEFAULT_INITIAL_SUPPLY
Default initial supply: 1 000 000 RM (18 decimals).


```solidity
uint256 public constant DEFAULT_INITIAL_SUPPLY = 1_000_000 * 1e18
```


## Functions
### run

Forge broadcast entrypoint. Reads env vars, deploys RmToken,
and writes a deployment JSON.


```solidity
function run() external returns (Deployed memory d);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`d`|`Deployed`|Struct containing the deployed token and key parameters.|


### runInProcessWith

In-process variant for forge tests. No broadcast, no JSON written.


```solidity
function runInProcessWith(
    string memory name_,
    string memory symbol_,
    address initialHolder_,
    uint256 initialSupply_
) external returns (Deployed memory d);
```

### _deploy


```solidity
function _deploy(
    string memory name_,
    string memory symbol_,
    address initialHolder_,
    uint256 initialSupply_
) internal returns (Deployed memory d);
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
Result struct returned to in-process callers.


```solidity
struct Deployed {
    RmToken token;
    address initialHolder;
    uint256 initialSupply;
}
```

