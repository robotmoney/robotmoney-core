//! Issue 1731: an RPC endpoint that answers HTTP 403 (or 401) is a final answer. The client names the
//! endpoint, the method and the block range, tells the operator to use an archive-capable logs RPC, and
//! never retries. A scripted loopback server stands in for a public Base RPC ("Archive requests require a
//! personal token"), so no network, no Postgres and no Docker are needed and the test always executes.

use explorer_indexer::indexer::refusal_backoff;
use explorer_indexer::rpc::{JsonRpc, RetryPolicy, RpcError};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;

/// Answers every request with `status` and counts the hits.
fn always(status: &'static str) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let url = format!(
        "http://{}/v2/SECRET-API-KEY",
        listener.local_addr().unwrap()
    );
    let hits = Arc::new(AtomicUsize::new(0));
    let hits_t = Arc::clone(&hits);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut sock) = stream else { break };
            let mut buf = vec![0u8; 8192];
            let _ = sock.read(&mut buf);
            hits_t.fetch_add(1, Ordering::SeqCst);
            let body = "Archive requests require a personal token";
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes());
        }
    });
    (url, hits)
}

#[tokio::test]
async fn a_403_on_get_logs_is_named_actionable_and_not_retried() {
    let (url, hits) = always("403 Forbidden");
    // Retries are configured on purpose: a refusal must not use them.
    let rpc = JsonRpc::new(url).with_retry(RetryPolicy::new(5, 1));
    let err = rpc
        .get_logs(100, 1099, &[], &[])
        .await
        .expect_err("a 403 is an error");
    assert!(
        matches!(err, RpcError::Refused { status: 403, .. }),
        "{err:?}"
    );
    let msg = err.to_string();
    assert!(msg.contains("eth_getLogs"), "names the method: {msg}");
    assert!(
        msg.contains("http://127.0.0.1"),
        "names the endpoint origin: {msg}"
    );
    assert!(msg.contains("HTTP 403"), "{msg}");
    assert!(
        msg.contains("blocks 100..1099"),
        "names the block range: {msg}"
    );
    assert!(
        msg.contains("INDEXER_LOGS_RPC_URL"),
        "names the setting: {msg}"
    );
    assert!(
        msg.contains("https://base.gateway.tenderly.co"),
        "names an archive RPC: {msg}"
    );
    assert!(
        !msg.contains("SECRET-API-KEY"),
        "the key never reaches the message: {msg}"
    );
    assert!(!msg.contains("/v2/"), "no URL path in the message: {msg}");
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "exactly one request, no retry"
    );
}

#[tokio::test]
async fn a_401_on_another_method_points_at_the_main_rpc_not_the_logs_rpc() {
    let (url, hits) = always("401 Unauthorized");
    let rpc = JsonRpc::new(url).with_retry(RetryPolicy::new(5, 1));
    let err = rpc.block_number().await.expect_err("a 401 is an error");
    let msg = err.to_string();
    assert!(
        matches!(err, RpcError::Refused { status: 401, .. }),
        "{msg}"
    );
    assert!(
        msg.contains("eth_blockNumber") && msg.contains("INDEXER_RPC_URL"),
        "{msg}"
    );
    assert!(
        !msg.contains("tenderly"),
        "no logs advice for another method: {msg}"
    );
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn the_logs_endpoint_is_the_one_named_when_it_refuses() {
    let (logs_url, logs_hits) = always("403 Forbidden");
    let (main_url, main_hits) = always("200 OK");
    let rpc = JsonRpc::new(main_url).with_logs_url(Some(logs_url));
    let err = rpc.get_logs(1, 2, &[], &[]).await.expect_err("refused");
    assert!(err.to_string().contains("refused by http://127.0.0.1"));
    assert_eq!(logs_hits.load(Ordering::SeqCst), 1);
    assert_eq!(
        main_hits.load(Ordering::SeqCst),
        0,
        "the main endpoint was not asked for logs"
    );
}

#[test]
fn the_wait_between_refused_ticks_grows_and_is_capped() {
    let waits: Vec<u64> = (1..=8).map(|n| refusal_backoff(n, 12).as_secs()).collect();
    assert_eq!(waits, vec![12, 24, 48, 96, 192, 300, 300, 300]);
}
