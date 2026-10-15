// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §7 — fixed ceilings stay constants
// Canonical: docs/technical/smart-contract-invariants.md — UPG-6 (an upgrade never loosens a ceiling)
// Implements: core issue 1808 (QA plan v1 P1)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ProtocolAssetVault} from "../vaults/ProtocolAssetVault.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {RwaBasketVault} from "../vaults/RwaBasketVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {ExclusionLedgerFactory} from "../ExclusionLedgerFactory.sol";
import {GovernedUpgrade} from "../lib/GovernedUpgrade.sol";

/// @dev Test-only probes for the `internal` ceilings (no public getter in the EIP-170-tight code).
contract RobotMoneyVaultCeilingProbe is RobotMoneyVault {
    function adapterCallGasFloor() external pure returns (uint256) {
        return ADAPTER_CALL_GAS_FLOOR;
    }

    function tailGasFloor() external pure returns (uint256) {
        return TAIL_GAS_FLOOR;
    }

    function pullEntryGasFloor() external pure returns (uint256) {
        return PULL_ENTRY_GAS_FLOOR;
    }

    function depositEntryGasFloor() external pure returns (uint256) {
        return DEPOSIT_ENTRY_GAS_FLOOR;
    }
}

/// @dev Probe for the `internal` basket ceilings, shared by the three kinds through `BasketVault`.
contract BasketVaultCeilingProbe is BasketVault {
    function maxAssets() public pure override returns (uint256) {
        return 1;
    }

    function _kindConfig() internal pure override returns (string memory, string memory, uint256) {
        return ("probe", "probe", 0);
    }

    function maxNavDeviationBps() external pure returns (uint256) {
        return MAX_NAV_DEVIATION_BPS;
    }

    function redeemBaseGas() external pure returns (uint256) {
        return REDEEM_BASE_GAS;
    }

    function redeemGasPerAsset() external pure returns (uint256) {
        return REDEEM_GAS_PER_ASSET;
    }
}

/// @dev Probe for the gateway's `internal` gas floors.
contract RobotMoneyGatewayCeilingProbe is RobotMoneyGateway {
    function withdrawGasFloor() external pure returns (uint256) {
        return WITHDRAW_GAS_FLOOR;
    }

    function routerWithdrawBaseGas() external pure returns (uint256) {
        return ROUTER_WITHDRAW_BASE_GAS;
    }

    function routerWithdrawGasPerLeg() external pure returns (uint256) {
        return ROUTER_WITHDRAW_GAS_PER_LEG;
    }

    function depositGasFloor() external pure returns (uint256) {
        return DEPOSIT_GAS_FLOOR;
    }

    function routerDepositBaseGas() external pure returns (uint256) {
        return ROUTER_DEPOSIT_BASE_GAS;
    }

    function routerDepositGasPerLeg() external pure returns (uint256) {
        return ROUTER_DEPOSIT_GAS_PER_LEG;
    }
}

/// @title UpgradeCeilingsTest
/// @notice ADR-0014 §7: the fixed ceilings are `constant`s in implementation bytecode. No role,
///         setter or initializer can change one, and an upgrade may keep or tighten a ceiling but
///         never loosen it. Each value of the ADR §7 table is pinned here in its safe direction: a
///         bound on what governance may set can only shrink (`<=`), a floor can only rise (`>=`).
///         Raising a ceiling, or lowering a floor, needs a new ADR, not an edit to this test.
/// @dev The constants are read from fresh implementations, which is where a new implementation
///      would carry a different value. The gas floors are part of the table: lowering one would
///      bring back the opaque out-of-gas failures core 1482 / 1513 removed.
contract UpgradeCeilingsTest is Test {
    function test_ceilingsNeverLoosened() public {
        // RobotMoneyVault (rmUSDC).
        RobotMoneyVaultCeilingProbe v = new RobotMoneyVaultCeilingProbe();
        assertLe(v.MAX_EXIT_FEE_BPS(), 100, "rmUSDC MAX_EXIT_FEE_BPS loosened");
        assertLe(v.MAX_ADAPTERS(), 20, "rmUSDC MAX_ADAPTERS loosened");
        assertLe(v.MAX_REBALANCE_BPS_CEILING(), 5_000, "rmUSDC MAX_REBALANCE_BPS_CEILING loosened");
        assertGe(
            v.MIN_REBALANCE_INTERVAL_FLOOR(),
            1 hours,
            "rmUSDC MIN_REBALANCE_INTERVAL_FLOOR loosened"
        );
        assertGe(v.adapterCallGasFloor(), 400_000, "rmUSDC ADAPTER_CALL_GAS_FLOOR lowered");
        assertGe(v.tailGasFloor(), 150_000, "rmUSDC TAIL_GAS_FLOOR lowered");
        assertGe(v.pullEntryGasFloor(), 1_600_000, "rmUSDC PULL_ENTRY_GAS_FLOOR lowered");
        assertGe(v.depositEntryGasFloor(), 1_600_000, "rmUSDC DEPOSIT_ENTRY_GAS_FLOOR lowered");

        // BasketVault (all three kinds share these).
        BasketVaultCeilingProbe b = new BasketVaultCeilingProbe();
        assertLe(b.MAX_EXIT_FEE_BPS(), 100, "basket MAX_EXIT_FEE_BPS loosened");
        assertLe(b.MAX_SLIPPAGE_BPS(), 500, "basket MAX_SLIPPAGE_BPS loosened");
        assertGe(uint256(b.MIN_TWAP_WINDOW()), 600, "basket MIN_TWAP_WINDOW loosened");
        assertLe(uint256(b.MAX_TWAP_WINDOW()), 86_400, "basket MAX_TWAP_WINDOW loosened");
        assertLe(b.maxNavDeviationBps(), 2_000, "basket MAX_NAV_DEVIATION_BPS loosened");
        assertGe(uint256(b.MIN_POOL_LIQUIDITY()), 1e6, "basket MIN_POOL_LIQUIDITY loosened");
        assertGe(b.redeemBaseGas(), 300_000, "basket REDEEM_BASE_GAS lowered");
        assertGe(b.redeemGasPerAsset(), 400_000, "basket REDEEM_GAS_PER_ASSET lowered");

        // Each kind's `_MAX_ASSETS`, read through its public `maxAssets()`.
        assertLe(new ProtocolAssetVault().maxAssets(), 10, "rmPROTO _MAX_ASSETS loosened");
        assertLe(new AgentTokenVault().maxAssets(), 15, "rmAGENT _MAX_ASSETS loosened");
        assertLe(new RwaBasketVault().maxAssets(), 10, "rmRWA _MAX_ASSETS loosened");

        // RobotMoneyGateway.
        RobotMoneyGatewayCeilingProbe g = new RobotMoneyGatewayCeilingProbe();
        assertLe(g.MAX_DEADLINE_SKEW(), 600, "gateway MAX_DEADLINE_SKEW loosened");
        assertLe(g.MAX_WINDOW_ENTRIES(), 86_400, "gateway MAX_WINDOW_ENTRIES loosened");
        assertGe(g.withdrawGasFloor(), 2_000_000, "gateway WITHDRAW_GAS_FLOOR lowered");
        assertGe(g.routerWithdrawBaseGas(), 400_000, "gateway ROUTER_WITHDRAW_BASE_GAS lowered");
        assertGe(
            g.routerWithdrawGasPerLeg(), 1_850_000, "gateway ROUTER_WITHDRAW_GAS_PER_LEG lowered"
        );
        assertGe(g.depositGasFloor(), 2_000_000, "gateway DEPOSIT_GAS_FLOOR lowered");
        assertGe(g.routerDepositBaseGas(), 400_000, "gateway ROUTER_DEPOSIT_BASE_GAS lowered");
        assertGe(
            g.routerDepositGasPerLeg(), 1_850_000, "gateway ROUTER_DEPOSIT_GAS_PER_LEG lowered"
        );
    }

    /// @notice A ceiling bounds the initializer exactly as it bounds the setter (ADR-0014 §7): an
    ///         initial exit fee above `MAX_EXIT_FEE_BPS` reverts `InvalidFee` inside the proxy's
    ///         deployment, so no deployment can start above a ceiling either.
    function test_initializerHonoursTheCeiling() public {
        RobotMoneyVault implementation = new RobotMoneyVault();
        bytes memory init = abi.encodeCall(
            RobotMoneyVault.initialize,
            (
                IERC20(address(1)),
                0,
                0,
                101, // MAX_EXIT_FEE_BPS + 1
                address(2),
                address(3),
                address(4),
                ExclusionLedgerFactory(address(5)),
                address(this),
                GovernedUpgrade.UpgradeMode.Upgradeable
            )
        );
        vm.expectRevert(RobotMoneyVault.InvalidFee.selector);
        new ERC1967Proxy(address(implementation), init);
    }
}
