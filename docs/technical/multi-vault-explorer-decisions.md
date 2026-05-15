# ADR — Multi-vault explorer: schema migration seams, new table specifications, and indexer poll-loop extension points

> Scope: dev-scout decision record for the multi-vault explorer phase of
> `docs/implementation-plan.md`. Resolves all open schema questions that gate
> any indexer code change or migration file: the `vault_snapshots`
> generalization strategy, three new tables (`router_weight_snapshots`,
> `governance_proposals`, `governance_votes`), the `account_positions` query
> shape, which existing API queries break after migration, and the indexer
> poll-loop extension points. No schema migration SQL or indexer code changes
> are produced by this scout.
>
> Closes the open question gate for all downstream multi-vault explorer issues.

---

## 1. Status

Accepted. Authored 2026-05-15 against `docs/technical/explorer-schema-decisions.md`,
`docs/technical/portfolio-router-decisions.md`,
`docs/technical/governance-decisions.md`, and
`services/explorer-indexer/` on branch
`chore/314-dev-scout-map-multi-vault-explorer-schema-migrat`.

Companion ADRs:

- `docs/technical/explorer-schema-decisions.md` — Phase 5 indexer foundations
  (DB engine, cadence, reorg handling, per-table PKs, idempotency keying).
- `docs/technical/portfolio-router-decisions.md` — Portfolio Router deposit
  signature, preview shape, cap enforcement, and gateway coupling.
- `docs/technical/governance-decisions.md` — Router-weight governance: quorum,
  cadence, voting power, execution delay, proposal lifecycle, and events.

---

## 2. Context and motivation

The explorer indexer (Phase 5, `services/explorer-indexer/`) was built with a
single-vault assumption. `IndexerConfig` carries one `vault: Address` field;
`snapshot_vault()` is hardcoded to `cfg.vault`; the heartbeat query filters
`vault_snapshots` on the single config address; `watched_addresses()` yields
`[gateway, vault, registry?]` with no concept of a dynamic vault set.

Phase 5 (vault registry) already added the `vaults` table and started ingesting
`VaultRegistered` / `VaultStatusChanged` events, but the snapshot loop was not
updated to iterate over all registered vaults. As a result:

- Only the single config vault gets snapshots. New vaults added via
  `VaultRegistered` are never snapshotted.
- The Portfolio Router's weight state is invisible to the explorer.
- Governance proposal and vote events are not ingested.
- The API's `vault_snapshots`-dependent queries (`/v1/vault/snapshot/latest`,
  `/v1/vault/snapshots`, `/v1/vaults` TVL join, `/v1/vaults/:address` TVL
  history) all return data for one vault only.

This ADR identifies every migration seam and extension point required to make
the explorer aware of all registered vaults, Portfolio Router state, governance
events, and account positions.

---

## 3. Single-vault hardcoding audit

The following locations in the codebase hardcode the assumption of one vault.
Each must be addressed in the corresponding implementation issue. **No code
changes are made in this scout.**

### 3.1 `services/explorer-indexer/src/indexer.rs`

| Location | Hardcoding | Impact |
|---|---|---|
| `IndexerConfig::vault: Address` field | One vault address per indexer instance | Must become `vaults: Vec<Address>` or be replaced by a live `listVaults()` query. |
| `IndexerConfig::watched_addresses()` → `vec![self.gateway, self.vault, …]` | Only the config vault is in the `eth_getLogs` filter | Events from newly registered vaults are not captured. |
| `for (bn, contract) in &event_blocks_per_contract { if *contract == cfg.vault { … } }` | Snapshot is taken only for `cfg.vault` | Every other vault is never snapshotted. |
| `sqlx::query_scalar("SELECT MAX(block_number) FROM vault_snapshots WHERE … contract = $2")` bound to `cfg.vault` | Heartbeat checks only the single config vault | Other vaults never receive heartbeat snapshots. |
| `snapshot_vault(db, rpc, cfg, …)` reads `cfg.vault` exclusively | All `eth_call`s target one address | Requires a `target: Address` parameter to snapshot any vault. |

### 3.2 `clients/explorer-api/src/routes.rs`

| Endpoint | Query | Impact after migration |
|---|---|---|
| `GET /v1/vault/snapshot/latest` | `SELECT … FROM vault_snapshots ORDER BY block_number DESC LIMIT 1` — no contract filter | After multi-vault: returns the latest snapshot regardless of vault; semantically ambiguous. **Query breaks** (returns arbitrary vault). |
| `GET /v1/vault/snapshots` | Accepts optional `?contract=` filter; default returns all | Survives multi-vault without change — the optional `contract` filter already exists. Low-risk. |
| `GET /v1/vaults` TVL JOIN | `LEFT JOIN LATERAL (SELECT … FROM vault_snapshots WHERE contract = v.vault_address …)` per vault | Survives multi-vault without change — already keyed by vault address. No action needed. |
| `GET /v1/vaults/:address` TVL history | `SELECT … FROM vault_snapshots WHERE chain_id = $1 AND contract = $2` | Survives multi-vault without change — already keyed by vault address. No action needed. |

**Breaking query: `GET /v1/vault/snapshot/latest`.** This endpoint has no
`contract` filter and returns whichever snapshot has the highest block number
across all vaults. In a multi-vault world this is meaningless. Resolution
options (decided in the implementation issue, not here):

- Deprecate the endpoint and redirect callers to `/v1/vaults/:address`.
- Add a required `?vault=` query parameter and return 400 without it.
- Change semantics to return the portfolio-level aggregate (sum of
  `total_assets` across all active vaults at the highest common block).

The implementation issue must choose one. Until then, the endpoint must not be
extended to return multi-vault data without a contract filter.

---

## 4. `vault_snapshots` generalization strategy

### 4.1 Current schema

```sql
CREATE TABLE IF NOT EXISTS vault_snapshots (
    chain_id        BIGINT          NOT NULL REFERENCES chains(chain_id),
    contract        BYTEA           NOT NULL,       -- vault address
    block_number    BIGINT          NOT NULL,
    total_assets    NUMERIC(78, 0)  NOT NULL,
    total_supply    NUMERIC(78, 0)  NOT NULL,
    exit_fee_bps    BIGINT          NOT NULL,
    tvl_cap         NUMERIC(78, 0)  NOT NULL,
    paused          BOOLEAN         NOT NULL,
    indexed_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, contract, block_number),
    FOREIGN KEY (chain_id, contract) REFERENCES contracts(chain_id, address)
);
```

### 4.2 Generalization decision: key on `(chain_id, contract, block_number)` — already sufficient

The existing primary key `(chain_id, contract, block_number)` correctly keys
snapshots by vault address. **No column renames or PK changes are required.**
The table is already multi-vault-capable at the schema level. The only gaps are:

1. The `contracts` FK requires that every vault address is first inserted into
   the `contracts` table with `kind = 'vault'`. The indexer already calls
   `upsert_contract` for `cfg.vault`; it must be extended to call
   `upsert_contract` for every address returned by `VaultRegistry.listVaults()`.

2. The `contracts.kind` column currently distinguishes `'gateway'`, `'vault'`,
   and `'vault_registry'`. No new `kind` values are required for multi-vault.

### 4.3 Migration order for existing history

Because the PK already includes `contract`, existing rows for the config vault
are preserved without modification. A full re-index is not required. The
migration path is:

1. `0003_register_all_vaults.sql` (name TBD): For every address already in the
   `vaults` table, ensure a corresponding `contracts` row exists. This is a
   data-repair migration, not a schema change:

   ```sql
   -- Data repair: ensure every registered vault has a contracts row.
   -- Safe to run multiple times (ON CONFLICT DO NOTHING).
   INSERT INTO contracts (chain_id, address, kind)
   SELECT chain_id, vault_address, 'vault'
   FROM vaults
   ON CONFLICT (chain_id, address) DO NOTHING;
   ```

2. Indexer restart with the updated poll loop: begins snapshotting all vaults.
   Historical snapshots for newly registered vaults start from the first tick
   after restart; they do not back-fill pre-restart blocks. This is acceptable
   because the explorer is not the source of truth and the TVL history shown
   to the dapp will simply have a shorter lookback for new vaults.

---

## 5. New table specifications

### 5.1 `router_weight_snapshots`

Captures the active weight vector on `PortfolioRouter` at each block where a
`WeightsSet` (or `WeightsApplied`) event is emitted.

```sql
-- Canonical: docs/technical/multi-vault-explorer-decisions.md §5.1
--
-- One row per (chain_id, router_address, block_number) weight snapshot.
-- vault_addresses and weight_bps are parallel arrays stored as JSONB to
-- avoid a separate junction table while retaining index-ability.
-- NUMERIC(78, 0) is not required here because weight bps fits in SMALLINT
-- but we use BIGINT for forward-compatibility with any future precision.

CREATE TABLE IF NOT EXISTS router_weight_snapshots (
    chain_id        BIGINT          NOT NULL REFERENCES chains(chain_id),
    router_address  BYTEA           NOT NULL,
    block_number    BIGINT          NOT NULL,
    log_index       INTEGER         NOT NULL,
    tx_hash         BYTEA           NOT NULL,
    -- Parallel JSON arrays: [vault_address_hex, ...] and [bps, ...]
    -- Lengths guaranteed equal by the contract; any consumer that
    -- encounters unequal lengths must treat the row as corrupted.
    vault_addresses JSONB           NOT NULL,   -- ["0xabc...", ...]
    weight_bps      JSONB           NOT NULL,   -- [3000, 4000, 3000]
    indexed_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, router_address, block_number, log_index),
    FOREIGN KEY (chain_id, router_address) REFERENCES contracts(chain_id, address)
);

CREATE INDEX IF NOT EXISTS router_weight_snapshots_router_block_idx
    ON router_weight_snapshots(chain_id, router_address, block_number DESC);
```

**Trigger.** The indexer writes a row when it decodes a `WeightsSet` event from
`PortfolioRouter.sol` (per `docs/technical/portfolio-router-decisions.md` §3.1
the contract emits `WeightsApplied` alongside `PortfolioRouter.WeightsSet`).
The `PortfolioRouter` address must be registered in `contracts` with
`kind = 'portfolio_router'` before the FK insert.

**No heartbeat.** Weights change only via governance execution; an event-driven
snapshot is sufficient. A heartbeat snapshot would add rows without data value.

### 5.2 `governance_proposals`

One row per `ProposalCreated` event from `RouterGovernance.sol`, updated
atomically on terminal events (`ProposalPassed`, `ProposalRejected`,
`ProposalExecuted`, `ProposalExpired`).

```sql
-- Canonical: docs/technical/multi-vault-explorer-decisions.md §5.2
-- Events sourced from RouterGovernance.sol per
-- docs/technical/governance-decisions.md §3.5.

CREATE TABLE IF NOT EXISTS governance_proposals (
    chain_id            BIGINT          NOT NULL REFERENCES chains(chain_id),
    governance_address  BYTEA           NOT NULL,
    -- on-chain uint256 proposalId; fits in NUMERIC(78,0) but proposals are
    -- sequential so BIGINT is sufficient in practice.
    proposal_id         BIGINT          NOT NULL,

    -- From ProposalCreated
    proposer            BYTEA           NOT NULL,
    snapshot_block      BIGINT          NOT NULL,
    -- Parallel JSON arrays mirroring router_weight_snapshots for the proposed weights.
    proposed_vaults     JSONB           NOT NULL,
    proposed_bps        JSONB           NOT NULL,
    created_block       BIGINT          NOT NULL,
    created_log_index   INTEGER         NOT NULL,
    created_tx          BYTEA           NOT NULL,

    -- Lifecycle state: 'open' | 'passed' | 'rejected' | 'executed' | 'expired'
    -- Updated by the indexer on each terminal event.
    state               TEXT            NOT NULL DEFAULT 'open',

    -- Filled in on ProposalPassed / ProposalRejected
    yes_votes           NUMERIC(78, 0),
    no_votes            NUMERIC(78, 0),
    total_supply_at_snapshot NUMERIC(78, 0),
    resolved_block      BIGINT,
    resolved_log_index  INTEGER,
    resolved_tx         BYTEA,

    -- Filled in on ProposalExecuted
    executed_block      BIGINT,
    executed_log_index  INTEGER,
    executed_tx         BYTEA,

    indexed_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, governance_address, proposal_id),
    FOREIGN KEY (chain_id, governance_address)
        REFERENCES contracts(chain_id, address)
);

CREATE INDEX IF NOT EXISTS governance_proposals_state_idx
    ON governance_proposals(chain_id, governance_address, state);
CREATE INDEX IF NOT EXISTS governance_proposals_proposer_idx
    ON governance_proposals(chain_id, proposer);
```

**Idempotency.** The `ProposalCreated` row uses `ON CONFLICT (chain_id,
governance_address, proposal_id) DO NOTHING` for the initial insert.
Lifecycle-state updates use `UPDATE … WHERE chain_id = $1 AND
governance_address = $2 AND proposal_id = $3` keyed by the same composite.
Re-indexing the same event range is idempotent because the `UPDATE` is a
no-op when the state column already carries the terminal value.

### 5.3 `governance_votes`

One row per `VoteCast` event from `RouterGovernance.sol`. Append-only; no
update path.

```sql
-- Canonical: docs/technical/multi-vault-explorer-decisions.md §5.3
-- Event-sourced from RouterGovernance.VoteCast per
-- docs/technical/governance-decisions.md §3.5.

CREATE TABLE IF NOT EXISTS governance_votes (
    chain_id            BIGINT          NOT NULL REFERENCES chains(chain_id),
    governance_address  BYTEA           NOT NULL,
    proposal_id         BIGINT          NOT NULL,
    block_number        BIGINT          NOT NULL,
    log_index           INTEGER         NOT NULL,
    tx_hash             BYTEA           NOT NULL,
    voter               BYTEA           NOT NULL,
    support             BOOLEAN         NOT NULL,   -- true = yes, false = no
    power               NUMERIC(78, 0)  NOT NULL,
    indexed_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number, log_index),
    FOREIGN KEY (chain_id, governance_address, proposal_id)
        REFERENCES governance_proposals(chain_id, governance_address, proposal_id)
);

CREATE INDEX IF NOT EXISTS governance_votes_proposal_idx
    ON governance_votes(chain_id, governance_address, proposal_id, block_number DESC);
CREATE INDEX IF NOT EXISTS governance_votes_voter_idx
    ON governance_votes(chain_id, voter);
```

**FK dependency.** The `governance_votes` table has a FK into
`governance_proposals`. This means a `VoteCast` event can only be inserted
after its `ProposalCreated` row exists. The indexer must process events in
block order (already guaranteed by the `eth_getLogs` ordering); within the
same block, `ProposalCreated` must be processed before `VoteCast`. The
existing `handle_log` loop iterates logs in `log_index` order, which satisfies
this as long as governance contracts emit `ProposalCreated` before any same-block
`VoteCast` (contractually impossible: you cannot vote before a proposal is open;
the voting period starts in a separate block).

---

## 6. `account_positions` — query or materialized view

`account_positions` is specified as a query over indexed transfer events, not a
stored table. The reason: ERC-20 `Transfer` events are not currently in the
indexer's watched event set, and adding them at the full-chain scale is out of
scope for this phase. Instead, account positions are derived from the existing
`agent_deposits` and `wallet_positions` tables.

### 6.1 Query definition

```sql
-- account_positions: derive per-account share balances from the most
-- recent wallet_positions row per (chain_id, contract, owner).
--
-- This is a VIEW definition, not a materialized view, to avoid
-- incremental-refresh complexity. If query latency becomes a problem,
-- the implementation issue may promote it to a MATERIALIZED VIEW with a
-- refresh trigger on wallet_positions inserts.

CREATE OR REPLACE VIEW account_positions AS
SELECT DISTINCT ON (chain_id, contract, owner)
    chain_id,
    contract        AS vault_address,
    owner,
    shares,
    block_number    AS as_of_block,
    indexed_at
FROM wallet_positions
ORDER BY chain_id, contract, owner, block_number DESC;
```

### 6.2 API surface

The implementation issue for account positions must add:

```
GET /v1/accounts/:address/positions
```

Response shape (per-vault):

```json
{
  "account": "0xabc...",
  "positions": [
    {
      "vault_address": "0xdef...",
      "shares": "1000000000000000000",
      "as_of_block": 12345678,
      "indexed_at": "2026-05-15T00:00:00Z"
    }
  ],
  "freshness": { "block_number": 12345678, "indexed_at": "2026-05-15T00:00:00Z" }
}
```

This endpoint is **not** implemented by this scout. The view definition above
is the schema stub that unblocks the implementation issue.

---

## 7. Existing API queries that break after schema migration

| Endpoint | Breakage? | Reason | Resolution |
|---|---|---|---|
| `GET /v1/vault/snapshot/latest` | **Yes** | No `contract` filter; returns arbitrary vault. | Deprecate or add required `?vault=` param. See §3.2. |
| `GET /v1/vault/snapshots` | No | Optional `?contract=` filter already present. | No action. |
| `GET /v1/vaults` TVL join | No | `LATERAL` join already keyed by `vault_address`. | No action. |
| `GET /v1/vaults/:address` TVL history | No | Already keyed by contract address. | No action. |
| `GET /v1/agents/:address` | No | Does not touch `vault_snapshots`. | No action. |
| `GET /v1/agents/:address/deposits` | No | Does not touch `vault_snapshots`. | No action. |
| `GET /v1/transactions/:tx_hash` | No | Does not touch `vault_snapshots`. | No action. |
| `GET /v1/deposits/:deposit_id` | No | Does not touch `vault_snapshots`. | No action. |
| `GET /v1/chains/:chain_id/contracts` | No | Reads `contracts` table; already multi-address. | No action. |
| `GET /health` | No | Reads `indexer_runs` only. | No action. |

---

## 8. Indexer poll-loop extension points

### 8.1 Dynamic vault address set

**Current:** `IndexerConfig.vault: Address` is a single address loaded at startup.

**Extension:** Replace with a live query on each tick:

```rust
// At the start of run_inner, after fetching the block number:
let registered_vaults: Vec<Address> = db.list_active_vault_addresses(cfg.chain_id).await?;
```

`list_active_vault_addresses` reads:

```sql
SELECT vault_address FROM vaults
WHERE chain_id = $1 AND status = 0  -- 0 = Active
```

The list is used to:

1. Build the `watched_addresses` set for `eth_getLogs`.
2. Drive the snapshot loop: iterate `registered_vaults` instead of `[cfg.vault]`.
3. Drive the heartbeat check: one heartbeat check per registered vault.

**Risk: `eth_getLogs` address filter size.** Most JSON-RPC endpoints accept up
to 50–100 address filters in one call. If the registry grows beyond that, the
indexer must batch `eth_getLogs` calls by address groups. The implementation
issue must add a compile-time constant `MAX_ADDRS_PER_LOG_QUERY = 50` and
batch accordingly.

### 8.2 Portfolio Router snapshot trigger

`PortfolioRouter.sol` emits `WeightsSet` when weights change (per
`docs/technical/portfolio-router-decisions.md` §3.1). The indexer must:

1. Add `cfg.router: Option<Address>` to `IndexerConfig` (analogous to
   `cfg.registry`).
2. Register the router in `contracts` with `kind = 'portfolio_router'`.
3. Add `topics.weights_set` to `Topics::new()` from the `WeightsApplied`
   event ABI.
4. In `handle_log`, decode `WeightsApplied` and call `db.insert_router_weight_snapshot(…)`.

No heartbeat is needed for router weights (see §5.1).

### 8.3 Governance event ingestion

`RouterGovernance.sol` emits seven events (per
`docs/technical/governance-decisions.md` §3.5). The indexer must:

1. Add `cfg.governance: Option<Address>` to `IndexerConfig`.
2. Register the governance contract in `contracts` with `kind = 'governance'`.
3. Add all seven `RouterGovernance` event topics to `Topics::new()`.
4. In `handle_log`:
   - `ProposalCreated` → `db.insert_governance_proposal(…)` (initial insert).
   - `VoteCast` → `db.insert_governance_vote(…)`.
   - `ProposalPassed` / `ProposalRejected` / `ProposalExecuted` / `ProposalExpired`
     → `db.update_governance_proposal_state(proposal_id, new_state, …)`.

### 8.4 `wallet_positions` multi-vault extension

The existing `wallet_positions` table already carries `(chain_id, contract,
owner, block_number)` as PK and is not hardcoded to a single vault. However,
the indexer never calls `insert_wallet_position` today (the `handle_log` loop
has no `Transfer`-event decoder). The implementation issue must decide:

- **Option A (minimal):** Populate `wallet_positions` only from `AgentDeposit`
  events — each deposit's `shareReceiver` is a known position holder. This
  covers agent flows but not human direct-deposit flows.
- **Option B (full):** Watch `Transfer` events from every registered vault and
  update `wallet_positions` on each `Transfer`. This requires adding
  `Transfer(address from, address to, uint256 value)` to the watched event
  set and decoding two position updates per event (decrement sender, increment
  receiver). Scale risk: vaults with high transfer frequency generate O(N)
  rows.

This ADR does not choose between A and B; the implementation issue must decide.
Both options are schema-compatible with the current `wallet_positions` table.

---

## 9. Migration ordering for downstream implementation issues

The correct order is:

1. **Data-repair migration** (`0003_register_all_vaults.sql`): ensure all
   `vaults` rows have a matching `contracts` row. No schema change.
2. **New table migration** (e.g. `0004_multi_vault_tables.sql`): add
   `router_weight_snapshots`, `governance_proposals`, `governance_votes`, and
   the `account_positions` view. Depends on: step 1 (FK into `contracts`).
3. **Indexer poll-loop update**: replace single-vault snapshot loop with
   multi-vault loop; add router and governance event handlers. Depends on:
   step 2 (tables must exist before inserts).
4. **API extension**: add new endpoints for router weights, governance, and
   account positions. Deprecate or fix `/v1/vault/snapshot/latest`. Depends
   on: step 3 (data must exist before the API is useful).

Steps 1 and 2 can land in a single migration PR. Steps 3 and 4 can land in
the same or separate PRs but must not land before step 2.

---

## 10. References

- `docs/technical/explorer-schema-decisions.md` — Phase 5 ADR (DB engine,
  cadence, reorg handling, per-table PKs, ingestion model).
- `docs/technical/portfolio-router-decisions.md` — `WeightsSet` / `WeightsApplied`
  event source for `router_weight_snapshots`.
- `docs/technical/governance-decisions.md` — All seven governance events, proposal
  lifecycle, and voting model for `governance_proposals` / `governance_votes`.
- `services/explorer-indexer/src/indexer.rs` — Single-vault hardcoding audit
  (§3.1).
- `services/explorer-indexer/migrations/0001_minimum_tables.sql` — Current schema.
- `services/explorer-indexer/migrations/0002_add_vaults_table.sql` — Vault
  registry addition.
- `clients/explorer-api/src/routes.rs` — Existing API queries audited in §7.
- Issue #314 — this scout.
