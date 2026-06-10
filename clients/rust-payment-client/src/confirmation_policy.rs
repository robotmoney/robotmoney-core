//! Canonical: docs/technical/security-model.md §12 — Off-chain chain & infrastructure
//!
//! Per-operation-class confirmation-depth policy for `rmpc`.
//!
//! Builds on the integration seam types from `crate::config`
//! ([`OperationClass`], [`RequiredFinality`], [`ConfirmationDepthPolicy`])
//! introduced by the client-stability seam-mapping pass: this module owns the
//! defaults (the policy table) and the string parsing/formatting used by the
//! `--op-class` / `--require-finality` CLI flags; `commands::get_tx` owns
//! enforcement.
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
//!   negligible for sub-$10k agent payment sizes. The `deposit` class covers
//!   BOTH gateway broadcast paths (issue #649): the single-vault
//!   `gateway.deposit()` default and the router `gateway.depositTo()` path
//!   (`rmpc deposit --destination <router>`) — router deposits are still
//!   agent deposits with the same safety boundary.
//! - Vault rebalance: involves ERC-4626 state transitions that affect share
//!   accounting. 6 confirmations provides a safety margin against shallow
//!   L2 reorgs without imposing the full L1-finality wait.
//! - Admin/governance: timelock-guarded, high-blast-radius operations
//!   (pause, role changes, router weight proposals). `l1_finalized` (64
//!   blocks ≈ 13 minutes on Base) is required so that any L1 reorg that
//!   could unwind the L2 state has been resolved before the operation is
//!   reported as irreversible.
//!
//! The table is fixed in code, not operator-tunable TOML: a security policy
//! that an operator config could weaken would not satisfy security-model.md
//! §12's "enforced by `rmpc`" requirement.
//!
//! # Integration with explorer-indexer
//!
//! The indexer's `CONFIRMATIONS = 5` in `services/explorer-indexer/src/lib.rs`
//! is an independent internal block-ingestion safety margin (ADR §3.3) and
//! does NOT replace this per-operation-class policy. The indexer margin ensures
//! the indexer does not ingest blocks that might be reorged away; this table
//! ensures `rmpc` reports the correct finality status to callers.

pub use crate::config::{ConfirmationDepthPolicy, OperationClass, RequiredFinality};

impl OperationClass {
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

impl std::fmt::Display for OperationClass {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl RequiredFinality {
    /// Stable wire string.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::L2Included => "l2_included",
            Self::L1Finalized => "l1_finalized",
        }
    }
}

impl std::fmt::Display for RequiredFinality {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Look up the confirmation policy for an operation class.
///
/// This is the authoritative policy table; changes here propagate to both
/// the `rmpc get-tx` finality report and the `--require-finality` exit-code
/// enforcement.
pub fn policy_for(op_class: OperationClass) -> ConfirmationDepthPolicy {
    match op_class {
        OperationClass::Deposit => ConfirmationDepthPolicy {
            operation_class: op_class,
            minimum_confirmations: 1,
            required_finality: RequiredFinality::L2Included,
        },
        OperationClass::Withdraw => ConfirmationDepthPolicy {
            operation_class: op_class,
            minimum_confirmations: 1,
            required_finality: RequiredFinality::L2Included,
        },
        OperationClass::VaultRebalance => ConfirmationDepthPolicy {
            operation_class: op_class,
            minimum_confirmations: 6,
            required_finality: RequiredFinality::L2Included,
        },
        OperationClass::AdminGovernance => ConfirmationDepthPolicy {
            operation_class: op_class,
            minimum_confirmations: 64,
            required_finality: RequiredFinality::L1Finalized,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_class_from_str_ci_all_variants() {
        assert_eq!(
            OperationClass::from_str_ci("deposit"),
            Some(OperationClass::Deposit)
        );
        assert_eq!(
            OperationClass::from_str_ci("withdraw"),
            Some(OperationClass::Withdraw)
        );
        assert_eq!(
            OperationClass::from_str_ci("vault_rebalance"),
            Some(OperationClass::VaultRebalance)
        );
        assert_eq!(
            OperationClass::from_str_ci("vault-rebalance"),
            Some(OperationClass::VaultRebalance)
        );
        assert_eq!(
            OperationClass::from_str_ci("admin_governance"),
            Some(OperationClass::AdminGovernance)
        );
        assert_eq!(
            OperationClass::from_str_ci("admin-governance"),
            Some(OperationClass::AdminGovernance)
        );
        assert_eq!(OperationClass::from_str_ci("unknown"), None);
    }

    #[test]
    fn policy_deposit_requires_1_confirmation_l2() {
        let p = policy_for(OperationClass::Deposit);
        assert_eq!(p.operation_class, OperationClass::Deposit);
        assert_eq!(p.minimum_confirmations, 1);
        assert_eq!(p.required_finality, RequiredFinality::L2Included);
    }

    #[test]
    fn policy_withdraw_requires_1_confirmation_l2() {
        let p = policy_for(OperationClass::Withdraw);
        assert_eq!(p.minimum_confirmations, 1);
        assert_eq!(p.required_finality, RequiredFinality::L2Included);
    }

    #[test]
    fn policy_vault_rebalance_requires_6_confirmations_l2() {
        let p = policy_for(OperationClass::VaultRebalance);
        assert_eq!(p.minimum_confirmations, 6);
        assert_eq!(p.required_finality, RequiredFinality::L2Included);
    }

    #[test]
    fn policy_admin_governance_requires_64_confirmations_l1() {
        let p = policy_for(OperationClass::AdminGovernance);
        assert_eq!(p.minimum_confirmations, 64);
        assert_eq!(p.required_finality, RequiredFinality::L1Finalized);
    }

    #[test]
    fn required_finality_serializes_as_snake_case() {
        let l2 = serde_json::to_value(RequiredFinality::L2Included).unwrap();
        assert_eq!(l2, "l2_included");
        let l1 = serde_json::to_value(RequiredFinality::L1Finalized).unwrap();
        assert_eq!(l1, "l1_finalized");
    }

    #[test]
    fn op_class_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_value(OperationClass::AdminGovernance).unwrap(),
            "admin_governance"
        );
        assert_eq!(
            serde_json::to_value(OperationClass::VaultRebalance).unwrap(),
            "vault_rebalance"
        );
    }
}
