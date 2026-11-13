// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.5 (asset list), §5.1 (receipt to plan), §5.3 (step),
//            §5.9 (timed flows), §5.9.5 (defaults), §7 RB-1, RB-8; docs/technical/one-vault-timed-flows-eng-plan.md E1,
//            E14 to E16, E19; scaffold plan §7.5 items 2 and 3
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PrototypeHarness} from "./PrototypeHarness.sol";
import {AssetConfig, AssetKind, FeedStatus, PlanStatus, Roles, BPS} from "./src/FundTypes.sol";
import {FlowParams} from "./src/FlowTypes.sol";
import {RobotMoneyFund} from "./src/RobotMoneyFund.sol";
import {IRobotMoneyFund} from "./src/interfaces/IRobotMoneyFund.sol";
import {ILendingRateAdapter} from "./src/interfaces/IFlowAdapters.sol";

/// @notice One-vault experiment (plan Step 2.1, step 3d wiring): proves `PrototypeHarness` deploys the full prototype
///         on the Base fixture and that its helpers work. Not a behaviour suite.
contract HarnessSmokeTest is PrototypeHarness {
    address internal alice = makeAddr("alice");

    function setUp() public override {
        super.setUp();
    }

    /// @dev Wiring (RB-1, RB-8, E1), the asset list and feeds (E15, E16), the seed (E14), then one deposit through
    ///      the queue with no plan: the seed is idle, so the pro-rata deposit stays idle and NAV is seed + cost.
    function test_deployAndDeposit() public fixtureCovered {
        RobotMoneyFund f = RobotMoneyFund(address(fund));
        assertTrue(f.hasRole(Roles.ADMIN_ROLE, address(timelock)), "fund admin = timelock");
        assertFalse(f.hasRole(Roles.ADMIN_ROLE, address(this)), "deployer renounced fund admin");
        assertTrue(f.hasRole(Roles.GOVERNANCE_ROLE, address(governance)), "governance role");
        assertTrue(f.hasRole(Roles.REBALANCER_ROLE, address(rebalancer)), "rebalancer role");
        assertTrue(f.hasRole(Roles.FLOW_ROLE, address(queue)), "FLOW_ROLE bound to the queue (E1)");
        assertEq(fund.flowQueue(), address(queue), "flowQueue");
        assertTrue(rebalancer.hasRole(Roles.KEEPER_ROLE, keeper), "keeper role");
        assertTrue(rebalancer.hasRole(Roles.ADMIN_ROLE, address(timelock)), "rebalancer admin");
        assertTrue(governance.hasRole(Roles.TARGET_SETTER_ROLE, address(timelock)), "target setter");
        assertFalse(governance.hasRole(Roles.TARGET_SETTER_ROLE, address(this)), "deployer renounced setter");
        assertTrue(receipts.hasRole(receipts.RECEIPT_RELEASER_ROLE(), address(governance)), "releaser");
        assertFalse(receipts.hasRole(receipts.ADMIN_ROLE(), address(governance)), "governance not receipt admin");
        assertTrue(queue.hasRole(Roles.ADMIN_ROLE, address(timelock)), "queue admin = timelock");
        assertFalse(queue.hasRole(Roles.ADMIN_ROLE, address(this)), "deployer renounced queue admin");
        assertTrue(queue.hasRole(Roles.KEEPER_ROLE, keeper), "queue keeper");
        assertTrue(queue.hasRole(Roles.EMERGENCY_ROLE, emergency), "queue emergency");
        assertEq(queue.share(), address(fund), "ERC-7575 share");
        assertEq(queue.asset(), USDC, "ERC-7575 asset");

        // §4.5: three lending venues (Compound only when the fixture holds Comet's extension), wETH, cbBTC.
        assertEq(fund.assetCount(), listedAssets(), "listed assets");
        for (uint256 i; i < fund.assetCount(); ++i) {
            AssetConfig memory a = fund.assetConfig(i);
            assertTrue(a.active, "active");
            if (isBasketIndex(i)) {
                assertEq(uint8(a.kind), uint8(AssetKind.Basket), "basket kind");
                assertTrue(a.feed != address(0) && a.maxFeedAge != 0, "basket feed and max age (E15)");
                assertEq(a.adapter, address(swapAdapter), "exact-output adapter copy");
            } else {
                assertEq(uint8(a.kind), uint8(AssetKind.Lending), "lending kind");
                assertEq(a.feed, address(0), "lending: no feed");
                assertGt(ILendingRateAdapter(a.adapter).ratePerUnit(), 1e18, "venue rate per unit (E15)");
            }
        }
        (address usdcFeed, uint32 usdcAge, address seqFeed) = queue.feeds();
        assertEq(usdcFeed, FEED_USDC, "USDC feed");
        assertEq(usdcAge, DAY_FEED_MAX_AGE, "USDC feed age");
        assertEq(seqFeed, FEED_SEQUENCER, "sequencer feed");
        FlowParams memory p = queue.flowParams();
        assertEq(p.epochLength, 6 hours, "epochLength default");
        assertEq(p.minHold, 24 hours, "minHold default");
        assertEq(p.legBandBps, 100, "legBandBps default");

        // E14: the seed, at the share scale, held by the fund itself.
        assertEq(fund.totalSupply(), SEED_USDC * 1e18, "seed supply");
        assertEq(fund.balanceOf(address(fund)), SEED_USDC * 1e18, "seed shares are the fund's");
        assertEq(fund.totalAssets(), SEED_USDC, "NAV = seed");

        uint256 amount = 100_000e6;
        uint256 shares = deposit(alice, amount);
        assertGt(shares, 0, "shares delivered");
        uint256 nav = fund.totalAssets();
        assertLe(nav, SEED_USDC + amount, "no plan: NAV <= seed + deposit");
        assertGe(nav, SEED_USDC + amount - amount / 1_000, "no plan: the cost is only rounding");
        assertEq(fund.idleUsdc(), nav, "idle: everything stayed idle");
        (uint256 credit,) = queue.creditOf(alice);
        assertEq(SEED_USDC + amount - nav, credit, "the unused USDC is alice's credit");
        assertApproxEqAbs(fund.convertToAssets(shares), nav - SEED_USDC, 2, "alice owns what she added");
    }

    /// @dev Receipt to plan through the timelock, three keeper steps on the seed, a pro-rata deposit through the
    ///      queue, then the price helper.
    function test_receiptPlanDepositStep() public fixtureCovered {
        uint16[5] memory target = bucketVec(6_000, 4_000);
        uint256 planId = recordAndApply(target);
        assertEq(planId, 1, "first plan");
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Open), "open");
        (uint256 executed, uint256 calls,) = stepUntilDone(3);
        assertEq(calls, 3, "three calls while open");
        assertGt(executed, 0, "the seed is being invested");
        refreshFeeds();

        uint256 amount = 100_000e6;
        uint256 navBefore = fund.totalAssets();
        (uint256[4] memory sw0,) = bucketWeightsBps();
        deposit(alice, amount);
        uint256 nav = fund.totalAssets();
        // The pro-rata purchase (E3): NAV grows by at most the deposit and at least the deposit less its costs.
        assertLe(nav, navBefore + amount, "nav <= deposit");
        assertGe(nav, navBefore + amount * (BPS - 100) / BPS, "nav >= deposit less 1 %");

        (uint256[4] memory sw, uint256 idleBps) = bucketWeightsBps();
        assertEq(sw[0], 0, "agent bucket empty");
        assertEq(sw[3], 0, "real-world bucket empty (section 4.5)");
        assertLe(sw[0] + sw[1] + sw[2] + sw[3] + idleBps, BPS, "weights <= 100%");
        for (uint256 s = 1; s < 3; ++s) {
            assertApproxEqAbs(sw[s], sw0[s], 5, "a pro-rata deposit keeps the mix");
        }
        assertGt(sw[1] + sw[2], 0, "the fund holds assets");
        (uint256[] memory aw,) = assetWeightsBps();
        assertEq(aw.length, listedAssets(), "asset weights aligned");

        uint256 got = movePrice(WETH_POOL, 1_000e6, true);
        assertGt(got, 0, "movePrice buy");
        got = movePrice(WETH_POOL, 1_000e6, false);
        assertGt(got, 900e6, "movePrice sell");
        assertLt(got, 1_000e6, "sell at a loss after fees");
    }

    /// @dev E19 and the feed helpers: after a warp past the ETH feed's maximum age the fund's NAV views revert and
    ///      `lastGoodNav` still answers; `refreshFeeds` makes them read again; `setFeedPrice` moves one feed.
    function test_feedHelpers() public fixtureCovered {
        uint256 nav = fund.totalAssets();
        vm.warp(block.timestamp + ETH_FEED_MAX_AGE + 1);
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.FeedUnhealthy.selector, IDX_WETH, FeedStatus.Stale));
        fund.totalAssets();
        (uint256 good,) = fund.lastGoodNav();
        assertEq(good, nav, "lastGoodNav keeps the last healthy value");
        refreshFeeds();
        assertEq(fund.totalAssets(), nav, "fresh feeds: NAV reads again");

        uint256 px = poolPrice8(WETH_POOL, WETH);
        assertGt(px, 0, "pool price");
        assertEq(uint256(feedPrice8[FEED_ETH]), px, "the ETH feed starts at the pool's price");
        setFeedPrice(IDX_WETH, px * 2);
        assertEq(uint256(feedPrice8[FEED_ETH]), px * 2, "setFeedPrice stores");
        refreshFeeds();
        assertEq(uint256(feedPrice8[FEED_ETH]), px * 2, "refreshFeeds keeps the stored price");
    }

    /// @dev Compound V3 is listed only when the fixture holds Comet's extension delegate (see the harness note).
    function test_compoundListedWhenTheFixtureCoversIt() public fixtureCovered {
        if (!cometListed) {
            _skipCovered("Compound V3 not listed: the replay fixture lacks Comet's extension delegate (re-record)");
        }
        assertEq(fund.assetConfig(IDX_COMET).adapter, address(cometAdapter), "Compound is the last asset");
        assertGt(ILendingRateAdapter(address(cometAdapter)).ratePerUnit(), 1e18, "Comet supply index");
    }
}
