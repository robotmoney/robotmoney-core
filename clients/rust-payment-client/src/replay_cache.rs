//! Canonical: docs/architecture.md §10 — Local State (submitted-order cache)
//!
//! Client-side replay cache for `(order_id, idempotency_key, deadline)`
//! tuples already submitted by this rmpc installation.
//!
//! Audit finding M3 (priority-fee cap + replay cache half). The gateway
//! contract enforces idempotency on-chain via `idempotencyKey`; the
//! cache is a defensive client-side check that catches an operator
//! retrying a deposit they previously sent — without paying gas to
//! discover the on-chain refusal. On a hit, the prior `tx_hash` is
//! surfaced so the operator can look up the original receipt.
//!
//! Storage shape: a single JSON file at `<state_dir>/submitted_order_ids.json`.
//! Concurrent access is serialised with `fs2` advisory locks (already a
//! dependency for `nonce::AgentLock`).

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read as _, Seek, SeekFrom, Write as _};
use std::path::{Path, PathBuf};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::errors::{Result, RmpcError};

/// On-disk filename, relative to the state dir.
pub const REPLAY_CACHE_FILENAME: &str = "submitted_order_ids.json";

/// One entry in the replay cache. Keyed by [`Entry::key`] which is the
/// hex concatenation of order_id || idempotency_key || deadline_be.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub order_id: String,
    pub idempotency_key: String,
    pub deadline: u64,
    pub tx_hash: String,
}

impl Entry {
    /// Stable cache key. The same triple from a retry must round-trip
    /// to the same string regardless of hex-prefix or case.
    pub fn key(order_id: &str, idempotency_key: &str, deadline: u64) -> String {
        format!(
            "{}|{}|{}",
            normalize_hex(order_id),
            normalize_hex(idempotency_key),
            deadline
        )
    }
}

fn normalize_hex(s: &str) -> String {
    s.strip_prefix("0x").unwrap_or(s).to_ascii_lowercase()
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
    1
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

    /// Return the prior tx_hash if `(order_id, idempotency_key,
    /// deadline)` was already submitted from this installation.
    pub fn lookup(
        &self,
        order_id: &str,
        idempotency_key: &str,
        deadline: u64,
    ) -> Result<Option<String>> {
        let key = Entry::key(order_id, idempotency_key, deadline);
        let map = self.read_locked()?;
        Ok(map.get(&key).map(|e| e.tx_hash.clone()))
    }

    /// Insert a new entry. Overwrites any existing entry with the same
    /// key (which would only happen if the prior insert lost a race
    /// before the broadcast actually returned a hash — and then we
    /// prefer the most recent observed tx_hash).
    pub fn insert(
        &self,
        order_id: &str,
        idempotency_key: &str,
        deadline: u64,
        tx_hash: &str,
    ) -> Result<()> {
        let key = Entry::key(order_id, idempotency_key, deadline);
        self.with_locked_file(|file, mut map| {
            map.insert(
                key,
                Entry {
                    order_id: normalize_hex(order_id),
                    idempotency_key: normalize_hex(idempotency_key),
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
                let k = Entry::key(&entry.order_id, &entry.idempotency_key, entry.deadline);
                map.insert(k, entry);
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
                    let k = Entry::key(&entry.order_id, &entry.idempotency_key, entry.deadline);
                    m.insert(k, entry);
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
    entries.sort_by(|a, b| a.order_id.cmp(&b.order_id));
    let payload = ReplayFile {
        version: 1,
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
    use tempfile::TempDir;

    #[test]
    fn miss_returns_none() {
        let dir = TempDir::new().unwrap();
        let cache = ReplayCache::open(dir.path()).unwrap();
        assert_eq!(cache.lookup("0xaa", "0xbb", 1).unwrap(), None);
    }

    #[test]
    fn insert_then_lookup_hits() {
        let dir = TempDir::new().unwrap();
        let cache = ReplayCache::open(dir.path()).unwrap();
        cache
            .insert("0xaa", "0xbb", 1700000000, "0xtxhash")
            .unwrap();
        let got = cache.lookup("0xaa", "0xbb", 1700000000).unwrap();
        assert_eq!(got, Some("0xtxhash".to_string()));
    }

    #[test]
    fn lookup_normalises_hex_prefix_and_case() {
        let dir = TempDir::new().unwrap();
        let cache = ReplayCache::open(dir.path()).unwrap();
        cache
            .insert("0xAA", "0xBB", 1700000000, "0xtxhash")
            .unwrap();
        // Without prefix, lower case — must hit.
        assert_eq!(
            cache.lookup("aa", "bb", 1700000000).unwrap(),
            Some("0xtxhash".to_string())
        );
    }

    #[test]
    fn different_deadline_misses() {
        let dir = TempDir::new().unwrap();
        let cache = ReplayCache::open(dir.path()).unwrap();
        cache.insert("0xaa", "0xbb", 1, "0xtxhash").unwrap();
        assert_eq!(cache.lookup("0xaa", "0xbb", 2).unwrap(), None);
    }

    #[test]
    fn different_idempotency_key_misses() {
        let dir = TempDir::new().unwrap();
        let cache = ReplayCache::open(dir.path()).unwrap();
        cache.insert("0xaa", "0xbb", 1, "0xtxhash").unwrap();
        assert_eq!(cache.lookup("0xaa", "0xcc", 1).unwrap(), None);
    }

    #[test]
    fn cache_persists_across_handles() {
        let dir = TempDir::new().unwrap();
        {
            let cache = ReplayCache::open(dir.path()).unwrap();
            cache.insert("0xaa", "0xbb", 1, "0xhash1").unwrap();
        }
        {
            let cache = ReplayCache::open(dir.path()).unwrap();
            assert_eq!(
                cache.lookup("0xaa", "0xbb", 1).unwrap(),
                Some("0xhash1".to_string())
            );
        }
    }

    #[test]
    fn second_insert_overwrites() {
        let dir = TempDir::new().unwrap();
        let cache = ReplayCache::open(dir.path()).unwrap();
        cache.insert("0xaa", "0xbb", 1, "0xfirst").unwrap();
        cache.insert("0xaa", "0xbb", 1, "0xsecond").unwrap();
        assert_eq!(
            cache.lookup("0xaa", "0xbb", 1).unwrap(),
            Some("0xsecond".to_string())
        );
    }
}
