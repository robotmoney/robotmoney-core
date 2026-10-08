//! Issue #1430 — `explorer-api` refuses to boot against a stale schema.
//!
//! These tests drive the COMPILED `explorer-api` binary against a real Postgres
//! testcontainer. The guard itself is the indexer's (`compare_schema`, shared on
//! purpose); what is proved here is that the API binary is wired to it: a stale
//! schema exits non-zero naming both versions without ever binding, and a
//! matching schema starts and serves. Docker is required and its absence fails
//! loudly (a testcontainer start failure panics).

use std::net::TcpListener;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use explorer_indexer::db::embedded_schema_version;
use explorer_indexer::Db;
use testcontainers::runners::AsyncRunner;
use testcontainers::ContainerAsync;
use testcontainers_modules::postgres::Postgres;

struct Pg {
    url: String,
    _c: ContainerAsync<Postgres>,
}

async fn pg() -> Pg {
    let c = Postgres::default()
        .start()
        .await
        .expect("Docker/Postgres testcontainer must start (hard failure, not a skip)");
    let host = c.get_host().await.expect("host");
    let port = c.get_host_port_ipv4(5432).await.expect("port");
    Pg {
        url: format!("postgres://postgres:postgres@{host}:{port}/postgres"),
        _c: c,
    }
}

fn free_addr() -> String {
    let l = TcpListener::bind("127.0.0.1:0").expect("bind probe");
    let a = l.local_addr().expect("addr");
    format!("{a}")
}

fn command(url: &str, bind: &str) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_explorer-api"));
    c.env("DATABASE_URL", url)
        .env("EXPLORER_API_CHAIN_ID", "8453")
        .env("EXPLORER_API_BIND", bind)
        .env_remove("EXPLORER_API_ALLOW_ORIGINS");
    c
}

fn describe(out: &Output) -> String {
    format!(
        "status={:?}\n--- stdout ---\n{}\n--- stderr ---\n{}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    )
}

/// Wait for the child to exit on its own; kill it and fail if it does not.
fn wait_exit(mut child: Child, within: Duration) -> Output {
    let start = Instant::now();
    loop {
        if child.try_wait().expect("try_wait").is_some() {
            return child.wait_with_output().expect("collect output");
        }
        if start.elapsed() > within {
            let _ = child.kill();
            let out = child.wait_with_output().expect("collect output");
            panic!(
                "explorer-api did not exit: a refusal must terminate, not serve.\n{}",
                describe(&out)
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[tokio::test]
async fn boot_refuses_a_stale_schema_and_names_both_versions() {
    let pg = pg().await;
    let db = Db::connect(&pg.url).await.expect("connect");
    db.migrate().await.expect("migrate");

    // Roll back one migration, as a skipped migrate step would leave it.
    let embedded = embedded_schema_version();
    sqlx::query("DROP TABLE IF EXISTS consensus_receipts CASCADE")
        .execute(db.pool())
        .await
        .expect("drop");
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = $1")
        .bind(embedded)
        .execute(db.pool())
        .await
        .expect("un-record");
    let applied = db
        .applied_schema_version()
        .await
        .expect("read")
        .expect("still migrated");
    assert_ne!(applied, embedded, "setup: the database must be behind");

    let child = command(&pg.url, &free_addr())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn explorer-api");
    let out = wait_exit(child, Duration::from_secs(60));
    let report = describe(&out);

    assert!(!out.status.success(), "must refuse, not serve.\n{report}");
    assert!(out.status.code().is_some(), "must exit by code.\n{report}");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        text.contains(&embedded.to_string()) && text.contains(&applied.to_string()),
        "the refusal must name BOTH versions ({embedded} embedded, {applied} applied).\n{report}"
    );
}

#[tokio::test]
async fn boot_accepts_a_matching_schema_and_serves() {
    let pg = pg().await;
    let db = Db::connect(&pg.url).await.expect("connect");
    db.migrate().await.expect("migrate");

    let bind = free_addr();
    let mut child = command(&pg.url, &bind)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn explorer-api");

    let client = reqwest::Client::new();
    let start = Instant::now();
    let mut ok = false;
    while start.elapsed() < Duration::from_secs(60) {
        if let Some(status) = child.try_wait().expect("try_wait") {
            panic!("explorer-api exited against a MATCHING schema: {status:?}");
        }
        if let Ok(r) = client.get(format!("http://{bind}/health")).send().await {
            if r.status().is_success() {
                ok = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let _ = child.kill();
    let _ = child.wait();
    assert!(
        ok,
        "explorer-api never answered /health on a matching schema"
    );
}
