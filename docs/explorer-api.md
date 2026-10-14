# Explorer API — Endpoint Contract Reference

> Canonical for: `clients/explorer-api/src/routes.rs`
> Schema source: `services/explorer-indexer/migrations/`
> Architecture: `docs/architecture.md §5.4`
> Schema decisions: `docs/technical/explorer-schema-decisions.md`

This document lists every endpoint the Explorer API exposes, their current
implementation status, and the planned extensions from Phase 5 data-layer
issues #654, #661, #675, and #695.

---

## Implemented endpoints (as of 2026-06-07)

| Method | Path | Handler | Status |
|--------|------|---------|--------|
| GET | `/health` | `health` | Implemented |
| GET | `/v1/chains/:chain_id/contracts` | `list_contracts` | Implemented |
| GET | `/v1/vault/snapshot/latest` | `get_vault_snapshot_latest` | Implemented |
| GET | `/v1/vault/snapshots` | `list_vault_snapshots` | Implemented |
| GET | `/v1/agents/:address` | `get_agent` | Implemented |
| GET | `/v1/agents/:address/deposits` | `list_agent_deposits` | Implemented |
| GET | `/v1/transactions/:tx_hash` | `get_transaction` | Implemented |
| GET | `/v1/deposits/:deposit_id` | `get_deposit` | Implemented |
| GET | `/v1/vaults` | `list_vaults` | Implemented |
| GET | `/v1/vaults/:address` | `get_vault` | Partial — see issue #675 |
| GET | `/v1/router/weights` | `get_router_weights` | Implemented |
| GET | `/v1/governance/proposals` | `list_proposals` | Implemented |
| GET | `/v1/governance/proposals/:id` | `get_proposal` | Implemented |
| GET | `/v1/governance/admin-events` | `list_admin_events` | Implemented (issue 1731) |
| GET | `/v1/stats` | `get_stats` | Implemented |
| GET | `/v1/router/state` | `get_router_state` | Implemented |
| GET | `/v1/accounts/:address/positions` | `get_account_positions` | Implemented |
| GET | `/v1/accounts/:address/history` | `get_account_history` | Partial — see issue #654 |
| GET | `/v1/accounts/:address/exclusion-claims` | `get_account_exclusion_claims` | Implemented (QA plan X7, issue 1820) |

### Index cursor, chain head and deposit state (issue 1731)

- `block_number` of `/v1/vaults`, `/v1/stats` and the other freshness headers, and `last_indexed_block` of `/health`, are the highest block an indexer run that finished **without an error** committed for the service's chain. They are never read from the newest `indexer_runs` row, which is the tick in flight or a failed tick. `block_number` 0 means nothing is indexed yet; `/health` then reports `last_indexed_block: null`.
- Depositors (issue 1766). `unique_depositors` on `/v1/stats` is the number of distinct addresses that currently hold shares in any of the vaults, so an address holding several vaults counts once and an address that redeemed everything does not count. The seed receiver counts while it holds the seed shares, and the deployer does not once it has redeemed. The balance is the latest `wallet_positions` row per vault and holder, which the indexer rolls forward on every vault `Deposit` (direct, router and gateway deposits all emit one) and back on every `Withdraw`. An address in `agent_deposits` or `router_deposit_legs` with no position row at all is also counted. This is an assumption, not an owner decision, and it is one SQL constant (`UNIQUE_DEPOSITORS_SQL` in `clients/explorer-api/src/routes.rs`). Plain share `Transfer` events are not indexed, so a holder who only received shares by transfer is not counted, and a sender who transferred all shares away is still counted.
- TVL (QA plan X2, DI-2). `total_tvl` on `/v1/stats` is the sum of the latest `vault_snapshots.total_assets` of every vault except those whose registry `status` is Retired (2). A DepositsPaused (1) vault still counts. The indexer keeps watching and snapshotting every vault whatever its status, so a retired vault (the old rmPROTO after its redeploy) still shows its live `total_assets` on `/v1/vaults` while its holders exit, and its exits still move positions and `unique_depositors`. The filter is one SQL constant (`TOTAL_TVL_SQL` in `clients/explorer-api/src/routes.rs`), tested by `endpoints::stats_total_tvl_leaves_out_retired_vaults`.
- Vault caps (issue 1741). `GET /v1/vaults` and `GET /v1/vaults/:address` serve, per vault, `tvl_cap` (the vault's `tvlCap()`), `per_deposit_cap` (`perDepositCap()`), `headroom` (`max(tvl_cap - total_assets, 0)`) and `snapshot_block`, all from the vault's latest `vault_snapshots` row and all in asset base units (USDC, 6 decimals) as decimal strings. `RobotMoneyVault` and every `BasketVault` declare both caps as `uint256 public`. A cap the indexer could not read is `null`, never `"0"`, and a `null` cap or `total_assets` makes `headroom` `null`: a client must show `null` as unknown. A real `"0"` means the chain reported 0 (a wound-down vault). `2^256-1` is the contract's "no cap" value. The registry `deposit_cap` field (always 0, the contract no longer has it) is gone from the API; the `vaults.deposit_cap` DB column remains but is unused. Migration 0018 resets old `vault_snapshots.tvl_cap = 0` rows to NULL (a failed read could not be told from a real zero); the next tick rewrites the latest snapshot, so afterwards a real zero cap (deposits blocked) is stored as `"0"`. `headroom` is `tvl_cap - total_assets` of the snapshot only: it ignores `perDepositCap`, `depositsPaused`, shutdown and retirement, which the on-chain `maxDeposit` folds in. The dapp labels it "TVL headroom (snapshot)" and shows a number only when the vault's resolved deposit state is open ("n/a (deposits closed)" when paused or retired, "unknown" otherwise). The caps are as of `snapshot_block`, which trails the index block by up to the snapshot heartbeat (a snapshot with an unknown cap is retaken on the next tick).
- `GET /v1/transactions/:tx_hash` (QA plan X6, DI-6) serves only transactions that carry a log the indexer watches. Hash, block and index come from the log, `from`, `to` and `status` from its receipt. Any other transaction answers 404, even one in an indexed block. A node that returned the log but has no receipt for it fails the indexer tick, so `status` is never a made-up 0.
- `GET /v1/vaults/:address` freshness (issue 1741): `block_number` is the index block (the same value as `/health` `last_indexed_block`), `chain_head_block` is the head the indexer last saw, and `vault.snapshot_block` is the block of the latest vault snapshot. `block_number` used to be the snapshot block, which made a healthy indexer look thousands of blocks behind. A client measures the lag as `chain_head_block - block_number` and labels `snapshot_block` separately.
- `GET /v1/router/weights` `current_weights` is the weight vector of the last `WeightsSet` **or** `DefaultWeightsSet` event, not the vector the router routes by. A passed vote (`WeightsSet`, `votedWeightsActive() == true`) overrides the default vector. The effective weights are read from the router itself (`getEffectiveWeights()`, `votedWeightsActive()`, `getWeights()`, `getDefaultWeights()`); the dapp's Router Governance tab does so, pinned to the deployment chain and only when the write-chain guard allows the read (otherwise "unknown"), and labels them `Effective: voted` or `Effective: default`.
- `chain_head_block` (on `/health`, `/v1/vaults` and `/v1/stats`) is the head the indexer last saw. `chain_head_block - block_number` is the lag (about 5 when healthy, because the indexer waits 5 confirmations). It is `null` until a tick has read a head.
- Chain and vault scope (QA plan X7, DI-9). `GET /v1/vault/snapshot/latest` requires `?contract=0x…` (the vault, the same parameter `/v1/vault/snapshots` takes) and returns that vault's newest snapshot on the served chain. Without the parameter it answers 400, a malformed address 400, and a vault with no snapshot 404. It used to return the newest row of the whole table, so with several vaults it answered whichever vault was read last. `GET /v1/chains/:chain_id/contracts` answers 404 for any chain other than the one the service serves (`EXPLORER_API_CHAIN_ID`); it used to list another chain's rows from a shared database. Tested by `endpoints::latest_snapshot_is_chain_and_vault_scoped` and `endpoints::list_contracts_serves_only_the_configured_chain`.
- Exclusion claims (QA plan X7, issue 1820). When a `RobotMoneyVault` excludes a funded adapter, its `ExclusionLedger` opens a record with a snapshot of the vault's shares. USDC later recovered from the adapter goes to the record, not to the vault, and belongs pro rata to the holders at the snapshot, including holders who have since exited. `GET /v1/accounts/:address/exclusion-claims` lists, per record the address held shares at, `vault`, `exclusion_ledger`, `exclusion_id`, `adapter`, `adapter_index`, `opened_block`, `snapshot_supply`, `balance_at` (the holder's shares at the snapshot), `recovered_usdc`, `claimed_usdc` (paid to this holder), `claimable_usdc` and `finalized` / `finalize_reason` (`restored`, `removed` or `force_removed`; a closed record stays claimable), plus `total_claimable_usdc`. `claimable_usdc` is `floor(recovered_usdc * balance_at / snapshot_supply) - claimed_usdc`, never below 0, the ledger's own formula and rounding. The indexer derives each vault's ledger address (the vault's first contract creation), stores the ledger's four events, and reads `balanceAt(holder, id)` from the chain for every address with a deposit or withdrawal in the vault at or before the snapshot, and for any other address when it first claims. A holder who only received shares by a plain transfer and has not claimed is not listed; the ledger's `claimable(id, holder)` is the authority. Tested by `endpoints::account_exclusion_claims_are_pro_rata_to_the_snapshot` and `vault_detail::exclusion_record_events_store_each_snapshot_holders_balance`.
- Reorgs and the registries (QA plan X7, DI-8). `/v1/committee/agents` and `/v1/vaults` follow a reorg like every event list. A reorg that orphans an `AgentRevoked` makes the member active again, one that orphans a re-registration brings back the registration before it, and a member or a vault that only orphaned blocks registered disappears until the canonical chain registers it again. Tested by `reorg_cursor_vault_status::reorged_agent_revoke_is_undone` and `reorg_cursor_vault_status::reorged_vault_registration_is_undone`.
- Halt visibility (QA plan X5, DI-5). `/health` also reports `lag_blocks` (`chain_head_block - last_indexed_block`, `null` while either is `null`) and `last_run_error` (the `indexer_runs.error` of the newest finished run, `null` when it succeeded). `status` is `"degraded"` while `last_run_error` is set and `"ok"` otherwise; the HTTP status stays 200 so readiness probes are unaffected. A tick that reads the head and then fails still records that head, so a wedged indexer shows a growing `lag_blocks` and the error it repeats, instead of `ok` and a frozen lag of 5. Tested by `progress_and_admin::health_exposes_the_newest_run_error_and_the_head_lag`.
- `GET /v1/vaults` rows carry `deposits_paused`: the vault's `depositsPaused()` at its latest snapshot, `null` when it has none (read that as unknown, never as open). `status` is the registry lifecycle status and does not follow `pauseDeposits()`.
- `GET /v1/governance/admin-events` lists, newest first (at most 500), the events of the Timelock (`CallScheduled`, `CallExecuted`, `Cancelled`, `MinDelayChange`) and of the Safe (`ExecutionSuccess`, `ExecutionFailure`, `AddedOwner`, `RemovedOwner`, `ChangedThreshold`) when the indexer is given `INDEXER_TIMELOCK` and `INDEXER_SAFE`. Each entry has `block_number`, `log_index`, `tx_hash`, `contract`, `contract_kind` (`timelock` or `safe`), `event_name`, `op_id` (timelock operation id or Safe transaction hash) and `detail` (the decoded arguments). Both contracts are listed by `/v1/chains/:chain_id/contracts` with kinds `timelock` and `safe`.

---

## Implemented endpoint response bodies

### `GET /v1/accounts/:address/positions`

> **Handler:** `get_account_positions` (`clients/explorer-api/src/routes.rs`)
> **Wire types:** `AccountPositionsResponse` / `VaultPosition` (`clients/explorer-api/src/model.rs`)

Per-vault receipt-token balance and computed USDC value for one account.
One entry per vault where the address holds a non-zero share balance
(latest `wallet_positions` row), chain-scoped to `AppState::chain_id`.

**Request:**
```
GET /v1/accounts/{address}/positions
```

Path parameter `address`: 0x-prefixed Ethereum address (20 bytes hex).

**Response (200 OK):**
```json
{
  "address": "0x1111111111111111111111111111111111111111",
  "positions": [
    {
      "vault": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "shares": "1000000000000000000",
      "usdc_value": "1010000000000000000",
      "block_number": 12345678,
      "indexed_at": "2026-06-07T00:00:00Z"
    }
  ],
  "block_number": 12345678,
  "indexed_at": "2026-06-07T00:00:00Z"
}
```

Field reference (matches `VaultPosition` / `AccountPositionsResponse` exactly):

| Field | Type | Notes |
|-------|------|-------|
| `address` | string | Queried account, 0x-prefixed lower-case hex. |
| `positions` | array | One `VaultPosition` per vault with a non-zero balance; empty array (not 404) when the account holds none. |
| `positions[].vault` | string | **ERC-4626 vault contract address.** This is the authoritative field name for the vault address — there is no `vault_*` alias on the wire. |
| `positions[].shares` | string | Most recent indexed share balance (receipt-token units), `uint256` decimal string. |
| `positions[].usdc_value` | string \| null | USDC a redeem of `shares` pays at the latest snapshot, with `previewRedeem` semantics: `floor(shares * preview_redeem_total / total_supply)`, where `preview_redeem_total` is the vault's `previewRedeem(totalSupply())` at the snapshot block (migration 0022). It is net of the exit fee and, on a BasketVault, of the `maxSlippageBps` floor, so it is a floor on what the redeem pays, never the gross `convertToAssets` value (core 1795, QA plan X8; rmAGENT read about 3% high before). `uint256` decimal string. `null` when no `vault_snapshot` exists for the vault, or its newest snapshot has no `previewRedeem` reading yet (a row from before migration 0022; the indexer fills it on its next tick). Tested by `endpoints::account_positions_usdc_value_is_preview_redeem_not_convert_to_assets`. |
| `positions[].block_number` | i64 | Block of the most recent `wallet_positions` row for that vault. |
| `positions[].indexed_at` | string | ISO-8601 UTC indexing timestamp for that row. |
| `block_number` | i64 | Top-level freshness: block of the first position, or the indexer's latest block when `positions` is empty. |
| `indexed_at` | string | Top-level freshness: ISO-8601 UTC. |

**Cross-component contract — read before consuming this endpoint.** The
vault-address key is serialized as `vault`. The human dapp's
`clients/dapp/src/lib/usePositions.ts` consumes this endpoint and renames the
`vault` key into its own internal client-side address field before rendering.
Issue #1038 (the `PositionSelector` crash) was caused by an earlier dapp build
that read the client-side field name directly off the API body — which the API
never serializes — leaving every position's address `undefined`. Any new
consumer must read the `vault` key shown above; do not assume the dapp's
internal client field name appears on the wire.

---

## Planned endpoints (stubs — not yet implemented)

### `GET /v1/accounts/:address/policies`

> **Implementing issue:** #661 — `feat(explorer-api): add GET /v1/accounts/:address/policies`
>
> **Prerequisites:** Issue #366 (ABI drift fix for `AgentAuthorized` — adds
> `address indexed owner` field so the indexer knows which depositor owns an agent).

**Request:**
```
GET /v1/accounts/{address}/policies
```

Path parameter `address`: 0x-prefixed Ethereum address (20 bytes hex).

**Response (200 OK):**
```json
[
  {
    "agent":                  "0xabcdef...",
    "owner":                  "0x{address}",
    "revoked":                false,
    "valid_until":            1735689600,
    "max_per_payment":        "1000000000000000000",
    "max_per_window":         "5000000000000000000",
    "window_usage_to_date":   "250000000000000000",
    "share_receiver":         "0xabcdef...",
    "tx_hash":                "0x...",
    "block_number":           12345678,
    "indexed_at":             "2026-06-07T00:00:00Z"
  }
]
```

Returns an empty array (not 404) when the owner has no policies.

All `uint256` fields are decimal strings (NUMERIC(78,0) wire format).
`valid_until` is a Unix timestamp seconds (i64). `indexed_at` is ISO-8601 UTC.

**DB query target:**
```sql
SELECT DISTINCT ON (chain_id, agent)
    chain_id, block_number, log_index, tx_hash, agent, owner,
    revoked, valid_until, max_per_payment, max_per_window,
    window_usage_to_date, share_receiver, indexed_at
FROM agent_policies
WHERE chain_id = $1 AND owner = $2
ORDER BY chain_id, agent, block_number DESC
```

**Migration dependency:** `0007_account_history_and_vault_detail_stubs.sql`
adds `owner` and `window_usage_to_date` columns to `agent_policies`.

---

## Partial endpoint extensions

### `GET /v1/accounts/:address/history` — extension (issue #654)

**Current response** (deposits-only):
```json
{
  "address": "0x...",
  "events": [
    {
      "kind": "deposit",
      "block_number": 12345678,
      "tx_hash": "0x...",
      "payment_id": "0x...",
      "amount": "1000000000000000000",
      "shares_minted": "999999999999999999",
      "indexed_at": "2026-06-07T00:00:00Z"
    }
  ]
}
```

**Planned response** (all event kinds — issue #654):
```json
{
  "address": "0x...",
  "events": [
    {
      "kind": "deposit",
      "block_number": 12345678,
      "log_index": 3,
      "tx_hash": "0x...",
      "payment_id": "0x...",
      "amount": "1000000000000000000",
      "shares_minted": "999999999999999999",
      "indexed_at": "2026-06-07T00:00:00Z"
    },
    {
      "kind": "withdrawal",
      "block_number": 12345700,
      "log_index": 1,
      "tx_hash": "0x...",
      "amount": "500000000000000000",
      "shares_burned": "499999999999999999",
      "indexed_at": "2026-06-07T00:00:00Z"
    },
    {
      "kind": "fee_charged",
      "block_number": 12345700,
      "log_index": 2,
      "tx_hash": "0x...",
      "gross_assets": "500000000000000000",
      "fee": "2500000000000000",
      "net_assets": "497500000000000000",
      "indexed_at": "2026-06-07T00:00:00Z"
    },
    {
      "kind": "policy_change",
      "block_number": 12345800,
      "log_index": 0,
      "tx_hash": "0x...",
      "agent": "0x...",
      "revoked": false,
      "indexed_at": "2026-06-07T00:00:00Z"
    },
    {
      "kind": "governance_vote",
      "block_number": 12346000,
      "log_index": 5,
      "tx_hash": "0x...",
      "proposal_id": 42,
      "power": "1000",
      "indexed_at": "2026-06-07T00:00:00Z"
    }
  ]
}
```

Events are interleaved in ascending `(block_number, log_index)` order.

**DB query target:** UNION of `agent_deposits` (kind="deposit") and
`account_history_events` (all other kinds), ordered by `(block_number, log_index)`.

**Table dependency:** `account_history_events` — migration `0007_account_history_and_vault_detail_stubs.sql`.

---

### `GET /v1/vaults/:address` — extension (issue #675)

**Current response:**
```json
{
  "vault": {
    "address": "0x...",
    "name": "...",
    "risk_label": "...",
    "status": 0,
    "tvl_cap": "1000000000",
    "per_deposit_cap": "100000000",
    "headroom": "998999955",
    "snapshot_block": 52401831,
    "tvl_history": [ ... ]
  },
  "block_number": 52424271,
  "chain_head_block": 52424276
}
```

**Planned response** (full §5.4 vault detail — issue #675):
```json
{
  "vault": {
    "address": "0x...",
    "name": "...",
    "risk_label": "...",
    "status": 0,
    "tvl_cap": "1000000000",
    "per_deposit_cap": "100000000",
    "headroom": "998999955",
    "snapshot_block": 52401831,
    "tvl_history": [ ... ],
    "adapter_allocation_history": [
      {
        "kind": "allocated",
        "adapter": "0x...",
        "amount": "500000000000000000",
        "block_number": 12345678,
        "tx_hash": "0x..."
      }
    ],
    "deposit_withdrawal_log": [
      {
        "kind": "deposit",
        "caller": "0x...",
        "owner": "0x...",
        "assets": "1000000000000000000",
        "shares": "999999999999999999",
        "block_number": 12345678,
        "tx_hash": "0x..."
      }
    ],
    "fee_history": [
      {
        "owner": "0x...",
        "receiver": "0x...",
        "gross_assets": "500000000000000000",
        "fee": "2500000000000000",
        "net_assets": "497500000000000000",
        "block_number": 12345700,
        "tx_hash": "0x..."
      }
    ]
  }
}
```

**Table dependencies:**
- `adapter_allocations` — migration `0007_account_history_and_vault_detail_stubs.sql`
- `vault_fee_events` — migration `0007_account_history_and_vault_detail_stubs.sql`
- `vault_transfer_events` — migration `0007_account_history_and_vault_detail_stubs.sql`

---

## Chain scoping

All endpoints bind `AppState::chain_id` (set at startup from `EXPLORER_API_CHAIN_ID`)
as the first query parameter. No request path or query string can override the
configured chain. See `docs/technical/explorer-schema-decisions.md §4`.

## Wire format conventions

- Ethereum addresses: 0x-prefixed lower-case hex, 20 bytes (42 chars total).
- Transaction hashes: 0x-prefixed lower-case hex, 32 bytes (66 chars total).
- `uint256` values: decimal strings (never floating-point).
- Timestamps: ISO-8601 UTC for `indexed_at`; Unix seconds `i64` for on-chain
  block timestamps (`valid_until`, `registered_at`, etc.).
- Block numbers: `i64`.
