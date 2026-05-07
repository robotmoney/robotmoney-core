//! Shared helpers for the explorer-indexer integration tests.
//!
//! - `pg_container()` boots a Postgres testcontainer and returns a
//!   ready-to-use `Db` (with migrations applied). Tests skip cleanly
//!   if Docker isn't available.
//! - `StubRpcServer` is an in-process tokio TCP listener that returns
//!   canned JSON-RPC responses keyed by method name, plus a forced-failure
//!   knob. Used to exercise the failure path without a real chain.

#![allow(dead_code)]

use explorer_indexer::Db;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use testcontainers::runners::AsyncRunner;
use testcontainers::ContainerAsync;
use testcontainers_modules::postgres::Postgres;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct PgFixture {
    pub db: Db,
    // Container handle is held to keep the postgres process alive
    // for the test's lifetime.
    _container: ContainerAsync<Postgres>,
}

/// Returns `Some(fixture)` if Docker is available and Postgres came
/// up; `None` otherwise. Callers should print a skip line and return
/// when this is None — matches the fork-e2e harness convention.
pub async fn try_pg_fixture() -> Option<PgFixture> {
    if which::which("docker").is_err() {
        eprintln!("[explorer-indexer-tests] skipping: docker not on PATH");
        return None;
    }
    let container = match Postgres::default().start().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[explorer-indexer-tests] skipping: postgres container failed to start: {e}");
            return None;
        }
    };
    let host = container.get_host().await.ok()?;
    let port = container.get_host_port_ipv4(5432).await.ok()?;
    let url = format!("postgres://postgres:postgres@{host}:{port}/postgres");
    let db = match Db::connect(&url).await {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[explorer-indexer-tests] skipping: db connect failed: {e}");
            return None;
        }
    };
    if let Err(e) = db.migrate().await {
        eprintln!("[explorer-indexer-tests] skipping: migrate failed: {e}");
        return None;
    }
    Some(PgFixture {
        db,
        _container: container,
    })
}

/// Tiny in-process JSON-RPC server. Methods can be programmed with
/// canned response strings (already-encoded as JSON values), or set
/// to fail with `force_failure(true)` to simulate an RPC outage.
pub struct StubRpcServer {
    pub url: String,
    handlers: Arc<Mutex<HashMap<String, serde_json::Value>>>,
    fail: Arc<AtomicBool>,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

impl StubRpcServer {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        let url = format!("http://{addr}");
        let handlers: Arc<Mutex<HashMap<String, serde_json::Value>>> = Arc::default();
        let fail = Arc::new(AtomicBool::new(false));
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        let h2 = handlers.clone();
        let f2 = fail.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accept = listener.accept() => {
                        let Ok((mut sock, _)) = accept else { break; };
                        let h = h2.clone();
                        let f = f2.clone();
                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 16 * 1024];
                            let n = match sock.read(&mut buf).await { Ok(n) => n, Err(_) => return };
                            if n == 0 { return; }
                            let body_start = buf[..n].windows(4)
                                .position(|w| w == b"\r\n\r\n")
                                .map(|i| i + 4)
                                .unwrap_or(0);
                            let body = &buf[body_start..n];
                            let req: serde_json::Value = match serde_json::from_slice(body) {
                                Ok(v) => v,
                                Err(_) => return,
                            };
                            let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
                            let resp = if f.load(Ordering::SeqCst) {
                                serde_json::json!({
                                    "jsonrpc": "2.0",
                                    "id": req.get("id").cloned().unwrap_or(serde_json::json!(1)),
                                    "error": { "code": -32000, "message": "stub forced failure" }
                                })
                            } else {
                                let result = h.lock().unwrap().get(method).cloned().unwrap_or(serde_json::Value::Null);
                                serde_json::json!({
                                    "jsonrpc": "2.0",
                                    "id": req.get("id").cloned().unwrap_or(serde_json::json!(1)),
                                    "result": result,
                                })
                            };
                            let body = serde_json::to_vec(&resp).unwrap();
                            let header = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            );
                            let _ = sock.write_all(header.as_bytes()).await;
                            let _ = sock.write_all(&body).await;
                            let _ = sock.shutdown().await;
                        });
                    }
                }
            }
        });

        Self {
            url,
            handlers,
            fail,
            shutdown: shutdown_tx,
        }
    }

    pub fn set(&self, method: &str, value: serde_json::Value) {
        self.handlers
            .lock()
            .unwrap()
            .insert(method.to_string(), value);
    }

    pub fn force_failure(&self, on: bool) {
        self.fail.store(on, Ordering::SeqCst);
    }

    pub fn shutdown(self) {
        let _ = self.shutdown.send(());
    }
}
