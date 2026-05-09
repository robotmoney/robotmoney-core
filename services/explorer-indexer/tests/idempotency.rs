//! §11 acceptance criterion: re-indexing the same range must produce
//! zero net inserts. We exercise the `Db` upsert helpers directly with
//! a synthetic event row, run the same insert twice, and assert the
//! second call returns 0 rows_affected (ON CONFLICT DO NOTHING).

mod common;

use alloy_primitives::U256;
use common::try_pg_fixture;
use explorer_indexer::db::CountTable;

#[tokio::test]
async fn agent_deposit_insert_is_idempotent() {
    let Some(fx) = try_pg_fixture().await else {
        return;
    };
    fx.db.upsert_chain(8453, "base", "test").await.unwrap();
    let gateway = [0xaau8; 20];
    fx.db
        .upsert_contract(8453, gateway, "gateway", None)
        .await
        .unwrap();
    fx.db
        .insert_block(8453, 100, [0x11u8; 32], [0x10u8; 32], 1_700_000_000)
        .await
        .unwrap();

    let first = fx
        .db
        .insert_agent_deposit(
            8453,
            100,
            7,
            [0x22u8; 32],
            [0x33u8; 32],
            [0x44u8; 32],
            [0x55u8; 20],
            [0x66u8; 20],
            U256::from(1_000_000u64),
            U256::from(1_000_000u64),
            42,
        )
        .await
        .unwrap();
    assert_eq!(first, 1, "first insert lands");

    let second = fx
        .db
        .insert_agent_deposit(
            8453,
            100,
            7,
            [0x22u8; 32],
            [0x33u8; 32],
            [0x44u8; 32],
            [0x55u8; 20],
            [0x66u8; 20],
            U256::from(1_000_000u64),
            U256::from(1_000_000u64),
            42,
        )
        .await
        .unwrap();
    assert_eq!(second, 0, "second insert is a no-op");

    assert_eq!(fx.db.count(CountTable::AgentDeposits).await.unwrap(), 1);
}

#[tokio::test]
async fn vault_snapshot_insert_is_idempotent() {
    let Some(fx) = try_pg_fixture().await else {
        return;
    };
    fx.db.upsert_chain(8453, "base", "test").await.unwrap();
    let vault = [0xbbu8; 20];
    fx.db
        .upsert_contract(8453, vault, "vault", None)
        .await
        .unwrap();
    let first = fx
        .db
        .insert_vault_snapshot(
            8453,
            vault,
            999,
            U256::from(1_234_567u64),
            U256::from(1_000_000u64),
            50,
            U256::from(10u64).pow(U256::from(18u64)),
            false,
        )
        .await
        .unwrap();
    assert_eq!(first, 1);
    let second = fx
        .db
        .insert_vault_snapshot(
            8453,
            vault,
            999,
            U256::from(1_234_567u64),
            U256::from(1_000_000u64),
            50,
            U256::from(10u64).pow(U256::from(18u64)),
            false,
        )
        .await
        .unwrap();
    assert_eq!(second, 0);
}
