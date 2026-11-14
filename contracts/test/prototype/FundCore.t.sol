// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.3, §4.4, §5.9.3 checks 7 to 10, §5.9.4, §7 RB-13,
//            RB-22; docs/technical/one-vault-timed-flows-eng-plan.md E2, E3, E4, E13, E14
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
//
// fund-core's own unit test (scaffold plan §7.2 "done when"): `seed`, `mintInKind` and `sellForFlow` against the
// real Base pools and lending venues of the recorded fixture, in replay mode. This test contract plays the queue: the
// harness does not bind its own FlowQueue or seed here (`_bindQueueAtSetUp`, `_seedUsdc`); the test holds FLOW_ROLE
// (bound once through the timelock) and answers `queuedSharesOf`, `feeds` and `flowParams` as the bound queue must.
// The harness's basket assets already use the exact-output adapter copy. Ported to the step 3d harness (five assets,
// feeds) by `integrate`; the Compound exclusion of the ledger test now excludes Moonwell, which replay always lists.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PrototypeHarness} from "./PrototypeHarness.sol";
import {FlowParams} from "./src/FlowTypes.sol";
import {IRobotMoneyFund} from "./src/interfaces/IRobotMoneyFund.sol";
import {FundExclusionLedger} from "./src/FundExclusionLedger.sol";
import {AssetKind, PlanParams, Roles, BPS, LENDING_ROUNDING_UNITS} from "./src/FundTypes.sol";

contract FundCoreTest is PrototypeHarness {
    using Math for uint256;

    /// @dev Per-leg purchase limit and sale floor the test passes, around the pool's TWAP. The queue derives the
    ///      real ones from the feeds and `legBandBps` (E12); the fund only enforces whatever it is given.
    uint256 internal constant LEG_BAND_BPS = 300;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    /// @dev This contract plays the FlowQueue: its answer to the fund's `ledgerBalanceOf` read.
    mapping(address => uint256) internal queued;

    function queuedSharesOf(address account) external view returns (uint256) {
        return queued[account];
    }

    /// @dev As the bound queue: the fund's NAV views read the USDC and sequencer feeds from here (E19).
    function feeds() external pure returns (address, uint32, address) {
        return (FEED_USDC, DAY_FEED_MAX_AGE, FEED_SEQUENCER);
    }

    /// @dev As the bound queue: the fund reads `settleWindow` and the peg band from here.
    function flowParams() external pure returns (FlowParams memory) {
        return defaultFlowParams();
    }

    /// @dev This test binds FLOW_ROLE to itself, so the harness must not bind its queue.
    function _bindQueueAtSetUp() internal pure override returns (bool) {
        return false;
    }

    /// @dev The seed is under test here: the harness does not seed.
    function _seedUsdc() internal pure override returns (uint256) {
        return 0;
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Setup helpers
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Seed through the timelock (the fund's ADMIN_ROLE), the only path E14 allows.
    function _seed(uint256 usdc) internal {
        fundUsdc(address(timelock), usdc);
        address[] memory targets = new address[](2);
        uint256[] memory values = new uint256[](2);
        bytes[] memory payloads = new bytes[](2);
        targets[0] = USDC;
        targets[1] = address(fund);
        payloads[0] = abi.encodeCall(IERC20.approve, (address(fund), usdc));
        payloads[1] = abi.encodeCall(IRobotMoneyFund.seed, (usdc));
        timelockExecuteBatch(targets, values, payloads);
    }

    /// @dev Bind FLOW_ROLE to this contract (the queue stand-in), once, through the timelock.
    function _bindFlowToThis() internal {
        timelockExecute(
            address(fund), abi.encodeCall(IRobotMoneyFund.bindFlowRole, (address(this)))
        );
    }

    /// @dev Seed, then let the real Rebalancer move the seed into every listed asset, so the fund holds idle USDC,
    ///      the lending positions and two basket tokens before a flow. Asserts it does.
    ///      Step 3e: a step reads the sequencer feed, the USDC feed and `refBandBps` from the bound queue, and with no
    ///      queue bound it fails closed (`StepFeedCheck.NoQueue`). So FLOW_ROLE is bound to this stand-in (which
    ///      answers `feeds()` and `flowParams()`) before the plan steps, not after.
    function _seedAndInvest() internal {
        _seed(SEED_USDC);
        _bindFlowToThis();
        uint16[5] memory v = cometListed
            ? assetVec(2_500, 2_000, 1_750, 1_750, 2_000)
            : assetVec(3_500, 3_000, 1_750, 1_750, 0);
        setTargetViaTimelock(v, PlanParams(1 days, COST_BUDGET_BPS));
        stepUntilDone(80);
        (, uint256[] memory held) = fund.heldBalances();
        assertEq(held.length, listedAssets(), "held per listed asset");
        for (uint256 i; i < held.length; ++i) {
            assertGt(held[i], 0, "rebalancer invested every non-zero target");
        }
        refreshFeeds();
    }

    /// @dev Per-leg purchase limits for `sharesOut`: TWAP value of each basket asset's exact part, plus the band.
    function _buyLimits(uint256 sharesOut)
        internal
        view
        returns (uint256[] memory limits, uint256 maxUsdc)
    {
        (uint256 idle, uint256[] memory held) = fund.heldBalances();
        uint256 supply = fund.totalSupply();
        limits = new uint256[](held.length);
        maxUsdc = idle.mulDiv(sharesOut, supply, Math.Rounding.Ceil);
        for (uint256 i; i < held.length; ++i) {
            uint256 want = held[i].mulDiv(sharesOut, supply, Math.Rounding.Ceil);
            if (want == 0) continue;
            if (fund.assetConfig(i).kind == AssetKind.Lending) {
                maxUsdc += want + LENDING_ROUNDING_UNITS;
            } else {
                limits[i] = fund.assetUsdcValue(i, want).mulDiv(BPS + LEG_BAND_BPS, BPS) + 1;
                maxUsdc += limits[i];
            }
        }
    }

    /// @dev Per-leg sale floors for `shares`: TWAP value of each basket asset's exact part, less the band.
    function _sellFloors(uint256 shares) internal view returns (uint256[] memory floors) {
        (, uint256[] memory held) = fund.heldBalances();
        uint256 supply = fund.totalSupply();
        floors = new uint256[](held.length);
        for (uint256 i; i < held.length; ++i) {
            if (fund.assetConfig(i).kind != AssetKind.Basket) continue;
            uint256 amt = held[i].mulDiv(shares, supply);
            if (amt != 0) floors[i] = fund.assetUsdcValue(i, amt).mulDiv(BPS - LEG_BAND_BPS, BPS);
        }
    }

    /// @dev Check 10 restated from outside: every held amount per share is at least what it was.
    function _assertPerShareNotLower(
        uint256 idle0,
        uint256[] memory held0,
        uint256 supply0,
        string memory label
    ) internal view {
        (uint256 idle1, uint256[] memory held1) = fund.heldBalances();
        uint256 supply1 = fund.totalSupply();
        assertGe(idle1 * supply0, idle0 * supply1, string.concat(label, ": idle per share"));
        for (uint256 i; i < held0.length; ++i) {
            assertGe(
                held1[i] * supply0, held0[i] * supply1, string.concat(label, ": asset per share")
            );
        }
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  E14: seed
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_seed_mintsAtTheShareScaleToTheFundOnce() public fixtureCovered {
        assertEq(fund.totalSupply(), 0, "empty");
        _seed(SEED_USDC);
        uint256 shares = SEED_USDC * 1e18;
        assertEq(fund.totalSupply(), shares, "supply = usdc x 10^18");
        assertEq(fund.balanceOf(address(fund)), shares, "seed shares belong to the fund itself");
        assertEq(fund.idleUsdc(), SEED_USDC, "seed stays idle");
        assertEq(fund.totalAssets(), SEED_USDC, "NAV = seed");

        vm.prank(address(timelock));
        vm.expectRevert(IRobotMoneyFund.AlreadySeeded.selector);
        fund.seed(SEED_USDC);
    }

    function test_seed_refusesBelowMinimumAndNonAdmin() public fixtureCovered {
        uint256 minSeed = fund.minSeedUsdc();
        fundUsdc(address(timelock), minSeed);
        vm.prank(address(timelock));
        IERC20(USDC).approve(address(fund), minSeed);
        vm.prank(address(timelock));
        vm.expectRevert(
            abi.encodeWithSelector(IRobotMoneyFund.SeedBelowMinimum.selector, minSeed - 1, minSeed)
        );
        fund.seed(minSeed - 1);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, Roles.ADMIN_ROLE
            )
        );
        fund.seed(minSeed);
    }

    function test_seedShares_neverMove() public fixtureCovered {
        _seed(SEED_USDC);
        vm.prank(address(fund));
        vm.expectRevert(IRobotMoneyFund.SeedSharesLocked.selector);
        fund.transfer(alice, 1);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  E2: the fund's own entry points name the queue
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_fundEntryPoints_revertAndNameTheQueue() public fixtureCovered {
        _seed(SEED_USDC);
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.UseFlowQueue.selector, address(0)));
        fund.deposit(1e6, alice);
        _bindFlowToThis();
        bytes memory named =
            abi.encodeWithSelector(IRobotMoneyFund.UseFlowQueue.selector, address(this));
        vm.expectRevert(named);
        fund.deposit(1e6, alice);
        vm.expectRevert(named);
        fund.mint(1e24, alice);
        vm.expectRevert(named);
        fund.redeem(1, alice, alice);
        vm.expectRevert(named);
        fund.previewDeposit(1e6);
        vm.expectRevert(named);
        fund.previewMint(1e24);
        vm.expectRevert(named);
        fund.previewRedeem(1);
        vm.expectRevert(IRobotMoneyFund.RedeemOnly.selector);
        fund.withdraw(1, alice, alice);
        assertEq(fund.maxDeposit(alice), 0, "maxDeposit 0");
        assertEq(fund.maxMint(alice), 0, "maxMint 0");
        assertEq(fund.maxRedeem(alice), 0, "maxRedeem 0");
        assertEq(fund.flowQueue(), address(this), "bound queue");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  E3 / E4 / check 10 on real pools
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_mintInKind_buysTheSliceOnRealPoolsAndMints() public fixtureCovered {
        _seedAndInvest();
        (uint256 idle0, uint256[] memory held0) = fund.heldBalances();
        uint256 supply0 = fund.totalSupply();
        uint256 sharesOut = supply0 / 50; // 2 %
        (uint256[] memory limits, uint256 maxUsdc) = _buyLimits(sharesOut);
        fundUsdc(address(this), maxUsdc);
        IERC20(USDC).approve(address(fund), maxUsdc);
        uint256 balBefore = IERC20(USDC).balanceOf(address(this));

        uint256 spent = fund.mintInKind(sharesOut, maxUsdc, limits);

        assertEq(
            balBefore - IERC20(USDC).balanceOf(address(this)),
            spent,
            "caller USDC fell by exactly spent"
        );
        assertLe(spent, maxUsdc, "spent <= maxUsdc");
        assertGt(spent, 0, "spent something");
        assertEq(fund.balanceOf(address(this)), sharesOut, "minted exactly sharesOut to the caller");
        assertEq(fund.totalSupply(), supply0 + sharesOut, "supply grew by sharesOut");
        assertEq(
            IERC20(USDC).allowance(address(fund), fund.assetConfig(IDX_WETH).adapter),
            0,
            "approval cleared"
        );
        _assertPerShareNotLower(idle0, held0, supply0, "mintInKind");
        // Each basket asset grew by at least its exact pro-rata part.
        (, uint256[] memory held1) = fund.heldBalances();
        for (uint256 i = IDX_WETH; i <= IDX_CBBTC; ++i) {
            assertGe(
                held1[i] - held0[i],
                held0[i].mulDiv(sharesOut, supply0, Math.Rounding.Ceil),
                "bought >= want"
            );
        }
    }

    function test_sellForFlow_sellsTheSliceOnRealPoolsAndPays() public fixtureCovered {
        _seedAndInvest();
        uint256 sharesOut = fund.totalSupply() / 50;
        (uint256[] memory limits, uint256 maxUsdc) = _buyLimits(sharesOut);
        fundUsdc(address(this), maxUsdc);
        IERC20(USDC).approve(address(fund), maxUsdc);
        uint256 spent = fund.mintInKind(sharesOut, maxUsdc, limits);

        (uint256 idle0, uint256[] memory held0) = fund.heldBalances();
        uint256 supply0 = fund.totalSupply();
        uint256[] memory floors = _sellFloors(sharesOut);
        uint256 balBefore = IERC20(USDC).balanceOf(address(this));
        uint256 feeBefore = IERC20(USDC).balanceOf(feeRecipient);

        uint256 net = fund.sellForFlow(sharesOut, floors);

        assertEq(
            IERC20(USDC).balanceOf(address(this)) - balBefore, net, "paid exactly net to the caller"
        );
        uint256 fee = IERC20(USDC).balanceOf(feeRecipient) - feeBefore;
        assertEq(
            fee, (net + fee).mulDiv(EXIT_FEE_BPS, BPS), "fee = exitFeeBps of the realized gross"
        );
        assertEq(fund.balanceOf(address(this)), 0, "shares burned");
        assertEq(fund.totalSupply(), supply0 - sharesOut, "supply fell by shares");
        _assertPerShareNotLower(idle0, held0, supply0, "sellForFlow");
        // A round trip through two pools and two fees costs the flow user, never the holders.
        assertLt(net, spent, "round trip pays its own costs");
        assertGt(net, spent.mulDiv(BPS - 2 * LEG_BAND_BPS, BPS), "round trip cost inside two bands");
    }

    function test_mintInKind_failedLegLimitRevertsAndChangesNothing() public fixtureCovered {
        _seedAndInvest();
        uint256 sharesOut = fund.totalSupply() / 50;
        (uint256[] memory limits, uint256 maxUsdc) = _buyLimits(sharesOut);
        limits[IDX_WETH] = limits[IDX_WETH] / 2; // the venue needs more than this: check 9 fails
        fundUsdc(address(this), maxUsdc);
        IERC20(USDC).approve(address(fund), maxUsdc);
        (uint256 idle0, uint256[] memory held0) = fund.heldBalances();
        uint256 supply0 = fund.totalSupply();
        uint256 balBefore = IERC20(USDC).balanceOf(address(this));

        vm.expectRevert();
        fund.mintInKind(sharesOut, maxUsdc, limits);

        (uint256 idle1, uint256[] memory held1) = fund.heldBalances();
        assertEq(idle1, idle0, "idle unchanged");
        assertEq(fund.totalSupply(), supply0, "supply unchanged");
        for (uint256 i; i < held0.length; ++i) {
            assertEq(held1[i], held0[i], "held unchanged");
        }
        assertEq(IERC20(USDC).balanceOf(address(this)), balBefore, "caller kept its USDC");
    }

    function test_mintInKind_overMaxUsdcReverts() public fixtureCovered {
        _seedAndInvest();
        uint256 sharesOut = fund.totalSupply() / 50;
        (uint256[] memory limits,) = _buyLimits(sharesOut);
        (uint256 idle,) = fund.heldBalances();
        uint256 idlePart = idle.mulDiv(sharesOut, fund.totalSupply(), Math.Rounding.Ceil);
        // Enough for the idle part only: the lending supplies take the fund past `maxUsdc`.
        fundUsdc(address(this), idlePart);
        IERC20(USDC).approve(address(fund), idlePart);
        vm.expectRevert();
        fund.mintInKind(sharesOut, idlePart, limits);
    }

    function test_flowFunctions_onlyFlowRoleAndLegLength() public fixtureCovered {
        _seedAndInvest();
        uint256[] memory limits = new uint256[](fund.assetCount());
        bytes memory denied = abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, alice, Roles.FLOW_ROLE
        );
        vm.startPrank(alice);
        vm.expectRevert(denied);
        fund.mintInKind(1, 1, limits);
        vm.expectRevert(denied);
        fund.sellForFlow(1, limits);
        vm.expectRevert(denied);
        fund.ledgerCheckpoint(alice);
        vm.stopPrank();

        uint256[] memory short = new uint256[](fund.assetCount() - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRobotMoneyFund.LegLimitsLength.selector, fund.assetCount() - 1, fund.assetCount()
            )
        );
        fund.mintInKind(1, 0, short);
    }

    function test_mintInKind_refusesWhileDepositsPaused() public fixtureCovered {
        _seedAndInvest();
        vm.prank(emergency);
        fund.pauseDeposits();
        uint256[] memory limits = new uint256[](fund.assetCount());
        vm.expectRevert(IRobotMoneyFund.DepositsArePaused.selector);
        fund.mintInKind(1, 0, limits);
    }

    /// @dev RB-13 on the holder's own exit: the in-kind exit asserts check 10 too, with the lending legs two units
    ///      short of exact.
    function test_redeemInKind_keepsEveryAmountPerShare() public fixtureCovered {
        _seedAndInvest();
        uint256 sharesOut = fund.totalSupply() / 50;
        (uint256[] memory limits, uint256 maxUsdc) = _buyLimits(sharesOut);
        fundUsdc(address(this), maxUsdc);
        IERC20(USDC).approve(address(fund), maxUsdc);
        fund.mintInKind(sharesOut, maxUsdc, limits);
        fund.transfer(alice, sharesOut);

        (uint256 idle0, uint256[] memory held0) = fund.heldBalances();
        uint256 supply0 = fund.totalSupply();
        vm.prank(alice);
        fund.redeemInKind(sharesOut, alice, alice);

        _assertPerShareNotLower(idle0, held0, supply0, "redeemInKind");
        assertGt(IERC20(WETH).balanceOf(alice), 0, "wETH in kind");
        assertGt(IERC20(CBBTC).balanceOf(alice), 0, "cbBTC in kind");
        assertGt(IERC20(USDC).balanceOf(alice), 0, "idle and lending USDC");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  E13 / RB-22: the ledger counts queued shares for their owner
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_ledger_isTheFundCopyAndCountsQueuedShares() public fixtureCovered {
        _seedAndInvest();
        FundExclusionLedger ledger = FundExclusionLedger(fund.exclusionLedger());
        assertEq(ledger.VAULT(), address(fund), "ledger bound to the fund");

        uint256 sharesOut = fund.totalSupply() / 50;
        (uint256[] memory limits, uint256 maxUsdc) = _buyLimits(sharesOut);
        fundUsdc(address(this), maxUsdc);
        IERC20(USDC).approve(address(fund), maxUsdc);
        fund.mintInKind(sharesOut, maxUsdc, limits);
        uint256 half = sharesOut / 2;
        fund.transfer(alice, half);
        fund.ledgerCheckpoint(alice); // before the queue's books change (no record yet: a no-op)
        queued[alice] = sharesOut - half; // the queue (this contract) holds the rest for alice

        assertEq(fund.ledgerBalanceOf(alice), sharesOut, "wallet plus queued");
        assertEq(fund.ledgerBalanceOf(address(this)), 0, "the queue itself has no entitlement");
        assertEq(fund.ledgerBalanceOf(address(fund)), SEED_USDC * 1e18, "the fund's seed shares");

        // Exclude Moonwell: a record opens with a snapshot of the supply.
        timelockExecute(
            address(fund),
            abi.encodeCall(
                IRobotMoneyFund.setAdapterCodeHashAllowed,
                (address(moonwellAdapter).codehash, false)
            )
        );
        uint256 id = fund.openExclusionOf(IDX_MOONWELL);
        assertGt(id, 0, "record opened");

        // The queue settles alice's escrow: hook first, then its books, then the burn.
        fund.ledgerCheckpoint(alice);
        queued[alice] = 0;
        uint256[] memory floors = _sellFloors(sharesOut - half);
        fund.sellForFlow(sharesOut - half, floors);
        // A fresh address filled after the record opened.
        vm.prank(alice);
        fund.transfer(bob, half);

        assertEq(
            ledger.balanceAt(alice, id), sharesOut, "alice keeps wallet + queued at the snapshot"
        );
        assertEq(ledger.balanceAt(bob, id), 0, "bob, filled after the record, has none");

        // Deposits close while a lending asset is excluded (check 1, defence in depth in the fund).
        vm.expectRevert(IRobotMoneyFund.DepositsClosedDuringExclusion.selector);
        fund.mintInKind(1, 0, limits);
    }

    function test_heldBalances_matchesTheHoldings() public fixtureCovered {
        _seedAndInvest();
        (uint256 idle, uint256[] memory held) = fund.heldBalances();
        assertEq(idle, fund.idleUsdc(), "idle");
        assertEq(held[IDX_WETH], IERC20(WETH).balanceOf(address(fund)), "wETH held");
        assertEq(held[IDX_AAVE], aaveAdapter.totalAssets(), "aave held");
        assertEq(held.length, fund.assetCount(), "one entry per asset");
    }
}
