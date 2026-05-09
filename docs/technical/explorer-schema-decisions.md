# ADR — Explorer schema, indexer cadence, and ingestion model

> Scope: dev-scout decision record for Phase 5 (Simple Web Explorer API and Database) of `docs/implementation-plan.md` §11. Resolves the unresolved choices that gate any explorer schema or indexer code: which DB engines are supported per environment, indexer trigger cadence and reorg handling, the exact idempotency-key shape, the ingestion model (rmpc-output-driven vs JSON-RPC-only), and the explicit defer list for "optional later" tables.
>
> Closes the open question gate in `docs/implementation-plan.md` §11. No schema migrations or API code are produced by this scout.

---

## 1. Status

Accepted. Authored 2026-05-06 against `docs/implementation-plan.md` §11 on branch `feat/56-dev-scout-explorer-schema-indexer-shape`. No prior ADR exists for this phase. No code stubs are required: §11 prescribes a separate service tree that does not yet exist, and the §11 acceptance criteria are documentation-only ("a local developer can start the API and DB, index a fork range, and query deposit/vault history" is satisfied at implementation time, not by this scout).

Companion ADR: `docs/technical/rmpc-read-output-contract.md` §3.3 and §5 already lock the `source: "json_rpc"` provenance rule for `rmpc` reads and explicitly anticipate a future `Source::Indexer` variant. This ADR does not modify that contract; it operates one layer below, on the indexer that would back any such variant.

## 2. Context

`docs/implementation-plan.md` §11 names nine minimum tables (`chains`, `contracts`, `blocks`, `transactions`, `agent_deposits`, `agent_policies`, `vault_snapshots`, `wallet_positions`, `indexer_runs`) and four optional later tables (`basket_routes`, `governance_events`, `buybacks`, `agent_task_runs`). It commits the API to:

- A small HTTP API with the eight endpoints listed in §11.
- "Preferably Postgres for production-like use and SQLite only for local development if it materially simplifies setup."
- A background indexer that reads JSON-RPC logs and selected state at known blocks.
- "Idempotent ingestion keyed by `chain_id`, `block_number`, `log_index`, and `tx_hash`."

§11 deliberately leaves five operational choices unresolved:

1. **DB engine policy.** Postgres-only or Postgres+SQLite? If both, what's the compatibility envelope?
2. **Indexer cadence.** Polling at a fixed interval, subscribing via `eth_subscribe` WebSocket, or a hybrid?
3. **Reorg handling.** Confirmation depth? Soft-delete vs purge-and-rewrite? How is a reorged row detected?
4. **Idempotency-key shape.** §11 lists four fields but does not say which combination is the primary key per table, how non-event rows (state snapshots) key themselves, or how the indexer detects "already ingested".
5. **Ingestion model.** §11 names both "JSON-RPC logs and selected state" and "rmpc outputs" as input sources. Which is canonical? Are rmpc outputs ingested directly, or re-derived from chain on the indexer side?

A binding constraint applies: per `docs/security-model.md` and §11's own "Boundaries" subsection, **the explorer is never the source of truth for signing or safety decisions**. Every decision below is anchored to that constraint plus the §11 acceptance criteria (clearly distinguish indexed data from live chain reads; mark stale data with block number and indexed-at time; Phase 6 dapp can use the API for display while sensitive actions still go through `rmpc`).

A second binding constraint from user memory applies: **no fast-feedback optimization in the test harness**. The indexer's local-dev story should not invent a faster substitute for the production stack just to shave seconds off contributor iteration.

## 3. Decisions

### 3.1 DB engine — **Postgres for every environment that runs the indexer; no SQLite path**

- **Decision.** The explorer service supports exactly one DB engine: Postgres (≥ 15). Local development uses a Docker-Compose Postgres container; CI uses a service container; production uses a managed Postgres. SQLite is **not** a supported target for the indexer or the API.
- **Rationale.** §11 hedges ("SQLite only for local development if it materially simplifies setup"), but the simplification does not exist in practice. The indexer needs:
  - `INSERT … ON CONFLICT … DO NOTHING` semantics on multi-column primary keys (Postgres `ON CONFLICT (chain_id, block_number, log_index)` vs SQLite's `INSERT OR IGNORE` with subtly different `RETURNING` behavior),
  - `NUMERIC(78,0)` for `uint256` storage (SQLite has no exact decimal type — it falls back to `TEXT`, which then disagrees with Postgres on collation and ordering),
  - row-level snapshot isolation for the reorg rewrite path (§3.3).
  Maintaining two SQL dialects across migrations, repository code, and snapshot fixtures violates the "fewer moving parts" constraint. A docker-compose Postgres on a developer laptop adds <30 s to first-run setup and is the single moving part.
- **Constraint cited.** §11 "preferably Postgres for production-like use" plus the project's "no fast-feedback optimization" memo (we accept the docker-compose dependency rather than maintain a parallel sqlite path).
- **Rejected alternatives.**
  - *Postgres + SQLite via SQLx or Diesel's multi-backend layer.* Forces every query to compile against both backends and every migration to be hand-translated; the optional-feature flag explosion bleeds into the API crate too.
  - *SQLite-only for the dev-scout milestone, Postgres later.* Leaves a single migration cliff for the same project. The cliff is cheaper to skip.

### 3.2 Indexer cadence — **poll-based, 12 s default tick, with `--tick` override; no `eth_subscribe`**

- **Decision.** The indexer runs a single `tokio` task that wakes every `INDEXER_TICK_SECONDS` (default 12, override via env var or CLI flag) and processes blocks from `last_indexed_block + 1` up to `eth_blockNumber - CONFIRMATIONS` (see §3.3). Per tick: fetch logs for the watched contract address set in one `eth_getLogs` call across the range, then upsert. There is no WebSocket subscription path.
- **Rationale.**
  - **Polling is simpler than push.** `eth_subscribe` requires a long-lived WebSocket, reconnection logic, missed-event recovery on disconnect, and a separate code path for the catch-up backfill on first start — and the backfill code path has to exist anyway for cold start and reorg rewrite. Polling collapses to one code path.
  - **12 s matches Base's slot time.** Base's sequencer produces a block every ~2 s; pulling at 12 s averages 6 blocks per tick, well under the typical `eth_getLogs` block-range cap (1k–10k blocks for paid endpoints). Smaller intervals do not improve correctness — `confirmations` (§3.3) gates how recent a block we ingest, not how often we look.
  - **`--tick` is a knob, not a tuning lever.** Operators can lower it for an integration test (e.g. 1 s) or raise it for a quiet RPC budget (e.g. 60 s). Default stays at 12 s.
- **Constraint cited.** §11 "Background indexer that reads JSON-RPC logs and selected state at known blocks" plus the project's no-fast-feedback constraint (we don't optimize for sub-second indexed latency since the explorer is never load-bearing for safety).
- **Rejected alternatives.**
  - *`eth_subscribe` with a poll fallback.* Two code paths to maintain, two failure modes to test. The push latency win is irrelevant to a UI that displays "indexed at block N (M seconds behind tip)".
  - *Block-time-aware adaptive cadence.* Premature optimization; revisit if a real RPC budget problem appears.

### 3.3 Reorg handling — **`CONFIRMATIONS = 5` blocks behind tip; rows at or above the safe head are rewritable; rewrite is `DELETE … WHERE block_number >= reorg_root` then re-ingest**

- **Decision.** The indexer never ingests blocks within `CONFIRMATIONS = 5` of `eth_blockNumber`. On every tick, the indexer fetches `eth_getBlockByNumber(last_indexed_block, false)` and compares its hash to the stored `blocks.hash` for that height. If they differ, a reorg is detected:
  - Walk back from `last_indexed_block` until the stored hash matches the chain hash; that's `reorg_root`.
  - In a single transaction: `DELETE FROM transactions WHERE block_number > reorg_root`; same for `agent_deposits`, `vault_snapshots`, `wallet_positions`. `blocks` rows with `block_number > reorg_root` are deleted last.
  - Set `last_indexed_block = reorg_root` in `indexer_runs` and let the next tick re-ingest forward.
  No "soft delete" / `is_canonical` flag — reorged data is removed, not retained. Audit history of reorgs lives in `indexer_runs.reorg_count` (counter) plus a structured log entry.
- **Rationale.**
  - **5-block confirmations is generous for Base** (~10 s, sequencer finality is ~1 slot, sequencer reorgs beyond depth 1 are vanishingly rare). It is also conservative enough that a re-org rewrite is a rare, recoverable event rather than a tick-frequency occurrence.
  - **DELETE-then-reinsert is simpler than soft-delete + filter-on-read.** Every read query would otherwise need `WHERE is_canonical = true`; missing one is a data-leak failure mode. The §11 boundary "explorer is never source of truth" means we don't owe consumers a forensic record of orphaned blocks.
  - **The reorg counter in `indexer_runs`** lets ops tools alert on "reorg storm" without requiring a separate audit table.
- **Constraint cited.** §11 acceptance criterion "stale data must be marked with block number and indexed-at time" — by deleting reorged rows and refusing to ingest within `CONFIRMATIONS` of tip, every row in the DB satisfies "this was canonical at the time it was indexed".
- **Rejected alternatives.**
  - *Soft-delete with `is_canonical`.* Adds a column to every table, a filter to every query, and a class of "forgot the filter" bugs. Rejected.
  - *Confirmations = 1 or 0 (index everything immediately).* Pushes the rewrite cost onto every tick and onto the API consumer (who sees flapping rows). Rejected.
  - *Confirmations >> 5 (e.g. 50).* Increases stale-data lag for the dapp without measurable correctness gain on Base. Rejected.

### 3.4 Idempotency-key shape — **per-table composite primary keys; events keyed `(chain_id, block_number, log_index)`; state snapshots keyed `(chain_id, contract, block_number)`**

- **Decision.** The §11 four-tuple `(chain_id, block_number, log_index, tx_hash)` is the *conceptual* idempotency identity for event-sourced rows, but it is not the literal primary key on every table. Per-table:

  | Table | Primary key | Notes |
  | --- | --- | --- |
  | `chains` | `(chain_id)` | Static config row per supported chain. |
  | `contracts` | `(chain_id, address)` | One row per watched contract per chain. |
  | `blocks` | `(chain_id, block_number)` | `hash` is a non-PK column used for reorg detection (§3.3). |
  | `transactions` | `(chain_id, tx_hash)` | `block_number` is a non-PK column; `tx_hash` is globally unique per chain. |
  | `agent_deposits` | `(chain_id, block_number, log_index)` | Event-sourced from `IGateway.AgentDeposit`. `tx_hash` and `payment_id` are non-PK columns. |
  | `agent_policies` | `(chain_id, block_number, log_index)` | Event-sourced from `IGateway.AgentAuthorized`/`AgentRevoked`. Latest-state view derived via `DISTINCT ON (chain_id, agent) … ORDER BY block_number DESC`. |
  | `vault_snapshots` | `(chain_id, contract, block_number)` | State-read row, not event-sourced. One snapshot per indexer-decided cadence (§3.5). |
  | `wallet_positions` | `(chain_id, contract, owner, block_number)` | State-read row. Same cadence as `vault_snapshots`. |
  | `indexer_runs` | `(run_id)` (serial) | Append-only audit log; `started_at`, `last_indexed_block`, `reorg_count`, `error` columns. |

- **Why `(chain_id, block_number, log_index)` and not the §11 four-tuple.** A single transaction can emit the same event multiple times (e.g. a vault rebalance touching three adapters emits three `Allocated` events). `(chain_id, block_number, log_index)` uniquely identifies one log on one canonical chain. `tx_hash` is redundant with `(block_number, log_index)` on a canonical chain (one log lives in exactly one tx) and would force the PK to widen by 32 bytes per row. `tx_hash` stays as a non-PK indexed column for `WHERE tx_hash = $1` lookups.
- **Why state snapshots are keyed by `(chain_id, contract, block_number)`.** State reads have no `log_index`. The `block_number` chosen for a snapshot is the indexer's decision (§3.5), and `(chain_id, contract, block_number)` is exactly enough to deduplicate "we already snapshotted this contract at this block".
- **Reproducibility across re-indexes.** Because every PK is derived from on-chain identifiers (`chain_id`, `block_number`, `log_index`, `contract`, `owner`), a wipe-and-replay produces byte-identical rows for the same block range. The indexer never inserts a synthetic id; surrogate `serial`/`bigserial` columns appear only in `indexer_runs` (which is operational telemetry, not chain truth).
- **Constraint cited.** §11 acceptance criterion (implied by "Idempotent ingestion keyed by …") plus the issue's own acceptance criterion "Idempotency keying is reproducible across re-indexes".

### 3.5 Ingestion model — **JSON-RPC is canonical; rmpc outputs are NOT ingested by the indexer**

- **Decision.** The indexer reads the chain via JSON-RPC (`eth_getLogs`, `eth_call`, `eth_getBlockByNumber`) and never consumes `rmpc` output. There is no path where an `rmpc` JSON envelope is parsed by the indexer and stored as a row. The two consumers of chain data — `rmpc` (live, for signing flows) and the indexer (cached, for the dapp) — share a chain but not a code path.
- **Rationale.**
  - **`rmpc` outputs are operator-triggered and partial.** They reflect what one operator queried at one moment; they are not a complete event log. A vault snapshot the indexer needs at block N may have no corresponding `rmpc get-vault` ever issued. Ingesting `rmpc` output as the source-of-truth would leave gaps that the indexer would have to backfill via JSON-RPC anyway — at which point the `rmpc` ingestion code is dead weight.
  - **The two paths must independently agree.** If a future ADR adds `Source::Indexer` to `rmpc` (per `rmpc-read-output-contract.md` §5), the safety claim is "the indexer derived this from the same JSON-RPC the live `rmpc` read would have used, just earlier". That claim only holds if the indexer's data lineage is JSON-RPC, not `rmpc` output.
  - **`rmpc` output is the right shape for the API consumer, not the indexer.** The Phase 5 HTTP API serves shapes that *resemble* `rmpc` envelopes (decimal-string `uint256`, block-pinned, source-tagged). That shaping happens at the API serialization layer, not at ingestion. The DB stores raw `NUMERIC(78,0)` and the API formats on the way out.
- **State-snapshot cadence.** The indexer takes `vault_snapshots` and `wallet_positions` rows by:
  - **Trigger 1 (event-driven):** any block in which the indexer ingested a `Deposit`/`Allocated`/`Pulled`/`Rebalanced`/`AgentDeposit` event triggers a state read for the affected contract at that block.
  - **Trigger 2 (heartbeat):** if no snapshot has been written for a watched contract in the last `SNAPSHOT_HEARTBEAT_BLOCKS = 7200` blocks (~4 h on Base), the indexer takes one anyway.
  Both triggers write to the same table with the same `(chain_id, contract, block_number)` key, so heartbeat snapshots are no-ops if an event-driven snapshot already covered that block.
- **Watched event set (initial).** From the contracts in this repo:
  - `IGateway.AgentAuthorized` → `agent_policies` upsert.
  - `IGateway.AgentRevoked` → `agent_policies` upsert (with a tombstone column).
  - `IGateway.AgentDeposit` → `agent_deposits` insert.
  - `IGateway.Paused` / `IGateway.Unpaused` → `agent_policies` global state row (or a `gateway_state` later table — defer).
  - `RobotMoneyVault.Allocated` / `Pulled` / `Rebalanced` / `ExitFeeCharged` / `EmergencyWithdraw*` → trigger `vault_snapshots`.
  - `MockVault.Deposit` (test fixture only, ERC-4626-shaped) → not watched in production.
- **Constraint cited.** §11 "Boundaries" — the explorer is not the source of truth for safety decisions, and `rmpc` is. If the indexer consumed `rmpc` output, the dependency arrow would point the wrong way for any future cross-check.
- **Rejected alternatives.**
  - *Hybrid: ingest `rmpc` output for state reads, JSON-RPC for events.* Two ingestion code paths, one of which is opportunistic and fragile. Rejected.
  - *`rmpc`-output-only.* Indexer becomes a passive recipient of operator queries; can never present a complete event history. Rejected.
  - *Indexer subscribes to a hypothetical `rmpc daemon` event stream.* No such daemon exists (per the architecture pivot memo, the gateway+daemon shape supersedes the vault+OWS shape but does not yet ship). Rejected as premature.

### 3.5a Schema home — **`services/explorer-indexer/migrations/` is canonical; `clients/explorer-api` consumes it via `include_str!` (issue #87, PR #99)**

- **Decision.** The nine §11 minimum-table migrations live in exactly one directory: `services/explorer-indexer/migrations/0001_minimum_tables.sql`. The api crate must not ship a parallel migrations directory. Its test harness reads the canonical SQL via `include_str!("../../../../services/explorer-indexer/migrations/0001_minimum_tables.sql")` and applies it to the testcontainer Postgres (`clients/explorer-api/tests/common/mod.rs`).
- **Why.** Two copies of the same DDL drift silently. Issue #58 (the api scout) acknowledged the duplicate as a known follow-up; issue #87 closes it. The indexer is the natural owner because it writes; the api only reads.
- **Enforcement.** Two CI checks gate this ADR section in `.github/workflows/explorer-schema.yml`:
  1. `.github/scripts/check_explorer_migrations.py` fails if any `.sql` reappears under `clients/explorer-api/migrations/`.
  2. `cargo test -p explorer-api --test canonical_schema` asserts byte-equality between the api's `include_str!` content and the file on disk in the indexer crate, AND asserts (with a Postgres testcontainer) that applying that migration yields the same nine §11 tables observed by `services/explorer-indexer/tests/migrations.rs`.
- **Consequence for wire format.** Address and hash columns are `BYTEA` per ADR §3.4. The api hex-encodes them on the way out so the JSON wire format ("0x"-prefixed lower-case hex for addresses, decimal strings for `uint256`) is unchanged. The api's `Deposit` wire type carries `share_receiver` (the canonical column); there is no per-deposit `token` field — that was a divergence in the old api-owned schema and has been removed.

### 3.6 Optional later tables — explicit defer list

- **Defer until the consumer issue lands.** §11 lists four "optional later" tables. None is built by Phase 5; each waits for a specific downstream consumer to file an issue that names the table as a blocker:

  | Table | Defer trigger |
  | --- | --- |
  | `basket_routes` | First Phase 7 demo issue that needs DEX-route history for OpenClaw. Not before Phase 7. |
  | `governance_events` | First admin-facing dapp issue (Phase 6) that needs to render Safe-multisig history. |
  | `buybacks` | First buyback-execution issue (no current phase). |
  | `agent_task_runs` | First Phase 4 (agent-harness) issue that wants persisted task output beyond the harness's own logs. |

- **Why explicit defer matters.** Without this list, every Phase 5 PR would invite scope creep ("can we add basket_routes while we're here?"). The defer rule is mechanical: if the consumer issue is not open and merged-into-plan, the table is not added.

## 4. Chain scoping — explorer-api is a single-chain service (issue #178)

- **Decision.** `explorer-api` is a *single-chain service*: the EIP-155 chain id it reads from is set once at startup via the `EXPLORER_API_CHAIN_ID` environment variable and stored in `AppState::chain_id`. No request parameter can override the configured chain. Every SQL query that touches a `chain_id` column binds `state.chain_id` unconditionally.

- **Affected queries.** Four read paths were previously ambiguous (no `chain_id` filter):

  | Handler | Table | Old predicate | New predicate |
  | --- | --- | --- | --- |
  | `get_agent` | `agent_policies` | `WHERE agent = $1` | `WHERE chain_id = $1 AND agent = $2` |
  | `list_agent_deposits` | `agent_deposits` | `WHERE agent = $1` | `WHERE chain_id = $1 AND agent = $2` |
  | `get_transaction` | `transactions` | `WHERE tx_hash = $1` | `WHERE chain_id = $1 AND tx_hash = $2` |
  | `get_deposit` | `agent_deposits` | `WHERE payment_id = $1` | `WHERE chain_id = $1 AND payment_id = $2` |

  Without chain scoping, a DB that indexes multiple chains returns the first matching row regardless of chain, violating the composite-PK invariant established in §3.4.

- **Why startup binding and not a per-request param.** A per-request `?chain_id=` query param would allow any caller to read any chain the indexer has populated — an information-boundary violation and a potential vector for cross-chain identity confusion. Binding at startup makes the chain an *operator-controlled* deployment parameter, not a client-controlled input.

- **Enforcement.** The integration tests in `clients/explorer-api/tests/` seed a second "shadow" chain (Ethereum mainnet, id 1) with the same agent address, tx hash, and payment_id as the Base fixture but with detectably different values (`authorized=false`, `status=0`, `amount=9999999`). Four cross-chain isolation tests (`get_agent_returns_only_configured_chain_policy`, `list_agent_deposits_returns_only_configured_chain_deposits`, `get_transaction_returns_only_configured_chain_row`, `get_deposit_returns_only_configured_chain_row`) assert that none of the shadow rows leak into Base-scoped API responses.

- **Constraint cited.** §11 "explorer is never the source of truth for safety decisions" — returning a deposit or policy from the wrong chain would silently corrupt any safety check that consumed the result.

## 5. Impact on `docs/implementation-plan.md` §11

The decisions above are consistent with §11 as written. **No §11 acceptance criterion changes.** The §11 prose can be left unchanged; this ADR provides the missing operational detail (DB engine, cadence, confirmations depth, per-table PKs, ingestion-source rule, defer triggers) that §11 deliberately left out.

A one-line cross-link is added to §11 directing readers to this ADR.

## 6. Newly discovered integration points and risks

- **`Source::Indexer` variant in `rmpc`.** `rmpc-read-output-contract.md` §5 anticipates a future variant. When that lands, the explorer API must expose a "data lineage" field on every response that names the JSON-RPC endpoint family used (e.g. `"alchemy_base_archive"`) and the tip-lag at indexed-at time. Out of scope for Phase 5 implementation; track when `Source::Indexer` is filed.
- **Multi-chain readiness.** Every PK starts with `chain_id`, but the watched-contract list and event-decoder registration are per-chain. Phase 5 ships single-chain (Base mainnet, chain id 8453); multi-chain expansion is a schema-compatible additive change but requires new ADRs for cross-chain query semantics.
- **Reorg storm alerting.** The `indexer_runs.reorg_count` column is the primary signal. Operators should set an alert on `reorg_count > 3 in 1 h`. Out of scope here; flag for the Phase 5 operations runbook.
- **Snapshot-test fixtures.** When the indexer is built, snapshot tests should pin one canonical fork-block and assert exact row contents. The fork-block ADR (`fork-e2e-decisions.md` §3.2) already has the env-var pattern (`RMPC_FORK_BLOCK`, `RMPC_FORK_RPC_URL`); reuse it.
- **`rmpc status` migration.** `rmpc-read-output-contract.md` §5 already lists the `rmpc status` migration as deferred. No interaction with this ADR; mentioned for completeness.
- **Phase 6 dapp coupling.** Phase 6 (Human Dapp) reads from this API for display. The API contract (decimal-string `uint256`, block-pinned, indexed-at time) must land before Phase 6 implementation begins or Phase 6 will hand-roll its own RPC reads and the explorer becomes vestigial.

## 7. References

- `docs/implementation-plan.md` §11 — Phase 5 — Simple Web Explorer API and Database (constraints this ADR resolves).
- `docs/implementation-plan.md` §12 — Phase 6 Human Dapp (downstream consumer).
- `docs/technical/rmpc-read-output-contract.md` — §3.3 (`source: "json_rpc"` lock) and §5 (future `Source::Indexer` variant).
- `docs/technical/fork-e2e-decisions.md` — §3.2 fork-block env-var pattern (reused by indexer integration tests).
- `docs/security-model.md` — explorer-is-not-source-of-truth boundary.
- `contracts/gateway/interfaces/IGateway.sol` — `AgentAuthorized`, `AgentRevoked`, `AgentDeposit`, `Paused`, `Unpaused` events (the watched event set in §3.5).
- `contracts/RobotMoneyVault.sol` — `Allocated`, `Pulled`, `Rebalanced`, `ExitFeeCharged`, `EmergencyWithdraw*` events.
- Issue #56 — this scout.
- User memory: "No fast-feedback optimization in test harness" (cited in §3.1 and §3.2).
- User memory: "Architecture pivot — gateway+daemon supersedes vault+OWS" (cited in §3.5 rejected alternatives).
