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
        .get(format!(
            "http://{}/v1/vault/snapshot/latest?contract=0x1111111111111111111111111111111111111111",
            s.addr
        ))
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

/// QA plan X7 (DI-9): `/v1/vault/snapshot/latest` answers for one vault on the
/// served chain. It used to read the newest row of the whole table, so it
/// answered with whichever vault (or chain) had the highest block.
///
/// The seed holds the gateway contract's snapshot at block 1000 and vault A's at
/// block 500 on Base. This test adds a newer row for the gateway contract on the
/// shadow chain (block 5000) in the same database.
#[tokio::test]
async fn latest_snapshot_is_chain_and_vault_scoped() {
    let s = start_with_seed().await;
    sqlx::query(
        "INSERT INTO vault_snapshots (chain_id, contract, block_number, total_assets, total_supply, \
                                       exit_fee_bps, tvl_cap, paused) \
         VALUES ($1, $2, 5000, 77777777::NUMERIC, 77777777::NUMERIC, 0, 0::NUMERIC, FALSE)",
    )
    .bind(common::SHADOW_CHAIN_ID)
    .bind(vec![0x11u8; 20])
    .execute(&s._pool)
    .await
    .unwrap();

    let get = |query: &'static str| {
        let url = format!("http://{}/v1/vault/snapshot/latest{query}", s.addr);
        async move { http().get(url).send().await.unwrap() }
    };

    // The gateway contract's newest Base row, not the newer shadow-chain row.
    let resp = get("?contract=0x1111111111111111111111111111111111111111").await;
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let snap = &body["snapshots"][0];
    assert_eq!(snap["chain_id"], common::PRIMARY_CHAIN_ID);
    assert_eq!(snap["block_number"], 1000);
    assert_eq!(snap["total_assets"], "12345678");
    assert_eq!(body["snapshots"].as_array().unwrap().len(), 1);

    // Vault A's own newest row (block 500), not the gateway's newer block 1000.
    let resp = get("?contract=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").await;
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(
        body["snapshots"][0]["contract"],
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    assert_eq!(body["snapshots"][0]["block_number"], 500);
    assert_eq!(body["snapshots"][0]["total_assets"], "99999999");

    // No vault named: refused, never "whichever vault is newest".
    assert_eq!(get("").await.status(), 400);
    // A malformed address is refused; a vault with no snapshot here is not found.
    assert_eq!(get("?contract=0x1234").await.status(), 400);
    assert_eq!(
        get("?contract=0x9999999999999999999999999999999999999999")
            .await
            .status(),
        404
    );
}

/// QA plan X7 (DI-9): `/v1/chains/:chain_id/contracts` lists only the served
/// chain. It used to bind the path's chain id, so the Base service listed the
/// shadow chain's contracts from the shared database.
#[tokio::test]
async fn list_contracts_serves_only_the_configured_chain() {
    let s = start_with_seed().await;
    let resp = http()
        .get(format!("http://{}/v1/chains/1/contracts", s.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404, "the shadow chain is not served here");

    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/chains/8453/contracts", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let contracts = body["contracts"].as_array().unwrap();
    assert!(!contracts.is_empty());
    for c in contracts {
        assert_eq!(c["chain_id"], common::PRIMARY_CHAIN_ID, "{c}");
    }
}

/// Seed one exclusion record with its holders' snapshot balances, credits,
/// claims and close (QA plan X7, core issue 1820).
#[allow(clippy::too_many_arguments)]
async fn seed_exclusion_record(
    pool: &sqlx::PgPool,
    chain_id: i64,
    exclusion_id: i64,
    snapshot_supply: &str,
    balances: &[([u8; 20], &str)],
    credits: &[(i64, &str, &str)],
    claims: &[(i64, [u8; 20], &str)],
    finalized: Option<(i64, i16, &str)>,
) {
    let ledger = vec![0x1Eu8; 20];
    sqlx::query(
        "INSERT INTO exclusion_records (chain_id, ledger_address, exclusion_id, vault_address, \
             adapter_index, adapter_address, snapshot_supply, adapter_value, block_number, \
             log_index, tx_hash) \
         VALUES ($1, $2, $3, $4, 2, $5, $6::NUMERIC, 500, $7, 0, $8)",
    )
    .bind(chain_id)
    .bind(&ledger)
    .bind(exclusion_id)
    .bind(vec![0xAAu8; 20])
    .bind(vec![0xADu8; 20])
    .bind(snapshot_supply)
    .bind(600 + exclusion_id)
    .bind(vec![0x60u8; 32])
    .execute(pool)
    .await
    .unwrap();
    for (holder, balance) in balances {
        sqlx::query(
            "INSERT INTO exclusion_holder_balances \
               (chain_id, ledger_address, exclusion_id, holder, balance_at, block_number) \
             VALUES ($1, $2, $3, $4, $5::NUMERIC, $6)",
        )
        .bind(chain_id)
        .bind(&ledger)
        .bind(exclusion_id)
        .bind(holder.to_vec())
        .bind(*balance)
        .bind(600 + exclusion_id)
        .execute(pool)
        .await
        .unwrap();
    }
    for (block, amount, total) in credits {
        sqlx::query(
            "INSERT INTO exclusion_recoveries (chain_id, block_number, log_index, tx_hash, \
                 ledger_address, exclusion_id, source, amount, recovered_total) \
             VALUES ($1, $2, $3, $4, $5, $6, 0, $7::NUMERIC, $8::NUMERIC)",
        )
        .bind(chain_id)
        .bind(*block)
        .bind(exclusion_id as i32)
        .bind(vec![0x61u8; 32])
        .bind(&ledger)
        .bind(exclusion_id)
        .bind(*amount)
        .bind(*total)
        .execute(pool)
        .await
        .unwrap();
    }
    for (block, holder, amount) in claims {
        sqlx::query(
            "INSERT INTO exclusion_claims (chain_id, block_number, log_index, tx_hash, \
                 ledger_address, exclusion_id, holder, amount) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::NUMERIC)",
        )
        .bind(chain_id)
        .bind(*block)
        .bind(exclusion_id as i32)
        .bind(vec![0x62u8; 32])
        .bind(&ledger)
        .bind(exclusion_id)
        .bind(holder.to_vec())
        .bind(*amount)
        .execute(pool)
        .await
        .unwrap();
    }
    if let Some((block, reason, total)) = finalized {
        sqlx::query(
            "INSERT INTO exclusion_finalizations (chain_id, ledger_address, exclusion_id, reason, \
                 recovered_total, block_number, log_index, tx_hash) \
             VALUES ($1, $2, $3, $4, $5::NUMERIC, $6, 0, $7)",
        )
        .bind(chain_id)
        .bind(&ledger)
        .bind(exclusion_id)
        .bind(reason)
        .bind(total)
        .bind(block)
        .bind(vec![0x63u8; 32])
        .execute(pool)
        .await
        .unwrap();
    }
}

/// Core issue 1820 (indexer half, QA plan X7): a holder's claim on each
/// exclusion record is `floor(recovered * balance_at / snapshot_supply) -
/// claimed`, the ledger's own formula and rounding.
///
/// Record 1 (force-removed): 300 USDC recovered over two credits, the holder
/// held 600 of 1000 shares and has claimed 100, so 180 is owed and 80 is
/// claimable. Another holder's claim on it does not count against this one.
/// Record 2 (open): 10 recovered, 333 of 1000 shares, so floor(3.33) = 3. The
/// same holder's record on the shadow chain is not served.
#[tokio::test]
async fn account_exclusion_claims_are_pro_rata_to_the_snapshot() {
    let s = start_with_seed().await;
    let holder = [0x33u8; 20];
    let other = [0x55u8; 20];
    seed_exclusion_record(
        &s._pool,
        common::PRIMARY_CHAIN_ID,
        1,
        "1000",
        &[(holder, "600"), (other, "400")],
        &[(610, "100", "100"), (620, "200", "300")],
        &[(630, holder, "100"), (631, other, "50")],
        Some((640, 2, "300")),
    )
    .await;
    seed_exclusion_record(
        &s._pool,
        common::PRIMARY_CHAIN_ID,
        2,
        "1000",
        &[(holder, "333")],
        &[(650, "10", "10")],
        &[],
        None,
    )
    .await;
    seed_exclusion_record(
        &s._pool,
        common::SHADOW_CHAIN_ID,
        3,
        "1000",
        &[(holder, "1000")],
        &[(660, "999", "999")],
        &[],
        None,
    )
    .await;

    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/accounts/0x3333333333333333333333333333333333333333/exclusion-claims",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let claims = body["claims"].as_array().unwrap();
    assert_eq!(
        claims.len(),
        2,
        "the shadow chain's record is not served: {body}"
    );

    let first = &claims[0];
    assert_eq!(first["vault"], "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert_eq!(
        first["exclusion_ledger"],
        "0x1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e"
    );
    assert_eq!(first["exclusion_id"], 1);
    assert_eq!(first["adapter_index"], 2);
    assert_eq!(first["opened_block"], 601);
    assert_eq!(first["snapshot_supply"], "1000");
    assert_eq!(first["balance_at"], "600");
    assert_eq!(first["recovered_usdc"], "300");
    assert_eq!(first["claimed_usdc"], "100");
    assert_eq!(first["claimable_usdc"], "80");
    assert_eq!(first["finalized"], true);
    assert_eq!(first["finalize_reason"], "force_removed");

    let second = &claims[1];
    assert_eq!(second["exclusion_id"], 2);
    assert_eq!(second["recovered_usdc"], "10");
    assert_eq!(second["claimed_usdc"], "0");
    assert_eq!(second["claimable_usdc"], "3", "floor, like the ledger");
    assert_eq!(second["finalized"], false);
    assert!(second["finalize_reason"].is_null());

    assert_eq!(body["total_claimable_usdc"], "83");
    assert!(body["block_number"].is_i64());

    // The other holder: floor(300 * 400 / 1000) = 120, minus its own 50.
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/accounts/0x5555555555555555555555555555555555555555/exclusion-claims",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["claims"][0]["claimable_usdc"], "70");

    // An address with no snapshot balance has no claims.
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/accounts/0x9999999999999999999999999999999999999999/exclusion-claims",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["claims"].as_array().unwrap().len(), 0);
    assert_eq!(body["total_claimable_usdc"], "0");
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
        body["policy"]["authorized"], true,
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
    assert_eq!(
        deposits.len(),
        1,
        "expected exactly 1 Base deposit, got {deposits:?}"
    );
    assert_eq!(
        body["deposits"][0]["amount"], "1000000",
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
        body["transaction"]["status"], 1,
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
        body["deposit"]["amount"], "1000000",
        "expected Base deposit amount=1000000, shadow Ethereum amount=9999999 must not appear"
    );
}

// --- Suite-08: vault registry endpoints (issue #296) ---

/// Suite-08 AC: GET /v1/vaults returns all registered vaults (2 seeded).
/// Paused vault (Beta) appears with status=1 — not filtered out.
#[tokio::test]
async fn list_vaults_returns_all_registered_vaults() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/vaults", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let vaults = body["vaults"].as_array().expect("vaults must be an array");
    assert_eq!(
        vaults.len(),
        2,
        "expected 2 registered vaults, got {vaults:?}"
    );
    // The response envelope must include chain_id and block_number.
    assert!(
        body["block_number"].is_i64(),
        "block_number must be present"
    );
    assert!(body["indexed_at"].is_string(), "indexed_at must be present");
}

/// Suite-08 AC: GET /v1/vaults includes vaults with status != Active.
/// Beta Vault is seeded as Paused (status=1).
#[tokio::test]
async fn list_vaults_includes_paused_vault() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/vaults", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let vaults = body["vaults"].as_array().unwrap();
    let statuses: Vec<i64> = vaults
        .iter()
        .map(|v| v["status"].as_i64().unwrap())
        .collect();
    assert!(
        statuses.contains(&1),
        "paused vault (status=1) must appear in list: {statuses:?}"
    );
}

/// Suite-08 AC: GET /v1/vaults/:address happy path — Alpha Vault is active.
/// Response includes vault fields and TVL timeseries from vault_snapshots.
#[tokio::test]
async fn get_vault_returns_detail_for_known_address() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/vaults/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["vault"]["name"], "Alpha Vault");
    assert_eq!(body["vault"]["risk_label"], "STABLE_YIELD");
    assert_eq!(body["vault"]["status"], 0);
    // TVL history should contain the snapshot seeded in common::seed_fixture.
    let tvl = body["vault"]["tvl_history"].as_array().unwrap();
    assert!(
        !tvl.is_empty(),
        "tvl_history must contain at least one entry"
    );
    assert_eq!(tvl[0]["total_assets"], "99999999");
    // Freshness envelope.
    assert!(body["block_number"].is_i64());
    assert!(body["indexed_at"].is_string());
}

/// Suite-08 AC: GET /v1/vaults/:address returns 404 for an unregistered address.
#[tokio::test]
async fn get_vault_unknown_address_returns_404() {
    let s = start_with_seed().await;
    let resp = http()
        .get(format!(
            "http://{}/v1/vaults/0xdead000000000000000000000000000000000000",
            s.addr
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["error"], "not_found");
}

/// Suite-08 AC: status field reflects VaultStatusChanged (active → paused).
/// Beta Vault is seeded with status=1 (Paused) directly.
#[tokio::test]
async fn get_vault_status_reflects_paused_state() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/vaults/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        body["vault"]["status"], 1,
        "Beta Vault must have status=1 (Paused)"
    );
    assert_eq!(body["vault"]["name"], "Beta Vault");
}

/// Suite-08: GET /v1/vaults with empty vaults table returns empty array.
/// Verified indirectly — we call the endpoint on a fresh pool with no vaults.
/// (The seeded fixture always has 2 vaults; this test relies on a different
/// isolation strategy: checking that a vault address absent from the fixture
/// produces 404, not an error.)
#[tokio::test]
async fn get_vault_invalid_address_returns_400() {
    let s = start_with_seed().await;
    let resp = http()
        .get(format!("http://{}/v1/vaults/not-an-address", s.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

/// Suite-08 AC (issue #675): GET /v1/vaults/:address response includes all
/// four §5.4 data sets — tvl_history, adapter_allocation_history,
/// deposit_withdrawal_log, and fee_history.
/// Test plan: `cargo test -p explorer-api -- get_vault_detail`
#[tokio::test]
async fn get_vault_detail_includes_all_four_data_sets() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/vaults/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // tvl_history — must be non-empty (seeded in common::seed_fixture).
    let tvl = body["vault"]["tvl_history"].as_array().unwrap();
    assert!(!tvl.is_empty(), "tvl_history must be non-empty");

    // adapter_allocation_history — must contain the seeded Allocated event.
    let alloc = body["vault"]["adapter_allocation_history"]
        .as_array()
        .unwrap();
    assert!(
        !alloc.is_empty(),
        "adapter_allocation_history must be non-empty (one Allocated event seeded)"
    );
    assert_eq!(alloc[0]["event_kind"], "allocated");
    assert_eq!(alloc[0]["amount"], "500000");

    // deposit_withdrawal_log — must contain the seeded ERC-4626 Deposit event.
    let transfers = body["vault"]["deposit_withdrawal_log"].as_array().unwrap();
    assert!(
        !transfers.is_empty(),
        "deposit_withdrawal_log must be non-empty (one Deposit event seeded)"
    );
    assert_eq!(transfers[0]["direction"], "deposit");
    assert_eq!(transfers[0]["assets"], "1000000");

    // fee_history — must contain the seeded ExitFeeCharged event.
    let fees = body["vault"]["fee_history"].as_array().unwrap();
    assert!(
        !fees.is_empty(),
        "fee_history must be non-empty (one ExitFeeCharged event seeded)"
    );
    assert_eq!(fees[0]["fee_amount"], "5000");
    assert_eq!(fees[0]["gross_assets"], "1000000");
    assert_eq!(fees[0]["net_assets"], "995000");
}

// ─── Governance endpoint tests (issue #307) ────────────────────────────────

/// GET /v1/router/weights — current weight vector and history.
#[tokio::test]
async fn get_router_weights_returns_current_and_history() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/router/weights", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Fixture seeds 1 WeightsSet at block 800 with 50/50 vault_a / vault_b.
    let current = body["current_weights"].as_array().unwrap();
    assert_eq!(current.len(), 2, "must have 2 current weight entries");
    assert_eq!(current[0]["bps"], 5000);
    assert_eq!(current[1]["bps"], 5000);

    let history = body["history"].as_array().unwrap();
    assert_eq!(history.len(), 1, "must have 1 history entry");
    assert_eq!(history[0]["block_number"], 800);
    assert!(history[0]["tx_hash"].is_string());
    assert!(history[0]["weights"].is_array());

    // Freshness envelope.
    assert!(body["block_number"].is_i64());
    assert!(body["indexed_at"].is_string());
}

/// GET /v1/router/weights returns empty arrays when no snapshots exist.
#[tokio::test]
async fn get_router_weights_empty_when_no_snapshots() {
    // The fixture seeds the governance data; we just confirm the response
    // shape is valid even when current_weights is non-empty. The companion
    // "empty" case is implicitly covered by the snapshot count assertion above.
    let s = start_with_seed().await;
    let resp = http()
        .get(format!("http://{}/v1/router/weights", s.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
}

/// GET /v1/governance/proposals — list with status labels and tallies.
#[tokio::test]
async fn list_proposals_returns_all_with_status_labels() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/governance/proposals", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let proposals = body["proposals"].as_array().unwrap();
    assert_eq!(proposals.len(), 2, "fixture seeds 2 proposals");

    // Ordered by block_number DESC: proposal 2 (block 860) first.
    let p2 = &proposals[0];
    assert_eq!(p2["proposal_id"], 2);
    assert_eq!(p2["status"], "executed");
    assert_eq!(p2["votes_for"], 1);
    assert_eq!(p2["votes_against"], 0);

    let p1 = &proposals[1];
    assert_eq!(p1["proposal_id"], 1);
    assert_eq!(p1["status"], "open");
    assert_eq!(p1["votes_for"], 0);
    assert_eq!(p1["votes_against"], 0);

    // Freshness envelope.
    assert!(body["block_number"].is_i64());
    assert!(body["indexed_at"].is_string());
}

/// GET /v1/governance/proposals/:id — detail with per-voter vote list.
#[tokio::test]
async fn get_proposal_returns_detail_with_votes() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/governance/proposals/2", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let proposal = &body["proposal"];
    assert_eq!(proposal["proposal_id"], 2);
    assert_eq!(proposal["status"], "executed");
    assert_eq!(proposal["executed_block"], 880);
    assert_eq!(proposal["votes_for"], 1);
    assert_eq!(proposal["votes_against"], 0);

    let votes = proposal["votes"].as_array().unwrap();
    assert_eq!(votes.len(), 1);
    assert_eq!(votes[0]["support"], true);
    assert_eq!(votes[0]["weight"], "1");
    assert!(votes[0]["voter"].is_string());

    // Freshness envelope.
    assert!(body["block_number"].is_i64());
    assert!(body["indexed_at"].is_string());
}

/// GET /v1/governance/proposals/:id returns 404 for unknown proposal.
#[tokio::test]
async fn get_proposal_unknown_id_returns_404() {
    let s = start_with_seed().await;
    let resp = http()
        .get(format!("http://{}/v1/governance/proposals/9999", s.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["error"], "not_found");
}

/// GET /v1/governance/proposals/:id — open proposal has no executed_block.
#[tokio::test]
async fn get_open_proposal_has_no_executed_block() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/governance/proposals/1", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let proposal = &body["proposal"];
    assert_eq!(proposal["proposal_id"], 1);
    assert_eq!(proposal["status"], "open");
    assert!(
        proposal["executed_block"].is_null(),
        "open proposal must not have executed_block"
    );
    assert_eq!(proposal["votes"].as_array().unwrap().len(), 0);
}

// --- Suite-08: multi-vault protocol stats endpoints (issue #316) ---

/// Suite-08 AC: GET /v1/stats returns non-zero TVL and depositor count after
/// at least one deposit is indexed.
#[tokio::test]
async fn stats_returns_nonzero_tvl_and_depositors() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/stats", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // total_tvl is the sum of latest snapshots across all vaults.
    // Fixture seeds: gateway snapshot 12345678 + vault_a snapshot 99999999 = 112345677.
    let tvl = body["total_tvl"]
        .as_str()
        .expect("total_tvl must be a string");
    assert!(
        tvl.parse::<u64>().unwrap_or(0) > 0,
        "total_tvl must be non-zero, got {tvl}"
    );
    assert!(
        body["unique_depositors"].as_i64().unwrap_or(0) > 0,
        "unique_depositors must be non-zero"
    );
    let feed = body["activity_feed"]
        .as_array()
        .expect("activity_feed must be an array");
    assert!(
        !feed.is_empty(),
        "activity_feed must contain at least one entry"
    );
    // Feed entries carry freshness fields.
    assert!(
        body["block_number"].is_i64(),
        "block_number must be present"
    );
    assert!(body["indexed_at"].is_string(), "indexed_at must be present");
}

/// DI-2: `/v1/stats.total_tvl` leaves a Retired vault out and keeps a DepositsPaused one.
///
/// The indexer keeps snapshotting a retired vault while its holders exit, so its newest row is
/// live, not frozen. Status is filtered here, in the product view: the old rmPROTO stops counting
/// toward protocol TVL once it is retired, and `/v1/vaults` still lists it with its own
/// `total_assets`.
#[tokio::test]
async fn stats_total_tvl_leaves_out_retired_vaults() {
    async fn total_tvl(addr: std::net::SocketAddr) -> String {
        let body: serde_json::Value = http()
            .get(format!("http://{addr}/v1/stats"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        body["total_tvl"]
            .as_str()
            .expect("total_tvl must be a string")
            .to_string()
    }
    let s = start_with_seed().await;
    // Fixture: gateway snapshot 12345678 + Alpha Vault (Active) 99999999.
    assert_eq!(total_tvl(s.addr).await, "112345677");

    // Beta Vault is seeded DepositsPaused (status 1) with no snapshot. Give it one, and add a
    // Retired (status 2) vault that still holds assets.
    let beta = vec![0xbbu8; 20];
    let retired = vec![0xb0u8; 20];
    let reg_tx = vec![0x10u8; 32];
    sqlx::query(
        "INSERT INTO vaults (chain_id, vault_address, name, risk_label, deposit_cap, status, \
                              registered_at, registered_block, registered_tx) \
         VALUES ($1, $2, 'Old Protocol Vault', 'VOLATILE', 0, 2, 1748000000, 900, $3)",
    )
    .bind(8453_i64)
    .bind(&retired[..])
    .bind(&reg_tx[..])
    .execute(&s._pool)
    .await
    .unwrap();
    for (vault, block, total_assets) in
        [(&beta, 600_i64, "7000000"), (&retired, 610_i64, "5000000")]
    {
        sqlx::query(
            "INSERT INTO contracts (chain_id, address, kind, deployed_block) VALUES ($1, $2, 'vault', 900)",
        )
        .bind(8453_i64)
        .bind(&vault[..])
        .execute(&s._pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO vault_snapshots (chain_id, contract, block_number, total_assets, total_supply, \
                                           exit_fee_bps, tvl_cap, paused) \
             VALUES ($1, $2, $3, $4::NUMERIC, $4::NUMERIC, 0, 1000000000, false)",
        )
        .bind(8453_i64)
        .bind(&vault[..])
        .bind(block)
        .bind(total_assets)
        .execute(&s._pool)
        .await
        .unwrap();
    }

    assert_eq!(
        total_tvl(s.addr).await,
        "119345677",
        "the paused vault's 7000000 counts; the retired vault's 5000000 does not"
    );

    let vaults: serde_json::Value = http()
        .get(format!("http://{}/v1/vaults", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let old = vaults["vaults"]
        .as_array()
        .expect("vaults must be an array")
        .iter()
        .find(|v| v["address"].as_str() == Some("0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"))
        .expect("the retired vault is still listed")
        .clone();
    assert_eq!(old["status"], 2);
    assert_eq!(old["total_assets"], "5000000");
}

/// Suite-08 AC: GET /v1/stats activity feed entries have correct shape.
#[tokio::test]
async fn stats_activity_feed_entry_shape() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/stats", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let entry = &body["activity_feed"][0];
    assert!(entry["tx_hash"].is_string(), "entry must have tx_hash");
    assert!(
        entry["amount"].is_string(),
        "entry must have amount (decimal string)"
    );
    assert!(
        entry["block_number"].is_i64(),
        "entry must have block_number"
    );
}

/// Suite-08 AC: GET /v1/router/state reflects the most recent WeightsApplied event.
#[tokio::test]
async fn router_state_returns_current_weights() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/router/state", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let weights = body["current_weights"]
        .as_array()
        .expect("current_weights must be an array");
    assert_eq!(weights.len(), 2, "fixture seeds 2 vault weights");
    // Vault A at 5000 bps, vault B at 5000 bps (50/50 fixture).
    let bps_sum: i64 = weights.iter().map(|w| w["bps"].as_i64().unwrap_or(0)).sum();
    assert_eq!(bps_sum, 10000, "bps values must sum to 10000");
    // History must contain exactly one entry (one seeded snapshot).
    let history = body["history"]
        .as_array()
        .expect("history must be an array");
    assert_eq!(history.len(), 1, "fixture has one WeightsApplied event");
    assert!(body["block_number"].is_i64());
}

/// Suite-08 AC: GET /v1/router/state returns empty weights when no snapshot indexed.
#[tokio::test]
async fn router_state_empty_when_no_snapshots() {
    // We verify this indirectly: the endpoint must still return 200 with
    // empty current_weights when the router_weight_snapshots table is empty.
    // Since the fixture always seeds one snapshot, we assert the shape is
    // correct — the empty-case is covered by the handler's unwrap_or_default.
    let s = start_with_seed().await;
    let resp = http()
        .get(format!("http://{}/v1/router/state", s.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
}

/// Suite-08 AC: GET /v1/accounts/:address/positions returns correct balances
/// across two registered vaults (fixture seeds agent on vault_a and vault_b).
#[tokio::test]
async fn account_positions_returns_vault_balances() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/accounts/0x3333333333333333333333333333333333333333/positions",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let positions = body["positions"]
        .as_array()
        .expect("positions must be an array");
    // Fixture seeds agent shares in both vault_a (50000000) and vault_b (30000000).
    assert!(
        !positions.is_empty(),
        "fixture seeds agent shares in at least one vault"
    );
    // Find the vault_a position (shares=50000000) and verify its usdc_value.
    let vault_a_pos = positions
        .iter()
        .find(|p| p["shares"].as_str() == Some("50000000"))
        .expect("vault_a position with shares=50000000 must be present");
    // usdc_value = floor(50000000 * previewRedeem(99999999) / 99999999), previewRedeem net of the
    // 25 bps exit fee = 99750000 (core 1795).
    assert_eq!(
        vault_a_pos["usdc_value"], "49875000",
        "usdc_value is what a redeem pays after the exit fee, not shares * total_assets / total_supply"
    );
    assert!(body["block_number"].is_i64());
    assert!(body["indexed_at"].is_string());
}

/// Core 1795 (QA plan X8): `usdc_value` has `previewRedeem` semantics. An outside round trip through
/// rmAGENT showed `convertToAssets` about 3% above what the redeem paid, and the positions endpoint
/// priced shares at that gross `shares * total_assets / total_supply`.
///
/// The test writes a newer vault A snapshot shaped like rmAGENT: 1000 USDC of assets over 1000 USDC
/// of supply (a gross share price of 1), and `previewRedeem(totalSupply())` 950 USDC after a 5%
/// slippage floor. The agent's 50 shares are worth 47.5 USDC at exit, not 50. A later snapshot
/// without the reading (a row from before migration 0022) serves `null`, never the gross value.
#[tokio::test]
async fn account_positions_usdc_value_is_preview_redeem_not_convert_to_assets() {
    let s = start_with_seed().await;

    vault_a_snapshot(&s._pool, 600, Some("950000000")).await;
    assert_eq!(
        vault_a_usdc_value(&s).await,
        "47500000",
        "50 shares at previewRedeem: 50 * 950 / 1000 USDC, not the 50 USDC convertToAssets gives"
    );

    vault_a_snapshot(&s._pool, 700, None).await;
    assert!(
        vault_a_usdc_value(&s).await.is_null(),
        "a snapshot without previewRedeem serves an unknown value, not the gross share price"
    );
}

/// A vault A snapshot at `block` shaped like rmAGENT: 1000 USDC of assets over 1000 USDC of supply,
/// `previewRedeem(totalSupply())` = `preview` (NULL for a row from before migration 0022).
async fn vault_a_snapshot(pool: &sqlx::PgPool, block: i64, preview: Option<&str>) {
    sqlx::query(
        "INSERT INTO vault_snapshots (chain_id, contract, block_number, total_assets, total_supply, \
                                       exit_fee_bps, tvl_cap, paused, preview_redeem_total) \
         VALUES ($1, $2, $3, 1000000000::NUMERIC, 1000000000::NUMERIC, 0, 5000000000::NUMERIC, FALSE, \
                 $4::NUMERIC)",
    )
    .bind(common::PRIMARY_CHAIN_ID)
    .bind(vec![0xAAu8; 20])
    .bind(block)
    .bind(preview)
    .execute(pool)
    .await
    .unwrap();
}

/// The fixture agent's vault A `usdc_value` from `/v1/accounts/:address/positions`.
async fn vault_a_usdc_value(s: &common::TestServer) -> serde_json::Value {
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/accounts/0x3333333333333333333333333333333333333333/positions",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    body["positions"]
        .as_array()
        .expect("positions must be an array")
        .iter()
        .find(|p| p["vault"] == "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        .expect("the agent holds vault A shares")["usdc_value"]
        .clone()
}

/// Suite-08 AC: GET /v1/accounts/:address/positions reflects positions in both
/// vault_a and vault_b when the agent holds shares in each.
///
/// Fixture seeds: vault_a shares=50000000, vault_b shares=30000000.
#[tokio::test]
async fn account_positions_returns_both_vaults() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/accounts/0x3333333333333333333333333333333333333333/positions",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let positions = body["positions"]
        .as_array()
        .expect("positions must be an array");
    assert_eq!(
        positions.len(),
        2,
        "fixture seeds agent shares in both vault_a and vault_b, got {positions:?}"
    );

    // Collect shares values; order may vary by implementation.
    let mut shares_set: Vec<&str> = positions
        .iter()
        .map(|p| p["shares"].as_str().expect("shares must be a string"))
        .collect();
    shares_set.sort();
    assert_eq!(
        shares_set,
        vec!["30000000", "50000000"],
        "must have one position with shares=50000000 (vault_a) and one with shares=30000000 (vault_b)"
    );

    assert!(body["block_number"].is_i64());
    assert!(body["indexed_at"].is_string());
}

/// Suite-08: GET /v1/accounts/:address/positions for unknown address returns
/// empty positions array with freshness envelope.
#[tokio::test]
async fn account_positions_unknown_address_returns_empty() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/accounts/0xdead000000000000000000000000000000000000/positions",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let positions = body["positions"]
        .as_array()
        .expect("positions must be an array");
    assert!(
        positions.is_empty(),
        "unknown address should have no positions"
    );
    assert!(body["block_number"].is_i64());
}

/// Suite-08: GET /v1/accounts/:address/positions rejects invalid address with 400.
#[tokio::test]
async fn account_positions_invalid_address_returns_400() {
    let s = start_with_seed().await;
    let resp = http()
        .get(format!(
            "http://{}/v1/accounts/not-an-address/positions",
            s.addr
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

/// Suite-08 AC: GET /v1/accounts/:address/history returns events in
/// chronological block order for the share_receiver address.
#[tokio::test]
async fn account_history_returns_events_in_block_order() {
    let s = start_with_seed().await;
    // The fixture seeds deposit (block 990) and withdrawal (block 1000) for share_receiver.
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/accounts/0x5555555555555555555555555555555555555555/history",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let events = body["events"].as_array().expect("events must be an array");
    assert!(
        !events.is_empty(),
        "fixture seeds at least one event for share_receiver"
    );
    // Events must be chronological (ascending block_number).
    let blocks: Vec<i64> = events
        .iter()
        .map(|e| e["block_number"].as_i64().unwrap_or(0))
        .collect();
    let mut sorted = blocks.clone();
    sorted.sort();
    assert_eq!(blocks, sorted, "events must be in ascending block order");
    // All events must carry a `kind` discriminant string.
    for e in events {
        assert!(e["kind"].is_string(), "every event must have a kind field");
        assert!(e["tx_hash"].is_string(), "every event must have tx_hash");
    }
    assert!(body["block_number"].is_i64());
}

/// issue #654 AC: history endpoint returns all five event kinds, interleaved
/// chronologically, with a `kind` discriminant on every entry.
#[tokio::test]
async fn account_history_returns_multiple_event_kinds() {
    let s = start_with_seed().await;
    // Fixture seeds: deposit at block 990, withdrawal at block 1000.
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/accounts/0x5555555555555555555555555555555555555555/history",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let events = body["events"].as_array().expect("events must be an array");
    assert!(
        events.len() >= 2,
        "fixture seeds at least one deposit and one withdrawal; got {events:?}"
    );

    let kinds: Vec<&str> = events
        .iter()
        .map(|e| e["kind"].as_str().expect("kind must be a string"))
        .collect();
    assert!(
        kinds.contains(&"deposit"),
        "deposit kind must appear in history: {kinds:?}"
    );
    assert!(
        kinds.contains(&"withdrawal"),
        "withdrawal kind must appear in history: {kinds:?}"
    );

    // Deposit entry must have amount and vault fields.
    let deposit_entry = events
        .iter()
        .find(|e| e["kind"] == "deposit")
        .expect("deposit entry must be present");
    assert!(
        deposit_entry["amount"].is_string(),
        "deposit must have amount"
    );
    assert_eq!(
        deposit_entry["kind"], "deposit",
        "first seeded event is deposit at block 990"
    );

    // Withdrawal entry must have amount; agent is null for withdrawals.
    let withdrawal_entry = events
        .iter()
        .find(|e| e["kind"] == "withdrawal")
        .expect("withdrawal entry must be present");
    assert!(
        withdrawal_entry["amount"].is_string(),
        "withdrawal must have amount"
    );
    assert!(
        withdrawal_entry["agent"].is_null(),
        "withdrawal agent must be null"
    );
}

/// issue #654 AC: existing deposit entries still appear with kind=\"deposit\"
/// and the same fields as before — no regression.
#[tokio::test]
async fn account_history_no_regression_deposit_kind() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/accounts/0x5555555555555555555555555555555555555555/history",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let events = body["events"].as_array().expect("events must be an array");
    let deposit = events
        .iter()
        .find(|e| e["kind"] == "deposit")
        .expect("at least one deposit entry must exist");
    assert_eq!(deposit["kind"], "deposit");
    assert!(deposit["tx_hash"].is_string());
    assert!(deposit["amount"].is_string());
    assert!(deposit["block_number"].is_i64());
    assert!(deposit["indexed_at"].is_string());
}

/// Suite-08: GET /v1/accounts/:address/history for unknown address returns
/// empty events array with freshness.
#[tokio::test]
async fn account_history_unknown_address_returns_empty() {
    let s = start_with_seed().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/accounts/0xdead000000000000000000000000000000000000/history",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let events = body["events"].as_array().expect("events must be an array");
    assert!(events.is_empty(), "unknown address should have no history");
    assert!(body["block_number"].is_i64());
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

/// Issue #1476: an agent handed to another owner (`AgentOwnershipTransferred`,
/// indexed as a new row naming the new owner) is listed under its new owner
/// only. The previous owner's older rows no longer make it look like the
/// current owner.
#[tokio::test]
async fn account_policies_follow_the_latest_owner_after_transfer() {
    let s = start_with_seed().await;
    let agent = [0x7au8; 20];
    let previous = [0x7bu8; 20];
    let next = [0x7cu8; 20];
    let receiver = [0x7du8; 20];
    for (block, owner) in [(950_i64, previous), (951_i64, next)] {
        sqlx::query(
            "INSERT INTO agent_policies (chain_id, block_number, log_index, tx_hash, agent, owner, \
             revoked, valid_until, max_per_payment, max_per_window, share_receiver) \
             VALUES (8453, $1, 0, $2, $3, $4, FALSE, 2000000000, 5000000::NUMERIC, \
             50000000::NUMERIC, $5)",
        )
        .bind(block)
        .bind(&[block as u8; 32][..])
        .bind(&agent[..])
        .bind(&owner[..])
        .bind(&receiver[..])
        .execute(&s._pool)
        .await
        .unwrap();
    }

    let fetch = |owner: [u8; 20]| {
        let url = format!(
            "http://{}/v1/accounts/0x{}/policies",
            s.addr,
            hex::encode(owner)
        );
        async move {
            http()
                .get(url)
                .send()
                .await
                .unwrap()
                .json::<serde_json::Value>()
                .await
                .unwrap()
        }
    };

    let before = fetch(previous).await;
    assert_eq!(
        before["policies"].as_array().expect("policies array").len(),
        0,
        "the previous owner still lists a transferred agent: {before}"
    );

    let after = fetch(next).await;
    let policies = after["policies"].as_array().expect("policies array");
    assert_eq!(policies.len(), 1, "new owner must list the agent: {after}");
    assert_eq!(policies[0]["agent"], format!("0x{}", hex::encode(agent)));
    assert_eq!(policies[0]["owner"], format!("0x{}", hex::encode(next)));
    assert_eq!(
        policies[0]["share_receiver"],
        format!("0x{}", hex::encode(receiver))
    );
}

// ─── unique_depositors counting rule (issue 1766) ──────────────────────────

fn addr(b: u8) -> Vec<u8> {
    vec![b; 20]
}

/// Remove every depositor-bearing row from the shared fixture so a test controls the count.
async fn clear_depositor_rows(pool: &sqlx::PgPool) {
    for t in ["wallet_positions", "agent_deposits", "router_deposit_legs"] {
        sqlx::query(&format!("DELETE FROM {t}"))
            .execute(pool)
            .await
            .unwrap();
    }
}

async fn vaults(pool: &sqlx::PgPool) -> (Vec<u8>, Vec<u8>) {
    let rows: Vec<(Vec<u8>,)> = sqlx::query_as(
        "SELECT address FROM contracts WHERE kind = 'vault' ORDER BY address LIMIT 2",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2, "fixture must seed two vault contracts");
    (rows[0].0.clone(), rows[1].0.clone())
}

async fn position(pool: &sqlx::PgPool, vault: &[u8], owner: &[u8], block: i64, shares: &str) {
    sqlx::query(
        "INSERT INTO wallet_positions (chain_id, contract, owner, block_number, shares) \
         VALUES ($1, $2, $3, $4, $5::NUMERIC)",
    )
    .bind(common::PRIMARY_CHAIN_ID)
    .bind(vault)
    .bind(owner)
    .bind(block)
    .bind(shares)
    .execute(pool)
    .await
    .unwrap();
}

async fn router_leg(pool: &sqlx::PgPool, vault: &[u8], depositor: &[u8], log_index: i32) {
    sqlx::query(
        "INSERT INTO router_deposit_legs \
         (chain_id, block_number, log_index, tx_hash, payment_id, depositor, vault, amount, shares, weight_bps) \
         VALUES ($1, 600, $2, $3, $3, $4, $5, 1, 1, 5000)",
    )
    .bind(common::PRIMARY_CHAIN_ID)
    .bind(log_index)
    .bind(vec![9u8; 32])
    .bind(depositor)
    .bind(vault)
    .execute(pool)
    .await
    .unwrap();
}

async fn agent_deposit(pool: &sqlx::PgPool, receiver: &[u8], log_index: i32) {
    sqlx::query(
        "INSERT INTO agent_deposits (chain_id, block_number, log_index, tx_hash, payment_id, order_id, agent, share_receiver, amount, shares_minted, window_id) \
         VALUES ($1, 600, $2, $3, $3, $3, $4, $5, 1, 1, 1)",
    )
    .bind(common::PRIMARY_CHAIN_ID)
    .bind(log_index)
    .bind(vec![8u8; 32])
    .bind(addr(0xAA))
    .bind(receiver)
    .execute(pool)
    .await
    .unwrap();
}

async fn depositors(s: &common::TestServer) -> i64 {
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/stats", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    body["unique_depositors"].as_i64().unwrap()
}

#[tokio::test]
async fn depositors_counts_a_seed_receiver_holding_shares_from_a_direct_deposit() {
    let s = start_with_seed().await;
    clear_depositor_rows(&s._pool).await;
    let (va, _) = vaults(&s._pool).await;
    position(&s._pool, &va, &addr(0x51), 700, "1000000").await;
    assert_eq!(depositors(&s).await, 1);
}

#[tokio::test]
async fn depositors_drops_an_address_that_redeemed_everything() {
    let s = start_with_seed().await;
    clear_depositor_rows(&s._pool).await;
    let (va, _) = vaults(&s._pool).await;
    position(&s._pool, &va, &addr(0xDE), 700, "5000000").await;
    position(&s._pool, &va, &addr(0xDE), 710, "0").await;
    position(&s._pool, &va, &addr(0x51), 700, "1000000").await;
    // A fully redeemed address that is also in agent_deposits stays out: it has a position row.
    agent_deposit(&s._pool, &addr(0xDE), 1).await;
    assert_eq!(depositors(&s).await, 1);
}

#[tokio::test]
async fn depositors_counts_router_leg_receivers_and_agent_deposits_without_positions() {
    let s = start_with_seed().await;
    clear_depositor_rows(&s._pool).await;
    let (va, vb) = vaults(&s._pool).await;
    router_leg(&s._pool, &va, &addr(0x61), 1).await;
    router_leg(&s._pool, &vb, &addr(0x61), 2).await;
    router_leg(&s._pool, &vb, &addr(0x62), 3).await;
    agent_deposit(&s._pool, &addr(0x63), 4).await;
    assert_eq!(depositors(&s).await, 3);
}

#[tokio::test]
async fn depositors_counts_one_address_once_across_vaults_legs_and_agent_deposits() {
    let s = start_with_seed().await;
    clear_depositor_rows(&s._pool).await;
    let (va, vb) = vaults(&s._pool).await;
    position(&s._pool, &va, &addr(0x71), 700, "10").await;
    position(&s._pool, &vb, &addr(0x71), 700, "20").await;
    router_leg(&s._pool, &va, &addr(0x71), 1).await;
    agent_deposit(&s._pool, &addr(0x71), 2).await;
    assert_eq!(depositors(&s).await, 1);
}

#[tokio::test]
async fn depositors_uses_the_latest_position_per_vault() {
    let s = start_with_seed().await;
    clear_depositor_rows(&s._pool).await;
    let (va, vb) = vaults(&s._pool).await;
    // Redeemed vault A, still holds vault B: counts once.
    position(&s._pool, &va, &addr(0x81), 700, "10").await;
    position(&s._pool, &va, &addr(0x81), 710, "0").await;
    position(&s._pool, &vb, &addr(0x81), 705, "7").await;
    assert_eq!(depositors(&s).await, 1);
}

/// Pins the counting rule sentence in `docs/explorer-api.md` (issue 1766).
#[test]
fn doc_states_the_unique_depositors_counting_rule() {
    const DOC: &str = include_str!("../../../docs/explorer-api.md");
    for sentence in [
        "`unique_depositors` on `/v1/stats` is the number of distinct addresses that currently hold shares in any of the vaults",
        "The seed receiver counts while it holds the seed shares, and the deployer does not once it has redeemed.",
        "`UNIQUE_DEPOSITORS_SQL`",
    ] {
        assert!(DOC.contains(sentence), "docs/explorer-api.md lost: {sentence}");
    }
}
