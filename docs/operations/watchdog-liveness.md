<!--
Canonical: docs/architecture.md §5.6 "Watchdog liveness and deployment"
Implements: issue #1378 — a dead watchdog is indistinguishable from a quiet market
-->

# Watchdog liveness: is the watchdog actually watching?

The watchdog pauses the gateway when mint/burn volume breaches its limits. The
pause stops new gateway deposits only. Withdrawals are never frozen, by anyone
(core 1494). In a
calm market it says nothing, and a dead watchdog also says nothing. This page
is how you tell the two apart, what pages you, and what to do about each page.

## The signal

Every successful watchdog poll refreshes `watchdog_cursor.updated_at` for its
chain. That includes a poll that finds no new block. A running watchdog keeps it
fresh. A stopped, hung, crash-looping, or startup-failed watchdog lets it age.

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
| `1` | `watchdog liveness stale` | The watchdog stopped polling. |
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
4. `watchdog_cursor_stale` while the process is still running means the poll
   loop is stuck or every poll is failing. Look for repeated `cycle error`
   lines. Restart with `systemctl restart fusion-watchdog.service`.
5. `missing` right after a fresh install means the watchdog has not seen an
   indexed block yet. Check that the explorer indexer is running for the same
   chain id.
6. When the fix is in, run `watchdog-liveness` by hand and confirm exit `0`.

## Proving it works

Two tests in suite 20 run this whole path:

- `services/watchdog/tests/liveness.rs` runs the real `watchdog` and
  `watchdog-liveness` binaries against Postgres. It checks that the signal stays
  healthy through a quiet market, goes stale after the watchdog is killed, and
  reads `missing` after an invalid-key exit.
- `scripts/stage/test-fusion-watchdog-supervisor.sh` runs the real supervisor
  against stub binaries. It checks that the supervisor pages a crash loop, a
  hung watchdog, and a missing checker, and stays silent in a quiet market.

To see it on a host: stop the watchdog
(`systemctl stop fusion-watchdog.service`), wait 180 s, and run
`watchdog-liveness`. It exits `1` with `stale`. Start the service again and it
returns to `0` within one poll.
