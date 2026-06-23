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
| GET | `/v1/stats` | `get_stats` | Implemented |
| GET | `/v1/router/state` | `get_router_state` | Implemented |
| GET | `/v1/accounts/:address/positions` | `get_account_positions` | Implemented |
| GET | `/v1/accounts/:address/history` | `get_account_history` | Partial — see issue #654 |

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
| `positions[].usdc_value` | string \| null | USDC value of `shares` at the latest snapshot share price (`shares * total_assets / total_supply`), `uint256` decimal string. `null` when no `vault_snapshot` exists for the vault. |
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
    "status": "active",
    "deposit_cap": "...",
    "tvl_history": [ ... ]
  }
}
```

**Planned response** (full §5.4 vault detail — issue #675):
```json
{
  "vault": {
    "address": "0x...",
    "name": "...",
    "risk_label": "...",
    "status": "active",
    "deposit_cap": "...",
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
