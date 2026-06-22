//! Canonical: Plan tracking issue #109 §4.5 — ABI encoding and Ethereum primitives (JSON-RPC transport)
//!
//! `rpc` module — minimal async JSON-RPC over `reqwest`.
//!
//! Per `Plan tracking issue #109` §3.5 ("hand-roll if minimal") and
//! issue #11. The daemon's read-side surface is small — chain id, block
//! number, code, balance, gas/fee history, transaction count, raw send,
//! and receipt — so we keep transport hand-rolled rather than pulling in
//! `alloy-provider`. That keeps the dep tree narrow and the §3.5 promise
//! ("the Rust binary must remain the only path to a signed deposit tx; no
//! alloy provider is exposed externally") trivially true.
//!
//! All numeric responses are decoded through `alloy-primitives` types
//! (`U256`, `Address`, `B256`, `Bytes`) so callers always get rich Rust
//! values rather than hex strings. JSON-RPC error objects map to
//! [`RmpcError::ErrRpcServer`]; transport failures map to
//! [`RmpcError::ErrRpcTransport`]; deserialisation issues to
//! [`RmpcError::ErrRpcDecode`].

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use alloy_primitives::{Address, Bytes, B256, U256, U64};
use alloy_rpc_types::{FeeHistory, TransactionReceipt};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

use crate::errors::{Result, RmpcError};

/// Default per-request timeout. Operator config can override later (#12+),
/// but the bare client is fine with a 30s budget against well-behaved RPCs.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Thin async JSON-RPC client over HTTP(S). Cheap to clone; the inner
/// `reqwest::Client` shares its connection pool.
#[derive(Debug, Clone)]
pub struct RpcClient {
    url: String,
    http: reqwest::Client,
    next_id: std::sync::Arc<AtomicU64>,
}

#[derive(Debug, Serialize)]
struct JsonRpcRequest<'a> {
    jsonrpc: &'static str,
    method: &'a str,
    params: Value,
    id: u64,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    #[allow(dead_code)]
    id: Option<Value>,
    result: Option<Value>,
    error: Option<JsonRpcErrorObj>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcErrorObj {
    code: i64,
    message: String,
}

/// Returns `true` iff `err` is Geth's transient "transaction indexing is in
/// progress" JSON-RPC error (code -32000). Right after a block is mined —
/// especially just after devnet boot — Geth reports a mined transaction as
/// not-yet-indexed for a brief window, so `eth_getTransactionReceipt`
/// transiently fails. Receipt-wait loops treat this as "pending" rather than
/// fatal. Matched narrowly (code -32000 AND the stable indexing-progress
/// message substring) so genuinely-unrelated server errors still propagate.
pub(crate) fn is_indexing_transient(err: &RmpcError) -> bool {
    matches!(
        err,
        RmpcError::ErrRpcServer { code: -32000, message }
            if message.contains("indexing is in progress")
    )
}

/// `eth_call` request shape — the daemon only uses the latest block and
/// only ever fills `to` and `data`. Anything else is left to whichever
/// caller cares (e.g. simulation tooling outside scope of #11).
#[derive(Debug, Clone, Serialize)]
pub struct CallRequest {
    pub to: Address,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<Address>,
    /// Hex-encoded call data, leading `0x`.
    pub data: Bytes,
}

impl RpcClient {
    /// Returns the endpoint URL (for logging).
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Construct a client. Validates the URL eagerly — passing garbage to
    /// `Client::new` would defer the error to the first request, and we'd
    /// like the daemon to fail fast on bad config.
    pub fn new(url: impl Into<String>) -> Result<Self> {
        let url = url.into();
        // Cheap structural check; full validation happens on the first send.
        reqwest::Url::parse(&url).map_err(|e| RmpcError::ErrConfig(format!("rpc url: {e}")))?;
        let http = reqwest::Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .build()
            .map_err(|e| RmpcError::ErrRpcTransport(e.to_string()))?;
        Ok(Self {
            url,
            http,
            next_id: std::sync::Arc::new(AtomicU64::new(1)),
        })
    }

    /// Issue a raw JSON-RPC call and decode `result` into `T`. Public so
    /// callers can reach methods we haven't wrapped yet (e.g. anvil pokes
    /// in the e2e harness).
    pub async fn call<T: DeserializeOwned>(&self, method: &str, params: Value) -> Result<T> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            method,
            params,
            id,
        };
        let resp = self
            .http
            .post(&self.url)
            .json(&req)
            .send()
            .await
            .map_err(|e| RmpcError::ErrRpcTransport(e.to_string()))?;

        let status = resp.status();
        let body = resp
            .bytes()
            .await
            .map_err(|e| RmpcError::ErrRpcTransport(e.to_string()))?;

        if !status.is_success() {
            return Err(RmpcError::ErrRpcTransport(format!(
                "HTTP {status}: {}",
                String::from_utf8_lossy(&body)
            )));
        }

        let parsed: JsonRpcResponse = serde_json::from_slice(&body)
            .map_err(|e| RmpcError::ErrRpcDecode(format!("response not JSON: {e}")))?;

        if let Some(err) = parsed.error {
            return Err(RmpcError::ErrRpcServer {
                code: err.code,
                message: err.message,
            });
        }
        // `result: null` is a *valid* response (e.g. pending receipt). Hand
        // through the literal `Value::Null` so callers that decode into
        // `Option<T>` see `None`. Only treat a missing `result` field as
        // a protocol violation.
        let result = parsed.result.unwrap_or(Value::Null);
        serde_json::from_value(result)
            .map_err(|e| RmpcError::ErrRpcDecode(format!("result decode: {e}")))
    }

    /// `eth_chainId` — returned as a `u64`. Mainnet won't realistically
    /// exceed this, and the operator config field is `u64`.
    pub async fn chain_id(&self) -> Result<u64> {
        let v: U64 = self.call("eth_chainId", json!([])).await?;
        Ok(v.to::<u64>())
    }

    /// `eth_blockNumber` — latest known block height.
    pub async fn block_number(&self) -> Result<u64> {
        let v: U64 = self.call("eth_blockNumber", json!([])).await?;
        Ok(v.to::<u64>())
    }

    /// `eth_getCode` — bytecode at `address` at the given block tag.
    /// `tag` defaults to `"latest"`. Used by #14 (code-hash pinning).
    pub async fn get_code(&self, address: Address, tag: Option<&str>) -> Result<Bytes> {
        self.call("eth_getCode", json!([address, tag.unwrap_or("latest")]))
            .await
    }

    /// `eth_getBalance` — wei balance.
    pub async fn get_balance(&self, address: Address, tag: Option<&str>) -> Result<U256> {
        self.call("eth_getBalance", json!([address, tag.unwrap_or("latest")]))
            .await
    }

    /// `eth_getTransactionCount` — pending nonce when `tag = "pending"`,
    /// confirmed nonce on `"latest"`. The CLI is single-flight so usually
    /// uses `"latest"` (see §3.6).
    pub async fn get_transaction_count(&self, address: Address, tag: Option<&str>) -> Result<u64> {
        let v: U64 = self
            .call(
                "eth_getTransactionCount",
                json!([address, tag.unwrap_or("latest")]),
            )
            .await?;
        Ok(v.to::<u64>())
    }

    /// `eth_gasPrice` — legacy gas price; kept for completeness, the daemon
    /// uses `eth_feeHistory` (EIP-1559 path) for actual fee selection.
    pub async fn gas_price(&self) -> Result<U256> {
        self.call("eth_gasPrice", json!([])).await
    }

    /// `eth_feeHistory(blockCount, newestBlock, rewardPercentiles)` — used
    /// by #12 to compute `priorityFee = max(p50, 1 gwei)`.
    pub async fn fee_history(
        &self,
        block_count: u64,
        newest_block: &str,
        reward_percentiles: &[f64],
    ) -> Result<FeeHistory> {
        // Geth/anvil expect the block count as a 0x-prefixed hex string; the
        // 0x-encoded form of a small integer is exactly what `format!` here
        // produces. We render it manually to avoid pulling in extra deps.
        let bc = format!("0x{block_count:x}");
        self.call(
            "eth_feeHistory",
            json!([bc, newest_block, reward_percentiles]),
        )
        .await
    }

    /// `eth_call` — read-only contract call. Returns raw return data; the
    /// caller is expected to decode through the `gateway` bindings.
    pub async fn eth_call(&self, req: &CallRequest, tag: Option<&str>) -> Result<Bytes> {
        self.call("eth_call", json!([req, tag.unwrap_or("latest")]))
            .await
    }

    /// `eth_sendRawTransaction` — broadcast a signed envelope. Returns the
    /// transaction hash.
    pub async fn send_raw_transaction(&self, raw: &Bytes) -> Result<B256> {
        self.call("eth_sendRawTransaction", json!([raw])).await
    }

    /// `eth_getTransactionReceipt` — `None` while pending. Decoded into the
    /// alloy receipt struct so callers can pull logs / status without
    /// re-parsing.
    ///
    /// Geth has a brief window right after a block is mined (especially just
    /// after devnet boot) where a transaction is mined but not yet indexed,
    /// so this method transiently returns JSON-RPC error -32000 with message
    /// "transaction indexing is in progress" (see [`is_indexing_transient`]).
    /// That transient is mapped to `Ok(None)` so it presents identically to a
    /// genuinely-pending receipt: callers polling on `None` keep polling
    /// within their existing budget instead of bailing out. All other
    /// JSON-RPC errors propagate unchanged.
    pub async fn get_transaction_receipt(
        &self,
        tx_hash: B256,
    ) -> Result<Option<TransactionReceipt>> {
        match self
            .call("eth_getTransactionReceipt", json!([tx_hash]))
            .await
        {
            Ok(receipt) => Ok(receipt),
            Err(e) if is_indexing_transient(&e) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// `eth_getLogs` — query logs by address + topics. The filter object
    /// follows the Ethereum JSON-RPC spec; callers pass the full JSON
    /// object (including `fromBlock`/`toBlock`/`address`/`topics`) so this
    /// method does not bake in any indexing strategy. Returns the raw
    /// JSON-RPC `result` array; the daemon decodes individual entries via
    /// the `gateway` ABI bindings.
    pub async fn get_logs(&self, filter: Value) -> Result<Vec<RawLog>> {
        self.call("eth_getLogs", json!([filter])).await
    }

    /// `eth_getBlockByNumber(tag, false)` — returns just the timestamp
    /// of the block at `block_number` (seconds since unix epoch). Used
    /// by §9 read commands to compute time-keyed views (e.g. the
    /// agent's current window id) deterministically against the pinned
    /// block, not the daemon's wall clock. `false` for the second
    /// `fullTransactions` arg keeps the response small.
    pub async fn block_timestamp(&self, block_number: u64) -> Result<u64> {
        let tag = format!("0x{block_number:x}");
        let v: Value = self
            .call("eth_getBlockByNumber", json!([tag, false]))
            .await?;
        let ts_hex = v
            .get("timestamp")
            .and_then(Value::as_str)
            .ok_or_else(|| RmpcError::ErrRpcDecode("block has no timestamp".to_string()))?;
        let stripped = ts_hex.trim_start_matches("0x");
        u64::from_str_radix(stripped, 16)
            .map_err(|e| RmpcError::ErrRpcDecode(format!("timestamp hex: {e}")))
    }
}

/// Multi-endpoint RPC client with automatic failover.
///
/// Wraps an ordered list of [`RpcClient`] instances. For every JSON-RPC
/// call, `FailoverRpcClient` tries each endpoint in order, returning the
/// first successful result. A call only fails if every configured endpoint
/// returns an error.
///
/// This satisfies the security-model.md §12 requirement:
/// > `rmpc` must support multiple RPC endpoints with automatic failover.
///
/// # Construction
///
/// Build via [`Config::rpc_client`] (preferred) or `FailoverRpcClient::new`.
///
/// # Failover behaviour
///
/// Transport errors (`ErrRpcTransport`) and HTTP non-2xx responses trigger
/// failover. JSON-RPC server errors (`ErrRpcServer`) also trigger failover
/// — different nodes may handle requests differently. Decode errors
/// (`ErrRpcDecode`) also trigger failover in case the node is misbehaving.
///
/// The last error is returned if all endpoints fail.
#[derive(Debug, Clone)]
pub struct FailoverRpcClient {
    endpoints: Vec<RpcClient>,
}

impl FailoverRpcClient {
    /// Construct from an ordered list of URLs. At least one URL is required;
    /// all URLs must be structurally valid (same check as [`RpcClient::new`]).
    pub fn new(urls: Vec<String>) -> crate::errors::Result<Self> {
        if urls.is_empty() {
            return Err(crate::errors::RmpcError::ErrConfig(
                "FailoverRpcClient requires at least one endpoint URL".to_string(),
            ));
        }
        let endpoints = urls
            .into_iter()
            .map(RpcClient::new)
            .collect::<crate::errors::Result<Vec<_>>>()?;
        Ok(Self { endpoints })
    }

    /// Returns the number of configured endpoints.
    pub fn endpoint_count(&self) -> usize {
        self.endpoints.len()
    }

    /// Issue a raw JSON-RPC call, failing over to subsequent endpoints on error.
    pub async fn call<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> crate::errors::Result<T> {
        let mut last_err = None;
        for client in &self.endpoints {
            match client.call(method, params.clone()).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    log::warn!(
                        "rmpc rpc: endpoint failed ({}), trying next; error: {e}",
                        client.url()
                    );
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.expect("endpoints is non-empty"))
    }

    /// `eth_chainId`.
    pub async fn chain_id(&self) -> crate::errors::Result<u64> {
        let mut last_err = None;
        for client in &self.endpoints {
            match client.chain_id().await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    log::warn!(
                        "rmpc rpc: chain_id failed on {}, trying next; error: {e}",
                        client.url()
                    );
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.expect("endpoints is non-empty"))
    }

    /// `eth_blockNumber`.
    pub async fn block_number(&self) -> crate::errors::Result<u64> {
        let mut last_err = None;
        for client in &self.endpoints {
            match client.block_number().await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    log::warn!(
                        "rmpc rpc: block_number failed on {}, trying next; error: {e}",
                        client.url()
                    );
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.expect("endpoints is non-empty"))
    }

    /// `eth_getCode`.
    pub async fn get_code(
        &self,
        address: alloy_primitives::Address,
        tag: Option<&str>,
    ) -> crate::errors::Result<alloy_primitives::Bytes> {
        let mut last_err = None;
        for client in &self.endpoints {
            match client.get_code(address, tag).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    log::warn!(
                        "rmpc rpc: get_code failed on {}, trying next; error: {e}",
                        client.url()
                    );
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.expect("endpoints is non-empty"))
    }

    /// `eth_getBalance`.
    pub async fn get_balance(
        &self,
        address: alloy_primitives::Address,
        tag: Option<&str>,
    ) -> crate::errors::Result<alloy_primitives::U256> {
        let mut last_err = None;
        for client in &self.endpoints {
            match client.get_balance(address, tag).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    log::warn!(
                        "rmpc rpc: get_balance failed on {}, trying next; error: {e}",
                        client.url()
                    );
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.expect("endpoints is non-empty"))
    }

    /// `eth_getTransactionCount`.
    pub async fn get_transaction_count(
        &self,
        address: alloy_primitives::Address,
        tag: Option<&str>,
    ) -> crate::errors::Result<u64> {
        let mut last_err = None;
        for client in &self.endpoints {
            match client.get_transaction_count(address, tag).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    log::warn!(
                        "rmpc rpc: get_transaction_count failed on {}, trying next; error: {e}",
                        client.url()
                    );
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.expect("endpoints is non-empty"))
    }

    /// `eth_gasPrice`.
    pub async fn gas_price(&self) -> crate::errors::Result<alloy_primitives::U256> {
        let mut last_err = None;
        for client in &self.endpoints {
            match client.gas_price().await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    log::warn!(
                        "rmpc rpc: gas_price failed on {}, trying next; error: {e}",
                        client.url()
                    );
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.expect("endpoints is non-empty"))
    }

    /// `eth_feeHistory`.
    pub async fn fee_history(
        &self,
        block_count: u64,
        newest_block: &str,
        reward_percentiles: &[f64],
    ) -> crate::errors::Result<alloy_rpc_types::FeeHistory> {
        let mut last_err = None;
        for client in &self.endpoints {
            match client
                .fee_history(block_count, newest_block, reward_percentiles)
                .await
            {
                Ok(v) => return Ok(v),
                Err(e) => {
                    log::warn!(
                        "rmpc rpc: fee_history failed on {}, trying next; error: {e}",
                        client.url()
                    );
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.expect("endpoints is non-empty"))
    }

    /// `eth_call`.
    pub async fn eth_call(
        &self,
        req: &CallRequest,
        tag: Option<&str>,
    ) -> crate::errors::Result<alloy_primitives::Bytes> {
        let mut last_err = None;
        for client in &self.endpoints {
            match client.eth_call(req, tag).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    log::warn!(
                        "rmpc rpc: eth_call failed on {}, trying next; error: {e}",
                        client.url()
                    );
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.expect("endpoints is non-empty"))
    }

    /// `eth_sendRawTransaction`.
    pub async fn send_raw_transaction(
        &self,
        raw: &alloy_primitives::Bytes,
    ) -> crate::errors::Result<alloy_primitives::B256> {
        let mut last_err = None;
        for client in &self.endpoints {
            match client.send_raw_transaction(raw).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    log::warn!(
                        "rmpc rpc: send_raw_transaction failed on {}, trying next; error: {e}",
                        client.url()
                    );
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.expect("endpoints is non-empty"))
    }

    /// `eth_getTransactionReceipt`, with failover that does **not** treat a
    /// `None` answer as terminal (RPC-3, RPC-4).
    ///
    /// A receipt of `None` on the first endpoint is ambiguous: it can mean the
    /// tx is genuinely pending, *or* that this endpoint hit Geth's transient
    /// `-32000 "indexing is in progress"` window (which [`RpcClient::
    /// get_transaction_receipt`] folds into `Ok(None)`), *or* that this
    /// endpoint returned a malformed/missing `result`. Returning that `None`
    /// immediately would defeat multi-endpoint failover for receipt lookups —
    /// a healthy second endpoint that already has the receipt would never be
    /// tried.
    ///
    /// So this loop keeps going past a `None` (and past an `Err`) to give every
    /// endpoint a chance to produce a real receipt:
    /// - the first `Ok(Some(receipt))` wins and returns immediately;
    /// - if no endpoint yields a receipt but at least one answered `Ok(None)`
    ///   (a legitimate "pending / not-yet-indexed here" answer), return
    ///   `Ok(None)` so receipt-wait loops keep polling within their budget;
    /// - only if *every* endpoint errored (none answered `None`) do we surface
    ///   the last error.
    pub async fn get_transaction_receipt(
        &self,
        tx_hash: alloy_primitives::B256,
    ) -> crate::errors::Result<Option<alloy_rpc_types::TransactionReceipt>> {
        let mut saw_none = false;
        let mut last_err = None;
        for client in &self.endpoints {
            match client.get_transaction_receipt(tx_hash).await {
                Ok(Some(receipt)) => return Ok(Some(receipt)),
                Ok(None) => {
                    // Pending / transient-indexing / empty here — try the next
                    // endpoint, but remember that at least one endpoint gave a
                    // valid "no receipt yet" answer.
                    log::debug!(
                        "rmpc rpc: get_transaction_receipt returned no receipt on {}, trying next endpoint",
                        client.url()
                    );
                    saw_none = true;
                }
                Err(e) => {
                    log::warn!(
                        "rmpc rpc: get_transaction_receipt failed on {}, trying next; error: {e}",
                        client.url()
                    );
                    last_err = Some(e);
                }
            }
        }
        if saw_none {
            // No endpoint had the receipt, but at least one answered "pending".
            Ok(None)
        } else {
            Err(last_err.expect("endpoints is non-empty"))
        }
    }

    /// `eth_getLogs`.
    pub async fn get_logs(&self, filter: serde_json::Value) -> crate::errors::Result<Vec<RawLog>> {
        let mut last_err = None;
        for client in &self.endpoints {
            match client.get_logs(filter.clone()).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    log::warn!(
                        "rmpc rpc: get_logs failed on {}, trying next; error: {e}",
                        client.url()
                    );
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.expect("endpoints is non-empty"))
    }

    /// `eth_getBlockByNumber` — returns block timestamp.
    pub async fn block_timestamp(&self, block_number: u64) -> crate::errors::Result<u64> {
        let mut last_err = None;
        for client in &self.endpoints {
            match client.block_timestamp(block_number).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    log::warn!(
                        "rmpc rpc: block_timestamp failed on {}, trying next; error: {e}",
                        client.url()
                    );
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.expect("endpoints is non-empty"))
    }
}

/// Minimal `eth_getLogs` log shape used by the daemon. Only the fields
/// `rmpc status` reads are deserialised; anything else the node may
/// include is ignored. Hex strings are kept as-is (decoded by the caller
/// using `alloy-primitives` parsers) so this struct stays trivially
/// `Deserialize`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawLog {
    /// Contract that emitted the log.
    pub address: Address,
    /// Indexed parameters; first entry is the event signature hash.
    pub topics: Vec<B256>,
    /// ABI-encoded non-indexed parameters.
    pub data: Bytes,
    /// Block in which the log was included. Hex-encoded `0x…`.
    pub block_number: U64,
    /// Hash of the transaction that produced the log.
    pub transaction_hash: B256,
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::address;

    #[test]
    fn new_rejects_bad_url() {
        let err = RpcClient::new("not a url").unwrap_err();
        assert!(matches!(err, RmpcError::ErrConfig(_)), "got {err:?}");
    }

    #[test]
    fn new_accepts_http_url() {
        RpcClient::new("http://localhost:8545").unwrap();
    }

    /// Drive a real HTTP exchange against `mockito`, asserting the request
    /// body is well-formed JSON-RPC and that the response is decoded into
    /// `u64`. This is the load-bearing test that ties the parser to the
    /// transport.
    #[tokio::test]
    async fn chain_id_round_trips_through_mock_server() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/")
            .match_header("content-type", "application/json")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"jsonrpc":"2.0","id":1,"result":"0x539"}"#)
            .expect(1)
            .create_async()
            .await;

        let client = RpcClient::new(server.url()).unwrap();
        let chain_id = client.chain_id().await.unwrap();
        // 0x539 == 1337 (anvil/hardhat default).
        assert_eq!(chain_id, 1337);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn server_error_object_maps_to_err_rpc_server() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/")
            .with_status(200)
            .with_body(
                r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}}"#,
            )
            .create_async()
            .await;

        let client = RpcClient::new(server.url()).unwrap();
        let err = client.chain_id().await.unwrap_err();
        match err {
            RmpcError::ErrRpcServer { code, message } => {
                assert_eq!(code, -32601);
                assert!(message.contains("method not found"));
            }
            other => panic!("expected ErrRpcServer, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn http_500_maps_to_err_rpc_transport() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/")
            .with_status(500)
            .with_body("upstream blew up")
            .create_async()
            .await;

        let client = RpcClient::new(server.url()).unwrap();
        let err = client.chain_id().await.unwrap_err();
        assert!(matches!(err, RmpcError::ErrRpcTransport(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn malformed_body_maps_to_err_rpc_decode() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/")
            .with_status(200)
            .with_body("not json at all")
            .create_async()
            .await;

        let client = RpcClient::new(server.url()).unwrap();
        let err = client.chain_id().await.unwrap_err();
        assert!(matches!(err, RmpcError::ErrRpcDecode(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn block_number_decodes_hex() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/")
            .with_status(200)
            .with_body(r#"{"jsonrpc":"2.0","id":1,"result":"0x10"}"#)
            .create_async()
            .await;
        let c = RpcClient::new(server.url()).unwrap();
        assert_eq!(c.block_number().await.unwrap(), 16);
    }

    #[tokio::test]
    async fn get_code_returns_bytes() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/")
            .with_status(200)
            .with_body(r#"{"jsonrpc":"2.0","id":1,"result":"0xdeadbeef"}"#)
            .create_async()
            .await;
        let c = RpcClient::new(server.url()).unwrap();
        let code = c
            .get_code(address!("00000000000000000000000000000000000000aa"), None)
            .await
            .unwrap();
        assert_eq!(code.as_ref(), &[0xde, 0xad, 0xbe, 0xef]);
    }

    #[tokio::test]
    async fn get_transaction_count_decodes() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/")
            .with_status(200)
            .with_body(r#"{"jsonrpc":"2.0","id":1,"result":"0x7"}"#)
            .create_async()
            .await;
        let c = RpcClient::new(server.url()).unwrap();
        let n = c
            .get_transaction_count(address!("00000000000000000000000000000000000000aa"), None)
            .await
            .unwrap();
        assert_eq!(n, 7);
    }

    #[tokio::test]
    async fn send_raw_transaction_returns_hash() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/")
            .with_status(200)
            .with_body(
                r#"{"jsonrpc":"2.0","id":1,"result":"0x1111111111111111111111111111111111111111111111111111111111111111"}"#,
            )
            .create_async()
            .await;
        let c = RpcClient::new(server.url()).unwrap();
        let hash = c
            .send_raw_transaction(&Bytes::from_static(&[0x02, 0xab]))
            .await
            .unwrap();
        assert_eq!(hash.as_slice()[0], 0x11);
    }

    /// Receipt is `null` while a tx is pending — must decode to `None`,
    /// not to an error. The CLI polls in a loop and treats `None` as
    /// "wait and retry".
    #[tokio::test]
    async fn pending_receipt_decodes_to_none() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/")
            .with_status(200)
            .with_body(r#"{"jsonrpc":"2.0","id":1,"result":null}"#)
            .create_async()
            .await;
        let c = RpcClient::new(server.url()).unwrap();
        let r = c.get_transaction_receipt(B256::ZERO).await.unwrap();
        assert!(r.is_none());
    }

    /// Predicate: matches only Geth's -32000 indexing transient, and rejects
    /// unrelated server / transport / decode errors so callers never swallow
    /// genuine failures.
    #[test]
    fn is_indexing_transient_matches_only_geth_transient() {
        assert!(is_indexing_transient(&RmpcError::ErrRpcServer {
            code: -32000,
            message: "transaction indexing is in progress".to_string(),
        }));
        // Same code but unrelated message must not match.
        assert!(!is_indexing_transient(&RmpcError::ErrRpcServer {
            code: -32000,
            message: "execution reverted".to_string(),
        }));
        // Right message but a different code must not match.
        assert!(!is_indexing_transient(&RmpcError::ErrRpcServer {
            code: -32602,
            message: "transaction indexing is in progress".to_string(),
        }));
        // Non-server errors never match.
        assert!(!is_indexing_transient(&RmpcError::ErrRpcTransport(
            "indexing is in progress".to_string()
        )));
    }

    /// Geth's indexing transient is surfaced by `get_transaction_receipt` as
    /// `Ok(None)` — identical to a pending receipt — so receipt-wait loops
    /// keep polling instead of bailing on a hard error.
    #[tokio::test]
    async fn indexing_transient_receipt_decodes_to_none() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/")
            .with_status(200)
            .with_body(
                r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"transaction indexing is in progress"}}"#,
            )
            .create_async()
            .await;
        let c = RpcClient::new(server.url()).unwrap();
        let r = c.get_transaction_receipt(B256::ZERO).await.unwrap();
        assert!(r.is_none());
    }

    /// An unrelated JSON-RPC server error still propagates from
    /// `get_transaction_receipt` — the transient tolerance is narrow.
    #[tokio::test]
    async fn unrelated_receipt_error_propagates() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/")
            .with_status(200)
            .with_body(
                r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"execution reverted"}}"#,
            )
            .create_async()
            .await;
        let c = RpcClient::new(server.url()).unwrap();
        let err = c.get_transaction_receipt(B256::ZERO).await.unwrap_err();
        assert!(
            matches!(err, RmpcError::ErrRpcServer { code: -32000, .. }),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn fee_history_request_shape_is_correct() {
        let mut server = mockito::Server::new_async().await;
        let body = r#"{
            "jsonrpc":"2.0","id":1,
            "result":{
                "oldestBlock":"0x1",
                "baseFeePerGas":["0x1","0x2"],
                "gasUsedRatio":[0.5],
                "reward":[["0x3b9aca00"]]
            }
        }"#;
        let m = server
            .mock("POST", "/")
            .match_body(mockito::Matcher::PartialJson(serde_json::json!({
                "method": "eth_feeHistory",
                "params": ["0x5", "latest", [50.0]]
            })))
            .with_status(200)
            .with_body(body)
            .create_async()
            .await;
        let c = RpcClient::new(server.url()).unwrap();
        let fh = c.fee_history(5, "latest", &[50.0]).await.unwrap();
        assert_eq!(fh.oldest_block, 1);
        m.assert_async().await;
    }

    // -- issue #667 — FailoverRpcClient tests --------------------------------

    #[test]
    fn failover_client_rejects_empty_url_list() {
        let err = FailoverRpcClient::new(vec![]).unwrap_err();
        assert!(matches!(err, RmpcError::ErrConfig(_)), "got {err:?}");
    }

    #[test]
    fn failover_client_rejects_bad_url() {
        let err = FailoverRpcClient::new(vec!["not a url".to_string()]).unwrap_err();
        assert!(matches!(err, RmpcError::ErrConfig(_)), "got {err:?}");
    }

    #[test]
    fn failover_client_accepts_single_valid_url() {
        let c = FailoverRpcClient::new(vec!["http://localhost:8545".to_string()]).unwrap();
        assert_eq!(c.endpoint_count(), 1);
    }

    #[test]
    fn failover_client_accepts_multi_url() {
        let c = FailoverRpcClient::new(vec![
            "http://node1:8545".to_string(),
            "http://node2:8545".to_string(),
        ])
        .unwrap();
        assert_eq!(c.endpoint_count(), 2);
    }

    /// When the first endpoint returns an HTTP 500, the failover client should
    /// try the second endpoint and succeed.
    #[tokio::test]
    async fn failover_client_retries_on_transport_error() {
        let mut bad_server = mockito::Server::new_async().await;
        let _bad_mock = bad_server
            .mock("POST", "/")
            .with_status(500)
            .with_body("upstream down")
            .create_async()
            .await;

        let mut good_server = mockito::Server::new_async().await;
        let _good_mock = good_server
            .mock("POST", "/")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"jsonrpc":"2.0","id":1,"result":"0x539"}"#)
            .create_async()
            .await;

        let client = FailoverRpcClient::new(vec![bad_server.url(), good_server.url()]).unwrap();

        let chain_id = client.chain_id().await.unwrap();
        assert_eq!(chain_id, 1337);
    }

    /// When all endpoints fail, the last error is returned.
    #[tokio::test]
    async fn failover_client_returns_error_when_all_endpoints_fail() {
        let mut s1 = mockito::Server::new_async().await;
        let _m1 = s1
            .mock("POST", "/")
            .with_status(500)
            .with_body("s1 down")
            .create_async()
            .await;

        let mut s2 = mockito::Server::new_async().await;
        let _m2 = s2
            .mock("POST", "/")
            .with_status(500)
            .with_body("s2 down")
            .create_async()
            .await;

        let client = FailoverRpcClient::new(vec![s1.url(), s2.url()]).unwrap();
        let err = client.chain_id().await.unwrap_err();
        assert!(matches!(err, RmpcError::ErrRpcTransport(_)), "got {err:?}");
    }

    // -- issue #991 — receipt failover on transient/None (RPC-3, RPC-4) ------

    /// Helper: a one-shot mock server whose `/` responds with `body`.
    async fn mock_server_with_body(body: &str) -> mockito::ServerGuard {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(body)
            .create_async()
            .await;
        server
    }

    /// RPC-3: when the first endpoint returns Geth's transient `-32000`
    /// indexing error (folded to `Ok(None)` by the single-client method) and
    /// the second endpoint has the receipt, the failover client must query the
    /// second endpoint and return the real receipt — `None` is not terminal.
    #[tokio::test]
    async fn failover_receipt_advances_past_transient_indexing_to_next_endpoint() {
        let transient = mock_server_with_body(
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"transaction indexing is in progress"}}"#,
        )
        .await;
        // A minimal but valid receipt with status 0x1.
        let good = mock_server_with_body(
            r#"{"jsonrpc":"2.0","id":1,"result":{
                "transactionHash":"0x1111111111111111111111111111111111111111111111111111111111111111",
                "transactionIndex":"0x0",
                "blockHash":"0x2222222222222222222222222222222222222222222222222222222222222222",
                "blockNumber":"0x10",
                "from":"0x000000000000000000000000000000000000aaaa",
                "to":"0x000000000000000000000000000000000000bbbb",
                "cumulativeGasUsed":"0x1",
                "gasUsed":"0x1",
                "contractAddress":null,
                "logs":[],
                "logsBloom":"0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
                "status":"0x1",
                "effectiveGasPrice":"0x1",
                "type":"0x2"
            }}"#,
        )
        .await;

        let client = FailoverRpcClient::new(vec![transient.url(), good.url()]).unwrap();
        let receipt = client.get_transaction_receipt(B256::ZERO).await.unwrap();
        assert!(
            receipt.is_some(),
            "failover must advance past the transient indexing error to the healthy endpoint"
        );
    }

    /// RPC-4: a malformed/missing-`result` response on the first endpoint
    /// (decoded to `Ok(None)`) must not be terminal either — the second
    /// endpoint's real receipt wins.
    #[tokio::test]
    async fn failover_receipt_advances_past_missing_result_to_next_endpoint() {
        // `result: null` ⇒ Ok(None) on the first endpoint.
        let empty = mock_server_with_body(r#"{"jsonrpc":"2.0","id":1,"result":null}"#).await;
        let good = mock_server_with_body(
            r#"{"jsonrpc":"2.0","id":1,"result":{
                "transactionHash":"0x1111111111111111111111111111111111111111111111111111111111111111",
                "transactionIndex":"0x0",
                "blockHash":"0x2222222222222222222222222222222222222222222222222222222222222222",
                "blockNumber":"0x10",
                "from":"0x000000000000000000000000000000000000aaaa",
                "to":"0x000000000000000000000000000000000000bbbb",
                "cumulativeGasUsed":"0x1",
                "gasUsed":"0x1",
                "contractAddress":null,
                "logs":[],
                "logsBloom":"0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
                "status":"0x1",
                "effectiveGasPrice":"0x1",
                "type":"0x2"
            }}"#,
        )
        .await;

        let client = FailoverRpcClient::new(vec![empty.url(), good.url()]).unwrap();
        let receipt = client.get_transaction_receipt(B256::ZERO).await.unwrap();
        assert!(
            receipt.is_some(),
            "failover must advance past a missing-result None to the healthy endpoint"
        );
    }

    /// When every endpoint legitimately reports "pending" (`Ok(None)`), the
    /// failover client returns `Ok(None)` — receipt-wait loops keep polling
    /// rather than seeing a spurious hard error.
    #[tokio::test]
    async fn failover_receipt_returns_none_when_all_endpoints_pending() {
        let p1 = mock_server_with_body(r#"{"jsonrpc":"2.0","id":1,"result":null}"#).await;
        let p2 = mock_server_with_body(
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"transaction indexing is in progress"}}"#,
        )
        .await;
        let client = FailoverRpcClient::new(vec![p1.url(), p2.url()]).unwrap();
        let receipt = client.get_transaction_receipt(B256::ZERO).await.unwrap();
        assert!(
            receipt.is_none(),
            "all-pending across endpoints must surface as Ok(None), not an error"
        );
    }

    /// When every endpoint hard-errors (no endpoint answers `None`), the last
    /// error is surfaced rather than a silent `Ok(None)`.
    #[tokio::test]
    async fn failover_receipt_errors_when_all_endpoints_hard_fail() {
        let e1 = mock_server_with_body(
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"execution reverted"}}"#,
        )
        .await;
        let e2 = mock_server_with_body(
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}}"#,
        )
        .await;
        let client = FailoverRpcClient::new(vec![e1.url(), e2.url()]).unwrap();
        let err = client.get_transaction_receipt(B256::ZERO).await.unwrap_err();
        assert!(
            matches!(err, RmpcError::ErrRpcServer { .. }),
            "all-error across endpoints must surface the last error; got {err:?}"
        );
    }

    /// Single-endpoint failover client works the same as a bare `RpcClient`.
    #[tokio::test]
    async fn failover_client_single_endpoint_success() {
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("POST", "/")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"jsonrpc":"2.0","id":1,"result":"0x10"}"#)
            .create_async()
            .await;

        let client = FailoverRpcClient::new(vec![server.url()]).unwrap();
        let block = client.block_number().await.unwrap();
        assert_eq!(block, 16);
    }
}

