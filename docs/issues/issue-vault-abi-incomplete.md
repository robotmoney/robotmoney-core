# Issue — CLI ABI is missing nine vault functions that exist in the deployed contract

> Summary: `packages/cli/src/lib/abi.ts` contains a hand-maintained subset of the `RobotMoneyVault` ABI. Nine functions present in the deployed contract are absent. Six are read-only views useful for monitoring and scheduling (drift, rebalance availability, active adapter count, current target weight, shutdown alias). Three are write functions relevant to keepers and admin operations (rebalance, adminRebalance, and role-management via AccessControl). The missing reads are immediately actionable — they require no new roles, no governance, and no contract changes — but agents and operators cannot call them programmatically today.

## 1. Severity

**Medium.** No existing functionality is broken. The missing reads are quality-of-life gaps that block richer monitoring (drift detection, rebalance scheduling). The missing writes block the keeper workflow once `KEEPER_ROLE` is granted (see `issue-keeper-role-not-granted.md`).

## 2. Missing read-only functions

These exist in `contracts/RobotMoneyVault.sol` and are useful today:

| Function | Signature | What it returns |
|---|---|---|
| `isRebalanceAvailable` | `() → bool` | Whether `minRebalanceInterval` has elapsed since `lastRebalanceAt` |
| `nextRebalanceAt` | `() → uint256` | Unix timestamp of the earliest next allowed `rebalance()` call |
| `getAdapterDrift` | `() → (uint256[], uint256[], int256[])` | Per-adapter current balance, target balance, and drift (current − target) |
| `activeAdapterCount` | `() → uint256` | Count of active adapters (more useful than `adapterCount()` which includes inactive) |
| `currentTargetBps` | `() → uint256` | Equal-weight target in bps (`MAX_BPS / activeAdapterCount`) |
| `isShutdown` | `() → bool` | Alias for the `shutdown` state variable |

Note: `adapterCount()` is in the CLI ABI but returns the total registry length including deactivated adapters. `activeAdapterCount()` is what most callers want.

## 3. Missing write functions

These should be added once the keeper workflow is defined:

| Function | Signature | Caller |
|---|---|---|
| `rebalance` | `() → void` | ADMIN or KEEPER (once granted) |
| `adminRebalance` | `(uint256[] calldata targetBalances) → void` | ADMIN only |
| `hasRole` | `(bytes32 role, address account) → bool` | Read-only; from AccessControl; lets CLI verify KEEPER_ROLE |
| `grantRole` | `(bytes32 role, address account) → void` | ADMIN only |

`hasRole` is an AccessControl standard function — it lets a CLI or agent confirm that a given keeper address has the correct role before attempting `rebalance()`.

## 4. Impact on SKILL.md and monitoring

`getAdapterDrift()` is particularly valuable for treasury monitoring: it tells an agent whether the vault is materially unbalanced before triggering a rebalance. `isRebalanceAvailable()` and `nextRebalanceAt()` let an autonomous keeper schedule the call correctly without guessing.

Without these in the ABI:
- `get-vault --verbose` cannot show drift
- The keeper workflow in `issue-keeper-role-not-granted.md` cannot be implemented
- An agent running `rebalance()` has no pre-call check other than catching `RebalanceTooSoon`

## 5. Proposed changes to `lib/abi.ts`

```typescript
// Add to VAULT_ABI:

// ─── Rebalance ───
{ type: 'function', name: 'rebalance', stateMutability: 'nonpayable', inputs: [], outputs: [] },
{
  type: 'function', name: 'adminRebalance', stateMutability: 'nonpayable',
  inputs: [{ name: 'targetBalances', type: 'uint256[]' }], outputs: []
},
{ type: 'function', name: 'isRebalanceAvailable', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
{ type: 'function', name: 'nextRebalanceAt', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
{ type: 'function', name: 'lastRebalanceAt', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },

// ─── Adapter views ───
{ type: 'function', name: 'activeAdapterCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
{ type: 'function', name: 'currentTargetBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
{
  type: 'function', name: 'getAdapterDrift', stateMutability: 'view', inputs: [],
  outputs: [
    { name: 'currentBalances', type: 'uint256[]' },
    { name: 'targetBalances', type: 'uint256[]' },
    { name: 'drifts', type: 'int256[]' }
  ]
},

// ─── Shutdown / emergency ───
{ type: 'function', name: 'isShutdown', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },

// ─── AccessControl ───
{
  type: 'function', name: 'hasRole', stateMutability: 'view',
  inputs: [{ name: 'role', type: 'bytes32' }, { name: 'account', type: 'address' }],
  outputs: [{ type: 'bool' }]
},

// ─── Rebalance events (for log parsing) ───
{ type: 'event', name: 'Rebalanced', inputs: [{ name: 'totalMoved', type: 'uint256', indexed: false }] },
{ type: 'event', name: 'Allocated', inputs: [{ name: 'index', type: 'uint256', indexed: true }, { name: 'adapter', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
{ type: 'event', name: 'Pulled', inputs: [{ name: 'index', type: 'uint256', indexed: true }, { name: 'adapter', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
```

## 6. Acceptance criteria

- All nine missing functions are added to `VAULT_ABI` in `lib/abi.ts`.
- `get-vault --verbose` output is extended to include `isRebalanceAvailable`, `nextRebalanceAt`, and `getAdapterDrift` results.
- `activeAdapterCount()` replaces the computed `_activeAdapterCount` in the existing `get-vault` response (currently computed client-side from the adapter array).
- Unit tests updated to cover the new ABI entries.
- No existing tests broken (adding entries to an ABI is non-breaking).

## 7. References

- Vault source (full function list): [`../../contracts/RobotMoneyVault.sol`](../../contracts/RobotMoneyVault.sol)
- CLI ABI (incomplete): [`../../packages/cli/src/lib/abi.ts`](../../packages/cli/src/lib/abi.ts)
- Related: [`issue-keeper-role-not-granted.md`](issue-keeper-role-not-granted.md)
