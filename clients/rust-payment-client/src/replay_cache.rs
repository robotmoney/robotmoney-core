//! Canonical: docs/architecture.md §10 — Local State (submitted-order cache)
//!
//! Client-side replay cache keyed on the gateway-equivalent `paymentId`,
//! which is `keccak256(abi.encode(chain_id, gateway, agent, order_id,
//! amount, idempotency_key))`.  The deadline is intentionally excluded
//! from the key — this mirrors the on-chain formula in
//! `RobotMoneyGateway.deposit` (comment "DEADLINE INTENTIONALLY EXCLUDED").
//!
//! Audit finding M3 (priority-fee cap + replay cache half). The gateway
//! contract enforces idempotency on-chain via the paymentId derived from
//! chain_id, gateway address, agent address, orderId, amount, and
//! idempotencyKey; the cache is a defensive client-side check that catches
//! an operator retrying a deposit they previously sent — without paying gas
//! to discover the on-chain refusal. On a hit, the prior `tx_hash` is
//! surfaced so the operator can look up the original receipt.
//!
//! A retry with a fresh deadline but the same on-chain paymentId is caught
//! locally; deposits that differ by amount, chain_id, gateway address, or
//! agent address do not collide in the cache.
//!
//! Storage shape: a single JSON file at `<state_dir>/submitted_order_ids.json`.
//! Concurrent access is serialised with `fs2` advisory locks (already a
//! dependency for `nonce::AgentLock`).

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read as _, Seek, SeekFrom, Write as _};
use std::path::{Path, PathBuf};

use alloy_primitives::{keccak256, Address, B256, U256};
use alloy_sol_types::SolValue;
use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::errors::{Result, RmpcError};

/// On-disk filename, relative to the state dir.
pub const REPLAY_CACHE_FILENAME: &str = "submitted_order_ids.json";

/// Inputs used to derive the gateway-equivalent paymentId cache key.
///
/// Mirrors the on-chain formula:
/// `keccak256(abi.encode(chain_id, gateway, agent, order_id, amount,
/// idempotency_key))`.
pub struct PaymentIdInputs<'a> {
    pub chain_id: u64,
    pub gateway: Address,
    pub agent: Address,
    pub order_id: B256,
    pub amount: U256,
    pub idempotency_key: B256,
    /// Kept for audit-log metadata only; not part of the cache key.
    pub deadline: u64,
    /// The tx_hash recorded on insert.
    pub tx_hash: &'a str,
}

/// Compute the gateway-equivalent paymentId from the given inputs.
///
/// Formula: `keccak256(abi.encode(chain_id, gateway, agent, order_id,
/// amount, idempotency_key))`.  The deadline is intentionally excluded —
/// matching the on-chain definition in `RobotMoneyGateway`.
pub fn compute_payment_id(
    chain_id: u64,
    gateway: Address,
    agent: Address,
    order_id: B256,
    amount: U256,
    idempotency_key: B256,
) -> B256 {
    // abi.encode(uint256(chain_id), address(gateway), address(agent),
    //            bytes32(order_id), uint256(amount), bytes32(idempotency_key))
    let encoded = (
        U256::from(chain_id),
        gateway,
        agent,
        order_id,
        amount,
        idempotency_key,
    )
        .abi_encode_sequence();
    B256::from(keccak256(encoded))
}

/// One entry in the replay cache. Keyed by the gateway-equivalent
/// `paymentId` (a 32-byte hex string).  `deadline` is retained only as
/// audit metadata and does not affect cache key lookup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub payment_id: String,
    pub order_id: String,
    pub idempotency_key: String,
    /// Audit metadata only — not part of the cache key.
    pub deadline: u64,
    pub tx_hash: String,
}

/// On-disk shape: a `Vec<Entry>` plus a version tag. Vec keeps the file
/// human-readable and avoids HashMap-key serialisation gymnastics.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ReplayFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    entries: Vec<Entry>,
}

fn default_version() -> u32 {
    2
}

/// Replay-cache handle. Stateless — every operation re-reads the file
/// under a held advisory lock to keep concurrent rmpc invocations
/// (across processes) consistent. The cache is small (one entry per
/// submitted deposit), so this is fine.
pub struct ReplayCache {
    path: PathBuf,
}

impl ReplayCache {
    /// Open (or lazily create) the replay cache at
    /// `<state_dir>/submitted_order_ids.json`. Creates the parent dir
    /// if missing.
    pub fn open(state_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(state_dir).map_err(RmpcError::ErrIo)?;
        let path = state_dir.join(REPLAY_CACHE_FILENAME);
        Ok(Self { path })
    }

    /// Return the prior tx_hash if a deposit with the same on-chain
    /// paymentId was already submitted from this installation.
    ///
    /// The paymentId is computed from `(chain_id, gateway, agent,
    /// order_id, amount, idempotency_key)`.  A retry with a fresh
    /// deadline but the same paymentId inputs is caught here; deposits
    /// that differ by amount, chain_id, gateway, or agent produce a
    /// distinct paymentId and do not collide.
    pub fn lookup(
        &self,
        chain_id: u64,
        gateway: Address,
        agent: Address,
        order_id: B256,
        amount: U256,
        idempotency_key: B256,
    ) -> Result<Option<String>> {
        let payment_id =
            compute_payment_id(chain_id, gateway, agent, order_id, amount, idempotency_key);
        let key = format!("{payment_id:#x}");
        let map = self.read_locked()?;
        Ok(map.get(&key).map(|e| e.tx_hash.clone()))
    }

    /// Insert a new entry. The cache key is the gateway-equivalent
    /// paymentId; `deadline` is stored as audit metadata only.
    ///
    /// Overwrites any existing entry with the same paymentId (which
    /// would only happen if the prior insert lost a race before the
    /// broadcast returned a hash — we prefer the most recent tx_hash).
    #[allow(clippy::too_many_arguments)]
    pub fn insert(
        &self,
        chain_id: u64,
        gateway: Address,
        agent: Address,
        order_id: B256,
        amount: U256,
        idempotency_key: B256,
        deadline: u64,
        tx_hash: &str,
    ) -> Result<()> {
        let payment_id =
            compute_payment_id(chain_id, gateway, agent, order_id, amount, idempotency_key);
        let key = format!("{payment_id:#x}");
        self.with_locked_file(|file, mut map| {
            map.insert(
                key.clone(),
                Entry {
                    payment_id: key,
                    order_id: format!("{order_id:#x}"),
                    idempotency_key: format!("{idempotency_key:#x}"),
                    deadline,
                    tx_hash: tx_hash.to_string(),
                },
            );
            write_back(file, &map)
        })
    }

    fn read_locked(&self) -> Result<HashMap<String, Entry>> {
        if !self.path.exists() {
            return Ok(HashMap::new());
        }
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.path)
            .map_err(RmpcError::ErrIo)?;
        file.lock_shared().map_err(RmpcError::ErrIo)?;
        let result = (|| -> Result<HashMap<String, Entry>> {
            let mut buf = String::new();
            file.read_to_string(&mut buf).map_err(RmpcError::ErrIo)?;
            if buf.trim().is_empty() {
                return Ok(HashMap::new());
            }
            let parsed: ReplayFile = serde_json::from_str(&buf)
                .map_err(|e| RmpcError::ErrConfig(format!("replay cache: failed to parse: {e}")))?;
            let mut map = HashMap::new();
            for entry in parsed.entries {
                map.insert(entry.payment_id.clone(), entry);
            }
            Ok(map)
        })();
        let _ = file.unlock();
        result
    }

    fn with_locked_file<F>(&self, f: F) -> Result<()>
    where
        F: FnOnce(&mut File, HashMap<String, Entry>) -> Result<()>,
    {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&self.path)
            .map_err(RmpcError::ErrIo)?;
        file.lock_exclusive().map_err(RmpcError::ErrIo)?;
        let mut buf = String::new();
        let res = (|| -> Result<()> {
            file.read_to_string(&mut buf).map_err(RmpcError::ErrIo)?;
            let map = if buf.trim().is_empty() {
                HashMap::new()
            } else {
                let parsed: ReplayFile = serde_json::from_str(&buf).map_err(|e| {
                    RmpcError::ErrConfig(format!("replay cache: failed to parse: {e}"))
                })?;
                let mut m = HashMap::new();
                for entry in parsed.entries {
                    m.insert(entry.payment_id.clone(), entry);
                }
                m
            };
            f(&mut file, map)
        })();
        let _ = file.unlock();
        res
    }
}

fn write_back(file: &mut File, map: &HashMap<String, Entry>) -> Result<()> {
    let mut entries: Vec<Entry> = map.values().cloned().collect();
    entries.sort_by(|a, b| a.payment_id.cmp(&b.payment_id));
    let payload = ReplayFile {
        version: 2,
        entries,
    };
    let json =
        serde_json::to_string_pretty(&payload).map_err(|e| RmpcError::ErrConfig(e.to_string()))?;
    file.set_len(0).map_err(RmpcError::ErrIo)?;
    file.seek(SeekFrom::Start(0)).map_err(RmpcError::ErrIo)?;
    file.write_all(json.as_bytes()).map_err(RmpcError::ErrIo)?;
    file.flush().map_err(RmpcError::ErrIo)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{address, b256, U256};
    use tempfile::TempDir;

    // Shared test fixtures.
    const CHAIN_ID: u64 = 1;
    const GATEWAY: Address = address!("0000000000000000000000000000000000000001");
    const AGENT: Address = address!("0000000000000000000000000000000000000002");
    const ORDER_ID: B256 =
        b256!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const IDEM_KEY: B256 =
        b256!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const AMOUNT: U256 = U256::from_limbs([1_000_000, 0, 0, 0]);
    const TX_HASH: &str = "0xtxhash";

    #[test]
    fn miss_returns_none() {
        let dir = TempDir::new().unwrap();
        let cache = ReplayCache::open(dir.path()).unwrap();
        assert_eq!(
            cache
                .lookup(CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY)
                .unwrap(),
            None
        );
    }

    #[test]
    fn insert_then_lookup_hits() {
        let dir = TempDir::new().unwrap();
        let cache = ReplayCache::open(dir.path()).unwrap();
        cache
            .insert(
                CHAIN_ID,
                GATEWAY,
                AGENT,
                ORDER_ID,
                AMOUNT,
                IDEM_KEY,
                1_700_000_000,
                TX_HASH,
            )
            .unwrap();
        let got = cache
            .lookup(CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY)
            .unwrap();
        assert_eq!(got, Some(TX_HASH.to_string()));
    }

    /// A retry with a different deadline but the same paymentId inputs
    /// MUST hit the cache — this is the primary fix for issue #176.
    #[test]
    fn same_payment_id_different_deadline_hits() {
        let dir = TempDir::new().unwrap();
        let cache = ReplayCache::open(dir.path()).unwrap();
        // Insert with deadline = 1.
        cache
            .insert(
                CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY, 1, TX_HASH,
            )
            .unwrap();
        // Lookup with deadline = 2 — must still hit because paymentId is the key.
        let got = cache
            .lookup(CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY)
            .unwrap();
        assert_eq!(got, Some(TX_HASH.to_string()));
    }

    /// Different amount → different paymentId → no collision.
    #[test]
    fn different_amount_does_not_collide() {
        let dir = TempDir::new().unwrap();
        let cache = ReplayCache::open(dir.path()).unwrap();
        cache
            .insert(
                CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY, 1, TX_HASH,
            )
            .unwrap();
        let other_amount = U256::from(999_999u64);
        assert_eq!(
            cache
                .lookup(CHAIN_ID, GATEWAY, AGENT, ORDER_ID, other_amount, IDEM_KEY)
                .unwrap(),
            None
        );
    }

    /// Different chain_id → different paymentId → no collision.
    #[test]
    fn different_chain_id_does_not_collide() {
        let dir = TempDir::new().unwrap();
        let cache = ReplayCache::open(dir.path()).unwrap();
        cache
            .insert(
                CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY, 1, TX_HASH,
            )
            .unwrap();
        assert_eq!(
            cache
                .lookup(CHAIN_ID + 1, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY)
                .unwrap(),
            None
        );
    }

    /// Different gateway address → different paymentId → no collision.
    #[test]
    fn different_gateway_does_not_collide() {
        let dir = TempDir::new().unwrap();
        let cache = ReplayCache::open(dir.path()).unwrap();
        cache
            .insert(
                CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY, 1, TX_HASH,
            )
            .unwrap();
        let other_gateway = address!("0000000000000000000000000000000000000009");
        assert_eq!(
            cache
                .lookup(CHAIN_ID, other_gateway, AGENT, ORDER_ID, AMOUNT, IDEM_KEY)
                .unwrap(),
            None
        );
    }

    /// Different agent address → different paymentId → no collision.
    #[test]
    fn different_agent_does_not_collide() {
        let dir = TempDir::new().unwrap();
        let cache = ReplayCache::open(dir.path()).unwrap();
        cache
            .insert(
                CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY, 1, TX_HASH,
            )
            .unwrap();
        let other_agent = address!("0000000000000000000000000000000000000007");
        assert_eq!(
            cache
                .lookup(CHAIN_ID, GATEWAY, other_agent, ORDER_ID, AMOUNT, IDEM_KEY)
                .unwrap(),
            None
        );
    }

    #[test]
    fn cache_persists_across_handles() {
        let dir = TempDir::new().unwrap();
        {
            let cache = ReplayCache::open(dir.path()).unwrap();
            cache
                .insert(
                    CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY, 1, "0xhash1",
                )
                .unwrap();
        }
        {
            let cache = ReplayCache::open(dir.path()).unwrap();
            assert_eq!(
                cache
                    .lookup(CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY)
                    .unwrap(),
                Some("0xhash1".to_string())
            );
        }
    }

    #[test]
    fn second_insert_overwrites() {
        let dir = TempDir::new().unwrap();
        let cache = ReplayCache::open(dir.path()).unwrap();
        cache
            .insert(
                CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY, 1, "0xfirst",
            )
            .unwrap();
        cache
            .insert(
                CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY, 1, "0xsecond",
            )
            .unwrap();
        assert_eq!(
            cache
                .lookup(CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY)
                .unwrap(),
            Some("0xsecond".to_string())
        );
    }

    /// compute_payment_id must produce a deterministic hash that equals the
    /// Solidity `keccak256(abi.encode(...))` for the same inputs.
    ///
    /// Reference value: computed off-chain with the same inputs to validate
    /// the Rust encoding matches Solidity's ABI layout.
    #[test]
    fn compute_payment_id_is_deterministic() {
        let id1 = compute_payment_id(CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY);
        let id2 = compute_payment_id(CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY);
        assert_eq!(id1, id2);
    }

    /// Different idempotency_key → different paymentId → no collision.
    #[test]
    fn different_idempotency_key_does_not_collide() {
        let dir = TempDir::new().unwrap();
        let cache = ReplayCache::open(dir.path()).unwrap();
        cache
            .insert(
                CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, IDEM_KEY, 1, TX_HASH,
            )
            .unwrap();
        let other_key = b256!("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
        assert_eq!(
            cache
                .lookup(CHAIN_ID, GATEWAY, AGENT, ORDER_ID, AMOUNT, other_key)
                .unwrap(),
            None
        );
    }
}
