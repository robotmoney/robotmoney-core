# DeployRehearsalSafe
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/5e09613190caf40c6bcde5921567746bca14fa99/contracts/script/DeployRehearsalSafe.s.sol)

**Inherits:**
Script

**Title:**
DeployRehearsalSafe

Deploy the rehearsal-only Safe stand-in. Broadcast as the deployer
EOA so the SAFE_ADDRESS passed to DeployTimelock.s.sol has deployed
code and a threshold >= 2, exactly as _validate requires.
Optional env vars:
DEPLOYMENT_OUT   — path for the output JSON
(default: "deployments/rehearsal-safe-<chain_id>.json")


## Functions
### run


```solidity
function run() external returns (RehearsalSafe safe);
```

