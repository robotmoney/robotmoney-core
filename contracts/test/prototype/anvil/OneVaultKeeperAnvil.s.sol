// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.4 (who calls step()); scripts/ops/onevault-keeper.sh and
//            its self-test (core issue 2033).
// Experiment prototype only. Test-only: deploys a Rebalancer proxy on a plain local anvil chain against the one-vault fund
// that OneVaultDeliveryAnvil deployed, and binds its rebalance roles (the fund admin is the deployer). The keeper
// (KeeperAccount) holds the Rebalancer's KEEPER_ROLE. It is never part of a production deploy.
// Env: FUND_ADDRESS, TIMELOCK_ADDRESS (the stack's timelock), KEEPER_ADDRESS (KEEPER_ROLE holder),
//      REBALANCER_ANVIL_OUT (a path under ./out/prototype, written as REBALANCER=0x...).
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {GovernedUUPS} from "../../../lib/GovernedUUPS.sol";
import {Rebalancer} from "../src/Rebalancer.sol";
import {StepParams} from "../src/FundTypes.sol";
import {IRobotMoneyFundFull} from "../src/interfaces/IRobotMoneyFund.sol";

/// @title OneVaultKeeperAnvil
/// @notice Local anvil Rebalancer for the one-vault keeper self-test. Parameters follow PrototypeHarness._deployRebalancer.
contract OneVaultKeeperAnvil is Script {
    uint32 internal constant MAX_OVERRUN = 7 days;
    uint16 internal constant MAX_STEP_COST_BPS = 50;
    uint16 internal constant TOLERANCE_BPS = 50;
    uint128 internal constant MIN_STEP_USDC = 100e6;

    function run() external {
        address fund = vm.envAddress("FUND_ADDRESS");
        address timelock = vm.envAddress("TIMELOCK_ADDRESS");
        address keeper = vm.envAddress("KEEPER_ADDRESS");
        string memory outPath = vm.envString("REBALANCER_ANVIL_OUT");

        vm.startBroadcast();
        address deployer = msg.sender;
        uint32 interval = uint32(Math.max(30 minutes, IRobotMoneyFundFull(fund).maxTwapWindow()));
        StepParams memory sp = StepParams({
            stepInterval: interval,
            maxOverrun: MAX_OVERRUN,
            maxStepCostBps: MAX_STEP_COST_BPS,
            toleranceBps: TOLERANCE_BPS,
            minStepUsdc: MIN_STEP_USDC
        });
        address impl = address(new Rebalancer());
        address rebalancer = address(
            new ERC1967Proxy(
                impl,
                abi.encodeCall(
                    Rebalancer.initialize,
                    (
                        fund,
                        deployer,
                        keeper,
                        sp,
                        timelock,
                        GovernedUUPS.UpgradeMode.Upgradeable
                    )
                )
            )
        );
        // The fund's rebalance roles bind once. The governance slot takes the deployer, which is not a live governance here.
        IRobotMoneyFundFull(fund).bindRebalanceRoles(deployer, rebalancer);
        vm.stopBroadcast();

        vm.writeFile(outPath, string.concat("REBALANCER=", vm.toString(rebalancer), "\n"));
    }
}
