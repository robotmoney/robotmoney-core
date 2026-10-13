//! Issue 1725: the JSON-RPC client retries throttles with backoff and can send eth_getLogs to a
//! separate endpoint. A scripted loopback HTTP server stands in for a public Base RPC, so no
//! network, no Postgres and no Docker are needed and the test always executes.

use explorer_indexer::rpc::{JsonRpc, RetryPolicy};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

/// Serves the scripted replies one per connection. Each entry is (status line, extra header, body).
/// Records the request body of each hit. Stops after the script is used up.
fn scripted(
    script: Vec<(&'static str, &'static str, &'static str)>,
) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_t = Arc::clone(&seen);
    thread::spawn(move || {
        for (status, header, body) in script {
            let (mut sock, _) = listener.accept().expect("accept");
            let mut buf = vec![0u8; 8192];
            let mut got = Vec::new();
            loop {
                let n = sock.read(&mut buf).unwrap_or(0);
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got).to_string();
                if let Some(idx) = text.find("\r\n\r\n") {
                    let len = text[..idx]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if got.len() >= idx + 4 + len || n == 0 {
                        break;
                    }
                } else if n == 0 {
                    break;
                }
            }
            seen_t
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(&got).to_string());
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{header}Connection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes());
        }
    });
    (url, seen)
}

const OK_BLOCK: &str = r#"{"jsonrpc":"2.0","id":1,"result":"0x64"}"#;

#[tokio::test]
async fn retries_429_then_succeeds_with_backoff() {
    let (url, seen) = scripted(vec![
        ("429 Too Many Requests", "", "{}"),
        ("429 Too Many Requests", "", "{}"),
        ("200 OK", "", OK_BLOCK),
    ]);
    let rpc = JsonRpc::new(url).with_retry(RetryPolicy::new(3, 1));
    assert_eq!(
        rpc.block_number().await.expect("recovers after two 429s"),
        100
    );
    assert_eq!(
        seen.lock().unwrap().len(),
        3,
        "two throttled attempts and one good one"
    );
}

#[tokio::test]
async fn gives_up_after_the_configured_retries() {
    let (url, seen) = scripted(vec![
        ("429 Too Many Requests", "", "{}"),
        ("429 Too Many Requests", "", "{}"),
        ("200 OK", "", OK_BLOCK),
    ]);
    let rpc = JsonRpc::new(url).with_retry(RetryPolicy::new(1, 1));
    let err = rpc
        .block_number()
        .await
        .expect_err("one retry is not enough for two 429s");
    assert!(err.to_string().contains("429"), "{err}");
    assert_eq!(
        seen.lock().unwrap().len(),
        2,
        "first attempt plus one retry"
    );
}

#[tokio::test]
async fn default_policy_makes_one_attempt() {
    let (url, seen) = scripted(vec![
        ("429 Too Many Requests", "", "{}"),
        ("200 OK", "", OK_BLOCK),
    ]);
    let rpc = JsonRpc::new(url);
    assert!(rpc.block_number().await.is_err());
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_404_or_a_json_rpc_error_is_never_retried() {
    let (url, seen) = scripted(vec![("404 Not Found", "", "{}"), ("200 OK", "", OK_BLOCK)]);
    let rpc = JsonRpc::new(url).with_retry(RetryPolicy::new(3, 1));
    assert!(rpc.block_number().await.is_err());
    assert_eq!(seen.lock().unwrap().len(), 1, "404 is a real answer");

    let (url, seen) = scripted(vec![
        (
            "200 OK",
            "",
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"limit exceeded"}}"#,
        ),
        ("200 OK", "", OK_BLOCK),
    ]);
    let rpc = JsonRpc::new(url).with_retry(RetryPolicy::new(3, 1));
    assert!(rpc.block_number().await.is_err());
    assert_eq!(
        seen.lock().unwrap().len(),
        1,
        "an error object is a real answer"
    );
}

#[tokio::test]
async fn get_logs_goes_to_the_logs_endpoint_and_other_calls_do_not() {
    let (main_url, main_seen) = scripted(vec![("200 OK", "", OK_BLOCK)]);
    let (logs_url, logs_seen) = scripted(vec![(
        "200 OK",
        "",
        r#"{"jsonrpc":"2.0","id":1,"result":[]}"#,
    )]);
    let rpc = JsonRpc::new(main_url).with_logs_url(Some(logs_url));
    assert_eq!(rpc.block_number().await.unwrap(), 100);
    let logs = rpc
        .get_logs(52_401_633, 52_402_632, &[], &[])
        .await
        .unwrap();
    assert!(logs.is_empty());
    let main = main_seen.lock().unwrap();
    let logs_req = logs_seen.lock().unwrap();
    assert_eq!(main.len(), 1);
    assert!(main[0].contains("eth_blockNumber") && !main[0].contains("eth_getLogs"));
    assert_eq!(logs_req.len(), 1);
    assert!(logs_req[0].contains("eth_getLogs"), "{}", logs_req[0]);
    assert!(
        logs_req[0].contains("0x31f95e1"),
        "fromBlock is the configured start: {}",
        logs_req[0]
    );
}
