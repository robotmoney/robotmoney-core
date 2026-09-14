//! Standing check on `RouterGovernance.quorumThreshold()` (task T22, decision D16).
//!
//! Canonical: `docs/technical/router-governance-handoff-runbook.md` §1.1;
//! `docs/governance-decisions.md`; `AC-GOV-03` ("quorum 2 of total voting
//! power 2").
//!
//! # Why a standing monitor and not only a contract floor
//!
//! `MIN_QUORUM_THRESHOLD` is raised to `2` in the contract, and both deploy
//! entrypoints refuse `1`. That fixes every *future* deployment. It does not
//! cover the chain that is already live: an `ADMIN_ROLE` holder calling
//! `setQuorumThreshold` on a deployed router is the one way `AC-GOV-03`'s
//! evidence can be undone **after** it was collected, and no rehearsal
//! postcondition re-runs to notice. Decision D16 therefore requires both: the
//! floor in the contract, and this page.
//!
//! Read-only: a single `eth_call`. This path never pauses and never writes.

use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::WatchdogError;

/// `keccak256("quorumThreshold()")[0..4]` — the view selector this check reads.
///
/// Pinned as a literal (and asserted against the signature text in the tests)
/// so a silent ABI drift shows up as a failing unit test rather than as an
/// `eth_call` that returns empty data and reads as health.
pub const QUORUM_THRESHOLD_SELECTOR: &str = "0x7b7a91dd";

/// Floor below which the router's quorum threshold is a governance fault.
///
/// Decision D16. A threshold of `1` means one voter is a quorum, which is not
/// the two-of-two arrangement `AC-GOV-03` was accepted on.
pub const DEFAULT_MIN_QUORUM_THRESHOLD: u64 = 2;

/// Default seconds between two pages for the same standing quorum fault.
pub const DEFAULT_QUORUM_REPAGE_SECS: u64 = 3_600;

/// Configuration for the standing quorum-floor check.
///
/// Absent means disabled, so every existing watchdog config keeps parsing.
#[derive(Debug, Clone, Deserialize)]
pub struct QuorumMonitorConfig {
    /// Whether the check runs at all.
    #[serde(default)]
    pub enabled: bool,
    /// JSON-RPC endpoint used for the `eth_call`.
    #[serde(default)]
    pub rpc_url: Option<String>,
    /// `RouterGovernance` address, `0x`-prefixed hex.
    #[serde(default)]
    pub router_address: Option<String>,
    /// Threshold at or below which the check pages.
    #[serde(default = "default_min_quorum_threshold")]
    pub min_quorum_threshold: u64,
    /// Floor between two pages for the same standing fault.
    #[serde(default = "default_quorum_repage_secs")]
    pub repage_secs: u64,
}

fn default_min_quorum_threshold() -> u64 {
    DEFAULT_MIN_QUORUM_THRESHOLD
}

fn default_quorum_repage_secs() -> u64 {
    DEFAULT_QUORUM_REPAGE_SECS
}

impl Default for QuorumMonitorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            rpc_url: None,
            router_address: None,
            min_quorum_threshold: DEFAULT_MIN_QUORUM_THRESHOLD,
            repage_secs: DEFAULT_QUORUM_REPAGE_SECS,
        }
    }
}

impl QuorumMonitorConfig {
    /// Refuse a configuration that would silently monitor nothing.
    ///
    /// An enabled check with no RPC URL or no router address cannot read the
    /// threshold, and "cannot read" must not be reachable by omission: it would
    /// log an error every cycle and be indistinguishable from a healthy chain
    /// to anyone reading only the alert receiver.
    pub fn validate(&self) -> Result<(), WatchdogError> {
        if !self.enabled {
            return Ok(());
        }
        if self.rpc_url.as_deref().unwrap_or("").is_empty() {
            return Err(WatchdogError::Config(
                "governance.rpc_url is required when governance.enabled = true".into(),
            ));
        }
        let addr = self.router_address.as_deref().unwrap_or("");
        if !is_hex_address(addr) {
            return Err(WatchdogError::Config(format!(
                "governance.router_address must be a 0x-prefixed 20-byte hex address, got {addr:?}"
            )));
        }
        if self.min_quorum_threshold == 0 {
            return Err(WatchdogError::Config(
                "governance.min_quorum_threshold must be non-zero — a floor of 0 can never fire"
                    .into(),
            ));
        }
        Ok(())
    }
}

/// True for a `0x`-prefixed 20-byte hex address.
pub fn is_hex_address(s: &str) -> bool {
    let Some(body) = s.strip_prefix("0x") else {
        return false;
    };
    body.len() == 40 && body.chars().all(|c| c.is_ascii_hexdigit())
}

/// What one quorum-floor cycle observed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuorumStatus {
    /// `quorumThreshold() > min_quorum_threshold - 1`, i.e. at or above the floor.
    Ok {
        /// The threshold read from the chain.
        threshold: u64,
    },
    /// The threshold is at or below the configured floor. A governance fault.
    BelowFloor(QuorumBreach),
}

/// A quorum threshold at or below the floor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuorumBreach {
    /// Chain the router lives on.
    pub chain_id: i64,
    /// Router address as configured.
    pub router_address: String,
    /// The threshold read from the chain.
    pub threshold: u64,
    /// The configured floor.
    pub min_threshold: u64,
}

/// Pure classifier: is this threshold a fault?
///
/// The condition is `threshold < min_threshold`. With the D16 floor of 2 that
/// is exactly `quorumThreshold() <= 1`, which is how the task states it.
pub fn classify_quorum(cfg: &QuorumMonitorConfig, chain_id: i64, threshold: u64) -> QuorumStatus {
    if threshold < cfg.min_quorum_threshold {
        QuorumStatus::BelowFloor(QuorumBreach {
            chain_id,
            router_address: cfg.router_address.clone().unwrap_or_default(),
            threshold,
            min_threshold: cfg.min_quorum_threshold,
        })
    } else {
        QuorumStatus::Ok { threshold }
    }
}

/// Decode a 32-byte ABI word returned by `quorumThreshold()`.
///
/// Refuses empty data explicitly. `eth_call` against a wrong address — a
/// mistyped router, or an address with no code — returns `"0x"`, and treating
/// that as `0` would page on a configuration error while treating it as health
/// would hide a real one. It is neither: it is a read failure.
pub fn decode_uint256_word(raw: &str) -> Result<u64, WatchdogError> {
    let body = raw.strip_prefix("0x").unwrap_or(raw);
    if body.is_empty() {
        return Err(WatchdogError::Config(
            "quorumThreshold() returned empty data — the configured router address has no code, \
             or is not a RouterGovernance"
                .into(),
        ));
    }
    if body.len() != 64 || !body.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(WatchdogError::Config(format!(
            "quorumThreshold() returned {body:?}, which is not one 32-byte ABI word"
        )));
    }
    // A quorum threshold beyond u64 is not a real configuration; saturate
    // rather than wrap, so an absurd value can never read as below the floor.
    let (high, low) = body.split_at(48);
    if high.chars().any(|c| c != '0') {
        return Ok(u64::MAX);
    }
    u64::from_str_radix(low, 16).map_err(|e| {
        WatchdogError::Config(format!(
            "quorumThreshold() word {body:?} is not a number: {e}"
        ))
    })
}

/// `eth_call` `quorumThreshold()` on the configured router and decode it.
pub async fn read_quorum_threshold(
    client: &Client,
    rpc_url: &str,
    router_address: &str,
) -> Result<u64, WatchdogError> {
    let req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_call",
        "params": [
            {"to": router_address, "data": QUORUM_THRESHOLD_SELECTOR},
            "latest"
        ]
    });
    let resp =
        client.post(rpc_url).json(&req).send().await.map_err(|e| {
            WatchdogError::Config(format!("quorumThreshold() eth_call failed: {e}"))
        })?;
    let body: Value = resp.json().await.map_err(|e| {
        WatchdogError::Config(format!("quorumThreshold() response parse failed: {e}"))
    })?;
    if let Some(err) = body.get("error") {
        return Err(WatchdogError::Config(format!(
            "quorumThreshold() RPC error: {err}"
        )));
    }
    let raw = body["result"].as_str().ok_or_else(|| {
        WatchdogError::Config(format!(
            "quorumThreshold() returned no result field: {body}"
        ))
    })?;
    decode_uint256_word(raw)
}

/// Read and classify in one call.
pub async fn check_quorum_floor(
    client: &Client,
    cfg: &QuorumMonitorConfig,
    chain_id: i64,
) -> Result<QuorumStatus, WatchdogError> {
    let rpc_url = cfg.rpc_url.as_deref().ok_or_else(|| {
        WatchdogError::Config("governance.rpc_url is unset but the check is enabled".into())
    })?;
    let router = cfg.router_address.as_deref().ok_or_else(|| {
        WatchdogError::Config("governance.router_address is unset but the check is enabled".into())
    })?;
    let threshold = read_quorum_threshold(client, rpc_url, router).await?;
    Ok(classify_quorum(cfg, chain_id, threshold))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> QuorumMonitorConfig {
        QuorumMonitorConfig {
            enabled: true,
            rpc_url: Some("http://127.0.0.1:18545".into()),
            router_address: Some(format!("0x{}", "ab".repeat(20))),
            min_quorum_threshold: 2,
            repage_secs: 3_600,
        }
    }

    fn word(v: u64) -> String {
        format!("0x{v:064x}")
    }

    #[test]
    fn a_threshold_of_one_is_a_fault_under_the_d16_floor() {
        match classify_quorum(&cfg(), 918_453, 1) {
            QuorumStatus::BelowFloor(b) => {
                assert_eq!(b.threshold, 1);
                assert_eq!(b.min_threshold, 2);
                assert_eq!(b.chain_id, 918_453);
            }
            other => panic!("quorumThreshold()==1 must page, got {other:?}"),
        }
    }

    #[test]
    fn a_threshold_of_zero_is_a_fault_too() {
        assert!(matches!(
            classify_quorum(&cfg(), 918_453, 0),
            QuorumStatus::BelowFloor(_)
        ));
    }

    #[test]
    fn the_accepted_two_of_two_arrangement_is_quiet() {
        assert_eq!(
            classify_quorum(&cfg(), 918_453, 2),
            QuorumStatus::Ok { threshold: 2 }
        );
        assert_eq!(
            classify_quorum(&cfg(), 918_453, 7),
            QuorumStatus::Ok { threshold: 7 }
        );
    }

    #[test]
    fn the_selector_matches_the_function_signature() {
        // keccak256("quorumThreshold()")[0..4]; recomputed here so a rename of
        // the view cannot pass silently.
        use alloy_primitives::keccak256;
        let hash = keccak256(b"quorumThreshold()");
        assert_eq!(
            format!("0x{}", hex::encode(&hash[..4])),
            QUORUM_THRESHOLD_SELECTOR
        );
    }

    #[test]
    fn a_word_decodes_to_its_value() {
        assert_eq!(decode_uint256_word(&word(0)).unwrap(), 0);
        assert_eq!(decode_uint256_word(&word(1)).unwrap(), 1);
        assert_eq!(decode_uint256_word(&word(2)).unwrap(), 2);
        assert_eq!(decode_uint256_word(&word(u64::MAX)).unwrap(), u64::MAX);
    }

    #[test]
    fn empty_call_data_is_a_read_failure_not_a_zero_threshold() {
        // The regression that matters: a wrong router address returns "0x".
        // Decoding that as 0 would page for the wrong reason; decoding it as
        // "fine" would hide a blind check. It must be an error.
        let err = decode_uint256_word("0x").unwrap_err();
        assert!(
            format!("{err}").contains("empty data"),
            "unexpected error: {err}"
        );
        assert!(decode_uint256_word("0xdeadbeef").is_err());
    }

    #[test]
    fn an_absurd_threshold_saturates_upward_and_never_reads_as_below_the_floor() {
        let huge = format!("0x{}", "f".repeat(64));
        assert_eq!(decode_uint256_word(&huge).unwrap(), u64::MAX);
        assert!(matches!(
            classify_quorum(&cfg(), 1, decode_uint256_word(&huge).unwrap()),
            QuorumStatus::Ok { .. }
        ));
    }

    #[test]
    fn an_enabled_check_refuses_to_start_without_somewhere_to_read_from() {
        let mut c = cfg();
        c.rpc_url = None;
        assert!(c.validate().is_err());

        let mut c = cfg();
        c.router_address = Some("not-an-address".into());
        assert!(c.validate().is_err());

        let mut c = cfg();
        c.min_quorum_threshold = 0;
        assert!(c.validate().is_err());

        assert!(cfg().validate().is_ok());
    }

    #[test]
    fn a_disabled_check_never_refuses_a_configuration() {
        let c = QuorumMonitorConfig::default();
        assert!(!c.enabled);
        assert!(c.validate().is_ok());
        assert_eq!(c.min_quorum_threshold, DEFAULT_MIN_QUORUM_THRESHOLD);
    }
}
