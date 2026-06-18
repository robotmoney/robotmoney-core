# ActivateBasketVaultEligibility
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/8fe82accd34499f358df165500b889c234fe064a/contracts/script/ActivateBasketVaultEligibility.s.sol)

**Inherits:**
Script

**Title:**
ActivateBasketVaultEligibility

Calls `VaultRegistry.setRouterEligible(vault, true)` for both
`ProtocolAssetVault` (rmPROTO) and `AgentTokenVault` (rmAGENT).
SAFETY GATE: the script reverts unless `BASKET_VAULT_AUDIT_COMPLETE`
env var is set to exactly `"true"`. This prevents accidental execution
before the Architecture §4.1 certification checklist is satisfied.
Required env vars:
BASKET_VAULT_AUDIT_COMPLETE — must be "true" (reverts otherwise)
REGISTRY_ADDRESS            — deployed VaultRegistry
PROTOCOL_VAULT_ADDRESS      — deployed ProtocolAssetVault (rmPROTO)
AGENT_VAULT_ADDRESS         — deployed AgentTokenVault (rmAGENT)
The broadcaster must hold ADMIN_ROLE on the VaultRegistry.


## Functions
### run

Forge broadcast entrypoint. Reads env vars, validates the audit
gate, and calls `setRouterEligible(true)` for both basket vaults.


```solidity
function run() external returns (Activated memory a);
```

### runInProcessWith

In-process variant for forge tests. No broadcast. Caller must
prank admin or call from a context that holds ADMIN_ROLE.
`auditComplete` is passed explicitly so tests can exercise both
the gated path (true) and the revert path (false) without setting
env vars.


```solidity
function runInProcessWith(
    address registry_,
    address protocolVault_,
    address agentVault_,
    bool auditComplete
) external returns (Activated memory a);
```

### _activate

Activate router eligibility for both basket vaults. Caller must
hold ADMIN_ROLE on the registry.


```solidity
function _activate(VaultRegistry registry, address protocolVault, address agentVault)
    internal
    returns (Activated memory a);
```

### _requireAuditComplete

Revert unless `BASKET_VAULT_AUDIT_COMPLETE` env var equals "true".
This guards the broadcast path so the operator cannot accidentally
activate eligibility before the Architecture §4.1 checklist is done.


```solidity
function _requireAuditComplete() internal view;
```

## Structs
### Activated
Result returned to in-process callers (e.g. forge tests).


```solidity
struct Activated {
    address protocolVault;
    address agentVault;
    address registry;
}
```

