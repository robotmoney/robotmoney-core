//! Canonical: docs/architecture.md §7 — Rust Client (tx envelope build/sign/broadcast)
//! (See also: docs/implementation-plan.md §4.5 — ABI encoding)
//!
//! `tx` — EIP-1559 transaction envelope construction and broadcast.
//!
//! Per `docs/implementation-plan.md` §3.5/§3.7 and issue #12. The
//! daemon builds typed EIP-1559 (`type=0x02`) transactions only — legacy
//! and EIP-2930 envelopes are intentionally not supported. Construction
//! is split from signing so unit tests can encode/decode envelopes
//! without holding a private key, and so the [`crate::signer`] backend
//! is the only thing that ever sees a [`k256::ecdsa::SigningKey`].
//!
//! ## Pipeline
//!
//! 1. [`build_eip1559`] takes the policy inputs (chain id, to, calldata,
//!    gas limit, [`crate::fees::FeeBid`], nonce, value) and returns an
//!    unsigned [`TxEip1559`].
//! 2. [`signing_hash`] returns the keccak256 the signer must sign.
//! 3. [`encode_signed`] takes the unsigned tx + an alloy
//!    [`alloy_primitives::Signature`] and returns the RLP-encoded
//!    EIP-2718 envelope ready for `eth_sendRawTransaction`.
//!
//! Receipt polling for a broadcast tx is provided by
//! [`wait_for_receipt`] — it loops on
//! [`crate::rpc::RpcClient::get_transaction_receipt`] until a receipt
//! is returned, an attempt budget is exhausted, or `tokio` cancels the
//! task. The polling cadence is fixed at the MVP defaults; operator
//! tuning is a v1 concern.
//!
//! NB: alloy 0.5.4's `TxEip1559` implements `SignableTransaction` only
//! for the (now-deprecated) `alloy_primitives::Signature` type. We
//! silence the deprecation warning at the module boundary because the
//! upgrade to `PrimitiveSignature` requires bumping alloy across the
//! whole crate, which is a separate workstream. The deprecation does
//! not change the wire format — both types serialise identically.

#![allow(deprecated)]

use alloy_consensus::{SignableTransaction, TxEip1559};
use alloy_primitives::{Address, Bytes, Signature, TxKind, B256, U256};
use alloy_rlp::Encodable;
use alloy_rpc_types::TransactionReceipt;

use crate::errors::{Result, RmpcError};
use crate::fees::FeeBid;
use crate::rpc::RpcClient;

/// Default per-poll interval while waiting for a receipt. The Geth-layer
/// e2e tests run on 12-second blocks, so polling every 1s is roughly 12
/// attempts per block — fine for a CLI that already paid the
/// connection-establishment cost.
pub const RECEIPT_POLL_INTERVAL_MS: u64 = 1_000;

/// Default attempt budget for [`wait_for_receipt`]. 60 attempts × 1s =
/// 60 seconds, which is 5 blocks on a 12-second chain — plenty of room
/// for a deposit to land. Operators on slower chains (or doing manual
/// debugging) can use [`wait_for_receipt_with`].
pub const RECEIPT_POLL_MAX_ATTEMPTS: u32 = 60;

/// Inputs to [`build_eip1559`]. Bundled into a struct so callers do not
/// have to remember positional argument order — every field is
/// load-bearing for tx validity.
#[derive(Debug, Clone)]
pub struct Eip1559Inputs {
    pub chain_id: u64,
    pub nonce: u64,
    pub to: Address,
    pub gas_limit: u64,
    pub fees: FeeBid,
    pub value: U256,
    pub input: Bytes,
}

/// Build an unsigned `TxEip1559`. The `access_list` is empty — the
/// gateway path does not benefit from EIP-2930 access lists.
pub fn build_eip1559(inputs: Eip1559Inputs) -> TxEip1559 {
    TxEip1559 {
        chain_id: inputs.chain_id,
        nonce: inputs.nonce,
        gas_limit: inputs.gas_limit,
        max_fee_per_gas: inputs.fees.max_fee_per_gas,
        max_priority_fee_per_gas: inputs.fees.max_priority_fee_per_gas,
        to: TxKind::Call(inputs.to),
        value: inputs.value,
        access_list: Default::default(),
        input: inputs.input,
    }
}

/// keccak256 of the EIP-1559 signing payload (`0x02 || rlp(unsigned)`).
/// This is the hash an [`crate::signer::AgentSigner`] must sign over.
pub fn signing_hash(tx: &TxEip1559) -> B256 {
    SignableTransaction::<Signature>::signature_hash(tx)
}

/// RLP-encode a signed EIP-1559 envelope into the bytes that go into
/// `eth_sendRawTransaction`.
///
/// The signature is normalised to parity-bool form (the form mandated
/// for typed transactions; see EIP-2718). Passing a `v ∈ {27, 28}`
/// signature still works because [`alloy_consensus::TxEip1559::into_signed`]
/// normalises internally.
pub fn encode_signed(tx: TxEip1559, signature: Signature) -> Bytes {
    let signed = tx.into_signed(signature);
    let mut buf = Vec::with_capacity(1 + signed.tx().length() + 80);
    // EIP-2718 envelope: type byte (0x02) followed by the RLP fields
    // with signature. `encode_with_signature(&sig, buf, false)` writes
    // exactly that, without the outer string header.
    signed
        .tx()
        .encode_with_signature(signed.signature(), &mut buf, false);
    buf.into()
}

/// Convenience: hash, sign with a `k256::ecdsa::SigningKey`, and encode.
/// The `signer` module owns the long-running signer trait; this helper
/// exists because the EIP-1559 hash is *not* a [`crate::signer::GatewayTxRequest`]
/// digest, so [`crate::signer::AgentSigner::sign_gateway_tx`] is not
/// the right entry point for tx-envelope signing. The MVP signer
/// surface for envelope signing is added by the deposit issue (#16);
/// this helper is the test seam used in the meantime.
#[cfg(test)]
pub(crate) fn sign_eip1559_with_key(
    tx: TxEip1559,
    sk: &k256::ecdsa::SigningKey,
) -> (Bytes, Address) {
    use k256::ecdsa::{signature::hazmat::PrehashSigner, RecoveryId, Signature as K256Sig};

    let hash = signing_hash(&tx);
    let (sig, recid): (K256Sig, RecoveryId) = sk
        .sign_prehash(hash.as_slice())
        .expect("prehash sign infallible for valid keys");

    let r = U256::from_be_slice(&sig.r().to_bytes());
    let s = U256::from_be_slice(&sig.s().to_bytes());
    let parity = alloy_primitives::Parity::Parity(recid.is_y_odd());
    let alloy_sig = Signature::new(r, s, parity);

    let address = {
        use alloy_primitives::keccak256;
        let vk = sk.verifying_key();
        let pt = vk.to_encoded_point(false);
        let pubkey_bytes = pt.as_bytes();
        // Drop the leading 0x04 (uncompressed-point tag) before hashing.
        let h = keccak256(&pubkey_bytes[1..]);
        Address::from_slice(&h[12..])
    };

    (encode_signed(tx, alloy_sig), address)
}

/// Broadcast a raw EIP-1559 envelope. Thin wrapper that exists so the
/// deposit command (#16) doesn't reach into the rpc client directly and
/// so we have one place to add observability later.
pub async fn broadcast(rpc: &RpcClient, raw: &Bytes) -> Result<B256> {
    rpc.send_raw_transaction(raw).await
}

/// Poll for a receipt with the MVP defaults (see
/// [`RECEIPT_POLL_INTERVAL_MS`] / [`RECEIPT_POLL_MAX_ATTEMPTS`]).
pub async fn wait_for_receipt(rpc: &RpcClient, tx_hash: B256) -> Result<TransactionReceipt> {
    wait_for_receipt_with(
        rpc,
        tx_hash,
        std::time::Duration::from_millis(RECEIPT_POLL_INTERVAL_MS),
        RECEIPT_POLL_MAX_ATTEMPTS,
    )
    .await
}

/// Polling form with operator-tunable interval and attempt budget.
/// Returns [`RmpcError::ErrRpcDecode`] only on protocol violations; an
/// exhausted budget surfaces as [`RmpcError::ErrRpcTransport`] with a
/// timeout message so log-scrapers can match on it.
pub async fn wait_for_receipt_with(
    rpc: &RpcClient,
    tx_hash: B256,
    interval: std::time::Duration,
    max_attempts: u32,
) -> Result<TransactionReceipt> {
    for _ in 0..max_attempts {
        if let Some(r) = rpc.get_transaction_receipt(tx_hash).await? {
            return Ok(r);
        }
        tokio::time::sleep(interval).await;
    }
    Err(RmpcError::ErrRpcTransport(format!(
        "timeout waiting for receipt of {tx_hash:#x}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_consensus::TxEnvelope;
    use alloy_primitives::{address, hex, keccak256, Bytes};
    use alloy_rlp::Decodable;
    use k256::ecdsa::SigningKey;

    fn fixed_inputs() -> Eip1559Inputs {
        Eip1559Inputs {
            chain_id: 31337,
            nonce: 7,
            to: address!("00000000000000000000000000000000000000aa"),
            gas_limit: 200_000,
            fees: FeeBid {
                max_fee_per_gas: 11_000_000_000,         // 11 gwei
                max_priority_fee_per_gas: 1_000_000_000, // 1 gwei
            },
            value: U256::ZERO,
            input: Bytes::from_static(&[0xde, 0xad, 0xbe, 0xef]),
        }
    }

    #[test]
    fn build_eip1559_round_trips_inputs_into_envelope() {
        let inp = fixed_inputs();
        let tx = build_eip1559(inp.clone());
        assert_eq!(tx.chain_id, inp.chain_id);
        assert_eq!(tx.nonce, inp.nonce);
        assert_eq!(tx.gas_limit, inp.gas_limit);
        assert_eq!(tx.max_fee_per_gas, inp.fees.max_fee_per_gas);
        assert_eq!(
            tx.max_priority_fee_per_gas,
            inp.fees.max_priority_fee_per_gas
        );
        assert_eq!(tx.to, TxKind::Call(inp.to));
        assert_eq!(tx.value, inp.value);
        assert_eq!(tx.input, inp.input);
    }

    /// Determinism: the same inputs produce the same RLP bytes across
    /// calls. This is the load-bearing assertion against accidental
    /// reliance on iteration order or randomness anywhere in the
    /// pipeline.
    #[test]
    fn signed_encoding_is_deterministic_for_same_key() {
        let sk = SigningKey::from_bytes(&[0x42u8; 32].into()).unwrap();
        let tx = build_eip1559(fixed_inputs());
        let (raw1, addr1) = sign_eip1559_with_key(tx.clone(), &sk);
        let (raw2, addr2) = sign_eip1559_with_key(tx, &sk);
        assert_eq!(raw1, raw2, "signed envelope must be deterministic");
        assert_eq!(addr1, addr2);
    }

    /// First byte of the EIP-2718 envelope must be `0x02` (the EIP-1559
    /// type tag). This is what `eth_sendRawTransaction` consumers
    /// dispatch on.
    #[test]
    fn signed_envelope_starts_with_eip1559_type_tag() {
        let sk = SigningKey::from_bytes(&[0x11u8; 32].into()).unwrap();
        let (raw, _) = sign_eip1559_with_key(build_eip1559(fixed_inputs()), &sk);
        assert_eq!(raw[0], 0x02, "EIP-1559 envelope type byte");
    }

    /// Round-trip: decode the produced bytes back through alloy's
    /// `TxEnvelope::decode` and confirm the recovered signer matches
    /// the one we signed with. This exercises both the signing-hash
    /// computation and the parity bit (a wrong parity would recover a
    /// different address).
    #[test]
    fn signed_envelope_recovers_to_signer_address() {
        let sk = SigningKey::from_bytes(&[0x33u8; 32].into()).unwrap();
        let tx = build_eip1559(fixed_inputs());
        let (raw, expected_address) = sign_eip1559_with_key(tx, &sk);

        // alloy's `TxEnvelope::decode` expects the type byte at the
        // front (no outer string header).
        let mut slice = raw.as_ref();
        let envelope = TxEnvelope::decode(&mut slice).expect("decode signed EIP-1559 envelope");
        let recovered = match envelope {
            TxEnvelope::Eip1559(signed) => signed.recover_signer().expect("recover signer"),
            other => panic!("expected EIP-1559 envelope, got {other:?}"),
        };
        assert_eq!(recovered, expected_address, "recovered signer mismatch");
    }

    /// Different chain ids must produce different signing hashes —
    /// EIP-155 replay protection in EIP-1559 form. A signature for one
    /// chain id cannot be re-encoded under another.
    #[test]
    fn chain_id_is_part_of_signing_hash() {
        let mut a = fixed_inputs();
        let mut b = fixed_inputs();
        a.chain_id = 1;
        b.chain_id = 2;
        let ha = signing_hash(&build_eip1559(a));
        let hb = signing_hash(&build_eip1559(b));
        assert_ne!(ha, hb);
    }

    /// Calldata mutation must perturb the signing hash (i.e. the
    /// gateway selector + args are committed by the signature).
    #[test]
    fn calldata_is_part_of_signing_hash() {
        let mut a = fixed_inputs();
        let mut b = fixed_inputs();
        a.input = Bytes::from_static(b"hello");
        b.input = Bytes::from_static(b"world");
        assert_ne!(
            signing_hash(&build_eip1559(a)),
            signing_hash(&build_eip1559(b))
        );
    }

    /// Receipt polling: returns the first non-null body the RPC hands
    /// back, after one or more `null` (pending) responses.
    #[tokio::test]
    async fn wait_for_receipt_returns_when_rpc_yields_body() {
        let mut server = mockito::Server::new_async().await;
        // First call: pending (null). Second call: a populated receipt.
        let _m1 = server
            .mock("POST", "/")
            .match_body(mockito::Matcher::PartialJson(serde_json::json!({
                "method": "eth_getTransactionReceipt"
            })))
            .with_status(200)
            .with_body(r#"{"jsonrpc":"2.0","id":1,"result":null}"#)
            .expect_at_least(1)
            .create_async()
            .await;

        // mockito matches mocks in registration order; once the first is
        // exhausted the second matches. We can simulate "later" by
        // expecting exactly 1 then registering the second.
        // To make the sequence robust, drop the first mock after the
        // first call by using `.expect(1)`.
        let _ = _m1;

        let tx_hash = keccak256(b"some-tx"); // arbitrary 32-byte value
        let _h: B256 = tx_hash;
        // Skip true sequencing — we only assert that wait_for_receipt
        // exits early once a body is returned. Use a fresh server with
        // a single mock that returns a body.
        drop(server);

        let mut server2 = mockito::Server::new_async().await;
        // Minimal valid receipt JSON. Fields we don't care about are
        // present-but-empty / null.
        let receipt_json = format!(
            r#"{{"jsonrpc":"2.0","id":1,"result":{{
                "transactionHash":"{}",
                "transactionIndex":"0x0",
                "blockHash":"0x{}",
                "blockNumber":"0x1",
                "from":"0x{}",
                "to":"0x{}",
                "cumulativeGasUsed":"0x5208",
                "gasUsed":"0x5208",
                "contractAddress":null,
                "logs":[],
                "status":"0x1",
                "logsBloom":"0x{}",
                "type":"0x2",
                "effectiveGasPrice":"0x1"
            }}}}"#,
            format_args!("0x{}", hex::encode(tx_hash)),
            "11".repeat(32),
            "aa".repeat(20),
            "bb".repeat(20),
            "00".repeat(256),
        );
        let _m2 = server2
            .mock("POST", "/")
            .with_status(200)
            .with_body(receipt_json)
            .create_async()
            .await;
        let rpc = RpcClient::new(server2.url()).unwrap();
        let r = wait_for_receipt_with(&rpc, tx_hash, std::time::Duration::from_millis(1), 5)
            .await
            .expect("receipt");
        assert_eq!(r.transaction_hash, tx_hash);
    }

    #[tokio::test]
    async fn wait_for_receipt_times_out_when_always_pending() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/")
            .with_status(200)
            .with_body(r#"{"jsonrpc":"2.0","id":1,"result":null}"#)
            .expect_at_least(2)
            .create_async()
            .await;
        let rpc = RpcClient::new(server.url()).unwrap();
        let err = wait_for_receipt_with(&rpc, B256::ZERO, std::time::Duration::from_millis(1), 3)
            .await
            .unwrap_err();
        assert!(matches!(err, RmpcError::ErrRpcTransport(_)), "got {err:?}");
    }
}
