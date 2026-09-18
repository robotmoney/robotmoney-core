//! The standing quorum-floor check, driven through a real `eth_call` over HTTP.
//!
//! Task T22 (watchdog half) / decision D16: the contract's
//! `MIN_QUORUM_THRESHOLD` stops a *new* deployment from being wired below the
//! floor, but only a standing monitor catches an `ADMIN_ROLE` holder calling
//! `setQuorumThreshold` on a router that is already live — the one way
//! `AC-GOV-03`'s evidence can be undone after it was collected.
//!
//! No Docker and no chain: a tiny in-process JSON-RPC server returns the word
//! the check has to interpret.

use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use watchdog::governance::{
    check_quorum_floor, QuorumMonitorConfig, QuorumStatus, QUORUM_THRESHOLD_SELECTOR,
};

const ROUTER: &str = "0xabababababababababababababababababababab";

/// A JSON-RPC endpoint that answers `eth_call` with one canned result string,
/// recording the request bodies it saw.
struct StubRpc {
    url: String,
    bodies: Arc<Mutex<Vec<String>>>,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

impl StubRpc {
    async fn start(result: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let bodies: Arc<Mutex<Vec<String>>> = Arc::default();
        let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
        let seen = bodies.clone();
        let result = result.to_owned();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut rx => break,
                    accept = listener.accept() => {
                        let Ok((mut sock, _)) = accept else { break };
                        let seen = seen.clone();
                        let result = result.clone();
                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 16 * 1024];
                            let n = match sock.read(&mut buf).await { Ok(n) => n, Err(_) => return };
                            if n == 0 { return; }
                            seen.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).into_owned());
                            let payload = format!(r#"{{"jsonrpc":"2.0","id":1,{result}}}"#);
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                payload.len(), payload
                            );
                            let _ = sock.write_all(resp.as_bytes()).await;
                            let _ = sock.shutdown().await;
                        });
                    }
                }
            }
        });
        Self {
            url,
            bodies,
            shutdown: tx,
        }
    }

    fn requests(&self) -> Vec<String> {
        self.bodies.lock().unwrap().clone()
    }
}

fn cfg(url: &str) -> QuorumMonitorConfig {
    QuorumMonitorConfig {
        enabled: true,
        rpc_url: Some(url.to_owned()),
        router_address: Some(ROUTER.to_owned()),
        min_quorum_threshold: 2,
        repage_secs: 300,
    }
}

fn word(v: u64) -> String {
    format!(r#""result":"0x{v:064x}""#)
}

#[tokio::test]
async fn a_router_lowered_to_quorum_one_is_read_and_classified_as_a_fault() {
    let rpc = StubRpc::start(&word(1)).await;
    let client = reqwest::Client::new();

    match check_quorum_floor(&client, &cfg(&rpc.url), 918_453).await {
        Ok(QuorumStatus::BelowFloor(b)) => {
            assert_eq!(b.threshold, 1);
            assert_eq!(b.min_threshold, 2);
            assert_eq!(b.chain_id, 918_453);
            assert_eq!(b.router_address, ROUTER);
        }
        other => panic!("quorumThreshold()==1 must be a fault, got {other:?}"),
    }

    // The call really was the view this claims to read, at the configured
    // address — an ABI drift must not be able to hide behind a green test.
    let req = rpc.requests().join("");
    assert!(req.contains("eth_call"), "method: {req}");
    assert!(req.contains(QUORUM_THRESHOLD_SELECTOR), "selector: {req}");
    assert!(req.contains(ROUTER), "to-address: {req}");
    let _ = rpc.shutdown.send(());
}

#[tokio::test]
async fn the_accepted_two_of_two_arrangement_reads_as_ok() {
    let rpc = StubRpc::start(&word(2)).await;
    let client = reqwest::Client::new();
    assert_eq!(
        check_quorum_floor(&client, &cfg(&rpc.url), 918_453)
            .await
            .expect("read"),
        QuorumStatus::Ok { threshold: 2 }
    );
    let _ = rpc.shutdown.send(());
}

#[tokio::test]
async fn a_wrong_router_address_is_a_read_failure_not_a_healthy_read() {
    // `eth_call` against an address with no code returns "0x". Reading that as
    // 0 would page for the wrong reason; reading it as fine would leave the
    // check blind. It must surface as an error the daemon logs every cycle.
    let rpc = StubRpc::start(r#""result":"0x""#).await;
    let client = reqwest::Client::new();
    let err = check_quorum_floor(&client, &cfg(&rpc.url), 918_453)
        .await
        .expect_err("empty call data must not classify as a threshold");
    assert!(format!("{err}").contains("empty data"), "got: {err}");
    let _ = rpc.shutdown.send(());
}

#[tokio::test]
async fn an_rpc_error_is_surfaced_rather_than_swallowed() {
    let rpc = StubRpc::start(r#""error":{"code":-32000,"message":"execution reverted"}"#).await;
    let client = reqwest::Client::new();
    let err = check_quorum_floor(&client, &cfg(&rpc.url), 918_453)
        .await
        .expect_err("an RPC error must not read as a quorum");
    assert!(
        format!("{err}").contains("execution reverted"),
        "got: {err}"
    );
    let _ = rpc.shutdown.send(());
}
