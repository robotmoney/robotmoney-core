//! Canonical: docs/implementation-plan.md §4.5 — ABI encoding and Ethereum primitives (JSON-RPC transport)
//!
//! `rpc` module — minimal async JSON-RPC over `reqwest`.
//!
//! Per `docs/implementation-plan.md` §3.5 ("hand-roll if minimal") and
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
    pub async fn get_transaction_receipt(
        &self,
        tx_hash: B256,
    ) -> Result<Option<TransactionReceipt>> {
        self.call("eth_getTransactionReceipt", json!([tx_hash]))
            .await
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
}
