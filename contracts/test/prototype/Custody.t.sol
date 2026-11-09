// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md §12 INV-2, INV-3; docs/technical/one-vault-rebalancer-proposal.md §7
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PrototypeHarness} from "./PrototypeHarness.sol";
import {RobotMoneyFund} from "./src/RobotMoneyFund.sol";

/// @notice One-vault experiment (plan Step 2, G3): the two custody invariants the other suites leave open.
///         INV-3: fee recipient, fee parameters and quarantine change only through the timelock.
///         INV-2: donations accrue pro rata to holders, and share inflation by a first depositor does not pay.
contract CustodyTest is PrototypeHarness {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    function _expectAllRefused(bytes memory data) internal {
        address[5] memory callers = [stranger, emergency, keeper, address(governance), address(rebalancer)];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            (bool ok,) = address(fund).call(data);
            assertFalse(ok, "non-timelock caller changed a governed parameter");
        }
    }

    function test_INV3_feeAndQuarantineOnlyViaTimelock() public fixtureCovered {
        address quarantine = fund.quarantineAddress();
        (,, uint256 feeBps0, address recipient0) = fund.config();

        _expectAllRefused(abi.encodeCall(RobotMoneyFund.setFeeRecipient, (stranger)));
        _expectAllRefused(abi.encodeCall(RobotMoneyFund.setExitFeeBps, (100)));
        _expectAllRefused(abi.encodeCall(RobotMoneyFund.setExitFeeBps, (0)));
        _expectAllRefused(abi.encodeWithSignature("upgradeToAndCall(address,bytes)", stranger, bytes("")));

        (,, uint256 feeBps1, address recipient1) = fund.config();
        assertEq(feeBps1, feeBps0, "fee bps unchanged");
        assertEq(recipient1, recipient0, "fee recipient unchanged");

        // The timelock path does take effect.
        address newRecipient = makeAddr("newFeeRecipient");
        timelockExecute(address(fund), abi.encodeCall(RobotMoneyFund.setFeeRecipient, (newRecipient)));
        timelockExecute(address(fund), abi.encodeCall(RobotMoneyFund.setExitFeeBps, (20)));
        (,, uint256 feeBps2, address recipient2) = fund.config();
        assertEq(feeBps2, 20, "timelock set fee bps");
        assertEq(recipient2, newRecipient, "timelock set fee recipient");

        // The quarantine is a fixed constant: no setter exists, so no path changes it.
        assertEq(fund.quarantineAddress(), quarantine, "quarantine fixed");
        assertTrue(quarantine != address(0), "quarantine set");
    }

    /// @dev A USDC donation raises every holder's claim pro rata. The donor gets nothing back.
    function test_INV2_donationAccruesProRata() public fixtureCovered {
        deposit(alice, 30_000e6);
        deposit(bob, 10_000e6);
        uint256 a0 = fund.convertToAssets(fund.balanceOf(alice));
        uint256 b0 = fund.convertToAssets(fund.balanceOf(bob));
        uint256 nav0 = fund.totalAssets();

        uint256 gift = 4_000e6;
        fundUsdc(address(fund), gift);

        assertEq(fund.totalAssets(), nav0 + gift, "donation counted in NAV");
        uint256 a1 = fund.convertToAssets(fund.balanceOf(alice));
        uint256 b1 = fund.convertToAssets(fund.balanceOf(bob));
        assertApproxEqAbs(a1 - a0, 3_000e6, 2, "alice gets 3/4 of the gift");
        assertApproxEqAbs(b1 - b0, 1_000e6, 2, "bob gets 1/4 of the gift");
    }

    /// @dev Classic first-depositor attack: mint a dust share, donate to inflate the price, let the victim's
    ///      deposit round down. The 18-decimal offset makes the victim's loss negligible and the attack a loss.
    function test_INV2_firstDepositorInflationDoesNotPay() public fixtureCovered {
        uint256 attackerSpend = 1;
        deposit(bob, attackerSpend);
        uint256 donation = 10_000e6;
        fundUsdc(address(fund), donation);
        attackerSpend += donation;

        uint256 victimIn = 10_000e6;
        deposit(alice, victimIn);
        uint256 victimClaim = fund.convertToAssets(fund.balanceOf(alice));
        assertGe(victimClaim, victimIn - victimIn / 10_000, "victim loses at most 1 bp");

        uint256 attackerClaim = fund.convertToAssets(fund.balanceOf(bob));
        assertLt(attackerClaim, attackerSpend, "attack does not pay");
    }
}
