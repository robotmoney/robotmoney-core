// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §13 gate G1 (EIP-170 headroom), §4 (fund), §5
//            (rebalancer), §6 and §6.1 (FlowQueue row, size); scaffold plan §1 item 5, §7.5 item 6
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {PrototypeHarness} from "./PrototypeHarness.sol";
import {TickMath} from "../../lib/TickMath.sol";
import {TwapTickMath} from "../../lib/TwapTickMath.sol";
import {BasketSwaps} from "../../lib/BasketSwaps.sol";
import {BasketAssetConfigGuard} from "../../lib/BasketAssetConfigGuard.sol";
import {GovernedUpgrade} from "../../lib/GovernedUUPS.sol";
import {FundValuationLib} from "../../lib/FundValuationLib.sol";
import {FundAdminLib} from "../../lib/FundAdminLib.sol";
import {FundFlowsLib} from "../../lib/FundFlowsLib.sol";
import {FundPositionLib} from "../../lib/FundPositionLib.sol";
import {FundStepLib} from "../../lib/FundStepLib.sol";
import {FundDelistLib} from "../../lib/FundDelistLib.sol";
import {StepFeedLib} from "../../lib/StepFeedLib.sol";
import {FundStorage} from "../../lib/FundStorage.sol";
import {FlowCheckLib} from "../../lib/FlowCheckLib.sol";
import {FlowMatchLib} from "../../lib/FlowMatchLib.sol";
import {FlowSettleLib} from "../../lib/FlowSettleLib.sol";
import {FlowClaimLib} from "../../lib/FlowClaimLib.sol";
import {PlanMath} from "../../PlanMath.sol";

/// @notice One-vault experiment (plan Step 2.2, gate G1; step 3d adds the queue; step 3f adds `FlowMatchLib` and
///         `FundDelistLib`): the core implementations and every linked library deploy under EIP-170 (24,576 bytes)
///         runtime and EIP-3860 (49,152 bytes) initcode limits. Sizes are read from the code the harness actually
///         deployed (the ERC-1967 implementation behind each proxy, the libraries forge linked), compiled with the
///         repo's production optimizer settings.
contract SizeGateTest is PrototypeHarness {
    /// @dev EIP-170 runtime code limit.
    uint256 internal constant EIP170_LIMIT = 24_576;
    /// @dev EIP-3860 max initcode size.
    uint256 internal constant EIP3860_LIMIT = 49_152;
    /// @dev G1: the EIP-170 limit itself (owner, 2026-11-12: the earlier 1 KB headroom was arbitrary).
    uint256 internal constant G1_MAX = EIP170_LIMIT;

    function setUp() public override {
        super.setUp();
    }

    function _impl(address proxy) internal view returns (address impl) {
        impl = address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
        assertTrue(impl != address(0) && impl != proxy, "proxy has an implementation");
    }

    function _assertLinkedLib(string memory label, address lib) internal view {
        uint256 size = lib.code.length;
        console2.log(label, size);
        assertGt(size, 0, string.concat(label, ": not deployed"));
        assertLe(size, EIP170_LIMIT, string.concat(label, ": over EIP-170"));
    }

    function _assertInitCode(string memory label, string memory artifact) internal view {
        bytes memory code = vm.getCode(artifact);
        uint256 size = code.length;
        console2.log(label, size);
        assertGt(size, 0, string.concat(label, ": empty initcode"));
        assertLe(size, EIP3860_LIMIT, string.concat(label, ": over EIP-3860"));
    }

    /// @notice G1 (§13): fund, rebalancer and queue implementation `code.length` <= 24,576 (EIP-170), plus all 16
    ///         libraries from `DeployFundLibs` (`FlowMatchLib`, `FundDelistLib`, etc.) and EIP-3860 initcode limits.
    function test_G1_fundRebalancerAndQueueFitWithHeadroom() public fixtureCovered {
        uint256 fundSize = _impl(address(fund)).code.length;
        uint256 rebalancerSize = _impl(address(rebalancer)).code.length;
        uint256 queueSize = _impl(address(queue)).code.length;
        uint256 governanceSize = _impl(address(governance)).code.length;
        uint256 ledgerSize = fund.exclusionLedger().code.length;

        console2.log("G1 limit (EIP-170)          ", G1_MAX);
        console2.log("EIP-3860 initcode limit     ", EIP3860_LIMIT);
        console2.log("RobotMoneyFund impl         ", fundSize);
        console2.log("Rebalancer impl             ", rebalancerSize);
        console2.log("FlowQueue impl              ", queueSize);
        console2.log("RebalanceGovernance impl    ", governanceSize);
        console2.log("FundExclusionLedger         ", ledgerSize);

        assertGt(fundSize, 0, "fund impl deployed");
        assertGt(rebalancerSize, 0, "rebalancer impl deployed");
        assertGt(queueSize, 0, "queue impl deployed");
        assertGt(governanceSize, 0, "governance impl deployed");
        assertGt(ledgerSize, 0, "ledger deployed");
        assertLe(fundSize, G1_MAX, "G1: RobotMoneyFund impl exceeds EIP-170 (24,576 bytes)");
        assertLe(rebalancerSize, G1_MAX, "G1: Rebalancer impl exceeds EIP-170 (24,576 bytes)");
        assertLe(queueSize, G1_MAX, "G1: FlowQueue impl exceeds EIP-170 (24,576 bytes)");
        assertLe(ledgerSize, EIP170_LIMIT, "FundExclusionLedger over EIP-170");
        assertLe(governanceSize, EIP170_LIMIT, "RebalanceGovernance over EIP-170");

        // All 16 libraries from DeployFundLibs.s.sol (deployed > 0 and <= EIP-170).
        _assertLinkedLib("TickMath                    ", address(TickMath));
        _assertLinkedLib("TwapTickMath                ", address(TwapTickMath));
        _assertLinkedLib("BasketSwaps                 ", address(BasketSwaps));
        _assertLinkedLib("BasketAssetConfigGuard      ", address(BasketAssetConfigGuard));
        _assertLinkedLib("GovernedUpgrade             ", address(GovernedUpgrade));
        _assertLinkedLib("FundPositionLib             ", address(FundPositionLib));
        _assertLinkedLib("FundValuationLib            ", address(FundValuationLib));
        _assertLinkedLib("FundAdminLib                ", address(FundAdminLib));
        _assertLinkedLib("FundFlowsLib                ", address(FundFlowsLib));
        _assertLinkedLib("FundStepLib                 ", address(FundStepLib));
        _assertLinkedLib("FundDelistLib               ", address(FundDelistLib));
        _assertLinkedLib("StepFeedLib                 ", address(StepFeedLib));
        _assertLinkedLib("FlowCheckLib                ", address(FlowCheckLib));
        _assertLinkedLib("FlowMatchLib                ", address(FlowMatchLib));
        _assertLinkedLib("FlowSettleLib               ", address(FlowSettleLib));
        _assertLinkedLib("FlowClaimLib                ", address(FlowClaimLib));

        // Internal-only libraries: inlined into callers; the stub is small/zero.
        console2.log("FundStorage (inlined stub)  ", type(FundStorage).runtimeCode.length);
        console2.log("PlanMath (inlined stub)     ", type(PlanMath).runtimeCode.length);
        console2.log("Fund headroom under G1      ", fundSize <= G1_MAX ? G1_MAX - fundSize : 0);
        console2.log("Queue headroom under G1     ", queueSize <= G1_MAX ? G1_MAX - queueSize : 0);

        // EIP-3860 initcode limits on all core contracts and all 16 libraries (full path disambiguates baseline/).
        _assertInitCode(
            "RobotMoneyFund initcode     ",
            "contracts/test/prototype/src/RobotMoneyFund.sol:RobotMoneyFund"
        );
        _assertInitCode(
            "Rebalancer initcode         ", "contracts/test/prototype/src/Rebalancer.sol:Rebalancer"
        );
        _assertInitCode(
            "FlowQueue initcode          ", "contracts/test/prototype/src/FlowQueue.sol:FlowQueue"
        );
        _assertInitCode(
            "RebalanceGovernance initcode",
            "contracts/test/prototype/src/RebalanceGovernance.sol:RebalanceGovernance"
        );
        _assertInitCode(
            "FundExclusionLedger initcode",
            "contracts/test/prototype/src/FundExclusionLedger.sol:FundExclusionLedger"
        );
        _assertInitCode("TickMath initcode           ", "contracts/lib/TickMath.sol:TickMath");
        _assertInitCode(
            "TwapTickMath initcode       ", "contracts/lib/TwapTickMath.sol:TwapTickMath"
        );
        _assertInitCode("BasketSwaps initcode        ", "contracts/lib/BasketSwaps.sol:BasketSwaps");
        _assertInitCode(
            "BasketAssetConfigGuard init ",
            "contracts/lib/BasketAssetConfigGuard.sol:BasketAssetConfigGuard"
        );
        _assertInitCode(
            "GovernedUpgrade initcode    ", "contracts/lib/GovernedUUPS.sol:GovernedUpgrade"
        );
        _assertInitCode(
            "FundPositionLib initcode    ",
            "contracts/test/prototype/src/lib/FundPositionLib.sol:FundPositionLib"
        );
        _assertInitCode(
            "FundValuationLib initcode   ",
            "contracts/test/prototype/src/lib/FundValuationLib.sol:FundValuationLib"
        );
        _assertInitCode(
            "FundAdminLib initcode       ",
            "contracts/test/prototype/src/lib/FundAdminLib.sol:FundAdminLib"
        );
        _assertInitCode(
            "FundFlowsLib initcode       ",
            "contracts/test/prototype/src/lib/FundFlowsLib.sol:FundFlowsLib"
        );
        _assertInitCode(
            "FundStepLib initcode        ",
            "contracts/test/prototype/src/lib/FundStepLib.sol:FundStepLib"
        );
        _assertInitCode(
            "FundDelistLib initcode      ",
            "contracts/test/prototype/src/lib/FundDelistLib.sol:FundDelistLib"
        );
        _assertInitCode(
            "StepFeedLib initcode        ",
            "contracts/test/prototype/src/lib/StepFeedLib.sol:StepFeedLib"
        );
        _assertInitCode(
            "FlowCheckLib initcode       ",
            "contracts/test/prototype/src/lib/FlowCheckLib.sol:FlowCheckLib"
        );
        _assertInitCode(
            "FlowMatchLib initcode       ",
            "contracts/test/prototype/src/lib/FlowMatchLib.sol:FlowMatchLib"
        );
        _assertInitCode(
            "FlowSettleLib initcode      ",
            "contracts/test/prototype/src/lib/FlowSettleLib.sol:FlowSettleLib"
        );
        _assertInitCode(
            "FlowClaimLib initcode       ",
            "contracts/test/prototype/src/lib/FlowClaimLib.sol:FlowClaimLib"
        );

        // Step 3f: all 5 prototype adapters (EIP-170 runtime <= 24,576 B, EIP-3860 initcode <= 49,152 B).
        assertGt(address(aaveAdapter).code.length, 0, "aaveAdapter deployed");
        assertLe(address(aaveAdapter).code.length, EIP170_LIMIT, "aaveAdapter over EIP-170");
        assertGt(address(moonwellAdapter).code.length, 0, "moonwellAdapter deployed");
        assertLe(address(moonwellAdapter).code.length, EIP170_LIMIT, "moonwellAdapter over EIP-170");
        assertGt(address(swapAdapter).code.length, 0, "swapAdapter deployed");
        assertLe(address(swapAdapter).code.length, EIP170_LIMIT, "swapAdapter over EIP-170");
        if (cometListed) {
            assertGt(address(cometAdapter).code.length, 0, "cometAdapter deployed");
            assertLe(address(cometAdapter).code.length, EIP170_LIMIT, "cometAdapter over EIP-170");
        }

        _assertAdapterArtifact(
            "AaveV3RateAdapter           ",
            "contracts/test/prototype/src/adapters/AaveV3RateAdapter.sol:AaveV3RateAdapter"
        );
        _assertAdapterArtifact(
            "CompoundV3RateAdapter       ",
            "contracts/test/prototype/src/adapters/CompoundV3RateAdapter.sol:CompoundV3RateAdapter"
        );
        _assertAdapterArtifact(
            "MorphoRateAdapter           ",
            "contracts/test/prototype/src/adapters/MorphoRateAdapter.sol:MorphoRateAdapter"
        );
        _assertAdapterArtifact(
            "UniswapV3ExactOutSwapAdapter",
            "contracts/test/prototype/src/adapters/UniswapV3ExactOutSwapAdapter.sol:UniswapV3ExactOutSwapAdapter"
        );
        _assertAdapterArtifact(
            "AerodromeExactOutSwapAdapter",
            "contracts/test/prototype/src/adapters/AerodromeExactOutSwapAdapter.sol:AerodromeExactOutSwapAdapter"
        );

        // Internal/inlined prototype libraries (verify stub runtime <= EIP-170 and initcode <= EIP-3860).
        assertLe(type(FundStorage).runtimeCode.length, EIP170_LIMIT, "FundStorage over EIP-170");
        assertLe(type(PlanMath).runtimeCode.length, EIP170_LIMIT, "PlanMath over EIP-170");
        _assertInitCode(
            "FundStorage initcode        ",
            "contracts/test/prototype/src/lib/FundStorage.sol:FundStorage"
        );
        _assertInitCode(
            "PlanMath initcode           ", "contracts/test/prototype/src/PlanMath.sol:PlanMath"
        );
        _assertInitCode(
            "FeedLib initcode            ", "contracts/test/prototype/src/lib/FeedLib.sol:FeedLib"
        );
        _assertInitCode(
            "TwapSlicesLib initcode      ",
            "contracts/test/prototype/src/lib/TwapSlicesLib.sol:TwapSlicesLib"
        );
        _assertInitCode(
            "FlowStorage initcode        ",
            "contracts/test/prototype/src/lib/FlowStorage.sol:FlowStorage"
        );
    }

    function _assertAdapterArtifact(string memory label, string memory artifact) private view {
        bytes memory rt = vm.getDeployedCode(artifact);
        console2.log(label, rt.length);
        assertGt(rt.length, 0, label);
        assertLe(rt.length, EIP170_LIMIT, label);
        _assertInitCode(string.concat(label, " init"), artifact);
    }
}
