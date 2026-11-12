// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.3 (deposit), §5.1 (receipt to plan), §5.3 (step),
//            §7 RB-1, RB-8
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
// FROZEN BASELINE (one-vault scaffold, 2026-11-11): a copy of the step 3c synchronous fund and its tests. Never edit.
// It is the sim's synchronous arm and the target of the baseline attack tests. The live tree is contracts/test/prototype/src.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaselineHarness} from "./BaselineHarness.sol";
import {Plan, PlanStatus, Roles, BPS} from "./src/FundTypes.sol";
import {RobotMoneyFund} from "./src/RobotMoneyFund.sol";

/// @notice One-vault experiment (plan Step 2.1): proves `BaselineHarness` deploys the full prototype on the
///         Base fixture and that its helpers work. Not a behaviour suite.
contract HarnessSmokeTest is BaselineHarness {
    address internal alice = makeAddr("alice");

    function setUp() public override {
        super.setUp();
    }

    /// @dev Wiring (RB-1, RB-8) plus one deposit with no plan: everything stays idle, so NAV is the deposit.
    function test_deployAndDeposit() public fixtureCovered {
        RobotMoneyFund f = RobotMoneyFund(address(fund));
        assertTrue(f.hasRole(Roles.ADMIN_ROLE, address(timelock)), "fund admin = timelock");
        assertFalse(f.hasRole(Roles.ADMIN_ROLE, address(this)), "deployer renounced fund admin");
        assertTrue(f.hasRole(Roles.GOVERNANCE_ROLE, address(governance)), "governance role");
        assertTrue(f.hasRole(Roles.REBALANCER_ROLE, address(rebalancer)), "rebalancer role");
        assertTrue(rebalancer.hasRole(Roles.KEEPER_ROLE, keeper), "keeper role");
        assertTrue(rebalancer.hasRole(Roles.ADMIN_ROLE, address(timelock)), "rebalancer admin");
        assertTrue(governance.hasRole(Roles.TARGET_SETTER_ROLE, address(timelock)), "target setter");
        assertFalse(governance.hasRole(Roles.TARGET_SETTER_ROLE, address(this)), "deployer renounced setter");
        assertTrue(receipts.hasRole(receipts.RECEIPT_RELEASER_ROLE(), address(governance)), "releaser");
        assertFalse(receipts.hasRole(receipts.ADMIN_ROLE(), address(governance)), "governance not receipt admin");
        assertEq(fund.assetCount(), N_ASSETS, "six assets");

        uint256 amount = 100_000e6;
        uint256 shares = deposit(alice, amount);
        assertGt(shares, 0, "shares minted");
        assertEq(fund.totalAssets(), amount, "no plan: all idle, NAV == deposit");
        assertEq(fund.idleUsdc(), amount, "idle");
        assertApproxEqAbs(fund.convertToAssets(fund.balanceOf(alice)), amount, 1, "alice owns the NAV");
    }

    /// @dev Receipt to plan through the timelock, a routed deposit, then a few keeper steps.
    function test_receiptPlanDepositStep() public fixtureCovered {
        uint16[6] memory target = bucketVec(6_000, 3_000, 1_000);
        uint256[4] memory tb = bucketsOf(target);
        uint256 planId = recordAndApply(target);
        assertEq(planId, 1, "first plan");
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Open), "open");

        uint256 amount = 100_000e6;
        uint256 navBefore = fund.totalAssets();
        deposit(alice, amount);
        uint256 nav = fund.totalAssets();
        // Realized-delta mint: NAV grows by at most the deposit and at least the slippage floor (§4.3).
        assertLe(nav, navBefore + amount, "nav <= deposit");
        assertGe(nav, navBefore + amount * (BPS - MAX_SLIPPAGE_BPS) / BPS, "nav >= floor");

        (uint256[4] memory sw, uint256 idleBps) = bucketWeightsBps();
        assertEq(sw[0], 0, "agent bucket empty");
        assertGt(sw[1], 0, "stable deployed");
        assertGt(sw[2], 0, "protocol bought");
        assertLe(sw[0] + sw[1] + sw[2] + sw[3] + idleBps, BPS, "weights <= 100%");
        // Deficit-first routing into a plan whose start equals its end (NAV 0 at open) lands near the target.
        for (uint256 s = 1; s < 4; ++s) {
            assertApproxEqAbs(sw[s], tb[s], 100, "bucket near target after routed deposit");
        }
        (uint256[] memory aw,) = assetWeightsBps();
        assertEq(aw.length, N_ASSETS, "asset weights aligned");

        (uint256 executed, uint256 calls,) = stepUntilDone(3);
        assertEq(calls, 3, "three calls while open");
        assertLe(executed, calls, "executed <= calls");
        assertLe(fund.totalAssets(), nav + nav / 100, "no value created from nothing");

        uint256 got = movePrice(WETH_POOL, 1_000e6, true);
        assertGt(got, 0, "movePrice buy");
        got = movePrice(WETH_POOL, 1_000e6, false);
        assertGt(got, 900e6, "movePrice sell");
        assertLt(got, 1_000e6, "sell at a loss after fees");
    }
}
