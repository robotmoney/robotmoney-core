//! Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
//!
//! Minimal async JSON-RPC client. Only the methods the indexer needs:
//! `eth_blockNumber`, `eth_chainId`, `eth_getBlockByNumber` (with and
//! without txs), `eth_getLogs`, `eth_call`. Mirrors the blocking
//! variant in `testing/fork-e2e-rust/src/lib.rs`.

use alloy_primitives::{Address, Bytes, B256};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum RpcError {
    #[error("transport: {0}")]
    Transport(String),
    #[error("rpc {method}: {message}")]
    Server { method: String, message: String },
    #[error("decode {method}: {message}")]
    Decode { method: String, message: String },
}

#[derive(Clone)]
pub struct JsonRpc {
    url: String,
    http: reqwest::Client,
}

#[derive(Debug, Clone)]
pub struct BlockHeader {
    pub number: u64,
    pub hash: B256,
    pub parent_hash: B256,
    pub timestamp: u64,
}

#[derive(Debug, Clone)]
pub struct LogEntry {
    pub address: Address,
    pub topics: Vec<B256>,
    pub data: Bytes,
    pub block_number: u64,
    pub block_hash: B256,
    pub tx_hash: B256,
    pub tx_index: u32,
    pub log_index: u32,
}

#[derive(Debug, Clone)]
pub struct TxRow {
    pub tx_hash: B256,
    pub tx_index: u32,
    pub from: Address,
    pub to: Option<Address>,
    pub status: u8,
}

impl JsonRpc {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("reqwest client builds"),
        }
    }

    async fn call<T: for<'de> Deserialize<'de>>(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<T, RpcError> {
        #[derive(Serialize)]
        struct Req<'a> {
            jsonrpc: &'a str,
            id: u64,
            method: &'a str,
            params: serde_json::Value,
        }
        let body = Req {
            jsonrpc: "2.0",
            id: 1,
            method,
            params,
        };
        let resp: serde_json::Value = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| RpcError::Transport(format!("{method}: {e}")))?
            .json()
            .await
            .map_err(|e| RpcError::Transport(format!("{method}: read body: {e}")))?;
        if let Some(err) = resp.get("error") {
            return Err(RpcError::Server {
                method: method.to_string(),
                message: err.to_string(),
            });
        }
        let result = resp
            .get("result")
            .ok_or_else(|| RpcError::Server {
                method: method.to_string(),
                message: "no result field".into(),
            })?
            .clone();
        serde_json::from_value(result).map_err(|e| RpcError::Decode {
            method: method.to_string(),
            message: e.to_string(),
        })
    }

    pub async fn chain_id(&self) -> Result<u64, RpcError> {
        let s: String = self.call("eth_chainId", serde_json::json!([])).await?;
        parse_u64_hex("eth_chainId", &s)
    }

    pub async fn block_number(&self) -> Result<u64, RpcError> {
        let s: String = self.call("eth_blockNumber", serde_json::json!([])).await?;
        parse_u64_hex("eth_blockNumber", &s)
    }

    /// Header-only fetch — keeps the response small for the per-tick
    /// reorg check.
    pub async fn block_header(&self, n: u64) -> Result<Option<BlockHeader>, RpcError> {
        let v: serde_json::Value = self
            .call(
                "eth_getBlockByNumber",
                serde_json::json!([format!("0x{:x}", n), false]),
            )
            .await?;
        if v.is_null() {
            return Ok(None);
        }
        let number = parse_u64_hex(
            "eth_getBlockByNumber.number",
            v.get("number").and_then(|x| x.as_str()).unwrap_or("0x0"),
        )?;
        let hash = parse_b256(
            "eth_getBlockByNumber.hash",
            v.get("hash").and_then(|x| x.as_str()).unwrap_or("0x"),
        )?;
        let parent_hash = parse_b256(
            "eth_getBlockByNumber.parentHash",
            v.get("parentHash").and_then(|x| x.as_str()).unwrap_or("0x"),
        )?;
        let timestamp = parse_u64_hex(
            "eth_getBlockByNumber.timestamp",
            v.get("timestamp").and_then(|x| x.as_str()).unwrap_or("0x0"),
        )?;
        Ok(Some(BlockHeader {
            number,
            hash,
            parent_hash,
            timestamp,
        }))
    }

    /// Fetch all transactions in a block, plus their receipts
    /// (status). Used to populate `transactions`.
    pub async fn block_with_txs(&self, n: u64) -> Result<(BlockHeader, Vec<TxRow>), RpcError> {
        let v: serde_json::Value = self
            .call(
                "eth_getBlockByNumber",
                serde_json::json!([format!("0x{:x}", n), true]),
            )
            .await?;
        if v.is_null() {
            return Err(RpcError::Server {
                method: "eth_getBlockByNumber".into(),
                message: format!("block {n} missing"),
            });
        }
        let header = BlockHeader {
            number: parse_u64_hex(
                "eth_getBlockByNumber.number",
                v.get("number").and_then(|x| x.as_str()).unwrap_or("0x0"),
            )?,
            hash: parse_b256(
                "eth_getBlockByNumber.hash",
                v.get("hash").and_then(|x| x.as_str()).unwrap_or("0x"),
            )?,
            parent_hash: parse_b256(
                "eth_getBlockByNumber.parentHash",
                v.get("parentHash").and_then(|x| x.as_str()).unwrap_or("0x"),
            )?,
            timestamp: parse_u64_hex(
                "eth_getBlockByNumber.timestamp",
                v.get("timestamp").and_then(|x| x.as_str()).unwrap_or("0x0"),
            )?,
        };
        let mut txs = Vec::new();
        if let Some(arr) = v.get("transactions").and_then(|x| x.as_array()) {
            for t in arr {
                let tx_hash = parse_b256(
                    "tx.hash",
                    t.get("hash").and_then(|x| x.as_str()).unwrap_or("0x"),
                )?;
                let tx_index = parse_u64_hex(
                    "tx.transactionIndex",
                    t.get("transactionIndex")
                        .and_then(|x| x.as_str())
                        .unwrap_or("0x0"),
                )? as u32;
                let from = parse_address(
                    "tx.from",
                    t.get("from").and_then(|x| x.as_str()).unwrap_or("0x"),
                )?;
                let to = match t.get("to").and_then(|x| x.as_str()) {
                    None => None,
                    Some("") => None,
                    Some(s) => Some(parse_address("tx.to", s)?),
                };
                // Receipt fetch for status. Cheap since we're already
                // ingesting block-by-block; a future optimization could
                // batch these.
                let status = self.tx_status(tx_hash).await?;
                txs.push(TxRow {
                    tx_hash,
                    tx_index,
                    from,
                    to,
                    status,
                });
            }
        }
        Ok((header, txs))
    }

    async fn tx_status(&self, hash: B256) -> Result<u8, RpcError> {
        let v: serde_json::Value = self
            .call(
                "eth_getTransactionReceipt",
                serde_json::json!([format!("{:#x}", hash)]),
            )
            .await?;
        if v.is_null() {
            return Ok(0);
        }
        let s = v.get("status").and_then(|x| x.as_str()).unwrap_or("0x0");
        let n = parse_u64_hex("receipt.status", s)?;
        Ok(n as u8)
    }

    /// `eth_getLogs` for a block range, optionally filtered by address
    /// + topic-0 OR-set.
    pub async fn get_logs(
        &self,
        from_block: u64,
        to_block: u64,
        addresses: &[Address],
        topic0: &[B256],
    ) -> Result<Vec<LogEntry>, RpcError> {
        let filter = serde_json::json!({
            "fromBlock": format!("0x{:x}", from_block),
            "toBlock":   format!("0x{:x}", to_block),
            "address":   addresses.iter().map(|a| format!("{:#x}", a)).collect::<Vec<_>>(),
            "topics":    [ topic0.iter().map(|t| format!("{:#x}", t)).collect::<Vec<_>>() ],
        });
        let raw: Vec<serde_json::Value> = self
            .call("eth_getLogs", serde_json::json!([filter]))
            .await?;
        let mut out = Vec::with_capacity(raw.len());
        for r in raw {
            let address = parse_address(
                "log.address",
                r.get("address").and_then(|x| x.as_str()).unwrap_or("0x"),
            )?;
            let topics = r
                .get("topics")
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|t| {
                    parse_b256(
                        "log.topic",
                        t.as_str().ok_or_else(|| RpcError::Decode {
                            method: "eth_getLogs".into(),
                            message: "topic not string".into(),
                        })?,
                    )
                })
                .collect::<Result<Vec<_>, _>>()?;
            let data = decode_hex_bytes(
                "log.data",
                r.get("data").and_then(|x| x.as_str()).unwrap_or("0x"),
            )?;
            let block_number = parse_u64_hex(
                "log.blockNumber",
                r.get("blockNumber")
                    .and_then(|x| x.as_str())
                    .unwrap_or("0x0"),
            )?;
            let block_hash = parse_b256(
                "log.blockHash",
                r.get("blockHash").and_then(|x| x.as_str()).unwrap_or("0x"),
            )?;
            let tx_hash = parse_b256(
                "log.transactionHash",
                r.get("transactionHash")
                    .and_then(|x| x.as_str())
                    .unwrap_or("0x"),
            )?;
            let tx_index = parse_u64_hex(
                "log.transactionIndex",
                r.get("transactionIndex")
                    .and_then(|x| x.as_str())
                    .unwrap_or("0x0"),
            )? as u32;
            let log_index = parse_u64_hex(
                "log.logIndex",
                r.get("logIndex").and_then(|x| x.as_str()).unwrap_or("0x0"),
            )? as u32;
            out.push(LogEntry {
                address,
                topics,
                data,
                block_number,
                block_hash,
                tx_hash,
                tx_index,
                log_index,
            });
        }
        Ok(out)
    }

    /// `eth_call` against `to` at a specific block. Used for state
    /// snapshot reads.
    pub async fn eth_call_at(
        &self,
        to: Address,
        data: Bytes,
        block: u64,
    ) -> Result<Bytes, RpcError> {
        let params = serde_json::json!([
            {
                "to": format!("{:#x}", to),
                "data": format!("0x{}", hex::encode(&data)),
            },
            format!("0x{:x}", block),
        ]);
        let s: String = self.call("eth_call", params).await?;
        decode_hex_bytes("eth_call", &s)
    }
}

fn parse_u64_hex(method: &str, s: &str) -> Result<u64, RpcError> {
    u64::from_str_radix(s.trim_start_matches("0x"), 16).map_err(|e| RpcError::Decode {
        method: method.to_string(),
        message: e.to_string(),
    })
}

fn parse_b256(method: &str, s: &str) -> Result<B256, RpcError> {
    let s = s.trim_start_matches("0x");
    let bytes = hex::decode(s).map_err(|e| RpcError::Decode {
        method: method.to_string(),
        message: e.to_string(),
    })?;
    if bytes.len() != 32 {
        return Err(RpcError::Decode {
            method: method.to_string(),
            message: format!("b256 wrong length {}", bytes.len()),
        });
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(B256::from(out))
}

fn parse_address(method: &str, s: &str) -> Result<Address, RpcError> {
    let s = s.trim_start_matches("0x");
    let bytes = hex::decode(s).map_err(|e| RpcError::Decode {
        method: method.to_string(),
        message: e.to_string(),
    })?;
    if bytes.len() != 20 {
        return Err(RpcError::Decode {
            method: method.to_string(),
            message: format!("address wrong length {}", bytes.len()),
        });
    }
    Ok(Address::from_slice(&bytes))
}

fn decode_hex_bytes(method: &str, s: &str) -> Result<Bytes, RpcError> {
    let s = s.trim_start_matches("0x");
    let bytes = hex::decode(s).map_err(|e| RpcError::Decode {
        method: method.to_string(),
        message: e.to_string(),
    })?;
    Ok(Bytes::from(bytes))
}
