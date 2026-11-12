// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.3 (one step), §5.4 (who calls step), §5.6 (parameters);
//            PrototypeHarness.sol (_deployRebalancer).
// Deploy 4 (owner exception 2026-11-12): the one-vault prototype through the real deploy tool, as a rehearsal.
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Rebalancer} from "../test/prototype/src/Rebalancer.sol";
import {RobotMoneyFund} from "../test/prototype/src/RobotMoneyFund.sol";
import {AssetStepParams, StepParams, Roles} from "../test/prototype/src/FundTypes.sol";
import {FundSystemBase} from "./FundSystemBase.sol";

/// @title DeployRebalancer
/// @notice The `rebalancer` stage (Deploy 4): `Rebalancer` behind its ERC-1967 proxy, initialized with the fund, the
///         deployer as ADMIN_ROLE until the handover, KEEPER_ADDRESS as KEEPER_ROLE (§5.4: the keeper steps first, anyone
///         after `keeperGrace`), the §5.6 step parameters, and the predicted fund-system timelock as its only upgrade
///         authority. Then the per-asset step parameters: lending withdrawals are 1:1 (slippage 0), wETH and cbBTC sit
///         REBALANCER_MAJOR_SLIPPAGE_OVER_FEE_BPS above their pool fee, capped at the fund's maxSlippageBps.
///
///         `stepInterval` is not a sheet value: it is max(30 minutes, the fund's longest TWAP window) (§5.6).
///
///         Required env vars (no defaults): ADMIN_ADDRESS, FUND_ADDRESS, KEEPER_ADDRESS, REBALANCER_KEEPER_GRACE,
///         REBALANCER_MAX_OVERRUN, REBALANCER_MAX_STEP_COST_BPS, REBALANCER_TOLERANCE_BPS, REBALANCER_MIN_STEP_USDC,
///         REBALANCER_LENDING_MAX_STEP_USDC, REBALANCER_MAJOR_MAX_STEP_USDC, REBALANCER_MAJOR_SLIPPAGE_OVER_FEE_BPS,
///         SAFE_ADDRESS, TIMELOCK_MIN_DELAY, UPGRADE_MODE, DEPLOYMENT_OUT.
contract DeployRebalancer is FundSystemBase {
    /// @notice Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "rebalancer.json";

    struct Inputs {
        address admin;
        address fund;
        address keeper;
        StepParams step;
        uint128 lendingMaxStepUsdc;
        uint128 majorMaxStepUsdc;
        uint256 majorSlippageOverFeeBps;
    }

    struct Deployed {
        address rebalancer;
        address rebalancerImplementation;
        uint16[] slippageBps;
        UpgradeConfig upgrade;
    }

    /// @notice Forge broadcast entrypoint.
    function run() external returns (Deployed memory d) {
        _requireExpectedChain("");
        Inputs memory i = _readInputs();
        UpgradeConfig memory u = _readUpgradeConfig("");
        _envStringRequired("DEPLOYMENT_OUT");

        vm.startBroadcast();
        d = _deploy(i, u);
        vm.stopBroadcast();

        _check(d, i);
        _writeDeploymentJson(d, i);
    }

    function _readInputs() internal view returns (Inputs memory i) {
        i.admin = _envNonZeroAddress("ADMIN_ADDRESS");
        i.fund = _envContract("FUND_ADDRESS");
        i.keeper = _envNonZeroAddress("KEEPER_ADDRESS");
        require(i.keeper != i.admin, "KEEPER_ADDRESS == ADMIN_ADDRESS: the keeper is its own key");
        uint32 interval = uint32(Math.max(30 minutes, RobotMoneyFund(i.fund).maxTwapWindow()));
        i.step = StepParams({
            stepInterval: interval,
            keeperGrace: uint32(_envUintMax("REBALANCER_KEEPER_GRACE", type(uint32).max)),
            maxOverrun: uint32(_envUintMax("REBALANCER_MAX_OVERRUN", type(uint32).max)),
            maxStepCostBps: uint16(_envUintMax("REBALANCER_MAX_STEP_COST_BPS", type(uint16).max)),
            toleranceBps: uint16(_envUintMax("REBALANCER_TOLERANCE_BPS", type(uint16).max)),
            minStepUsdc: uint128(_envUintMax("REBALANCER_MIN_STEP_USDC", type(uint128).max))
        });
        i.lendingMaxStepUsdc = uint128(_envUintMax("REBALANCER_LENDING_MAX_STEP_USDC", type(uint128).max));
        i.majorMaxStepUsdc = uint128(_envUintMax("REBALANCER_MAJOR_MAX_STEP_USDC", type(uint128).max));
        i.majorSlippageOverFeeBps = _envUintMax("REBALANCER_MAJOR_SLIPPAGE_OVER_FEE_BPS", 10_000);
    }

    function _deploy(Inputs memory i, UpgradeConfig memory u) internal returns (Deployed memory d) {
        d.upgrade = u;
        d.rebalancerImplementation = address(new Rebalancer());
        d.rebalancer = _deployProxy(
            d.rebalancerImplementation,
            abi.encodeCall(Rebalancer.initialize, (i.fund, i.admin, i.keeper, i.step, u.timelock, u.mode))
        );
        Rebalancer r = Rebalancer(d.rebalancer);
        RobotMoneyFund f = RobotMoneyFund(i.fund);
        uint256 ceiling = f.maxSlippageBps();
        d.slippageBps = new uint16[](N_ASSETS);
        d.slippageBps[IDX_WETH] =
            uint16(Math.min(f.poolFeeBps(IDX_WETH) + i.majorSlippageOverFeeBps, ceiling));
        d.slippageBps[IDX_CBBTC] =
            uint16(Math.min(f.poolFeeBps(IDX_CBBTC) + i.majorSlippageOverFeeBps, ceiling));
        r.setAssetStepParams(IDX_AAVE, AssetStepParams(i.lendingMaxStepUsdc, 0));
        r.setAssetStepParams(IDX_MOONWELL, AssetStepParams(i.lendingMaxStepUsdc, 0));
        r.setAssetStepParams(IDX_WETH, AssetStepParams(i.majorMaxStepUsdc, d.slippageBps[IDX_WETH]));
        r.setAssetStepParams(IDX_CBBTC, AssetStepParams(i.majorMaxStepUsdc, d.slippageBps[IDX_CBBTC]));
        r.setAssetStepParams(IDX_COMET, AssetStepParams(i.lendingMaxStepUsdc, 0));
    }

    function _check(Deployed memory d, Inputs memory i) internal view {
        Rebalancer r = Rebalancer(d.rebalancer);
        require(r.hasRole(Roles.KEEPER_ROLE, i.keeper), "rebalancer: keeper lacks KEEPER_ROLE");
        require(r.hasRole(Roles.ADMIN_ROLE, i.admin), "rebalancer: deployer lacks ADMIN_ROLE");
        require(r.upgradeTimelock() == d.upgrade.timelock, "rebalancer: upgradeTimelock");
        require(_implementationOf(d.rebalancer) == d.rebalancerImplementation, "rebalancer: implementation slot");
    }

    function _writeDeploymentJson(Deployed memory d, Inputs memory i) internal {
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");
        string memory obj = "rebalancer_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "rebalancer", d.rebalancer);
        vm.serializeAddress(obj, "rebalancer_implementation", d.rebalancerImplementation);
        vm.serializeAddress(obj, "fund", i.fund);
        vm.serializeAddress(obj, "keeper", i.keeper);
        vm.serializeUint(obj, "step_interval", i.step.stepInterval);
        vm.serializeUint(obj, "min_step_usdc", i.step.minStepUsdc);
        vm.serializeUint(obj, "weth_slippage_bps", d.slippageBps[IDX_WETH]);
        vm.serializeUint(obj, "cbbtc_slippage_bps", d.slippageBps[IDX_CBBTC]);
        vm.serializeAddress(obj, "upgrade_timelock", d.upgrade.timelock);
        string memory json = vm.serializeString(obj, "upgrade_mode", upgradeModeName(d.upgrade.mode));
        vm.writeJson(json, outPath);
        console2.log("Wrote rebalancer deployment JSON to", outPath);
    }
}
