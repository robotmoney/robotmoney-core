# BasketAssetConfigGuard
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/04ed1dbad12586b776088eccf72044b65f6c4cc3/contracts/lib/BasketAssetConfigGuard.sol)

**Title:**
BasketAssetConfigGuard

The config-validation interface the 2026-06-19 audit recommended for
`BasketVault.addAsset`: it enforces the ADP-2 adapter codehash
allowlist and the ORA-3 execution-pool == TWAP-pool equality (F-09).

Declared `public` (external, DELEGATECALL-linked) so the checks live in a
single deployed library instead of being inlined into every vault in the
already-EIP-170-tight basket family.


## Functions
### requireAllowedAdapter

Vet a non-zero adapter's codehash against the allowlist (ADP-2 / NC-2).
The default Uniswap V3 path (adapter == 0) needs no vetting.


```solidity
function requireAllowedAdapter(address adapter, bool allowed) public pure;
```

### requireExecutionPoolMatchesTwap

Assert the execution pool resolved from `swapFee` is the SAME pool
the NAV TWAP reads from (ORA-3 / F-09): fee tier for V3/V4, tick
spacing for Aerodrome. `swapFee == 0` is the pool-independent-pricing
sentinel (e.g. the Chronicle NAV adapter) and is exempt.


```solidity
function requireExecutionPoolMatchesTwap(address pool, uint24 swapFee, Venue venue)
    public
    view;
```

## Errors
### AdapterCodeHashNotAllowed
Adapter runtime-bytecode hash not on the ADMIN-approved allowlist (ADP-2).


```solidity
error AdapterCodeHashNotAllowed();
```

### ExecutionPoolMismatch
Execution pool (resolved from swapFee) != registered TWAP pool (ORA-3).


```solidity
error ExecutionPoolMismatch();
```

## Enums
### Venue
Mirror of `BasketVault.Venue`. Kept value-compatible (same ordinals).


```solidity
enum Venue {
    V3,
    V4,
    Aerodrome
}
```

