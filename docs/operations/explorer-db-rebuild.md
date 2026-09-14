# Explorer database rebuild and reindex

**Scope.** How to apply a migration that cannot backfill, rebuild the explorer
database from chain, and seed the watchdog baseline deliberately instead of
discovering it during an incident.

**Written for** migration `0016_consensus_receipts_contract_scope.sql`, which is
the first migration in this service that deliberately **refuses to run** against
a populated table. The procedure generalises to any later one that does.

---

## 1. Why a rebuild, and why exactly once

`0016` does two things (Fusion round-2 code review T20 and T12):

- **T20** changes the `consensus_receipts` primary key from
  `(chain_id, receipt_id)` to `(chain_id, contract_address, receipt_id)`.
  `receipt_id = keccak256(domain || session_id || "\n" || subject_id)` is
  identical across every deployment of `ConsensusRecommendationReceipt`, so the
  old key collided across deployments on one chain — devnet 918453 already
  carries two — and the superseded deployment's row silently won.
- **T12** adds `verified_at`, `verify_attempts` and `last_verify_error`, the
  state the re-verification sweep needs to converge and to stop.

There is **no sound backfill** for `contract_address`: the emitting address was
never recorded, and inferring it from the `contracts` table would stamp rows
written by a superseded deployment with the address of the current one —
manufacturing exactly the false provenance the migration exists to prevent. So
the migration raises an exception on a non-empty table and the data is rebuilt
from chain, which is authoritative.

**Sequence it with the contract redeploy.** If the deployment plan also
redeploys the receipt/governance wiring (§B1/B2), do the redeploy and the
rebuild in one window, so the database is rebuilt **once** and the watchdog
baseline is seeded once.

---

## 2. Before you touch anything: dump

A dump is not a rollback plan here (the old rows cannot be re-imported into the
new key), it is **evidence**. Take it anyway.

```bash
# On the host running the explorer stack.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
docker compose exec -T dapp-postgres \
  pg_dump -U "$PGUSER" -d "$PGDATABASE" \
          --table=consensus_receipts --table=indexer_runs \
          --data-only --column-inserts \
  > "explorer-predrop-${STAMP}.sql"

# Row counts, for the before/after comparison in §6.
docker compose exec -T dapp-postgres psql -U "$PGUSER" -d "$PGDATABASE" -At -c \
  "SELECT 'consensus_receipts', count(*) FROM consensus_receipts
   UNION ALL SELECT 'indexer_runs', count(*) FROM indexer_runs
   UNION ALL SELECT 'min_started_at', min(started_at)::text FROM indexer_runs;" \
  | tee "explorer-precounts-${STAMP}.txt"
```

Copy both files into the evidence bundle **before** step 3. A rebuild whose
"before" state was never captured is not a recorded acceptance step.

---

## 3. Record the watchdog cold-start baseline

The watchdog derives its cold-start baseline from `MIN(indexer_runs.started_at)`
and that value is deliberately not resettable from the watchdog side. Wiping the
database moves the baseline to "now", and a chain with no anchors after the wipe
lands in `NoBaseline` and **pages**.

So, before the wipe:

1. Read and record `MIN(indexer_runs.started_at)` (captured in §2).
2. Decide, and write down, whether the post-rebuild baseline should be
   (a) the recorded original value, re-seeded, or (b) the rebuild time, accepted
   as a new baseline.
3. If (a): after §5 completes, re-seed it explicitly rather than letting the
   first post-rebuild run define it.

Do not skip this because "the rebuild is quick". The page fires on the gap
between the baseline and the first anchor, not on the length of the outage.

---

## 4. Stop the writers

```bash
# Stop the indexer AND the watchdog: a watchdog tick against a half-rebuilt
# database reads a real cursor gap and alerts on it.
systemctl stop fusion-watchdog.service
docker compose --env-file <env> -f <compose> -f <override> stop dapp-indexer
```

The explorer API may stay up; it will serve a shrinking dataset during the
rebuild, which is correct and visible.

---

## 5. Drop, migrate, reindex

`sqlx` migrations run automatically at indexer start. The only manual step is
clearing the state `0016` refuses to migrate.

```bash
# Option A (preferred): full rebuild from genesis. Deterministic, and it also
# re-derives every other table from chain.
docker compose exec -T dapp-postgres psql -U "$PGUSER" -d "$PGDATABASE" -c \
  "DROP TABLE IF EXISTS consensus_receipts CASCADE;
   DELETE FROM _sqlx_migrations WHERE version = 15;"

# Option B (narrow): keep every other table, clear only the receipt register.
# Use only when a full reindex is not affordable; the receipt rows are rebuilt
# from chain either way.
docker compose exec -T dapp-postgres psql -U "$PGUSER" -d "$PGDATABASE" -c \
  "TRUNCATE consensus_receipts;"
```

> **`docker compose down -v` is NOT part of this procedure.** `-v` destroys the
> volume, and with it every table plus `indexer_runs` — i.e. the watchdog
> baseline of §3 — in one unreviewable step. Use it only as a deliberate,
> separately recorded decision (evidence-plan C-8), never as the default way to
> get a clean database.

Then start the indexer and let it migrate and reindex:

```bash
docker compose --env-file <env> -f <compose> -f <override> up -d --no-build dapp-indexer
docker compose logs -f dapp-indexer      # watch 0016 apply, then the scan
```

If the indexer exits with
`migration 0016 cannot backfill consensus_receipts.contract_address for N existing row(s)`,
the clear in this step did not happen or did not commit. Do not edit the
migration — re-run the clear.

---

## 6. Verify before declaring the rebuild done

```bash
docker compose exec -T dapp-postgres psql -U "$PGUSER" -d "$PGDATABASE" -At -c "
  SELECT count(*) FILTER (WHERE TRUE)            AS receipts,
         count(*) FILTER (WHERE verified)        AS verified,
         count(*) FILTER (WHERE NOT verified)    AS unverified,
         count(DISTINCT contract_address)        AS deployments
  FROM consensus_receipts;"
```

Check, in order:

1. **Every receipt is back.** `receipts` matches the pre-drop count from §2, or
   exceeds it (a re-anchored commitment that the old key silently discarded now
   has its own row — that is T20 working, and the difference should be
   explainable receipt-by-receipt).
2. **`contract_address` is the configured deployment.** Every distinct value must
   be a receipt-contract address you deployed. `handle_log` now gates on
   `log.address`, so a foreign address here means the indexer config is wrong.
3. **`unverified` converges.** It may be non-zero right after the scan; the
   re-verification sweep drains a bounded batch per tick. Re-run this query
   after a few ticks — it must fall. Rows that stay unverified carry
   `last_verify_error`, which says whether the cause is the payload host or a
   real digest mismatch.
4. **The cursor advanced.** `SELECT max(last_indexed_block) FROM indexer_runs
   WHERE error IS NULL;` is at the chain head.
5. **The baseline is what §3 decided.** Re-seed it now if the decision was (a).

Only then:

```bash
systemctl start fusion-watchdog.service
journalctl -u fusion-watchdog.service -n 50   # must not be in NoBaseline
```

---

## 7. Release-runbook hook

This procedure is a **preflight** item, not a postflight one: it runs inside the
cutover window, between the contract deploy and the manual QA pass. See
`docs/operations/contract-release-runbooks.md` §4.2 and §4.3 — a release that
ships a refusing migration must name this document in its per-release runbook
and record the §2 dump and the §6 verification output as release evidence.
