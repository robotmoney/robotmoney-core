//! Issue 1731: the explorer reports the real index cursor and chain head, a vault's own
//! `depositsPaused()` flag, and the Timelock and Safe events.
//!
//! Before the fix `/health` and every `/v1/*` freshness header read the NEWEST `indexer_runs` row. While a
//! tick was in flight (nothing written yet) or after a failed tick that row has no cursor, so `/health` said
//! `last_indexed_block: null` and every response said `block_number: 0` while the index sat at the head.
//!
//! Each test boots its own Postgres container (the shared harness fails loudly, naming Docker, when it
//! cannot), applies the indexer migrations and seeds only what it asserts on.

mod common;

use chrono::{TimeZone, Utc};
use common::{apply_migrations, http, PRIMARY_CHAIN_ID};
use explorer_api::routes::router;
use explorer_api::state::AppState;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

struct Srv {
    addr: std::net::SocketAddr,
    pool: PgPool,
    _c: testcontainers::ContainerAsync<Postgres>,
}

async fn boot() -> Srv {
    let c = Postgres::default()
        .start()
        .await
        .expect("postgres container");
    let host = c.get_host().await.unwrap();
    let port = c.get_host_port_ipv4(5432).await.unwrap();
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&format!(
            "postgres://postgres:postgres@{host}:{port}/postgres"
        ))
        .await
        .unwrap();
    apply_migrations(&pool).await;
    sqlx::query("INSERT INTO chains (chain_id, name, rpc_label) VALUES ($1, 'base', 'stub')")
        .bind(PRIMARY_CHAIN_ID)
        .execute(&pool)
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(AppState::new(pool.clone(), PRIMARY_CHAIN_ID));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Srv { addr, pool, _c: c }
}

async fn get(s: &Srv, path: &str) -> serde_json::Value {
    http()
        .get(format!("http://{}{path}", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

/// (finished, error, last_indexed_block, chain_head_block)
async fn run(
    pool: &PgPool,
    finished: bool,
    error: Option<&str>,
    last: Option<i64>,
    head: Option<i64>,
) {
    let t = Utc.with_ymd_and_hms(2026, 10, 10, 12, 0, 0).unwrap();
    sqlx::query(
        "INSERT INTO indexer_runs (chain_id, started_at, finished_at, from_block, last_indexed_block, \
                                   chain_head_block, error) \
         VALUES ($1, $2, $3, 1, $4, $5, $6)",
    )
    .bind(PRIMARY_CHAIN_ID)
    .bind(t)
    .bind(finished.then_some(t))
    .bind(last)
    .bind(head)
    .bind(error)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn health_and_freshness_use_the_last_good_cursor_not_the_newest_run_row() {
    let s = boot().await;
    run(&s.pool, true, None, Some(1000), Some(1010)).await;
    // The tick in flight and a failed tick are the newest rows. Neither has a cursor.
    run(&s.pool, true, Some("rpc eth_getLogs refused"), None, None).await;
    run(&s.pool, false, None, None, None).await;

    let h = get(&s, "/health").await;
    assert_eq!(h["last_indexed_block"], 1000, "health: {h}");
    assert_eq!(h["chain_head_block"], 1010, "health: {h}");

    let vaults = get(&s, "/v1/vaults").await;
    assert_eq!(vaults["block_number"], 1000, "vaults: {vaults}");
    assert_eq!(vaults["chain_head_block"], 1010);
    let stats = get(&s, "/v1/stats").await;
    assert_eq!(stats["block_number"], 1000, "stats: {stats}");
    assert_eq!(stats["chain_head_block"], 1010);
}

#[tokio::test]
async fn before_anything_is_indexed_the_cursor_and_head_are_null_not_invented() {
    let s = boot().await;
    run(&s.pool, false, None, None, None).await;
    let h = get(&s, "/health").await;
    assert!(h["last_indexed_block"].is_null(), "{h}");
    assert!(h["chain_head_block"].is_null(), "{h}");
}

#[tokio::test]
async fn the_cursor_is_scoped_to_the_chain_of_the_service() {
    let s = boot().await;
    sqlx::query("INSERT INTO chains (chain_id, name, rpc_label) VALUES (1, 'eth', 'x')")
        .execute(&s.pool)
        .await
        .unwrap();
    run(&s.pool, true, None, Some(1000), Some(1010)).await;
    let t = Utc.with_ymd_and_hms(2026, 10, 10, 12, 0, 0).unwrap();
    sqlx::query(
        "INSERT INTO indexer_runs (chain_id, started_at, finished_at, from_block, last_indexed_block, chain_head_block) \
         VALUES (1, $1, $1, 1, 99999, 99999)",
    )
    .bind(t)
    .execute(&s.pool)
    .await
    .unwrap();
    let h = get(&s, "/health").await;
    assert_eq!(
        h["last_indexed_block"], 1000,
        "another chain's cursor must not leak: {h}"
    );
    assert_eq!(h["chain_head_block"], 1010);
}

#[tokio::test]
async fn vaults_report_their_own_deposits_paused_flag_and_null_when_unknown() {
    let s = boot().await;
    run(&s.pool, true, None, Some(1000), Some(1010)).await;
    let t = Utc.with_ymd_and_hms(2026, 10, 10, 12, 0, 0).unwrap();
    for (byte, name, snapshot) in [
        (0xa1u8, "Paused", Some(true)),
        (0xa2, "Open", Some(false)),
        (0xa3, "NoSnapshot", None),
    ] {
        let addr = vec![byte; 20];
        sqlx::query("INSERT INTO contracts (chain_id, address, kind, deployed_block) VALUES ($1, $2, 'vault', 1)")
            .bind(PRIMARY_CHAIN_ID)
            .bind(&addr)
            .execute(&s.pool)
            .await
            .unwrap();
        // Registry status 0 (Active) for all three: the registry does not follow pauseDeposits().
        sqlx::query(
            "INSERT INTO vaults (chain_id, vault_address, name, risk_label, deposit_cap, status, \
                                 registered_at, registered_block, registered_tx) \
             VALUES ($1, $2, $3, 'STABLE_YIELD', 0, 0, 1, 1, $4)",
        )
        .bind(PRIMARY_CHAIN_ID)
        .bind(&addr)
        .bind(name)
        .bind(vec![byte; 32])
        .execute(&s.pool)
        .await
        .unwrap();
        if let Some(paused) = snapshot {
            sqlx::query(
                "INSERT INTO vault_snapshots (chain_id, contract, block_number, total_assets, total_supply, \
                                              exit_fee_bps, tvl_cap, paused, indexed_at) \
                 VALUES ($1, $2, 900, 1, 1, 0, 0, $3, $4)",
            )
            .bind(PRIMARY_CHAIN_ID)
            .bind(&addr)
            .bind(paused)
            .bind(t)
            .execute(&s.pool)
            .await
            .unwrap();
        }
    }
    let body = get(&s, "/v1/vaults").await;
    let by_name = |n: &str| {
        body["vaults"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == n)
            .unwrap_or_else(|| panic!("{n} missing in {body}"))
            .clone()
    };
    assert_eq!(by_name("Paused")["status"], 0);
    assert_eq!(by_name("Paused")["deposits_paused"], true);
    assert_eq!(by_name("Open")["deposits_paused"], false);
    assert!(by_name("NoSnapshot")["deposits_paused"].is_null());
}

#[tokio::test]
async fn the_safe_and_the_timelock_are_listed_and_their_events_are_served() {
    let s = boot().await;
    run(&s.pool, true, None, Some(1000), Some(1010)).await;
    let timelock = vec![0x7au8; 20];
    let safe = vec![0x5eu8; 20];
    for (addr, kind) in [(&timelock, "timelock"), (&safe, "safe")] {
        sqlx::query("INSERT INTO contracts (chain_id, address, kind) VALUES ($1, $2, $3)")
            .bind(PRIMARY_CHAIN_ID)
            .bind(addr)
            .bind(kind)
            .execute(&s.pool)
            .await
            .unwrap();
    }
    for (block, idx, contract, kind, name, op, detail) in [
        (
            500i64,
            0i32,
            &timelock,
            "timelock",
            "CallScheduled",
            Some(vec![0xabu8; 32]),
            r#"{"delay":"172800"}"#,
        ),
        (
            600,
            1,
            &safe,
            "safe",
            "ExecutionSuccess",
            Some(vec![0xcdu8; 32]),
            r#"{"payment":"0"}"#,
        ),
    ] {
        sqlx::query(
            "INSERT INTO admin_events (chain_id, block_number, log_index, tx_hash, contract, contract_kind, \
                                      event_name, op_id, detail) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(PRIMARY_CHAIN_ID)
        .bind(block)
        .bind(idx)
        .bind(vec![0x01u8; 32])
        .bind(contract)
        .bind(kind)
        .bind(name)
        .bind(op)
        .bind(detail)
        .execute(&s.pool)
        .await
        .unwrap();
    }
    let contracts = get(&s, "/v1/chains/8453/contracts").await;
    let kinds: Vec<(String, String)> = contracts["contracts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["address"].as_str().unwrap().to_string(),
                c["kind"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert!(
        kinds.contains(&(format!("0x{}", "7a".repeat(20)), "timelock".into())),
        "{kinds:?}"
    );
    assert!(
        kinds.contains(&(format!("0x{}", "5e".repeat(20)), "safe".into())),
        "{kinds:?}"
    );

    let ev = get(&s, "/v1/governance/admin-events").await;
    let events = ev["events"].as_array().unwrap();
    assert_eq!(events.len(), 2, "{ev}");
    assert_eq!(
        events[0]["event_name"], "ExecutionSuccess",
        "newest first: {ev}"
    );
    assert_eq!(events[0]["contract_kind"], "safe");
    assert_eq!(events[1]["event_name"], "CallScheduled");
    assert_eq!(events[1]["detail"]["delay"], "172800");
    assert_eq!(events[1]["op_id"], format!("0x{}", "ab".repeat(32)));
    assert_eq!(ev["block_number"], 1000);
}

/// Seed one registered vault with an optional snapshot at block 900:
/// (total_assets, tvl_cap, per_deposit_cap). Registry `deposit_cap` is 0, as the indexer writes it.
async fn seed_vault(
    pool: &PgPool,
    byte: u8,
    name: &str,
    snapshot: Option<(&str, Option<&str>, Option<&str>)>,
) -> String {
    let t = Utc.with_ymd_and_hms(2026, 10, 10, 12, 0, 0).unwrap();
    let addr = vec![byte; 20];
    sqlx::query(
        "INSERT INTO contracts (chain_id, address, kind, deployed_block) VALUES ($1, $2, 'vault', 1)",
    )
    .bind(PRIMARY_CHAIN_ID)
    .bind(&addr)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO vaults (chain_id, vault_address, name, risk_label, deposit_cap, status, \
                             registered_at, registered_block, registered_tx) \
         VALUES ($1, $2, $3, 'STABLE_YIELD', 0, 0, 1, 1, $4)",
    )
    .bind(PRIMARY_CHAIN_ID)
    .bind(&addr)
    .bind(name)
    .bind(vec![byte; 32])
    .execute(pool)
    .await
    .unwrap();
    if let Some((assets, tvl_cap, per_deposit_cap)) = snapshot {
        sqlx::query(
            "INSERT INTO vault_snapshots (chain_id, contract, block_number, total_assets, total_supply, \
                                          exit_fee_bps, tvl_cap, per_deposit_cap, paused, indexed_at) \
             VALUES ($1, $2, 900, $3::NUMERIC, 1, 0, $4::NUMERIC, $5::NUMERIC, false, $6)",
        )
        .bind(PRIMARY_CHAIN_ID)
        .bind(&addr)
        .bind(assets)
        .bind(tvl_cap)
        .bind(per_deposit_cap)
        .bind(t)
        .execute(pool)
        .await
        .unwrap();
    }
    format!("0x{}", hex::encode(addr))
}

#[tokio::test]
async fn vaults_serve_the_real_caps_and_a_headroom_and_null_when_a_cap_is_unknown() {
    let s = boot().await;
    run(&s.pool, true, None, Some(1000), Some(1010)).await;
    // The rehearsal numbers: USDC vault TVL cap 1000 USDC, per-deposit cap 100 USDC, 1.000045 USDC deposited.
    let usdc = seed_vault(
        &s.pool,
        0xb1,
        "Usdc",
        Some(("1000045", Some("1000000000"), Some("100000000"))),
    )
    .await;
    // Agent Tokens: 100 USDC TVL cap, 15 USDC per-deposit cap.
    let agent = seed_vault(
        &s.pool,
        0xb2,
        "Agent",
        Some(("0", Some("100000000"), Some("15000000"))),
    )
    .await;
    // Over the cap (a cap lowered below the NAV): headroom is 0, never negative.
    let over = seed_vault(
        &s.pool,
        0xb3,
        "Over",
        Some(("2000000000", Some("1000000000"), Some("100000000"))),
    )
    .await;
    // A failed tvlCap() read is NULL: the cap AND the headroom are unknown, not 0.
    let unknown = seed_vault(
        &s.pool,
        0xb4,
        "Unknown",
        Some(("5", None, Some("100000000"))),
    )
    .await;
    let none = seed_vault(&s.pool, 0xb5, "NoSnapshot", None).await;

    let body = get(&s, "/v1/vaults").await;
    let by_name = |n: &str| {
        body["vaults"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == n)
            .unwrap_or_else(|| panic!("{n} missing in {body}"))
            .clone()
    };
    let u = by_name("Usdc");
    assert_eq!(u["tvl_cap"], "1000000000");
    assert_eq!(u["per_deposit_cap"], "100000000");
    assert_eq!(u["headroom"], "998999955");
    assert_eq!(u["snapshot_block"], 900);
    assert!(
        u.get("deposit_cap").is_none(),
        "the registry deposit_cap (always 0) is gone from the wire: {u}"
    );
    let a = by_name("Agent");
    assert_eq!(a["tvl_cap"], "100000000");
    assert_eq!(a["per_deposit_cap"], "15000000");
    assert_eq!(a["headroom"], "100000000");
    assert_eq!(by_name("Over")["headroom"], "0");
    let k = by_name("Unknown");
    assert!(k["tvl_cap"].is_null(), "{k}");
    assert!(
        k["headroom"].is_null(),
        "unknown cap is not zero headroom: {k}"
    );
    assert_eq!(k["per_deposit_cap"], "100000000");
    let n = by_name("NoSnapshot");
    for f in ["tvl_cap", "per_deposit_cap", "headroom", "snapshot_block"] {
        assert!(n[f].is_null(), "{f} of a vault with no snapshot: {n}");
    }

    // The detail endpoint serves the same numbers, and the index block is the cursor (1000), not the snapshot (900).
    let d = get(&s, &format!("/v1/vaults/{usdc}")).await;
    assert_eq!(d["vault"]["tvl_cap"], "1000000000");
    assert_eq!(d["vault"]["per_deposit_cap"], "100000000");
    assert_eq!(d["vault"]["headroom"], "998999955");
    assert_eq!(d["vault"]["snapshot_block"], 900);
    assert_eq!(d["block_number"], 1000, "the index block: {d}");
    assert_eq!(d["chain_head_block"], 1010);
    assert_eq!(
        d["vault"]["tvl_history"][0]["block_number"], 900,
        "the history still carries the snapshot block"
    );
    let over_d = get(&s, &format!("/v1/vaults/{over}")).await;
    assert_eq!(over_d["vault"]["headroom"], "0");
    let unknown_d = get(&s, &format!("/v1/vaults/{unknown}")).await;
    assert!(unknown_d["vault"]["tvl_cap"].is_null());
    assert!(unknown_d["vault"]["headroom"].is_null());
    let none_d = get(&s, &format!("/v1/vaults/{none}")).await;
    assert!(none_d["vault"]["tvl_cap"].is_null());
    assert!(none_d["vault"]["snapshot_block"].is_null());
    assert_eq!(none_d["block_number"], 1000);
    let _ = agent;
}

#[tokio::test]
async fn vault_detail_block_number_is_the_cursor_even_when_the_last_snapshot_is_old() {
    let s = boot().await;
    // The indexer is at 52424271 with the head at 52424276, the last snapshot of the vault is 22k blocks old.
    run(&s.pool, true, None, Some(52_424_271), Some(52_424_276)).await;
    let addr = seed_vault(
        &s.pool,
        0xc1,
        "Usdc",
        Some(("1000045", Some("1000000000"), Some("100000000"))),
    )
    .await;
    let d = get(&s, &format!("/v1/vaults/{addr}")).await;
    assert_eq!(d["block_number"], 52_424_271, "the index block: {d}");
    assert_eq!(d["chain_head_block"], 52_424_276);
    assert_eq!(d["vault"]["snapshot_block"], 900);
}
