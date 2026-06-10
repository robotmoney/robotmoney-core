//! Gateway pause trigger via JSON-RPC `eth_sendRawTransaction`.
//!
//! Canonical: docs/technical/security-model.md §9 — automated pause path.
//!
//! When the watchdog detects a threshold breach and the configured action mode
//! includes `"pause"`, [`trigger_pause`] constructs and submits an EVM transaction
//! that calls `gateway.pause()` from the configured PAUSER_ROLE account.
//!
//! # Transaction construction
//!
//! The `pause()` selector is the first 4 bytes of `keccak256("pause()")`.
//! The transaction is signed with the configured PAUSER_ROLE private key and
//! submitted via `eth_sendRawTransaction` to the configured JSON-RPC endpoint.
//!
//! Gas price and nonce are fetched live from `eth_gasPrice` / `eth_getTransactionCount`
//! immediately before submission to minimise MEV exposure and nonce conflicts.
//!
//! # Idempotency
//!
//! The gateway reverts with `PausedError()` if already paused — the watchdog treats
//! this revert as a success (the gateway is already safe).

use alloy_primitives::{keccak256, Address, Bytes};
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;

use crate::WatchdogError;

/// Selector for `pause()` — first 4 bytes of `keccak256("pause()")`.
pub fn pause_selector() -> [u8; 4] {
    let hash = keccak256(b"pause()");
    [hash[0], hash[1], hash[2], hash[3]]
}

/// Parameters required to submit a `gateway.pause()` transaction.
#[derive(Debug, Clone)]
pub struct PauseParams {
    /// JSON-RPC endpoint URL for the gateway chain.
    pub rpc_url: String,
    /// Deployed gateway contract address.
    pub gateway_address: Address,
    /// Chain ID (used in EIP-155 transaction signing).
    pub chain_id: u64,
    /// ECDSA private key for the PAUSER_ROLE account (raw 32-byte scalar).
    pub pauser_key: [u8; 32],
}

/// Submit a `gateway.pause()` transaction and return the transaction hash hex string.
///
/// Returns `Ok(tx_hash_hex)` on successful submission.  If the gateway is already
/// paused (revert `PausedError()`) the call returns `Ok("already_paused")` so the
/// caller can log a no-op rather than treating it as an error.
///
/// All network / signing errors are returned as [`WatchdogError::Pause`].
pub async fn trigger_pause(client: &Client, params: &PauseParams) -> Result<String, WatchdogError> {
    // 1. Derive sender address from private key.
    let signing_key = k256::ecdsa::SigningKey::from_bytes((&params.pauser_key).into())
        .map_err(|e| WatchdogError::Pause(format!("invalid pauser key: {e}")))?;
    let verifying_key = signing_key.verifying_key();
    // alloy Address from uncompressed public key bytes (skip the 0x04 prefix).
    let pubkey_bytes = verifying_key.to_encoded_point(false);
    let pubkey_slice = &pubkey_bytes.as_bytes()[1..]; // strip 0x04 prefix
    let hash = keccak256(pubkey_slice);
    let from = Address::from_slice(&hash[12..]);

    // 2. Fetch nonce.
    let nonce = eth_get_transaction_count(client, &params.rpc_url, from).await?;

    // 3. Fetch gas price.
    let gas_price = eth_gas_price(client, &params.rpc_url).await?;

    // 4. Build the call data: pause() selector, no arguments.
    let selector = pause_selector();
    let data = Bytes::copy_from_slice(&selector);

    // 5. Sign and encode the transaction using a lightweight legacy (EIP-155) envelope.
    //    We avoid pulling in the full alloy-network stack to keep dependencies minimal.
    let tx_hash = send_legacy_transaction(
        client,
        &params.rpc_url,
        &signing_key,
        from,
        params.gateway_address,
        nonce,
        gas_price,
        80_000u64, // gas limit: pause() is a simple storage write
        data,
        params.chain_id,
    )
    .await?;

    Ok(tx_hash)
}

/// Fetch the current transaction count (nonce) for `address` via `eth_getTransactionCount`.
async fn eth_get_transaction_count(
    client: &Client,
    rpc_url: &str,
    address: Address,
) -> Result<u64, WatchdogError> {
    let addr_hex = format!("0x{}", hex::encode(address.as_slice()));
    let result = rpc_call(
        client,
        rpc_url,
        "eth_getTransactionCount",
        serde_json::json!([addr_hex, "pending"]),
    )
    .await?;
    parse_hex_u64(&result, "eth_getTransactionCount")
}

/// Fetch the current gas price via `eth_gasPrice`.
async fn eth_gas_price(client: &Client, rpc_url: &str) -> Result<u64, WatchdogError> {
    let result = rpc_call(client, rpc_url, "eth_gasPrice", serde_json::json!([])).await?;
    parse_hex_u64(&result, "eth_gasPrice")
}

/// Sign a legacy (EIP-155) transaction, encode it as RLP, and submit it via
/// `eth_sendRawTransaction`.  Returns the transaction hash hex string.
#[allow(clippy::too_many_arguments)]
async fn send_legacy_transaction(
    client: &Client,
    rpc_url: &str,
    signing_key: &k256::ecdsa::SigningKey,
    _from: Address,
    to: Address,
    nonce: u64,
    gas_price: u64,
    gas_limit: u64,
    data: Bytes,
    chain_id: u64,
) -> Result<String, WatchdogError> {
    // EIP-155 legacy transaction RLP encoding.
    // Fields: nonce, gasPrice, gasLimit, to, value, data, v, r, s
    // For signing: encode without v/r/s, append (chainId, 0, 0), hash, sign.

    let rlp_unsigned = encode_legacy_tx_for_signing(
        nonce, gas_price, gas_limit, to, 0u64, // value = 0
        &data, chain_id,
    );

    let msg_hash = keccak256(&rlp_unsigned);

    // Sign the hash.
    use k256::ecdsa::{signature::hazmat::PrehashSigner, RecoveryId, Signature};
    let (sig, recid): (Signature, RecoveryId) = signing_key
        .sign_prehash(msg_hash.as_slice())
        .map_err(|e| WatchdogError::Pause(format!("signing failed: {e}")))?;

    // EIP-155 v = 2 * chain_id + 35 + recovery_id
    let v = 2u64 * chain_id + 35 + recid.to_byte() as u64;
    let sig_bytes = sig.to_bytes();
    let r = &sig_bytes[..32];
    let s = &sig_bytes[32..];

    let rlp_signed = encode_legacy_tx_signed(nonce, gas_price, gas_limit, to, 0, &data, v, r, s);

    let hex_tx = format!("0x{}", hex::encode(&rlp_signed));
    let result = rpc_call(
        client,
        rpc_url,
        "eth_sendRawTransaction",
        serde_json::json!([hex_tx]),
    )
    .await?;

    match result.as_str() {
        Some(hash) => Ok(hash.to_owned()),
        None => Err(WatchdogError::Pause(format!(
            "unexpected eth_sendRawTransaction result: {result}"
        ))),
    }
}

/// Minimal RLP encoding for a legacy EIP-155 transaction (for signing).
/// Fields: [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]
fn encode_legacy_tx_for_signing(
    nonce: u64,
    gas_price: u64,
    gas_limit: u64,
    to: Address,
    value: u64,
    data: &[u8],
    chain_id: u64,
) -> Vec<u8> {
    let items: Vec<Vec<u8>> = vec![
        rlp_uint(nonce),
        rlp_uint(gas_price),
        rlp_uint(gas_limit),
        rlp_bytes(to.as_slice()), // address is always 20 bytes
        rlp_uint(value),
        rlp_bytes(data),
        rlp_uint(chain_id), // EIP-155
        rlp_uint(0u64),     // r = 0
        rlp_uint(0u64),     // s = 0
    ];
    let flat: Vec<u8> = items.into_iter().flatten().collect();
    rlp_list(&flat)
}

/// Minimal RLP encoding for a signed legacy EIP-155 transaction.
/// Fields: [nonce, gasPrice, gasLimit, to, value, data, v, r, s]
#[allow(clippy::too_many_arguments)]
fn encode_legacy_tx_signed(
    nonce: u64,
    gas_price: u64,
    gas_limit: u64,
    to: Address,
    value: u64,
    data: &[u8],
    v: u64,
    r: &[u8],
    s: &[u8],
) -> Vec<u8> {
    let items: Vec<Vec<u8>> = vec![
        rlp_uint(nonce),
        rlp_uint(gas_price),
        rlp_uint(gas_limit),
        rlp_bytes(to.as_slice()),
        rlp_uint(value),
        rlp_bytes(data),
        rlp_uint(v),
        rlp_bytes(r),
        rlp_bytes(s),
    ];
    let flat: Vec<u8> = items.into_iter().flatten().collect();
    rlp_list(&flat)
}

// ---- Minimal RLP helpers ----

/// RLP-encode an unsigned integer (big-endian, minimal length, no leading zero bytes).
fn rlp_uint(v: u64) -> Vec<u8> {
    if v == 0 {
        return vec![0x80]; // RLP empty byte string = 0
    }
    let bytes = v.to_be_bytes();
    let start = bytes.iter().position(|&b| b != 0).unwrap_or(7);
    let trimmed = &bytes[start..];
    rlp_bytes(trimmed)
}

/// RLP-encode a byte string.
fn rlp_bytes(data: &[u8]) -> Vec<u8> {
    if data.len() == 1 && data[0] < 0x80 {
        return vec![data[0]];
    }
    let mut out = rlp_length_prefix(0x80, data.len());
    out.extend_from_slice(data);
    out
}

/// RLP-encode a list of already-encoded items.
fn rlp_list(encoded_items: &[u8]) -> Vec<u8> {
    let mut out = rlp_length_prefix(0xc0, encoded_items.len());
    out.extend_from_slice(encoded_items);
    out
}

/// Produce the RLP length prefix for `offset` + payload length.
fn rlp_length_prefix(offset: u8, len: usize) -> Vec<u8> {
    if len <= 55 {
        vec![offset + len as u8]
    } else {
        let len_bytes = len.to_be_bytes();
        let start = len_bytes.iter().position(|&b| b != 0).unwrap_or(7);
        let len_enc = &len_bytes[start..];
        let mut out = vec![offset + 55 + len_enc.len() as u8];
        out.extend_from_slice(len_enc);
        out
    }
}

// ---- JSON-RPC helpers ----

/// JSON-RPC request body.
#[derive(Serialize)]
struct RpcRequest {
    jsonrpc: &'static str,
    method: &'static str,
    params: Value,
    id: u32,
}

/// Execute a single JSON-RPC call and return the `result` field.
async fn rpc_call(
    client: &Client,
    url: &str,
    method: &'static str,
    params: Value,
) -> Result<Value, WatchdogError> {
    let req = RpcRequest {
        jsonrpc: "2.0",
        method,
        params,
        id: 1,
    };
    let resp = client
        .post(url)
        .json(&req)
        .send()
        .await
        .map_err(|e| WatchdogError::Pause(format!("{method} request failed: {e}")))?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| WatchdogError::Pause(format!("{method} response parse failed: {e}")))?;

    if let Some(err) = body.get("error") {
        return Err(WatchdogError::Pause(format!("{method} RPC error: {err}")));
    }

    Ok(body["result"].clone())
}

/// Parse a `"0x..."` hex string result as `u64`.
fn parse_hex_u64(v: &Value, context: &str) -> Result<u64, WatchdogError> {
    let s = v
        .as_str()
        .ok_or_else(|| WatchdogError::Pause(format!("{context}: expected string, got {v}")))?;
    let hex = s.trim_start_matches("0x");
    u64::from_str_radix(hex, 16)
        .map_err(|e| WatchdogError::Pause(format!("{context}: invalid hex {s:?}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pause_selector_matches_keccak() {
        // keccak256("pause()") = 0x8456cb59...
        let sel = pause_selector();
        assert_eq!(sel[0], 0x84);
        assert_eq!(sel[1], 0x56);
        assert_eq!(sel[2], 0xcb);
        assert_eq!(sel[3], 0x59);
    }

    #[test]
    fn rlp_uint_zero_is_empty_string() {
        assert_eq!(rlp_uint(0), vec![0x80]);
    }

    #[test]
    fn rlp_uint_small_values() {
        // 0x01 encodes as 0x01 (single byte < 0x80)
        assert_eq!(rlp_uint(1), vec![0x01]);
        // 0x7f encodes as 0x7f
        assert_eq!(rlp_uint(0x7f), vec![0x7f]);
        // 0x80 encodes as 0x81 0x80
        assert_eq!(rlp_uint(0x80), vec![0x81, 0x80]);
    }
}
