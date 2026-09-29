//! Issue #1378: a dead watchdog must be distinguishable from a quiet market.
//!
//! Canonical: docs/architecture.md §5.6 "Watchdog liveness and deployment";
//! operator runbook: docs/operations/watchdog-liveness.md.
//!
//! These tests drive the real `watchdog` and `watchdog-liveness` binaries
//! (`CARGO_BIN_EXE_*`) against a Postgres testcontainer, so they exercise the
//! exact signal an operator's monitor sees:
//!
//! - a running watchdog with **no new indexed blocks** (quiet market) keeps the
//!   heartbeat healthy for longer than the staleness limit;
//! - killing it degrades the signal to `stale` (exit 1) within a bounded time;
//! - an invalid pauser key exits the daemon at startup, non-zero, and the
//!   checker then reports `missing` rather than silence.
//!
//! Run: `cargo test -p watchdog --test liveness -- --test-threads=1`.

mod common;

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    time::{Duration, Instant},
};

use common::pg_fixture;
use reqwest::Client;
use watchdog::{
    config::Config,
    liveness::{check_cursor_liveness, CursorLiveness, EXIT_HEALTHY, EXIT_UNHEALTHY},
    watchdog::{load_cursor, run_cycles_since_cursor, store_cursor, CycleResult},
};

const CHAIN_ID: i64 = 918_453;
const INDEXED_HEAD: i64 = 100;

/// Liveness limit used by the process-level tests. Short so the suite stays
/// fast; the daemon polls every second, so a healthy heartbeat is never older
/// than ~1 s.
const MAX_AGE_SECS: u64 = 3;

/// Every `WATCHDOG_*` variable either binary reads from the environment. The
/// spawned processes get these removed so a developer's or runner's shell can
/// never change what the test is asserting.
const WATCHDOG_ENV: &[&str] = &[
    "WATCHDOG_CONFIG",
    "WATCHDOG_DATABASE_URL",
    "WATCHDOG_CHAIN_ID",
    "WATCHDOG_POLL_INTERVAL_SECS",
    "WATCHDOG_PAUSER_KEY_HEX",
    "WATCHDOG_LIVENESS_MAX_AGE_SECS",
];

// ---- helpers ---------------------------------------------------------------

/// Kill-on-drop guard so a failed assertion never leaks a daemon.
struct Daemon(Child);

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn temp_config(name: &str, body: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "watchdog-liveness-{name}-{}-{}.toml",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::write(&path, body).unwrap();
    path
}

/// Alert-only config: no pauser key, receipt and governance checks off, so the
/// daemon's only database side effect is the cursor.
fn alert_only_config() -> String {
    r#"
[global]
per_block_mint_limit_usdc = "1000000"
per_hour_mint_limit_usdc = "1000000"
per_block_burn_limit_usdc = "1000000"
per_hour_burn_limit_usdc = "1000000"

[action]
mode = "alert"
webhook_url = "http://127.0.0.1:1/never-called"

[sla]
max_response_secs = 300
"#
    .to_owned()
}

/// Pause-mode config whose pauser key is all zeros — not a valid secp256k1
/// scalar. This is the shape of the committed `services/watchdog/config.toml`
/// that motivated #1378.
fn invalid_key_config() -> String {
    r#"
[global]
per_block_mint_limit_usdc = "1"
per_hour_mint_limit_usdc = "1"
per_block_burn_limit_usdc = "1"
per_hour_burn_limit_usdc = "1"

[action]
mode = "pause"
gateway_rpc_url = "http://127.0.0.1:1"
gateway_address = "0x0000000000000000000000000000000000000001"
pauser_private_key_hex = "0x0000000000000000000000000000000000000000000000000000000000000000"

[sla]
max_response_secs = 300
"#
    .to_owned()
}

fn watchdog_cmd(config: &Path, database_url: &str) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_watchdog"));
    for k in WATCHDOG_ENV {
        cmd.env_remove(k);
    }
    cmd.args([
        "--config",
        config.to_str().unwrap(),
        "--database-url",
        database_url,
        "--chain-id",
        &CHAIN_ID.to_string(),
        "--poll-interval-secs",
        "1",
    ]);
    cmd
}

/// Run `watchdog-liveness` the way the stage supervisor does: the database URL
/// comes from the environment, never argv.
fn liveness(database_url: &str) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_watchdog-liveness"));
    for k in WATCHDOG_ENV {
        cmd.env_remove(k);
    }
    cmd.env("WATCHDOG_DATABASE_URL", database_url)
        .args([
            "--chain-id",
            &CHAIN_ID.to_string(),
            "--max-age-secs",
            &MAX_AGE_SECS.to_string(),
        ])
        .output()
        .unwrap()
}

fn code(o: &Output) -> i32 {
    o.status.code().expect("liveness killed by a signal")
}

fn text(o: &Output) -> String {
    format!(
        "stdout={:?} stderr={:?}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

/// Run a daemon that is expected to exit on its own, but never block the suite
/// on one that does not: past `within` it is killed and the test fails.
fn run_expecting_exit(mut cmd: Command, within: Duration) -> Output {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    while child.try_wait().unwrap().is_none() {
        if started.elapsed() >= within {
            let _ = child.kill();
            let out = child.wait_with_output().unwrap();
            panic!(
                "watchdog did not exit within {within:?} — it kept running: {}",
                text(&out)
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    child.wait_with_output().unwrap()
}

/// Poll `watchdog-liveness` until it returns `want`, or panic after `within`.
fn wait_for_liveness(database_url: &str, want: u8, within: Duration) -> (Duration, Output) {
    let started = Instant::now();
    loop {
        let out = liveness(database_url);
        if code(&out) == i32::from(want) {
            return (started.elapsed(), out);
        }
        assert!(
            started.elapsed() < within,
            "watchdog-liveness never returned {want} within {within:?}; last: {}",
            text(&out)
        );
        std::thread::sleep(Duration::from_millis(250));
    }
}

async fn seed_indexed_head(pool: &sqlx::PgPool) {
    sqlx::query(
        "INSERT INTO chains (chain_id, name, rpc_label) VALUES ($1, 'test', 'test') \
         ON CONFLICT DO NOTHING",
    )
    .bind(CHAIN_ID)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO indexer_runs (chain_id, started_at, from_block, last_indexed_block) \
         VALUES ($1, now(), 0, $2)",
    )
    .bind(CHAIN_ID)
    .bind(INDEXED_HEAD)
    .execute(pool)
    .await
    .unwrap();
}

async fn age_heartbeat(pool: &sqlx::PgPool, secs: i64) {
    sqlx::query(
        "UPDATE watchdog_cursor SET updated_at = now() - make_interval(secs => $2) \
         WHERE chain_id = $1",
    )
    .bind(CHAIN_ID)
    .bind(secs as f64)
    .execute(pool)
    .await
    .unwrap();
}

// ---- library-level ---------------------------------------------------------

/// The heartbeat half of the fix: a poll that finds no newly indexed block
/// must still refresh `updated_at` — without moving the cursor, which would
/// skip blocks. Without `touch_cursor` a quiet market ages the heartbeat
/// exactly like a dead daemon.
#[tokio::test]
async fn quiet_poll_refreshes_heartbeat_without_moving_the_cursor() {
    let fx = pg_fixture().await;
    seed_indexed_head(&fx.pool).await;
    store_cursor(&fx.pool, CHAIN_ID, INDEXED_HEAD)
        .await
        .unwrap();
    age_heartbeat(&fx.pool, 600).await;
    assert!(matches!(
        check_cursor_liveness(&fx.pool, CHAIN_ID, 60).await.unwrap(),
        CursorLiveness::Stale { .. }
    ));

    let cfg_path = temp_config("quiet", &alert_only_config());
    let config = Config::from_file(&cfg_path).unwrap();
    fs::remove_file(&cfg_path).unwrap();

    let result = run_cycles_since_cursor(
        &fx.pool,
        &config,
        &Client::new(),
        CHAIN_ID,
        INDEXED_HEAD,
        None,
    )
    .await
    .unwrap();
    assert_eq!(result, CycleResult::NoData, "nothing new was indexed");
    assert_eq!(
        load_cursor(&fx.pool, CHAIN_ID).await.unwrap(),
        Some(INDEXED_HEAD),
        "a quiet poll must not advance the progress cursor"
    );
    assert!(
        check_cursor_liveness(&fx.pool, CHAIN_ID, 60)
            .await
            .unwrap()
            .is_healthy(),
        "a successful quiet poll must refresh the heartbeat"
    );
}

/// The checker's three states against a real `watchdog_cursor` row.
#[tokio::test]
async fn checker_reports_healthy_then_stale_then_missing() {
    let fx = pg_fixture().await;
    seed_indexed_head(&fx.pool).await;

    assert_eq!(
        check_cursor_liveness(&fx.pool, CHAIN_ID, 60).await.unwrap(),
        CursorLiveness::Missing,
        "no cursor row is not health"
    );

    store_cursor(&fx.pool, CHAIN_ID, INDEXED_HEAD)
        .await
        .unwrap();
    assert_eq!(
        check_cursor_liveness(&fx.pool, CHAIN_ID, 60).await.unwrap(),
        CursorLiveness::Healthy { age_secs: 0 }
    );

    age_heartbeat(&fx.pool, 61).await;
    assert_eq!(
        check_cursor_liveness(&fx.pool, CHAIN_ID, 60).await.unwrap(),
        CursorLiveness::Stale { age_secs: 61 }
    );

    assert_eq!(
        check_cursor_liveness(&fx.pool, CHAIN_ID + 1, 60)
            .await
            .unwrap(),
        CursorLiveness::Missing,
        "a wrong chain id must read as missing, never as healthy"
    );
}

// ---- process-level (the operator's view) -------------------------------------

/// Acceptance criterion 1 / test plan 1: start the watchdog, confirm the
/// liveness signal is healthy — and stays healthy through a quiet market longer
/// than the staleness limit — then stop it and confirm the signal degrades
/// within a bounded interval.
#[tokio::test]
async fn running_watchdog_stays_healthy_when_quiet_and_goes_stale_when_stopped() {
    let fx = pg_fixture().await;
    seed_indexed_head(&fx.pool).await;

    let before = liveness(&fx.url);
    assert_eq!(
        code(&before),
        i32::from(EXIT_UNHEALTHY),
        "before the watchdog ever ran: {}",
        text(&before)
    );
    assert!(String::from_utf8_lossy(&before.stderr).contains("missing"));

    let cfg = temp_config("daemon", &alert_only_config());
    let mut daemon = Daemon(
        watchdog_cmd(&cfg, &fx.url)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );

    wait_for_liveness(&fx.url, EXIT_HEALTHY, Duration::from_secs(30));

    // Quiet market: the indexer head never moves. Stay quiet for twice the
    // staleness limit; the heartbeat must remain healthy the whole time.
    let quiet_until = Instant::now() + Duration::from_secs(MAX_AGE_SECS * 2 + 1);
    while Instant::now() < quiet_until {
        assert!(
            daemon.0.try_wait().unwrap().is_none(),
            "watchdog exited unexpectedly"
        );
        let out = liveness(&fx.url);
        assert_eq!(
            code(&out),
            i32::from(EXIT_HEALTHY),
            "a running watchdog in a quiet market must read healthy: {}",
            text(&out)
        );
        std::thread::sleep(Duration::from_millis(500));
    }
    assert_eq!(
        load_cursor(&fx.pool, CHAIN_ID).await.unwrap(),
        Some(INDEXED_HEAD),
        "the daemon evaluated the indexed head exactly once"
    );

    // Stop it. SIGKILL: no chance to write a farewell.
    daemon.0.kill().unwrap();
    daemon.0.wait().unwrap();

    // Bound: the last heartbeat is at most one poll (1 s) old at kill time, so
    // the signal must degrade within MAX_AGE_SECS plus that poll and slack.
    let bound = Duration::from_secs(MAX_AGE_SECS + 3);
    let (elapsed, out) = wait_for_liveness(&fx.url, EXIT_UNHEALTHY, bound);
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("stale"),
        "a stopped watchdog reads stale: {}",
        text(&out)
    );
    assert!(elapsed <= bound, "degraded after {elapsed:?} > {bound:?}");
    fs::remove_file(&cfg).unwrap();
}

/// Test plan 2: an invalid pauser key exits at startup, non-zero, naming the
/// key — and the exit is detectable by the liveness check rather than silent.
#[tokio::test]
async fn invalid_pauser_key_exits_at_startup_and_liveness_reports_it() {
    let fx = pg_fixture().await;
    seed_indexed_head(&fx.pool).await;

    let cfg = temp_config("invalid-key", &invalid_key_config());
    // Immediate: the key is checked before the first poll, so a startup
    // failure never needs a poll interval to surface.
    let out = run_expecting_exit(watchdog_cmd(&cfg, &fx.url), Duration::from_secs(20));
    fs::remove_file(&cfg).unwrap();

    assert!(
        !out.status.success(),
        "invalid key must fail startup: {}",
        text(&out)
    );
    let logs = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        logs.contains("invalid pauser key"),
        "startup error must identify the invalid pauser key: {logs}"
    );

    // The daemon never polled, so there is no heartbeat: the checker reports it.
    let check = liveness(&fx.url);
    assert_eq!(
        code(&check),
        i32::from(EXIT_UNHEALTHY),
        "an exited watchdog must not read healthy: {}",
        text(&check)
    );
    assert!(String::from_utf8_lossy(&check.stderr).contains("missing"));
}

/// The key is validated before any database work: a pause-mode daemon that
/// cannot sign must not come up as an alert-only process first.
#[test]
fn invalid_pauser_key_exits_before_connecting_to_the_database() {
    let cfg = temp_config("invalid-key-nodb", &invalid_key_config());
    let out = run_expecting_exit(
        watchdog_cmd(&cfg, "postgres://not-contacted.invalid/watchdog"),
        Duration::from_secs(20),
    );
    fs::remove_file(&cfg).unwrap();

    assert!(!out.status.success(), "invalid key must fail startup");
    let logs = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(logs.contains("invalid pauser key"), "{logs}");
    assert!(
        !logs.contains("database connect failed"),
        "the key check must run before the database connect: {logs}"
    );
}

/// An unreachable database is `unknown` (exit 2), never healthy.
#[test]
fn liveness_is_unknown_when_the_database_is_unreachable() {
    let out = liveness("postgres://postgres:postgres@127.0.0.1:1/postgres");
    assert_eq!(code(&out), 2, "{}", text(&out));
    assert!(String::from_utf8_lossy(&out.stderr).contains("unknown"));
}
