// Integration tests for the explorer HTTP API.
//
// Each test boots a Postgres container with the seeded fixture and asserts
// JSON shape against frozen snapshot fixtures (`tests/fixtures/`). The
// negative test asserts that sign/authorize-style URLs return 404.

mod common;

use common::{http, start_with_seed};

#[tokio::test]
async fn health_returns_indexer_cursor() {
    let s = start_with_seed().await;
    let resp = http()
        .get(format!("http://{}/health", s.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["status"], "ok");
    assert_eq!(body["last_indexed_block"], 1000);
    assert_eq!(body["reorg_count"], 0);
}

#[tokio::test]
async fn list_contracts_returns_freshness_header() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/chains/8453/contracts", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["chain_id"], 8453);
    assert_eq!(
        body["contracts"][0]["address"],
        "0x1111111111111111111111111111111111111111"
    );
    assert_eq!(body["block_number"], 1000);
    assert!(body["indexed_at"].is_string());
}

#[tokio::test]
async fn latest_vault_snapshot_returns_decimal_strings() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/vault/snapshot/latest", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["snapshots"][0]["total_assets"], "12345678");
    assert_eq!(body["snapshots"][0]["total_supply"], "11111111");
    assert_eq!(body["block_number"], 1000);
    assert!(body["indexed_at"].is_string());
}

#[tokio::test]
async fn list_vault_snapshots_filters_by_block_range() {
    let s = start_with_seed().await;
    let resp = http()
        .get(format!(
            "http://{}/v1/vault/snapshots?from_block=999&to_block=1001",
            s.addr
        ))
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["snapshots"].as_array().unwrap().len(), 1);

    // Empty range still has freshness header.
    let resp = http()
        .get(format!(
            "http://{}/v1/vault/snapshots?from_block=2000&to_block=2001",
            s.addr
        ))
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["snapshots"].as_array().unwrap().len(), 0);
    assert!(body["block_number"].is_i64());
    assert!(body["indexed_at"].is_string());
}

#[tokio::test]
async fn list_vault_snapshots_rejects_inverted_range() {
    let s = start_with_seed().await;
    let resp = http()
        .get(format!(
            "http://{}/v1/vault/snapshots?from_block=10&to_block=5",
            s.addr
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn get_agent_returns_latest_policy() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/agents/0x3333333333333333333333333333333333333333",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["policy"]["authorized"], true);
    assert_eq!(body["policy"]["cap"], "5000000");
    assert!(body["block_number"].is_i64());
}

#[tokio::test]
async fn get_agent_unknown_returns_null_policy_with_freshness() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/agents/0x9999999999999999999999999999999999999999",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(body["policy"].is_null());
    assert!(body["block_number"].is_i64());
}

#[tokio::test]
async fn list_agent_deposits_filters_by_address() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/agents/0x3333333333333333333333333333333333333333/deposits",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["deposits"][0]["amount"], "1000000");
    assert_eq!(
        body["deposits"][0]["payment_id"].as_str().unwrap().len(),
        66
    );
}

#[tokio::test]
async fn get_transaction_by_hash() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/transactions/0x2222222222222222222222222222222222222222222222222222222222222222",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["transaction"]["status"], 1);
    assert_eq!(body["block_number"], 1000);
}

#[tokio::test]
async fn get_transaction_unknown_returns_404() {
    let s = start_with_seed().await;
    let resp = http()
        .get(format!(
            "http://{}/v1/transactions/0x{}",
            s.addr,
            "ee".repeat(32)
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn get_deposit_by_payment_id() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/deposits/0x4444444444444444444444444444444444444444444444444444444444444444",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["deposit"]["amount"], "1000000");
    assert_eq!(body["block_number"], 1000);
}

#[tokio::test]
async fn invalid_address_returns_400() {
    let s = start_with_seed().await;
    let resp = http()
        .get(format!("http://{}/v1/agents/notanaddress", s.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

// --- Cross-chain isolation tests (issue #178) ---
//
// The fixture seeds the same agent address, tx_hash, and payment_id on two
// chains (Base 8453 + Ethereum 1) with detectably different values:
//   - agent policy: Base authorized=true / Ethereum revoked (authorized=false)
//   - transaction:  Base status=1       / Ethereum status=0
//   - deposit:      Base amount=1000000 / Ethereum amount=9999999
//
// The API is scoped to PRIMARY_CHAIN_ID (Base). All four tests confirm that
// the shadow chain's rows are never returned.

#[tokio::test]
async fn get_agent_returns_only_configured_chain_policy() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/agents/0x3333333333333333333333333333333333333333",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // Base policy: revoked=false → authorized=true.
    // Shadow Ethereum policy: revoked=true → authorized=false.
    // If chain scoping is absent, the wrong row could be returned.
    assert_eq!(
        body["policy"]["authorized"],
        true,
        "expected Base policy (authorized=true), got {:?}",
        body["policy"]
    );
}

#[tokio::test]
async fn list_agent_deposits_returns_only_configured_chain_deposits() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/agents/0x3333333333333333333333333333333333333333/deposits",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let deposits = body["deposits"].as_array().expect("deposits array");
    // Exactly one deposit for this agent on Base; shadow Ethereum deposit must not appear.
    assert_eq!(deposits.len(), 1, "expected exactly 1 Base deposit, got {deposits:?}");
    assert_eq!(
        body["deposits"][0]["amount"],
        "1000000",
        "expected Base amount=1000000, shadow amount=9999999 must not appear"
    );
}

#[tokio::test]
async fn get_transaction_returns_only_configured_chain_row() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/transactions/0x2222222222222222222222222222222222222222222222222222222222222222",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // Base tx: status=1. Shadow Ethereum tx: status=0.
    assert_eq!(
        body["transaction"]["status"],
        1,
        "expected Base tx status=1, shadow Ethereum status=0 must not appear"
    );
}

#[tokio::test]
async fn get_deposit_returns_only_configured_chain_row() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/deposits/0x4444444444444444444444444444444444444444444444444444444444444444",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // Base deposit: amount=1000000. Shadow Ethereum deposit: amount=9999999.
    assert_eq!(
        body["deposit"]["amount"],
        "1000000",
        "expected Base deposit amount=1000000, shadow Ethereum amount=9999999 must not appear"
    );
}

/// Boundary test (§11): the API exposes no signing or authorization
/// surface. Any sign/authorize-style URL returns 404. This is asserted
/// for both GET and POST to confirm the router has no such route at all.
#[tokio::test]
async fn sign_authorize_endpoints_are_absent() {
    let s = start_with_seed().await;
    let urls = [
        format!("http://{}/v1/sign", s.addr),
        format!("http://{}/v1/authorize", s.addr),
        format!(
            "http://{}/v1/agents/0x3333333333333333333333333333333333333333/authorize",
            s.addr
        ),
        format!(
            "http://{}/v1/agents/0x3333333333333333333333333333333333333333/sign",
            s.addr
        ),
        format!("http://{}/v1/deposits", s.addr),
    ];
    let client = http();
    for url in urls {
        for method in [reqwest::Method::GET, reqwest::Method::POST] {
            let resp = client.request(method.clone(), &url).send().await.unwrap();
            assert_eq!(
                resp.status(),
                404,
                "method {} on {} should be 404, got {}",
                method,
                url,
                resp.status()
            );
        }
    }
}
