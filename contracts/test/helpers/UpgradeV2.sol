// SPDX-License-Identifier: MIT
// Canonical: docs/technical/contract-upgradeability-plan.md — Delivery sequence step 3 (v1 -> v2 state preservation, issue 1808)
pragma solidity ^0.8.24;

import {RobotMoneyVault} from "../../RobotMoneyVault.sol";
import {ProtocolAssetVault} from "../../vaults/ProtocolAssetVault.sol";
import {AgentTokenVault} from "../../vaults/AgentTokenVault.sol";
import {RwaBasketVault} from "../../vaults/RwaBasketVault.sol";
import {VaultRegistry} from "../../VaultRegistry.sol";
import {PortfolioRouter} from "../../PortfolioRouter.sol";
import {RobotMoneyGateway} from "../../gateway/RobotMoneyGateway.sol";
import {InvestmentCommitteePolicy} from "../../gateway/InvestmentCommitteePolicy.sol";
import {ConsensusRecommendationReceipt} from "../../gateway/ConsensusRecommendationReceipt.sol";
import {RouterGovernance} from "../../RouterGovernance.sol";

// Test-only v2 implementations (issue 1808). Each is the v1 contract plus one marker getter, so a
// test can see which implementation a proxy runs while every v1 slot stays where it was: the
// state-preservation tests upgrade a populated v1 proxy to these through the real Safe and timelock
// and read every v1 value back.

/// @dev The marker every v2 answers.
uint256 constant UPGRADE_V2_MARKER = 2;

contract RobotMoneyVaultV2 is RobotMoneyVault {
    function upgradeMarker() external pure returns (uint256) {
        return UPGRADE_V2_MARKER;
    }
}

contract ProtocolAssetVaultV2 is ProtocolAssetVault {
    function upgradeMarker() external pure returns (uint256) {
        return UPGRADE_V2_MARKER;
    }
}

contract AgentTokenVaultV2 is AgentTokenVault {
    function upgradeMarker() external pure returns (uint256) {
        return UPGRADE_V2_MARKER;
    }
}

contract RwaBasketVaultV2 is RwaBasketVault {
    function upgradeMarker() external pure returns (uint256) {
        return UPGRADE_V2_MARKER;
    }
}

contract VaultRegistryV2 is VaultRegistry {
    function upgradeMarker() external pure returns (uint256) {
        return UPGRADE_V2_MARKER;
    }
}

contract PortfolioRouterV2 is PortfolioRouter {
    function upgradeMarker() external pure returns (uint256) {
        return UPGRADE_V2_MARKER;
    }
}

contract RobotMoneyGatewayV2 is RobotMoneyGateway {
    function upgradeMarker() external pure returns (uint256) {
        return UPGRADE_V2_MARKER;
    }
}

contract InvestmentCommitteePolicyV2 is InvestmentCommitteePolicy {
    function upgradeMarker() external pure returns (uint256) {
        return UPGRADE_V2_MARKER;
    }
}

contract ConsensusRecommendationReceiptV2 is ConsensusRecommendationReceipt {
    function upgradeMarker() external pure returns (uint256) {
        return UPGRADE_V2_MARKER;
    }
}

contract RouterGovernanceV2 is RouterGovernance {
    function upgradeMarker() external pure returns (uint256) {
        return UPGRADE_V2_MARKER;
    }
}

/// @dev A v2 with an appended slot and a reinitializer, the shape a real v2 that adds state has.
contract VaultRegistryV2Reinit is VaultRegistry {
    uint256 public v2Value;

    function initializeV2(uint256 value) external reinitializer(2) {
        v2Value = value;
    }

    /// @dev A parent initializer outside any initializer must revert (`NotInitializing`).
    function reinitParents() external {
        __AccessControlEnumerable_init();
    }

    /// @dev Re-running the upgrade-authority initializer in a reinitializer must revert.
    function initializeV3RenamesAuthority(address timelock) external reinitializer(3) {
        __GovernedUUPS_init(timelock, UpgradeMode.Upgradeable);
    }
}

/// @dev Not a UUPS implementation: no `proxiableUUID`.
contract NotUUPS {
    function hello() external pure returns (uint256) {
        return 1;
    }
}

/// @dev Answers `proxiableUUID` with the wrong slot.
contract WrongUUID {
    function proxiableUUID() external pure returns (bytes32) {
        return keccak256("not the ERC-1967 implementation slot");
    }
}
