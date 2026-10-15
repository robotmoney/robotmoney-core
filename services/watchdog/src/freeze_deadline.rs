//! Missed freeze-deadline alert (issue 1809, ADR-0014 §5; QA plan v1 L1).
//!
//! Canonical: `docs/adr/ADR-0014-governed-upgrades-and-freeze.md` §5 — a
//! proving-period deadline is an operational commitment, not an on-chain timer;
//! `docs/operations/contract-release-runbooks.md` §4.12 — Missed-deadline alert.
//!
//! # Why this exists
//!
//! A final release that ships `upgradeable` commits to freezing every proxy by
//! a deadline: the end of its proving period. Nothing on chain enforces that
//! date. A deployment stays upgradeable until `upgradesFrozen()` reads true on
//! every proxy, and the release owner checks it by hand on the deadline day.
//! P2 (issue 1809) left the automated alert for later. This is that alert.
//!
//! # What it does
//!
//! Before `deadline_unix` it reads nothing and stays quiet. From the deadline
//! on, every poll reads `upgradesFrozen()` on each configured proxy. One proxy
//! that reads false pages `freeze_deadline_missed:<chain>`, naming every
//! unfrozen proxy. The page resolves once all of them read true. A proxy the
//! poll cannot read is a read failure, logged every cycle and never taken as
//! frozen, exactly as the weight-setter check treats one ([`crate::governance`]).
//!
//! Read-only: `eth_call` only. It never pauses, upgrades or freezes anything.
//! The freeze itself is a Safe → timelock operation (`govern --row freeze-proxy`).

use reqwest::Client;
use serde::Deserialize;

use crate::governance::{decode_uint256_word, eth_call, is_hex_address};
use crate::WatchdogError;

/// `keccak256("upgradesFrozen()")[0..4]`: `GovernedUpgrade.upgradesFrozen()`.
///
/// Pinned as a literal and asserted against the signature text in the tests, so
/// a renamed view fails a unit test instead of returning empty data.
pub const UPGRADES_FROZEN_SELECTOR: &str = "0x6d439372";

/// Default seconds between two pages for the same missed deadline (one day).
/// The condition stays true until the Safe freezes the proxies, so the page
/// repeats daily rather than every poll.
pub const DEFAULT_FREEZE_DEADLINE_REPAGE_SECS: u64 = 86_400;

/// One governed proxy the check reads.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct FreezeProxy {
    /// The stage-table name of the proxy (`rmUSDC`, `registry`, `router`, …):
    /// the name the verifier labels and the `freeze-proxy` row use.
    pub name: String,
    /// The proxy address, `0x`-prefixed hex.
    pub address: String,
}

/// Configuration for the missed freeze-deadline alert (`[freeze_deadline]`).
///
/// Absent means disabled, so every existing watchdog config keeps parsing. A
/// deployment released `frozen-at-deploy` has nothing to watch; a release that
/// is `upgradeable` with a proving period enables it with the deadline the
/// release issue names.
#[derive(Debug, Clone, Deserialize)]
pub struct FreezeDeadlineConfig {
    /// Whether the check runs at all.
    #[serde(default)]
    pub enabled: bool,
    /// JSON-RPC endpoint used for the `eth_call`s.
    #[serde(default)]
    pub rpc_url: Option<String>,
    /// The freeze deadline the release issue names, Unix seconds (UTC).
    #[serde(default)]
    pub deadline_unix: Option<i64>,
    /// Every proxy of the deployment (ADR-0014 §1: nine). A release may call
    /// its core logic immutable only when all of them read frozen.
    #[serde(default)]
    pub proxies: Vec<FreezeProxy>,
    /// Floor between two pages for the same missed deadline.
    #[serde(default = "default_freeze_deadline_repage_secs")]
    pub repage_secs: u64,
}

fn default_freeze_deadline_repage_secs() -> u64 {
    DEFAULT_FREEZE_DEADLINE_REPAGE_SECS
}

impl Default for FreezeDeadlineConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            rpc_url: None,
            deadline_unix: None,
            proxies: Vec::new(),
            repage_secs: DEFAULT_FREEZE_DEADLINE_REPAGE_SECS,
        }
    }
}

impl FreezeDeadlineConfig {
    /// Refuse a configuration that would silently watch nothing.
    ///
    /// An enabled check with no RPC URL, no deadline or no proxy cannot tell a
    /// missed freeze from a kept one, and that blindness must not be reachable
    /// by omission. A disabled section is never refused.
    pub fn validate(&self) -> Result<(), WatchdogError> {
        if !self.enabled {
            return Ok(());
        }
        if self.rpc_url.as_deref().unwrap_or("").is_empty() {
            return Err(WatchdogError::Config(
                "freeze_deadline.rpc_url is required when freeze_deadline.enabled = true".into(),
            ));
        }
        match self.deadline_unix {
            Some(d) if d > 0 => {}
            other => {
                return Err(WatchdogError::Config(format!(
                    "freeze_deadline.deadline_unix must be the release's freeze deadline in Unix \
                     seconds, got {other:?}"
                )))
            }
        }
        if self.proxies.is_empty() {
            return Err(WatchdogError::Config(
                "freeze_deadline.proxies is empty: list every proxy of the deployment \
                 (ADR-0014 §1), or the check proves nothing"
                    .into(),
            ));
        }
        if self.repage_secs == 0 {
            return Err(WatchdogError::Config(
                "freeze_deadline.repage_secs must be positive".into(),
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for p in &self.proxies {
            if p.name.trim().is_empty() {
                return Err(WatchdogError::Config(
                    "freeze_deadline.proxies has an entry with no name".into(),
                ));
            }
            if !is_hex_address(&p.address) {
                return Err(WatchdogError::Config(format!(
                    "freeze_deadline.proxies {}: address must be a 0x-prefixed 20-byte hex \
                     address, got {:?}",
                    p.name, p.address
                )));
            }
            if !seen.insert(p.address.to_ascii_lowercase()) {
                return Err(WatchdogError::Config(format!(
                    "freeze_deadline.proxies lists {} twice",
                    p.address
                )));
            }
        }
        Ok(())
    }
}

/// What one freeze-deadline cycle observed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FreezeDeadlineStatus {
    /// The deadline has not passed: nothing was read.
    BeforeDeadline,
    /// The deadline passed and every configured proxy reads frozen.
    AllFrozen,
    /// The deadline passed and at least one proxy reads unfrozen.
    Missed(FreezeDeadlineBreach),
}

/// A freeze deadline that passed with a proxy still upgradeable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FreezeDeadlineBreach {
    /// Chain the proxies live on.
    pub chain_id: i64,
    /// The configured deadline, Unix seconds.
    pub deadline_unix: i64,
    /// When the cycle read the proxies, Unix seconds.
    pub observed_at_unix: i64,
    /// Every proxy that reads `upgradesFrozen() == false`.
    pub unfrozen: Vec<FreezeProxy>,
    /// How many proxies the check reads in total.
    pub proxy_count: usize,
}

impl FreezeDeadlineBreach {
    /// Whole days since the deadline, rounded down (0 on the deadline day).
    pub fn days_overdue(&self) -> i64 {
        (self.observed_at_unix - self.deadline_unix).max(0) / 86_400
    }
}

/// Pure classifier: has the deadline passed with a proxy still upgradeable?
///
/// `frozen` holds the read of each configured proxy, in the configured order.
pub fn classify_freeze_deadline(
    cfg: &FreezeDeadlineConfig,
    chain_id: i64,
    now_unix: i64,
    frozen: &[(FreezeProxy, bool)],
) -> FreezeDeadlineStatus {
    let deadline = cfg.deadline_unix.unwrap_or(i64::MAX);
    if now_unix < deadline {
        return FreezeDeadlineStatus::BeforeDeadline;
    }
    let unfrozen: Vec<FreezeProxy> = frozen
        .iter()
        .filter(|(_, is_frozen)| !is_frozen)
        .map(|(p, _)| p.clone())
        .collect();
    if unfrozen.is_empty() {
        return FreezeDeadlineStatus::AllFrozen;
    }
    FreezeDeadlineStatus::Missed(FreezeDeadlineBreach {
        chain_id,
        deadline_unix: deadline,
        observed_at_unix: now_unix,
        unfrozen,
        proxy_count: frozen.len(),
    })
}

/// Decode a 32-byte ABI `bool` word. Anything but 0 or 1 is not a bool and is
/// refused, so a wrong address can never read as frozen.
pub fn decode_bool_word(raw: &str, what: &str) -> Result<bool, WatchdogError> {
    match decode_uint256_word(raw, what)? {
        0 => Ok(false),
        1 => Ok(true),
        other => Err(WatchdogError::Config(format!(
            "{what} returned {other}, which is not an ABI-encoded bool"
        ))),
    }
}

/// Read `upgradesFrozen()` on every configured proxy once the deadline has
/// passed, and classify the result. Before the deadline it reads nothing.
pub async fn check_freeze_deadline(
    client: &Client,
    cfg: &FreezeDeadlineConfig,
    chain_id: i64,
    now_unix: i64,
) -> Result<FreezeDeadlineStatus, WatchdogError> {
    if now_unix < cfg.deadline_unix.unwrap_or(i64::MAX) {
        return Ok(FreezeDeadlineStatus::BeforeDeadline);
    }
    let rpc_url = cfg.rpc_url.as_deref().ok_or_else(|| {
        WatchdogError::Config("freeze_deadline.rpc_url is unset but the check is enabled".into())
    })?;
    let mut frozen = Vec::with_capacity(cfg.proxies.len());
    for p in &cfg.proxies {
        let what = format!("{} ({}) upgradesFrozen()", p.name, p.address);
        let raw = eth_call(client, rpc_url, &p.address, UPGRADES_FROZEN_SELECTOR, &what).await?;
        frozen.push((p.clone(), decode_bool_word(&raw, &what)?));
    }
    Ok(classify_freeze_deadline(cfg, chain_id, now_unix, &frozen))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEADLINE: i64 = 1_800_000_000;

    fn proxy(name: &str, n: u8) -> FreezeProxy {
        FreezeProxy {
            name: name.into(),
            address: format!("0x{}", format!("{n:02x}").repeat(20)),
        }
    }

    fn cfg() -> FreezeDeadlineConfig {
        FreezeDeadlineConfig {
            enabled: true,
            rpc_url: Some("http://127.0.0.1:18545".into()),
            deadline_unix: Some(DEADLINE),
            proxies: vec![proxy("rmUSDC", 0x11), proxy("registry", 0x22)],
            repage_secs: 86_400,
        }
    }

    #[test]
    fn before_the_deadline_nothing_pages_even_with_unfrozen_proxies() {
        let reads = [
            (proxy("rmUSDC", 0x11), false),
            (proxy("registry", 0x22), false),
        ];
        assert_eq!(
            classify_freeze_deadline(&cfg(), 8_453, DEADLINE - 1, &reads),
            FreezeDeadlineStatus::BeforeDeadline
        );
    }

    #[test]
    fn after_the_deadline_one_unfrozen_proxy_pages_and_is_named() {
        let reads = [
            (proxy("rmUSDC", 0x11), true),
            (proxy("registry", 0x22), false),
        ];
        match classify_freeze_deadline(&cfg(), 8_453, DEADLINE + 3 * 86_400 + 5, &reads) {
            FreezeDeadlineStatus::Missed(b) => {
                assert_eq!(b.chain_id, 8_453);
                assert_eq!(b.unfrozen, vec![proxy("registry", 0x22)]);
                assert_eq!(b.proxy_count, 2);
                assert_eq!(b.days_overdue(), 3);
            }
            other => panic!("an unfrozen proxy after the deadline must page, got {other:?}"),
        }
    }

    #[test]
    fn on_the_deadline_second_the_check_is_live() {
        let reads = [
            (proxy("rmUSDC", 0x11), false),
            (proxy("registry", 0x22), false),
        ];
        assert!(matches!(
            classify_freeze_deadline(&cfg(), 1, DEADLINE, &reads),
            FreezeDeadlineStatus::Missed(_)
        ));
    }

    #[test]
    fn every_proxy_frozen_after_the_deadline_is_quiet() {
        let reads = [
            (proxy("rmUSDC", 0x11), true),
            (proxy("registry", 0x22), true),
        ];
        assert_eq!(
            classify_freeze_deadline(&cfg(), 1, DEADLINE + 1, &reads),
            FreezeDeadlineStatus::AllFrozen
        );
    }

    #[test]
    fn the_selector_matches_its_signature() {
        use alloy_primitives::keccak256;
        let sel = format!("0x{}", hex::encode(&keccak256(b"upgradesFrozen()")[..4]));
        assert_eq!(sel, UPGRADES_FROZEN_SELECTOR);
    }

    #[test]
    fn bool_words_decode_and_anything_else_is_a_read_failure() {
        let word = |v: u64| format!("0x{v:064x}");
        assert!(!decode_bool_word(&word(0), "f").unwrap());
        assert!(decode_bool_word(&word(1), "f").unwrap());
        assert!(decode_bool_word(&word(2), "f").is_err());
        // a wrong address returns "0x": never frozen, never unfrozen, a read failure
        assert!(decode_bool_word("0x", "f").is_err());
    }

    #[test]
    fn an_enabled_check_refuses_to_start_blind() {
        let mut c = cfg();
        c.rpc_url = None;
        assert!(format!("{}", c.validate().unwrap_err()).contains("rpc_url"));
        let mut c = cfg();
        c.deadline_unix = None;
        assert!(format!("{}", c.validate().unwrap_err()).contains("deadline_unix"));
        let mut c = cfg();
        c.proxies.clear();
        assert!(format!("{}", c.validate().unwrap_err()).contains("proxies is empty"));
        let mut c = cfg();
        c.proxies[1].address = "not-an-address".into();
        assert!(format!("{}", c.validate().unwrap_err()).contains("registry"));
        let mut c = cfg();
        c.proxies[1].address = c.proxies[0]
            .address
            .to_ascii_uppercase()
            .replacen("0X", "0x", 1);
        assert!(format!("{}", c.validate().unwrap_err()).contains("twice"));
        assert!(cfg().validate().is_ok());
    }

    #[test]
    fn a_disabled_or_absent_section_never_refuses_a_configuration() {
        let c = FreezeDeadlineConfig::default();
        assert!(!c.enabled);
        assert!(c.validate().is_ok());
        assert_eq!(c.repage_secs, DEFAULT_FREEZE_DEADLINE_REPAGE_SECS);
    }
}
