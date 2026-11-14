// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §6.1 (size: the fund's logic lives in linked libraries);
//            core issue 1721 (libraries forge deploys through the CREATE2 factory inside a stage).
// Deploy 4 (owner exception 2026-11-12): the one-vault prototype through the real deploy tool, as a rehearsal.
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {TickMath} from "../lib/TickMath.sol";
import {TwapTickMath} from "../lib/TwapTickMath.sol";
import {BasketSwaps} from "../lib/BasketSwaps.sol";
import {BasketAssetConfigGuard} from "../lib/BasketAssetConfigGuard.sol";
import {GovernedUpgrade} from "../lib/GovernedUUPS.sol";
import {FundPositionLib} from "../test/prototype/src/lib/FundPositionLib.sol";
import {FundValuationLib} from "../test/prototype/src/lib/FundValuationLib.sol";
import {FundAdminLib} from "../test/prototype/src/lib/FundAdminLib.sol";
import {FundFlowsLib} from "../test/prototype/src/lib/FundFlowsLib.sol";
import {FundStepLib} from "../test/prototype/src/lib/FundStepLib.sol";
import {StepFeedLib} from "../test/prototype/src/lib/StepFeedLib.sol";
import {FlowCheckLib} from "../test/prototype/src/lib/FlowCheckLib.sol";
import {FlowSettleLib} from "../test/prototype/src/lib/FlowSettleLib.sol";
import {FlowClaimLib} from "../test/prototype/src/lib/FlowClaimLib.sol";
import {ExpectedChainGuard} from "./ExpectedChainGuard.sol";

/// @title DeployFundLibs
/// @notice The first stage of the `fund` system (Deploy 4). Deploys every library the one-vault contracts link, through
///         the CREATE2 factory forge uses for script libraries (salt 0), before any stage that links them. The fund
///         alone is 23 kB with its logic outside it (§6.1), so the libraries are most of the system's bytes.
///
///         The script references each library's address, so forge deploys each one it finds without code at its
///         CREATE2 address and leaves out each one already there (core issue 1721: the runner proves an adopted one is
///         the build's library). The fund system links no `--libraries` address: TickMath is one of these CREATE2
///         libraries here, at the same address the vaults system's `libs` stage gives it.
///
///         Required env vars: DEPLOYMENT_OUT (output JSON path). EXPECTED_CHAIN_ID is mandatory and 8453 on Base.
contract DeployFundLibs is ExpectedChainGuard {
    /// @notice Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "fund-libs.json";

    /// @notice sqrt(1.0001^0) * 2^96: the canonical answer for tick 0.
    uint160 public constant SQRT_RATIO_AT_TICK_ZERO = 79228162514264337593543950336;

    struct Deployed {
        address tickMath;
        address twapTickMath;
        address basketSwaps;
        address basketAssetConfigGuard;
        address governedUpgrade;
        address fundPositionLib;
        address fundValuationLib;
        address fundAdminLib;
        address fundFlowsLib;
        address fundStepLib;
        address stepFeedLib;
        address flowCheckLib;
        address flowSettleLib;
        address flowClaimLib;
    }

    /// @notice Forge broadcast entrypoint.
    function run() external returns (Deployed memory d) {
        _requireExpectedChain("");
        _envStringRequired("DEPLOYMENT_OUT");
        vm.startBroadcast();
        d = _deploy();
        vm.stopBroadcast();
        _writeDeploymentJson(d);
    }

    /// @notice In-process variant for forge tests. No broadcast, no JSON written.
    function runInProcess() external returns (Deployed memory d) {
        d = _deploy();
        console2.log("fund-libs: fund_admin_lib", d.fundAdminLib);
    }

    function _deploy() internal view returns (Deployed memory d) {
        d.tickMath = address(TickMath);
        d.twapTickMath = address(TwapTickMath);
        d.basketSwaps = address(BasketSwaps);
        d.basketAssetConfigGuard = address(BasketAssetConfigGuard);
        d.governedUpgrade = address(GovernedUpgrade);
        d.fundPositionLib = address(FundPositionLib);
        d.fundValuationLib = address(FundValuationLib);
        d.fundAdminLib = address(FundAdminLib);
        d.fundFlowsLib = address(FundFlowsLib);
        d.fundStepLib = address(FundStepLib);
        d.stepFeedLib = address(StepFeedLib);
        d.flowCheckLib = address(FlowCheckLib);
        d.flowSettleLib = address(FlowSettleLib);
        d.flowClaimLib = address(FlowClaimLib);
        // The call proves TickMath is linked to working code, not only to an address (finding L3-D1).
        require(
            TickMath.getSqrtRatioAtTick(0) == SQRT_RATIO_AT_TICK_ZERO, "TickMath: tick 0 mismatch"
        );
        address[14] memory all = [
            d.tickMath,
            d.twapTickMath,
            d.basketSwaps,
            d.basketAssetConfigGuard,
            d.governedUpgrade,
            d.fundPositionLib,
            d.fundValuationLib,
            d.fundAdminLib,
            d.fundFlowsLib,
            d.fundStepLib,
            d.stepFeedLib,
            d.flowCheckLib,
            d.flowSettleLib,
            d.flowClaimLib
        ];
        for (uint256 i = 0; i < all.length; i++) {
            require(all[i] != address(0), "fund-libs: zero linked library");
        }
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");
        string memory obj = "fund_libs_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "tick_math", d.tickMath);
        vm.serializeAddress(obj, "twap_tick_math", d.twapTickMath);
        vm.serializeAddress(obj, "basket_swaps", d.basketSwaps);
        vm.serializeAddress(obj, "basket_asset_config_guard", d.basketAssetConfigGuard);
        vm.serializeAddress(obj, "governed_upgrade", d.governedUpgrade);
        vm.serializeAddress(obj, "fund_position_lib", d.fundPositionLib);
        vm.serializeAddress(obj, "fund_valuation_lib", d.fundValuationLib);
        vm.serializeAddress(obj, "fund_admin_lib", d.fundAdminLib);
        vm.serializeAddress(obj, "fund_flows_lib", d.fundFlowsLib);
        vm.serializeAddress(obj, "fund_step_lib", d.fundStepLib);
        vm.serializeAddress(obj, "step_feed_lib", d.stepFeedLib);
        vm.serializeAddress(obj, "flow_check_lib", d.flowCheckLib);
        vm.serializeAddress(obj, "flow_settle_lib", d.flowSettleLib);
        string memory json = vm.serializeAddress(obj, "flow_claim_lib", d.flowClaimLib);
        vm.writeJson(json, outPath);
        console2.log("Wrote fund-libs deployment JSON to", outPath);
    }
}
