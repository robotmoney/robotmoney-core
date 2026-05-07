//! Canonical: docs/architecture.md §10 — Local State (operator config TOML loader)
//!
//! TOML configuration loader.
//!
//! Field set is fixed by `docs/implementation-plan.md` §3.4–§3.7 and
//! issue #7. Unknown fields are rejected (`deny_unknown_fields`) so that a
//! typo in operator config fails loudly instead of silently using a default.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::errors::{Result, RmpcError};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// EIP-155 chain id the daemon is allowed to sign for.
    pub chain_id: u64,
    /// JSON-RPC endpoint URL.
    pub rpc_url: String,
    /// Deployed `RobotMoneyGateway` address (0x-prefixed hex).
    pub gateway_address: String,
    /// USDC token address on `chain_id`.
    pub usdc_address: String,
    /// Vault address that receives deposits.
    pub vault_address: String,
    /// Pinned `keccak256(eth_getCode(gateway_address))` (0x-prefixed hex).
    pub gateway_runtime_hash: String,
    /// Operator-policy ceiling on `maxFeePerGas`, in wei.
    ///
    /// `u64` (max ≈ 1.8 × 10^19 wei = 18 ETH/gas) is far above any plausible
    /// cap. The TOML 0.8 wire format does not support `u128`.
    ///
    /// Optional in TOML (issue #93). When omitted, the active value is
    /// resolved from the per-chain default table — see
    /// [`crate::fees::default_max_fee_per_gas_cap_wei`] and
    /// [`Config::effective_max_fee_per_gas_cap`]. An explicit value here
    /// always wins over the per-chain default.
    #[serde(default)]
    pub max_fee_per_gas_cap: Option<u64>,
    /// Operator-policy ceiling on `maxPriorityFeePerGas`, in wei.
    ///
    /// Mirrors `max_fee_per_gas_cap`: `compute_fees` refuses
    /// (`ErrFeeCapExceeded`) when the observed network tip exceeds
    /// this ceiling. Optional in TOML — `None` (i.e. omitted) means
    /// "no priority-fee cap"; the `max_fee_per_gas_cap` total still
    /// bounds the bid.
    #[serde(default)]
    pub max_priority_fee_per_gas_cap: Option<u64>,
    /// Per-agent state directory (lock files, replay cache, etc.).
    ///
    /// Optional in the TOML; the loader resolves the active value via
    /// [`Config::resolve_state_dir`] which prefers the `RMPC_STATE_DIR`
    /// env var and otherwise reads this field. There is **no silent
    /// fallback**: if neither source provides a path,
    /// [`Config::resolve_state_dir`] returns an error.
    #[serde(default)]
    pub state_dir: Option<PathBuf>,
    /// Signer backend configuration.
    pub signer: SignerConfig,
    /// Logging configuration. Optional in TOML; defaults applied via
    /// [`LogConfig::with_env_overrides`].
    #[serde(default)]
    pub log: LogConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SignerConfig {
    /// Must be `true` for the software signer to start (v0 §10.5).
    pub allow_software_fallback: bool,
    /// Path to the encrypted-at-rest keystore file.
    pub keystore_path: PathBuf,
}

/// Logging configuration block. All fields are optional in TOML (sane
/// defaults applied) and may be overridden by environment variables —
/// see [`LogConfig::with_env_overrides`].
///
/// Knobs:
///
/// - `level` — `error|warn|info|debug|trace`. Default `info`.
///   Env: `RMPC_LOG_LEVEL`.
/// - `dir` — directory holding the rotating diagnostic log + the audit
///   log. Default: [`crate::logging::default_log_dir`].
///   Env: `RMPC_LOG_DIR`.
/// - `rotate_size_mb` — per-file size limit before rotation. Default 10.
/// - `keep_files` — number of rolled files to retain. Default 14.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LogConfig {
    #[serde(default = "default_log_level")]
    pub level: String,
    #[serde(default = "default_log_dir_field")]
    pub dir: PathBuf,
    #[serde(default = "default_rotate_size_mb")]
    pub rotate_size_mb: u32,
    #[serde(default = "default_keep_files")]
    pub keep_files: u32,
}

fn default_log_level() -> String {
    "info".to_string()
}
fn default_log_dir_field() -> PathBuf {
    crate::logging::default_log_dir()
}
fn default_rotate_size_mb() -> u32 {
    10
}
fn default_keep_files() -> u32 {
    14
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            level: default_log_level(),
            dir: default_log_dir_field(),
            rotate_size_mb: default_rotate_size_mb(),
            keep_files: default_keep_files(),
        }
    }
}

impl LogConfig {
    /// Apply `RMPC_LOG_LEVEL` and `RMPC_LOG_DIR` overrides on top of
    /// whatever was loaded from TOML.
    pub fn with_env_overrides(mut self) -> Self {
        if let Ok(lvl) = std::env::var("RMPC_LOG_LEVEL") {
            if !lvl.is_empty() {
                self.level = lvl;
            }
        }
        if let Ok(dir) = std::env::var("RMPC_LOG_DIR") {
            if !dir.is_empty() {
                self.dir = PathBuf::from(dir);
            }
        }
        self
    }
}

impl Config {
    /// Load from a TOML file on disk.
    pub fn from_path<P: AsRef<Path>>(path: P) -> Result<Self> {
        let s = std::fs::read_to_string(path)?;
        Self::from_str(&s)
    }

    /// Parse from a TOML string.
    #[allow(clippy::should_implement_trait)] // existing API; not a `FromStr` (returns RmpcError)
    pub fn from_str(s: &str) -> Result<Self> {
        toml::from_str::<Self>(s).map_err(RmpcError::from)
    }

    /// Resolve the effective `max_fee_per_gas_cap` for this config — issue #93.
    ///
    /// Resolution order:
    ///
    ///   1. `cli_override` if `Some(_)` (e.g. the rmpc `--fee-cap` flag).
    ///   2. The TOML `max_fee_per_gas_cap` field if `Some(_)`.
    ///   3. The per-chain default from
    ///      [`crate::fees::default_max_fee_per_gas_cap_wei`] for `chain_id`.
    ///   4. Otherwise: [`crate::fees::UNKNOWN_CHAIN_FEE_CAP_FALLBACK_WEI`],
    ///      with a `log::warn!` so the operator notices the unknown chain.
    pub fn effective_max_fee_per_gas_cap(&self, cli_override: Option<u64>) -> u64 {
        if let Some(v) = cli_override {
            return v;
        }
        if let Some(v) = self.max_fee_per_gas_cap {
            return v;
        }
        if let Some(v) = crate::fees::default_max_fee_per_gas_cap_wei(self.chain_id) {
            return v;
        }
        log::warn!(
            "rmpc config: chain_id {} has no default max_fee_per_gas_cap; falling back to {} wei. Set [fees].max_fee_per_gas_cap explicitly to silence.",
            self.chain_id,
            crate::fees::UNKNOWN_CHAIN_FEE_CAP_FALLBACK_WEI
        );
        crate::fees::UNKNOWN_CHAIN_FEE_CAP_FALLBACK_WEI
    }

    /// Resolve the active state directory.
    ///
    /// Lookup order: `RMPC_STATE_DIR` env var → `[state_dir]` from
    /// TOML → error. There is **no silent fallback to `/tmp`** (audit
    /// finding M1).
    pub fn resolve_state_dir(&self) -> Result<PathBuf> {
        if let Ok(s) = std::env::var("RMPC_STATE_DIR") {
            if !s.is_empty() {
                return Ok(PathBuf::from(s));
            }
        }
        match &self.state_dir {
            Some(p) => Ok(p.clone()),
            None => Err(RmpcError::ErrConfig(
                "state_dir is not set: provide $RMPC_STATE_DIR or `state_dir = \"...\"` in the config TOML"
                    .to_string(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
chain_id              = 31337
rpc_url               = "http://127.0.0.1:8545"
gateway_address       = "0x0000000000000000000000000000000000000001"
usdc_address          = "0x0000000000000000000000000000000000000002"
vault_address         = "0x0000000000000000000000000000000000000003"
gateway_runtime_hash  = "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "/var/lib/rmpc/keystore.enc"
"#;

    #[test]
    fn parses_full_config() {
        let cfg = Config::from_str(SAMPLE).expect("parses");
        assert_eq!(cfg.chain_id, 31337);
        assert_eq!(cfg.rpc_url, "http://127.0.0.1:8545");
        assert_eq!(
            cfg.gateway_address,
            "0x0000000000000000000000000000000000000001"
        );
        assert_eq!(
            cfg.usdc_address,
            "0x0000000000000000000000000000000000000002"
        );
        assert_eq!(
            cfg.vault_address,
            "0x0000000000000000000000000000000000000003"
        );
        assert_eq!(
            cfg.gateway_runtime_hash,
            "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        );
        assert_eq!(cfg.max_fee_per_gas_cap, Some(100_000_000_000u64));
        assert!(cfg.signer.allow_software_fallback);
        assert_eq!(
            cfg.signer.keystore_path,
            PathBuf::from("/var/lib/rmpc/keystore.enc")
        );
    }

    #[test]
    fn rejects_unknown_field() {
        let bad = format!("{SAMPLE}\nunknown_field = 1\n");
        assert!(Config::from_str(&bad).is_err());
    }

    #[test]
    fn rejects_unknown_signer_field() {
        let bad = SAMPLE.replace("[signer]", "[signer]\nunexpected = \"oops\"");
        assert!(Config::from_str(&bad).is_err());
    }

    #[test]
    fn round_trips_through_toml() {
        let cfg = Config::from_str(SAMPLE).unwrap();
        let serialized = toml::to_string(&cfg).unwrap();
        let cfg2 = Config::from_str(&serialized).unwrap();
        assert_eq!(cfg, cfg2);
    }

    #[test]
    fn priority_fee_cap_defaults_when_omitted() {
        let cfg = Config::from_str(SAMPLE).expect("parses");
        assert_eq!(cfg.max_priority_fee_per_gas_cap, None);
    }

    #[test]
    fn priority_fee_cap_round_trips_when_set() {
        let body = SAMPLE.replace(
            "[signer]",
            "max_priority_fee_per_gas_cap = 2000000000\n\n[signer]",
        );
        let cfg = Config::from_str(&body).expect("parses");
        assert_eq!(cfg.max_priority_fee_per_gas_cap, Some(2_000_000_000));
    }

    #[test]
    fn resolve_state_dir_prefers_env_var_over_config() {
        let body = SAMPLE.replace("[signer]", "state_dir = \"/from/config\"\n\n[signer]");
        let cfg = Config::from_str(&body).expect("parses");
        // SAFETY: unit test process, single-threaded for env access here.
        std::env::set_var("RMPC_STATE_DIR", "/from/env");
        assert_eq!(cfg.resolve_state_dir().unwrap(), PathBuf::from("/from/env"));
        std::env::remove_var("RMPC_STATE_DIR");
    }

    #[test]
    fn resolve_state_dir_uses_config_when_env_unset() {
        let body = SAMPLE.replace("[signer]", "state_dir = \"/from/config\"\n\n[signer]");
        let cfg = Config::from_str(&body).expect("parses");
        std::env::remove_var("RMPC_STATE_DIR");
        assert_eq!(
            cfg.resolve_state_dir().unwrap(),
            PathBuf::from("/from/config")
        );
    }

    #[test]
    fn resolve_state_dir_errors_when_neither_set() {
        let cfg = Config::from_str(SAMPLE).expect("parses");
        std::env::remove_var("RMPC_STATE_DIR");
        let err = cfg.resolve_state_dir().expect_err("must error");
        let msg = format!("{err}");
        assert!(msg.contains("state_dir"), "{msg}");
        assert!(msg.contains("RMPC_STATE_DIR"), "{msg}");
    }

    #[test]
    fn parses_explicit_log_block() {
        let body = format!(
            "{SAMPLE}\n[log]\nlevel = \"debug\"\ndir = \"/var/log/rmpc\"\nrotate_size_mb = 25\nkeep_files = 7\n"
        );
        let cfg = Config::from_str(&body).expect("parses");
        assert_eq!(cfg.log.level, "debug");
        assert_eq!(cfg.log.dir, PathBuf::from("/var/log/rmpc"));
        assert_eq!(cfg.log.rotate_size_mb, 25);
        assert_eq!(cfg.log.keep_files, 7);
    }

    #[test]
    fn log_config_defaults_when_section_omitted() {
        let cfg = Config::from_str(SAMPLE).expect("parses");
        assert_eq!(cfg.log.level, "info");
        assert_eq!(cfg.log.rotate_size_mb, 10);
        assert_eq!(cfg.log.keep_files, 14);
    }

    // -- issue #93 — per-chain fee-cap defaults -----------------------

    /// Build a config with the given chain id and TOML override for
    /// `max_fee_per_gas_cap`. `cap_line` should be a TOML line such as
    /// `"max_fee_per_gas_cap = 7"` or empty to leave the field omitted.
    fn cfg_for_chain(chain_id: u64, cap_line: &str) -> Config {
        let body = format!(
            r#"
chain_id              = {chain_id}
rpc_url               = "http://127.0.0.1:8545"
gateway_address       = "0x0000000000000000000000000000000000000001"
usdc_address          = "0x0000000000000000000000000000000000000002"
vault_address         = "0x0000000000000000000000000000000000000003"
gateway_runtime_hash  = "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
{cap_line}

[signer]
allow_software_fallback = true
keystore_path           = "/var/lib/rmpc/keystore.enc"
"#
        );
        Config::from_str(&body).expect("parses")
    }

    #[test]
    fn fee_cap_default_for_base_mainnet_is_one_gwei() {
        let cfg = cfg_for_chain(8453, "");
        assert_eq!(cfg.max_fee_per_gas_cap, None);
        assert_eq!(cfg.effective_max_fee_per_gas_cap(None), 1_000_000_000);
    }

    #[test]
    fn fee_cap_default_for_base_sepolia_is_one_gwei() {
        let cfg = cfg_for_chain(84532, "");
        assert_eq!(cfg.effective_max_fee_per_gas_cap(None), 1_000_000_000);
    }

    #[test]
    fn fee_cap_default_for_ethereum_mainnet_is_one_hundred_gwei() {
        let cfg = cfg_for_chain(1, "");
        assert_eq!(cfg.effective_max_fee_per_gas_cap(None), 100_000_000_000);
    }

    #[test]
    fn fee_cap_default_for_anvil_is_unlimited_high() {
        // Anvil — 1000 gwei, well above any sane fee bid so local
        // tests never trip the cap.
        let cfg = cfg_for_chain(31337, "");
        assert_eq!(cfg.effective_max_fee_per_gas_cap(None), 1_000_000_000_000);
    }

    #[test]
    fn fee_cap_unknown_chain_falls_back_to_one_hundred_gwei() {
        // 424242 is not in the per-chain table; resolver must return
        // the documented fallback. The `log::warn!` is fired but isn't
        // observable from a unit test without extra plumbing — covered
        // by the per-chain table tests above plus this fallback assert.
        let cfg = cfg_for_chain(424_242, "");
        assert_eq!(
            cfg.effective_max_fee_per_gas_cap(None),
            crate::fees::UNKNOWN_CHAIN_FEE_CAP_FALLBACK_WEI
        );
    }

    #[test]
    fn fee_cap_explicit_toml_override_beats_chain_default() {
        // Base default is 1 gwei; explicit TOML value of 42 wei must win.
        let cfg = cfg_for_chain(8453, "max_fee_per_gas_cap = 42");
        assert_eq!(cfg.effective_max_fee_per_gas_cap(None), 42);
    }

    #[test]
    fn fee_cap_cli_override_beats_toml_and_chain_default() {
        // CLI override must win over both the explicit TOML value and
        // the per-chain default — for any chain id.
        let cfg = cfg_for_chain(1, "max_fee_per_gas_cap = 42");
        assert_eq!(cfg.effective_max_fee_per_gas_cap(Some(7)), 7);

        let cfg = cfg_for_chain(8453, "");
        assert_eq!(cfg.effective_max_fee_per_gas_cap(Some(7)), 7);

        let cfg = cfg_for_chain(424_242, "");
        assert_eq!(cfg.effective_max_fee_per_gas_cap(Some(7)), 7);
    }

    #[test]
    fn log_config_env_overrides_apply() {
        let cfg = Config::from_str(SAMPLE).expect("parses");
        std::env::set_var("RMPC_LOG_LEVEL", "warn");
        std::env::set_var("RMPC_LOG_DIR", "/tmp/rmpc-test-logs");
        let log = cfg.log.clone().with_env_overrides();
        assert_eq!(log.level, "warn");
        assert_eq!(log.dir, PathBuf::from("/tmp/rmpc-test-logs"));
        std::env::remove_var("RMPC_LOG_LEVEL");
        std::env::remove_var("RMPC_LOG_DIR");
    }
}
