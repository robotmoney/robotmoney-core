//! Canonical: docs/technical/security-model.md §12 — Off-chain chain & infrastructure
//!
//! Per-operation-class confirmation-depth policy for `rmpc`.
//!
//! # Policy table
//!
//! | Operation class    | Min confirmations | Required finality level |
//! |--------------------|-------------------|-------------------------|
//! | `deposit`          | 1                 | `l2_included`           |
//! | `withdraw`         | 1                 | `l2_included`           |
//! | `vault_rebalance`  | 6                 | `l2_included`           |
//! | `admin_governance` | 64                | `l1_finalized`          |
//!
//! Rationale:
//! - Deposits and withdrawals: a single inclusion confirmation on L2 is
//!   sufficient for day-to-day agent operations. Base's sequencer posts to L1
//!   roughly every 12 minutes; reorg risk on already-included L2 blocks is
//!   negligible for sub-$10k agent payment sizes.
//! - Vault rebalance: involves ERC-4626 state transitions that affect share
//!   accounting. 6 confirmations provides a safety margin against shallow
//!   L2 reorgs without imposing the full L1-finality wait.
//! - Admin/governance: timelock-guarded, high-blast-radius operations
//!   (pause, role changes, router weight proposals). `l1_finalized` (64
//!   blocks ≈ 13 minutes on Base) is required so that any L1 reorg that
//!   could unwind the L2 state has been resolved before the operation is
//!   reported as irreversible.
//!
//! # Integration with explorer-indexer
//!
//! The indexer's `CONFIRMATIONS = 5` in `services/explorer-indexer/src/lib.rs`
//! is an independent internal block-ingestion safety margin (ADR §3.3) and
//! does NOT replace this per-operation-class policy. The indexer margin ensures
//! the indexer does not ingest blocks that might be reorged away; this table
//! ensures `rmpc` reports the correct finality status to callers.

use serde::{Deserialize, Serialize};

/// Operation class — determines the minimum confirmation depth and required
/// finality level. Passed via `--op-class` on `rmpc get-tx`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpClass {
    /// Agent deposit through the gateway.
    Deposit,
    /// Agent withdrawal (share redemption) through the gateway.
    Withdraw,
    /// Vault asset rebalancing / adapter allocation changes.
    VaultRebalance,
    /// Admin or governance operation (pause, role change, router proposal,
    /// timelock execution). Requires `l1_finalized`.
    AdminGovernance,
}

impl OpClass {
    /// Parse from a case-insensitive string matching the `--op-class` flag.
    pub fn from_str_ci(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "deposit" => Some(Self::Deposit),
            "withdraw" => Some(Self::Withdraw),
            "vault_rebalance" | "vault-rebalance" => Some(Self::VaultRebalance),
            "admin_governance" | "admin-governance" => Some(Self::AdminGovernance),
            _ => None,
        }
    }

    /// Stable wire string for this operation class. Matches the `snake_case`
    /// serde output and the `--op-class` flag values.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Deposit => "deposit",
            Self::Withdraw => "withdraw",
            Self::VaultRebalance => "vault_rebalance",
            Self::AdminGovernance => "admin_governance",
        }
    }
}

impl std::fmt::Display for OpClass {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Required finality level for an operation class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequiredFinalityLevel {
    /// The transaction need only be included in an L2 block (sequencer-confirmed).
    L2Included,
    /// The transaction must be covered by a posted L1 batch that has
    /// accumulated enough L1 confirmations to be considered irreversible.
    L1Finalized,
}

impl RequiredFinalityLevel {
    /// Stable wire string.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::L2Included => "l2_included",
            Self::L1Finalized => "l1_finalized",
        }
    }
}

impl std::fmt::Display for RequiredFinalityLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Policy entry for a single operation class.
#[derive(Debug, Clone, Copy)]
pub struct PolicyEntry {
    /// Minimum number of blocks that must have been mined on top of the
    /// transaction's inclusion block before `rmpc` reports it as final.
    pub min_confirmations: u64,
    /// Required finality level (L2 or L1).
    pub required_level: RequiredFinalityLevel,
}

/// Look up the confirmation policy for an operation class.
///
/// This is the authoritative policy table; changes here propagate to both
/// the `rmpc get-tx` finality report and the `--require-finality` exit-code
/// enforcement.
pub fn policy_for(op_class: OpClass) -> PolicyEntry {
    match op_class {
        OpClass::Deposit => PolicyEntry {
            min_confirmations: 1,
            required_level: RequiredFinalityLevel::L2Included,
        },
        OpClass::Withdraw => PolicyEntry {
            min_confirmations: 1,
            required_level: RequiredFinalityLevel::L2Included,
        },
        OpClass::VaultRebalance => PolicyEntry {
            min_confirmations: 6,
            required_level: RequiredFinalityLevel::L2Included,
        },
        OpClass::AdminGovernance => PolicyEntry {
            min_confirmations: 64,
            required_level: RequiredFinalityLevel::L1Finalized,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_class_from_str_ci_all_variants() {
        assert_eq!(OpClass::from_str_ci("deposit"), Some(OpClass::Deposit));
        assert_eq!(OpClass::from_str_ci("withdraw"), Some(OpClass::Withdraw));
        assert_eq!(
            OpClass::from_str_ci("vault_rebalance"),
            Some(OpClass::VaultRebalance)
        );
        assert_eq!(
            OpClass::from_str_ci("vault-rebalance"),
            Some(OpClass::VaultRebalance)
        );
        assert_eq!(
            OpClass::from_str_ci("admin_governance"),
            Some(OpClass::AdminGovernance)
        );
        assert_eq!(
            OpClass::from_str_ci("admin-governance"),
            Some(OpClass::AdminGovernance)
        );
        assert_eq!(OpClass::from_str_ci("unknown"), None);
    }

    #[test]
    fn policy_deposit_requires_1_confirmation_l2() {
        let p = policy_for(OpClass::Deposit);
        assert_eq!(p.min_confirmations, 1);
        assert_eq!(p.required_level, RequiredFinalityLevel::L2Included);
    }

    #[test]
    fn policy_withdraw_requires_1_confirmation_l2() {
        let p = policy_for(OpClass::Withdraw);
        assert_eq!(p.min_confirmations, 1);
        assert_eq!(p.required_level, RequiredFinalityLevel::L2Included);
    }

    #[test]
    fn policy_vault_rebalance_requires_6_confirmations_l2() {
        let p = policy_for(OpClass::VaultRebalance);
        assert_eq!(p.min_confirmations, 6);
        assert_eq!(p.required_level, RequiredFinalityLevel::L2Included);
    }

    #[test]
    fn policy_admin_governance_requires_64_confirmations_l1() {
        let p = policy_for(OpClass::AdminGovernance);
        assert_eq!(p.min_confirmations, 64);
        assert_eq!(p.required_level, RequiredFinalityLevel::L1Finalized);
    }

    #[test]
    fn required_finality_level_serializes_as_snake_case() {
        let l2 = serde_json::to_value(RequiredFinalityLevel::L2Included).unwrap();
        assert_eq!(l2, "l2_included");
        let l1 = serde_json::to_value(RequiredFinalityLevel::L1Finalized).unwrap();
        assert_eq!(l1, "l1_finalized");
    }

    #[test]
    fn op_class_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_value(OpClass::AdminGovernance).unwrap(),
            "admin_governance"
        );
        assert_eq!(
            serde_json::to_value(OpClass::VaultRebalance).unwrap(),
            "vault_rebalance"
        );
    }
}
