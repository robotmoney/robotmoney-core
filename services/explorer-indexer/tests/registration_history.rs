//! Canonical: docs/architecture.md §5.2 (ACL-9), docs/technical/explorer-schema-decisions.md §3.4
//! Implements: core issue 1891 (RS-1019-18) — agent identity is (address, registration).
//!
//! Gateway events are fed to `handle_log` in (block, log index) order, the order a tick uses, and the
//! rows they write are read back from Postgres. A registration is identified by the position of the
//! event that started it (migration 0031).
//!
//! - `a_revoke_then_another_owner_registers_keeps_both_registrations`: A, setPolicy, revoke, B.
//! - `an_expiry_then_another_owner_registers_without_a_revoke`: an old deployment re-registers an
//!   expired address without a revoke.
//! - `a_revoke_then_the_same_owner_registers_again`: A, revoke, A again is two registrations.
//! - `same_block_events_are_assigned_in_log_index_order`: revoke, authorize and deposit in one block
//!   and in one transaction.
//! - `deployments_and_chains_never_share_a_registration`: two gateways, two chains.
//! - `ingesting_twice_changes_nothing`: event counts and keys are stable.
//! - `rollback_and_replay_equal_a_clean_canonical_replay`: orphaned policy, deposit, revoke and
//!   re-registration blocks are rolled back and replayed.
//! - `a_historical_transfer_keeps_the_old_owner_attribution`: old deployments only.
//! - `insufficient_history_fabricates_no_ownership`: a deposit or a transfer with nothing indexed
//!   before it gets no registration it cannot prove.
//!
//! Like every test behind `pg_fixture()`, these fail loudly when Docker is absent.

mod common;

use alloy_primitives::{Address, Bytes, FixedBytes, B256, U256};
use alloy_sol_types::SolEvent;
use common::pg_fixture;
use explorer_indexer::abi::{IGatewayEvents, Topics};
use explorer_indexer::indexer::{handle_log, IndexerConfig};
use explorer_indexer::rpc::LogEntry;
use explorer_indexer::Db;

const CHAIN: i64 = 8453;
const OTHER_CHAIN: i64 = 1;

fn addr(b: u8) -> Address {
    Address::from([b; 20])
}

fn gw1() -> Address {
    addr(0x11)
}
fn gw2() -> Address {
    addr(0x12)
}
fn agent() -> Address {
    addr(0xA0)
}
fn owner_a() -> Address {
    addr(0xA1)
}
fn owner_b() -> Address {
    addr(0xB1)
}

fn cfg(chain_id: i64, gateway: Address) -> IndexerConfig {
    IndexerConfig {
        chain_id,
        chain_name: "base".into(),
        rpc_label: "stub".into(),
        gateway: Some(gateway),
        vault: addr(0x22),
        registry: None,
        router_governance: None,
        portfolio_router: None,
        consensus_receipt: None,
        timelock: None,
        safe: None,
        max_blocks_per_tick: 100,
        start_block: None,
        end_block: None,
        feature_flags: 0,
    }
}

/// One gateway log at (block, log index), emitted by `gateway`.
fn log<E: SolEvent>(event: E, gateway: Address, block: u64, log_index: u32) -> LogEntry {
    let data = event.encode_log_data();
    LogEntry {
        address: gateway,
        topics: data.topics().to_vec(),
        data: Bytes::copy_from_slice(data.data.as_ref()),
        block_number: block,
        block_hash: B256::from([block as u8; 32]),
        tx_hash: B256::from([(block as u8).wrapping_add(log_index as u8); 32]),
        tx_index: 0,
        log_index,
    }
}

fn authorize(
    gateway: Address,
    owner: Address,
    valid_until: u64,
    block: u64,
    log_index: u32,
) -> LogEntry {
    log(
        IGatewayEvents::AgentAuthorized {
            agent: agent(),
            owner,
            validUntil: valid_until,
            maxPerPayment: U256::from(5_000_000u64),
            maxPerWindow: U256::from(50_000_000u64),
            shareReceiver: owner,
        },
        gateway,
        block,
        log_index,
    )
}

fn revoke(gateway: Address, owner: Address, block: u64, log_index: u32) -> LogEntry {
    log(
        IGatewayEvents::AgentRevoked {
            agent: agent(),
            owner,
        },
        gateway,
        block,
        log_index,
    )
}

fn deposit(gateway: Address, payment: u8, block: u64, log_index: u32) -> LogEntry {
    log(
        IGatewayEvents::AgentDeposit {
            paymentId: FixedBytes([payment; 32]),
            orderId: FixedBytes([payment; 32]),
            agent: agent(),
            shareReceiver: addr(0x55),
            amount: U256::from(1_000_000u64),
            sharesMinted: U256::from(1_000_000u64),
            windowId: 1,
        },
        gateway,
        block,
        log_index,
    )
}

fn transfer(gateway: Address, from: Address, to: Address, block: u64, log_index: u32) -> LogEntry {
    log(
        IGatewayEvents::AgentOwnershipTransferred {
            agent: agent(),
            previousOwner: from,
            newOwner: to,
        },
        gateway,
        block,
        log_index,
    )
}

/// Block `n` with timestamp `1000 * n`, so a `validUntil` is read against a known clock.
async fn blocks(db: &Db, chain: i64, numbers: &[i64]) {
    db.upsert_chain(chain, "chain", "stub").await.unwrap();
    for n in numbers {
        db.insert_block(chain, *n, [*n as u8; 32], [0u8; 32], 1000 * n)
            .await
            .unwrap();
    }
}

async fn feed(db: &Db, chain: i64, gateway: Address, logs: &[LogEntry]) {
    let topics = Topics::new();
    let cfg = cfg(chain, gateway);
    for l in logs {
        handle_log(db, &cfg, &topics, l).await.unwrap();
    }
}

type PolicyRowT = (
    i64,
    Option<Vec<u8>>,
    i64,
    i32,
    Option<String>,
    Option<Vec<u8>>,
    Option<i64>,
    Option<i32>,
);
type DepositRowT = (i64, Option<Vec<u8>>, i64, i32, Option<i64>, Option<i32>);

/// `(chain, gateway, block, log, kind, owner, registration_block, registration_log_index)` of every
/// policy row, in event order, as strings so two snapshots compare with one `assert_eq!`.
async fn policy_rows(db: &Db) -> Vec<String> {
    let rows: Vec<PolicyRowT> = sqlx::query_as(
        "SELECT chain_id, gateway, block_number, log_index, event_kind, owner, \
                    registration_block, registration_log_index \
             FROM agent_policies ORDER BY chain_id, gateway, block_number, log_index",
    )
    .fetch_all(db.pool())
    .await
    .unwrap();
    rows.into_iter()
        .map(|(c, g, b, l, k, o, rb, rl)| {
            format!(
                "policy chain={c} gw={} at={b}/{l} kind={} owner={} reg={rb:?}/{rl:?}",
                g.map(hex::encode).unwrap_or_default(),
                k.unwrap_or_default(),
                o.map(hex::encode).unwrap_or_default(),
            )
        })
        .collect()
}

async fn deposit_rows(db: &Db) -> Vec<String> {
    let rows: Vec<DepositRowT> = sqlx::query_as(
        "SELECT chain_id, gateway, block_number, log_index, registration_block, \
                registration_log_index \
         FROM agent_deposits ORDER BY chain_id, gateway, block_number, log_index",
    )
    .fetch_all(db.pool())
    .await
    .unwrap();
    rows.into_iter()
        .map(|(c, g, b, l, rb, rl)| {
            format!(
                "deposit chain={c} gw={} at={b}/{l} reg={rb:?}/{rl:?}",
                g.map(hex::encode).unwrap_or_default()
            )
        })
        .collect()
}

async fn snapshot(db: &Db) -> Vec<String> {
    let mut s = policy_rows(db).await;
    s.extend(deposit_rows(db).await);
    s
}

/// `(registration_block, registration_log_index)` of the policy row at (block, log).
async fn reg_of_policy(
    db: &Db,
    chain: i64,
    block: i64,
    log_index: i32,
) -> (Option<i64>, Option<i32>) {
    sqlx::query_as(
        "SELECT registration_block, registration_log_index FROM agent_policies \
         WHERE chain_id = $1 AND block_number = $2 AND log_index = $3",
    )
    .bind(chain)
    .bind(block)
    .bind(log_index)
    .fetch_one(db.pool())
    .await
    .unwrap()
}

async fn reg_of_deposit(
    db: &Db,
    chain: i64,
    block: i64,
    log_index: i32,
) -> (Option<i64>, Option<i32>) {
    sqlx::query_as(
        "SELECT registration_block, registration_log_index FROM agent_deposits \
         WHERE chain_id = $1 AND block_number = $2 AND log_index = $3",
    )
    .bind(chain)
    .bind(block)
    .bind(log_index)
    .fetch_one(db.pool())
    .await
    .unwrap()
}

fn some(b: i64, l: i32) -> (Option<i64>, Option<i32>) {
    (Some(b), Some(l))
}

#[tokio::test]
async fn a_revoke_then_another_owner_registers_keeps_both_registrations() {
    let fx = pg_fixture().await;
    let db = &fx.db;
    blocks(db, CHAIN, &[100, 101, 102, 103, 104]).await;

    feed(
        db,
        CHAIN,
        gw1(),
        &[
            authorize(gw1(), owner_a(), 4_000_000, 100, 0),
            deposit(gw1(), 1, 100, 1),
            // setPolicy: the same owner authorizes again inside the registration.
            authorize(gw1(), owner_a(), 5_000_000, 101, 0),
            deposit(gw1(), 2, 101, 1),
            revoke(gw1(), owner_a(), 102, 0),
            authorize(gw1(), owner_b(), 9_000_000, 103, 0),
            deposit(gw1(), 3, 104, 0),
        ],
    )
    .await;

    // A's registration starts at 100/0 and the setPolicy keeps its id.
    assert_eq!(reg_of_policy(db, CHAIN, 100, 0).await, some(100, 0));
    assert_eq!(
        reg_of_policy(db, CHAIN, 101, 0).await,
        some(100, 0),
        "setPolicy must stay inside its registration"
    );
    // The revoke closes it as evidence of that registration.
    assert_eq!(reg_of_policy(db, CHAIN, 102, 0).await, some(100, 0));
    // B starts a new, distinct registration; A's rows are untouched.
    assert_eq!(reg_of_policy(db, CHAIN, 103, 0).await, some(103, 0));
    // Each deposit belongs to the registration live at its position.
    assert_eq!(reg_of_deposit(db, CHAIN, 100, 1).await, some(100, 0));
    assert_eq!(reg_of_deposit(db, CHAIN, 101, 1).await, some(100, 0));
    assert_eq!(reg_of_deposit(db, CHAIN, 104, 0).await, some(103, 0));

    let owners: Vec<(i64, Vec<u8>, String)> = sqlx::query_as(
        "SELECT block_number, owner, event_kind FROM agent_policies ORDER BY block_number",
    )
    .fetch_all(db.pool())
    .await
    .unwrap();
    assert_eq!(owners[0].1, owner_a().to_vec());
    assert_eq!(owners[2].2, "revoked");
    assert_eq!(
        owners[3].1,
        owner_b().to_vec(),
        "B's row names B, A's rows still name A"
    );
}

#[tokio::test]
async fn an_expiry_then_another_owner_registers_without_a_revoke() {
    let fx = pg_fixture().await;
    let db = &fx.db;
    // Block n has timestamp 1000 * n. A's authorization expires at 150_000, before block 200.
    blocks(db, CHAIN, &[100, 120, 200, 201]).await;

    feed(
        db,
        CHAIN,
        gw1(),
        &[
            authorize(gw1(), owner_a(), 150_000, 100, 0),
            // Still live at block 120 (120_000 < 150_000): the same registration.
            authorize(gw1(), owner_a(), 150_000, 120, 0),
            // Expired at block 200 (200_000 > 150_000): B's authorization is a new registration.
            authorize(gw1(), owner_b(), 900_000, 200, 0),
            // And A authorizing yet again after B is a third one.
            revoke(gw1(), owner_b(), 201, 0),
            authorize(gw1(), owner_a(), 950_000, 201, 1),
        ],
    )
    .await;

    assert_eq!(reg_of_policy(db, CHAIN, 100, 0).await, some(100, 0));
    assert_eq!(reg_of_policy(db, CHAIN, 120, 0).await, some(100, 0));
    assert_eq!(reg_of_policy(db, CHAIN, 200, 0).await, some(200, 0));
    assert_eq!(reg_of_policy(db, CHAIN, 201, 0).await, some(200, 0));
    assert_eq!(reg_of_policy(db, CHAIN, 201, 1).await, some(201, 1));
}

#[tokio::test]
async fn a_revoke_then_the_same_owner_registers_again() {
    let fx = pg_fixture().await;
    let db = &fx.db;
    blocks(db, CHAIN, &[100, 110, 120]).await;

    feed(
        db,
        CHAIN,
        gw1(),
        &[
            authorize(gw1(), owner_a(), 900_000, 100, 0),
            deposit(gw1(), 1, 100, 1),
            revoke(gw1(), owner_a(), 110, 0),
            authorize(gw1(), owner_a(), 900_000, 120, 0),
            deposit(gw1(), 2, 120, 1),
        ],
    )
    .await;

    assert_eq!(reg_of_policy(db, CHAIN, 100, 0).await, some(100, 0));
    assert_eq!(reg_of_policy(db, CHAIN, 120, 0).await, some(120, 0));
    assert_eq!(reg_of_deposit(db, CHAIN, 100, 1).await, some(100, 0));
    assert_eq!(
        reg_of_deposit(db, CHAIN, 120, 1).await,
        some(120, 0),
        "a re-registration by the same owner does not take over the earlier deposits"
    );
}

#[tokio::test]
async fn same_block_events_are_assigned_in_log_index_order() {
    let fx = pg_fixture().await;
    let db = &fx.db;
    blocks(db, CHAIN, &[100, 300]).await;

    // One block, one transaction: a deposit by A's registration, A is revoked, B registers, and B's
    // registration takes a deposit. Log index decides which registration each event belongs to.
    feed(
        db,
        CHAIN,
        gw1(),
        &[
            authorize(gw1(), owner_a(), 900_000, 100, 0),
            deposit(gw1(), 1, 300, 0),
            revoke(gw1(), owner_a(), 300, 1),
            authorize(gw1(), owner_b(), 900_000, 300, 2),
            deposit(gw1(), 2, 300, 3),
        ],
    )
    .await;

    assert_eq!(reg_of_deposit(db, CHAIN, 300, 0).await, some(100, 0));
    assert_eq!(reg_of_policy(db, CHAIN, 300, 1).await, some(100, 0));
    assert_eq!(reg_of_policy(db, CHAIN, 300, 2).await, some(300, 2));
    assert_eq!(reg_of_deposit(db, CHAIN, 300, 3).await, some(300, 2));
}

#[tokio::test]
async fn deployments_and_chains_never_share_a_registration() {
    let fx = pg_fixture().await;
    let db = &fx.db;
    blocks(db, CHAIN, &[100, 101]).await;
    blocks(db, OTHER_CHAIN, &[100, 101]).await;

    // The same agent address, the same block and log positions, on two gateways and two chains.
    feed(
        db,
        CHAIN,
        gw1(),
        &[authorize(gw1(), owner_a(), 900_000, 100, 0)],
    )
    .await;
    feed(
        db,
        CHAIN,
        gw2(),
        &[authorize(gw2(), owner_b(), 900_000, 100, 1)],
    )
    .await;
    feed(
        db,
        OTHER_CHAIN,
        gw1(),
        &[authorize(gw1(), owner_b(), 900_000, 100, 0)],
    )
    .await;
    // A revoke on gateway 2 closes only gateway 2's registration.
    feed(db, CHAIN, gw2(), &[revoke(gw2(), owner_b(), 101, 0)]).await;
    // A deposit on each gateway joins its own gateway's registration.
    feed(db, CHAIN, gw1(), &[deposit(gw1(), 1, 101, 1)]).await;
    feed(db, CHAIN, gw2(), &[deposit(gw2(), 2, 101, 2)]).await;

    assert_eq!(reg_of_policy(db, CHAIN, 100, 0).await, some(100, 0));
    assert_eq!(reg_of_policy(db, CHAIN, 100, 1).await, some(100, 1));
    assert_eq!(reg_of_policy(db, OTHER_CHAIN, 100, 0).await, some(100, 0));
    assert_eq!(reg_of_deposit(db, CHAIN, 101, 1).await, some(100, 0));
    assert_eq!(
        reg_of_deposit(db, CHAIN, 101, 2).await,
        (None, None),
        "gateway 2's registration was revoked, and gateway 1's registration is not its evidence"
    );
    let gateways: Vec<(i64, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT DISTINCT chain_id, gateway FROM agent_policies ORDER BY chain_id, gateway",
    )
    .fetch_all(db.pool())
    .await
    .unwrap();
    assert_eq!(gateways.len(), 3, "{gateways:?}");
}

#[tokio::test]
async fn ingesting_twice_changes_nothing() {
    let fx = pg_fixture().await;
    let db = &fx.db;
    blocks(db, CHAIN, &[100, 101, 102]).await;
    let logs = vec![
        authorize(gw1(), owner_a(), 900_000, 100, 0),
        deposit(gw1(), 1, 100, 1),
        revoke(gw1(), owner_a(), 101, 0),
        authorize(gw1(), owner_b(), 900_000, 102, 0),
    ];
    feed(db, CHAIN, gw1(), &logs).await;
    let first = snapshot(db).await;
    assert_eq!(
        first.len(),
        4,
        "three policy rows and one deposit: {first:?}"
    );
    feed(db, CHAIN, gw1(), &logs).await;
    assert_eq!(
        snapshot(db).await,
        first,
        "a second pass must change nothing"
    );
}

/// The canonical history used by the rollback test: blocks 100..=106.
fn canonical(gw: Address) -> Vec<LogEntry> {
    vec![
        authorize(gw, owner_a(), 900_000, 100, 0),
        deposit(gw, 1, 101, 0),
        revoke(gw, owner_a(), 103, 0),
        authorize(gw, owner_b(), 900_000, 104, 0),
        deposit(gw, 2, 105, 0),
        authorize(gw, owner_b(), 950_000, 106, 0),
    ]
}

#[tokio::test]
async fn rollback_and_replay_equal_a_clean_canonical_replay() {
    let clean = pg_fixture().await;
    blocks(&clean.db, CHAIN, &[100, 101, 103, 104, 105, 106]).await;
    feed(&clean.db, CHAIN, gw1(), &canonical(gw1())).await;
    let expected = snapshot(&clean.db).await;
    assert_eq!(expected.len(), 6);

    // The same database first indexes a FORK of blocks 103..=106: A is not revoked there, the policy
    // is updated, and a deposit lands. The canonical chain then replaces it below block 103.
    let fx = pg_fixture().await;
    let db = &fx.db;
    blocks(db, CHAIN, &[100, 101, 103, 104, 105, 106]).await;
    let mut fork = canonical(gw1());
    fork.truncate(2);
    fork.extend([
        authorize(gw1(), owner_a(), 960_000, 103, 0),
        deposit(gw1(), 9, 104, 0),
        revoke(gw1(), owner_a(), 105, 0),
        authorize(gw1(), owner_a(), 970_000, 106, 0),
    ]);
    feed(db, CHAIN, gw1(), &fork).await;
    assert_ne!(
        snapshot(db).await,
        expected,
        "the fork must differ from the canonical history"
    );

    // Orphan policy, deposit, revoke and re-registration blocks, then replay the canonical chain.
    db.delete_above_block(CHAIN, 102).await.unwrap();
    assert_eq!(
        snapshot(db).await.len(),
        2,
        "only the rows at or below the root survive: {:?}",
        snapshot(db).await
    );
    let canonical_tail: Vec<LogEntry> = canonical(gw1())
        .into_iter()
        .filter(|l| l.block_number > 102)
        .collect();
    // The rollback deleted the orphaned blocks with their rows. The replay reads their headers again.
    blocks(db, CHAIN, &[103, 104, 105, 106]).await;
    feed(db, CHAIN, gw1(), &canonical_tail).await;

    assert_eq!(
        snapshot(db).await,
        expected,
        "a rolled-back and replayed index must equal a clean canonical replay"
    );
}

#[tokio::test]
async fn a_historical_transfer_keeps_the_old_owner_attribution() {
    let fx = pg_fixture().await;
    let db = &fx.db;
    blocks(db, CHAIN, &[100, 110, 120]).await;

    feed(
        db,
        CHAIN,
        gw1(),
        &[
            authorize(gw1(), owner_a(), 900_000, 100, 0),
            deposit(gw1(), 1, 100, 1),
            // An old deployment: ownership moves to B inside the registration.
            transfer(gw1(), owner_a(), owner_b(), 110, 0),
            deposit(gw1(), 2, 120, 0),
        ],
    )
    .await;

    let rows: Vec<(i64, Vec<u8>, String, Option<i64>)> = sqlx::query_as(
        "SELECT block_number, owner, event_kind, registration_block FROM agent_policies \
         ORDER BY block_number",
    )
    .fetch_all(db.pool())
    .await
    .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].1, owner_a().to_vec(), "the old row keeps its owner");
    assert_eq!(rows[1].1, owner_b().to_vec());
    assert_eq!(rows[1].2, "transferred");
    assert_eq!(
        rows[1].3,
        Some(100),
        "a transfer stays inside the registration"
    );
    assert_eq!(reg_of_deposit(db, CHAIN, 100, 1).await, some(100, 0));
    assert_eq!(reg_of_deposit(db, CHAIN, 120, 0).await, some(100, 0));
}

#[tokio::test]
async fn insufficient_history_fabricates_no_ownership() {
    let fx = pg_fixture().await;
    let db = &fx.db;
    blocks(db, CHAIN, &[100, 110, 120]).await;

    feed(
        db,
        CHAIN,
        gw1(),
        &[
            // The index starts after the agent's registration: a deposit with nothing before it.
            deposit(gw1(), 1, 100, 0),
            // A transfer with no earlier row copies no policy and names only what the event says.
            transfer(gw1(), owner_a(), owner_b(), 110, 0),
        ],
    )
    .await;

    assert_eq!(
        reg_of_deposit(db, CHAIN, 100, 0).await,
        (None, None),
        "a deposit with no indexed registration must not be given one"
    );
    let row: (Vec<u8>, Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT owner, valid_until, registration_block FROM agent_policies WHERE block_number = 110",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(row.0, owner_b().to_vec());
    assert_eq!(row.1, None, "no policy field is invented");
    assert_eq!(
        row.2,
        Some(110),
        "the transfer starts a registration of its own evidence"
    );
}
