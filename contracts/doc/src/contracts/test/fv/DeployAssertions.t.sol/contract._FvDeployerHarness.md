# _FvDeployerHarness
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/ff7f6357fae66fafd4ea43a7ad5248daf223b17f/contracts/test/fv/DeployAssertions.t.sol)

Stand-in for the deployer EOA. It holds the constructor-granted roles and
itself calls `runHandover`, so inside the handover `msg.sender` (the
address revoked) is this harness — mirroring the broadcast path where the
deployer key both grants and is revoked. It first delegates the
role-granting authority (ADMIN_ROLE on all five contracts, plus the
gateway DEFAULT_ADMIN_ROLE) to `address(script)`, which is what executes
the script's grant/revoke external calls.


## Constants
### ADMIN_ROLE

```solidity
bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### DEFAULT_ADMIN_ROLE

```solidity
bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00
```


## Functions
### grantAdminTo


```solidity
function grantAdminTo(
    address script_,
    address vault_,
    address gateway_,
    address registry_,
    address router_,
    address governance_
) external;
```

### runHandover


```solidity
function runHandover(
    DeployTimelock script_,
    address vault_,
    address gateway_,
    address registry_,
    address router_,
    address governance_,
    address safe_,
    address emergency_,
    uint256 minDelay_
) external returns (DeployTimelock.Deployed memory);
```

