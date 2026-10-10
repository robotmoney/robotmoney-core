//! Issue 1741: the indexer stores each vault's real `tvlCap()` and `perDepositCap()` in `vault_snapshots`,
//! and a read that fails is NULL (unknown), never 0.
//!
//! One test per vault family. RobotMoneyVault and every BasketVault (ProtocolAssetVault, AgentTokenVault,
//! RwaBasketVault) declare both caps as `uint256 public`, so the same two selectors answer on both. The stub RPC
//! answers per target address and selector, so each family gets its own caps from its own address. The
//! numbers are the ones read with `cast` from the Base 8453 rehearsal contracts.
//!
//! The tests use the shared Postgres fixture and a stub RPC. They do not skip when Docker is missing: the
//! fixture panics, naming the missing dependency (issue #1377).

mod common;

use alloy_primitives::{Address, U256};
use common::{pg_fixture, StubRpcServer};
use explorer_indexer::{
    abi::IVaultReads,
    indexer::{run_once, IndexerConfig},
    rpc::JsonRpc,
};
use std::collections::HashMap;
use std::sync::Arc;

const CHAIN: i64 = 8453;
const USDC: u64 = 1_000_000;

fn cfg() -> IndexerConfig {
    IndexerConfig {
        chain_id: CHAIN,
        chain_name: "base".into(),
        rpc_label: "stub".into(),
        gateway: Address::from([0x11u8; 20]),
        vault: Address::from([0x22u8; 20]),
        registry: None,
        router_governance: None,
        portfolio_router: None,
        investment_committee: None,
        consensus_receipt: None,
        timelock: None,
        safe: None,
        max_blocks_per_tick: 100,
        start_block: None,
        end_block: Some(12),
        feature_flags: 0,
    }
}

fn word(v: U256) -> String {
    format!("0x{}", alloy_primitives::hex::encode(v.to_be_bytes::<32>()))
}

fn sel<C: alloy_sol_types::SolCall>() -> String {
    alloy_primitives::hex::encode(C::SELECTOR)
}

/// What one fake vault answers. `None` for a getter makes that call revert.
#[derive(Clone, Copy)]
struct FakeVault {
    total_assets: u64,
    tvl_cap: Option<U256>,
    per_deposit_cap: Option<U256>,
}

async fn register(fx: &common::PgFixture, vault: Address, name: &str) {
    fx.db
        .upsert_contract(CHAIN, vault.into_array(), "vault", None)
        .await
        .unwrap();
    fx.db
        .upsert_vault(
            CHAIN,
            vault.into_array(),
            name,
            "STABLE_YIELD",
            U256::ZERO,
            0,
            1,
            1,
            [0x01; 32],
        )
        .await
        .unwrap();
}

async fn run(fx: &common::PgFixture, vaults: HashMap<Address, FakeVault>) {
    fx.db.upsert_chain(CHAIN, "base", "stub").await.unwrap();
    let stub = StubRpcServer::start().await;
    stub.set("eth_blockNumber", serde_json::json!("0x14"));
    stub.set(
        "eth_getBlockByNumber",
        serde_json::json!({
            "number": "0xa",
            "hash": format!("0x{}", hex::encode([0xaau8; 32])),
            "parentHash": format!("0x{}", hex::encode([0x00u8; 32])),
            "timestamp": "0x65000000",
            "transactions": []
        }),
    );
    stub.set("eth_getLogs", serde_json::json!([]));
    let (assets, supply, fee, tvl, per, paused) = (
        sel::<IVaultReads::totalAssetsCall>(),
        sel::<IVaultReads::totalSupplyCall>(),
        sel::<IVaultReads::exitFeeBpsCall>(),
        sel::<IVaultReads::tvlCapCall>(),
        sel::<IVaultReads::perDepositCapCall>(),
        sel::<IVaultReads::depositsPausedCall>(),
    );
    let by_addr: HashMap<String, FakeVault> = vaults
        .iter()
        .map(|(a, v)| (format!("{a:#x}"), *v))
        .collect();
    stub.set_call_hook(Arc::new(move |to: &str, data: &str| {
        let Some(v) = by_addr.get(to) else {
            return Err("execution reverted".to_string());
        };
        let data = data.trim_start_matches("0x");
        let revert = || Err("execution reverted".to_string());
        if data.starts_with(&assets) || data.starts_with(&supply) {
            Ok(word(U256::from(v.total_assets)))
        } else if data.starts_with(&fee) || data.starts_with(&paused) {
            Ok(word(U256::ZERO))
        } else if data.starts_with(&tvl) {
            v.tvl_cap.map(word).ok_or(()).or_else(|_| revert())
        } else if data.starts_with(&per) {
            v.per_deposit_cap.map(word).ok_or(()).or_else(|_| revert())
        } else {
            revert()
        }
    }));
    let rpc = JsonRpc::new(&stub.url);
    let outcome = run_once(&fx.db, &rpc, &cfg()).await.unwrap();
    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    stub.shutdown();
}

/// (tvl_cap, per_deposit_cap) of the newest snapshot of `vault`, as decimal strings.
async fn caps(fx: &common::PgFixture, vault: Address) -> (Option<String>, Option<String>) {
    sqlx::query_as(
        "SELECT tvl_cap::text, per_deposit_cap::text FROM vault_snapshots \
         WHERE chain_id = $1 AND contract = $2 ORDER BY block_number DESC LIMIT 1",
    )
    .bind(CHAIN)
    .bind(vault.as_slice())
    .fetch_one(fx.db.pool())
    .await
    .expect("a snapshot row exists")
}

#[tokio::test]
async fn a_robot_money_vault_snapshot_stores_its_real_tvl_cap_and_per_deposit_cap() {
    let fx = pg_fixture().await;
    let vault = Address::from([0x33u8; 20]);
    fx.db.upsert_chain(CHAIN, "base", "stub").await.unwrap();
    register(&fx, vault, "Robot Money USDC").await;
    run(
        &fx,
        HashMap::from([(
            vault,
            FakeVault {
                total_assets: 1_000_045,
                tvl_cap: Some(U256::from(1_000 * USDC)),
                per_deposit_cap: Some(U256::from(100 * USDC)),
            },
        )]),
    )
    .await;
    assert_eq!(
        caps(&fx, vault).await,
        (Some("1000000000".into()), Some("100000000".into()))
    );
}

#[tokio::test]
async fn a_basket_vault_snapshot_stores_its_own_caps_not_another_vaults() {
    let fx = pg_fixture().await;
    let agent_tokens = Address::from([0x44u8; 20]);
    let protocol = Address::from([0x55u8; 20]);
    fx.db.upsert_chain(CHAIN, "base", "stub").await.unwrap();
    register(&fx, agent_tokens, "Robot Money Agent Tokens").await;
    register(&fx, protocol, "Robot Money Protocol").await;
    run(
        &fx,
        HashMap::from([
            (
                agent_tokens,
                FakeVault {
                    total_assets: 0,
                    tvl_cap: Some(U256::from(100 * USDC)),
                    per_deposit_cap: Some(U256::from(15 * USDC)),
                },
            ),
            (
                protocol,
                FakeVault {
                    total_assets: 0,
                    tvl_cap: Some(U256::from(1_000 * USDC)),
                    per_deposit_cap: Some(U256::from(100 * USDC)),
                },
            ),
        ]),
    )
    .await;
    assert_eq!(
        caps(&fx, agent_tokens).await,
        (Some("100000000".into()), Some("15000000".into()))
    );
    assert_eq!(
        caps(&fx, protocol).await,
        (Some("1000000000".into()), Some("100000000".into()))
    );
}

#[tokio::test]
async fn a_cap_read_that_fails_is_null_never_zero_and_a_real_zero_stays_zero() {
    let fx = pg_fixture().await;
    let tvl_fails = Address::from([0x66u8; 20]);
    let per_fails = Address::from([0x77u8; 20]);
    let wound_down = Address::from([0x88u8; 20]);
    fx.db.upsert_chain(CHAIN, "base", "stub").await.unwrap();
    register(&fx, tvl_fails, "Robot Money RWA").await;
    register(&fx, per_fails, "Robot Money Protocol").await;
    register(&fx, wound_down, "Robot Money USDC").await;
    run(
        &fx,
        HashMap::from([
            (
                tvl_fails,
                FakeVault {
                    total_assets: 5,
                    tvl_cap: None,
                    per_deposit_cap: Some(U256::from(100 * USDC)),
                },
            ),
            (
                per_fails,
                FakeVault {
                    total_assets: 5,
                    tvl_cap: Some(U256::from(1_000 * USDC)),
                    per_deposit_cap: None,
                },
            ),
            // `shutdown()` on RobotMoneyVault sets tvlCap to 0: a real zero, which is NOT unknown.
            (
                wound_down,
                FakeVault {
                    total_assets: 5,
                    tvl_cap: Some(U256::ZERO),
                    per_deposit_cap: Some(U256::ZERO),
                },
            ),
        ]),
    )
    .await;
    assert_eq!(
        caps(&fx, tvl_fails).await,
        (None, Some("100000000".into())),
        "a failed tvlCap() read is NULL, not 0"
    );
    assert_eq!(
        caps(&fx, per_fails).await,
        (Some("1000000000".into()), None),
        "a failed perDepositCap() read is NULL, not 0"
    );
    assert_eq!(
        caps(&fx, wound_down).await,
        (Some("0".into()), Some("0".into())),
        "a cap the chain really reports as 0 stays 0"
    );
}

#[test]
fn the_cap_selectors_are_the_public_getter_selectors_of_both_vault_families() {
    // `uint256 public tvlCap` / `perDepositCap` compile to these selectors in RobotMoneyVault.sol and BasketVault.sol.
    assert_eq!(sel::<IVaultReads::tvlCapCall>(), "3f23fa1a");
    assert_eq!(sel::<IVaultReads::perDepositCapCall>(), "90569cd5");
}

#[tokio::test]
async fn a_snapshot_with_unknown_caps_is_retaken_on_the_next_tick_not_after_the_heartbeat() {
    let fx = pg_fixture().await;
    let vault = Address::from([0x99u8; 20]);
    fx.db.upsert_chain(CHAIN, "base", "stub").await.unwrap();
    register(&fx, vault, "Robot Money USDC").await;
    // A row from before migration 0018: non-zero TVL (so the zero-TVL rule does not fire), one block old (so the
    // heartbeat does not fire), caps unknown.
    fx.db
        .insert_vault_snapshot(
            CHAIN,
            vault.into_array(),
            11,
            U256::from(1_000_045u64),
            U256::from(1_000_045u64),
            0,
            None,
            None,
            false,
        )
        .await
        .unwrap();
    run(
        &fx,
        HashMap::from([(
            vault,
            FakeVault {
                total_assets: 1_000_045,
                tvl_cap: Some(U256::from(1_000 * USDC)),
                per_deposit_cap: Some(U256::from(100 * USDC)),
            },
        )]),
    )
    .await;
    assert_eq!(
        caps(&fx, vault).await,
        (Some("1000000000".into()), Some("100000000".into())),
        "the newest snapshot carries the real caps"
    );
}
