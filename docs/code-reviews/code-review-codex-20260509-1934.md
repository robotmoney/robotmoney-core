# Robot Money — Security Code Review

**Date:** 2026-05-09  
**Reviewer:** Codex (GPT-5), acting as an external blockchain-security CTO  
**Scope:** Full codebase pass with emphasis on `contracts/`, `clients/rust-payment-client/`, `clients/dapp/`, `services/explorer-indexer/`, and `clients/explorer-api/`  
**Anchor docs:** `docs/prd.md`, `docs/architecture.md`, `docs/technical/security-model.md`, `docs/implementation-plan.md`

---

## Review Methodology

1. Read the PRD and security model to understand what the system promises: pooled USDC, synchronous redemption, bounded agent authority, observable state, and no silent partial success.
2. Reviewed deployed Solidity surfaces: `RobotMoneyVault.sol`, all adapters, `RobotMoneyGateway.sol`, `AccessRoles.sol`, and gateway interfaces/tests.
3. Reviewed critical Rust client paths: config loading, preflight, signing, nonce locking, deposit submission, and dapp-config round-trip tests.
4. Reviewed the admin dapp transaction-preview and config-export paths.
5. Reviewed explorer indexer/API state-ingestion, reorg, snapshot, and response-error surfaces.
6. Compared findings against existing `docs/technical/security-model.md` rows to distinguish implementation bugs from already-acknowledged residual risk.

This was a static review. I did not run a full test suite or mainnet-fork exploit harness.

---

## Summary

This project has more security discipline than most early DeFi repos: the gateway is narrow, role separation is explicit, `rmpc` preflight is thoughtful, explorer errors are masked, and the security model is unusually candid.

The hard criticism: the core vault accounting is not yet production-grade. The same class of ERC-4626 accounting bugs that has repeatedly hurt vault protocols is present here in multiple forms. Until those are fixed and regression-tested on a fork, I would not accept public deposits.

The second concern is security-contract drift across surfaces. The dapp claims bytecode-hash verification without performing it, and the dapp-exported config is knowingly not the `rmpc` loader format. Those are not fund-drain bugs by themselves, but they erode the operator guarantees the rest of the system is carefully trying to build.

---

## Findings

---

### Finding 1 — HIGH: ERC-4626 Inflation Protection Is Disabled

**File:** `contracts/RobotMoneyVault.sol:237`  
**Category:** Vault accounting / first-depositor attack  
**Confidence:** 0.95

#### Code

```solidity
function _decimalsOffset() internal pure override returns (uint8) {
    return 0;
}
```

#### Description

OpenZeppelin ERC-4626's virtual-share defense depends on `_decimalsOffset()`. Returning `0` removes that defense, making the vault economically sensitive to first-depositor and donation-based share-price manipulation.

This vault is especially exposed because `totalAssets()` is derived from live adapter balances. An attacker does not need to transfer assets through the vault to manipulate those balances. They can credit Aave aTokens to the adapter via `supply(..., onBehalfOf = adapter)`, deposit into the Morpho ERC-4626 vault for the adapter as receiver, or otherwise donate into protocol positions where the adapter's reported balance rises without new vault shares being minted.

The result is a classic pattern:

1. Attacker seeds the vault with a dust deposit and receives nearly all outstanding shares.
2. Attacker donates assets into an adapter position credited to the adapter.
3. Victim deposits against an inflated `totalAssets()` / tiny `totalSupply()` ratio.
4. Victim receives too few shares or reverts until depositing a very large amount.
5. Attacker redeems a disproportionate share of vault value.

#### Impact

Loss of depositor funds or a public vault that can be cheaply griefed before meaningful liquidity arrives. This is a launch blocker.

#### Recommendation

Set a non-zero decimals offset and test the economics explicitly:

```solidity
function _decimalsOffset() internal pure override returns (uint8) {
    return 18;
}
```

Add fork tests for all supported adapters proving that external donations to Aave, Morpho, and Compound positions cannot make a later depositor receive economically unfair shares. Also document an admin seed procedure, but do not rely on seed deposits as the only mitigation.

---

### Finding 2 — HIGH: `totalAssets()` Excludes Idle USDC and `_routeDeposit()` Allows Silent Residue

**File:** `contracts/RobotMoneyVault.sol:244`, `contracts/RobotMoneyVault.sol:270`  
**Category:** ERC-4626 invariant / silent partial success  
**Confidence:** 0.95

#### Code

```solidity
function totalAssets() public view override returns (uint256) {
    uint256 sum = 0;
    uint256 len = adapters.length;
    for (uint256 i = 0; i < len; i++) {
        if (adapters[i].active) sum += adapters[i].adapter.totalAssets();
    }
    return sum;
}
```

`_routeDeposit()` decrements `remaining`, but it never reverts or emits if `remaining > 0` after both allocation passes.

#### Description

An ERC-4626 vault's `totalAssets()` should include all underlying assets controlled by the vault. This implementation excludes USDC sitting directly in the vault contract.

Idle USDC can appear through direct transfer, rounding, cap configuration where active adapter caps sum below 100%, or any allocation residue left after `_routeDeposit()`. The user-facing product promise says there are no silent partial successes; this path silently mints shares while leaving some deposited USDC outside reported NAV and outside yield.

#### Impact

The accounting consequences are severe:

- TVL cap checks undercount actual USDC controlled by the vault.
- Share issuance can dilute existing holders because new deposits are priced against an understated NAV.
- Later `rebalance()` routes idle USDC into adapters, crystallizing the prior mispricing.
- Operators and explorers using `totalAssets()` see a false treasury value.

#### Recommendation

Include idle USDC in `totalAssets()`:

```solidity
uint256 sum = IERC20(asset()).balanceOf(address(this));
```

Then decide whether deposit routing must be atomic. My recommendation is to revert if `remaining > 0` after `_routeDeposit()` unless the product explicitly accepts idle cash. If idle cash is accepted, emit a dedicated `UnroutedDeposit(amount)` event and surface idle balance in explorer/API outputs.

---

### Finding 3 — MEDIUM: Morpho Withdrawals Return the Requested Amount Without Verifying Delivery

**File:** `contracts/adapters/MorphoAdapter.sol:57`  
**Category:** Adapter accounting / external-protocol assumption  
**Confidence:** 0.90

#### Code

```solidity
function withdraw(uint256 amount) external onlyVault returns (uint256) {
    MORPHO_VAULT.withdraw(amount, VAULT, address(this));
    return amount;
}
```

#### Description

The Aave and Compound adapters verify actual received assets or returned amounts. The Morpho adapter assumes the ERC-4626 withdrawal delivered exactly `amount` assets to the vault.

That is usually true for a well-behaved ERC-4626 vault, but security-critical accounting should not rely on "usually". The vault uses the adapter return value to reduce `remaining` during `_pullProportional()`. If the external vault ever delivers less than requested due to rounding, liquidity constraints, changed behavior, or a wrapper incompatibility, Robot Money records a full pull even if the vault did not receive full USDC.

#### Impact

Withdrawals can revert late, use unrelated idle USDC to mask a shortfall, or emit misleading `Pulled` amounts. In incident response, bad telemetry is not a small problem; it slows the operator's ability to distinguish upstream liquidity failure from local accounting failure.

#### Recommendation

Use the same balance-delta pattern as Compound:

```solidity
uint256 beforeBal = USDC.balanceOf(VAULT);
MORPHO_VAULT.withdraw(amount, VAULT, address(this));
uint256 actual = USDC.balanceOf(VAULT) - beforeBal;
if (actual < amount) revert WithdrawShortfall(amount, actual);
return actual;
```

Add a local custom error and a fork test against the configured Morpho vault.

---

### Finding 4 — MEDIUM: The Admin Dapp Treats Bytecode Verification as an Environment Flag

**File:** `clients/dapp/src/main.tsx:22`, `clients/dapp/src/lib/preview.ts:79`, `clients/dapp/src/components/AdminFlow.tsx:197`  
**Category:** Admin transaction integrity / frontend trust boundary  
**Confidence:** 0.88

#### Code

```typescript
const codeHashVerified = env.VITE_GATEWAY_CODE_HASH_VERIFIED !== "false";
```

The preview then treats that boolean as authoritative, and `writeContract()` submits privileged calls to `props.gatewayAddress`.

#### Description

The preview pipeline is designed around a strong claim: if bytecode is not verified, signing is refused. But the implementation does not fetch bytecode or compute a hash in the browser. It trusts a build-time environment variable, and it defaults to `true`.

That is the wrong default for an admin surface. A misconfigured build, compromised hosting pipeline, or accidental wrong `VITE_GATEWAY_ADDRESS` can still render "[bytecode verified]" and enable signing.

#### Impact

An operator can be induced to grant roles, revoke roles, pause, or unpause the wrong gateway contract while the dapp presents the action as verified. The wallet may still display the target address, but the project's own UX is supposed to reduce blind-signing risk; this implementation gives a false sense of assurance.

#### Recommendation

Make verification real and fail closed:

- Require `VITE_GATEWAY_RUNTIME_HASH`, not `VITE_GATEWAY_CODE_HASH_VERIFIED`.
- Fetch `eth_getCode(gatewayAddress)` through wagmi/viem.
- Compute `keccak256(code)` client-side.
- Disable every write path until observed hash equals the pinned hash.
- Default to unverified when any env var is missing.
- Reject the zero address at startup instead of rendering a usable admin surface.

---

### Finding 5 — MEDIUM: Dapp Config Export Does Not Produce a Directly Loadable `rmpc` Config

**File:** `clients/dapp/src/lib/configExport.ts:34`, `clients/rust-payment-client/src/config.rs:17`, `clients/rust-payment-client/tests/dapp_toml_roundtrip.rs:14`, `clients/dapp/src/components/AdminFlow.tsx:597`  
**Category:** Cross-surface contract drift / operator reliability  
**Confidence:** 0.92

#### Description

The dapp exports a namespaced TOML shape:

```typescript
contracts: { gateway: string; vault: string; gateway_code_hash: string };
```

The actual Rust loader expects flat fields:

```rust
pub gateway_address: String,
pub usdc_address: String,
pub vault_address: String,
pub gateway_runtime_hash: String,
```

The test suite acknowledges the mismatch and uses a translation layer. That means the artifact presented to an operator as an `rmpc` config is not, in fact, the config `rmpc` consumes directly.

There is also a concrete bad value: `AdminFlow` passes a hardcoded zero hash into `ConfigExportPanel`:

```typescript
gatewayCodeHash={"0x" + "00".repeat(32)}
```

#### Impact

Operators get a config that either fails preflight or requires undocumented manual transformation. That is an availability and reliability issue today. It can become a security issue if operators work around the failure by weakening code-hash checks or copying values from untrusted places.

#### Recommendation

Collapse the schema bridge now:

- Make the dapp emit exactly the `Config` struct accepted by `rmpc`, or teach `rmpc` to accept the documented namespaced schema directly.
- Include `usdc_address`, `state_dir`, and the exact `gateway_runtime_hash` in the emitted config.
- Remove the zero-hash placeholder.
- Change the round-trip test so `Config::from_str(dapp_toml)` is called directly, with no translation helper.

---

## Positive Observations

- `RobotMoneyGateway.deposit()` now follows CEI and is `nonReentrant`; the earlier replay/window reentrancy shape is addressed.
- `AccessRoles` enforces pairwise separation among admin, pauser, and agent roles.
- The Rust client pins chain id and gateway runtime hash before signing.
- Nonce locking is simple and defensible for a single-flight MVP.
- Explorer API database errors are logged server-side but masked from clients.
- Reorg handling has an explicit cursor-header fix and avoids treating missing block hashes as canonical roots.

---

## Priority Fix Order

1. Fix vault accounting: `_decimalsOffset`, idle USDC in `totalAssets()`, and `_routeDeposit()` residue behavior.
2. Add fork-level accounting tests that simulate direct donations into each adapter and direct USDC transfers into the vault.
3. Fix Morpho withdrawal verification.
4. Replace dapp env-boolean bytecode verification with real client-side hash verification.
5. Reconcile dapp config export and the `rmpc` loader into one schema.

My CTO-level launch gate would be: no public deposits until items 1–3 are fixed and tested; no admin dapp use for production roles until item 4 is fixed; no operator self-service agent onboarding until item 5 is fixed.
