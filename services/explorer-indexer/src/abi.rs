//! ABI surfaces the indexer decodes — IGateway, RobotMoneyVault, and
//! VaultRegistry events plus the ERC-4626 / vault state reads.  Mirrors
//! the contract sources in `contracts/gateway/interfaces/IGateway.sol`,
//! `contracts/RobotMoneyVault.sol`, and the canonical event signatures
//! in `docs/technical/vault-registry-decisions.md` §3.5.
//!
//! # ABI Drift Map (dev-scout #383 findings — 2026-05-15)
//!
//! The following divergences were identified between the `sol!` declarations
//! in this file and the compiled Solidity sources.  Each item maps to the
//! downstream fix issue that will correct it.  No runtime behavior is changed
//! by this scout pass — only documentation is added.
//!
//! ## IGatewayEvents — `contracts/gateway/interfaces/IGateway.sol`
//!
//! ### `AgentAuthorized` — DRIFTED (fix in issue #366)
//! - **abi.rs (current):**
//!   `AgentAuthorized(address indexed agent, uint64 validUntil, uint256 maxPerPayment, uint256 maxPerWindow, address shareReceiver)`
//! - **IGateway.sol:74 (authoritative):**
//!   `AgentAuthorized(address indexed agent, address indexed owner, uint64 validUntil, uint256 maxPerPayment, uint256 maxPerWindow, address shareReceiver)`
//! - **Missing:** `address indexed owner` as second parameter.
//! - **Topic-0 impact:** `keccak256("AgentAuthorized(address,uint64,uint256,uint256,address)")` ≠
//!   `keccak256("AgentAuthorized(address,address,uint64,uint256,uint256,address)")` — all
//!   `AgentAuthorized` events are silently dropped by the indexer.
//!
//! ### `AgentRevoked` — DRIFTED (fix in issue #366)
//! - **abi.rs (current):**
//!   `AgentRevoked(address indexed agent)`
//! - **IGateway.sol:85 (authoritative):**
//!   `AgentRevoked(address indexed agent, address indexed owner)`
//! - **Missing:** `address indexed owner` as second parameter.
//! - **Topic-0 impact:** All `AgentRevoked` events silently dropped.
//!
//! ### `AgentDepositRouted` — MISSING (not indexed; add if needed)
//! - **IGateway.sol:119** declares `AgentDepositRouted(...)` for multi-leg router deposits.
//!   Not present in this file — add to `IGatewayEvents` when router path is ingested.
//!
//! ### `AgentWithdrawal` — MISSING (not indexed; add if needed)
//! - **IGateway.sol:139** declares `AgentWithdrawal(...)` for agent-initiated withdrawals.
//!   Not present in this file — add to `IGatewayEvents` when withdrawal path is ingested.
//!
//! ## IVaultRegistryEvents — `contracts/VaultRegistry.sol`
//!
//! ### `VaultRegistered` — DRIFTED (fix in issue #366)
//! - **abi.rs (current):**
//!   `VaultRegistered(address indexed vault, string name, string riskLabel, uint256 depositCap, uint64 registeredAt)`
//! - **VaultRegistry.sol:67 (authoritative):**
//!   `VaultRegistered(address indexed vault, string name, address indexed asset)`
//! - **Fields removed:** `riskLabel`, `depositCap`, `registeredAt` (no longer in Solidity).
//! - **Fields added:** `asset` (indexed address).
//! - **Topic-0 impact:** All `VaultRegistered` events silently dropped.
//!
//! ### `VaultStatusChanged` — DRIFTED (fix in issue #366)
//! - **abi.rs (current):**
//!   `VaultStatusChanged(address indexed vault, uint8 oldStatus, uint8 newStatus, uint64 changedAt)`
//! - **VaultRegistry.sol:73 (authoritative):**
//!   `VaultStatusChanged(address indexed vault, VaultStatus indexed newStatus, uint256 timestamp)`
//! - **Fields removed:** `oldStatus`, `changedAt`.
//! - **Fields changed:** `newStatus` is now `indexed`; `timestamp` is `uint256` not `uint64`.
//! - **Topic-0 impact:** All `VaultStatusChanged` events silently dropped.
//!
//! ## IRouterGovernanceEvents — `contracts/RouterGovernance.sol`
//!
//! ### `ProposalCreated` — DRIFTED (fix in issue #366)
//! - **abi.rs (current):**
//!   `ProposalCreated(uint256 indexed proposalId, address indexed proposer, string description, uint256 deadlineBlock, uint64 createdAt)`
//! - **RouterGovernance.sol:106 (authoritative):**
//!   `ProposalCreated(uint256 indexed proposalId, address indexed proposer, address[] vaults, uint256[] bps, uint64 votingDeadline)`
//! - **Fields changed:** `description`→`address[] vaults`, `deadlineBlock`→`uint256[] bps`, `createdAt`→`uint64 votingDeadline`.
//! - **Topic-0 impact:** All `ProposalCreated` events silently dropped.
//!
//! ### `VoteCast` — DRIFTED (fix in issue #366)
//! - **abi.rs (current):**
//!   `VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight)`
//! - **RouterGovernance.sol:119 (authoritative):**
//!   `VoteCast(uint256 indexed proposalId, address indexed voter, uint256 power, uint256 totalFor)`
//! - **Fields changed:** `bool support` removed, `weight`→`power`, `totalFor` added.
//! - **Topic-0 impact:** All `VoteCast` events silently dropped.
//!
//! ### `ProposalExecuted` — DRIFTED (fix in issue #366)
//! - **abi.rs (current):**
//!   `ProposalExecuted(uint256 indexed proposalId)`
//! - **RouterGovernance.sol:126 (authoritative):**
//!   `ProposalExecuted(uint256 indexed proposalId, address indexed executor)`
//! - **Missing:** `address indexed executor`.
//! - **Topic-0 impact:** All `ProposalExecuted` events silently dropped.
//!
//! ### `WeightsSet` → `WeightsApplied` — NAME AND SIGNATURE DRIFTED (fix in issue #366)
//! - **abi.rs (current):**
//!   `WeightsSet(address[] vaults, uint256[] bps)`
//! - **RouterGovernance.sol:132 (authoritative):**
//!   `WeightsApplied(uint256 indexed proposalId, address[] vaults, uint256[] bps)`
//! - **Name changed** from `WeightsSet` to `WeightsApplied`; `proposalId` added.
//! - **Topic-0 impact:** All `WeightsApplied` events silently dropped (wrong name too).
//!
//! # Vault Pause Split Seam (issue #368)
//!
//! `RobotMoneyVault` inherits OZ `Pausable` which uses a single boolean pause flag.
//! Both `_deposit` (line 303: `whenNotPaused`) and `_withdraw` (line 401: `whenNotPaused`)
//! gate on the same flag.  `emergencyWithdraw()` (line 610) calls `_pause()` then drains
//! adapters — leaving USDC idle in the vault — but blocks all user redemptions because
//! `_withdraw` is still guarded by `whenNotPaused`.
//!
//! **State variables to split for issue #368:**
//! - Replace OZ `Pausable` (single `_paused` bool) with two independent booleans:
//!   `depositsPaused` and `withdrawalsPaused` (or equivalent modifier split).
//! - `pause()` (EMERGENCY_ROLE) sets both to `true`.
//! - `emergencyWithdraw()` (EMERGENCY_ROLE) sets only `depositsPaused = true`.
//! - `unpause()` (ADMIN_ROLE) clears both.
//! - `_deposit` guards on `depositsPaused`; `_withdraw` guards on `withdrawalsPaused`.
//! - Coupling risk: removing OZ `Pausable` also removes `Paused(address)`/`Unpaused(address)`
//!   events from the inherited contract — those are re-declared in `IGateway` (gateway-side);
//!   the vault emits them via `_pause()`/`_unpause()` calls today.  Issue #368 must either
//!   retain those OZ events or re-emit them manually from the new modifier paths.
//!
//! # Gateway Pinned-Vault vs Multi-Vault Constraint (issue #370)
//!
//! `IGateway.sol:35` documents `allowedDestinations`: "An empty array disables the allowlist —
//! any registered vault or the router is permitted." `IGateway.sol:46` similarly documents
//! `allowedSourceVaults`: "An empty array permits any registered vault."
//!
//! **Actual enforcement in `RobotMoneyGateway.sol`:**
//! - `_validateDestination` (line 473): checks `destination == address(vaultContract)` OR
//!   `destination == address(routerContract)` — only the single pinned vault and the router.
//! - `withdraw()` (line 599): `if (sourceVault != address(vaultContract)) revert InvalidSourceVault()`.
//! - **Conclusion: Option A (docs fix) is sufficient.** There is no VaultRegistry injection
//!   point in the constructor or storage — the immutables `vaultContract` and `routerContract`
//!   are the only valid targets. Issue #370 should update IGateway NatSpec for both
//!   `allowedDestinations` (line 35-40) and `allowedSourceVaults` (line 46-48) to state:
//!   "When empty, only the pinned vault (`vault()`) and the portfolio router (`router()`) are
//!   accepted." No contract logic change is required for Option A.
//!
//! # Governance Documentation Ownership (issue #372)
//!
//! `RouterGovernance.sol` implements admin-weighted voting via explicit `votingPower` mapping
//! (set by `ADMIN_ROLE` via `setVotingPower`).  The contract is NOT token-holder governance.
//! Documentation in `docs/prd.md` and NatSpec should label it as an admin-weighted MVP mock.
//! The `WeightsApplied` event (not `WeightsSet`) is the canonical on-chain signal that the
//! weight vector changed as a result of a governance proposal execution.

use alloy_primitives::{keccak256, B256};
use alloy_sol_types::sol;

sol! {
    /// Event surface from `RouterGovernance` and `PortfolioRouter`.
    ///
    /// ProposalCreated / VoteCast / ProposalExecuted are emitted by the
    /// RouterGovernance contract (docs/architecture.md §5.4).  WeightsSet is
    /// emitted by PortfolioRouter each time the weight vector is updated
    /// (also called WeightsApplied in the issue — same on-chain event).
    #[allow(missing_docs)]
    interface IRouterGovernanceEvents {
        /// Emitted when a new governance proposal is created.
        event ProposalCreated(
            uint256 indexed proposalId,
            address indexed proposer,
            string  description,
            uint256 deadlineBlock,
            uint64  createdAt
        );

        /// Emitted when a voter casts a vote.
        event VoteCast(
            uint256 indexed proposalId,
            address indexed voter,
            bool    support,
            uint256 weight
        );

        /// Emitted when a passed proposal is executed and weights applied.
        event ProposalExecuted(uint256 indexed proposalId);

        /// Emitted by PortfolioRouter when the weight vector is set.
        /// This is the on-chain `WeightsSet` event; the issue calls it
        /// `WeightsApplied` — same signature.
        event WeightsSet(address[] vaults, uint256[] bps);
    }

    /// Event surface from `IGateway`. Names match the Solidity source so
    /// `SolEvent::SIGNATURE_HASH` lines up with the on-chain topic.
    #[allow(missing_docs)]
    interface IGatewayEvents {
        event AgentAuthorized(
            address indexed agent,
            uint64 validUntil,
            uint256 maxPerPayment,
            uint256 maxPerWindow,
            address shareReceiver
        );
        event AgentRevoked(address indexed agent);
        event Paused(address indexed by);
        event Unpaused(address indexed by);
        event AgentDeposit(
            bytes32 indexed paymentId,
            bytes32 indexed orderId,
            address indexed agent,
            address shareReceiver,
            uint256 amount,
            uint256 sharesMinted,
            uint64 windowId
        );
    }

    /// Event surface from `RobotMoneyVault`. Trigger set for state
    /// snapshots per ADR §3.5.
    #[allow(missing_docs)]
    interface IVaultEvents {
        event Allocated(uint256 indexed index, address indexed adapter, uint256 amount);
        event Pulled(uint256 indexed index, address indexed adapter, uint256 amount);
        event Rebalanced(uint256 totalMoved);
        event ExitFeeCharged(
            address indexed owner,
            address indexed receiver,
            uint256 grossAssets,
            uint256 fee,
            uint256 netAssets
        );
    }

    /// Read surface for vault state snapshots.
    #[allow(missing_docs)]
    interface IVaultReads {
        function totalAssets() external view returns (uint256);
        function totalSupply() external view returns (uint256);
        function exitFeeBps() external view returns (uint256);
        function tvlCap() external view returns (uint256);
        function paused() external view returns (bool);
    }

    /// Event surface from `VaultRegistry`.  Canonical signatures are
    /// defined in `docs/technical/vault-registry-decisions.md` §3.5 and
    /// must appear verbatim in `VaultRegistry.sol`.
    #[allow(missing_docs)]
    interface IVaultRegistryEvents {
        /// Emitted once when a vault is added to the registry.
        event VaultRegistered(
            address indexed vault,
            string  name,
            string  riskLabel,
            uint256 depositCap,
            uint64  registeredAt
        );

        /// Emitted each time an admin changes a vault's operational status.
        event VaultStatusChanged(
            address indexed vault,
            uint8           oldStatus,
            uint8           newStatus,
            uint64          changedAt
        );
    }

    /// Minimum stable read surface for `VaultRegistry`.  Defined in
    /// `docs/technical/vault-registry-decisions.md` §3.4.
    #[allow(missing_docs)]
    interface IVaultRegistryReads {
        /// Returns all registered vault addresses regardless of status.
        function listVaults() external view returns (address[] memory);
        /// Returns the number of registered vaults (all statuses).
        function vaultCount() external view returns (uint256);
    }
}

/// Topic-0 hashes the indexer matches on `eth_getLogs`. Computed once
/// at startup from the canonical event signature strings.
pub struct Topics {
    pub agent_authorized: B256,
    pub agent_revoked: B256,
    pub agent_deposit: B256,
    pub paused: B256,
    pub unpaused: B256,
    pub vault_allocated: B256,
    pub vault_pulled: B256,
    pub vault_rebalanced: B256,
    pub vault_exit_fee_charged: B256,
    // VaultRegistry events — docs/technical/vault-registry-decisions.md §3.5.
    pub vault_registered: B256,
    pub vault_status_changed: B256,
    // RouterGovernance + PortfolioRouter events — docs/architecture.md §5.4.
    pub proposal_created: B256,
    pub vote_cast: B256,
    pub proposal_executed: B256,
    pub weights_set: B256,
}

impl Topics {
    pub fn new() -> Self {
        Self {
            agent_authorized: keccak256(b"AgentAuthorized(address,uint64,uint256,uint256,address)"),
            agent_revoked: keccak256(b"AgentRevoked(address)"),
            agent_deposit: keccak256(
                b"AgentDeposit(bytes32,bytes32,address,address,uint256,uint256,uint64)",
            ),
            paused: keccak256(b"Paused(address)"),
            unpaused: keccak256(b"Unpaused(address)"),
            vault_allocated: keccak256(b"Allocated(uint256,address,uint256)"),
            vault_pulled: keccak256(b"Pulled(uint256,address,uint256)"),
            vault_rebalanced: keccak256(b"Rebalanced(uint256)"),
            vault_exit_fee_charged: keccak256(
                b"ExitFeeCharged(address,address,uint256,uint256,uint256)",
            ),
            // VaultRegistry — docs/technical/vault-registry-decisions.md §3.5.
            vault_registered: keccak256(b"VaultRegistered(address,string,string,uint256,uint64)"),
            vault_status_changed: keccak256(b"VaultStatusChanged(address,uint8,uint8,uint64)"),
            // RouterGovernance + PortfolioRouter — docs/architecture.md §5.4.
            proposal_created: keccak256(b"ProposalCreated(uint256,address,string,uint256,uint64)"),
            vote_cast: keccak256(b"VoteCast(uint256,address,bool,uint256)"),
            proposal_executed: keccak256(b"ProposalExecuted(uint256)"),
            weights_set: keccak256(b"WeightsSet(address[],uint256[])"),
        }
    }

    /// All topic-0s the indexer subscribes to, suitable for an
    /// `eth_getLogs` `topics: [[t0, t1, ...]]` first-slot OR-filter.
    pub fn all_topic0(&self) -> Vec<B256> {
        vec![
            self.agent_authorized,
            self.agent_revoked,
            self.agent_deposit,
            self.paused,
            self.unpaused,
            self.vault_allocated,
            self.vault_pulled,
            self.vault_rebalanced,
            self.vault_exit_fee_charged,
            self.vault_registered,
            self.vault_status_changed,
            self.proposal_created,
            self.vote_cast,
            self.proposal_executed,
            self.weights_set,
        ]
    }
}

impl Default for Topics {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_sol_types::SolEvent;

    /// Sanity-check: locally-computed topic hashes match what `sol!`
    /// derives. If a contract event signature drifts, this catches it.
    #[test]
    fn topic_hashes_match_sol_macros() {
        let t = Topics::new();
        assert_eq!(
            t.agent_deposit,
            IGatewayEvents::AgentDeposit::SIGNATURE_HASH
        );
        assert_eq!(
            t.agent_authorized,
            IGatewayEvents::AgentAuthorized::SIGNATURE_HASH
        );
        assert_eq!(
            t.agent_revoked,
            IGatewayEvents::AgentRevoked::SIGNATURE_HASH
        );
        assert_eq!(t.paused, IGatewayEvents::Paused::SIGNATURE_HASH);
        assert_eq!(t.unpaused, IGatewayEvents::Unpaused::SIGNATURE_HASH);
        assert_eq!(t.vault_allocated, IVaultEvents::Allocated::SIGNATURE_HASH);
        assert_eq!(t.vault_pulled, IVaultEvents::Pulled::SIGNATURE_HASH);
        assert_eq!(t.vault_rebalanced, IVaultEvents::Rebalanced::SIGNATURE_HASH);
        assert_eq!(
            t.vault_exit_fee_charged,
            IVaultEvents::ExitFeeCharged::SIGNATURE_HASH
        );
        // VaultRegistry events — docs/technical/vault-registry-decisions.md §3.5.
        assert_eq!(
            t.vault_registered,
            IVaultRegistryEvents::VaultRegistered::SIGNATURE_HASH
        );
        assert_eq!(
            t.vault_status_changed,
            IVaultRegistryEvents::VaultStatusChanged::SIGNATURE_HASH
        );
        // RouterGovernance + PortfolioRouter — docs/architecture.md §5.4.
        assert_eq!(
            t.proposal_created,
            IRouterGovernanceEvents::ProposalCreated::SIGNATURE_HASH
        );
        assert_eq!(
            t.vote_cast,
            IRouterGovernanceEvents::VoteCast::SIGNATURE_HASH
        );
        assert_eq!(
            t.proposal_executed,
            IRouterGovernanceEvents::ProposalExecuted::SIGNATURE_HASH
        );
        assert_eq!(
            t.weights_set,
            IRouterGovernanceEvents::WeightsSet::SIGNATURE_HASH
        );
    }
}
