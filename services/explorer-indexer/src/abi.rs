//! Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
//! ABI surfaces the indexer decodes — IGateway, RobotMoneyVault, and
//! VaultRegistry events plus the ERC-4626 / vault state reads.  Mirrors
//! the contract sources in `contracts/gateway/interfaces/IGateway.sol`,
//! `contracts/RobotMoneyVault.sol`, `contracts/VaultRegistry.sol`, and the canonical event signatures
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
    /// Event surface from `RouterGovernance`.
    ///
    /// Signatures match `RouterGovernance.sol` exactly so that
    /// `SolEvent::SIGNATURE_HASH` and the `Topics` keccak strings agree
    /// with the on-chain topic-0.  See `docs/architecture.md §5.4`.
    #[allow(missing_docs)]
    interface IRouterGovernanceEvents {
        /// Emitted when a new governance proposal is created.
        /// RouterGovernance.sol:106
        event ProposalCreated(
            uint256 indexed proposalId,
            address indexed proposer,
            address[] vaults,
            uint256[] bps,
            uint64  votingDeadline
        );

        /// Emitted when a voter casts a vote in favour.
        /// RouterGovernance.sol:119
        event VoteCast(
            uint256 indexed proposalId,
            address indexed voter,
            uint256 power,
            uint256 totalFor
        );

        /// Emitted when a queued proposal is executed.
        /// RouterGovernance.sol:126
        event ProposalExecuted(uint256 indexed proposalId, address indexed executor);

        /// Emitted by RouterGovernance when the router weight vector is updated.
        /// RouterGovernance.sol:132
        event WeightsApplied(uint256 indexed proposalId, address[] vaults, uint256[] bps);
    }

    /// Event surface from `IGateway`. Names match the Solidity source so
    /// `SolEvent::SIGNATURE_HASH` lines up with the on-chain topic.
    #[allow(missing_docs)]
    interface IGatewayEvents {
        /// IGateway.sol:74
        event AgentAuthorized(
            address indexed agent,
            address indexed owner,
            uint64 validUntil,
            uint256 maxPerPayment,
            uint256 maxPerWindow,
            address shareReceiver
        );
        /// IGateway.sol:85
        event AgentRevoked(address indexed agent, address indexed owner);
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
        /// IGateway.sol:119 — emitted for router-path deposits (multi-leg).
        event AgentDepositRouted(
            bytes32 indexed paymentId,
            bytes32 indexed orderId,
            address indexed agent,
            address shareReceiver,
            address router,
            uint256 amount,
            uint256[] sharesPerLeg,
            uint64  windowId
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

    /// Event surface from `VaultRegistry`.  Signatures match `VaultRegistry.sol`
    /// exactly — see §3.5 in `docs/technical/vault-registry-decisions.md`.
    #[allow(missing_docs)]
    interface IVaultRegistryEvents {
        /// Emitted once when a vault is added to the registry.
        /// VaultRegistry.sol:67
        event VaultRegistered(
            address indexed vault,
            string  name,
            address indexed asset
        );

        /// Emitted each time an admin changes a vault's operational status.
        /// VaultRegistry.sol:73 — `VaultStatus` enum encodes as uint8 in ABI.
        event VaultStatusChanged(
            address indexed vault,
            uint8   indexed newStatus,
            uint256         timestamp
        );
    }

    /// Event surface from `PortfolioRouter`.  The `RouterDeposit` event is
    /// emitted once per vault leg on every successful `deposit()` call.
    ///
    /// Signature matches `PortfolioRouter.sol:71` exactly so that
    /// `SolEvent::SIGNATURE_HASH` agrees with the on-chain topic-0.
    #[allow(missing_docs)]
    interface IPortfolioRouterEvents {
        /// Emitted once per vault leg on each `deposit()` call.
        /// PortfolioRouter.sol:71
        event RouterDeposit(
            address indexed depositor,
            address indexed vault,
            uint256 amount,
            uint256 shares,
            uint256 weightBps
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
    /// Multi-leg router deposit emitted by IGateway.sol:119.
    pub agent_deposit_routed: B256,
    pub paused: B256,
    pub unpaused: B256,
    pub vault_allocated: B256,
    pub vault_pulled: B256,
    pub vault_rebalanced: B256,
    pub vault_exit_fee_charged: B256,
    // VaultRegistry events.
    pub vault_registered: B256,
    pub vault_status_changed: B256,
    // RouterGovernance events — docs/architecture.md §5.4.
    pub proposal_created: B256,
    pub vote_cast: B256,
    pub proposal_executed: B256,
    pub weights_applied: B256,
    /// Per-leg deposit emitted by PortfolioRouter.sol:71.
    pub router_deposit: B256,
}

impl Topics {
    pub fn new() -> Self {
        Self {
            agent_authorized: keccak256(
                b"AgentAuthorized(address,address,uint64,uint256,uint256,address)",
            ),
            agent_revoked: keccak256(b"AgentRevoked(address,address)"),
            agent_deposit: keccak256(
                b"AgentDeposit(bytes32,bytes32,address,address,uint256,uint256,uint64)",
            ),
            agent_deposit_routed: keccak256(
                b"AgentDepositRouted(bytes32,bytes32,address,address,address,uint256,uint256[],uint64)",
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
            vault_registered: keccak256(b"VaultRegistered(address,string,address)"),
            vault_status_changed: keccak256(b"VaultStatusChanged(address,uint8,uint256)"),
            // RouterGovernance — docs/architecture.md §5.4.
            proposal_created: keccak256(
                b"ProposalCreated(uint256,address,address[],uint256[],uint64)",
            ),
            vote_cast: keccak256(b"VoteCast(uint256,address,uint256,uint256)"),
            proposal_executed: keccak256(b"ProposalExecuted(uint256,address)"),
            weights_applied: keccak256(b"WeightsApplied(uint256,address[],uint256[])"),
            router_deposit: keccak256(
                b"RouterDeposit(address,address,uint256,uint256,uint256)",
            ),
        }
    }

    /// All topic-0s the indexer subscribes to, suitable for an
    /// `eth_getLogs` `topics: [[t0, t1, ...]]` first-slot OR-filter.
    pub fn all_topic0(&self) -> Vec<B256> {
        vec![
            self.agent_authorized,
            self.agent_revoked,
            self.agent_deposit,
            self.agent_deposit_routed,
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
            self.weights_applied,
            self.router_deposit,
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
            t.agent_deposit_routed,
            IGatewayEvents::AgentDepositRouted::SIGNATURE_HASH
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
        // VaultRegistry events.
        assert_eq!(
            t.vault_registered,
            IVaultRegistryEvents::VaultRegistered::SIGNATURE_HASH
        );
        assert_eq!(
            t.vault_status_changed,
            IVaultRegistryEvents::VaultStatusChanged::SIGNATURE_HASH
        );
        // RouterGovernance — docs/architecture.md §5.4.
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
            t.weights_applied,
            IRouterGovernanceEvents::WeightsApplied::SIGNATURE_HASH
        );
        // PortfolioRouter events.
        assert_eq!(
            t.router_deposit,
            IPortfolioRouterEvents::RouterDeposit::SIGNATURE_HASH
        );
    }

    /// CI ABI drift gate — compares `sol!`-derived SIGNATURE_HASH constants
    /// against canonical topic-0 values computed at runtime from the
    /// authoritative event signature strings in the Solidity sources.
    ///
    /// This test is the automated ABI drift check required by issue #366.
    /// It catches any mismatch between:
    ///   1. The `sol!` event declarations in this file, and
    ///   2. The canonical canonical signatures from the contract source.
    ///
    /// If any field is added, removed, or renamed in `abi.rs` without a
    /// matching change in the `SOL_SIGS` table below (or vice-versa), the
    /// test fails — preventing silent event drops in the indexer.
    ///
    /// Source references:
    ///   IGateway.sol:74,85,100,119  VaultRegistry.sol:67,73
    ///   RouterGovernance.sol:106,119,126,132  PortfolioRouter.sol:71
    #[test]
    fn abi_drift_gate() {
        use alloy_primitives::keccak256;

        // One entry per indexed event: (event_name, canonical_signature, sol_macro_hash).
        let checks: &[(&str, &[u8], B256)] = &[
            // IGateway.sol:74
            (
                "AgentAuthorized",
                b"AgentAuthorized(address,address,uint64,uint256,uint256,address)",
                IGatewayEvents::AgentAuthorized::SIGNATURE_HASH,
            ),
            // IGateway.sol:85
            (
                "AgentRevoked",
                b"AgentRevoked(address,address)",
                IGatewayEvents::AgentRevoked::SIGNATURE_HASH,
            ),
            // IGateway.sol:100
            (
                "AgentDeposit",
                b"AgentDeposit(bytes32,bytes32,address,address,uint256,uint256,uint64)",
                IGatewayEvents::AgentDeposit::SIGNATURE_HASH,
            ),
            // IGateway.sol:119
            (
                "AgentDepositRouted",
                b"AgentDepositRouted(bytes32,bytes32,address,address,address,uint256,uint256[],uint64)",
                IGatewayEvents::AgentDepositRouted::SIGNATURE_HASH,
            ),
            // VaultRegistry.sol:67
            (
                "VaultRegistered",
                b"VaultRegistered(address,string,address)",
                IVaultRegistryEvents::VaultRegistered::SIGNATURE_HASH,
            ),
            // VaultRegistry.sol:73 — VaultStatus enum ABI-encodes as uint8
            (
                "VaultStatusChanged",
                b"VaultStatusChanged(address,uint8,uint256)",
                IVaultRegistryEvents::VaultStatusChanged::SIGNATURE_HASH,
            ),
            // RouterGovernance.sol:106
            (
                "ProposalCreated",
                b"ProposalCreated(uint256,address,address[],uint256[],uint64)",
                IRouterGovernanceEvents::ProposalCreated::SIGNATURE_HASH,
            ),
            // RouterGovernance.sol:119
            (
                "VoteCast",
                b"VoteCast(uint256,address,uint256,uint256)",
                IRouterGovernanceEvents::VoteCast::SIGNATURE_HASH,
            ),
            // RouterGovernance.sol:126
            (
                "ProposalExecuted",
                b"ProposalExecuted(uint256,address)",
                IRouterGovernanceEvents::ProposalExecuted::SIGNATURE_HASH,
            ),
            // RouterGovernance.sol:132
            (
                "WeightsApplied",
                b"WeightsApplied(uint256,address[],uint256[])",
                IRouterGovernanceEvents::WeightsApplied::SIGNATURE_HASH,
            ),
            // PortfolioRouter.sol:71
            (
                "RouterDeposit",
                b"RouterDeposit(address,address,uint256,uint256,uint256)",
                IPortfolioRouterEvents::RouterDeposit::SIGNATURE_HASH,
            ),
        ];

        for (name, sig, sol_hash) in checks {
            let canonical = keccak256(sig);
            assert_eq!(
                canonical, *sol_hash,
                "ABI drift detected for {name}: \
                 sol! declaration topic-0 ({sol_hash:?}) \
                 does not match canonical signature topic-0 ({canonical:?}). \
                 Update the sol! declaration in abi.rs to match the contract source."
            );
        }
    }
}
