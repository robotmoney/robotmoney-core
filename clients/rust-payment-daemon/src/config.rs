//! TOML configuration loader.
//!
//! Field set is fixed by `docs/implementation-plan-mvp.md` §3.4–§3.7 and
//! issue #7. Unknown fields are rejected (`deny_unknown_fields`) so that a
//! typo in operator config fails loudly instead of silently using a default.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::errors::{Result, RmpdError};

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
    pub max_fee_per_gas_cap: u64,
    /// Signer backend configuration.
    pub signer: SignerConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SignerConfig {
    /// Must be `true` for the software signer to start (v0 §10.5).
    pub allow_software_fallback: bool,
    /// Path to the encrypted-at-rest keystore file.
    pub keystore_path: PathBuf,
}

impl Config {
    /// Load from a TOML file on disk.
    pub fn from_path<P: AsRef<Path>>(path: P) -> Result<Self> {
        let s = std::fs::read_to_string(path)?;
        Self::from_str(&s)
    }

    /// Parse from a TOML string.
    #[allow(clippy::should_implement_trait)] // existing API; not a `FromStr` (returns RmpdError)
    pub fn from_str(s: &str) -> Result<Self> {
        toml::from_str::<Self>(s).map_err(RmpdError::from)
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
keystore_path           = "/var/lib/rmpd/keystore.enc"
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
        assert_eq!(cfg.max_fee_per_gas_cap, 100_000_000_000u64);
        assert!(cfg.signer.allow_software_fallback);
        assert_eq!(
            cfg.signer.keystore_path,
            PathBuf::from("/var/lib/rmpd/keystore.enc")
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
}
