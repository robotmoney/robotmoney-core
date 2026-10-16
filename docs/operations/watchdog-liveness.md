<!--
Canonical: docs/architecture.md §5.6 "Watchdog liveness and deployment"
Implements: issue #1378 — a dead watchdog is indistinguishable from a quiet market
-->

# Watchdog liveness: is the watchdog actually watching?

The watchdog pauses gateway deposits (`gateway.pauseDeposits()`) when mint/burn
volume breaches its limits. The pause stops new deposits only. Withdrawals are
never frozen, by anyone (core 1494). In a
calm market it says nothing, and a dead watchdog also says nothing. This page
is how you tell the two apart, what pages you, and what to do about each page.

## The signal

Every successful watchdog poll refreshes `watchdog_cursor.updated_at` for its
chain. That includes a poll that finds no new block, but only while the explorer
indexer is keeping up (QA plan X5, DI-5). A running watchdog keeps it fresh. A
stopped, hung, crash-looping, or startup-failed watchdog lets it age.

A poll with no new block has two causes: a quiet market, or an indexer that has
stopped. The watchdog tells them apart from `indexer_runs`. The indexer is
behind when the chain head it last recorded is more than `max_lag_blocks`
(default 150) ahead of its cursor, or when its last good run is more than
`max_silence_secs` (default 300) old. These are the `[indexer_lag]` keys of the
watchdog config. While the indexer is behind, a poll that finds no new block
does not refresh the heartbeat, and the watchdog pages `indexer_behind:<chain>`
once per `repage_secs` (default 3600). It resolves that page once the indexer
is back within budget. A long indexer catch-up pages too: until it ends, the
watchdog evaluates blocks older than its response SLA.

The watchdog evaluates every indexed block in order and advances its cursor
after each one. That write refreshes the heartbeat only while the cursor is
within `max_cursor_lag_blocks` (default 150, also an `[indexer_lag]` key) of the
indexed head (security round 2). A watchdog that evaluates blocks slower than
the chain makes them keeps going, but its heartbeat ages and
`watchdog-liveness` reports `stale` until it catches up.

A breach alert that the webhook does not accept (non-2xx or timeout) holds the
watchdog cursor on that block. The next poll sends the undelivered alert again
under the same `dedup_key`. It sends the pause again too, unless the gateway's
`depositsPaused()` reads true (security round 1). An operator who unpauses
deposits while the cursor is held sees the watchdog pause them again on the
next poll, until the alert is delivered. Later blocks wait until it is
delivered, so a held cursor also lets the heartbeat age.

A catch-up does not trip the per-hour limits on the backlog. The per-hour
volume of a block counts the hour that ends at that block, never a later block
that is already indexed (security round 3).

Check it by hand from any host that can reach the explorer database:

```text
WATCHDOG_DATABASE_URL=postgres://... \
  watchdog-liveness --chain-id 918453 --max-age-secs 180
echo $?
```

`watchdog-liveness` is built next to `watchdog` by `cargo build -p watchdog
--release`. Keep the database URL in the environment, not on the command line.

| Exit | Output starts with | Meaning |
|------|--------------------|---------|
| `0` | `watchdog liveness healthy` | Last successful poll is within the limit. |
| `1` | `watchdog liveness stale` | The watchdog stopped polling, the indexer it reads is behind, the watchdog is more than `max_cursor_lag_blocks` behind the indexed head, or a breach alert is undelivered. The line ends with `indexer_lag_blocks`, `indexer_since_success_secs` and `indexer_last_run_failed`. |
| `1` | `watchdog liveness missing` | The watchdog never polled this chain, or the chain id is wrong. |
| `2` | `watchdog liveness unknown` | The check itself failed (database down, bad arguments). Treat as down. |

## Who runs the check

On the stage host, `fusion-watchdog.service` runs
`scripts/stage/fusion-watchdog-supervisor.sh`. The supervisor starts the
watchdog, restarts it when it exits, and runs `watchdog-liveness` every poll
interval (12 s) with `--max-age-secs` set to `WATCHDOG_CURSOR_STALE_SECS`
(180 s). It posts to `WATCHDOG_ALERT_WEBHOOK`. Each page kind is sent at most
once per 180 s window.

| Page `kind` | Sent when | Detected within |
|-------------|-----------|-----------------|
| `watchdog_exited` | The watchdog process exited. The detail has the exit status. | one poll (12 s) |
| `watchdog_cursor_stale` | `watchdog-liveness` exited `1`. | 180 s + 12 s |
| `watchdog_liveness_unknown` | `watchdog-liveness` exited with anything else, including "binary not found". | 180 s + 12 s |
| `watchdog_supervisor_failed` | systemd stopped restarting the supervisor (`fusion-watchdog-failed.service`). | 10 failures in 300 s |

The supervisor waits one 180 s window after it starts before its first liveness
check. This gives a freshly restarted watchdog time to poll. An exit is still
paged at once.

A process on the stage host cannot page when the whole host is down. A
production deployment must also run `watchdog-liveness` from a monitor on a
different host. That monitor belongs to the DevOps runtime repository.

## Install

```text
sudo scripts/stage/install-fusion-watchdog.sh
```

`/etc/fusion-watchdog.env` (mode 0600) must set `WATCHDOG_BIN`,
`WATCHDOG_CONFIG`, `WATCHDOG_DATABASE_URL`, `WATCHDOG_CHAIN_ID`, and
`WATCHDOG_ALERT_WEBHOOK`. Set `WATCHDOG_LIVENESS_BIN` only if
`watchdog-liveness` is not in the same directory as `WATCHDOG_BIN`. The
installer refuses to run if that binary is missing.

## Responding to a page

1. Look at why the watchdog stopped:
   `journalctl -u fusion-watchdog.service -n 100`.
2. `startup: config error: invalid pauser key` means the watchdog is in a pause
   mode and its key is not a valid secp256k1 key. It exits at startup on
   purpose and will keep exiting. Fix `WATCHDOG_PAUSER_KEY_HEX` (or
   `action.pauser_private_key_hex`). The committed
   `services/watchdog/config.toml` has an all-zero placeholder key, so it
   always fails this way.
3. `database connect failed` or a `watchdog_liveness_unknown` page means the
   explorer database is unreachable. Fix the database first. The watchdog
   cannot watch without it.
4. `watchdog_cursor_stale` while the process is still running: read the end of
   the page. A large `indexer_lag_blocks` or `indexer_since_success_secs`
   means the explorer indexer stopped, not the watchdog. Its `/health` shows
   `last_run_error`; fix the indexer, and the page clears on its own. An
   `indexer_behind:<chain>` page from the watchdog says the same thing. A
   `breach alert(s) not delivered` line in the journal means the alert webhook
   refuses the watchdog's posts; fix the webhook. Otherwise the poll loop is
   stuck or every poll is failing: look for repeated `cycle error` lines and
   restart with `systemctl restart fusion-watchdog.service`.
5. `missing` right after a fresh install means the watchdog has not seen an
   indexed block yet. Check that the explorer indexer is running for the same
   chain id.
6. When the fix is in, run `watchdog-liveness` by hand and confirm exit `0`.

## Proxy upgrade pages and the first run

The watchdog pages every governed upgrade or freeze of a proxied core contract
once (`services/watchdog/src/upgrade_monitor.rs`). The explorer indexer's proxy
backfill inserts the whole upgrade history at once, so without a rule the first
backfill would page every historical upgrade in one burst (issue 1856).

- When a watchdog starts for the first time on a database, it stores a
  baseline block per chain in `watchdog_proxy_baseline`. It is the indexer's
  cursor (`MAX(last_indexed_block)`), which is also the upper end of the
  backfill. It is not the chain head: an upgrade between the cursor and the
  head is indexed later and must page.
- A proxy event at or below the baseline was indexable before the watchdog ever
  ran. It is logged once at `warn` ("not paged: this proxy change predates the
  watchdog's first run") and recorded in `watchdog_pager_state` as seen. It is
  never paged, even when the backfill inserts it later.
- Every event above the baseline pages as before. That includes a new upgrade,
  a new freeze, and a deployment row the indexer could not mark.
- The baseline is kept. It does not move with the chain.
- The watchdog takes the baseline at startup, before its first cycle. If the
  chain already has a `watchdog_cursor` row or any `watchdog_pager_state` row,
  an older watchdog ran here and may have seen an upgrade it could not deliver
  (webhook down or unset). The baseline is then `-1` and nothing is seeded:
  every unpaged proxy event pages once. This is the rollout of issue 1856 on an
  existing deployment.
- Only the startup call may take the indexer cursor as the baseline. A later
  cycle that finds no baseline stores `-1`. Otherwise an indexer run that
  commits after startup could cover an upgrade mined after the watchdog started,
  and that upgrade would never page (issue 1868).
- With nothing indexed when the watchdog first starts, the startup call stores
  `-1` at once. After a failed startup call the next cycle stores `-1`. Either
  way a restart or a second replica cannot take the indexer cursor later, and
  every historical proxy event the backfill inserts pages once, in one burst.
  This is intended.
  Retrying the cursor baseline until the indexer's first run would reopen the
  race above, and a burst of extra pages is recoverable while a silent upgrade
  is not. Start the watchdog after the indexer has indexed its first blocks to
  get the seeding.
- If the baseline table cannot be read, the watchdog logs an error and pages
  every unpaged proxy event.

Before issue 1856, a watchdog that started before the indexer finished its
backfill paged every unmarked deployment row once. On a fresh install the
baseline now covers those rows.

Before rolling out the issue 1856 baseline on an existing deployment, check
each chain for a prior watchdog. The watchdog infers one from a
`watchdog_cursor` row or any `watchdog_pager_state` row. A watchdog from before
issue 1856 that never stored a cursor and never delivered a page leaves neither,
so the new watchdog would take a cursor baseline and silence history it may
have missed. For each chain the watchdog monitors, run
`SELECT 1 FROM watchdog_cursor WHERE chain_id = <chain>`. If it returns no
row, record a `-1` baseline before the new watchdog starts, unless you know no
watchdog ever ran against this database, so every unpaged proxy event pages once. Run it as the
watchdog's database role, so the watchdog can still read the table:

```sql
CREATE TABLE IF NOT EXISTS watchdog_proxy_baseline (
  chain_id BIGINT NOT NULL,
  baseline_block BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id));
INSERT INTO watchdog_proxy_baseline (chain_id, baseline_block)
VALUES (<chain>, -1) ON CONFLICT (chain_id) DO NOTHING;
```

To re-take the baseline (for example after restoring the database), first make
sure no proxy page is still undelivered: every `admin_events` row with
`contract_kind = 'proxy'` above the old baseline must have a `proxy_change:`
row in `watchdog_pager_state`, or have been reviewed by hand. Re-taking it marks
every event at or below the new cursor as seen, so an undelivered upgrade would
never page. Then delete the chain's row from `watchdog_proxy_baseline`, its
`proxy_change:` rows from `watchdog_pager_state`, and every other row for the
chain in `watchdog_pager_state` and `watchdog_cursor`, and restart the watchdog.

Deleting those rows resets more than the baseline:

- With no `watchdog_cursor` row, the volume cycle restarts at the latest indexed
  block. Blocks between the old cursor and that block are not evaluated for
  mint and burn volume.
- With no `watchdog_pager_state` rows, the liveness pagers (missing consensus
  receipt, no receipt baseline, weight-setter path, indexer behind) re-arm. A
  condition that is still open pages again on the first cycle that sees it.

The indexer reports the backfill's own state in the explorer's `/health` as
`proxy_backfill`. `refused` means the range is too wide: set
`INDEXER_START_BLOCK` and restart the indexer.

## Proving it works

These tests in suite 20 run this whole path:

- `services/watchdog/tests/liveness.rs` runs the real `watchdog` and
  `watchdog-liveness` binaries against Postgres. It checks that the signal stays
  healthy through a quiet market, goes stale after the watchdog is killed, and
  reads `missing` after an invalid-key exit. `stale_indexer_cursor_is_not_healthy`
  checks that a quiet poll behind a wedged indexer does not refresh it.
- `services/watchdog/tests/threshold_breach.rs`
  `failed_webhook_is_retried_next_cycle` checks that an alert the webhook
  refused is sent again on the next poll, and that the cursor waits for it.
- `scripts/stage/test-fusion-watchdog-supervisor.sh` runs the real supervisor
  against stub binaries. It checks that the supervisor pages a crash loop, a
  hung watchdog, and a missing checker, and stays silent in a quiet market.

To see it on a host: stop the watchdog
(`systemctl stop fusion-watchdog.service`), wait 180 s, and run
`watchdog-liveness`. It exits `1` with `stale`. Start the service again and it
returns to `0` within one poll.
