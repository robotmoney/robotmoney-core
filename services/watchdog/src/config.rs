//! Watchdog threshold configuration.
//!
//! Canonical: docs/technical/security-model.md §9 — Automated watchdog thresholds.
//!
//! Configuration is loaded from a TOML file (default: `services/watchdog/config.toml`).
//! A missing or zero threshold is a fatal error at startup — per the acceptance criterion
//! in issue #658, the service must not run with an unconfigured safety envelope.
//!
//! # File layout
//!
//! ```toml
//! [global]
//! per_block_mint_limit_usdc   = "500000"   # USDC (6 decimals: 500 000 USDC per block)
//! per_hour_mint_limit_usdc    = "2000000"  # USDC (6 decimals: 2 000 000 USDC per hour)
//! per_block_burn_limit_usdc   = "500000"
//! per_hour_burn_limit_usdc    = "2000000"
//!
//! [action]
//! # "pause" → call gateway.pause() via funded PAUSER_ROLE key
//! # "alert" → dispatch structured JSON alert to webhook_url
//! # "pause_and_alert" → both
//! mode = "pause_and_alert"
//! # Required when mode contains "alert"
//! webhook_url = "https://events.pagerduty.com/v2/enqueue"
//! # Required when mode contains "pause"
//! gateway_rpc_url = "https://mainnet.base.org"
//! gateway_address = "0xDEADBEEF..."
//! pauser_private_key_hex = "0x..."          # PAUSER_ROLE key (funded for gas)
//!
//! [sla]
//! # Maximum seconds between breach detection and pause/alert dispatch.
//! # Recorded in the plan and asserted at runtime.
//! max_response_secs = 300   # 5 minutes
//!
//! # Optional per-vault overrides (keyed by lowercase hex address without 0x prefix).
//! # Vaults not listed here inherit the global limits.
//! [vault."abcdef1234567890abcdef1234567890abcdef12"]
//! per_block_mint_limit_usdc  = "100000"
//! per_hour_mint_limit_usdc   = "400000"
//! per_block_burn_limit_usdc  = "100000"
//! per_hour_burn_limit_usdc   = "400000"
//! ```

use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

use crate::receipt_liveness::ReceiptLivenessConfig;
use crate::WatchdogError;

/// Top-level configuration struct loaded from the TOML file.
#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    /// Global mint/burn volume thresholds.
    pub global: GlobalThresholds,
    /// Action to take on threshold breach.
    pub action: ActionConfig,
    /// SLA configuration.
    pub sla: SlaConfig,
    /// Optional per-vault overrides keyed by lowercase hex vault address (no `0x` prefix).
    #[serde(default)]
    pub vault: HashMap<String, VaultThresholds>,
    /// Consensus-receipt anchoring-gap monitor (issue #1247 task 4.13).
    /// Absent means disabled, so pre-existing configs keep parsing unchanged.
    #[serde(default)]
    pub consensus_receipts: ReceiptLivenessConfig,
}

/// Global per-block and per-hour mint/burn volume limits (USDC units, 6-decimal integer strings).
#[derive(Debug, Clone, Deserialize)]
pub struct GlobalThresholds {
    /// Maximum total mint (deposit) volume per block across all vaults, in USDC base units.
    pub per_block_mint_limit_usdc: String,
    /// Maximum total mint (deposit) volume per rolling hour across all vaults, in USDC base units.
    pub per_hour_mint_limit_usdc: String,
    /// Maximum total burn (withdrawal) volume per block across all vaults, in USDC base units.
    pub per_block_burn_limit_usdc: String,
    /// Maximum total burn (withdrawal) volume per rolling hour across all vaults, in USDC base units.
    pub per_hour_burn_limit_usdc: String,
}

/// Per-vault threshold overrides.  Vaults not listed inherit the global limits.
#[derive(Debug, Clone, Deserialize)]
pub struct VaultThresholds {
    /// Per-block mint limit override, in USDC base units.
    pub per_block_mint_limit_usdc: Option<String>,
    /// Per-hour mint limit override, in USDC base units.
    pub per_hour_mint_limit_usdc: Option<String>,
    /// Per-block burn limit override, in USDC base units.
    pub per_block_burn_limit_usdc: Option<String>,
    /// Per-hour burn limit override, in USDC base units.
    pub per_hour_burn_limit_usdc: Option<String>,
}

/// Action to take when a threshold is breached.
#[derive(Debug, Clone, Deserialize)]
pub struct ActionConfig {
    /// Breach response mode: `"pause"`, `"alert"`, or `"pause_and_alert"`.
    pub mode: ActionMode,
    /// Webhook URL for structured JSON alerts (required when `mode` contains `"alert"`).
    pub webhook_url: Option<String>,
    /// JSON-RPC endpoint for the gateway chain (required when `mode` contains `"pause"`).
    pub gateway_rpc_url: Option<String>,
    /// Deployed gateway contract address (required when `mode` contains `"pause"`).
    pub gateway_address: Option<String>,
    /// Hex-encoded private key for the PAUSER_ROLE account (required when `mode` contains `"pause"`).
    pub pauser_private_key_hex: Option<String>,
    /// Gas-price bump applied over the network `eth_gasPrice` when submitting a
    /// pause tx, in basis points (e.g. `1500` = +15%). Lets a retried pause
    /// replace a stuck same-nonce tx by out-bidding it (scan finding WD-5).
    /// Defaults to [`DEFAULT_PAUSE_FEE_BUMP_BPS`] when absent.
    #[serde(default = "default_pause_fee_bump_bps")]
    pub pause_fee_bump_bps: u64,
}

/// Default pause-tx fee bump: +15% over the network gas price, enough to replace
/// a stuck under-priced same-nonce tx on Base under typical conditions.
pub const DEFAULT_PAUSE_FEE_BUMP_BPS: u64 = 1500;

fn default_pause_fee_bump_bps() -> u64 {
    DEFAULT_PAUSE_FEE_BUMP_BPS
}

/// Response mode on threshold breach.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionMode {
    /// Call `gateway.pause()` via a funded PAUSER_ROLE key.
    Pause,
    /// Dispatch a structured JSON alert to the configured webhook/PagerDuty endpoint.
    Alert,
    /// Both pause and alert.
    PauseAndAlert,
}

impl ActionMode {
    /// True if this mode involves calling `gateway.pause()`.
    pub fn includes_pause(self) -> bool {
        matches!(self, ActionMode::Pause | ActionMode::PauseAndAlert)
    }

    /// True if this mode involves dispatching a webhook alert.
    pub fn includes_alert(self) -> bool {
        matches!(self, ActionMode::Alert | ActionMode::PauseAndAlert)
    }
}

/// SLA configuration — maximum response time from breach detection.
#[derive(Debug, Clone, Deserialize)]
pub struct SlaConfig {
    /// Maximum seconds between breach detection and pause/alert dispatch.
    /// Recorded in the plan (issue #658). Must be non-zero.
    pub max_response_secs: u64,
}

impl Config {
    /// Load and validate a [`Config`] from a TOML file.
    ///
    /// Returns [`WatchdogError::Config`] if the file cannot be read, parsed, or
    /// fails any threshold validation (missing or zero limits).
    pub fn from_file(path: &Path) -> Result<Self, WatchdogError> {
        let raw = std::fs::read_to_string(path).map_err(|e| {
            WatchdogError::Config(format!("cannot read config file {}: {e}", path.display()))
        })?;
        let cfg: Config = toml::from_str(&raw).map_err(|e| {
            WatchdogError::Config(format!("config parse error in {}: {e}", path.display()))
        })?;
        cfg.validate()?;
        Ok(cfg)
    }

    /// Validate that all required threshold and action fields are present and non-zero.
    ///
    /// A missing or zero threshold is a fatal error: running the watchdog without a
    /// configured safety envelope would silently disable the control.
    pub fn validate(&self) -> Result<(), WatchdogError> {
        // A zero receipt cadence would page on every poll; refuse it rather
        // than silently disable the control (issue #1247 task 4.13).
        self.consensus_receipts.validate()?;

        // Validate global thresholds.
        validate_threshold(
            &self.global.per_block_mint_limit_usdc,
            "global.per_block_mint_limit_usdc",
        )?;
        validate_threshold(
            &self.global.per_hour_mint_limit_usdc,
            "global.per_hour_mint_limit_usdc",
        )?;
        validate_threshold(
            &self.global.per_block_burn_limit_usdc,
            "global.per_block_burn_limit_usdc",
        )?;
        validate_threshold(
            &self.global.per_hour_burn_limit_usdc,
            "global.per_hour_burn_limit_usdc",
        )?;

        // Validate per-vault overrides.
        for (vault_addr, vt) in &self.vault {
            if let Some(ref v) = vt.per_block_mint_limit_usdc {
                validate_threshold(v, &format!("vault.{vault_addr}.per_block_mint_limit_usdc"))?;
            }
            if let Some(ref v) = vt.per_hour_mint_limit_usdc {
                validate_threshold(v, &format!("vault.{vault_addr}.per_hour_mint_limit_usdc"))?;
            }
            if let Some(ref v) = vt.per_block_burn_limit_usdc {
                validate_threshold(v, &format!("vault.{vault_addr}.per_block_burn_limit_usdc"))?;
            }
            if let Some(ref v) = vt.per_hour_burn_limit_usdc {
                validate_threshold(v, &format!("vault.{vault_addr}.per_hour_burn_limit_usdc"))?;
            }
        }

        // Validate SLA.
        if self.sla.max_response_secs == 0 {
            return Err(WatchdogError::Config(
                "sla.max_response_secs must be non-zero".to_owned(),
            ));
        }

        // Validate action config.
        if self.action.mode.includes_alert() && self.action.webhook_url.is_none() {
            return Err(WatchdogError::Config(
                "action.webhook_url is required when action.mode includes alert".to_owned(),
            ));
        }
        if self.action.mode.includes_pause() {
            if self.action.gateway_rpc_url.is_none() {
                return Err(WatchdogError::Config(
                    "action.gateway_rpc_url is required when action.mode includes pause".to_owned(),
                ));
            }
            if self.action.gateway_address.is_none() {
                return Err(WatchdogError::Config(
                    "action.gateway_address is required when action.mode includes pause".to_owned(),
                ));
            }
            if self.action.pauser_private_key_hex.is_none() {
                return Err(WatchdogError::Config(
                    "action.pauser_private_key_hex is required when action.mode includes pause"
                        .to_owned(),
                ));
            }
        }

        Ok(())
    }

    /// Return the effective per-block mint limit for a given vault address (hex, no prefix).
    ///
    /// Falls back to the global limit if no per-vault override is configured.
    pub fn per_block_mint_limit(&self, vault_hex: &str) -> u128 {
        self.vault
            .get(vault_hex)
            .and_then(|v| v.per_block_mint_limit_usdc.as_deref())
            .unwrap_or(&self.global.per_block_mint_limit_usdc)
            .parse::<u128>()
            .unwrap_or(0)
    }

    /// Return the effective per-hour mint limit for a given vault address (hex, no prefix).
    pub fn per_hour_mint_limit(&self, vault_hex: &str) -> u128 {
        self.vault
            .get(vault_hex)
            .and_then(|v| v.per_hour_mint_limit_usdc.as_deref())
            .unwrap_or(&self.global.per_hour_mint_limit_usdc)
            .parse::<u128>()
            .unwrap_or(0)
    }

    /// Return the effective per-block burn limit for a given vault address (hex, no prefix).
    pub fn per_block_burn_limit(&self, vault_hex: &str) -> u128 {
        self.vault
            .get(vault_hex)
            .and_then(|v| v.per_block_burn_limit_usdc.as_deref())
            .unwrap_or(&self.global.per_block_burn_limit_usdc)
            .parse::<u128>()
            .unwrap_or(0)
    }

    /// Return the effective per-hour burn limit for a given vault address (hex, no prefix).
    pub fn per_hour_burn_limit(&self, vault_hex: &str) -> u128 {
        self.vault
            .get(vault_hex)
            .and_then(|v| v.per_hour_burn_limit_usdc.as_deref())
            .unwrap_or(&self.global.per_hour_burn_limit_usdc)
            .parse::<u128>()
            .unwrap_or(0)
    }

    /// Return the global per-block mint limit.
    pub fn global_per_block_mint_limit(&self) -> u128 {
        self.global
            .per_block_mint_limit_usdc
            .parse::<u128>()
            .unwrap_or(0)
    }

    /// Return the global per-hour mint limit.
    pub fn global_per_hour_mint_limit(&self) -> u128 {
        self.global
            .per_hour_mint_limit_usdc
            .parse::<u128>()
            .unwrap_or(0)
    }

    /// Return the global per-block burn limit.
    pub fn global_per_block_burn_limit(&self) -> u128 {
        self.global
            .per_block_burn_limit_usdc
            .parse::<u128>()
            .unwrap_or(0)
    }

    /// Return the global per-hour burn limit.
    pub fn global_per_hour_burn_limit(&self) -> u128 {
        self.global
            .per_hour_burn_limit_usdc
            .parse::<u128>()
            .unwrap_or(0)
    }
}

/// Validate that a threshold string is present, parseable as u128, and non-zero.
fn validate_threshold(value: &str, field: &str) -> Result<(), WatchdogError> {
    match value.trim().parse::<u128>() {
        Ok(0) => Err(WatchdogError::Config(format!(
            "{field} must be non-zero (got 0)"
        ))),
        Ok(_) => Ok(()),
        Err(_) => Err(WatchdogError::Config(format!(
            "{field} is not a valid integer: {value:?}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_valid_config_toml() -> String {
        r#"
[global]
per_block_mint_limit_usdc   = "500000"
per_hour_mint_limit_usdc    = "2000000"
per_block_burn_limit_usdc   = "500000"
per_hour_burn_limit_usdc    = "2000000"

[action]
mode = "alert"
webhook_url = "https://events.example.com/alert"

[sla]
max_response_secs = 300
"#
        .to_owned()
    }

    #[test]
    fn valid_config_parses_and_validates() {
        let raw = make_valid_config_toml();
        let cfg: Config = toml::from_str(&raw).unwrap();
        cfg.validate().unwrap();
    }

    #[test]
    fn config_missing_threshold_is_fatal_zero_block_mint() {
        let raw = r#"
[global]
per_block_mint_limit_usdc   = "0"
per_hour_mint_limit_usdc    = "2000000"
per_block_burn_limit_usdc   = "500000"
per_hour_burn_limit_usdc    = "2000000"

[action]
mode = "alert"
webhook_url = "https://events.example.com/alert"

[sla]
max_response_secs = 300
"#;
        let cfg: Config = toml::from_str(raw).unwrap();
        let err = cfg.validate().unwrap_err();
        match err {
            WatchdogError::Config(msg) => {
                assert!(
                    msg.contains("per_block_mint_limit_usdc"),
                    "error must name the bad field; got: {msg}"
                );
            }
            other => panic!("expected WatchdogError::Config, got: {other}"),
        }
    }

    #[test]
    fn config_missing_threshold_is_fatal_missing_hour_burn() {
        // Missing field entirely → toml parse error, not validation error.
        let raw = r#"
[global]
per_block_mint_limit_usdc   = "500000"
per_hour_mint_limit_usdc    = "2000000"
per_block_burn_limit_usdc   = "500000"
# per_hour_burn_limit_usdc is intentionally absent

[action]
mode = "alert"
webhook_url = "https://events.example.com/alert"

[sla]
max_response_secs = 300
"#;
        let result: Result<Config, _> = toml::from_str(raw);
        assert!(result.is_err(), "missing field must fail TOML parse");
    }

    #[test]
    fn config_missing_threshold_is_fatal_non_integer() {
        let raw = r#"
[global]
per_block_mint_limit_usdc   = "not_a_number"
per_hour_mint_limit_usdc    = "2000000"
per_block_burn_limit_usdc   = "500000"
per_hour_burn_limit_usdc    = "2000000"

[action]
mode = "alert"
webhook_url = "https://events.example.com/alert"

[sla]
max_response_secs = 300
"#;
        let cfg: Config = toml::from_str(raw).unwrap();
        let err = cfg.validate().unwrap_err();
        match err {
            WatchdogError::Config(msg) => {
                assert!(msg.contains("per_block_mint_limit_usdc"), "got: {msg}");
            }
            other => panic!("expected WatchdogError::Config, got: {other}"),
        }
    }

    #[test]
    fn alert_mode_requires_webhook_url() {
        let raw = r#"
[global]
per_block_mint_limit_usdc   = "500000"
per_hour_mint_limit_usdc    = "2000000"
per_block_burn_limit_usdc   = "500000"
per_hour_burn_limit_usdc    = "2000000"

[action]
mode = "alert"
# webhook_url absent

[sla]
max_response_secs = 300
"#;
        let cfg: Config = toml::from_str(raw).unwrap();
        let err = cfg.validate().unwrap_err();
        match err {
            WatchdogError::Config(msg) => {
                assert!(msg.contains("webhook_url"), "got: {msg}");
            }
            other => panic!("expected WatchdogError::Config, got: {other}"),
        }
    }

    #[test]
    fn pause_mode_requires_gateway_fields() {
        let raw = r#"
[global]
per_block_mint_limit_usdc   = "500000"
per_hour_mint_limit_usdc    = "2000000"
per_block_burn_limit_usdc   = "500000"
per_hour_burn_limit_usdc    = "2000000"

[action]
mode = "pause"
# No gateway fields

[sla]
max_response_secs = 300
"#;
        let cfg: Config = toml::from_str(raw).unwrap();
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn zero_sla_is_fatal() {
        let raw = r#"
[global]
per_block_mint_limit_usdc   = "500000"
per_hour_mint_limit_usdc    = "2000000"
per_block_burn_limit_usdc   = "500000"
per_hour_burn_limit_usdc    = "2000000"

[action]
mode = "alert"
webhook_url = "https://events.example.com/alert"

[sla]
max_response_secs = 0
"#;
        let cfg: Config = toml::from_str(raw).unwrap();
        let err = cfg.validate().unwrap_err();
        match err {
            WatchdogError::Config(msg) => {
                assert!(msg.contains("max_response_secs"), "got: {msg}");
            }
            other => panic!("expected WatchdogError::Config, got: {other}"),
        }
    }

    #[test]
    fn global_limit_accessors_parse_correctly() {
        let raw = make_valid_config_toml();
        let cfg: Config = toml::from_str(&raw).unwrap();
        assert_eq!(cfg.global_per_block_mint_limit(), 500_000);
        assert_eq!(cfg.global_per_hour_mint_limit(), 2_000_000);
        assert_eq!(cfg.global_per_block_burn_limit(), 500_000);
        assert_eq!(cfg.global_per_hour_burn_limit(), 2_000_000);
    }

    #[test]
    fn per_vault_override_is_respected() {
        let raw = r#"
[global]
per_block_mint_limit_usdc   = "500000"
per_hour_mint_limit_usdc    = "2000000"
per_block_burn_limit_usdc   = "500000"
per_hour_burn_limit_usdc    = "2000000"

[action]
mode = "alert"
webhook_url = "https://events.example.com/alert"

[sla]
max_response_secs = 300

[vault."aabbccdd00112233aabbccdd00112233aabbccdd"]
per_block_mint_limit_usdc = "100000"
per_hour_mint_limit_usdc  = "400000"
"#;
        let cfg: Config = toml::from_str(raw).unwrap();
        cfg.validate().unwrap();
        let vault = "aabbccdd00112233aabbccdd00112233aabbccdd";
        assert_eq!(cfg.per_block_mint_limit(vault), 100_000);
        assert_eq!(cfg.per_hour_mint_limit(vault), 400_000);
        // burn falls back to global
        assert_eq!(cfg.per_block_burn_limit(vault), 500_000);
        assert_eq!(cfg.per_hour_burn_limit(vault), 2_000_000);
    }
}
