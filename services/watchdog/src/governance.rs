//! Standing check on the router's weight-setter path (issue 1698, QA plan v1
//! leftovers L1).
//!
//! Canonical: `docs/architecture.md` §5.6; `docs/technical/governance-decisions.md`
//! §3.2 and §3.7 (a receipt is applied, not voted on); ADR-0002 (weight-setter
//! rotation).
//!
//! # What this replaced
//!
//! This module used to read the weight setter's `quorumThreshold()` view (task
//! T22, decision D16). Issue 1698 deleted the voting path with that view, so the old
//! check could only log a read failure every cycle and page nobody. There is no
//! quorum left to watch.
//!
//! # What it watches now
//!
//! Router weights change only through `RouterGovernance.applyReceipt`, which the
//! Safe schedules through the timelock. Three role sets make that true:
//!
//! 1. The router's `WEIGHT_SETTER_ROLE` is held by exactly one account, the
//!    configured weight setter (`RouterGovernance`). Any other holder can call
//!    `PortfolioRouter.setWeights` directly, with no receipt and no delay.
//! 2. The weight setter's own `WEIGHT_SETTER_ROLE` (the only role that may call
//!    `applyReceipt`, self-administered) is held by exactly one account, the
//!    configured `TimelockController`. Any other holder can apply a recorded
//!    receipt without waiting the timelock delay.
//! 3. The weight setter's `ADMIN_ROLE` is held by exactly one account, the
//!    timelock. Any other holder can call `setDefaultWeights` (and, on a
//!    router from before issue 1988, its clear of the applied vector) without
//!    waiting the timelock delay.
//!
//! The stage 12 verifier checks these once, at deploy. A grant executed after
//! that undoes the evidence, and only a standing check notices it. A deliberate
//! weight-setter rotation (ADR-0002) also fires this page until the operator
//! updates `weight_setter_address`; the page names the new holder.
//!
//! Read-only: `eth_call` only. This path never pauses and never writes.

use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::WatchdogError;

/// `keccak256("getRoleMemberCount(bytes32)")[0..4]`.
///
/// Pinned as a literal (and asserted against the signature text in the tests)
/// so a silent ABI drift shows up as a failing unit test rather than as an
/// `eth_call` that returns empty data.
pub const GET_ROLE_MEMBER_COUNT_SELECTOR: &str = "0xca15c873";

/// `keccak256("getRoleMember(bytes32,uint256)")[0..4]`.
pub const GET_ROLE_MEMBER_SELECTOR: &str = "0x9010d07c";

/// `keccak256("WEIGHT_SETTER_ROLE")`, hex without `0x`: `PortfolioRouter.WEIGHT_SETTER_ROLE`
/// and `RouterGovernance.WEIGHT_SETTER_ROLE` (same role id on both contracts).
pub const WEIGHT_SETTER_ROLE: &str =
    "a2edfd05c0c1cda238b1c99a8a31252998b19153c63b3f9e5b7048bc4b5f4a3f";

/// `keccak256("ADMIN_ROLE")`, hex without `0x`: `RouterGovernance.ADMIN_ROLE`.
pub const ADMIN_ROLE: &str = "a49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775";

/// Most role members one cycle lists. Exactly one is expected, so any count
/// above one is already a drift; the cap only bounds the reads a hostile grant
/// spree could cost.
pub const MAX_LISTED_MEMBERS: u64 = 16;

/// Default seconds between two pages for the same standing drift.
pub const DEFAULT_WEIGHT_SETTER_REPAGE_SECS: u64 = 3_600;

/// Configuration for the standing weight-setter-path check (`[governance]`).
///
/// Absent means disabled, so every existing watchdog config keeps parsing.
#[derive(Debug, Clone, Deserialize)]
pub struct WeightSetterMonitorConfig {
    /// Whether the check runs at all.
    #[serde(default)]
    pub enabled: bool,
    /// JSON-RPC endpoint used for the `eth_call`s.
    #[serde(default)]
    pub rpc_url: Option<String>,
    /// `PortfolioRouter` address, `0x`-prefixed hex.
    #[serde(default)]
    pub router_address: Option<String>,
    /// `RouterGovernance` address: the one expected `WEIGHT_SETTER_ROLE` holder.
    #[serde(default)]
    pub weight_setter_address: Option<String>,
    /// `TimelockController` address: the one expected `WEIGHT_SETTER_ROLE` and
    /// `ADMIN_ROLE` holder on the weight setter.
    #[serde(default)]
    pub timelock_address: Option<String>,
    /// Floor between two pages for the same standing drift.
    #[serde(default = "default_weight_setter_repage_secs")]
    pub repage_secs: u64,
    /// Pre-1698 key of the deleted quorum check. Read only so an enabled
    /// section that still carries it is refused with a reason, rather than
    /// silently reinterpreted.
    #[serde(default)]
    pub min_quorum_threshold: Option<u64>,
}

fn default_weight_setter_repage_secs() -> u64 {
    DEFAULT_WEIGHT_SETTER_REPAGE_SECS
}

impl Default for WeightSetterMonitorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            rpc_url: None,
            router_address: None,
            weight_setter_address: None,
            timelock_address: None,
            repage_secs: DEFAULT_WEIGHT_SETTER_REPAGE_SECS,
            min_quorum_threshold: None,
        }
    }
}

impl WeightSetterMonitorConfig {
    /// Refuse a configuration that would silently monitor nothing.
    ///
    /// An enabled check with no RPC URL or a missing address cannot read the
    /// role sets, and "cannot read" must not be reachable by omission: it would
    /// log an error every cycle and be indistinguishable from a healthy chain
    /// to anyone reading only the alert receiver. A disabled section is never
    /// refused, so a stale key there cannot stop the volume monitor.
    pub fn validate(&self) -> Result<(), WatchdogError> {
        if !self.enabled {
            return Ok(());
        }
        if self.min_quorum_threshold.is_some() {
            return Err(WatchdogError::Config(
                "governance.min_quorum_threshold belongs to the deleted quorum check (issue 1698): \
                 remove it, and set governance.router_address (PortfolioRouter), \
                 governance.weight_setter_address (RouterGovernance) and \
                 governance.timelock_address"
                    .into(),
            ));
        }
        if self.rpc_url.as_deref().unwrap_or("").is_empty() {
            return Err(WatchdogError::Config(
                "governance.rpc_url is required when governance.enabled = true".into(),
            ));
        }
        for (key, value) in [
            ("router_address", &self.router_address),
            ("weight_setter_address", &self.weight_setter_address),
            ("timelock_address", &self.timelock_address),
        ] {
            let addr = value.as_deref().unwrap_or("");
            if !is_hex_address(addr) {
                return Err(WatchdogError::Config(format!(
                    "governance.{key} must be a 0x-prefixed 20-byte hex address, got {addr:?}"
                )));
            }
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

/// One role's members as read from the chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleMembers {
    /// `getRoleMemberCount(role)`.
    pub count: u64,
    /// The first `min(count, MAX_LISTED_MEMBERS)` members, lowercase `0x` hex.
    pub members: Vec<String>,
}

impl RoleMembers {
    /// True when the role has exactly one member and it is `expected`.
    pub fn is_exactly(&self, expected: &str) -> bool {
        self.count == 1 && self.members.len() == 1 && self.members[0].eq_ignore_ascii_case(expected)
    }
}

/// What one weight-setter-path cycle observed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WeightSetterStatus {
    /// All three role sets are exactly the configured path.
    Ok,
    /// At least one role set differs from the configured path.
    Drifted(WeightSetterBreach),
}

/// A weight-setter path that is not the configured one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WeightSetterBreach {
    /// Chain the router lives on.
    pub chain_id: i64,
    /// `PortfolioRouter` address as configured.
    pub router_address: String,
    /// Expected sole `WEIGHT_SETTER_ROLE` holder (`RouterGovernance`).
    pub weight_setter_address: String,
    /// Expected sole `WEIGHT_SETTER_ROLE` and `ADMIN_ROLE` holder on the weight
    /// setter (the timelock).
    pub timelock_address: String,
    /// The router's `WEIGHT_SETTER_ROLE` members as read.
    pub weight_setter_role: RoleMembers,
    /// The weight setter's own `WEIGHT_SETTER_ROLE` members as read: who may
    /// call `applyReceipt`.
    pub weight_setter_appliers: RoleMembers,
    /// The weight setter's `ADMIN_ROLE` members as read.
    pub weight_setter_admins: RoleMembers,
}

/// Pure classifier: are these three role sets the configured path?
pub fn classify_weight_setter_path(
    cfg: &WeightSetterMonitorConfig,
    chain_id: i64,
    weight_setter_role: RoleMembers,
    weight_setter_appliers: RoleMembers,
    weight_setter_admins: RoleMembers,
) -> WeightSetterStatus {
    let setter = cfg.weight_setter_address.clone().unwrap_or_default();
    let timelock = cfg.timelock_address.clone().unwrap_or_default();
    if weight_setter_role.is_exactly(&setter)
        && weight_setter_appliers.is_exactly(&timelock)
        && weight_setter_admins.is_exactly(&timelock)
    {
        return WeightSetterStatus::Ok;
    }
    WeightSetterStatus::Drifted(WeightSetterBreach {
        chain_id,
        router_address: cfg.router_address.clone().unwrap_or_default(),
        weight_setter_address: setter,
        timelock_address: timelock,
        weight_setter_role,
        weight_setter_appliers,
        weight_setter_admins,
    })
}

/// Hex body of a 32-byte word, after the `0x`, checked for shape.
///
/// Refuses empty data explicitly. `eth_call` against a wrong address (a
/// mistyped router, or an address with no code) returns `"0x"`, and treating
/// that as zero members would page on a configuration error while treating it
/// as health would hide a real one. It is neither: it is a read failure.
fn word_body<'a>(raw: &'a str, what: &str) -> Result<&'a str, WatchdogError> {
    let body = raw.strip_prefix("0x").unwrap_or(raw);
    if body.is_empty() {
        return Err(WatchdogError::Config(format!(
            "{what} returned empty data — the configured address has no code, \
             or is not the contract this check expects"
        )));
    }
    if body.len() != 64 || !body.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(WatchdogError::Config(format!(
            "{what} returned {body:?}, which is not one 32-byte ABI word"
        )));
    }
    Ok(body)
}

/// Decode a 32-byte ABI `uint256` word. A value beyond `u64` saturates
/// upward, so an absurd count can never read as "exactly one".
pub fn decode_uint256_word(raw: &str, what: &str) -> Result<u64, WatchdogError> {
    let body = word_body(raw, what)?;
    let (high, low) = body.split_at(48);
    if high.chars().any(|c| c != '0') {
        return Ok(u64::MAX);
    }
    u64::from_str_radix(low, 16)
        .map_err(|e| WatchdogError::Config(format!("{what} word {body:?} is not a number: {e}")))
}

/// Decode a 32-byte ABI `address` word to lowercase `0x` hex. A word whose
/// top 12 bytes are not zero is not an address and is refused.
pub fn decode_address_word(raw: &str, what: &str) -> Result<String, WatchdogError> {
    let body = word_body(raw, what)?;
    let (pad, addr) = body.split_at(24);
    if pad.chars().any(|c| c != '0') {
        return Err(WatchdogError::Config(format!(
            "{what} returned {body:?}, which is not an ABI-encoded address"
        )));
    }
    Ok(format!("0x{}", addr.to_ascii_lowercase()))
}

/// One `eth_call` at `latest`; returns the `result` hex string.
pub(crate) async fn eth_call(
    client: &Client,
    rpc_url: &str,
    to: &str,
    data: &str,
    what: &str,
) -> Result<String, WatchdogError> {
    let req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_call",
        "params": [{"to": to, "data": data}, "latest"]
    });
    let resp = client
        .post(rpc_url)
        .json(&req)
        .send()
        .await
        .map_err(|e| WatchdogError::Config(format!("{what} eth_call failed: {e}")))?;
    let body: Value = resp
        .json()
        .await
        .map_err(|e| WatchdogError::Config(format!("{what} response parse failed: {e}")))?;
    if let Some(err) = body.get("error") {
        return Err(WatchdogError::Config(format!("{what} RPC error: {err}")));
    }
    body["result"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| WatchdogError::Config(format!("{what} returned no result field: {body}")))
}

/// Read one role's member count and its first `MAX_LISTED_MEMBERS` members.
///
/// `role` is the 32-byte role id as 64 hex characters without `0x`.
pub async fn read_role_members(
    client: &Client,
    rpc_url: &str,
    contract: &str,
    role: &str,
    label: &str,
) -> Result<RoleMembers, WatchdogError> {
    let what = format!("{label} getRoleMemberCount()");
    let data = format!("{GET_ROLE_MEMBER_COUNT_SELECTOR}{role}");
    let count = decode_uint256_word(
        &eth_call(client, rpc_url, contract, &data, &what).await?,
        &what,
    )?;
    let mut members = Vec::new();
    for i in 0..count.min(MAX_LISTED_MEMBERS) {
        let what = format!("{label} getRoleMember({i})");
        let data = format!("{GET_ROLE_MEMBER_SELECTOR}{role}{i:064x}");
        members.push(decode_address_word(
            &eth_call(client, rpc_url, contract, &data, &what).await?,
            &what,
        )?);
    }
    Ok(RoleMembers { count, members })
}

/// Read the three role sets and classify them in one call.
pub async fn check_weight_setter_path(
    client: &Client,
    cfg: &WeightSetterMonitorConfig,
    chain_id: i64,
) -> Result<WeightSetterStatus, WatchdogError> {
    let unset = |key: &str| {
        WatchdogError::Config(format!(
            "governance.{key} is unset but the check is enabled"
        ))
    };
    let rpc_url = cfg.rpc_url.as_deref().ok_or_else(|| unset("rpc_url"))?;
    let router = cfg
        .router_address
        .as_deref()
        .ok_or_else(|| unset("router_address"))?;
    let setter = cfg
        .weight_setter_address
        .as_deref()
        .ok_or_else(|| unset("weight_setter_address"))?;
    let role = read_role_members(
        client,
        rpc_url,
        router,
        WEIGHT_SETTER_ROLE,
        "PortfolioRouter WEIGHT_SETTER_ROLE",
    )
    .await?;
    let appliers = read_role_members(
        client,
        rpc_url,
        setter,
        WEIGHT_SETTER_ROLE,
        "RouterGovernance WEIGHT_SETTER_ROLE",
    )
    .await?;
    let admins = read_role_members(
        client,
        rpc_url,
        setter,
        ADMIN_ROLE,
        "RouterGovernance ADMIN_ROLE",
    )
    .await?;
    Ok(classify_weight_setter_path(
        cfg, chain_id, role, appliers, admins,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SETTER: &str = "0xabababababababababababababababababababab";
    const TIMELOCK: &str = "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
    const STRANGER: &str = "0x1111111111111111111111111111111111111111";

    fn cfg() -> WeightSetterMonitorConfig {
        WeightSetterMonitorConfig {
            enabled: true,
            rpc_url: Some("http://127.0.0.1:18545".into()),
            router_address: Some(format!("0x{}", "ef".repeat(20))),
            weight_setter_address: Some(SETTER.into()),
            timelock_address: Some(TIMELOCK.into()),
            repage_secs: 3_600,
            min_quorum_threshold: None,
        }
    }

    fn only(addr: &str) -> RoleMembers {
        RoleMembers {
            count: 1,
            members: vec![addr.to_owned()],
        }
    }

    fn word(v: u64) -> String {
        format!("0x{v:064x}")
    }

    #[test]
    fn the_configured_path_is_quiet() {
        assert_eq!(
            classify_weight_setter_path(
                &cfg(),
                918_453,
                only(SETTER),
                only(TIMELOCK),
                only(TIMELOCK)
            ),
            WeightSetterStatus::Ok
        );
    }

    #[test]
    fn the_comparison_ignores_address_case() {
        let upper = format!("0x{}", "AB".repeat(20));
        assert_eq!(
            classify_weight_setter_path(&cfg(), 1, only(&upper), only(TIMELOCK), only(TIMELOCK)),
            WeightSetterStatus::Ok
        );
    }

    #[test]
    fn a_second_weight_setter_role_holder_is_a_drift() {
        let two = RoleMembers {
            count: 2,
            members: vec![SETTER.into(), STRANGER.into()],
        };
        match classify_weight_setter_path(&cfg(), 918_453, two, only(TIMELOCK), only(TIMELOCK)) {
            WeightSetterStatus::Drifted(b) => {
                assert_eq!(b.chain_id, 918_453);
                assert_eq!(b.weight_setter_role.count, 2);
                assert!(b.weight_setter_role.members.contains(&STRANGER.to_owned()));
            }
            other => panic!("an extra WEIGHT_SETTER_ROLE holder must page, got {other:?}"),
        }
    }

    #[test]
    fn a_weight_setter_with_no_holder_or_a_rotated_one_is_a_drift() {
        let none = RoleMembers {
            count: 0,
            members: vec![],
        };
        assert!(matches!(
            classify_weight_setter_path(&cfg(), 1, none, only(TIMELOCK), only(TIMELOCK)),
            WeightSetterStatus::Drifted(_)
        ));
        assert!(matches!(
            classify_weight_setter_path(&cfg(), 1, only(STRANGER), only(TIMELOCK), only(TIMELOCK)),
            WeightSetterStatus::Drifted(_)
        ));
    }

    #[test]
    fn an_admin_other_than_the_timelock_is_a_drift() {
        let two = RoleMembers {
            count: 2,
            members: vec![TIMELOCK.into(), STRANGER.into()],
        };
        assert!(matches!(
            classify_weight_setter_path(&cfg(), 1, only(SETTER), only(TIMELOCK), two),
            WeightSetterStatus::Drifted(_)
        ));
        assert!(matches!(
            classify_weight_setter_path(&cfg(), 1, only(SETTER), only(TIMELOCK), only(STRANGER)),
            WeightSetterStatus::Drifted(_)
        ));
    }

    #[test]
    fn an_apply_receipt_holder_other_than_the_timelock_is_a_drift() {
        // RouterGovernance.applyReceipt is gated by the weight setter's own
        // WEIGHT_SETTER_ROLE: a second holder applies receipts with no delay.
        let two = RoleMembers {
            count: 2,
            members: vec![TIMELOCK.into(), STRANGER.into()],
        };
        match classify_weight_setter_path(&cfg(), 1, only(SETTER), two, only(TIMELOCK)) {
            WeightSetterStatus::Drifted(b) => {
                assert_eq!(b.weight_setter_appliers.count, 2);
                assert!(b.weight_setter_admins.is_exactly(TIMELOCK));
            }
            other => panic!("a second applyReceipt holder must page, got {other:?}"),
        }
        assert!(matches!(
            classify_weight_setter_path(&cfg(), 1, only(SETTER), only(STRANGER), only(TIMELOCK)),
            WeightSetterStatus::Drifted(_)
        ));
    }

    #[test]
    fn a_count_above_the_listing_cap_is_never_exactly_one() {
        let many = RoleMembers {
            count: u64::MAX,
            members: vec![SETTER.into()],
        };
        assert!(!many.is_exactly(SETTER));
    }

    #[test]
    fn the_selectors_and_roles_match_their_signatures() {
        // Recomputed here so a rename of a view or a role cannot pass silently.
        use alloy_primitives::keccak256;
        let sel = |s: &str| format!("0x{}", hex::encode(&keccak256(s.as_bytes())[..4]));
        assert_eq!(
            sel("getRoleMemberCount(bytes32)"),
            GET_ROLE_MEMBER_COUNT_SELECTOR
        );
        assert_eq!(
            sel("getRoleMember(bytes32,uint256)"),
            GET_ROLE_MEMBER_SELECTOR
        );
        assert_eq!(
            hex::encode(keccak256(b"WEIGHT_SETTER_ROLE")),
            WEIGHT_SETTER_ROLE
        );
        assert_eq!(hex::encode(keccak256(b"ADMIN_ROLE")), ADMIN_ROLE);
    }

    #[test]
    fn words_decode_to_their_values() {
        assert_eq!(decode_uint256_word(&word(0), "n").unwrap(), 0);
        assert_eq!(decode_uint256_word(&word(1), "n").unwrap(), 1);
        let huge = format!("0x{}", "f".repeat(64));
        assert_eq!(decode_uint256_word(&huge, "n").unwrap(), u64::MAX);
        let addr = format!("0x{}{}", "0".repeat(24), "AB".repeat(20));
        assert_eq!(decode_address_word(&addr, "a").unwrap(), SETTER);
        assert!(decode_address_word(&huge, "a").is_err());
    }

    #[test]
    fn empty_call_data_is_a_read_failure_not_zero_members() {
        // A wrong address returns "0x". Decoding that as 0 members would page
        // for the wrong reason; decoding it as fine would hide a blind check.
        let err = decode_uint256_word("0x", "count").unwrap_err();
        assert!(
            format!("{err}").contains("empty data"),
            "unexpected error: {err}"
        );
        assert!(decode_uint256_word("0xdeadbeef", "count").is_err());
        assert!(decode_address_word("0x", "member").is_err());
    }

    #[test]
    fn an_enabled_check_refuses_to_start_without_somewhere_to_read_from() {
        let mut c = cfg();
        c.rpc_url = None;
        assert!(c.validate().is_err());

        for key in ["router", "weight_setter", "timelock"] {
            let mut c = cfg();
            match key {
                "router" => c.router_address = None,
                "weight_setter" => c.weight_setter_address = Some("not-an-address".into()),
                _ => c.timelock_address = None,
            }
            let err = c.validate().expect_err("a missing address must be refused");
            assert!(format!("{err}").contains(key), "{key}: {err}");
        }

        assert!(cfg().validate().is_ok());
    }

    #[test]
    fn an_enabled_section_with_the_deleted_quorum_key_is_refused_by_name() {
        let mut c = cfg();
        c.min_quorum_threshold = Some(2);
        let err = c.validate().expect_err("a pre-1698 section must not run");
        assert!(format!("{err}").contains("issue 1698"), "{err}");
    }

    #[test]
    fn a_disabled_check_never_refuses_a_configuration() {
        let c = WeightSetterMonitorConfig::default();
        assert!(!c.enabled);
        assert!(c.validate().is_ok());
        let legacy = WeightSetterMonitorConfig {
            min_quorum_threshold: Some(2),
            ..WeightSetterMonitorConfig::default()
        };
        assert!(legacy.validate().is_ok());
    }
}
