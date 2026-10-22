//! Canonical: docs/explorer-api.md (account policy endpoint), docs/architecture.md §5.2 (ACL-9)
//! Implements: core issue 1891 (RS-1019-18, IC-1019-9, IC-1019-15) over HTTP, against Postgres.
//!
//! Registration rows are written the way the indexer writes them (migration 0031): every policy and
//! deposit row names its gateway and the position of the event that started its registration.
//!
//! - `earlier_and_later_registrations_stay_queryable_under_their_owners`
//! - `an_expired_registration_is_history_and_not_the_current_policy`
//! - `chains_and_deployments_never_leak_into_each_other`
//! - `the_committee_and_regime_routes_are_retired`
//! - `human_wallet_vault_and_router_reads_are_unchanged` (receipts are covered by consensus_receipt_api)

mod common;

use common::{http, start_with_seed, TestServer};

const GATEWAY: &str = "0x1111111111111111111111111111111111111111";
const AGENT: [u8; 20] = [0x6a; 20];
const OWNER_A: [u8; 20] = [0x6b; 20];
const OWNER_B: [u8; 20] = [0x6c; 20];
const FAR_FUTURE: i64 = 4_000_000_000;

fn hex_of(b: [u8; 20]) -> String {
    format!("0x{}", hex::encode(b))
}

/// One `agent_policies` row of the registration that began at (`reg_block`, `reg_log`).
#[allow(clippy::too_many_arguments)]
async fn policy(
    s: &TestServer,
    chain: i64,
    gateway: [u8; 20],
    block: i64,
    owner: [u8; 20],
    revoked: bool,
    valid_until: Option<i64>,
    reg_block: i64,
) {
    sqlx::query(
        "INSERT INTO agent_policies (chain_id, block_number, log_index, tx_hash, agent, owner, \
         revoked, valid_until, max_per_payment, max_per_window, share_receiver, gateway, \
         event_kind, registration_block, registration_log_index) \
         VALUES ($1, $2, 0, $3, $4, $5, $6, $7, \
                 CASE WHEN $6 THEN NULL ELSE 5000000 END, \
                 CASE WHEN $6 THEN NULL ELSE 50000000 END, $5, $8, \
                 CASE WHEN $6 THEN 'revoked' ELSE 'authorized' END, $9, 0)",
    )
    .bind(chain)
    .bind(block)
    .bind(vec![block as u8; 32])
    .bind(&AGENT[..])
    .bind(&owner[..])
    .bind(revoked)
    .bind(valid_until)
    .bind(&gateway[..])
    .bind(reg_block)
    .execute(&s._pool)
    .await
    .expect("seed a policy row");
}

async fn deposit(s: &TestServer, gateway: [u8; 20], block: i64, payment: u8, reg: Option<i64>) {
    sqlx::query(
        "INSERT INTO agent_deposits (chain_id, block_number, log_index, tx_hash, payment_id, \
         order_id, agent, share_receiver, amount, shares_minted, window_id, gateway, \
         registration_block, registration_log_index) \
         VALUES (8453, $1, 1, $2, $2, $2, $3, $3, 1000000, 1000000, 1, $4, $5, \
                 CASE WHEN $5::BIGINT IS NULL THEN NULL ELSE 0 END)",
    )
    .bind(block)
    .bind(vec![payment; 32])
    .bind(&AGENT[..])
    .bind(&gateway[..])
    .bind(reg)
    .execute(&s._pool)
    .await
    .expect("seed a deposit");
}

async fn get(s: &TestServer, path: &str) -> serde_json::Value {
    let resp = http()
        .get(format!("http://{}{path}", s.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "GET {path}");
    resp.json().await.unwrap()
}

fn gw() -> [u8; 20] {
    [0x11; 20]
}

#[tokio::test]
async fn earlier_and_later_registrations_stay_queryable_under_their_owners() {
    let s = start_with_seed().await;
    // A registers at 950, is revoked at 951, B registers the same agent at 952.
    policy(&s, 8453, gw(), 950, OWNER_A, false, Some(FAR_FUTURE), 950).await;
    policy(&s, 8453, gw(), 951, OWNER_A, true, None, 950).await;
    policy(&s, 8453, gw(), 952, OWNER_B, false, Some(FAR_FUTURE), 952).await;
    deposit(&s, gw(), 950, 0xd1, Some(950)).await;
    deposit(&s, gw(), 952, 0xd2, Some(952)).await;

    let id_a = format!("8453:{GATEWAY}:950:0");
    let id_b = format!("8453:{GATEWAY}:952:0");

    // A's registration is history under A: revoked, with its closing evidence and its own policy.
    let a = get(&s, &format!("/v1/accounts/{}/policies", hex_of(OWNER_A))).await;
    let a = a["policies"].as_array().unwrap();
    assert_eq!(a.len(), 1, "{a:?}");
    assert_eq!(a[0]["registration_id"], id_a);
    assert_eq!(a[0]["owner"], hex_of(OWNER_A));
    assert_eq!(a[0]["status"], "revoked");
    assert_eq!(a[0]["revoked"], true);
    assert_eq!(a[0]["started_block"], 950);
    assert_eq!(a[0]["closed_block"], 951);
    assert_eq!(
        a[0]["closed_tx_hash"],
        format!("0x{}", hex::encode([951u32 as u8; 32]))
    );
    assert_eq!(
        a[0]["max_per_window"], "50000000",
        "a revoked registration keeps its policy"
    );
    assert_eq!(a[0]["gateway"], GATEWAY);

    // B's later registration never overwrote A's, and is live.
    let b = get(&s, &format!("/v1/accounts/{}/policies", hex_of(OWNER_B))).await;
    let b = b["policies"].as_array().unwrap();
    assert_eq!(b.len(), 1);
    assert_eq!(b[0]["registration_id"], id_b);
    assert_eq!(b[0]["status"], "active");
    assert_eq!(b[0]["revoked"], false);

    // The active projection leaves the revoked one out. The history projection is the default.
    let a_active = get(
        &s,
        &format!("/v1/accounts/{}/policies?active=true", hex_of(OWNER_A)),
    )
    .await;
    assert_eq!(a_active["policies"].as_array().unwrap().len(), 0);
    let b_active = get(
        &s,
        &format!("/v1/accounts/{}/policies?active=true", hex_of(OWNER_B)),
    )
    .await;
    assert_eq!(b_active["policies"].as_array().unwrap().len(), 1);

    // The current-agent response is the live registration only.
    let agent = get(&s, &format!("/v1/agents/{}", hex_of(AGENT))).await;
    assert_eq!(agent["policy"]["authorized"], true);
    assert_eq!(agent["policy"]["block_number"], 952);

    // Every registration of the address, oldest first.
    let regs = get(&s, &format!("/v1/agents/{}/registrations", hex_of(AGENT))).await;
    let regs = regs["registrations"].as_array().unwrap();
    assert_eq!(regs.len(), 2);
    assert_eq!(regs[0]["registration_id"], id_a);
    assert_eq!(regs[0]["status"], "revoked");
    assert_eq!(regs[1]["registration_id"], id_b);
    assert_eq!(regs[1]["status"], "active");

    // Deposits and the single-deposit route expose the registration they belong to.
    let deposits = get(&s, &format!("/v1/agents/{}/deposits", hex_of(AGENT))).await;
    let ids: Vec<(i64, String)> = deposits["deposits"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["block_number"] != 1000)
        .map(|d| {
            (
                d["block_number"].as_i64().unwrap(),
                d["registration_id"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(ids, vec![(952, id_b.clone()), (950, id_a.clone())]);
    let one = get(&s, &format!("/v1/deposits/0x{}", hex::encode([0xd1u8; 32]))).await;
    assert_eq!(one["deposit"]["registration_id"], id_a);
}

#[tokio::test]
async fn an_expired_registration_is_history_and_not_the_current_policy() {
    let s = start_with_seed().await;
    // A live registration at 940, and one at 950 whose valid_until 1 is long past. The seeded `blocks`
    // rows are in 2025, so the status reads against the newest indexed block, not the wall clock.
    policy(&s, 8453, gw(), 940, OWNER_A, false, Some(FAR_FUTURE), 940).await;
    policy(&s, 8453, gw(), 950, OWNER_A, false, Some(1), 950).await;
    let regs = get(&s, &format!("/v1/agents/{}/registrations", hex_of(AGENT))).await;
    let regs = regs["registrations"].as_array().unwrap();
    assert_eq!(
        regs.len(),
        2,
        "the live registration and the expired one: {regs:?}"
    );
    let expired = regs
        .iter()
        .find(|r| r["started_block"] == 950)
        .expect("the expired registration");
    assert_eq!(expired["status"], "expired");
    assert_eq!(expired["revoked"], false);

    // The registration at 940 is live. The expired one at 950 is newer and is still not the current policy.
    let agent = get(&s, &format!("/v1/agents/{}", hex_of(AGENT))).await;
    assert_eq!(agent["policy"]["block_number"], 940);
    let active = get(
        &s,
        &format!("/v1/accounts/{}/policies?active=true", hex_of(OWNER_A)),
    )
    .await;
    let live = active["policies"].as_array().unwrap();
    assert_eq!(
        live.len(),
        1,
        "only the registration at 940 is live: {live:?}"
    );
    assert_eq!(live[0]["started_block"], 940);
    let history = get(&s, &format!("/v1/accounts/{}/policies", hex_of(OWNER_A))).await;
    assert_eq!(history["policies"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn chains_and_deployments_never_leak_into_each_other() {
    let s = start_with_seed().await;
    let other_gateway = [0x12u8; 20];
    // Same agent, same owner, same block: another chain, and another deployment on this chain.
    policy(&s, 1, gw(), 960, OWNER_A, false, Some(FAR_FUTURE), 960).await;
    policy(
        &s,
        8453,
        other_gateway,
        961,
        OWNER_A,
        false,
        Some(FAR_FUTURE),
        961,
    )
    .await;
    policy(&s, 8453, gw(), 962, OWNER_A, false, Some(FAR_FUTURE), 962).await;

    let all = get(&s, &format!("/v1/accounts/{}/policies", hex_of(OWNER_A))).await;
    let ids: Vec<&str> = all["policies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["registration_id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![
            format!("8453:{}:961:0", hex_of(other_gateway)),
            format!("8453:{GATEWAY}:962:0"),
        ],
        "the shadow chain's registration (960) must not appear, and ids name their deployment"
    );

    let filtered = get(
        &s,
        &format!(
            "/v1/accounts/{}/policies?gateway={}",
            hex_of(OWNER_A),
            hex_of(other_gateway)
        ),
    )
    .await;
    let filtered = filtered["policies"].as_array().unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0]["gateway"], hex_of(other_gateway));
}

#[tokio::test]
async fn the_committee_and_regime_routes_are_retired() {
    let s = start_with_seed().await;
    for path in [
        "/v1/committee/agents".to_string(),
        format!("/v1/committee/agents/{}/track-record", hex_of(AGENT)),
        "/v1/committee/tilts".to_string(),
        "/v1/regime/feed".to_string(),
    ] {
        let resp = http()
            .get(format!("http://{}{path}", s.addr))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404, "GET {path} must be retired");
    }
}

#[tokio::test]
async fn human_wallet_vault_and_router_reads_are_unchanged() {
    let s = start_with_seed().await;
    let wallet = [0x71u8; 20];
    let vault = [0x22u8; 20];
    for (block, kind) in [(970_i64, "deposit"), (971, "withdrawal")] {
        sqlx::query(
            "INSERT INTO account_history_events (chain_id, block_number, log_index, tx_hash, \
             account, kind, vault, agent, amount) \
             VALUES (8453, $1, 0, $2, $3, $4, $5, NULL, 2500000)",
        )
        .bind(block)
        .bind(vec![block as u8; 32])
        .bind(&wallet[..])
        .bind(kind)
        .bind(&vault[..])
        .execute(&s._pool)
        .await
        .unwrap();
    }
    let history = get(&s, &format!("/v1/accounts/{}/history", hex_of(wallet))).await;
    let kinds: Vec<&str> = history["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        vec!["deposit", "withdrawal"],
        "a human wallet's own actions stay visible"
    );
    assert_eq!(history["events"][1]["amount"], "2500000");

    let vaults = get(&s, "/v1/vaults").await;
    assert!(vaults["vaults"].is_array());
    let router = get(&s, "/v1/router/weights").await;
    assert!(router["history"].as_array().is_some_and(|h| !h.is_empty()));
}
