//! Canonical: docs/architecture.md §4.9 — Consensus Recommendation Receipt Contract
//! Implements: issue #1247 — consensus receipt event indexing acceptance tests.
//!
//! Five cases, modelled on `tests/committee_indexing.rs` (hand-encoded logs
//! served by a `StubRpcServer`):
//!   1. A `ReceiptRecorded` log creates a `consensus_receipts` row with the
//!      right digest / submitter / uri / index.
//!   2. Digest verification is TRUE when the served payload hashes to
//!      `payloadDigest`.
//!   3. Digest verification is FALSE on a hash mismatch — and the row still
//!      exists. A receipt is never dropped silently: an unverifiable
//!      commitment must be visible as unverified, not absent.
//!   4. A `ReceiptReleased` log flips `released` / `released_at` on the
//!      existing row.
//!   5. A reorg at the safe head rewrites receipt rows: rows above the fork
//!      root are DELETED by `Db::delete_above_block`, rows at/below survive,
//!      and a release that landed above the root is rolled back in place.
//!
//! These tests do **not** skip when Docker is unavailable: the shared
//! `pg_fixture` panics, naming the missing dependency. That is the convention
//! (issue #1377) — a test that returns early because its fixture handed it
//! `None` still reports as passed, so an absent dependency must red the job.
//! The doc that used to stand here claimed the opposite and invited a
//! maintainer to "restore" an `Option`-returning fixture, which would make
//! every PG-backed indexer test green on a runner without Docker.

mod common;

use alloy_primitives::{Address, FixedBytes, LogData, U256};
use alloy_sol_types::SolEvent as _;
use common::{pg_fixture, StubRpcServer};
use explorer_indexer::{
    abi::IConsensusRecommendationReceiptEvents,
    db::{CountTable, ReceiptVerification},
    indexer::{run_once, IndexerConfig},
    rpc::JsonRpc,
};
use std::net::SocketAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const CHAIN: i64 = 8453;

/// Every column of a `consensus_receipts` row, in SELECT order:
/// receipt_id, receipt_index, submitter, payload_digest, payload_uri,
/// recorded_at, block_number, log_index, tx_hash, verified, payload_bytes,
/// released, released_at.
type FullReceiptRow = (
    Vec<u8>,
    i64,
    Vec<u8>,
    Vec<u8>,
    String,
    i64,
    i64,
    i32,
    Vec<u8>,
    bool,
    Option<i64>,
    bool,
    Option<i64>,
);

// ─── helpers ─────────────────────────────────────────────────────────────────

fn receipt_addr() -> Address {
    Address::from([0xC7u8; 20])
}
fn gateway_addr() -> Address {
    Address::from([0x11u8; 20])
}
fn vault_addr() -> Address {
    Address::from([0x22u8; 20])
}
fn submitter_addr() -> Address {
    Address::from([0x5Au8; 20])
}
fn timelock_addr() -> Address {
    Address::from([0x7Bu8; 20])
}

/// A successful digest verification, as the indexer would produce it.
fn verified_now(bytes: i64) -> ReceiptVerification {
    ReceiptVerification {
        verified: true,
        payload_bytes: Some(bytes),
        attempts: 1,
        last_error: None,
    }
}

fn stub_block(number: u64, hash_byte: u8, parent_byte: u8) -> serde_json::Value {
    serde_json::json!({
        "number":     format!("0x{:x}", number),
        "hash":       format!("0x{}", hex::encode([hash_byte; 32])),
        "parentHash": format!("0x{}", hex::encode([parent_byte; 32])),
        "timestamp":  "0x65000000",
        "transactions": []
    })
}

fn log_json(
    address: Address,
    log_data: &LogData,
    block_number: u64,
    block_hash_byte: u8,
    tx_hash: [u8; 32],
    log_index: u32,
) -> serde_json::Value {
    let topics: Vec<String> = log_data
        .topics()
        .iter()
        .map(|t| format!("{t:#x}"))
        .collect();
    serde_json::json!({
        "address":          format!("{address:#x}"),
        "topics":           topics,
        "data":             format!("0x{}", hex::encode(log_data.data.as_ref())),
        "blockNumber":      format!("0x{block_number:x}"),
        "blockHash":        format!("0x{}", hex::encode([block_hash_byte; 32])),
        "transactionHash":  format!("0x{}", hex::encode(tx_hash)),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{log_index:x}"),
    })
}

#[allow(clippy::too_many_arguments)]
fn encode_receipt_recorded_log(
    contract: Address,
    receipt_id: [u8; 32],
    submitter: Address,
    index: u64,
    payload_digest: [u8; 32],
    payload_uri: &str,
    recorded_at: u64,
    block_number: u64,
    tx_hash: [u8; 32],
    log_index: u32,
) -> serde_json::Value {
    let event = IConsensusRecommendationReceiptEvents::ReceiptRecorded {
        receiptId: FixedBytes(receipt_id),
        submitter,
        index: U256::from(index),
        payloadDigest: FixedBytes(payload_digest),
        payloadUri: payload_uri.to_string(),
        recordedAt: recorded_at,
    };
    log_json(
        contract,
        &event.encode_log_data(),
        block_number,
        0xcc,
        tx_hash,
        log_index,
    )
}

fn encode_receipt_released_log(
    contract: Address,
    receipt_id: [u8; 32],
    released_by: Address,
    released_at: u64,
    block_number: u64,
    tx_hash: [u8; 32],
    log_index: u32,
) -> serde_json::Value {
    let event = IConsensusRecommendationReceiptEvents::ReceiptReleased {
        receiptId: FixedBytes(receipt_id),
        releasedBy: released_by,
        releasedAt: released_at,
    };
    log_json(
        contract,
        &event.encode_log_data(),
        block_number,
        0xdd,
        tx_hash,
        log_index,
    )
}

fn base_cfg(end_block: u64) -> IndexerConfig {
    IndexerConfig {
        chain_id: CHAIN,
        chain_name: "base".to_string(),
        rpc_label: "stub".to_string(),
        gateway: Some(gateway_addr()),
        vault: vault_addr(),
        registry: None,
        router_governance: None,
        portfolio_router: None,
        consensus_receipt: Some(receipt_addr()),
        timelock: None,
        safe: None,
        max_blocks_per_tick: 100,
        start_block: None,
        end_block: Some(end_block),
        feature_flags: 0,
    }
}

/// Program the stub for a single-tick run that indexes up to `block`.
/// `eth_blockNumber` is set well above `block + CONFIRMATIONS`.
fn program_stub(stub: &StubRpcServer, block: u64, hash_byte: u8, parent_byte: u8) {
    stub.set(
        "eth_blockNumber",
        serde_json::json!(format!("0x{:x}", block + 10)),
    );
    stub.set(
        "eth_getBlockByNumber",
        stub_block(block, hash_byte, parent_byte),
    );
    // eth_call backs the vault heartbeat snapshot (totalAssets / totalSupply).
    stub.set(
        "eth_call",
        serde_json::Value::String(format!("0x{}", "00".repeat(32))),
    );
}

/// A tiny HTTP server that serves a fixed body on any request — stands in for
/// the `payloadUri` route serving the receipt's canonical bytes.
struct PayloadServer {
    pub url: String,
    _shutdown: tokio::sync::oneshot::Sender<()>,
}

impl PayloadServer {
    async fn start(body: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        let url = format!("http://{addr}/api/swarm/receipts/session-1");
        let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut rx => break,
                    accept = listener.accept() => {
                        let Ok((mut stream, _)) = accept else { continue };
                        let body = body.clone();
                        tokio::spawn(async move {
                            let mut buf = [0u8; 4096];
                            let _ = stream.read(&mut buf).await;
                            let response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\n\r\n",
                                body.len()
                            );
                            let _ = stream.write_all(response.as_bytes()).await;
                            let _ = stream.write_all(&body).await;
                        });
                    }
                }
            }
        });
        PayloadServer { url, _shutdown: tx }
    }
}

/// The canonical preimage shape pinned by
/// `tests/fixtures/consensus-receipt.canonicalization.json`: the domain tag,
/// the compact JSON, and a trailing newline. The exact JSON does not matter to
/// the indexer — only that keccak256(served bytes) == payloadDigest.
fn canonical_payload() -> Vec<u8> {
    let mut v = b"robotmoney:consensus-receipt:v1\n".to_vec();
    v.extend_from_slice(br#"{"session_id":"session-1","subject_id":"vault-a"}"#);
    v.push(b'\n');
    v
}

// ─── AC-1 / AC-2: ReceiptRecorded creates a verified row ─────────────────────

#[tokio::test]
async fn receipt_recorded_creates_row_with_digest_verified() {
    let fx = pg_fixture().await;

    let payload = canonical_payload();
    let digest = alloy_primitives::keccak256(&payload);
    let srv = PayloadServer::start(payload.clone()).await;

    let receipt_id = [0x9au8; 32];
    let tx: [u8; 32] = [0x01; 32];
    let rec_log = encode_receipt_recorded_log(
        receipt_addr(),
        receipt_id,
        submitter_addr(),
        7,
        digest.0,
        &srv.url,
        1_700_000_000,
        10,
        tx,
        3,
    );

    let stub = StubRpcServer::start().await;
    program_stub(&stub, 10, 0xaa, 0x00);
    stub.set("eth_getLogs", serde_json::json!([rec_log]));

    let rpc = JsonRpc::new(&stub.url);
    let outcome = run_once(&fx.db, &rpc, &base_cfg(10)).await.unwrap();
    assert!(
        outcome.error.is_none(),
        "indexer error: {:?}",
        outcome.error
    );

    assert_eq!(
        fx.db.count(CountTable::ConsensusReceipts).await.unwrap(),
        1,
        "expected 1 consensus_receipts row"
    );

    let row: FullReceiptRow = sqlx::query_as(
        "SELECT receipt_id, receipt_index, submitter, payload_digest, payload_uri, \
                recorded_at, block_number, log_index, tx_hash, verified, payload_bytes, \
                released, released_at \
         FROM consensus_receipts WHERE chain_id = $1",
    )
    .bind(CHAIN)
    .fetch_one(fx.db.pool())
    .await
    .unwrap();

    assert_eq!(row.0, receipt_id.to_vec(), "receipt_id mismatch");
    assert_eq!(row.1, 7, "receipt_index mismatch");
    assert_eq!(row.2, submitter_addr().as_slice(), "submitter mismatch");
    assert_eq!(row.3, digest.0.to_vec(), "payload_digest mismatch");
    assert_eq!(row.4, srv.url, "payload_uri mismatch");
    assert_eq!(row.5, 1_700_000_000, "recorded_at mismatch");
    assert_eq!(row.6, 10, "block_number mismatch");
    assert_eq!(row.7, 3, "log_index mismatch");
    assert_eq!(row.8, tx.to_vec(), "tx_hash mismatch");
    assert!(
        row.9,
        "verified must be true — the served body hashes to payload_digest"
    );
    assert_eq!(
        row.10,
        Some(payload.len() as i64),
        "payload_bytes must record the fetched body length"
    );
    assert!(!row.11, "a freshly recorded receipt must not be released");
    assert_eq!(row.12, None, "released_at must be NULL before release");
}

// --- AC-CORE-07 / AC-E2E-02: the published URL serves an ENVELOPE ------------

/// THE URL THAT GETS ANCHORED DOES NOT SERVE THE BYTES THAT GET ANCHORED.
///
/// robotmoney-frontend's public, read-time-verifying route answers
/// `{sessionId, subjectId, schemaVersion, publishedAt, receipt, canonicalBytes,
///   verified, signatures, unverifiedReasons}`. The anchored `payloadDigest` is
/// keccak256 of the CANONICAL BYTES of the `receipt` field, which is not
/// keccak256 of the served body. `rmpc` was taught to unwrap that envelope at
/// af878e46 so it could verify before submitting; the indexer was not, so it
/// recomputed keccak256 over the envelope, missed, and stored
/// `verified = false` -- permanently, because verification happens once on the
/// first scan of `ReceiptRecorded` and is never retried.
///
/// This test serves the real envelope shape around the repo's own committed
/// `consensus-receipt.valid.json` and anchors that receipt's canonical digest.
/// Without the canonicalizing fallback in `fetch_and_verify_payload` it fails on
/// the final assertion with `verified = false`.
#[tokio::test]
async fn receipt_recorded_verifies_when_the_url_serves_the_frontend_envelope() {
    let fx = pg_fixture().await;

    let fixture_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/consensus-receipt.valid.json"
    );
    let receipt_json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixture_path).unwrap()).unwrap();

    // The digest is derived from the RECEIPT, exactly as the submitter derives it.
    let canonical =
        rust_payment_client::consensus_receipt::ConsensusReceipt::canonical_bytes_from_json_slice(
            &serde_json::to_vec(&receipt_json).unwrap(),
        )
        .expect("the committed valid fixture must canonicalize");
    let digest = alloy_primitives::keccak256(&canonical);

    // The envelope the public route actually serves.
    let envelope = serde_json::json!({
        "sessionId": receipt_json["session_id"],
        "subjectId": receipt_json["subject_id"],
        "schemaVersion": receipt_json["schema_version"],
        "publishedAt": "2026-09-14T00:00:00.000Z",
        "receipt": receipt_json,
        "canonicalBytes": String::from_utf8(canonical.clone()).unwrap(),
        "verified": true,
        "signatures": [],
        "unverifiedReasons": [],
    });
    let served = serde_json::to_vec(&envelope).unwrap();

    // The defect this test exists for: the served body is NOT the preimage.
    assert_ne!(
        alloy_primitives::keccak256(&served).0,
        digest.0,
        "the envelope must not hash to the anchored digest, or this test proves nothing"
    );

    let srv = PayloadServer::start(served.clone()).await;

    let receipt_id = [0x9fu8; 32];
    let tx: [u8; 32] = [0x0f; 32];
    let rec_log = encode_receipt_recorded_log(
        receipt_addr(),
        receipt_id,
        submitter_addr(),
        0,
        digest.0,
        &srv.url,
        1_700_000_500,
        10,
        tx,
        0,
    );

    let stub = StubRpcServer::start().await;
    program_stub(&stub, 10, 0xaa, 0x00);
    stub.set("eth_getLogs", serde_json::json!([rec_log]));

    let rpc = JsonRpc::new(&stub.url);
    let outcome = run_once(&fx.db, &rpc, &base_cfg(10)).await.unwrap();
    assert!(
        outcome.error.is_none(),
        "indexer error: {:?}",
        outcome.error
    );

    let (verified, bytes): (bool, Option<i64>) = sqlx::query_as(
        "SELECT verified, payload_bytes FROM consensus_receipts \
         WHERE chain_id = $1 AND receipt_id = $2",
    )
    .bind(CHAIN)
    .bind(&receipt_id[..])
    .fetch_one(fx.db.pool())
    .await
    .unwrap();

    assert!(
        verified,
        "the indexer must re-derive the canonical bytes from the envelope's receipt \
         and reproduce the anchored digest"
    );
    assert_eq!(
        bytes,
        Some(served.len() as i64),
        "payload_bytes records the fetched body length, envelope included"
    );
}

/// The fallback must not become a blanket pass: a body that parses as a receipt
/// but canonicalizes to something else is still unverified.
#[tokio::test]
async fn receipt_recorded_envelope_with_the_wrong_receipt_stays_unverified() {
    let fx = pg_fixture().await;

    let fixture_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/consensus-receipt.valid.json"
    );
    let mut receipt_json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixture_path).unwrap()).unwrap();
    let honest =
        rust_payment_client::consensus_receipt::ConsensusReceipt::canonical_bytes_from_json_slice(
            &serde_json::to_vec(&receipt_json).unwrap(),
        )
        .unwrap();
    let anchored = alloy_primitives::keccak256(&honest);

    // One field changed after the digest was anchored.
    receipt_json["judge"]["rationale"] =
        serde_json::Value::String("a different opinion entirely".to_string());
    let envelope = serde_json::json!({ "receipt": receipt_json });
    let srv = PayloadServer::start(serde_json::to_vec(&envelope).unwrap()).await;

    let receipt_id = [0x9eu8; 32];
    let rec_log = encode_receipt_recorded_log(
        receipt_addr(),
        receipt_id,
        submitter_addr(),
        0,
        anchored.0,
        &srv.url,
        1_700_000_600,
        10,
        [0x0e; 32],
        0,
    );

    let stub = StubRpcServer::start().await;
    program_stub(&stub, 10, 0xaa, 0x00);
    stub.set("eth_getLogs", serde_json::json!([rec_log]));

    let rpc = JsonRpc::new(&stub.url);
    run_once(&fx.db, &rpc, &base_cfg(10)).await.unwrap();

    let (verified,): (bool,) = sqlx::query_as(
        "SELECT verified FROM consensus_receipts WHERE chain_id = $1 AND receipt_id = $2",
    )
    .bind(CHAIN)
    .bind(&receipt_id[..])
    .fetch_one(fx.db.pool())
    .await
    .unwrap();

    assert!(
        !verified,
        "a tampered receipt inside a well-formed envelope must stay unverified"
    );
}

// ─── AC-3: digest mismatch stores the row with verified = false ──────────────

#[tokio::test]
async fn receipt_recorded_digest_mismatch_stores_unverified_row() {
    let fx = pg_fixture().await;

    // The URI serves bytes that do NOT hash to the on-chain digest.
    let served = b"{\"tampered\":true}".to_vec();
    let wrong_digest = [0xdeu8; 32];
    assert_ne!(alloy_primitives::keccak256(&served).0, wrong_digest);
    let srv = PayloadServer::start(served).await;

    let receipt_id = [0x9bu8; 32];
    let tx: [u8; 32] = [0x02; 32];
    let rec_log = encode_receipt_recorded_log(
        receipt_addr(),
        receipt_id,
        submitter_addr(),
        0,
        wrong_digest,
        &srv.url,
        1_700_000_100,
        10,
        tx,
        0,
    );

    let stub = StubRpcServer::start().await;
    program_stub(&stub, 10, 0xaa, 0x00);
    stub.set("eth_getLogs", serde_json::json!([rec_log]));

    let rpc = JsonRpc::new(&stub.url);
    let outcome = run_once(&fx.db, &rpc, &base_cfg(10)).await.unwrap();
    assert!(
        outcome.error.is_none(),
        "a digest mismatch must not fail the tick: {:?}",
        outcome.error
    );

    // The row must STILL EXIST — a receipt is never dropped silently.
    assert_eq!(
        fx.db.count(CountTable::ConsensusReceipts).await.unwrap(),
        1,
        "an unverifiable receipt must still be stored, not dropped"
    );

    let (verified, digest, uri): (bool, Vec<u8>, String) = sqlx::query_as(
        "SELECT verified, payload_digest, payload_uri FROM consensus_receipts \
         WHERE chain_id = $1 AND receipt_id = $2",
    )
    .bind(CHAIN)
    .bind(&receipt_id[..])
    .fetch_one(fx.db.pool())
    .await
    .unwrap();

    assert!(!verified, "verified must be false on a digest mismatch");
    assert_eq!(
        digest,
        wrong_digest.to_vec(),
        "the on-chain commitment is still recorded verbatim"
    );
    assert_eq!(uri, srv.url, "payload_uri is still recorded verbatim");
}

/// An unreachable `payloadUri` is non-fatal: the commitment row is stored with
/// `verified = false` and a NULL `payload_bytes`.
#[tokio::test]
async fn receipt_recorded_unreachable_uri_stores_unverified_row() {
    let fx = pg_fixture().await;

    // Port 1 on loopback: nothing listens, so the GET fails fast.
    let dead_uri = "http://127.0.0.1:1/api/swarm/receipts/session-dead";
    let receipt_id = [0x9cu8; 32];
    let rec_log = encode_receipt_recorded_log(
        receipt_addr(),
        receipt_id,
        submitter_addr(),
        1,
        [0xefu8; 32],
        dead_uri,
        1_700_000_200,
        10,
        [0x03; 32],
        0,
    );

    let stub = StubRpcServer::start().await;
    program_stub(&stub, 10, 0xaa, 0x00);
    stub.set("eth_getLogs", serde_json::json!([rec_log]));

    let rpc = JsonRpc::new(&stub.url);
    let outcome = run_once(&fx.db, &rpc, &base_cfg(10)).await.unwrap();
    assert!(
        outcome.error.is_none(),
        "a payload fetch failure must be non-fatal: {:?}",
        outcome.error
    );

    let (verified, payload_bytes): (bool, Option<i64>) = sqlx::query_as(
        "SELECT verified, payload_bytes FROM consensus_receipts \
         WHERE chain_id = $1 AND receipt_id = $2",
    )
    .bind(CHAIN)
    .bind(&receipt_id[..])
    .fetch_one(fx.db.pool())
    .await
    .unwrap();

    assert!(
        !verified,
        "an unfetchable payload must leave verified=false"
    );
    assert_eq!(
        payload_bytes, None,
        "payload_bytes must be NULL when the fetch failed"
    );
}

// ─── AC-4: ReceiptReleased flips the existing row ────────────────────────────

#[tokio::test]
async fn receipt_released_flips_released_columns() {
    let fx = pg_fixture().await;

    let payload = canonical_payload();
    let digest = alloy_primitives::keccak256(&payload);
    let srv = PayloadServer::start(payload).await;

    let receipt_id = [0x9du8; 32];
    let rec_log = encode_receipt_recorded_log(
        receipt_addr(),
        receipt_id,
        submitter_addr(),
        0,
        digest.0,
        &srv.url,
        1_700_000_000,
        9,
        [0x04; 32],
        0,
    );
    let rel_log = encode_receipt_released_log(
        receipt_addr(),
        receipt_id,
        timelock_addr(),
        1_700_000_500,
        10,
        [0x05; 32],
        1,
    );

    let stub = StubRpcServer::start().await;
    program_stub(&stub, 10, 0xaa, 0x00);
    stub.set("eth_getLogs", serde_json::json!([rec_log, rel_log]));

    let rpc = JsonRpc::new(&stub.url);
    let outcome = run_once(&fx.db, &rpc, &base_cfg(10)).await.unwrap();
    assert!(
        outcome.error.is_none(),
        "indexer error: {:?}",
        outcome.error
    );

    // Release is an in-place flip, not a second row.
    assert_eq!(
        fx.db.count(CountTable::ConsensusReceipts).await.unwrap(),
        1,
        "ReceiptReleased must update the existing row, not append one"
    );

    let (released, released_at, released_block, released_by): (
        bool,
        Option<i64>,
        Option<i64>,
        Option<Vec<u8>>,
    ) = sqlx::query_as(
        "SELECT released, released_at, released_block_number, released_by \
         FROM consensus_receipts WHERE chain_id = $1 AND receipt_id = $2",
    )
    .bind(CHAIN)
    .bind(&receipt_id[..])
    .fetch_one(fx.db.pool())
    .await
    .unwrap();

    assert!(released, "released must be true after ReceiptReleased");
    assert_eq!(released_at, Some(1_700_000_500), "released_at mismatch");
    assert_eq!(
        released_block,
        Some(10),
        "released_block_number must record the release block for reorg rollback"
    );
    assert_eq!(
        released_by.as_deref(),
        Some(timelock_addr().as_slice()),
        "released_by must record the ADMIN_ROLE caller"
    );
}

// ─── AC-5: a reorg at the safe head rewrites receipt rows ────────────────────

/// Explicit acceptance criterion: `consensus_receipts` must be rolled back by
/// `Db::delete_above_block`, the reorg rewrite. Rows above the fork root are
/// deleted; rows at/below it survive. This test exercises the real
/// `delete_above_block` path (the same function `run_inner` calls on a reorg),
/// so a future edit that drops `consensus_receipts` from that table list turns
/// this test RED.
#[tokio::test]
async fn reorg_rollback_deletes_receipts_above_root_and_keeps_the_rest() {
    let fx = pg_fixture().await;
    let db = &fx.db;
    db.upsert_chain(CHAIN, "base", "stub").await.unwrap();

    // Three receipts: block 100 (below root), 100 is the fork root, and blocks
    // 101 / 102 above it.
    for (i, (id_byte, block)) in [(0xa1u8, 99i64), (0xa2u8, 100), (0xa3u8, 101), (0xa4u8, 102)]
        .into_iter()
        .enumerate()
    {
        db.insert_consensus_receipt(
            CHAIN,
            receipt_addr().into_array(),
            [id_byte; 32],
            i as i64,
            submitter_addr().into_array(),
            [0xd0u8; 32],
            "https://example.invalid/api/swarm/receipts/s",
            1_700_000_000 + block,
            block,
            0,
            [id_byte; 32],
            verified_now(64),
        )
        .await
        .unwrap();
    }
    assert_eq!(db.count(CountTable::ConsensusReceipts).await.unwrap(), 4);

    // The block-99 receipt was released at block 102 — above the fork root, so
    // the in-place release must be rolled back even though the row survives.
    db.mark_consensus_receipt_released(
        CHAIN,
        receipt_addr().into_array(),
        [0xa1u8; 32],
        timelock_addr().into_array(),
        1_700_000_102,
        102,
    )
    .await
    .unwrap();

    // ── The reorg rewrite. Fork root = 100. ──
    db.delete_above_block(CHAIN, 100).await.unwrap();

    // Rows above the root are gone.
    assert_eq!(
        db.count(CountTable::ConsensusReceipts).await.unwrap(),
        2,
        "receipts recorded above the fork root must be deleted by the reorg rewrite"
    );
    let surviving: Vec<(Vec<u8>, i64)> = sqlx::query_as(
        "SELECT receipt_id, block_number FROM consensus_receipts \
         WHERE chain_id = $1 ORDER BY block_number",
    )
    .bind(CHAIN)
    .fetch_all(db.pool())
    .await
    .unwrap();
    assert_eq!(
        surviving,
        vec![([0xa1u8; 32].to_vec(), 99), ([0xa2u8; 32].to_vec(), 100)],
        "exactly the receipts at/below the fork root must survive"
    );

    // The release that landed above the root is rolled back in place — the row
    // itself is never deleted (an unreleased receipt stays a public record).
    let (released, released_at, released_block): (bool, Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT released, released_at, released_block_number FROM consensus_receipts \
         WHERE chain_id = $1 AND receipt_id = $2",
    )
    .bind(CHAIN)
    .bind(&[0xa1u8; 32][..])
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert!(
        !released,
        "a release recorded above the fork root must be un-released by the rewrite"
    );
    assert_eq!(released_at, None);
    assert_eq!(released_block, None);

    // Re-indexing the same range after the rollback is a no-op for a row that
    // survived (ON CONFLICT DO NOTHING), so recovery never duplicates receipts.
    let again = db
        .insert_consensus_receipt(
            CHAIN,
            receipt_addr().into_array(),
            [0xa2u8; 32],
            1,
            submitter_addr().into_array(),
            [0xd0u8; 32],
            "https://example.invalid/api/swarm/receipts/s",
            1_700_000_100,
            100,
            0,
            [0xa2u8; 32],
            verified_now(64),
        )
        .await
        .unwrap();
    assert_eq!(again, 0, "re-inserting a surviving receipt must be a no-op");
    assert_eq!(db.count(CountTable::ConsensusReceipts).await.unwrap(), 2);
}

/// End-to-end reorg through `run_once`: tick 1 indexes a receipt at the safe
/// head; tick 2 sees a different hash at the cursor height, walks back, and the
/// rollback removes the receipt. Re-indexing then re-inserts it idempotently.
#[tokio::test]
async fn run_once_reorg_at_safe_head_rewrites_receipt_rows() {
    let fx = pg_fixture().await;

    let payload = canonical_payload();
    let digest = alloy_primitives::keccak256(&payload);
    let srv = PayloadServer::start(payload).await;
    let receipt_id = [0xbeu8; 32];

    let rec_log = |block: u64| {
        encode_receipt_recorded_log(
            receipt_addr(),
            receipt_id,
            submitter_addr(),
            0,
            digest.0,
            &srv.url,
            1_700_000_000,
            block,
            [0x06; 32],
            0,
        )
    };

    // ── Tick 1: index block 10 (hash 0xaa…) carrying the receipt. ──
    let pre = StubRpcServer::start().await;
    program_stub(&pre, 10, 0xaa, 0x00);
    pre.set("eth_getLogs", serde_json::json!([rec_log(10)]));
    let o1 = run_once(&fx.db, &JsonRpc::new(&pre.url), &base_cfg(10))
        .await
        .unwrap();
    assert!(o1.error.is_none(), "tick 1 must succeed: {:?}", o1.error);
    assert_eq!(o1.last_indexed_block, Some(10));
    assert_eq!(
        fx.db.count(CountTable::ConsensusReceipts).await.unwrap(),
        1,
        "tick 1 must have indexed the receipt"
    );
    pre.shutdown();

    // ── Tick 2: block 10 now hashes differently → reorg → rollback. ──
    // `walk_back_to_match` finds no matching stored hash below 10 (only block 10
    // was persisted), so root = -1 and every block-numbered row is wiped.
    let post = StubRpcServer::start().await;
    program_stub(&post, 10, 0xee, 0x00);
    post.set("eth_getLogs", serde_json::Value::Array(Vec::new()));
    let o2 = run_once(&fx.db, &JsonRpc::new(&post.url), &base_cfg(10))
        .await
        .unwrap();
    assert!(o2.error.is_none(), "tick 2 must succeed: {:?}", o2.error);
    assert!(o2.reorg_detected, "tick 2 must detect the reorg");
    assert_eq!(
        fx.db.count(CountTable::ConsensusReceipts).await.unwrap(),
        0,
        "the reorg rewrite must delete the orphaned receipt — \
         consensus_receipts is in delete_above_block's table list"
    );
    // The rolled-back block is gone from `blocks` too, confirming the rewrite
    // ran the full cascade rather than only touching the receipt table.
    assert_eq!(
        fx.db.get_block_hash(CHAIN, 10).await.unwrap(),
        Some([0xeeu8; 32]),
        "block 10 must be re-persisted at its canonical hash after the rewrite"
    );
    post.shutdown();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Fusion round-2 code review — T20 (contract-scoped key, log.address gate)
//                              T12 (bounded retry, repairable row)
// ═══════════════════════════════════════════════════════════════════════════════

/// A payload server that answers 502 until it is told to serve the body.
///
/// Stands in for the real failure T12 exists for: a frontend redeploy makes the
/// `payloadUri` route 502 for a few seconds, and the receipt is anchored in that
/// window.
struct FlakyPayloadServer {
    pub url: String,
    healthy: std::sync::Arc<std::sync::atomic::AtomicBool>,
    _shutdown: tokio::sync::oneshot::Sender<()>,
}

impl FlakyPayloadServer {
    async fn start(body: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        let url = format!("http://{addr}/api/swarm/receipts/session-flaky");
        let healthy = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = healthy.clone();
        let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut rx => break,
                    accept = listener.accept() => {
                        let Ok((mut stream, _)) = accept else { continue };
                        let body = body.clone();
                        let flag = flag.clone();
                        tokio::spawn(async move {
                            let mut buf = [0u8; 4096];
                            let _ = stream.read(&mut buf).await;
                            if flag.load(std::sync::atomic::Ordering::SeqCst) {
                                let head = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\n\r\n",
                                    body.len()
                                );
                                let _ = stream.write_all(head.as_bytes()).await;
                                let _ = stream.write_all(&body).await;
                            } else {
                                let _ = stream
                                    .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                                    .await;
                            }
                        });
                    }
                }
            }
        });
        FlakyPayloadServer {
            url,
            healthy,
            _shutdown: tx,
        }
    }

    fn recover(&self) {
        self.healthy
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// T12 — THE REGRESSION THIS TASK EXISTS FOR.
///
/// Before the fix: verification was one 10 s GET with no retry, every error was
/// swallowed into `(false, None)`, no code path anywhere ever updated
/// `verified`, and the insert ended `ON CONFLICT … DO NOTHING`. So a transient
/// 502 pinned an authentic, correctly-signed receipt at `verified = false` for
/// the LIFE OF THE DATABASE, and the only remedy was wiping the explorer
/// database — which also wipes the watchdog's deliberately un-resettable
/// cold-start baseline `MIN(indexer_runs.started_at)`, so the remedy pages.
///
/// After the fix: the row converges WITHOUT A DELETE, via the re-verification
/// sweep, on a later tick.
#[tokio::test]
async fn unfetchable_payload_is_repaired_to_verified_on_a_later_tick() {
    let fx = pg_fixture().await;

    let payload = canonical_payload();
    let digest = alloy_primitives::keccak256(&payload);
    let srv = FlakyPayloadServer::start(payload.clone()).await;

    let receipt_id = [0x71u8; 32];
    let rec_log = encode_receipt_recorded_log(
        receipt_addr(),
        receipt_id,
        submitter_addr(),
        0,
        digest.0,
        &srv.url,
        1_700_000_700,
        10,
        [0x71; 32],
        0,
    );

    let stub = StubRpcServer::start().await;
    program_stub(&stub, 10, 0xaa, 0x00);
    stub.set("eth_getLogs", serde_json::json!([rec_log]));
    let rpc = JsonRpc::new(&stub.url);

    // ── Tick 1: the payload host is down. ──
    let o = run_once(&fx.db, &rpc, &base_cfg(10)).await.unwrap();
    assert!(o.error.is_none(), "tick 1 error: {:?}", o.error);
    assert_eq!(
        fx.db.count(CountTable::ConsensusReceipts).await.unwrap(),
        1,
        "the commitment row is stored even when the payload host is down"
    );

    let (verified, attempts, last_error): (bool, i32, Option<String>) = sqlx::query_as(
        "SELECT verified, verify_attempts, last_verify_error FROM consensus_receipts \
         WHERE chain_id = $1 AND receipt_id = $2",
    )
    .bind(CHAIN)
    .bind(&receipt_id[..])
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert!(!verified, "a 502 must leave the row unverified");
    assert!(
        attempts >= 3,
        "the fetch must be BOUNDED-RETRY, not single-shot: got {attempts} attempt(s)"
    );
    assert!(
        last_error.is_some_and(|e| e.contains("502")),
        "the row must record WHY it is unverified, so `verified = false` is not \
         mistaken for evidence of forgery during a compromise investigation"
    );

    // ── The host comes back. ──
    srv.recover();

    // ── Tick 2: the SAME chain state (no reorg), no new logs. Nothing about
    //    the chain can repair this row — only the re-verification sweep can. ──
    stub.set("eth_getLogs", serde_json::json!([]));
    let o = run_once(&fx.db, &rpc, &base_cfg(10)).await.unwrap();
    assert!(o.error.is_none(), "tick 2 error: {:?}", o.error);
    assert!(
        !o.reorg_detected,
        "tick 2 must not reorg — the repair has to come from the sweep"
    );

    let (verified, verified_at, bytes): (bool, Option<chrono::DateTime<chrono::Utc>>, Option<i64>) =
        sqlx::query_as(
            "SELECT verified, verified_at, payload_bytes FROM consensus_receipts \
             WHERE chain_id = $1 AND receipt_id = $2",
        )
        .bind(CHAIN)
        .bind(&receipt_id[..])
        .fetch_one(fx.db.pool())
        .await
        .unwrap();

    assert!(
        verified,
        "the re-verification sweep must repair the row once the payload is reachable"
    );
    assert!(
        verified_at.is_some(),
        "verified_at must be stamped on repair"
    );
    assert_eq!(
        bytes,
        Some(payload.len() as i64),
        "the repaired row must record the fetched body length"
    );
    assert_eq!(
        fx.db.count(CountTable::ConsensusReceipts).await.unwrap(),
        1,
        "the repair must happen IN PLACE — no delete, no duplicate row"
    );
}

/// T12 — a repair must never run backwards.
///
/// A verified row is authentic: the indexer itself recomputed keccak256 of the
/// preimage and matched the on-chain digest. A later fetch failure says
/// something about the payload HOST, never about the commitment, so it must not
/// be able to flip the public flag back to false.
#[tokio::test]
async fn replay_and_sweep_never_downgrade_a_verified_receipt() {
    let fx = pg_fixture().await;
    let db = &fx.db;
    db.upsert_chain(CHAIN, "base", "stub").await.unwrap();

    let receipt_id = [0x72u8; 32];
    db.insert_consensus_receipt(
        CHAIN,
        receipt_addr().into_array(),
        receipt_id,
        0,
        submitter_addr().into_array(),
        [0xd0u8; 32],
        "https://example.invalid/api/swarm/receipts/s",
        1_700_000_000,
        10,
        0,
        [0x72u8; 32],
        verified_now(64),
    )
    .await
    .unwrap();

    // A replay whose fetch failed.
    let failed = ReceiptVerification {
        verified: false,
        payload_bytes: None,
        attempts: 3,
        last_error: Some("GET … returned 502".to_string()),
    };
    db.insert_consensus_receipt(
        CHAIN,
        receipt_addr().into_array(),
        receipt_id,
        0,
        submitter_addr().into_array(),
        [0xd0u8; 32],
        "https://example.invalid/api/swarm/receipts/s",
        1_700_000_000,
        10,
        0,
        [0x72u8; 32],
        failed,
    )
    .await
    .unwrap();

    // And a direct sweep repair reporting failure.
    db.repair_receipt_verification(
        CHAIN,
        receipt_addr().as_slice(),
        &receipt_id[..],
        false,
        None,
        Some("GET … returned 502"),
    )
    .await
    .unwrap();

    let (verified, bytes): (bool, Option<i64>) = sqlx::query_as(
        "SELECT verified, payload_bytes FROM consensus_receipts \
         WHERE chain_id = $1 AND receipt_id = $2",
    )
    .bind(CHAIN)
    .bind(&receipt_id[..])
    .fetch_one(db.pool())
    .await
    .unwrap();

    assert!(
        verified,
        "a failed replay or sweep must NEVER downgrade an already-verified receipt"
    );
    assert_eq!(
        bytes,
        Some(64),
        "the recorded payload length must survive a failed replay too"
    );
    assert_eq!(
        db.count(CountTable::ConsensusReceipts).await.unwrap(),
        1,
        "duplicate delivery of the same receipt writes exactly one row"
    );

    // The sweep must not pick this row up again at all.
    let pending = db.list_unverified_receipts(CHAIN, 12, 16).await.unwrap();
    assert!(
        pending.is_empty(),
        "a verified receipt must leave the sweep's working set"
    );
}

/// T12 — the sweep must TERMINATE.
///
/// A receipt whose payload host is permanently gone must stop being re-fetched,
/// or the indexer turns into an unbounded outbound request loop against a dead
/// host for the life of the database.
#[tokio::test]
async fn the_sweep_gives_up_after_the_attempt_ceiling() {
    let fx = pg_fixture().await;
    let db = &fx.db;
    db.upsert_chain(CHAIN, "base", "stub").await.unwrap();

    db.insert_consensus_receipt(
        CHAIN,
        receipt_addr().into_array(),
        [0x73u8; 32],
        0,
        submitter_addr().into_array(),
        [0xd0u8; 32],
        "https://example.invalid/api/swarm/receipts/s",
        1_700_000_000,
        10,
        0,
        [0x73u8; 32],
        ReceiptVerification {
            verified: false,
            payload_bytes: None,
            attempts: 3,
            last_error: Some("GET … returned 502".to_string()),
        },
    )
    .await
    .unwrap();

    assert_eq!(
        db.list_unverified_receipts(CHAIN, 12, 16)
            .await
            .unwrap()
            .len(),
        1,
        "an unverified receipt below the ceiling is in the sweep's working set"
    );
    assert!(
        db.list_unverified_receipts(CHAIN, 3, 16)
            .await
            .unwrap()
            .is_empty(),
        "a receipt at the attempt ceiling must leave the working set"
    );
}

/// T20 — TWO DEPLOYMENTS ON ONE CHAIN MUST NOT COLLIDE.
///
/// `receipt_id = keccak256(domain || session_id || "\n" || subject_id)` is
/// byte-identical across every deployment of ConsensusRecommendationReceipt, and
/// devnet 918453 already carries two live ones. Under the old
/// `(chain_id, receipt_id)` key with `ON CONFLICT DO NOTHING`, re-anchoring the
/// same session+subject against a redeployed contract was SILENTLY DISCARDED and
/// the explorer kept serving the superseded contract's digest, uri, verified and
/// released state for ever. `delete_above_block` cannot repair that — nothing was
/// written above a reorg root.
#[tokio::test]
async fn two_receipt_contracts_on_one_chain_keep_separate_rows() {
    let fx = pg_fixture().await;
    let db = &fx.db;
    db.upsert_chain(CHAIN, "base", "stub").await.unwrap();

    // The SAME receipt id, anchored by two different deployments, with
    // different digests — the redeploy-and-re-anchor case.
    let receipt_id = [0x74u8; 32];
    let old_contract = Address::from([0xC7u8; 20]);
    let new_contract = Address::from([0xC8u8; 20]);

    for (contract, digest_byte, block) in
        [(old_contract, 0xd0u8, 10i64), (new_contract, 0xd1u8, 20i64)]
    {
        db.insert_consensus_receipt(
            CHAIN,
            contract.into_array(),
            receipt_id,
            0,
            submitter_addr().into_array(),
            [digest_byte; 32],
            "https://example.invalid/api/swarm/receipts/s",
            1_700_000_000 + block,
            block,
            0,
            [digest_byte; 32],
            verified_now(64),
        )
        .await
        .unwrap();
    }

    assert_eq!(
        db.count(CountTable::ConsensusReceipts).await.unwrap(),
        2,
        "the re-anchored commitment must NOT be discarded: the emitting contract \
         is part of the key"
    );

    let rows: Vec<(Vec<u8>, Vec<u8>)> = sqlx::query_as(
        "SELECT contract_address, payload_digest FROM consensus_receipts \
         WHERE chain_id = $1 AND receipt_id = $2 ORDER BY block_number",
    )
    .bind(CHAIN)
    .bind(&receipt_id[..])
    .fetch_all(db.pool())
    .await
    .unwrap();
    assert_eq!(rows[0].0, old_contract.as_slice());
    assert_eq!(rows[0].1, vec![0xd0u8; 32]);
    assert_eq!(rows[1].0, new_contract.as_slice());
    assert_eq!(
        rows[1].1,
        vec![0xd1u8; 32],
        "each deployment keeps its own digest"
    );

    // A release emitted by the NEW contract must flip only the NEW row.
    let flipped = db
        .mark_consensus_receipt_released(
            CHAIN,
            new_contract.into_array(),
            receipt_id,
            timelock_addr().into_array(),
            1_700_000_030,
            21,
        )
        .await
        .unwrap();
    assert_eq!(flipped, 1, "exactly one row may be released");

    let released: Vec<(Vec<u8>, bool)> = sqlx::query_as(
        "SELECT contract_address, released FROM consensus_receipts \
         WHERE chain_id = $1 AND receipt_id = $2 ORDER BY block_number",
    )
    .bind(CHAIN)
    .bind(&receipt_id[..])
    .fetch_all(db.pool())
    .await
    .unwrap();
    assert!(
        !released[0].1,
        "the superseded deployment's row must NOT be released by the new \
         deployment's ReceiptReleased"
    );
    assert!(released[1].1, "the emitting deployment's row is released");
}

/// T20 — `handle_log` must gate on `log.address`.
///
/// Dispatch is on `topic0` alone, over a watched-address set that also carries
/// the gateway, the vaults, the registry, the router, governance and the IC
/// policy. A `ReceiptRecorded`-shaped event from any of those used to be written
/// straight into the receipt register as though the receipt contract had emitted
/// it.
#[tokio::test]
async fn receipt_shaped_log_from_an_unconfigured_contract_is_ignored() {
    let fx = pg_fixture().await;

    let payload = canonical_payload();
    let digest = alloy_primitives::keccak256(&payload);
    let srv = PayloadServer::start(payload).await;

    // Emitted by the GATEWAY, which is watched but is not the receipt contract.
    let impostor = encode_receipt_recorded_log(
        gateway_addr(),
        [0x75u8; 32],
        submitter_addr(),
        0,
        digest.0,
        &srv.url,
        1_700_000_800,
        10,
        [0x75; 32],
        0,
    );
    // And a genuine one from the configured contract, in the same batch, so the
    // test also proves the gate is not a blanket refusal.
    let genuine = encode_receipt_recorded_log(
        receipt_addr(),
        [0x76u8; 32],
        submitter_addr(),
        1,
        digest.0,
        &srv.url,
        1_700_000_801,
        10,
        [0x76; 32],
        1,
    );

    let stub = StubRpcServer::start().await;
    program_stub(&stub, 10, 0xaa, 0x00);
    stub.set("eth_getLogs", serde_json::json!([impostor, genuine]));

    let rpc = JsonRpc::new(&stub.url);
    let outcome = run_once(&fx.db, &rpc, &base_cfg(10)).await.unwrap();
    assert!(
        outcome.error.is_none(),
        "an impostor log must be ignored, not fatal: {:?}",
        outcome.error
    );

    let ids: Vec<(Vec<u8>, Vec<u8>)> =
        sqlx::query_as("SELECT contract_address, receipt_id FROM consensus_receipts")
            .fetch_all(fx.db.pool())
            .await
            .unwrap();
    assert_eq!(
        ids.len(),
        1,
        "only the configured ConsensusRecommendationReceipt deployment may write \
         the receipt register; got {ids:?}"
    );
    assert_eq!(ids[0].0, receipt_addr().as_slice());
    assert_eq!(ids[0].1, vec![0x76u8; 32]);
}

/// T20 — a `ReceiptReleased` from an unconfigured contract must not flip a row.
#[tokio::test]
async fn release_from_an_unconfigured_contract_cannot_flip_a_receipt() {
    let fx = pg_fixture().await;
    let db = &fx.db;
    db.upsert_chain(CHAIN, "base", "stub").await.unwrap();

    let receipt_id = [0x77u8; 32];
    db.insert_consensus_receipt(
        CHAIN,
        receipt_addr().into_array(),
        receipt_id,
        0,
        submitter_addr().into_array(),
        [0xd0u8; 32],
        "",
        1_700_000_000,
        5,
        0,
        [0x77u8; 32],
        verified_now(64),
    )
    .await
    .unwrap();

    let impostor_release = encode_receipt_released_log(
        gateway_addr(),
        receipt_id,
        timelock_addr(),
        1_700_000_900,
        10,
        [0x78; 32],
        0,
    );

    let stub = StubRpcServer::start().await;
    program_stub(&stub, 10, 0xaa, 0x00);
    stub.set("eth_getLogs", serde_json::json!([impostor_release]));

    let rpc = JsonRpc::new(&stub.url);
    run_once(db, &JsonRpc::new(&stub.url), &base_cfg(10))
        .await
        .unwrap();
    drop(rpc);

    let (released,): (bool,) = sqlx::query_as(
        "SELECT released FROM consensus_receipts WHERE chain_id = $1 AND receipt_id = $2",
    )
    .bind(CHAIN)
    .bind(&receipt_id[..])
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert!(
        !released,
        "a ReceiptReleased emitted by a contract that is not the configured \
         receipt contract must not release anything"
    );
}

// ─── Security round 1: on-chain URI fetch guard ───────────────────────────────
//
// A receipt's `payloadUri` (and a vote's `rationaleUri`) is chosen on chain, and the indexer
// fetches it from its own network position. It must not reach the cloud metadata endpoint or any
// other link-local, unspecified, broadcast or multicast address, or a non-HTTP scheme, and it must
// never buffer a body past the 1 MiB cap. Each refused URI fails before any connection, and the
// oversized bodies come from a loopback thread, so these need no Docker.

use explorer_indexer::indexer::{fetch_payload_once, is_forbidden_fetch_ip, SWEEP_TIME_BUDGET};

/// The indexer's body cap (`MAX_FETCH_BODY` in `indexer.rs`).
const MAX_FETCH_BODY_BYTES: usize = 1024 * 1024;

#[tokio::test]
async fn fetch_payload_once_refuses_metadata_link_local_and_other_schemes() {
    for uri in [
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        "https://169.254.170.2/v2/credentials",
        "http://[fe80::1]/payload",
        "http://[::ffff:169.254.169.254]/latest/meta-data/",
        "http://[fd00:ec2::254]/latest/meta-data/",
        "http://0.0.0.0:8080/payload",
        "http://255.255.255.255/payload",
        "http://224.0.0.1/payload",
        "file:///etc/passwd",
        "ftp://example.com/payload",
        "gopher://example.com/payload",
    ] {
        let err = fetch_payload_once(uri)
            .await
            .expect_err(&format!("{uri} must be refused"));
        assert!(err.starts_with("refused "), "{uri}: {err}");
    }
}

#[test]
fn only_link_local_unspecified_broadcast_and_multicast_hosts_are_forbidden() {
    let forbidden = [
        "169.254.169.254",
        "169.254.0.1",
        "0.0.0.0",
        "255.255.255.255",
        "239.1.2.3",
        "fe80::1",
        "febf::1",
        "::",
        "ff02::1",
        "::ffff:169.254.169.254",
        "fd00:ec2::254",
    ];
    for ip in forbidden {
        assert!(
            is_forbidden_fetch_ip(ip.parse::<std::net::IpAddr>().unwrap()),
            "{ip} must be refused"
        );
    }
    // A devnet and the tests serve receipts from loopback and private ranges; public hosts
    // are what production uses.
    let allowed = [
        "127.0.0.1",
        "10.0.0.5",
        "172.16.1.1",
        "192.168.1.10",
        "::1",
        "fd00::1",
        "8.8.8.8",
        "2606:4700::1111",
    ];
    for ip in allowed {
        assert!(
            !is_forbidden_fetch_ip(ip.parse::<std::net::IpAddr>().unwrap()),
            "{ip} must be fetchable"
        );
    }
}

/// Serve one HTTP response from a loopback thread: `head` then `body_len` bytes of `x`.
fn serve_once(head: String, body_len: usize) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/payload", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        if let Ok((mut sock, _)) = listener.accept() {
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf);
            let _ = sock.write_all(head.as_bytes());
            let chunk = vec![b'x'; 64 * 1024];
            let mut left = body_len;
            while left > 0 {
                let n = left.min(chunk.len());
                if sock.write_all(&chunk[..n]).is_err() {
                    break;
                }
                left -= n;
            }
        }
    });
    url
}

#[tokio::test]
async fn a_body_past_the_cap_is_refused_while_it_streams() {
    // No Content-Length: the body is cut while it streams, at the chunk that crosses 1 MiB.
    let url = serve_once(
        "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_string(),
        2 * MAX_FETCH_BODY_BYTES,
    );
    let err = fetch_payload_once(&url)
        .await
        .expect_err("2 MiB is refused");
    assert!(err.contains("too large"), "{err}");

    // A declared Content-Length over the cap is refused before the body is read.
    let url = serve_once(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            MAX_FETCH_BODY_BYTES + 1
        ),
        0,
    );
    let err = fetch_payload_once(&url)
        .await
        .expect_err("declared size is refused");
    assert!(err.contains("too large"), "{err}");

    // A body at the cap is read whole.
    let url = serve_once(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {MAX_FETCH_BODY_BYTES}\r\nConnection: close\r\n\r\n"
        ),
        MAX_FETCH_BODY_BYTES,
    );
    let body = fetch_payload_once(&url).await.expect("1 MiB is read");
    assert_eq!(body.len(), MAX_FETCH_BODY_BYTES);
}

/// Security round 1: payload hosts that never answer cannot hold a tick past the sweep's time
/// budget.
///
/// The re-verification sweep runs before the tick indexes anything. One receipt whose host accepts
/// and never answers costs three 5 s timeouts plus 8 s of backoff, about 23 s, and the sweep took
/// up to 16 of them, so eight such receipts used to hold the tick for about three minutes (and the
/// watchdog's evaluation behind it). With the budget the tick returns soon after it, and every cut
/// attempt still counts toward the attempt ceiling.
#[tokio::test]
async fn tarpit_payload_hosts_cannot_hold_the_tick_past_the_sweep_budget() {
    let fx = pg_fixture().await;
    let db = &fx.db;
    db.upsert_chain(CHAIN, "base", "stub").await.unwrap();

    // A host that accepts every connection and never answers.
    let tarpit = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let tarpit_addr: SocketAddr = tarpit.local_addr().unwrap();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((sock, _)) = tarpit.accept().await {
            held.push(sock);
        }
    });
    for i in 0..8u8 {
        db.insert_consensus_receipt(
            CHAIN,
            receipt_addr().into_array(),
            [0x90 + i; 32],
            i64::from(i),
            submitter_addr().into_array(),
            [0xd0u8; 32],
            &format!("http://{tarpit_addr}/api/swarm/receipts/tarpit-{i}"),
            1_700_000_000,
            10,
            i32::from(i),
            [0x90 + i; 32],
            ReceiptVerification {
                verified: false,
                payload_bytes: None,
                attempts: 0,
                last_error: Some("not fetched yet".to_string()),
            },
        )
        .await
        .unwrap();
    }

    let stub = StubRpcServer::start().await;
    program_stub(&stub, 20, 0xab, 0xaa);
    stub.set("eth_getLogs", serde_json::json!([]));
    let rpc = JsonRpc::new(&stub.url);

    let started = std::time::Instant::now();
    let outcome = run_once(db, &rpc, &base_cfg(20)).await.unwrap();
    let elapsed = started.elapsed();
    stub.shutdown();
    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    assert!(
        elapsed < SWEEP_TIME_BUDGET + std::time::Duration::from_secs(15),
        "eight tarpit payload hosts held the tick for {elapsed:?}; the sweep's budget is {:?}",
        SWEEP_TIME_BUDGET
    );

    let attempted: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM consensus_receipts \
         WHERE chain_id = $1 AND verified = FALSE AND verify_attempts >= 1",
    )
    .bind(CHAIN)
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert!(
        attempted >= 1,
        "the attempts the sweep made, cut ones included, count toward the ceiling"
    );
}

/// Security round 2: payload hosts that never answer cannot hold the tick that INDEXES their
/// receipts past the inline fetch budget.
///
/// The sweep got a budget in round 1, but `handle_log` fetched every new `ReceiptRecorded` inline,
/// about 23 s per host that accepts and never answers, with no cap per tick. Any committee agent
/// can record receipts with an arbitrary URI, so 100 of them in one block held the tick (and the
/// watchdog's evaluation behind it) for about 40 minutes. Ten such receipts now cost at most the
/// inline budget. Every row is stored, and every one the tick did not verify is in the sweep's
/// working set, so a later tick's sweep fetches it.
#[tokio::test]
async fn tarpit_payload_hosts_cannot_hold_the_indexing_tick_past_the_inline_budget() {
    use explorer_indexer::indexer::INLINE_FETCH_TIME_BUDGET;

    let fx = pg_fixture().await;

    // A host that accepts every connection and never answers.
    let tarpit = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let tarpit_addr: SocketAddr = tarpit.local_addr().unwrap();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((sock, _)) = tarpit.accept().await {
            held.push(sock);
        }
    });
    let logs: Vec<serde_json::Value> = (0..10u8)
        .map(|i| {
            encode_receipt_recorded_log(
                receipt_addr(),
                [0xA0 + i; 32],
                submitter_addr(),
                u64::from(i),
                [0xd1u8; 32],
                &format!("http://{tarpit_addr}/api/swarm/receipts/inline-{i}"),
                1_700_000_000,
                10,
                [0xA0 + i; 32],
                u32::from(i),
            )
        })
        .collect();

    let stub = StubRpcServer::start().await;
    program_stub(&stub, 10, 0xaa, 0x00);
    stub.set("eth_getLogs", serde_json::Value::Array(logs));
    let rpc = JsonRpc::new(&stub.url);

    let started = std::time::Instant::now();
    let outcome = run_once(&fx.db, &rpc, &base_cfg(10)).await.unwrap();
    let elapsed = started.elapsed();
    stub.shutdown();
    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    assert!(
        elapsed < INLINE_FETCH_TIME_BUDGET + std::time::Duration::from_secs(15),
        "ten tarpit payload hosts held the indexing tick for {elapsed:?}; the inline budget is \
         {INLINE_FETCH_TIME_BUDGET:?}"
    );
    assert_eq!(
        fx.db.count(CountTable::ConsensusReceipts).await.unwrap(),
        10,
        "every commitment is stored, fetched or not"
    );
    let deferred: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM consensus_receipts \
         WHERE chain_id = $1 AND verified = FALSE AND verify_attempts = 0",
    )
    .bind(CHAIN)
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert!(
        deferred >= 1,
        "past the budget a receipt is stored unfetched, with no attempt counted against it"
    );
    let pending = fx
        .db
        .list_unverified_receipts(CHAIN, 12, 100)
        .await
        .unwrap();
    assert_eq!(
        pending.len(),
        10,
        "every unverified receipt is in the sweep's working set"
    );
}

/// Security round 2: the DNS resolution before a payload or memo fetch shares the attempt's
/// timeout. It used to run before the client existed, outside the request timeout, so a name
/// whose nameserver never answers added the system resolver's own timeout to every attempt.
#[tokio::test]
async fn a_resolver_that_never_answers_fails_within_the_fetch_timeout() {
    use explorer_indexer::indexer::resolve_within;

    let timeout = std::time::Duration::from_millis(300);
    let started = std::time::Instant::now();
    let hang = std::future::pending::<std::io::Result<std::vec::IntoIter<SocketAddr>>>();
    let err = resolve_within("never-answers.example", timeout, hang)
        .await
        .expect_err("a resolver that never answers is an error");
    let elapsed = started.elapsed();
    assert!(err.contains("never-answers.example"), "{err}");
    assert!(
        elapsed < timeout + std::time::Duration::from_secs(2),
        "the resolution took {elapsed:?} against a {timeout:?} budget"
    );

    // An answer within the budget passes through unchanged.
    let addr: SocketAddr = "127.0.0.1:443".parse().unwrap();
    let ok = resolve_within("fast.example", timeout, async move {
        Ok(vec![addr].into_iter())
    })
    .await
    .unwrap();
    assert_eq!(ok, vec![addr]);
}
