//! Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
//! ABI surfaces the indexer decodes — IGateway, RobotMoneyVault, and
//! VaultRegistry events plus the ERC-4626 / vault state reads.  Mirrors
//! the contract sources in `contracts/gateway/interfaces/IGateway.sol`,
//! `contracts/RobotMoneyVault.sol`, `contracts/VaultRegistry.sol`, and the canonical event signatures
//! in `docs/technical/vault-registry-decisions.md` §3.5.
//!
//! # ABI Drift Map (dev-scout #383 findings — 2026-05-15) — HISTORICAL RECORD
//!
//! The following divergences were identified between the `sol!` declarations
//! in this file and the compiled Solidity sources.  Each item maps to the
//! downstream fix issue that will correct it.  No runtime behavior is changed
//! by this scout pass — only documentation is added.
//!
//! **Read this section as a dated record, not as current state (issue #1346).**
//! Every `Foo.sol:NN` reference *inside this section* is the line number as it
//! stood on 2026-05-15; the sources have moved since and these numbers are
//! deliberately left frozen so the record still reads as the snapshot it was.
//! The `AgentAuthorized` / `AgentRevoked` / `VaultRegistered` /
//! `VaultStatusChanged` drifts below were all corrected by issue #366 (closed)
//! and no longer exist. The `RouterGovernance` voting events the record also
//! covered were deleted from the contract with its voting (issue #1698), so the
//! indexer no longer decodes any `RouterGovernance` event. The **live,
//! maintained** citations are the ones on the `sol!` declarations, the `Topics` fields, and the `abi_drift_gate` table
//! further down this file — those were re-derived from the current sources in
//! issue #1346 and are the ones to trust.
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
//! ### `AgentWithdrawal` — added by issue #654
//! - **IGateway.sol:139** declares `AgentWithdrawal(bytes32 indexed paymentId,
//!   bytes32 indexed orderId, address indexed agent, address sourceVault,
//!   uint256 shares, uint256 assetsOut, address assetRecipient, uint64 windowId)`.
//!   Indexed in issue #654 — stores a withdrawal history row for the agent.
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
//! # Deposit pause only; withdrawals are never frozen (issue #368, core 1494)
//!
//! Issue #368 found that an emergency drain left USDC idle in the vault while a
//! single shared pause flag also blocked every redemption. Core 1494 (owner
//! decision 2026-10-05: "We do not ever freeze withdrawals") settled it:
//!
//! - A pause stops new deposits only. The vaults expose `pauseDeposits()`
//!   (EMERGENCY_ROLE), `unpauseDeposits()` (ADMIN_ROLE) and the `depositsPaused()`
//!   view. The gateway exposes the same three, gated by `DEPOSIT_PAUSER_ROLE`.
//! - There is no withdrawal pause flag and no setter for one. `_withdraw`,
//!   `maxRedeem` and `maxWithdraw` never consult the deposit pause.
//! - Emergency levers (`emergencyWithdraw`, `emergencyUnwind`, `shutdownVault`)
//!   set `depositsPaused` and move funds to idle. They never block an exit.
//! - Events: gateway and vaults emit `DepositsPaused(address indexed)` /
//!   `DepositsUnpaused(address indexed)`. Both share one topic-0 per event, so
//!   the indexer's `deposits_paused` / `deposits_unpaused` topics cover both
//!   emitters. They only drive state snapshots (no dedicated table row).
//! - The deployed v1 vault keeps its old code and its old OZ pause events.
//!   It also exposes `depositsPaused()`, which is what the snapshot reads.
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
use alloy_primitives::{keccak256, B256};
use alloy_sol_types::sol;

// Every event interface below carries `#[sol(abi)]`, which generates
// `<Interface>::abi::events()` — the runtime `alloy_json_abi::Event` view of
// these declarations, carrying each parameter's `indexed` flag. Topic-0 does
// not encode indexedness, so without this view no gate can see an `indexed`
// swap between two same-type parameters: the log still decodes cleanly and the
// values land transposed (issue #1368). `event_topics_match_foundry_artifacts`
// compares that view against the compiled Foundry artifacts.
sol! {
    /// Event surface from `IGateway`. Names match the Solidity source so
    /// `SolEvent::SIGNATURE_HASH` lines up with the on-chain topic.
    #[sol(abi)]
    #[allow(missing_docs)]
    interface IGatewayEvents {
        /// IGateway.sol:102
        event AgentAuthorized(
            address indexed agent,
            address indexed owner,
            uint64 validUntil,
            uint256 maxPerPayment,
            uint256 maxPerWindow,
            address shareReceiver
        );
        /// IGateway.sol:116 — issue #1476. Only the recorded owner changes;
        /// the agent keeps `AGENT_ROLE` and its stored policy.
        event AgentOwnershipTransferred(
            address indexed agent,
            address indexed previousOwner,
            address indexed newOwner
        );
        /// IGateway.sol:122
        event AgentRevoked(address indexed agent, address indexed owner);
        /// IGateway — `pauseDeposits()` succeeded. Stops new deposits only;
        /// withdrawals stay open. The vaults emit the same signature
        /// (`DepositsPaused(address indexed account)`), so one topic-0 covers both.
        event DepositsPaused(address indexed by);
        /// IGateway — `unpauseDeposits()` succeeded (vaults emit the same topic-0).
        event DepositsUnpaused(address indexed by);
        event AgentDeposit(
            bytes32 indexed paymentId,
            bytes32 indexed orderId,
            address indexed agent,
            address shareReceiver,
            uint256 amount,
            uint256 sharesMinted,
            uint64 windowId
        );
        /// IGateway.sol:176 — emitted on every successful agent withdrawal.
        event AgentWithdrawal(
            bytes32 indexed paymentId,
            bytes32 indexed orderId,
            address indexed agent,
            address sourceVault,
            uint256 shares,
            uint256 assetsOut,
            address assetRecipient,
            uint64  windowId
        );
        /// IGateway.sol:156 — emitted for router-path deposits (multi-leg).
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
    #[sol(abi)]
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
        /// ERC-4626 standard deposit event. Emitted by the vault on every deposit
        /// regardless of call path (direct, gateway, or router). Watched so that
        /// router-seeded deposits trigger an event-driven TVL snapshot without
        /// waiting for the SNAPSHOT_HEARTBEAT_BLOCKS interval.
        event Deposit(
            address indexed caller,
            address indexed owner,
            uint256 assets,
            uint256 shares
        );
        /// ERC-4626 standard withdraw event. Watched to snapshot TVL after any redemption.
        event Withdraw(
            address indexed caller,
            address indexed receiver,
            address indexed owner,
            uint256 assets,
            uint256 shares
        );
        // Snapshot triggers with no table row (issue 1781, QA plan X6). Each changes a
        // `vault_snapshots` column without an ERC-4626 event, and a tick reads only the vaults
        // that emitted a watched log (or are new, zero-TVL, unknown-cap or heartbeat-due).
        /// RobotMoneyVault and BasketVault.
        event TvlCapUpdated(uint256 oldCap, uint256 newCap);
        /// RobotMoneyVault and BasketVault.
        event PerDepositCapUpdated(uint256 oldCap, uint256 newCap);
        /// RobotMoneyVault and BasketVault.
        event ExitFeeUpdated(uint256 oldBps, uint256 newBps);
        /// `shutdownVault()` zeroes `tvlCap` and emits only this, in both vault families.
        event Shutdown();
        /// BasketVault `restoreVault`: sets a fresh `tvlCap` and emits only this.
        event Restored(uint256 newTvlCap);
        /// BasketVault `redeemInKind`: burns shares and pays out without an ERC-4626 `Withdraw`.
        event RedeemedInKind(address indexed owner, address indexed receiver, uint256 shares);
        /// RobotMoneyVault: an adapter written off, `totalAssets` drops by `lossAmount`.
        event AdapterForceRemoved(uint256 indexed index, address indexed adapter, uint256 lossAmount);
    }

    /// Read surface for vault state snapshots.
    #[allow(missing_docs)]
    interface IVaultReads {
        function totalAssets() external view returns (uint256);
        function totalSupply() external view returns (uint256);
        function exitFeeBps() external view returns (uint256);
        function tvlCap() external view returns (uint256);
        function perDepositCap() external view returns (uint256);
        /// Deposit pause flag. Present on every vault, the v1 vault included. A
        /// `true` value stops deposits only; redemptions stay open.
        function depositsPaused() external view returns (bool);
        /// ERC-4626 `previewRedeem`: the USDC a redeem of `shares` pays, after the
        /// exit fee and (BasketVault) the `maxSlippageBps` floor. Read with
        /// `totalSupply()` as the argument for the position value (core 1795, QA plan X8).
        function previewRedeem(uint256 shares) external view returns (uint256);
    }

    /// Event surface from `VaultRegistry`.  Signatures match `VaultRegistry.sol`
    /// exactly — see §3.5 in `docs/technical/vault-registry-decisions.md`.
    #[sol(abi)]
    #[allow(missing_docs)]
    interface IVaultRegistryEvents {
        /// Emitted once when a vault is added to the registry.
        /// VaultRegistry.sol:146
        event VaultRegistered(
            address indexed vault,
            string  name,
            address indexed asset
        );

        /// Emitted each time an admin changes a vault's operational status.
        /// VaultRegistry.sol:152 — `VaultStatus` enum encodes as uint8 in ABI.
        event VaultStatusChanged(
            address indexed vault,
            uint8   indexed newStatus,
            uint256         timestamp
        );
    }

    /// Event surface from `PortfolioRouter`.  The `RouterDeposit` event is
    /// emitted once per vault leg on every successful `deposit()` call.
    /// `WeightsSet` and `DefaultWeightsSet` are emitted by `setWeights()` and
    /// `setDefaultWeights()` respectively; `RouterGovernance.applyReceipt` sets
    /// a receipt's vector through `setWeights()`.
    ///
    /// Signatures match `PortfolioRouter.sol` exactly so that
    /// `SolEvent::SIGNATURE_HASH` agrees with the on-chain topic-0.
    #[sol(abi)]
    #[allow(missing_docs)]
    interface IPortfolioRouterEvents {
        /// Emitted once per vault leg on each `deposit()` call.
        /// PortfolioRouter.sol:122
        event RouterDeposit(
            address indexed depositor,
            address indexed vault,
            uint256 amount,
            uint256 shares,
            uint256 weightBps
        );

        /// Emitted when the active weight vector is set.
        /// PortfolioRouter.sol:133
        event WeightsSet(address[] vaults, uint256[] bps);

        /// Emitted when the default (fallback) weight vector is
        /// set by ADMIN_ROLE.
        /// PortfolioRouter.sol:139
        event DefaultWeightsSet(address[] vaults, uint256[] bps);
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

    /// Event surface from `InvestmentCommitteePolicy`.
    ///
    /// Signatures match `contracts/gateway/InvestmentCommitteePolicy.sol` and
    /// `contracts/gateway/interfaces/IInvestmentCommitteePolicy.sol` exactly.
    /// See `docs/architecture.md §5.4` and issue #1053.
    ///
    /// Three events are indexed:
    ///   AgentRegistered  — upserts committee_agents row.
    ///   AgentRevoked     — sets committee_agents.active = false.
    ///   VoteSubmitted    — stores commitment; memo hash-verification sets verified.
    #[sol(abi)]
    #[allow(missing_docs)]
    interface IInvestmentCommitteePolicyEvents {
        /// Emitted when ADMIN_ROLE registers a committee agent.
        /// InvestmentCommitteePolicy.sol:104
        event AgentRegistered(address indexed agent, string agentId);

        /// Emitted when ADMIN_ROLE revokes a committee agent.
        /// InvestmentCommitteePolicy.sol:107
        event AgentRevoked(address indexed agent);

        /// Emitted when an allowlisted agent submits a signed vote.
        /// InvestmentCommitteePolicy.sol:110
        /// Stance ABI-encodes as uint8: Overweight=0, Neutral=1, Underweight=2.
        event VoteSubmitted(
            uint256 indexed voteId,
            address indexed agent,
            address indexed vault,
            uint8   stance,
            uint16  targetWeightBps,
            uint8   confidence,
            string  rationaleUri,
            bytes32 voteJsonHash,
            uint64  timestamp
        );
    }

    /// Event surface from `ConsensusRecommendationReceipt`.
    ///
    /// Signatures match `contracts/gateway/ConsensusRecommendationReceipt.sol` and
    /// `contracts/gateway/interfaces/IConsensusRecommendationReceipt.sol` exactly.
    /// See `docs/architecture.md §4.9` and issue #1247.
    ///
    /// Two events are indexed:
    ///   ReceiptRecorded — inserts a consensus_receipts row; the indexer fetches
    ///                     `payloadUri` and sets `verified` from the keccak256
    ///                     comparison against `payloadDigest`.
    ///   ReceiptReleased — flips `released` / `released_at` on the existing row.
    ///
    /// **No event carries a signature parameter** (architecture §4.9): the
    /// analysts' ed25519 signatures are payload data verified off-chain, never
    /// event data.
    #[sol(abi)]
    #[allow(missing_docs)]
    interface IConsensusRecommendationReceiptEvents {
        /// Emitted when a committee submitter records a receipt commitment.
        /// IConsensusRecommendationReceipt.sol:51 — three indexed params (EVM limit).
        event ReceiptRecorded(
            bytes32 indexed receiptId,
            address indexed submitter,
            uint256 indexed index,
            bytes32 payloadDigest,
            string  payloadUri,
            uint64  recordedAt
        );

        /// Emitted when ADMIN_ROLE (the timelock) releases a recorded receipt.
        /// IConsensusRecommendationReceipt.sol:63
        event ReceiptReleased(bytes32 indexed receiptId, address indexed releasedBy, uint64 releasedAt);
    }

    /// Upgrade and freeze events every proxied core contract emits from its own
    /// address (contracts/lib/GovernedUUPS.sol, issue 1808): the gateway, the
    /// vaults, the registry, the router, RouterGovernance, the IC policy and the
    /// receipt register. Indexed into `admin_events` with `contract_kind =
    /// 'proxy'` (issue 1810).
    #[sol(abi)]
    #[allow(missing_docs)]
    interface IGovernedUpgradeEvents {
        /// ERC-1967 `Upgraded`, emitted by the proxy constructor and by every
        /// governed upgrade.
        event Upgraded(address indexed implementation);
        /// Upgrades on this proxy are permanently disabled. GovernedUUPS.sol.
        event UpgradesFrozen(address indexed proxy, address indexed implementation, bytes32 codeHash);
        /// OpenZeppelin `Initializable` (v5), emitted by each `initializer` and
        /// `reinitializer(n)` run. An upgrade installed without a call leaves its
        /// reinitializer to a later timelock operation, which emits only this event,
        /// so it is read to re-check a vault's `exclusionLedger()` (security round 3).
        /// Never stored.
        event Initialized(uint64 version);
    }

    /// Event surface of OpenZeppelin `TimelockController`, the contract the Safe schedules every
    /// governed change through. Signatures are OpenZeppelin's, so there is no Robot Money source file to
    /// check them against.
    #[sol(abi)]
    #[allow(missing_docs)]
    interface ITimelockEvents {
        event CallScheduled(
            bytes32 indexed id,
            uint256 indexed index,
            address target,
            uint256 value,
            bytes data,
            bytes32 predecessor,
            uint256 delay
        );
        event CallExecuted(
            bytes32 indexed id,
            uint256 indexed index,
            address target,
            uint256 value,
            bytes data
        );
        event Cancelled(bytes32 indexed id);
        event MinDelayChange(uint256 oldDuration, uint256 newDuration);
    }

    /// Event surface of `ExclusionLedger`, the exclusion record of a
    /// `RobotMoneyVault` (core issue 1820, QA plan D3 / X7). The vault's
    /// initializer creates it (`contracts/RobotMoneyVault.sol`).
    ///
    /// Signatures match `contracts/ExclusionLedger.sol` exactly. The two enum
    /// parameters (`RecoverySource`, `FinalizeReason`) ABI-encode as `uint8`.
    /// The ledger's address is not configured: the indexer reads it from the
    /// vault's `exclusionLedger()` ([`IRobotMoneyVaultReads`]) and stores it in
    /// `vault_exclusion_ledgers` (`crate::indexer::exclusion_ledgers_of`).
    #[sol(abi)]
    #[allow(missing_docs)]
    interface IExclusionLedgerEvents {
        /// A record opened: `adapter` left NAV, and its future recovery belongs
        /// to the holders of `snapshotSupply` shares at this point.
        event ExclusionOpened(
            uint256 indexed exclusionId,
            uint256 indexed adapterIndex,
            address indexed adapter,
            uint256 snapshotSupply,
            uint256 adapterValue
        );
        /// Recovered USDC was credited to a record. `recoveredUsdc` is the
        /// record's total after this credit.
        event ExclusionRecoveryCredited(
            uint256 indexed exclusionId,
            uint8 indexed source,
            uint256 amount,
            uint256 recoveredUsdc
        );
        /// A record stopped accepting recovery. It stays claimable.
        event ExclusionFinalized(
            uint256 indexed exclusionId,
            uint8 indexed reason,
            uint256 recoveredUsdc
        );
        /// A snapshot holder was paid from a record.
        event ExclusionClaimed(uint256 indexed exclusionId, address indexed holder, uint256 amount);
    }

    /// The `RobotMoneyVault` getter that names its `ExclusionLedger`. The vault's
    /// initializer creates the ledger, so no address derived from the vault is the
    /// ledger, and the indexer reads it once per vault, and again at the block of each
    /// `Upgraded` or `Initialized` of the vault (security rounds 2 and 3). A `BasketVault`
    /// has no such getter: the call reverts, and that vault has no ledger.
    #[allow(missing_docs)]
    interface IRobotMoneyVaultReads {
        function exclusionLedger() external view returns (address);
    }

    /// The one `ExclusionLedger` read the indexer makes: a holder's vault
    /// shares at a record's snapshot. The value is fixed once the record
    /// exists, so any block at or after the record answers the same.
    #[allow(missing_docs)]
    interface IExclusionLedgerReads {
        function balanceAt(address holder, uint256 id) external view returns (uint256);
    }
}

/// Topic-0 hashes the indexer matches on `eth_getLogs`. Computed once
/// at startup from the canonical event signature strings.
pub struct Topics {
    pub agent_authorized: B256,
    /// Owner-initiated agent ownership transfer — IGateway.sol:116, issue #1476.
    pub agent_ownership_transferred: B256,
    pub agent_revoked: B256,
    pub agent_deposit: B256,
    /// Agent-initiated withdrawal emitted by IGateway.sol:176.
    pub agent_withdrawal: B256,
    /// Multi-leg router deposit emitted by IGateway.sol:156.
    pub agent_deposit_routed: B256,
    /// `DepositsPaused(address)` — emitted by the gateway and by every vault.
    pub deposits_paused: B256,
    /// `DepositsUnpaused(address)` — emitted by the gateway and by every vault.
    pub deposits_unpaused: B256,
    pub vault_allocated: B256,
    pub vault_pulled: B256,
    pub vault_rebalanced: B256,
    pub vault_exit_fee_charged: B256,
    // VaultRegistry events.
    pub vault_registered: B256,
    pub vault_status_changed: B256,
    /// Per-leg deposit emitted by PortfolioRouter.sol:122.
    pub router_deposit: B256,
    /// Active weight vector set by the weight setter — PortfolioRouter.sol:133.
    /// Emitted by `setWeights()`, which `RouterGovernance.applyReceipt` calls.
    pub weights_set: B256,
    /// Default (fallback) weight vector set by ADMIN_ROLE — PortfolioRouter.sol:139.
    /// Emitted by `setDefaultWeights()`.
    pub default_weights_set: B256,
    /// ERC-4626 Deposit event emitted by any vault on every deposit.
    /// Watching this ensures TVL snapshots fire after router-seeded deposits.
    pub erc4626_deposit: B256,
    /// ERC-4626 Withdraw event emitted by any vault on every redemption.
    pub erc4626_withdraw: B256,
    // Vault state changes that only trigger a snapshot read (issue 1781, QA plan X6).
    pub vault_tvl_cap_updated: B256,
    pub vault_per_deposit_cap_updated: B256,
    pub vault_exit_fee_updated: B256,
    pub vault_shutdown: B256,
    /// BasketVault only.
    pub vault_restored: B256,
    /// BasketVault only.
    pub vault_redeemed_in_kind: B256,
    /// RobotMoneyVault only.
    pub vault_adapter_force_removed: B256,
    // InvestmentCommitteePolicy events — docs/architecture.md §5.4, issue #1053.
    /// Emitted when ADMIN_ROLE registers a committee agent.
    /// InvestmentCommitteePolicy.sol:104
    pub ic_agent_registered: B256,
    /// Emitted when ADMIN_ROLE revokes a committee agent.
    /// InvestmentCommitteePolicy.sol:107
    pub ic_agent_revoked: B256,
    /// Emitted when an allowlisted agent submits a signed vote.
    /// InvestmentCommitteePolicy.sol:110
    pub ic_vote_submitted: B256,
    // ConsensusRecommendationReceipt events — docs/architecture.md §4.9, issue #1247.
    /// Emitted when a committee submitter records a receipt commitment.
    pub consensus_receipt_recorded: B256,
    /// Emitted when ADMIN_ROLE (the timelock) releases a recorded receipt.
    pub consensus_receipt_released: B256,
    // TimelockController events (OpenZeppelin) — the governed-change path, issue #1731.
    pub timelock_call_scheduled: B256,
    pub timelock_call_executed: B256,
    pub timelock_cancelled: B256,
    pub timelock_min_delay_change: B256,
    // Safe events. `ExecutionSuccess(bytes32,uint256)` has the same topic-0 on Safe 1.3 and 1.4 even
    // though 1.4 indexes the first argument, so the indexer reads the hash from topic 1 or from the data.
    pub safe_execution_success: B256,
    pub safe_execution_failure: B256,
    pub safe_added_owner: B256,
    pub safe_removed_owner: B256,
    pub safe_changed_threshold: B256,
    // ExclusionLedger events — core issue 1820, QA plan X7. Emitted by the ledger each
    // `RobotMoneyVault` creates, never by the vault itself.
    pub exclusion_opened: B256,
    pub exclusion_recovery_credited: B256,
    pub exclusion_finalized: B256,
    pub exclusion_claimed: B256,
    // GovernedUUPS proxy events (issue 1810), emitted by every proxied core contract.
    /// ERC-1967 `Upgraded(address)`.
    pub proxy_upgraded: B256,
    /// `UpgradesFrozen(address,address,bytes32)`.
    pub proxy_upgrades_frozen: B256,
    /// OpenZeppelin `Initialized(uint64)`: an initializer or reinitializer ran. Only read to
    /// trigger a vault's `exclusionLedger()` re-read (security round 3); never stored.
    pub proxy_initialized: B256,
}

impl Topics {
    pub fn new() -> Self {
        Self {
            agent_authorized: keccak256(
                b"AgentAuthorized(address,address,uint64,uint256,uint256,address)",
            ),
            agent_ownership_transferred: keccak256(
                b"AgentOwnershipTransferred(address,address,address)",
            ),
            agent_revoked: keccak256(b"AgentRevoked(address,address)"),
            agent_deposit: keccak256(
                b"AgentDeposit(bytes32,bytes32,address,address,uint256,uint256,uint64)",
            ),
            agent_withdrawal: keccak256(
                b"AgentWithdrawal(bytes32,bytes32,address,address,uint256,uint256,address,uint64)",
            ),
            agent_deposit_routed: keccak256(
                b"AgentDepositRouted(bytes32,bytes32,address,address,address,uint256,uint256[],uint64)",
            ),
            deposits_paused: keccak256(b"DepositsPaused(address)"),
            deposits_unpaused: keccak256(b"DepositsUnpaused(address)"),
            vault_allocated: keccak256(b"Allocated(uint256,address,uint256)"),
            vault_pulled: keccak256(b"Pulled(uint256,address,uint256)"),
            vault_rebalanced: keccak256(b"Rebalanced(uint256)"),
            vault_exit_fee_charged: keccak256(
                b"ExitFeeCharged(address,address,uint256,uint256,uint256)",
            ),
            // VaultRegistry — docs/technical/vault-registry-decisions.md §3.5.
            vault_registered: keccak256(b"VaultRegistered(address,string,address)"),
            vault_status_changed: keccak256(b"VaultStatusChanged(address,uint8,uint256)"),
            router_deposit: keccak256(
                b"RouterDeposit(address,address,uint256,uint256,uint256)",
            ),
            weights_set: keccak256(b"WeightsSet(address[],uint256[])"),
            default_weights_set: keccak256(b"DefaultWeightsSet(address[],uint256[])"),
            erc4626_deposit: keccak256(b"Deposit(address,address,uint256,uint256)"),
            erc4626_withdraw: keccak256(b"Withdraw(address,address,address,uint256,uint256)"),
            // Snapshot-trigger vault events — issue 1781.
            vault_tvl_cap_updated: keccak256(b"TvlCapUpdated(uint256,uint256)"),
            vault_per_deposit_cap_updated: keccak256(b"PerDepositCapUpdated(uint256,uint256)"),
            vault_exit_fee_updated: keccak256(b"ExitFeeUpdated(uint256,uint256)"),
            vault_shutdown: keccak256(b"Shutdown()"),
            vault_restored: keccak256(b"Restored(uint256)"),
            vault_redeemed_in_kind: keccak256(b"RedeemedInKind(address,address,uint256)"),
            vault_adapter_force_removed: keccak256(b"AdapterForceRemoved(uint256,address,uint256)"),
            // InvestmentCommitteePolicy — issue #1053.
            ic_agent_registered: keccak256(b"AgentRegistered(address,string)"),
            ic_agent_revoked: keccak256(b"AgentRevoked(address)"),
            ic_vote_submitted: keccak256(
                b"VoteSubmitted(uint256,address,address,uint8,uint16,uint8,string,bytes32,uint64)",
            ),
            // ConsensusRecommendationReceipt — issue #1247.
            consensus_receipt_recorded: keccak256(
                b"ReceiptRecorded(bytes32,address,uint256,bytes32,string,uint64)",
            ),
            consensus_receipt_released: keccak256(b"ReceiptReleased(bytes32,address,uint64)"),
            timelock_call_scheduled: keccak256(
                b"CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)",
            ),
            timelock_call_executed: keccak256(b"CallExecuted(bytes32,uint256,address,uint256,bytes)"),
            timelock_cancelled: keccak256(b"Cancelled(bytes32)"),
            timelock_min_delay_change: keccak256(b"MinDelayChange(uint256,uint256)"),
            safe_execution_success: keccak256(b"ExecutionSuccess(bytes32,uint256)"),
            safe_execution_failure: keccak256(b"ExecutionFailure(bytes32,uint256)"),
            safe_added_owner: keccak256(b"AddedOwner(address)"),
            safe_removed_owner: keccak256(b"RemovedOwner(address)"),
            safe_changed_threshold: keccak256(b"ChangedThreshold(uint256)"),
            // ExclusionLedger — core issue 1820. Enum parameters encode as uint8.
            exclusion_opened: keccak256(
                b"ExclusionOpened(uint256,uint256,address,uint256,uint256)",
            ),
            exclusion_recovery_credited: keccak256(
                b"ExclusionRecoveryCredited(uint256,uint8,uint256,uint256)",
            ),
            exclusion_finalized: keccak256(b"ExclusionFinalized(uint256,uint8,uint256)"),
            exclusion_claimed: keccak256(b"ExclusionClaimed(uint256,address,uint256)"),
            proxy_upgraded: keccak256(b"Upgraded(address)"),
            proxy_upgrades_frozen: keccak256(b"UpgradesFrozen(address,address,bytes32)"),
            proxy_initialized: keccak256(b"Initialized(uint64)"),
        }
    }

    /// All topic-0s the indexer subscribes to, suitable for an
    /// `eth_getLogs` `topics: [[t0, t1, ...]]` first-slot OR-filter.
    pub fn all_topic0(&self) -> Vec<B256> {
        vec![
            self.agent_authorized,
            self.agent_ownership_transferred,
            self.agent_revoked,
            self.agent_deposit,
            self.agent_withdrawal,
            self.agent_deposit_routed,
            self.deposits_paused,
            self.deposits_unpaused,
            self.vault_allocated,
            self.vault_pulled,
            self.vault_rebalanced,
            self.vault_exit_fee_charged,
            self.vault_registered,
            self.vault_status_changed,
            self.router_deposit,
            self.weights_set,
            self.default_weights_set,
            self.erc4626_deposit,
            self.erc4626_withdraw,
            // Vault snapshot triggers — issue 1781. Without them a quiet vault's cap, fee or
            // in-kind exit would wait for the heartbeat, since a tick no longer reads every vault.
            self.vault_tvl_cap_updated,
            self.vault_per_deposit_cap_updated,
            self.vault_exit_fee_updated,
            self.vault_shutdown,
            self.vault_restored,
            self.vault_redeemed_in_kind,
            self.vault_adapter_force_removed,
            // InvestmentCommitteePolicy — issue #1053.
            self.ic_agent_registered,
            self.ic_agent_revoked,
            self.ic_vote_submitted,
            // ConsensusRecommendationReceipt — issue #1247. A topic omitted from this
            // list is silently never fetched by `eth_getLogs`.
            self.consensus_receipt_recorded,
            self.consensus_receipt_released,
            self.timelock_call_scheduled,
            self.timelock_call_executed,
            self.timelock_cancelled,
            self.timelock_min_delay_change,
            self.safe_execution_success,
            self.safe_execution_failure,
            self.safe_added_owner,
            self.safe_removed_owner,
            self.safe_changed_threshold,
            // ExclusionLedger — core issue 1820, QA plan X7.
            self.exclusion_opened,
            self.exclusion_recovery_credited,
            self.exclusion_finalized,
            self.exclusion_claimed,
            self.proxy_upgraded,
            self.proxy_upgrades_frozen,
            // A (re)initializer run — security round 3: a reinitializer that moves a vault's
            // ExclusionLedger can run in a later timelock operation than its upgrade.
            self.proxy_initialized,
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
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    /// Foundry's build-output directory (`out = "out"` in `foundry.toml`),
    /// resolved from this crate's manifest directory so the test is
    /// independent of the working directory `cargo test` was launched from.
    fn foundry_out_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("out")
    }

    /// Canonical ABI type of one parameter, expanding tuples recursively so a
    /// struct parameter renders as `(address,uint256)` — the form that goes
    /// into the topic-0 preimage.
    fn param_type(param: &serde_json::Value) -> String {
        let ty = param["type"].as_str().unwrap_or_default();
        match ty.strip_prefix("tuple") {
            Some(array_suffix) => {
                let components = param["components"]
                    .as_array()
                    .map(|c| c.iter().map(param_type).collect::<Vec<_>>().join(","))
                    .unwrap_or_default();
                format!("({components}){array_suffix}")
            }
            None => ty.to_string(),
        }
    }

    /// One event exactly as the compiled Foundry artifact declares it.
    #[derive(Debug)]
    struct ArtifactEvent {
        topic0: B256,
        /// `(parameter name, indexed)` in declaration order. The `indexed`
        /// half is invisible to `topic0` — see `indexed_flags_mismatch`.
        params: Vec<(String, bool)>,
    }

    /// Read a Foundry artifact and return every event it declares as
    /// `name -> [event, ...]` (a `Vec` because Solidity permits overloads).
    ///
    /// Panics — loudly, never skips — when the artifact is missing. A missing
    /// `out/` means `forge build` did not run, and a drift gate that quietly
    /// passes when it cannot read the thing it guards is the exact defect
    /// issue #1346 exists to fix.
    fn artifact_events(contract_dir: &str, contract: &str) -> BTreeMap<String, Vec<ArtifactEvent>> {
        let out = foundry_out_dir();
        let path = out.join(contract_dir).join(format!("{contract}.json"));
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "cannot read Foundry artifact {}: {e}\n\
                 This test derives event topic-0 hashes from the compiled contracts, so the \
                 artifacts must exist. Run `forge build` from the repository root first \
                 (CI: see the `forge build` step in .github/workflows/suite-16-abi-drift.yml).",
                path.display()
            )
        });
        let artifact: serde_json::Value = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("malformed Foundry artifact {}: {e}", path.display()));
        let entries = artifact["abi"]
            .as_array()
            .unwrap_or_else(|| panic!("Foundry artifact {} has no `abi` array", path.display()));

        let mut events: BTreeMap<String, Vec<ArtifactEvent>> = BTreeMap::new();
        for entry in entries {
            if entry["type"].as_str() != Some("event") {
                continue;
            }
            let name = entry["name"].as_str().unwrap_or_default();
            let inputs = entry["inputs"].as_array().cloned().unwrap_or_default();
            let types = inputs.iter().map(param_type).collect::<Vec<_>>().join(",");
            let signature = format!("{name}({types})");
            let params = inputs
                .iter()
                .map(|p| {
                    (
                        p["name"].as_str().unwrap_or_default().to_string(),
                        // Absent `indexed` in an ABI entry means `false`; a
                        // missing key must never read as "indexed", or the gate
                        // would pass on a malformed artifact.
                        p["indexed"].as_bool().unwrap_or(false),
                    )
                })
                .collect();
            events
                .entry(name.to_string())
                .or_default()
                .push(ArtifactEvent {
                    topic0: keccak256(signature.as_bytes()),
                    params,
                });
        }
        events
    }

    /// Every event declared by the `sol!` interfaces in this file, keyed by
    /// topic-0, as `(event name, [(parameter name, indexed), ...])`.
    ///
    /// Topic-0 is the key because it is what the check table already carries
    /// and because it disambiguates the two distinct `AgentRevoked` events
    /// (`IGatewayEvents` and `IInvestmentCommitteePolicyEvents`) that share a
    /// name but not a signature.
    fn sol_events_by_topic0() -> BTreeMap<B256, (String, Vec<(String, bool)>)> {
        let mut out: BTreeMap<B256, (String, Vec<(String, bool)>)> = BTreeMap::new();
        macro_rules! collect {
            ($($iface:ident),+ $(,)?) => {$(
                for event in $iface::abi::events().into_values().flatten() {
                    let params = event
                        .inputs
                        .iter()
                        .map(|p| (p.name.clone(), p.indexed))
                        .collect::<Vec<_>>();
                    let topic0 = event.selector();
                    if let Some((prior_name, prior_params)) = out.get(&topic0) {
                        assert_eq!(
                            (prior_name, prior_params),
                            (&event.name, &params),
                            "two sol! declarations share topic-0 {topic0:?} but disagree on \
                             their parameters — one of them is wrong"
                        );
                    }
                    out.insert(topic0, (event.name.clone(), params));
                }
            )+};
        }
        collect!(
            IGatewayEvents,
            IVaultEvents,
            IVaultRegistryEvents,
            IPortfolioRouterEvents,
            IInvestmentCommitteePolicyEvents,
            IConsensusRecommendationReceiptEvents,
            IExclusionLedgerEvents,
            IGovernedUpgradeEvents,
        );
        out
    }

    /// Compare the `indexed` bitmask the compiled artifact declares against the
    /// one the `sol!` declaration in this file declares, returning a message
    /// that names the offending event **and parameter** on mismatch.
    ///
    /// Parameter *names* are deliberately not compared: the ERC-4626 `Deposit`
    /// / `Withdraw` events call their first parameter `sender` in OpenZeppelin
    /// and `caller` in the `sol!` declaration, which is harmless — only the
    /// position and the `indexed` flag decide where a decoded value lands.
    fn indexed_flags_mismatch(
        contract: &str,
        event: &str,
        artifact: &[(String, bool)],
        declared: &[(String, bool)],
    ) -> Option<String> {
        if artifact.len() != declared.len() {
            return Some(format!(
                "ABI drift for {contract}.{event}: the compiled artifact declares \
                 {} parameters, the sol! declaration {}",
                artifact.len(),
                declared.len()
            ));
        }
        for (position, ((artifact_name, artifact_indexed), (declared_name, declared_indexed))) in
            artifact.iter().zip(declared).enumerate()
        {
            if artifact_indexed != declared_indexed {
                return Some(format!(
                    "ABI drift for {contract}.{event}, parameter {position} \
                     (`{artifact_name}` in Solidity, `{declared_name}` in abi.rs): the compiled \
                     Foundry artifact declares it {}, the sol! declaration in \
                     services/explorer-indexer/src/abi.rs declares it {}.\n\
                     Topic-0 does NOT encode which parameters are `indexed`, so this event still \
                     decodes without error — the indexer just writes the values into the wrong \
                     columns. An `indexed` swap between two same-type parameters transposes them \
                     silently (issue #1368). Update the `sol!` declaration to match the Solidity \
                     source.",
                    if *artifact_indexed {
                        "`indexed`"
                    } else {
                        "not `indexed`"
                    },
                    if *declared_indexed {
                        "`indexed`"
                    } else {
                        "not `indexed`"
                    },
                ));
            }
        }
        None
    }

    /// **The Solidity-truth ABI drift gate (issue #1346).**
    ///
    /// `abi_drift_gate` below compares this file's three hand-maintained
    /// copies of every event signature (the `sol!` declarations, the
    /// `Topics::new()` keccak literals, and its own `SOL_SIGS` table) only
    /// against *each other*. It reads no Solidity, so it cannot fail when a
    /// contract changes — only when someone edits one of the three copies and
    /// forgets the other two. Every copy can be simultaneously, consistently
    /// wrong and that gate still passes green.
    ///
    /// This test closes that hole: it re-derives topic-0 from the compiled
    /// Foundry artifacts in `out/` — the same bytes the deployed contract
    /// emits — and fails if the indexer's topic differs. A Solidity signature
    /// change with no corresponding `abi.rs` change turns this RED, which is
    /// exactly the class of silent event-drop the indexer shipped in #366.
    ///
    /// **The `indexed` half (issue #1368).** Topic-0 is derived from the
    /// signature string, which does not say which parameters are `indexed`.
    /// Changing the *number* of indexed parameters still fails loudly — the
    /// topic count changes and `decode_log(&log, true)` returns
    /// `IndexerError::Decode`. But **swapping** `indexed` between two
    /// same-type parameters (`AgentRevoked(address indexed agent, address
    /// owner)` → `AgentRevoked(address agent, address indexed owner)`) leaves
    /// topic-0, the topic count and the decode all unchanged, and the indexer
    /// writes `agent` and `owner` transposed into `insert_agent_policy`. A
    /// silent write-path corruption on identity-shaped columns, invisible to
    /// every topic-0 gate. So this test also compares the per-parameter
    /// `indexed` bitmask the artifact declares against the `sol!`
    /// declaration's, taken from `<Interface>::abi::events()` rather than from
    /// a fourth hand-maintained copy.
    ///
    /// Requires `forge build` to have populated `out/`; it panics with
    /// instructions rather than skipping when the artifacts are absent.
    #[test]
    fn event_topics_match_foundry_artifacts() {
        let out = foundry_out_dir();
        assert!(
            out.is_dir(),
            "Foundry out/ directory not found at {} — run `forge build` from the repository \
             root before this test. This gate derives topic-0 from compiled artifacts and \
             must never pass without them.",
            out.display()
        );

        let t = Topics::new();

        // (artifact dir, contract, event name, the topic the indexer filters on).
        // One entry per topic-0 in `Topics` that a first-party contract emits.
        let checks: &[(&str, &str, &str, B256)] = &[
            // IGateway events, taken from the concrete implementation's artifact
            // (RobotMoneyGateway inherits the IGateway event surface).
            (
                "RobotMoneyGateway.sol",
                "RobotMoneyGateway",
                "AgentAuthorized",
                t.agent_authorized,
            ),
            // `AgentOwnershipTransferred` is no longer declared by the gateway (issue 1890
            // removed `transferAgentOwnership`). The indexer keeps the topic only to decode
            // historical logs of the deployed release, so it has no artifact entry here.
            (
                "RobotMoneyGateway.sol",
                "RobotMoneyGateway",
                "AgentRevoked",
                t.agent_revoked,
            ),
            (
                "RobotMoneyGateway.sol",
                "RobotMoneyGateway",
                "AgentDeposit",
                t.agent_deposit,
            ),
            // `AgentDepositRouted`, `AgentWithdrawal` and `AgentWithdrawalRouted` left the
            // gateway ABI (issue 1889). The indexer still decodes them as history of older
            // deployments, so they have no compiled artifact to cross-check.
            (
                "RobotMoneyGateway.sol",
                "RobotMoneyGateway",
                "DepositsPaused",
                t.deposits_paused,
            ),
            (
                "RobotMoneyGateway.sol",
                "RobotMoneyGateway",
                "DepositsUnpaused",
                t.deposits_unpaused,
            ),
            // RobotMoneyVault — vault state-snapshot triggers plus the two
            // ERC-4626 standard events the vault inherits.
            (
                "RobotMoneyVault.sol",
                "RobotMoneyVault",
                "Allocated",
                t.vault_allocated,
            ),
            // The vault's deposit-pause events share the gateway's topic-0.
            (
                "RobotMoneyVault.sol",
                "RobotMoneyVault",
                "DepositsPaused",
                t.deposits_paused,
            ),
            (
                "RobotMoneyVault.sol",
                "RobotMoneyVault",
                "DepositsUnpaused",
                t.deposits_unpaused,
            ),
            (
                "RobotMoneyVault.sol",
                "RobotMoneyVault",
                "Pulled",
                t.vault_pulled,
            ),
            (
                "RobotMoneyVault.sol",
                "RobotMoneyVault",
                "Rebalanced",
                t.vault_rebalanced,
            ),
            (
                "RobotMoneyVault.sol",
                "RobotMoneyVault",
                "ExitFeeCharged",
                t.vault_exit_fee_charged,
            ),
            (
                "RobotMoneyVault.sol",
                "RobotMoneyVault",
                "Deposit",
                t.erc4626_deposit,
            ),
            (
                "RobotMoneyVault.sol",
                "RobotMoneyVault",
                "Withdraw",
                t.erc4626_withdraw,
            ),
            // Snapshot-trigger events (issue 1781), from both vault families.
            (
                "RobotMoneyVault.sol",
                "RobotMoneyVault",
                "TvlCapUpdated",
                t.vault_tvl_cap_updated,
            ),
            (
                "RobotMoneyVault.sol",
                "RobotMoneyVault",
                "PerDepositCapUpdated",
                t.vault_per_deposit_cap_updated,
            ),
            (
                "RobotMoneyVault.sol",
                "RobotMoneyVault",
                "ExitFeeUpdated",
                t.vault_exit_fee_updated,
            ),
            (
                "RobotMoneyVault.sol",
                "RobotMoneyVault",
                "Shutdown",
                t.vault_shutdown,
            ),
            (
                "RobotMoneyVault.sol",
                "RobotMoneyVault",
                "AdapterForceRemoved",
                t.vault_adapter_force_removed,
            ),
            (
                "BasketVault.sol",
                "BasketVault",
                "TvlCapUpdated",
                t.vault_tvl_cap_updated,
            ),
            (
                "BasketVault.sol",
                "BasketVault",
                "PerDepositCapUpdated",
                t.vault_per_deposit_cap_updated,
            ),
            (
                "BasketVault.sol",
                "BasketVault",
                "ExitFeeUpdated",
                t.vault_exit_fee_updated,
            ),
            (
                "BasketVault.sol",
                "BasketVault",
                "Shutdown",
                t.vault_shutdown,
            ),
            (
                "BasketVault.sol",
                "BasketVault",
                "Restored",
                t.vault_restored,
            ),
            (
                "BasketVault.sol",
                "BasketVault",
                "RedeemedInKind",
                t.vault_redeemed_in_kind,
            ),
            // VaultRegistry.
            (
                "VaultRegistry.sol",
                "VaultRegistry",
                "VaultRegistered",
                t.vault_registered,
            ),
            (
                "VaultRegistry.sol",
                "VaultRegistry",
                "VaultStatusChanged",
                t.vault_status_changed,
            ),
            // PortfolioRouter.
            (
                "PortfolioRouter.sol",
                "PortfolioRouter",
                "RouterDeposit",
                t.router_deposit,
            ),
            (
                "PortfolioRouter.sol",
                "PortfolioRouter",
                "WeightsSet",
                t.weights_set,
            ),
            (
                "PortfolioRouter.sol",
                "PortfolioRouter",
                "DefaultWeightsSet",
                t.default_weights_set,
            ),
            // The InvestmentCommitteePolicy rows were removed with the contract (issue 1888).
            // Issue 1891 deletes the matching decoders.
            // ConsensusRecommendationReceipt — issue #1247.
            (
                "ConsensusRecommendationReceipt.sol",
                "ConsensusRecommendationReceipt",
                "ReceiptRecorded",
                t.consensus_receipt_recorded,
            ),
            (
                "ConsensusRecommendationReceipt.sol",
                "ConsensusRecommendationReceipt",
                "ReceiptReleased",
                t.consensus_receipt_released,
            ),
            // ExclusionLedger — core issue 1820, QA plan X7.
            (
                "ExclusionLedger.sol",
                "ExclusionLedger",
                "ExclusionOpened",
                t.exclusion_opened,
            ),
            (
                "ExclusionLedger.sol",
                "ExclusionLedger",
                "ExclusionRecoveryCredited",
                t.exclusion_recovery_credited,
            ),
            (
                "ExclusionLedger.sol",
                "ExclusionLedger",
                "ExclusionFinalized",
                t.exclusion_finalized,
            ),
            (
                "ExclusionLedger.sol",
                "ExclusionLedger",
                "ExclusionClaimed",
                t.exclusion_claimed,
            ),
            // GovernedUUPS proxy events — issue 1810. Declared once on the
            // shared base, so the gateway's and the vault's artifacts carry them.
            (
                "RobotMoneyGateway.sol",
                "RobotMoneyGateway",
                "Upgraded",
                t.proxy_upgraded,
            ),
            (
                "RobotMoneyGateway.sol",
                "RobotMoneyGateway",
                "UpgradesFrozen",
                t.proxy_upgrades_frozen,
            ),
            (
                "RobotMoneyVault.sol",
                "RobotMoneyVault",
                "Upgraded",
                t.proxy_upgraded,
            ),
            (
                "RobotMoneyVault.sol",
                "RobotMoneyVault",
                "UpgradesFrozen",
                t.proxy_upgrades_frozen,
            ),
            // OpenZeppelin `Initializable` — security round 3.
            (
                "RobotMoneyVault.sol",
                "RobotMoneyVault",
                "Initialized",
                t.proxy_initialized,
            ),
        ];

        // The `sol!` declarations' own view of themselves, keyed by topic-0.
        let declared = sol_events_by_topic0();

        // Cache each artifact so a contract's JSON is parsed once, not once per event.
        let mut cache: BTreeMap<&str, BTreeMap<String, Vec<ArtifactEvent>>> = BTreeMap::new();
        let mut checked = 0usize;

        for (dir, contract, event, indexer_topic) in checks {
            let artifact = cache
                .entry(contract)
                .or_insert_with(|| artifact_events(dir, contract));
            let candidates = artifact.get(*event).unwrap_or_else(|| {
                panic!(
                    "ABI drift: `{event}` is not declared by {contract} in the compiled \
                     artifact, but services/explorer-indexer/src/abi.rs still filters \
                     `eth_getLogs` on its topic-0. The event was renamed or removed in \
                     Solidity — update abi.rs. Events present: {:?}",
                    artifact.keys().collect::<Vec<_>>()
                )
            });
            let compiled = candidates
                .iter()
                .find(|c| c.topic0 == *indexer_topic)
                .unwrap_or_else(|| {
                    panic!(
                        "ABI drift for {contract}.{event}: the indexer filters on topic-0 \
                         {indexer_topic:?}, but the compiled Foundry artifact declares {:?}. \
                         The Solidity signature changed without a matching change in \
                         services/explorer-indexer/src/abi.rs, so every {event} log would be \
                         silently dropped. Update the `sol!` declaration, the `Topics::new()` \
                         keccak literal, and the `abi_drift_gate` table to the new signature.",
                        candidates.iter().map(|c| c.topic0).collect::<Vec<_>>()
                    )
                });

            // Issue #1368: same signature, same topic-0, different indexedness.
            let (_, declared_params) = declared.get(indexer_topic).unwrap_or_else(|| {
                panic!(
                    "no `sol!` declaration in abi.rs has topic-0 {indexer_topic:?} for \
                     {contract}.{event} — `Topics::new()` and the `sol!` interfaces disagree, \
                     or the event's interface is missing from `sol_events_by_topic0()`"
                )
            });
            if let Some(message) =
                indexed_flags_mismatch(contract, event, &compiled.params, declared_params)
            {
                panic!("{message}");
            }
            checked += 1;
        }

        // Guard against the table itself being emptied or shadowed by a refactor:
        // a gate that checks nothing is indistinguishable from a passing gate.
        assert_eq!(
            checked,
            checks.len(),
            "not every entry in the artifact cross-check table was evaluated"
        );
        // 26 since issue #1698 deleted the four RouterGovernance voting events;
        // 30 since issue 1810 added the two proxy events on two artifacts.
        assert!(
            checked >= 30,
            "artifact cross-check covered only {checked} events — entries were removed \
             from the table without removing the corresponding topic from `Topics`"
        );

        // SELF-TEST OF THE `indexed` COMPARISON (issue #1368).
        // The loop above only ever observes this comparison passing, and a
        // comparison nobody has seen fail is not a gate. Transpose `indexed`
        // between the two same-type parameters of the real `AgentRevoked`
        // declaration and assert the comparison rejects it, naming the
        // parameter. Both sides keep the same topic-0 and the same topic
        // count, so this is exactly the mutation topic-0 cannot see.
        let (_, agent_revoked) = declared
            .get(&t.agent_revoked)
            .expect("AgentRevoked must be among the sol! declarations");
        assert_eq!(
            agent_revoked,
            &vec![("agent".to_string(), true), ("owner".to_string(), true),],
            "AgentRevoked's declared parameters changed — update this self-test's fixture"
        );
        let transposed = vec![("agent".to_string(), false), ("owner".to_string(), true)];
        let message = indexed_flags_mismatch(
            "RobotMoneyGateway",
            "AgentRevoked",
            &transposed,
            agent_revoked,
        )
        .expect(
            "the `indexed` comparison accepted an AgentRevoked whose two same-type address \
             parameters have their `indexed` flags transposed — the gate is blind to the exact \
             defect issue #1368 exists to catch",
        );
        assert!(
            message.contains("parameter 0") && message.contains("agent"),
            "the mismatch message must name the offending parameter, got: {message}"
        );
    }

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
            t.agent_withdrawal,
            IGatewayEvents::AgentWithdrawal::SIGNATURE_HASH
        );
        assert_eq!(
            t.agent_authorized,
            IGatewayEvents::AgentAuthorized::SIGNATURE_HASH
        );
        assert_eq!(
            t.agent_ownership_transferred,
            IGatewayEvents::AgentOwnershipTransferred::SIGNATURE_HASH
        );
        assert_eq!(
            t.agent_revoked,
            IGatewayEvents::AgentRevoked::SIGNATURE_HASH
        );
        assert_eq!(
            t.deposits_paused,
            IGatewayEvents::DepositsPaused::SIGNATURE_HASH
        );
        assert_eq!(
            t.deposits_unpaused,
            IGatewayEvents::DepositsUnpaused::SIGNATURE_HASH
        );
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
        // PortfolioRouter events.
        assert_eq!(
            t.router_deposit,
            IPortfolioRouterEvents::RouterDeposit::SIGNATURE_HASH
        );
        assert_eq!(
            t.weights_set,
            IPortfolioRouterEvents::WeightsSet::SIGNATURE_HASH
        );
        assert_eq!(
            t.default_weights_set,
            IPortfolioRouterEvents::DefaultWeightsSet::SIGNATURE_HASH
        );
        // ERC-4626 standard events.
        assert_eq!(t.erc4626_deposit, IVaultEvents::Deposit::SIGNATURE_HASH);
        assert_eq!(t.erc4626_withdraw, IVaultEvents::Withdraw::SIGNATURE_HASH);
        // Snapshot-trigger vault events — issue 1781.
        assert_eq!(
            t.vault_tvl_cap_updated,
            IVaultEvents::TvlCapUpdated::SIGNATURE_HASH
        );
        assert_eq!(
            t.vault_per_deposit_cap_updated,
            IVaultEvents::PerDepositCapUpdated::SIGNATURE_HASH
        );
        assert_eq!(
            t.vault_exit_fee_updated,
            IVaultEvents::ExitFeeUpdated::SIGNATURE_HASH
        );
        assert_eq!(t.vault_shutdown, IVaultEvents::Shutdown::SIGNATURE_HASH);
        assert_eq!(t.vault_restored, IVaultEvents::Restored::SIGNATURE_HASH);
        assert_eq!(
            t.vault_redeemed_in_kind,
            IVaultEvents::RedeemedInKind::SIGNATURE_HASH
        );
        assert_eq!(
            t.vault_adapter_force_removed,
            IVaultEvents::AdapterForceRemoved::SIGNATURE_HASH
        );
        // InvestmentCommitteePolicy — issue #1053.
        assert_eq!(
            t.ic_agent_registered,
            IInvestmentCommitteePolicyEvents::AgentRegistered::SIGNATURE_HASH
        );
        assert_eq!(
            t.ic_agent_revoked,
            IInvestmentCommitteePolicyEvents::AgentRevoked::SIGNATURE_HASH
        );
        assert_eq!(
            t.ic_vote_submitted,
            IInvestmentCommitteePolicyEvents::VoteSubmitted::SIGNATURE_HASH
        );
        // ConsensusRecommendationReceipt — issue #1247.
        assert_eq!(
            t.consensus_receipt_recorded,
            IConsensusRecommendationReceiptEvents::ReceiptRecorded::SIGNATURE_HASH
        );
        assert_eq!(
            t.consensus_receipt_released,
            IConsensusRecommendationReceiptEvents::ReceiptReleased::SIGNATURE_HASH
        );
        // GovernedUUPS proxy events — issue 1810.
        assert_eq!(
            t.proxy_upgraded,
            IGovernedUpgradeEvents::Upgraded::SIGNATURE_HASH
        );
        assert_eq!(
            t.proxy_upgrades_frozen,
            IGovernedUpgradeEvents::UpgradesFrozen::SIGNATURE_HASH
        );
        assert_eq!(
            t.proxy_initialized,
            IGovernedUpgradeEvents::Initialized::SIGNATURE_HASH
        );
        let all = t.all_topic0();
        assert!(
            all.contains(&t.proxy_upgraded)
                && all.contains(&t.proxy_upgrades_frozen)
                && all.contains(&t.proxy_initialized),
            "the upgrade, freeze and initializer topics must be in the eth_getLogs filter"
        );
    }

    /// Every topic-0 the indexer knows about must also appear in
    /// `all_topic0()` — a topic omitted there is never requested from
    /// `eth_getLogs`, so its events are silently dropped with no error.
    /// Issue #1247 added the two ConsensusRecommendationReceipt topics; this gate
    /// keeps them (and the pre-existing set) wired to the fetch filter.
    #[test]
    fn all_topic0_includes_consensus_receipt_topics() {
        let t = Topics::new();
        let all = t.all_topic0();
        assert!(
            all.contains(&t.consensus_receipt_recorded),
            "ReceiptRecorded topic-0 missing from Topics::all_topic0() — \
             the indexer would never fetch it"
        );
        assert!(
            all.contains(&t.consensus_receipt_released),
            "ReceiptReleased topic-0 missing from Topics::all_topic0() — \
             the indexer would never fetch it"
        );
        // No duplicate topic-0 may appear in the OR-filter.
        let mut sorted = all.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            all.len(),
            "duplicate topic-0 in Topics::all_topic0()"
        );
    }

    /// CI ABI drift gate — compares `sol!`-derived SIGNATURE_HASH constants
    /// against canonical topic-0 values computed at runtime from the
    /// authoritative event signature strings in the Solidity sources.
    ///
    /// This test is the automated ABI drift check required by issue #366.
    /// It catches any mismatch between:
    ///   1. The `sol!` event declarations in this file, and
    ///   2. The signature strings hand-transcribed into the table below.
    ///
    /// If any field is added, removed, or renamed in `abi.rs` without a
    /// matching change in the table below (or vice-versa), the test fails.
    ///
    /// **What it cannot catch (issue #1346).** Both sides of every comparison
    /// here are hand-maintained copies living in this file; the test reads no
    /// Solidity and no build artifact, so a signature change in the contracts
    /// leaves it green. `event_topics_match_foundry_artifacts` above is the
    /// half that reads the compiled `out/` artifacts and is therefore the gate
    /// that actually fails on real Solidity drift. Keep both: this one localises
    /// an internal inconsistency to a specific copy, that one establishes truth.
    ///
    /// Source references:
    ///   IGateway.sol:102,116,122,137,156,176  VaultRegistry.sol:146,152
    ///   PortfolioRouter.sol:122
    #[test]
    fn abi_drift_gate() {
        use alloy_primitives::keccak256;

        // One entry per indexed event: (event_name, canonical_signature, sol_macro_hash).
        let checks: &[(&str, &[u8], B256)] = &[
            // IGateway.sol:102
            (
                "AgentAuthorized",
                b"AgentAuthorized(address,address,uint64,uint256,uint256,address)",
                IGatewayEvents::AgentAuthorized::SIGNATURE_HASH,
            ),
            // IGateway.sol:116
            (
                "AgentOwnershipTransferred",
                b"AgentOwnershipTransferred(address,address,address)",
                IGatewayEvents::AgentOwnershipTransferred::SIGNATURE_HASH,
            ),
            // IGateway.sol:122
            (
                "AgentRevoked",
                b"AgentRevoked(address,address)",
                IGatewayEvents::AgentRevoked::SIGNATURE_HASH,
            ),
            // IGateway.sol:137
            (
                "AgentDeposit",
                b"AgentDeposit(bytes32,bytes32,address,address,uint256,uint256,uint64)",
                IGatewayEvents::AgentDeposit::SIGNATURE_HASH,
            ),
            // IGateway.sol:176
            (
                "AgentWithdrawal",
                b"AgentWithdrawal(bytes32,bytes32,address,address,uint256,uint256,address,uint64)",
                IGatewayEvents::AgentWithdrawal::SIGNATURE_HASH,
            ),
            // IGateway.sol:156
            (
                "AgentDepositRouted",
                b"AgentDepositRouted(bytes32,bytes32,address,address,address,uint256,uint256[],uint64)",
                IGatewayEvents::AgentDepositRouted::SIGNATURE_HASH,
            ),
            // VaultRegistry.sol:146
            (
                "VaultRegistered",
                b"VaultRegistered(address,string,address)",
                IVaultRegistryEvents::VaultRegistered::SIGNATURE_HASH,
            ),
            // VaultRegistry.sol:152 — VaultStatus enum ABI-encodes as uint8
            (
                "VaultStatusChanged",
                b"VaultStatusChanged(address,uint8,uint256)",
                IVaultRegistryEvents::VaultStatusChanged::SIGNATURE_HASH,
            ),
            // PortfolioRouter.sol:122
            (
                "RouterDeposit",
                b"RouterDeposit(address,address,uint256,uint256,uint256)",
                IPortfolioRouterEvents::RouterDeposit::SIGNATURE_HASH,
            ),
            // PortfolioRouter.sol:133 — weight-setter weight-set (applyReceipt path)
            (
                "WeightsSet",
                b"WeightsSet(address[],uint256[])",
                IPortfolioRouterEvents::WeightsSet::SIGNATURE_HASH,
            ),
            // PortfolioRouter.sol:139 — default (fallback) weight-set by ADMIN_ROLE
            (
                "DefaultWeightsSet",
                b"DefaultWeightsSet(address[],uint256[])",
                IPortfolioRouterEvents::DefaultWeightsSet::SIGNATURE_HASH,
            ),
            // ERC-4626 standard events (OpenZeppelin ERC4626 — inherited by all vaults)
            (
                "Deposit",
                b"Deposit(address,address,uint256,uint256)",
                IVaultEvents::Deposit::SIGNATURE_HASH,
            ),
            (
                "Withdraw",
                b"Withdraw(address,address,address,uint256,uint256)",
                IVaultEvents::Withdraw::SIGNATURE_HASH,
            ),
            // Snapshot-trigger vault events — issue 1781.
            // Declared in RobotMoneyVault.sol and contracts/vaults/BasketVault.sol.
            (
                "TvlCapUpdated",
                b"TvlCapUpdated(uint256,uint256)",
                IVaultEvents::TvlCapUpdated::SIGNATURE_HASH,
            ),
            (
                "PerDepositCapUpdated",
                b"PerDepositCapUpdated(uint256,uint256)",
                IVaultEvents::PerDepositCapUpdated::SIGNATURE_HASH,
            ),
            (
                "ExitFeeUpdated",
                b"ExitFeeUpdated(uint256,uint256)",
                IVaultEvents::ExitFeeUpdated::SIGNATURE_HASH,
            ),
            ("Shutdown", b"Shutdown()", IVaultEvents::Shutdown::SIGNATURE_HASH),
            (
                "Restored",
                b"Restored(uint256)",
                IVaultEvents::Restored::SIGNATURE_HASH,
            ),
            (
                "RedeemedInKind",
                b"RedeemedInKind(address,address,uint256)",
                IVaultEvents::RedeemedInKind::SIGNATURE_HASH,
            ),
            (
                "AdapterForceRemoved",
                b"AdapterForceRemoved(uint256,address,uint256)",
                IVaultEvents::AdapterForceRemoved::SIGNATURE_HASH,
            ),
            // InvestmentCommitteePolicy.sol:104,107,110 — issue #1053.
            // Stance ABI-encodes as uint8.
            (
                "AgentRegistered",
                b"AgentRegistered(address,string)",
                IInvestmentCommitteePolicyEvents::AgentRegistered::SIGNATURE_HASH,
            ),
            (
                "IC AgentRevoked",
                b"AgentRevoked(address)",
                IInvestmentCommitteePolicyEvents::AgentRevoked::SIGNATURE_HASH,
            ),
            (
                "VoteSubmitted",
                b"VoteSubmitted(uint256,address,address,uint8,uint16,uint8,string,bytes32,uint64)",
                IInvestmentCommitteePolicyEvents::VoteSubmitted::SIGNATURE_HASH,
            ),
            // ConsensusRecommendationReceipt.sol — issue #1247, docs/architecture.md §4.9.
            // Exactly two events; neither carries a signature parameter.
            (
                "ReceiptRecorded",
                b"ReceiptRecorded(bytes32,address,uint256,bytes32,string,uint64)",
                IConsensusRecommendationReceiptEvents::ReceiptRecorded::SIGNATURE_HASH,
            ),
            (
                "ReceiptReleased",
                b"ReceiptReleased(bytes32,address,uint64)",
                IConsensusRecommendationReceiptEvents::ReceiptReleased::SIGNATURE_HASH,
            ),
            // ExclusionLedger — core issue 1820, QA plan X7. Enum parameters encode as uint8.
            (
                "ExclusionOpened",
                b"ExclusionOpened(uint256,uint256,address,uint256,uint256)",
                IExclusionLedgerEvents::ExclusionOpened::SIGNATURE_HASH,
            ),
            (
                "ExclusionRecoveryCredited",
                b"ExclusionRecoveryCredited(uint256,uint8,uint256,uint256)",
                IExclusionLedgerEvents::ExclusionRecoveryCredited::SIGNATURE_HASH,
            ),
            (
                "ExclusionFinalized",
                b"ExclusionFinalized(uint256,uint8,uint256)",
                IExclusionLedgerEvents::ExclusionFinalized::SIGNATURE_HASH,
            ),
            (
                "ExclusionClaimed",
                b"ExclusionClaimed(uint256,address,uint256)",
                IExclusionLedgerEvents::ExclusionClaimed::SIGNATURE_HASH,
            ),
            // contracts/lib/GovernedUUPS.sol — issue 1810.
            (
                "Upgraded",
                b"Upgraded(address)",
                IGovernedUpgradeEvents::Upgraded::SIGNATURE_HASH,
            ),
            (
                "UpgradesFrozen",
                b"UpgradesFrozen(address,address,bytes32)",
                IGovernedUpgradeEvents::UpgradesFrozen::SIGNATURE_HASH,
            ),
            // OpenZeppelin Initializable (v5) — security round 3.
            (
                "Initialized",
                b"Initialized(uint64)",
                IGovernedUpgradeEvents::Initialized::SIGNATURE_HASH,
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
