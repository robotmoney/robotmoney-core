//! The standing weight-setter-path check, driven through real `eth_call`s over
//! HTTP (issue 1698).
//!
//! Router weights change only through `RouterGovernance.applyReceipt` on a
//! Safe-scheduled timelock operation. The stage 12 verifier checks, once, that
//! the router's `WEIGHT_SETTER_ROLE` is held only by the weight setter and that
//! the weight setter's `ADMIN_ROLE` is held only by the timelock. Only a
//! standing monitor catches a grant executed after that. This replaced the
//! `quorumThreshold()` floor check, whose view issue 1698 deleted.
//!
//! No Docker and no chain: a tiny in-process JSON-RPC server answers each
//! `eth_call` by the calldata and target it carries.

use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use watchdog::governance::{
    check_weight_setter_path, WeightSetterMonitorConfig, WeightSetterStatus, ADMIN_ROLE,
    GET_ROLE_MEMBER_COUNT_SELECTOR, GET_ROLE_MEMBER_SELECTOR, WEIGHT_SETTER_ROLE,
};

const ROUTER: &str = "0xefefefefefefefefefefefefefefefefefefefef";
const SETTER: &str = "0xabababababababababababababababababababab";
const TIMELOCK: &str = "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
const STRANGER: &str = "0x1111111111111111111111111111111111111111";

/// One canned answer: the first rule whose `to` and `data` both appear in a
/// request body answers it with `result` (a JSON fragment such as
/// `"result":"0x…"` or `"error":{…}`).
#[derive(Clone)]
struct Rule {
    to: String,
    data: String,
    result: String,
}

/// A JSON-RPC endpoint that answers `eth_call` by rule, recording the request
/// bodies it saw. A request no rule matches gets an RPC error, so a read this
/// test did not plan for can never pass as a healthy answer.
struct StubRpc {
    url: String,
    bodies: Arc<Mutex<Vec<String>>>,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

impl StubRpc {
    async fn start(rules: Vec<Rule>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let bodies: Arc<Mutex<Vec<String>>> = Arc::default();
        let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
        let seen = bodies.clone();
        let rules = Arc::new(rules);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut rx => break,
                    accept = listener.accept() => {
                        let Ok((mut sock, _)) = accept else { break };
                        let seen = seen.clone();
                        let rules = rules.clone();
                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 16 * 1024];
                            let n = match sock.read(&mut buf).await { Ok(n) => n, Err(_) => return };
                            if n == 0 { return; }
                            let req = String::from_utf8_lossy(&buf[..n]).to_lowercase();
                            seen.lock().unwrap().push(req.clone());
                            let result = rules
                                .iter()
                                .find(|r| req.contains(&r.to) && req.contains(&r.data))
                                .map(|r| r.result.clone())
                                .unwrap_or_else(|| r#""error":{"code":-32601,"message":"no stub rule"}"#.to_owned());
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

fn cfg(url: &str) -> WeightSetterMonitorConfig {
    WeightSetterMonitorConfig {
        enabled: true,
        rpc_url: Some(url.to_owned()),
        router_address: Some(ROUTER.to_owned()),
        weight_setter_address: Some(SETTER.to_owned()),
        timelock_address: Some(TIMELOCK.to_owned()),
        repage_secs: 300,
        min_quorum_threshold: None,
    }
}

fn uint(v: u64) -> String {
    format!(r#""result":"0x{v:064x}""#)
}

fn address(a: &str) -> String {
    format!(
        r#""result":"0x{}{}""#,
        "0".repeat(24),
        a.trim_start_matches("0x")
    )
}

/// Rules that answer `getRoleMemberCount(role)` and `getRoleMember(role, i)`
/// on `contract` with `members`.
fn role_rules(contract: &str, role: &str, members: &[&str]) -> Vec<Rule> {
    let mut rules = vec![Rule {
        to: contract.to_owned(),
        data: format!("{GET_ROLE_MEMBER_COUNT_SELECTOR}{role}"),
        result: uint(members.len() as u64),
    }];
    for (i, m) in members.iter().enumerate() {
        rules.push(Rule {
            to: contract.to_owned(),
            data: format!("{GET_ROLE_MEMBER_SELECTOR}{role}{i:064x}"),
            result: address(m),
        });
    }
    rules
}

fn path_rules(setters: &[&str], admins: &[&str]) -> Vec<Rule> {
    let mut rules = role_rules(ROUTER, WEIGHT_SETTER_ROLE, setters);
    rules.extend(role_rules(SETTER, ADMIN_ROLE, admins));
    rules
}

#[tokio::test]
async fn the_deployed_path_reads_as_ok() {
    let rpc = StubRpc::start(path_rules(&[SETTER], &[TIMELOCK])).await;
    let client = reqwest::Client::new();
    assert_eq!(
        check_weight_setter_path(&client, &cfg(&rpc.url), 918_453)
            .await
            .expect("read"),
        WeightSetterStatus::Ok
    );

    // The calls really were the views this claims to read, at the configured
    // addresses: an ABI drift must not be able to hide behind a green test.
    let req = rpc.requests().join("");
    assert!(req.contains("eth_call"), "method: {req}");
    assert!(
        req.contains(&format!(
            "{GET_ROLE_MEMBER_COUNT_SELECTOR}{WEIGHT_SETTER_ROLE}"
        )),
        "router role read: {req}"
    );
    assert!(
        req.contains(&format!("{GET_ROLE_MEMBER_SELECTOR}{ADMIN_ROLE}")),
        "weight-setter admin read: {req}"
    );
    assert!(req.contains(ROUTER), "router address: {req}");
    assert!(req.contains(SETTER), "weight-setter address: {req}");
    let _ = rpc.shutdown.send(());
}

#[tokio::test]
async fn a_second_weight_setter_role_holder_is_read_and_classified_as_a_drift() {
    let rpc = StubRpc::start(path_rules(&[SETTER, STRANGER], &[TIMELOCK])).await;
    let client = reqwest::Client::new();
    match check_weight_setter_path(&client, &cfg(&rpc.url), 918_453).await {
        Ok(WeightSetterStatus::Drifted(b)) => {
            assert_eq!(b.chain_id, 918_453);
            assert_eq!(b.router_address, ROUTER);
            assert_eq!(b.weight_setter_role.count, 2);
            assert_eq!(
                b.weight_setter_role.members,
                vec![SETTER.to_owned(), STRANGER.to_owned()]
            );
            assert!(b.weight_setter_admins.is_exactly(TIMELOCK));
        }
        other => panic!("a second WEIGHT_SETTER_ROLE holder must be a drift, got {other:?}"),
    }
    let _ = rpc.shutdown.send(());
}

#[tokio::test]
async fn a_weight_setter_admin_other_than_the_timelock_is_a_drift() {
    let rpc = StubRpc::start(path_rules(&[SETTER], &[STRANGER])).await;
    let client = reqwest::Client::new();
    match check_weight_setter_path(&client, &cfg(&rpc.url), 918_453).await {
        Ok(WeightSetterStatus::Drifted(b)) => {
            assert_eq!(b.weight_setter_admins.members, vec![STRANGER.to_owned()]);
            assert_eq!(b.timelock_address, TIMELOCK);
        }
        other => {
            panic!("an ADMIN_ROLE holder that is not the timelock must be a drift, got {other:?}")
        }
    }
    let _ = rpc.shutdown.send(());
}

#[tokio::test]
async fn a_wrong_router_address_is_a_read_failure_not_a_healthy_read() {
    // `eth_call` against an address with no code returns "0x". Reading that as
    // zero holders would page for the wrong reason; reading it as fine would
    // leave the check blind. It must surface as an error the daemon logs.
    let rules = vec![Rule {
        to: ROUTER.to_owned(),
        data: GET_ROLE_MEMBER_COUNT_SELECTOR.to_owned(),
        result: r#""result":"0x""#.to_owned(),
    }];
    let rpc = StubRpc::start(rules).await;
    let client = reqwest::Client::new();
    let err = check_weight_setter_path(&client, &cfg(&rpc.url), 918_453)
        .await
        .expect_err("empty call data must not classify as a role set");
    assert!(format!("{err}").contains("empty data"), "got: {err}");
    let _ = rpc.shutdown.send(());
}

#[tokio::test]
async fn an_rpc_error_is_surfaced_rather_than_swallowed() {
    let rules = vec![Rule {
        to: ROUTER.to_owned(),
        data: GET_ROLE_MEMBER_COUNT_SELECTOR.to_owned(),
        result: r#""error":{"code":-32000,"message":"execution reverted"}"#.to_owned(),
    }];
    let rpc = StubRpc::start(rules).await;
    let client = reqwest::Client::new();
    let err = check_weight_setter_path(&client, &cfg(&rpc.url), 918_453)
        .await
        .expect_err("an RPC error must not read as a healthy path");
    assert!(
        format!("{err}").contains("execution reverted"),
        "got: {err}"
    );
    let _ = rpc.shutdown.send(());
}
