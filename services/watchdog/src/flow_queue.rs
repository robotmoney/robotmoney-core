//! Standing check on the one fund's flow queue: deposit stops, cancel deadline, guard bands, and
//! keeper and Safe liveness (OPS-07, FLOW-08, E31, E34, E38, E39).
//!
//! Canonical: `docs/technical/one-vault-rebalancer-proposal.md` section 5.11.3 item 8 and section 8;
//! `docs/technical/one-vault-timed-flows-eng-plan.md` section 8.
//!
//! The queue shows three things the Watchdog reads with two `eth_call`s:
//!
//! - `liveness()`: is a keeper configured, is the queue paused (and until when), are deposits stopped
//!   now, is wind-down active, and the `cancelBuffer` and `maxPause` the Safe set.
//! - `quoteDeposit(probe)`: the cancel cutoff for a deposit made now, plus `refBandBps` and
//!   `legBandBps`.
//!
//! A stop, a paused queue, a wind-down, or a queue with no keeper is a page. The page names the stop,
//! its end when known, and the cancel deadline, so a depositor-facing team can tell users in time.
//! Read-only: `eth_call` only. This path never pauses and never writes.

use reqwest::Client;
use serde::Deserialize;

use crate::governance::{decode_uint256_word, eth_call, is_hex_address};
use crate::WatchdogError;

/// `keccak256("liveness()")[0..4]`.
pub const LIVENESS_SELECTOR: &str = "0x6ad0690a";

/// `keccak256("quoteDeposit(uint256)")[0..4]`.
pub const QUOTE_DEPOSIT_SELECTOR: &str = "0xdb431f06";

/// Default seconds between two pages for the same standing condition.
pub const DEFAULT_FLOW_QUEUE_REPAGE_SECS: u64 = 3_600;

/// Default probe size for `quoteDeposit`, in USDC base units (1 USDC, 6 decimals).
pub const DEFAULT_QUOTE_PROBE_USDC: u64 = 1_000_000;

/// Configuration for the flow-queue check (`[flow_queue]`). Absent means disabled.
#[derive(Debug, Clone, Deserialize)]
pub struct FlowQueueMonitorConfig {
    /// Whether the check runs at all.
    #[serde(default)]
    pub enabled: bool,
    /// JSON-RPC endpoint used for the `eth_call`s.
    #[serde(default)]
    pub rpc_url: Option<String>,
    /// `FlowQueue` address, `0x`-prefixed hex.
    #[serde(default)]
    pub queue_address: Option<String>,
    /// Floor between two pages for the same standing condition.
    #[serde(default = "default_repage_secs")]
    pub repage_secs: u64,
    /// USDC amount (base units) passed to `quoteDeposit`.
    #[serde(default = "default_probe")]
    pub quote_probe_usdc: u64,
}

fn default_repage_secs() -> u64 {
    DEFAULT_FLOW_QUEUE_REPAGE_SECS
}

fn default_probe() -> u64 {
    DEFAULT_QUOTE_PROBE_USDC
}

impl Default for FlowQueueMonitorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            rpc_url: None,
            queue_address: None,
            repage_secs: DEFAULT_FLOW_QUEUE_REPAGE_SECS,
            quote_probe_usdc: DEFAULT_QUOTE_PROBE_USDC,
        }
    }
}

impl FlowQueueMonitorConfig {
    /// Refuse an enabled check that could not read anything. A disabled section is never refused.
    pub fn validate(&self) -> Result<(), WatchdogError> {
        if !self.enabled {
            return Ok(());
        }
        if self.rpc_url.as_deref().unwrap_or("").is_empty() {
            return Err(WatchdogError::Config(
                "flow_queue.rpc_url is required when flow_queue.enabled = true".into(),
            ));
        }
        let addr = self.queue_address.as_deref().unwrap_or("");
        if !is_hex_address(addr) {
            return Err(WatchdogError::Config(format!(
                "flow_queue.queue_address must be a 0x-prefixed 20-byte hex address, got {addr:?}"
            )));
        }
        if self.repage_secs == 0 || self.quote_probe_usdc == 0 {
            return Err(WatchdogError::Config(
                "flow_queue.repage_secs and flow_queue.quote_probe_usdc must be non-zero".into(),
            ));
        }
        Ok(())
    }
}

/// `QueueLiveness` as returned by `FlowQueue.liveness()`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueLiveness {
    /// A keeper holds `KEEPER_ROLE`.
    pub keeper_configured: bool,
    /// The queue is paused right now.
    pub queue_paused_now: bool,
    /// End of the self-expiring pause (Unix seconds), zero when never paused.
    pub queue_paused_until: u64,
    /// Deposits are stopped right now.
    pub deposits_stopped_now: bool,
    /// The fund is in wind-down.
    pub wind_down_active: bool,
    /// Seconds before epoch close at which cancel ends.
    pub cancel_buffer: u64,
    /// Longest self-expiring pause in seconds.
    pub max_pause: u64,
}

/// The terms of `FlowQueue.quoteDeposit(usdc)`. It carries no price.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepositQuote {
    /// Exit fee in basis points.
    pub fee_bps: u64,
    /// Last second a deposit made now can be cancelled (Unix seconds).
    pub cancel_cutoff: u64,
    /// Earliest settlement time (Unix seconds).
    pub earliest_settle: u64,
    /// End of the hold (Unix seconds).
    pub hold_ends: u64,
    /// TWAP against feed band, basis points.
    pub ref_band_bps: u64,
    /// Per-swap limit band, basis points.
    pub leg_band_bps: u64,
}

fn words(raw: &str, n: usize, what: &str) -> Result<Vec<String>, WatchdogError> {
    let body = raw.strip_prefix("0x").unwrap_or(raw);
    if body.len() != 64 * n || !body.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(WatchdogError::Config(format!(
            "{what} returned {} hex characters, expected {} ({n} ABI words)",
            body.len(),
            64 * n
        )));
    }
    Ok((0..n)
        .map(|i| format!("0x{}", &body[i * 64..(i + 1) * 64]))
        .collect())
}

fn bool_word(word: &str, what: &str) -> Result<bool, WatchdogError> {
    match decode_uint256_word(word, what)? {
        0 => Ok(false),
        1 => Ok(true),
        other => Err(WatchdogError::Config(format!(
            "{what} is {other}, not a bool"
        ))),
    }
}

/// Decode the seven-word `liveness()` result.
pub fn decode_liveness(raw: &str) -> Result<QueueLiveness, WatchdogError> {
    let w = words(raw, 7, "FlowQueue.liveness()")?;
    let u = |i: usize, f: &str| decode_uint256_word(&w[i], f);
    Ok(QueueLiveness {
        keeper_configured: bool_word(&w[0], "liveness.keeperConfigured")?,
        queue_paused_now: bool_word(&w[1], "liveness.queuePausedNow")?,
        queue_paused_until: u(2, "liveness.queuePausedUntil")?,
        deposits_stopped_now: bool_word(&w[3], "liveness.depositsStoppedNow")?,
        wind_down_active: bool_word(&w[4], "liveness.windDownActive")?,
        cancel_buffer: u(5, "liveness.cancelBuffer")?,
        max_pause: u(6, "liveness.maxPause")?,
    })
}

/// Decode the six-word `quoteDeposit()` result.
pub fn decode_quote(raw: &str) -> Result<DepositQuote, WatchdogError> {
    let w = words(raw, 6, "FlowQueue.quoteDeposit()")?;
    let u = |i: usize, f: &str| decode_uint256_word(&w[i], f);
    Ok(DepositQuote {
        fee_bps: u(0, "quote.feeBps")?,
        cancel_cutoff: u(1, "quote.cancelCutoff")?,
        earliest_settle: u(2, "quote.earliestSettle")?,
        hold_ends: u(3, "quote.holdEnds")?,
        ref_band_bps: u(4, "quote.refBandBps")?,
        leg_band_bps: u(5, "quote.legBandBps")?,
    })
}

/// One reason the queue is not taking deposits normally.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowQueueCondition {
    /// The Safe's emergency key paused the queue (self-expiring).
    QueuePaused,
    /// Deposits are stopped (an excluded asset, a delisting sale, or a venue stop).
    DepositsStopped,
    /// The fund is winding down.
    WindDown,
    /// No keeper holds `KEEPER_ROLE`, so no round can settle.
    NoKeeper,
    /// A guard band reads zero, so that guard is off.
    BandOff,
}

impl FlowQueueCondition {
    /// Short stable name for the alert body.
    pub fn name(self) -> &'static str {
        match self {
            Self::QueuePaused => "queue_paused",
            Self::DepositsStopped => "deposits_stopped",
            Self::WindDown => "wind_down",
            Self::NoKeeper => "no_keeper",
            Self::BandOff => "band_off",
        }
    }
}

/// What one cycle observed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlowQueueStatus {
    /// No stop, a keeper is configured, both bands are on.
    Ok(FlowQueueSnapshot),
    /// At least one condition holds.
    Degraded(FlowQueueSnapshot, Vec<FlowQueueCondition>),
}

/// Everything read in one cycle, shown whether or not it pages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowQueueSnapshot {
    /// Chain the queue lives on.
    pub chain_id: i64,
    /// Queue address as configured.
    pub queue_address: String,
    /// The liveness read.
    pub liveness: QueueLiveness,
    /// The deposit quote read.
    pub quote: DepositQuote,
}

/// Pure classifier.
pub fn classify_flow_queue(
    chain_id: i64,
    queue_address: &str,
    liveness: QueueLiveness,
    quote: DepositQuote,
) -> FlowQueueStatus {
    let mut conditions = Vec::new();
    if liveness.queue_paused_now {
        conditions.push(FlowQueueCondition::QueuePaused);
    }
    if liveness.deposits_stopped_now {
        conditions.push(FlowQueueCondition::DepositsStopped);
    }
    if liveness.wind_down_active {
        conditions.push(FlowQueueCondition::WindDown);
    }
    if !liveness.keeper_configured {
        conditions.push(FlowQueueCondition::NoKeeper);
    }
    if quote.ref_band_bps == 0 || quote.leg_band_bps == 0 {
        conditions.push(FlowQueueCondition::BandOff);
    }
    let snap = FlowQueueSnapshot {
        chain_id,
        queue_address: queue_address.to_owned(),
        liveness,
        quote,
    };
    if conditions.is_empty() {
        FlowQueueStatus::Ok(snap)
    } else {
        FlowQueueStatus::Degraded(snap, conditions)
    }
}

/// Plain-text page body: each condition, its end, the cancel deadline, the bands and liveness.
pub fn describe_degraded(snap: &FlowQueueSnapshot, conditions: &[FlowQueueCondition]) -> String {
    let l = &snap.liveness;
    let q = &snap.quote;
    let mut parts: Vec<String> = Vec::new();
    for c in conditions {
        parts.push(match c {
            FlowQueueCondition::QueuePaused => format!(
                "queue paused until unix {} (self-expiring, max pause {}s)",
                l.queue_paused_until, l.max_pause
            ),
            FlowQueueCondition::DepositsStopped => {
                "deposits stopped (excluded asset, delisting sale, or venue stop)".to_owned()
            }
            FlowQueueCondition::WindDown => "fund in wind-down".to_owned(),
            FlowQueueCondition::NoKeeper => "no keeper configured, no round can settle".to_owned(),
            FlowQueueCondition::BandOff => "a guard band reads zero".to_owned(),
        });
    }
    format!(
        "RobotMoney watchdog: flow queue {} on chain {}: {}. Cancel deadline for a deposit made \
         now: unix {} (cancel buffer {}s before epoch close). refBandBps {}, legBandBps {}. \
         Keeper configured: {}.",
        snap.queue_address,
        snap.chain_id,
        parts.join("; "),
        q.cancel_cutoff,
        l.cancel_buffer,
        q.ref_band_bps,
        q.leg_band_bps,
        l.keeper_configured
    )
}

/// Stable incident key for the flow-queue condition on `chain_id`.
pub fn flow_queue_dedup_key(chain_id: i64) -> String {
    format!("flow_queue_degraded:{chain_id}")
}

/// Calldata for `quoteDeposit(usdc)`.
pub fn quote_deposit_calldata(usdc: u64) -> String {
    format!("{QUOTE_DEPOSIT_SELECTOR}{usdc:064x}")
}

/// Read liveness and the deposit quote and classify them.
pub async fn check_flow_queue(
    client: &Client,
    cfg: &FlowQueueMonitorConfig,
    chain_id: i64,
) -> Result<FlowQueueStatus, WatchdogError> {
    let unset = |k: &str| {
        WatchdogError::Config(format!("flow_queue.{k} is unset but the check is enabled"))
    };
    let rpc = cfg.rpc_url.as_deref().ok_or_else(|| unset("rpc_url"))?;
    let queue = cfg
        .queue_address
        .as_deref()
        .ok_or_else(|| unset("queue_address"))?;
    let live_raw = eth_call(
        client,
        rpc,
        queue,
        LIVENESS_SELECTOR,
        "FlowQueue.liveness()",
    )
    .await?;
    let quote_raw = eth_call(
        client,
        rpc,
        queue,
        &quote_deposit_calldata(cfg.quote_probe_usdc),
        "FlowQueue.quoteDeposit()",
    )
    .await?;
    Ok(classify_flow_queue(
        chain_id,
        queue,
        decode_liveness(&live_raw)?,
        decode_quote(&quote_raw)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(v: u64) -> String {
        format!("{v:064x}")
    }
    fn raw(vals: &[u64]) -> String {
        format!("0x{}", vals.iter().map(|v| word(*v)).collect::<String>())
    }
    fn healthy() -> (QueueLiveness, DepositQuote) {
        (
            decode_liveness(&raw(&[1, 0, 0, 0, 0, 900, 172_800])).unwrap(),
            decode_quote(&raw(&[10, 5_000, 6_000, 7_000, 90, 100])).unwrap(),
        )
    }

    #[test]
    fn selectors_match_signatures_in_the_interface() {
        assert_eq!(LIVENESS_SELECTOR, "0x6ad0690a");
        assert_eq!(QUOTE_DEPOSIT_SELECTOR, "0xdb431f06");
    }

    #[test]
    fn decodes_every_liveness_and_quote_field() {
        let (l, q) = healthy();
        assert!(l.keeper_configured && !l.queue_paused_now && !l.deposits_stopped_now);
        assert_eq!((l.cancel_buffer, l.max_pause), (900, 172_800));
        assert_eq!(
            (q.cancel_cutoff, q.ref_band_bps, q.leg_band_bps),
            (5_000, 90, 100)
        );
        assert_eq!(
            (q.fee_bps, q.earliest_settle, q.hold_ends),
            (10, 6_000, 7_000)
        );
    }

    #[test]
    fn refuses_short_data_and_non_bool_words() {
        assert!(decode_liveness("0x").is_err());
        assert!(decode_quote(&raw(&[1, 2, 3])).is_err());
        assert!(decode_liveness(&raw(&[2, 0, 0, 0, 0, 0, 0])).is_err());
    }

    #[test]
    fn healthy_queue_is_ok() {
        let (l, q) = healthy();
        assert!(matches!(
            classify_flow_queue(8453, "0xq", l, q),
            FlowQueueStatus::Ok(_)
        ));
    }

    #[test]
    fn each_stop_is_reported_with_the_cancel_deadline_and_bands() {
        let l = decode_liveness(&raw(&[0, 1, 9_999, 1, 1, 900, 172_800])).unwrap();
        let (_, q) = healthy();
        let FlowQueueStatus::Degraded(snap, conds) = classify_flow_queue(8453, "0xq", l, q) else {
            panic!("expected degraded");
        };
        assert_eq!(
            conds,
            vec![
                FlowQueueCondition::QueuePaused,
                FlowQueueCondition::DepositsStopped,
                FlowQueueCondition::WindDown,
                FlowQueueCondition::NoKeeper
            ]
        );
        let text = describe_degraded(&snap, &conds);
        assert!(text.contains("paused until unix 9999"));
        assert!(text.contains("Cancel deadline for a deposit made now: unix 5000"));
        assert!(text.contains("refBandBps 90, legBandBps 100"));
        assert!(text.contains("Keeper configured: false"));
    }

    #[test]
    fn a_zero_band_is_degraded() {
        let (l, _) = healthy();
        let q = decode_quote(&raw(&[10, 5_000, 6_000, 7_000, 0, 100])).unwrap();
        let FlowQueueStatus::Degraded(_, c) = classify_flow_queue(1, "0xq", l, q) else {
            panic!("expected degraded");
        };
        assert_eq!(c, vec![FlowQueueCondition::BandOff]);
    }

    #[test]
    fn calldata_pads_the_probe() {
        assert_eq!(quote_deposit_calldata(1), format!("0xdb431f06{}", word(1)));
    }

    #[test]
    fn config_validation() {
        assert!(FlowQueueMonitorConfig::default().validate().is_ok());
        let mut c = FlowQueueMonitorConfig {
            enabled: true,
            ..Default::default()
        };
        assert!(c.validate().is_err());
        c.rpc_url = Some("http://x".into());
        c.queue_address = Some("0xnope".into());
        assert!(c.validate().is_err());
        c.queue_address = Some(format!("0x{}", "ab".repeat(20)));
        assert!(c.validate().is_ok());
        c.repage_secs = 0;
        assert!(c.validate().is_err());
    }

    #[test]
    fn dedup_key_is_per_chain() {
        assert_ne!(flow_queue_dedup_key(1), flow_queue_dedup_key(2));
    }
}
