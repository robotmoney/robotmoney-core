# Azimuth Client-Hardening Seam Map

> Phase: Azimuth client hardening
> Scout issue: #1073
> Canonical docs: `docs/code-review/20260623-code-review-testmachine-azimuth.md`
> Date: 2026-06-23

## 1. Purpose

This report documents three seams that downstream implementation issues (#1066,
#1068, #1069) depend on: ABI binding freshness for `commitAuthorization` /
`revealAuthorization`, the `ReplayCache` public API contract in
`replay_cache.rs`, and dapp component isolation between `OnboardingWizard`,
`AuthorizeTab`, and `AgentPoliciesPanel`.

## 2. ABI Bindings — commitAuthorization / revealAuthorization

**File:** `clients/dapp/src/lib/abi.generated.ts`
**Generator:** `bash .github/scripts/generate_abi_bindings.sh`

### Finding: bindings are current

The generated TypeScript ABI at `abi.generated.ts` was compared against the
live Solidity source in `contracts/gateway/RobotMoneyGateway.sol` and the
`IGateway.AgentPolicy` struct in `contracts/gateway/interfaces/IGateway.sol`.

| Function | Contract signature | Generated ABI |
|----------|--------------------|---------------|
| `commitAuthorization` | `commitAuthorization(bytes32 commitHash) external` | `bytes32` input named `commitHash`, no outputs, `nonpayable` — matches |
| `revealAuthorization` | `revealAuthorization(address agent, bytes32 salt, AgentPolicy calldata p) external` | `address agent`, `bytes32 salt`, `tuple p` with 11 struct components in declaration order — matches |

`AgentPolicy` struct field order in the ABI (11 fields):
`active` (bool), `validUntil` (uint64), `maxPerPayment` (uint256),
`maxPerWindow` (uint256), `shareReceiver` (address),
`allowedDestinations` (address[]), `assetRecipient` (address),
`maxWithdrawPerPayment` (uint256), `maxWithdrawPerWindow` (uint256),
`allowedSourceVaults` (address[]).

This matches the `IGateway.sol:51–62` struct declaration exactly.

**Conclusion for #1066:** No ABI regeneration needed before implementing the
commit/reveal flow in `OnboardingWizard` and `AuthorizeTab`. The wagmi call
sites can use `gatewayAbi` (which re-exports from `abi.generated.ts`) as-is.

### Build verification

`npm run build --workspace=clients/dapp` completed successfully (4813 modules
transformed, 0 type errors, 0 lint errors).

## 3. replay_cache.rs Public API Contract

**File:** `clients/rust-payment-client/src/replay_cache.rs`

A stable-API comment block was added to the module docstring (see §10 of
`docs/architecture.md` for canonical context). The block documents the
insert/remove/lookup lifecycle that downstream deposit-timeout and
withdraw-replay hardening (#1068, AZ-RPC-1 / AZ-RPC-2) must follow:

```
insert  — optimistic write at broadcast time; entry persists on success
remove  — rollback on revert or timeout; removes the poisoned entry
lookup  — pre-broadcast duplicate check; returns prior tx_hash or None
```

The `OP_WITHDRAW = 2u8` constant is already exported. Downstream PR #1068 must
use it (not `OP_DEPOSIT`) when building the paymentId for withdrawal entries so
that deposit and withdrawal entries remain disjoint.

**Cargo build verification:** `cargo build -p rust-payment-client` completed
successfully (no new compilation errors after the documentation annotation).

### Integration risks for #1068

- `replay_cache.rs` is touched by both the deposit-timeout path (AZ-RPC-1) and
  the withdraw-replay path (AZ-RPC-2). Both are in issue #1068, so there is no
  parallel-file conflict within that issue.
- `insert` / `remove` / `lookup` signatures are stable and must not change.
  Any new callers (e.g. `commands/withdraw.rs`) call the existing methods with
  `OP_WITHDRAW`-keyed paymentIds — no signature changes needed.
- `compute_payment_id` encodes `u8` op-kind as a `U256` (ABI-encode-compatible
  with Solidity `uint256`). Downstream callers must preserve this padding.

## 4. Dapp Component Isolation

**Files examined:**
- `clients/dapp/src/components/OnboardingWizard.tsx`
- `clients/dapp/src/components/AuthorizeTab.tsx`
- `clients/dapp/src/components/AgentPoliciesPanel.tsx`

### Finding: components are fully isolated

All three components live in separate files. Cross-import analysis:

| File | Imports from the other two? | Shared mutable state? |
|------|-----------------------------|-----------------------|
| `OnboardingWizard.tsx` | No | No |
| `AuthorizeTab.tsx` | No | No |
| `AgentPoliciesPanel.tsx` | No | No |

`OnboardingWizard` and `AuthorizeTab` both import `PolicyFields` (shared form
widget) and `TxPreview` (shared display component), but these are read-only
presentational helpers with no mutable state or side-effects visible across
component boundaries.

`AgentPoliciesPanel` imports only `viem` types and its own props interface —
no shared stores, no context producers that the other two consume.

**Conclusion for #1066, #1068, #1069:** Issues #1066 (OnboardingWizard +
AuthorizeTab), #1068 (rmpc replay cache), and #1069 (AgentPoliciesPanel share
allowance display) can proceed in parallel with no file-level merge conflicts
and no shared-state coupling.

### Vitest verification

`npx vitest run clients/dapp/tests/unit/` ran 547 tests across 60 test files
with 0 failures. No regressions from existing component test suites.

## 5. Integration handoff for downstream issues

### #1066 — fix(dapp): commit/reveal authorization flow

- Use `gatewayAbi` from `clients/dapp/src/lib/abi.ts` (re-exports from
  `abi.generated.ts`). Bindings for `commitAuthorization` and
  `revealAuthorization` are current — no regeneration needed before you land.
- `OnboardingWizard.tsx` and `AuthorizeTab.tsx` are independent files; your
  changes will not conflict with #1069 which only touches `AgentPoliciesPanel`.
- `PolicyFields.tsx` is a shared import — coordinate if you need to change its
  props interface.

### #1068 — fix(rmpc): replay-cache hardening

- `replay_cache.rs` insert/remove/lookup contract is documented in the module
  docstring. Read it before implementing AZ-RPC-1 (timeout → remove) and
  AZ-RPC-2 (withdraw replay protection).
- Use `OP_WITHDRAW = 2u8` for withdraw paymentIds. Do not change existing
  function signatures.
- No file-level conflict with #1066 or #1069 (different language / module).

### #1069 — fix(rmpc,dapp): shareReceiver allowance display

- `AgentPoliciesPanel.tsx` is fully isolated. Your changes will not conflict
  with #1066 (different component files).
- `AgentPolicy.shareReceiver` is present in the generated ABI at the correct
  field position (index 4 in the components array). No ABI changes needed.
