# ForeignTokenQuarantine
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/0d868fe02e5cf19ce075213817ca84416ca13c09/contracts/lib/ForeignTokenQuarantine.sol)

**Title:**
ForeignTokenQuarantine

Shared logic for the permissionless foreign-token sweep that enforces
custody invariants INV-1 and INV-2.
INV-1 (no arbitrary admin routing): no admin/role-gated function may
route a PROTOCOL or DEPOSITOR asset to a caller-supplied recipient.
The old `rescueTokens`/`rescueUsdc` functions did exactly that and are
deleted across the protocol.
INV-2 (no stranded assets): every protocol/depositor asset is either
redeemable by holders or absorbed into NAV. Non-whitelisted "foreign"
tokens that land on a contract via a raw ERC-20 transfer cannot be
rejected on receipt nor returned-to-sender (the sender is not knowable
on-chain), and are inert (uncounted, un-redeemable). For storage
hygiene they get a *deterministic, permissionless* sweep to a governed
quarantine ("trash") address. Anyone may trigger the sweep; no caller
can choose the destination (INV-1). An offline multisig governance
process can later empty the trash address (the reverse-mistakes safety
valve).

Two sweep overloads are provided:
`sweep(token, triggeredBy)` — uses the hardcoded `QUARANTINE` constant.
Used by adapters that have no on-chain admin (immutable contracts).
`sweep(token, destination, triggeredBy)` — uses a caller-supplied
`destination` that must be the per-contract governance-controlled
quarantine address (see `quarantineAddress` on RobotMoneyVault,
BasketVault, and PortfolioRouter). The destination is never the raw
`msg.sender`; it is set only through the TimelockController (INV-3)
and therefore cannot be steered by a calling-time argument.


## Constants
### QUARANTINE
The protocol-wide default quarantine ("trash") address used by
adapters that have no on-chain governance (immutable contracts).
Main protocol contracts (RobotMoneyVault, BasketVault,
PortfolioRouter) store a timelock-settable `quarantineAddress`
state variable and call the three-argument `sweep` overload.


```solidity
address internal constant QUARANTINE = 0x0000000000000000000000000000000000deaD11
```


## Functions
### sweep

Move the caller contract's full balance of `token` to the fixed
`QUARANTINE` constant address. Used by adapters that are
immutable and have no on-chain access control.

`internal` (inlined), NOT an external delegatecall-linked library:
strategy adapters are forbidden from containing the `DELEGATECALL`
opcode by `AdapterBytecodeGuard` / `AdapterDelegatecallGuard`
(confused-deputy defence), and an external library call compiles to a
delegatecall. Inlining keeps the adapters delegatecall-free.


```solidity
function sweep(address token, address triggeredBy) internal returns (uint256 amount);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|Foreign ERC-20 to sweep. Must not be protected.|
|`triggeredBy`|`address`|The unprivileged account that triggered the sweep.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`amount`|`uint256`|The amount swept to quarantine.|


### sweep

Move the caller contract's full balance of `token` to a
governance-controlled `destination`. Use this overload when the
quarantine address is stored as a timelock-settable state variable
on the calling contract (RobotMoneyVault, BasketVault,
PortfolioRouter). The `destination` MUST NOT be a caller-supplied
argument; it must be read from the contract's governed storage.


```solidity
function sweep(address token, address destination, address triggeredBy)
    internal
    returns (uint256 amount);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|      Foreign ERC-20 to sweep. Must not be protected.|
|`destination`|`address`|Governed quarantine address. Must not be address(0).|
|`triggeredBy`|`address`|The unprivileged account that triggered the sweep.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`amount`|`uint256`|The amount swept to `destination`.|


## Events
### ForeignTokenQuarantined
Emitted when a foreign token is swept to the quarantine address.


```solidity
event ForeignTokenQuarantined(address indexed token, uint256 amount, address indexed caller);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`| Foreign ERC-20 swept to quarantine.|
|`amount`|`uint256`|Amount swept (the contract's full balance of `token`).|
|`caller`|`address`|The (unprivileged) account that triggered the sweep.|

## Errors
### TokenIsProtected
A sweep was attempted on a protected (protocol/depositor) token.


```solidity
error TokenIsProtected(address token);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|The protected token that may not be swept.|

### ZeroQuarantineAddress
Quarantine address must not be the zero address.


```solidity
error ZeroQuarantineAddress();
```

