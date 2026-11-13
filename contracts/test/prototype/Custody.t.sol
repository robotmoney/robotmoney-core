// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md §12 INV-2, INV-3; docs/technical/one-vault-rebalancer-proposal.md §4.5 (the seed), §5.9.5
//            (flow parameters through the timelock), §7; docs/technical/one-vault-timed-flows-eng-plan.md E14
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PrototypeHarness} from "./PrototypeHarness.sol";
import {RobotMoneyFund} from "./src/RobotMoneyFund.sol";
import {FlowQueue} from "./src/FlowQueue.sol";
import {FlowParams} from "./src/FlowTypes.sol";

/// @notice One-vault experiment (plan Step 2, G3; step 3d flows): the two custody invariants the other suites leave
///         open. INV-3: fee recipient, fee parameters, quarantine and the flow parameters change only through the
///         timelock. INV-2: donations accrue pro rata to holders (the seed's own shares included), and share
///         inflation by a first depositor does not pay (the seed, E14, makes the fund never empty).
contract CustodyTest is PrototypeHarness {
    using Math for uint256;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    function _expectAllRefused(address target, bytes memory data) internal {
        address[6] memory callers =
            [stranger, emergency, keeper, address(governance), address(rebalancer), address(queue)];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            (bool ok,) = target.call(data);
            assertFalse(ok, "non-timelock caller changed a governed parameter");
        }
    }

    function test_INV3_feeAndQuarantineOnlyViaTimelock() public fixtureCovered {
        address quarantine = fund.quarantineAddress();
        (,, uint256 feeBps0, address recipient0) = fund.config();

        _expectAllRefused(address(fund), abi.encodeCall(RobotMoneyFund.setFeeRecipient, (stranger)));
        _expectAllRefused(address(fund), abi.encodeCall(RobotMoneyFund.setExitFeeBps, (100)));
        _expectAllRefused(address(fund), abi.encodeCall(RobotMoneyFund.setExitFeeBps, (0)));
        _expectAllRefused(
            address(fund),
            abi.encodeWithSignature("upgradeToAndCall(address,bytes)", stranger, bytes(""))
        );
        _expectAllRefused(
            address(fund), abi.encodeCall(RobotMoneyFund.setInKindAllowance, (10_000, 0, 6 hours))
        );

        (,, uint256 feeBps1, address recipient1) = fund.config();
        assertEq(feeBps1, feeBps0, "fee bps unchanged");
        assertEq(recipient1, recipient0, "fee recipient unchanged");

        // The timelock path does take effect.
        address newRecipient = makeAddr("newFeeRecipient");
        timelockExecute(
            address(fund), abi.encodeCall(RobotMoneyFund.setFeeRecipient, (newRecipient))
        );
        timelockExecute(address(fund), abi.encodeCall(RobotMoneyFund.setExitFeeBps, (20)));
        (,, uint256 feeBps2, address recipient2) = fund.config();
        assertEq(feeBps2, 20, "timelock set fee bps");
        assertEq(recipient2, newRecipient, "timelock set fee recipient");

        // The quarantine is a fixed constant: no setter exists, so no path changes it.
        assertEq(fund.quarantineAddress(), quarantine, "quarantine fixed");
        assertTrue(quarantine != address(0), "quarantine set");
    }

    /// @dev §5.9.5: the flow parameters, the queue's unpause and its upgrade are the timelock's alone.
    function test_INV3_flowParamsOnlyViaTimelock() public fixtureCovered {
        FlowParams memory p = queue.flowParams();
        p.maxEpochFlowBps = 1_000;
        _expectAllRefused(address(queue), abi.encodeCall(FlowQueue.setFlowParams, (p)));
        _expectAllRefused(
            address(queue),
            abi.encodeWithSignature("upgradeToAndCall(address,bytes)", stranger, bytes(""))
        );
        vm.prank(emergency);
        queue.pause();
        _expectAllRefused(address(queue), abi.encodeCall(FlowQueue.unpause, ()));
        assertTrue(queue.paused(), "still paused");
        assertEq(queue.flowParams().maxEpochFlowBps, 500, "unchanged");

        timelockExecute(address(queue), abi.encodeCall(FlowQueue.setFlowParams, (p)));
        assertEq(queue.flowParams().maxEpochFlowBps, 1_000, "timelock set the flow cap");
        timelockExecute(address(queue), abi.encodeCall(FlowQueue.unpause, ()));
        assertFalse(queue.paused(), "timelock unpaused");
    }

    /// @dev A USDC donation raises every holder's claim pro rata, the seed's included. The donor gets nothing back.
    function test_INV2_donationAccruesProRata() public fixtureCovered {
        deposit(alice, 30_000e6);
        deposit(bob, 10_000e6);
        uint256 supply = fund.totalSupply();
        uint256 sa = fund.balanceOf(alice);
        uint256 sb = fund.balanceOf(bob);
        uint256 seedShares = fund.balanceOf(address(fund));
        uint256 a0 = fund.convertToAssets(sa);
        uint256 b0 = fund.convertToAssets(sb);
        uint256 s0 = fund.convertToAssets(seedShares);
        uint256 nav0 = fund.totalAssets();

        uint256 gift = 4_000e6;
        fundUsdc(address(fund), gift);

        assertEq(fund.totalAssets(), nav0 + gift, "donation counted in NAV");
        uint256 a1 = fund.convertToAssets(sa);
        uint256 b1 = fund.convertToAssets(sb);
        assertApproxEqAbs(a1 - a0, gift.mulDiv(sa, supply), 2, "alice gets her share of the gift");
        assertApproxEqAbs(b1 - b0, gift.mulDiv(sb, supply), 2, "bob gets his share of the gift");
        assertApproxEqAbs(
            fund.convertToAssets(seedShares) - s0,
            gift.mulDiv(seedShares, supply),
            2,
            "the seed's shares get theirs"
        );
    }

    /// @dev Classic first-depositor attack: mint a small position, donate to inflate the price, let the victim's
    ///      deposit round down. With the seed (E14) the fund is never empty, the 18-decimal offset still applies,
    ///      and the victim buys at the price of the settlement (its bound, E12), so the victim's loss is negligible
    ///      and the attack is a loss.
    function test_INV2_firstDepositorInflationDoesNotPay() public fixtureCovered {
        uint256 attackerSpend = 100e6; // minRequestUsdc
        deposit(bob, attackerSpend);
        uint256 donation = 10_000e6;
        fundUsdc(address(fund), donation);
        attackerSpend += donation;
        (uint256 bobCredit,) = queue.creditOf(bob);
        attackerSpend -= bobCredit;

        uint256 victimIn = 10_000e6;
        deposit(alice, victimIn);
        (uint256 aliceCredit,) = queue.creditOf(alice);
        uint256 victimClaim = fund.convertToAssets(fund.balanceOf(alice)) + aliceCredit;
        assertGe(victimClaim, victimIn - victimIn / 10_000, "victim loses at most 1 bp");

        uint256 attackerClaim = fund.convertToAssets(fund.balanceOf(bob));
        assertLt(attackerClaim, attackerSpend, "attack does not pay");
    }
}
