//! ABI surfaces the indexer decodes — IGateway and RobotMoneyVault
//! events plus the ERC-4626 / vault state reads. Mirrors the contract
//! sources in `contracts/gateway/interfaces/IGateway.sol` and
//! `contracts/RobotMoneyVault.sol`.

use alloy_primitives::{keccak256, B256};
use alloy_sol_types::sol;

sol! {
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
    }
}
