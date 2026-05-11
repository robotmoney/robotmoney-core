# Robot Money — Security Code Review

**Date:** 2026-05-08  
**Reviewer:** Claude (claude-sonnet-4-6)  
**Scope:** Full codebase — `contracts/`, `clients/rust-payment-client/`, `services/explorer-indexer/`, `clients/dapp/`  
**Anchor docs:** `docs/prd.md`, `docs/architecture.md`, `docs/security-model.md`

---

## Review Methodology

1. Read product, architecture, and security-model docs to establish threat model and stated mitigations.
2. Read all deployed contract source (`RobotMoneyVault.sol`, `RobotMoneyGateway.sol`, `AccessRoles.sol`, all three adapters).
3. Read the Rust client's critical paths: `signer/software.rs`, `commands/deposit.rs`, `policy/mod.rs`, `config.rs`, `replay_cache.rs`, `rpc/mod.rs`, `tx/mod.rs`, `nonce/mod.rs`, `fees/mod.rs`, `logging.rs`, all `commands/*.rs` read subcommands, and `gateway/mod.rs`.
4. Read the explorer indexer: `indexer.rs`, `db.rs`, `rpc.rs`, `abi.rs`, `main.rs`.
5. Read the explorer API: `routes.rs`, `model.rs`, `error.rs`, `state.rs`, `main.rs`.
6. Read the dapp: all components (`AdminFlow`, `PauseFlow`, `TxPreview`, `ConfigExportPanel`, `HistoryPane`) and all lib modules (`abi.ts`, `preview.ts`, `explorerApi.ts`, `featureFlags.ts`, `wagmi.ts`).
7. Read the test harness: `testing/ethereum-testnet/e2e-rust/src/lib.rs`.
8. Cross-referenced every finding against the team's own `docs/security-model.md` to distinguish "known gap" from "unknown gap" and to avoid re-annotating what is already triaged.

The review is constructive and focused on correctness, not completion. Findings are ordered by blast radius.

---

## Summary

The codebase shows careful, disciplined engineering throughout. The gateway access layer, the Rust signer, and the on-chain role separation are all well-constructed. The security model document is unusually honest and thorough for an early-stage project — that alone is a strong foundation.

The most important issues are two related gaps in the vault's asset accounting model. One is a classic ERC-4626 correctness bug (missing virtual shares offset); the other is a non-standard `totalAssets()` implementation that excludes idle vault-resident USDC. Both have concrete user-fund impact at the moment real depositors arrive.

---

## Findings

---

### Finding 1 — HIGH: ERC-4626 First-Depositor Share Inflation via External Protocol Donation

**File:** `contracts/RobotMoneyVault.sol:151`  
**Category:** Accounting / ERC-4626 invariant  
**Confidence:** 0.95

#### Code

```solidity
function _decimalsOffset() internal pure override returns (uint8) { return 0; }
```

#### Description

The OpenZeppelin ERC-4626 implementation defends against first-depositor share-price manipulation by applying a virtual offset via `_decimalsOffset()`. Returning `0` disables this protection entirely, leaving the classic inflation attack open.

The vault's `totalAssets()` sums `adapter.totalAssets()` across all active adapters. For `AaveV3Adapter`, this is `A_TOKEN.balanceOf(address(adapter))`. Aave's `Pool.supply` function accepts an `onBehalfOf` parameter. An attacker can supply USDC directly to Aave on behalf of the adapter contract — crediting aTokens to the adapter — without interacting with the vault at all. The same donation path exists for Morpho (via `MORPHO_VAULT.deposit(amount, adapter)`) and Compound (via `COMET.supply` which credits the adapter's position).

#### Exploit Scenario

1. Attacker calls `vault.deposit(1)` (1 wei USDC). Receives 1 share. `totalSupply = 1`, `totalAssets = 1`.
2. Attacker calls `aavePool.supply(usdc, 1_000_000e6, AaveV3Adapter, 0)` — donates 1,000,000 USDC worth of aTokens directly to the adapter. `totalAssets` rises to `1_000_001e6`. `totalSupply` stays at 1.
3. Victim submits a deposit of 999_999e6 USDC.
4. OZ ERC-4626 computes `shares = 999_999e6 * 1 / 1_000_001e6 = 0` (floor rounding). Deposit reverts.
5. Victim must deposit more than `totalAssets` to get even 1 share (at minimum 1,000,002e6 USDC).
6. Once the victim deposits enough for 1 share, the attacker holds 1 share against a pool worth ~2× the victim's deposit and redeems at a profit equal to roughly half the victim's principal.

This does not require a flash loan; the attacker only needs capital for the initial donation. The capital is recoverable through the attacker's 1 share once a victim deposits.

#### Team's Current Status

`docs/security-model.md §3` marks this "Unaddressed" and calls it the top-priority triage item. This review confirms that assessment and adds the concrete cross-protocol donation path, which was not described in the triage note.

#### Recommendation

```solidity
// Minimum safe: adds 1 virtual share and 10^18 virtual USDC,
// making rounding manipulation economically infeasible.
function _decimalsOffset() internal pure override returns (uint8) { return 18; }
```

Note: `decimals()` returns 6. The offset operates on the internal share accounting and does not affect the share token's human-readable decimals. With offset 18, `previewDeposit(1e6)` for a fresh vault returns `1e6 * 1e18 / 1e18 = 1e6` — normal behaviour. An attacker donating `X` USDC to inflate the price would need to donate >10^18 times more than the virtual floor, which makes the attack economically inviable.

Additionally, document an explicit admin-seed procedure: the admin should deposit a minimum seed amount (e.g., 1000 USDC) immediately after deployment and before opening the vault to the public. This ensures `totalAssets` is never 1 at the point of first public deposit.

---

### Finding 2 — HIGH: `totalAssets()` Excludes Idle USDC in the Vault Contract

**File:** `contracts/RobotMoneyVault.sol:155-162`  
**Category:** Accounting correctness  
**Confidence:** 0.92

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

#### Description

ERC-4626's canonical invariant is `totalAssets() == balanceOf(underlying, address(this)) + balance in yield positions`. This implementation counts only yield positions (adapter balances) and silently ignores USDC that sits in the vault contract itself.

USDC can accumulate in the vault in at least two ways without triggering a revert:

**Path A — Routing overflow:** `_routeDeposit()` (called from `_deposit`) runs two allocation passes but has no revert if `remaining > 0` after both. If all adapter caps are at their configured maximum, the unrouted USDC stays in the vault. Shares were already minted (via `super._deposit()` before `_routeDeposit`), and the caller receives no indication that their funds are not earning yield.

**Path B — Direct transfer:** Any address can call `USDC.transfer(vault, amount)` directly. These funds are fully outside `totalAssets()`.

#### Impact

When idle USDC is present, `totalAssets()` understates the vault's true NAV:

- The **TVL cap check** (`totalAssets() + assets > tvlCap`) under-counts current exposure, allowing more deposits than the policy intends.
- The **share issuance price** (`assets * totalSupply / totalAssets`) is too low, so the next depositor receives more shares than they are entitled to at the expense of existing holders. When idle USDC is later deployed by `rebalance()`, those inflated shares become a permanent dilution of prior depositors.
- The combination with Finding 1 is especially dangerous: an attacker can donate USDC directly to the vault (inflating the idle balance), then deposit normally against the understated `totalAssets()` to receive over-priced shares.

#### Recommendation

Include the vault's own USDC balance in `totalAssets()`:

```solidity
function totalAssets() public view override returns (uint256) {
    uint256 sum = IERC20(asset()).balanceOf(address(this)); // idle balance
    uint256 len = adapters.length;
    for (uint256 i = 0; i < len; i++) {
        if (adapters[i].active) sum += adapters[i].adapter.totalAssets();
    }
    return sum;
}
```

Also add a revert in `_routeDeposit` if `remaining > 0` after both routing passes, or emit a named event so the operator knows funds are sitting idle:

```solidity
if (remaining > 0) {
    emit UnroutedDeposit(remaining); // or: revert RoutingFailed(remaining);
}
```

---

### Finding 3 — MEDIUM: `RobotMoneyGateway.deposit()` Violates CEI — State Updated After External Call

**File:** `contracts/gateway/RobotMoneyGateway.sol:241-279`  
**Category:** Reentrancy / CEI violation  
**Confidence:** 0.85

#### Code

```solidity
// Step 6: paymentId CHECK — usedPaymentIds not yet set
if (usedPaymentIds[paymentId]) revert PaymentIdAlreadyUsed();

// Step 7: transfer USDC from agent to gateway
usdcToken.safeTransferFrom(msg.sender, address(this), amount);

// Step 9: INTERACTION — external vault call (potential callback)
sharesMinted = vaultContract.deposit(amount, p.shareReceiver);

// Step 11: EFFECTS — state written AFTER the external call
agentWindowGross[msg.sender][windowId] = windowSoFar + amount;
usedPaymentIds[paymentId] = true;
```

#### Description

The gateway marks `usedPaymentIds` and updates `agentWindowGross` *after* calling `vaultContract.deposit()`. This is a classic CEI (Checks-Effects-Interactions) violation. If `vaultContract.deposit()` triggers a callback path that re-enters `gateway.deposit()` before step 11 completes, a second deposit with the same `paymentId` parameters will pass the `PaymentIdAlreadyUsed` check (because the flag is not yet set) and the window-cap check (because `agentWindowGross` is not yet updated).

#### Current Exploitability

With the *current deployed contracts*, this path is not exploitable because:
- The vault uses standard USDC (no ERC-777 or transfer-callback surface).
- The vault's `_deposit` calls `super._deposit` which does a `safeTransferFrom` from the *gateway* to the vault — no callback to the original `msg.sender` (the agent).
- Adapters use standard ERC-20 supply/deposit and do not trigger callbacks to the gateway caller.

However, this is a fragile safety property. It depends on the upstream behaviour of three external protocols remaining callback-free. USDC is upgradeable by Circle. Morpho, Compound, and Aave have each had protocol upgrades. If any of these introduces a receiver callback (as ERC-777, ERC-1363, or similar hooks do), the reentrancy path opens without any change to the gateway code.

Agent accounts are also permitted to be smart contracts (the architecture does not restrict `AGENT_ROLE` to EOAs). A contract agent with a controlled `receive()` or `fallback()` triggered by share delivery to `shareReceiver` (if it equals the agent) could construct a reentrant call path.

#### Recommendation

Apply CEI: write the effects before the external interaction.

```solidity
// EFFECTS first
agentWindowGross[msg.sender][windowId] = windowSoFar + amount;
usedPaymentIds[paymentId] = true;

// THEN interact
usdcToken.safeTransferFrom(msg.sender, address(this), amount);
usdcToken.forceApprove(address(vaultContract), amount);
sharesMinted = vaultContract.deposit(amount, p.shareReceiver);
usdcToken.forceApprove(address(vaultContract), 0);
```

Additionally, add `ReentrancyGuard` from OpenZeppelin to the gateway as a defense-in-depth measure, since the gateway holds USDC transiently.

---

### Finding 4 — MEDIUM: `MorphoAdapter.withdraw()` Returns Assumed Amount Without Verification

**File:** `contracts/adapters/MorphoAdapter.sol:49-52`  
**Category:** Accounting correctness  
**Confidence:** 0.90

#### Code

```solidity
function withdraw(uint256 amount) external onlyVault returns (uint256) {
    MORPHO_VAULT.withdraw(amount, VAULT, address(this));
    return amount;  // ← unconditionally trusts the requested amount was delivered
}
```

Compare with the Aave and Compound adapters, which both verify the actual received amount:

```solidity
// AaveV3Adapter
uint256 actual = POOL.withdraw(address(USDC), amount, VAULT);
if (amount != type(uint256).max && actual < amount) {
    revert WithdrawShortfall(amount, actual);
}
return actual;

// CompoundV3Adapter
uint256 preBalance  = USDC.balanceOf(address(this));
COMET.withdraw(address(USDC), amount);
uint256 postBalance = USDC.balanceOf(address(this));
uint256 actual      = postBalance - preBalance;
if (amount != type(uint256).max && actual < amount) {
    revert WithdrawShortfall(amount, actual);
}
return actual;
```

#### Description

`MorphoAdapter.withdraw()` calls `MORPHO_VAULT.withdraw(amount, VAULT, address(this))` and then returns `amount` — assuming the Morpho vault delivered exactly the requested USDC to `VAULT`. It does not check the vault's USDC balance before and after, nor does it check the return value of `MORPHO_VAULT.withdraw` (which returns the number of shares burned, not the amount transferred).

The Morpho ERC-4626 vault rounds share burns in favour of the vault (i.e., you burn slightly more shares than exact), but the USDC *delivered* to `VAULT` should be exactly `amount` per the ERC-4626 spec. In normal operation this assumption holds.

However, the adapter lies to the vault about what was actually received. If the assumption ever breaks — due to a Morpho protocol upgrade, a slippage condition, a downstream rounding edge case, or an ERC-20 fee-on-transfer-like path introduced in a future USDC version — the vault's `_pullProportional` will record more assets as withdrawn than were actually received. The vault would then overpay the withdrawing user (from idle USDC or subsequent depositors), causing fund loss to the pool.

This is an inconsistency with an already-deployed sibling contract (`AaveV3Adapter`) and creates an accounting gap that compounds with Finding 2.

#### Recommendation

Mirror the pattern used in the other adapters:

```solidity
function withdraw(uint256 amount) external onlyVault returns (uint256) {
    uint256 preBalance = USDC.balanceOf(VAULT);
    MORPHO_VAULT.withdraw(amount, VAULT, address(this));
    uint256 postBalance = USDC.balanceOf(VAULT);
    uint256 actual = postBalance - preBalance;
    if (amount != type(uint256).max && actual < amount) {
        revert WithdrawShortfall(amount, actual);
    }
    return actual;
}
```

---

### Finding 5 — MEDIUM: `RobotMoneyVault.unpause()` Accessible to `EMERGENCY_ROLE`, Not `ADMIN_ROLE`

**File:** `contracts/RobotMoneyVault.sol:422-423`  
**Category:** Access control / role asymmetry  
**Confidence:** 0.88

#### Code

```solidity
function pause() external onlyRole(EMERGENCY_ROLE) { _pause(); }
function unpause() external onlyRole(EMERGENCY_ROLE) { _unpause(); }
```

#### Description

The architecture document (`docs/architecture.md §6` and `§15`) establishes an asymmetric pause/unpause design as a security property: *pausing must be fast and unilateral; unpausing must be deliberate and restricted to a higher-trust role.*

This design is correctly implemented in `RobotMoneyGateway`:
- `pause()` requires `PAUSER_ROLE`
- `unpause()` requires `ADMIN_ROLE`
- The two roles are enforced disjoint by `AccessRoles._grantRole()`

The vault contradicts this model: a single `EMERGENCY_ROLE` holder can both pause and unpause. In the current deployment, `EMERGENCY_ROLE` is granted to the same multisig that holds `ADMIN_ROLE`, so there is no practical difference today. But the design intent is that a faster-moving emergency key (lower quorum, hardware-only, on-call) will eventually be configured as the pause key. If that emergency key also holds unpause authority, a compromise of that key can cycle the vault through pause/unpause states at will, facilitating timing attacks (e.g., front-running a withdrawal during a briefly open unpause window).

More concretely: `EMERGENCY_ROLE` can call `emergencyWithdraw()`, which pulls all adapter balances to the vault and pauses it. It can then call `unpause()`. Normal withdrawals from the vault can then proceed (including by the attacker, if they hold shares). This sequence does not violate the `rescueTokens` USDC guard, but it does mean a compromised emergency key has a path to liquidity that the architecture description does not intend.

#### Recommendation

Require `ADMIN_ROLE` (or a dedicated `KEEPER_ROLE`) for `unpause()`, mirroring the gateway:

```solidity
function pause()   external onlyRole(EMERGENCY_ROLE) { _pause(); }
function unpause() external onlyRole(ADMIN_ROLE)      { _unpause(); }
```

This is a configuration-level change with no functional impact on current deployments (both roles are held by the multisig today) but correctly encodes the intended security model for the day when the emergency key is delegated.

---

## Latent Risk: `db.rs::count()` Dynamic SQL Surface

**File:** `services/explorer-indexer/src/db.rs:379-386`  
**Not a current vulnerability — flagged as a footgun to track.**

```rust
pub async fn count(&self, table: &str) -> Result<i64, DbError> {
    // table is hard-coded by callers
    let q = format!("SELECT COUNT(*)::BIGINT FROM {}", table);
    let row: (i64,) = sqlx::query_as(&q).fetch_one(&self.pool).await?;
    Ok(row.0)
}
```

`count()` is a public method on `Db` that builds a dynamic SQL query from its `table: &str` argument. It is currently only called from integration tests with hardcoded table names. `sqlx` does not support placeholder binding for identifiers, so this pattern is the only way to accept a table name dynamically. If any API route handler or application code ever calls this method with a user-controlled string, it becomes a SQL injection vector. The comment says "we never accept user input here" — that invariant must be enforced structurally, not just by convention. Options: make the function `pub(crate)` instead of `pub`, replace it with a typed enum of valid table names, or remove it from production code and keep it in `#[cfg(test)]` only.

---

## Third-Pass Verification Addendum

The review above was re-checked by walking the Solidity callable surface and the Rust binary/API/indexer entry paths. The original HIGH contract accounting findings still stand. The follow-up pass found the additional implementation bugs below.

**Correction to Finding 1 remediation:** the recommendation to set `_decimalsOffset()` to `18` is directionally right for ERC-4626 inflation resistance, but the worked example in Finding 1 should be recalculated before implementation. OpenZeppelin's ERC-4626 virtual offset math uses virtual shares of `10 ** _decimalsOffset()` and virtual assets of `1`, so with this contract's explicit `decimals() == 6` override, a fresh `previewDeposit(1e6)` would not simply stay at `1e6` raw shares if `_decimalsOffset()` becomes `18`. The fix should choose share decimals and offset together, update tests around `previewDeposit`, `previewMint`, `previewWithdraw`, and `previewRedeem`, and document the intended raw-share scale.

---

### Finding 6 — MEDIUM: `rmpc` Replay Cache Key Does Not Match On-Chain `paymentId`

**Files:** `clients/rust-payment-client/src/replay_cache.rs:30-49`, `clients/rust-payment-client/src/commands/deposit.rs:301-315`, `contracts/gateway/RobotMoneyGateway.sol:239-245`
**Category:** Client idempotency / operational correctness
**Confidence:** 0.94

#### Code

```rust
// replay_cache.rs
pub fn key(order_id: &str, idempotency_key: &str, deadline: u64) -> String {
    format!(
        "{}|{}|{}",
        normalize_hex(order_id),
        normalize_hex(idempotency_key),
        deadline
    )
}
```

```solidity
// RobotMoneyGateway.sol
paymentId = keccak256(
    abi.encode(
        block.chainid, address(this), msg.sender, orderId, amount, idempotencyKey
    )
);
```

#### Description

The Rust replay cache is documented as a local guard that catches a previously submitted deposit before paying gas for an on-chain replay refusal. It does not actually key on the same tuple as the gateway.

The gateway deliberately excludes `deadline` and includes `block.chainid`, `address(this)`, `msg.sender`, `orderId`, `amount`, and `idempotencyKey`. The local cache includes only `orderId`, `idempotencyKey`, and `deadline`.

This creates both false negatives and false positives:

- A normal retry with the same order/idempotency key and amount but a fresh CLI-computed deadline misses the local cache, signs, broadcasts, and then reverts on-chain with `PaymentIdAlreadyUsed`.
- Two deposits with the same order/idempotency key and same deadline but different amounts collide locally even though the gateway would derive different `paymentId` values.
- Reusing a state directory across chains, gateways, or agent keys can create local cache collisions that cannot occur on-chain.

The on-chain protection still prevents duplicate deposits, so this is not a direct funds-loss issue. The bug is that the client-side "do not pay gas to discover the same dedupe on chain" guarantee is not true.

#### Recommendation

Make the cache key equal to the on-chain idempotency domain. The simplest implementation is to compute and store the same `paymentId` pre-broadcast:

```text
keccak256(abi.encode(chain_id, gateway_address, agent_address, order_id, amount, idempotency_key))
```

Then look up by that `paymentId` alone. Keep `deadline` as metadata in the JSON entry if useful for audit logs, but do not include it in the key.

Also update the replay-cache tests: `different_deadline_misses` should become `same_payment_id_hits_across_deadline_changes`, and add coverage that different `amount`, `chain_id`, `gateway`, or `agent` values do not collide.

---

### Finding 7 — MEDIUM: Indexer Reorg Detection Is Disabled When the Cursor Block Has No Stored Header

**File:** `services/explorer-indexer/src/indexer.rs:135-149`, `services/explorer-indexer/src/indexer.rs:197-203`, `services/explorer-indexer/src/indexer.rs:264-267`, `services/explorer-indexer/src/indexer.rs:273-299`
**Category:** Indexer correctness / reorg handling
**Confidence:** 0.90

#### Code

```rust
// Reorg check only runs if there is a stored hash for last_indexed_block.
if let Some(li) = last_indexed {
    if let Some(stored_hash) = db.get_block_hash(cfg.chain_id, li).await? {
        if let Some(header) = rpc.block_header(li as u64).await? {
            if header.hash.0 != stored_hash {
                let root = walk_back_to_match(db, rpc, cfg.chain_id, li).await?;
                db.delete_above_block(cfg.chain_id, root).await?;
                last_indexed = if root < 0 { None } else { Some(root) };
                reorg_detected = true;
            }
        }
    }
}
```

```rust
// But headers are only inserted for blocks with watched events.
for &bn in &blocks_with_events {
    let (header, txs) = rpc.block_with_txs(bn).await?;
    db.insert_block(...).await?;
}

// The cursor still advances to target, even when target had no stored header.
last_indexed_block: Some(target as i64),
```

#### Description

The indexer advances `last_indexed_block` to the safe target every tick, but it only inserts `blocks` rows for blocks containing watched events. Most blocks will not contain watched Robot Money events. On the next tick, if the previous cursor block had no event, `db.get_block_hash(chain_id, last_indexed_block)` returns `None` and the reorg check silently does nothing.

`walk_back_to_match` has the same problem: it treats a missing stored hash as a clean root:

```rust
} else {
    // No stored hash for this height → already a clean root.
    return Ok(n);
}
```

That is not a valid reorg proof. It means a reorg can leave stale `agent_deposits`, `agent_policies`, `transactions`, and `vault_snapshots` rows in Postgres whenever the cursor sits on a no-event block, which is the common case. The API then serves stale indexed data as canonical history.

#### Exploit / Failure Scenario

1. Tick 1 indexes blocks `100..200`. A gateway deposit happened in block `150`, so block `150` and its event rows are stored. Block `200` had no watched event, so no `blocks` row for `200` is stored.
2. The run records `last_indexed_block = 200`.
3. A reorg replaces block `150`.
4. Tick 2 checks `get_block_hash(chain_id, 200)`, gets `None`, and skips reorg recovery.
5. The stale deposit from old block `150` remains in `agent_deposits` and can be returned by `/v1/deposits/:deposit_id` and `/v1/agents/:address/deposits`.

#### Recommendation

Persist at least the cursor block header (`target`) on every successful tick, even when no watched event occurred in that block. A stronger fix is to persist all safe-head cursor headers needed for reorg proofs, but the minimum is:

- fetch and insert the `target` header before recording `last_indexed_block = target`;
- make `walk_back_to_match` continue walking back on missing stored hashes instead of treating them as a clean root;
- add an integration test where the first run advances through a no-event target block, a stored event block below it is reorged, and the next run deletes rows above the true matching root.

---

### Finding 8 — LOW: Explorer API Queries Cross Chain Boundaries

**File:** `clients/explorer-api/src/routes.rs:211-215`, `clients/explorer-api/src/routes.rs:236-240`, `clients/explorer-api/src/routes.rs:259-263`, `clients/explorer-api/src/routes.rs:286-290`
**Category:** API correctness / multi-chain data isolation
**Confidence:** 0.82

#### Code

```rust
// get_agent
SELECT block_number, revoked, max_per_window FROM agent_policies
WHERE agent = $1 ORDER BY block_number DESC, log_index DESC LIMIT 1

// list_agent_deposits
SELECT ... FROM agent_deposits WHERE agent = $1

// get_transaction
SELECT ... FROM transactions WHERE tx_hash = $1 LIMIT 1

// get_deposit
SELECT ... FROM agent_deposits WHERE payment_id = $1 LIMIT 1
```

#### Description

The indexer schema is explicitly multi-chain: every relevant table includes `chain_id`, and the `/v1/chains/:chain_id/contracts` endpoint already exposes chain-scoped reads. Several other API routes ignore `chain_id` entirely.

If the same database ever stores more than one chain, these endpoints can return the wrong chain's latest policy, deposit list, transaction, or deposit. The most likely user-visible failure is `/v1/agents/:address`, because the same EOA address often exists on many EVM chains and the query orders only by block number/log index across all chains.

This is not a current single-chain deployment vulnerability, but it is a real implementation bug relative to the schema and route set.

#### Recommendation

Choose and enforce one API contract:

- If the service is single-chain, configure a server-side `chain_id` in `AppState` and bind it in every query.
- If the service is multi-chain, add `chain_id` to the affected paths or query parameters and require it for ambiguous resources.

At minimum, add tests with two chains sharing the same agent address and prove `/v1/agents/:address` cannot return the other chain's policy.

---

## What the Team Got Right

This section is not courtesy — these are genuine strengths worth keeping as the project scales:

- **Gateway CEI on USDC transfer:** The USDC `safeTransferFrom` with pre/post balance verification (`FeeOnTransferDetected`) correctly defends against fee-on-transfer tokens. This is often missed.
- **Residual allowance clearing:** Both the gateway and all three adapters zero out ERC-20 allowances after each use. Correct.
- **`_decimalsOffset` is at least overridden:** The override is present; it just returns the wrong value. This is a one-line fix, not an architectural rework.
- **Code hash pin in `rmpc`:** Verifying `keccak256(eth_getCode(gateway))` before signing is a strong defense against a malicious RPC substituting a different contract address. Few clients do this.
- **Argon2id + AES-256-GCM keystore:** The software signer uses the correct primitives, proper AEAD (address bound as AAD), `zeroize` on drop, and explicit opt-in flag. The threat model for the software path is correctly stated in the warning log.
- **Role separation in the gateway:** `AccessRoles._grantRole()` enforcing pairwise disjointness at the contract level (not just by convention) is well-done.
- **No generic signing oracle:** The signer API (`sign_eip1559_hash`) only accepts pre-constructed hashes from the known calldata builder. The agent planner never touches a signing primitive.
- **`nonReentrant` on all state-mutating vault paths:** The vault correctly guards `_deposit`, `_withdraw`, `rebalance`, `adminRebalance`, and emergency paths.
- **`forceRemoveAdapter` exists:** The ability to write off a stuck adapter without a full pause is a practical safety valve that most vaults lack.

---

## Priority Order for Fixes

1. **Finding 1** (`_decimalsOffset = 0`) + **Finding 2** (`totalAssets` missing idle balance) — fix together. These two interact and both affect every depositor from day one. Zero-cost to fix at this stage; expensive to fix after TVL accumulates.
2. **Finding 4** (MorphoAdapter withdrawal amount) — one-line accounting fix; no deployment risk.
3. **Finding 3** (gateway CEI) — reorder six lines; add `ReentrancyGuard`. No semantic change to current behaviour.
4. **Finding 5** (vault unpause role) — one-line change; no functional impact today but encodes the correct invariant for when the emergency key is eventually delegated to a lower-quorum holder.
5. **Finding 7** (indexer reorg cursor/header bug) — fix before relying on explorer data for operator decisions; stale event rows can survive common no-event cursor ticks.
6. **Finding 6** (`rmpc` replay-cache key mismatch) — align local idempotency with on-chain `paymentId`; this is a small client patch plus tests.
7. **Finding 8** (API chain scoping) — fix before indexing more than one chain into the same database.
8. **Latent SQL surface** — access-scope change or test-only annotation; no deployment required.

---

---

## Second-Pass Coverage Notes

The first pass covered all smart contracts and the Rust client's critical signing/deposit paths. The second pass extended coverage to the full codebase. The following areas produced no new HIGH or MEDIUM findings but are noted for completeness.

### Explorer API (`clients/explorer-api/`)

All nine HTTP endpoints use fully parameterized `sqlx` queries. Path parameters (`address`, `tx_hash`, `deposit_id`) are validated with explicit byte-length checks before binding to `BYTEA` columns — `decode_address_param` enforces 42-char `0x` + exactly 20 hex bytes; `decode_hash_param` enforces 66-char `0x` + exactly 32 hex bytes. SQL errors are masked behind a generic "internal error" response with no detail leakage to clients. The router is GET-only (verified by the `router_introspection` test), which eliminates the entire class of write-path injection vectors.

**Functional gap — CORS not configured:** `clients/explorer-api/src/main.rs` starts Axum with no `CorsLayer`. The dapp's `HistoryPane` component fetches from `VITE_EXPLORER_API_URL` at runtime. In any production deployment where the dapp origin differs from the API origin (the common case), browser preflight will block every request silently. This is not a security issue — an absence of CORS headers is restrictive, not permissive — but it will cause the history pane to fail in every multi-origin deployment. Add `tower_http::cors::CorsLayer` with an explicit allow-origin policy before enabling the `historyPane` feature flag in production.

### `rmpc` Read-Side Commands

`get_agent.rs`, `get_allowance.rs`, `get_balance.rs`, `get_deposit.rs`, `get_gateway.rs`, `get_roles.rs`, `get_tx.rs`, `get_vault.rs`, `status.rs`, and `self_check.rs` all follow the same safe pattern: typed `alloy-sol-types` ABI encoding for `eth_call`, with explicit typed decoding of return values. No string interpolation into RPC parameters. The `status.rs` command filters logs by `B256::from_str(payment_id_hex)` before passing the value to the RPC — the value is parsed to a typed primitive and then re-serialized, not interpolated as a raw string. `self_check.rs` never emits the private key or passphrase in its output; it emits only the public address and a preflight snapshot.

### `gateway/mod.rs` (ABI bindings)

The ABI bindings are generated at compile time from committed JSON artifacts via `alloy-sol-types::sol!`. Selector cross-check tests (`deposit_selector_matches_canonical_signature`, `authorize_agent_selector_matches`, `agent_deposit_event_roundtrip`) run on every `cargo test` invocation and would catch any drift between the Rust bindings and the Solidity ABI. This is a good practice that several production clients skip.

### Dapp (`clients/dapp/`)

`preview.ts` enforces a hard refusal (`ok: false`) when `gatewayCodeHashVerified` is false, preventing the signing UI from activating against an unverified contract. The risk classifier marks pause/unpause on any non-fork environment as `"unsafe"`, which disables the `PauseFlow` buttons via the `!preview.ok` guard. The encode → decode round-trip check in `buildPreview` is an additional integrity guard that catches ABI encoding regressions at the UI layer. React's default HTML escaping means none of the rendered user/chain data creates an XSS surface.

### Testing harness

`testing/ethereum-testnet/e2e-rust/src/lib.rs` contains hardcoded test private keys (`DEPLOYER_PRIVATE_KEY_HEX`, `PAUSER_PRIVATE_KEY_HEX`, `AGENT_PRIVATE_KEY`). These are clearly labeled test-only with explicit warnings and the matching addresses appear in comments. The test chain (Geth devnet) has no real funds; these keys should never be used on mainnet or any funded network. This is standard practice for integration harnesses.

---

*Review conducted 2026-05-08. Full-codebase second pass completed same day. All referenced source is on the `dev` branch at commit `e54de4f` (most recent at review time). No audit tooling (Slither, Aderyn, Mythril) was run — this is a manual review. An automated pass before mainnet is strongly recommended.*
