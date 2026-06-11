//! Shared helpers for watchdog integration tests.
//!
//! - `try_pg_fixture()` — boots Postgres testcontainer + applies explorer-indexer
//!   migrations (same canonical schema the watchdog queries). Skips if Docker is absent.
//! - `MockWebhookServer` — in-process HTTP server for alert payload capture.

#![allow(dead_code)]

use explorer_indexer::db::MIGRATOR;
use sqlx::postgres::{PgPool, PgPoolOptions};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use testcontainers::runners::AsyncRunner;
use testcontainers::ContainerAsync;
use testcontainers_modules::postgres::Postgres;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Fixture wrapping a live Postgres container.
pub struct PgFixture {
    pub pool: PgPool,
    _container: ContainerAsync<Postgres>,
}

/// Boot a fresh Postgres container, apply the explorer-indexer canonical migrations,
/// and return the pool.  Returns `None` if Docker is unavailable.
pub async fn try_pg_fixture() -> Option<PgFixture> {
    if which::which("docker").is_err() {
        eprintln!("[watchdog-tests] skipping: docker not on PATH");
        return None;
    }
    let container = match Postgres::default().start().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[watchdog-tests] skipping: postgres container start failed: {e}");
            return None;
        }
    };
    let host = container.get_host().await.ok()?;
    let port = container.get_host_port_ipv4(5432).await.ok()?;
    let url = format!("postgres://postgres:postgres@{host}:{port}/postgres");

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&url)
        .await
        .ok()?;

    // Apply the canonical explorer-indexer migrations so the watchdog's SQL
    // queries have the expected tables.
    if let Err(e) = MIGRATOR.run(&pool).await {
        panic!("[watchdog-tests] migrate failed: {e}");
    }

    Some(PgFixture {
        pool,
        _container: container,
    })
}

/// Captured webhook request.
#[derive(Debug, Clone)]
pub struct WebhookCapture {
    /// Raw JSON body bytes.
    pub body: Vec<u8>,
}

/// Minimal in-process HTTP server that captures POST /v2/enqueue bodies.
///
/// Responds HTTP 202 to every request so the alert dispatcher sees success.
pub struct MockWebhookServer {
    /// Full URL (e.g. `http://127.0.0.1:12345`).
    pub url: String,
    captures: Arc<Mutex<Vec<WebhookCapture>>>,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

impl MockWebhookServer {
    /// Start the mock server on a random port.
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}");
        let captures: Arc<Mutex<Vec<WebhookCapture>>> = Arc::default();
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        let caps2 = captures.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accept = listener.accept() => {
                        let Ok((mut sock, _)) = accept else { break };
                        let caps = caps2.clone();
                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 32 * 1024];
                            let n = match sock.read(&mut buf).await { Ok(n) => n, Err(_) => return };
                            if n == 0 { return; }
                            // Split on \r\n\r\n to isolate the JSON body.
                            let body_start = buf[..n].windows(4)
                                .position(|w| w == b"\r\n\r\n")
                                .map(|i| i + 4)
                                .unwrap_or(0);
                            let body = buf[body_start..n].to_vec();
                            caps.lock().unwrap().push(WebhookCapture { body });
                            // 202 Accepted
                            let resp = b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                            let _ = sock.write_all(resp).await;
                            let _ = sock.shutdown().await;
                        });
                    }
                }
            }
        });

        Self {
            url,
            captures,
            shutdown: shutdown_tx,
        }
    }

    /// Drain all captured requests so far.
    pub fn drain_captures(&self) -> Vec<WebhookCapture> {
        self.captures.lock().unwrap().drain(..).collect()
    }

    /// Shut down the server.
    pub fn shutdown(self) {
        let _ = self.shutdown.send(());
    }
}
