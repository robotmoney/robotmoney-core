//! Canonical: docs/implementation-plan.md §4 — Phase 1 Rust client
//!
//! Network environment classification helper.
//!
//! Maps a configured or observed chain id to a human-readable environment
//! label so every CLI command and agent skill response can unambiguously
//! name the active network before presenting results or signing actions.
//!
//! # Rationale
//!
//! Users and autonomous agents need an unmistakable signal when they are
//! interacting with Robot Money testnet, local devnet, or production Base.
//! Chain id is authoritative — this module maps it to a friendly label
//! without replacing the chain-id or code-hash preflight checks, which
//! remain the safety gate.
//!
//! # Wire values
//!
//! The [`NetworkEnv::as_str`] output is part of the stable operator-visible
//! contract. Downstream consumers MUST NOT hard-code the integer chain ids;
//! they SHOULD match on the string label so the mapping can be extended.
//!
//! | Chain id | Label              |
//! |----------|--------------------|
//! | 31337    | `local_devnet`     |
//! | 84532    | `rm_testnet`       |
//! | 8453     | `production_base`  |
//! | other    | `unknown`          |
//!
//! # Usage example
//!
//! ```
//! use rust_payment_client::network_env::NetworkEnv;
//!
//! let env = NetworkEnv::from_chain_id(8453);
//! assert_eq!(env.as_str(), "production_base");
//! assert!(env.is_production());
//! println!("{}", env.human_label());
//! ```

use serde::Serialize;

/// Network environment derived from a chain id.
///
/// Production Base is explicitly distinguished from test environments so
/// callers can apply the required production warning without any chain-id
/// knowledge of their own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkEnv {
    /// Anvil / Hardhat local devnet (chain id 31337).
    LocalDevnet,
    /// Robot Money testnet — Base Sepolia (chain id 84532).
    RmTestnet,
    /// Production Base mainnet (chain id 8453). Requires an explicit
    /// production warning before any write action.
    ProductionBase,
    /// Unrecognised chain id. The existing chain-id and code-hash refusals
    /// remain authoritative; this label does not bypass them.
    Unknown,
}

impl NetworkEnv {
    /// Classify a chain id into a [`NetworkEnv`].
    ///
    /// The mapping is intentionally minimal and stable: new chains require
    /// an explicit entry here, ensuring they don't silently fall through to
    /// `Unknown` without a log warning.
    pub fn from_chain_id(chain_id: u64) -> Self {
        match chain_id {
            31337 => Self::LocalDevnet,
            84532 => Self::RmTestnet,
            8453 => Self::ProductionBase,
            _ => Self::Unknown,
        }
    }

    /// Stable machine-readable wire string. Part of the operator-visible
    /// contract; snapshot tests assert on the literal values.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LocalDevnet => "local_devnet",
            Self::RmTestnet => "rm_testnet",
            Self::ProductionBase => "production_base",
            Self::Unknown => "unknown",
        }
    }

    /// Human-readable label for log lines and agent skill feedback.
    ///
    /// Production Base is annotated with `[PRODUCTION]` so the label is
    /// visually distinct from test environments in terminal output and
    /// log files.
    pub const fn human_label(self) -> &'static str {
        match self {
            Self::LocalDevnet => "local devnet",
            Self::RmTestnet => "Robot Money testnet (Base Sepolia)",
            Self::ProductionBase => "[PRODUCTION] Base mainnet",
            Self::Unknown => "unknown chain",
        }
    }

    /// Returns `true` only for [`NetworkEnv::ProductionBase`].
    ///
    /// Callers that need a conditional production warning use this rather
    /// than pattern-matching, to stay stable if new production environments
    /// are ever added.
    pub const fn is_production(self) -> bool {
        matches!(self, Self::ProductionBase)
    }

    /// Returns the production warning message that must appear in CLI logs
    /// and agent skill feedback before any write action on production Base.
    ///
    /// Returns `None` on non-production environments.
    pub const fn production_warning(self) -> Option<&'static str> {
        if self.is_production() {
            Some("WARNING: connected to production Base mainnet — real assets are at risk")
        } else {
            None
        }
    }
}

impl std::fmt::Display for NetworkEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.human_label())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_devnet_chain_id() {
        let env = NetworkEnv::from_chain_id(31337);
        assert_eq!(env, NetworkEnv::LocalDevnet);
        assert_eq!(env.as_str(), "local_devnet");
        assert!(!env.is_production());
        assert!(env.production_warning().is_none());
    }

    #[test]
    fn rm_testnet_chain_id() {
        let env = NetworkEnv::from_chain_id(84532);
        assert_eq!(env, NetworkEnv::RmTestnet);
        assert_eq!(env.as_str(), "rm_testnet");
        assert!(!env.is_production());
        assert!(env.production_warning().is_none());
    }

    #[test]
    fn production_base_chain_id() {
        let env = NetworkEnv::from_chain_id(8453);
        assert_eq!(env, NetworkEnv::ProductionBase);
        assert_eq!(env.as_str(), "production_base");
        assert!(env.is_production());
        assert!(env.production_warning().is_some());
        assert!(env
            .production_warning()
            .unwrap()
            .contains("production Base mainnet"));
    }

    #[test]
    fn unknown_chain_id() {
        let env = NetworkEnv::from_chain_id(1); // Ethereum mainnet — not a RM chain
        assert_eq!(env, NetworkEnv::Unknown);
        assert_eq!(env.as_str(), "unknown");
        assert!(!env.is_production());
        assert!(env.production_warning().is_none());
    }

    #[test]
    fn another_unknown_chain_id() {
        let env = NetworkEnv::from_chain_id(424_242);
        assert_eq!(env, NetworkEnv::Unknown);
    }

    #[test]
    fn as_str_values_are_stable() {
        // These strings are part of the operator-visible wire contract.
        assert_eq!(NetworkEnv::LocalDevnet.as_str(), "local_devnet");
        assert_eq!(NetworkEnv::RmTestnet.as_str(), "rm_testnet");
        assert_eq!(NetworkEnv::ProductionBase.as_str(), "production_base");
        assert_eq!(NetworkEnv::Unknown.as_str(), "unknown");
    }

    #[test]
    fn serializes_as_snake_case_string() {
        let v = serde_json::to_value(NetworkEnv::ProductionBase).unwrap();
        assert_eq!(v, serde_json::json!("production_base"));

        let v = serde_json::to_value(NetworkEnv::LocalDevnet).unwrap();
        assert_eq!(v, serde_json::json!("local_devnet"));

        let v = serde_json::to_value(NetworkEnv::RmTestnet).unwrap();
        assert_eq!(v, serde_json::json!("rm_testnet"));

        let v = serde_json::to_value(NetworkEnv::Unknown).unwrap();
        assert_eq!(v, serde_json::json!("unknown"));
    }

    #[test]
    fn human_label_production_is_visually_distinct() {
        // Production label must contain a distinguishing marker so it is
        // visually unmistakable from test/devnet output.
        let label = NetworkEnv::ProductionBase.human_label();
        assert!(
            label.contains("PRODUCTION"),
            "production label must contain PRODUCTION: {label}"
        );
    }

    #[test]
    fn display_matches_human_label() {
        for env in [
            NetworkEnv::LocalDevnet,
            NetworkEnv::RmTestnet,
            NetworkEnv::ProductionBase,
            NetworkEnv::Unknown,
        ] {
            assert_eq!(format!("{env}"), env.human_label());
        }
    }
}
