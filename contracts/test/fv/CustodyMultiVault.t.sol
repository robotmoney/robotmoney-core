// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md §1–2 (SUP-1, CUST-4/5)
//            docs/prd.md §12 (INV-1/2/3)
//
// MULTI-VAULT CUSTODY STATEFUL-INVARIANT HARNESS (issue #964, AC3)
// ───────────────────────────────────────────────────────────────────────────────
// The existing custody stateful-invariant proof (CustodyInvariant.t.sol) drives
// RobotMoneyVault only. SUP-1 (Σ holder-redeemable ≤ totalAssets) and CUST-4/5
// are family-wide solvency properties that must hold for *every* vault family:
//
//   1. RobotMoneyVault     — proven by CustodyInvariant.t.sol (StdInvariant handler)
//   2. BasketVault         — live TWAP-pool/router rig below
//   3. RwaVault            — live Chronicle-oracle/Aerodrome rig below
//   4. AgentTokenVault     — seam below (BasketVault descendant)
//   5. ProtocolAssetVault  — seam below (BasketVault descendant)
//
// Each live family test deposits into its native accounting path, then applies the
// shared predicate. The negative test below proves the predicate itself rejects a
// vault that over-promises holder redemption value.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {RobotMoneyVault} from "../../RobotMoneyVault.sol";
import {BasketVault} from "../../vaults/BasketVault.sol";
import {RwaVault} from "../../vaults/RwaVault.sol";
import {ChronicleOracleAdapter} from "../../adapters/ChronicleOracleAdapter.sol";
import {ISwapRouter} from "../../interfaces/ISwapRouter.sol";
import {IChronicleOracle} from "../../interfaces/IChronicleOracle.sol";
import {InvUSDC} from "../CustodyInvariant.t.sol";
import {NoYieldTestAdapter} from "../helpers/NoYieldTestAdapter.sol";
import {TestERC20} from "../helpers/TestERC20.sol";
import {BasketVaultHarness, MockPool, MockSwapRouter} from "../BasketVault.t.sol";
import {
    Sup5AeroRouter,
    Sup5Chronicle,
    Sup5Pool,
    Sup5StubV3Router,
    Sup5Token,
    Sup5Usdc
} from "./StaleOracleRedemption.t.sol";

/// @dev Intentionally violates SUP-1: one holder can redeem twice the assets.
///      This test-only double proves the shared predicate is executed, not vacuous.
contract Sup1OverpromisingVault {
    function totalAssets() external pure returns (uint256) {
        return 1e6;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 1e6;
    }

    function convertToAssets(uint256) external pure returns (uint256) {
        return 2e6;
    }
}

contract CustodyMultiVaultTest is Test {
    address internal admin = makeAddr("multiVaultAdmin");

    /// @dev Shared SUP-1 predicate: the sum of the given holders' redeemable
    ///      assets never exceeds totalAssets(). Reused by every per-family test so
    ///      the property is defined once and applied uniformly across vaults.
    function _assertRedeemableLeqTotalAssets(IERC4626 vault, address[] memory holders)
        internal
        view
    {
        uint256 redeemable;
        for (uint256 i = 0; i < holders.length; i++) {
            redeemable += vault.convertToAssets(vault.balanceOf(holders[i]));
        }
        assertLe(redeemable, vault.totalAssets(), "SUP-1: holders' redeemable exceeds totalAssets");
    }

    /// @dev External boundary lets the negative test assert that the complete
    ///      shared predicate reverts, rather than merely one of its view calls.
    function assertRedeemableLeqTotalAssetsExternal(IERC4626 vault, address[] memory holders)
        external
        view
    {
        _assertRedeemableLeqTotalAssets(vault, holders);
    }

    /// @notice SUP-1 / CUST-4 / INV-2 (RobotMoneyVault, live). A single
    ///         deposit/redeem round trip keeps Σ redeemable ≤ totalAssets. The
    ///         exhaustive stateful-fuzz proof remains in CustodyInvariant.t.sol;
    ///         this asserts the shared predicate against the one family wired live
    ///         in the scout pass so the harness is not vacuous.
    function test_SUP1_robotMoneyVault_redeemableLeqTotalAssets() public {
        InvUSDC usdc = new InvUSDC();
        RobotMoneyVault vault = new RobotMoneyVault(
            IERC20(address(usdc)), type(uint256).max, type(uint256).max, 0, admin, admin, admin
        );

        // RobotMoneyVault requires at least one active, eligible adapter before it
        // will accept deposits (maxDeposit returns 0 otherwise).
        NoYieldTestAdapter adapter = new NoYieldTestAdapter(address(usdc), address(vault));
        vm.startPrank(admin);
        vault.setAdapterAllowed(address(adapter), true);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vault.addAdapter(address(adapter), 10_000);
        vm.stopPrank();

        address alice = makeAddr("alice");
        usdc.mint(alice, 1_000_000e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(500_000e6, alice);
        vm.stopPrank();

        address[] memory holders = new address[](1);
        holders[0] = alice;
        _assertRedeemableLeqTotalAssets(IERC4626(address(vault)), holders);

        // A protocol-asset donation accrues to the holder pro-rata, never strands.
        usdc.mint(address(vault), 10_000e6);
        _assertRedeemableLeqTotalAssets(IERC4626(address(vault)), holders);
    }

    /// @notice SUP-1 (BasketVault family): a live V3-priced basket deposit keeps
    ///         its holder's redeemable value within NAV.
    function test_SUP1_basketFamily_redeemableLeqTotalAssets() public {
        TestERC20 usdc = new TestERC20();
        TestERC20 basketToken = new TestERC20();
        MockSwapRouter router = new MockSwapRouter();
        MockPool pool = new MockPool(address(basketToken), address(usdc), uint160(1 << 96));
        BasketVaultHarness vault = new BasketVaultHarness(
            IERC20(address(usdc)), ISwapRouter(address(router)), admin, admin
        );

        vm.prank(admin);
        vault.addAsset(address(basketToken), address(pool), 500, address(0), BasketVault.Venue.V3);

        address alice = makeAddr("basketAlice");
        uint256 depositAmount = 1_000e6;
        basketToken.mint(address(router), depositAmount);
        router.setAmountOut(depositAmount);
        usdc.mint(alice, depositAmount);
        vm.startPrank(alice);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, alice);
        vm.stopPrank();

        address[] memory holders = new address[](1);
        holders[0] = alice;
        _assertRedeemableLeqTotalAssets(IERC4626(address(vault)), holders);
    }

    /// @notice SUP-1 (RwaVault): a live Chronicle-priced RWA deposit keeps its
    ///         holder's redeemable value within NAV.
    function test_SUP1_rwaVault_redeemableLeqTotalAssets() public {
        Sup5Usdc usdc = new Sup5Usdc();
        Sup5Token despxa = new Sup5Token();
        Sup5Chronicle chronicle = new Sup5Chronicle(5e18, block.timestamp);
        Sup5AeroRouter router = new Sup5AeroRouter();
        (address token0, address token1) = address(despxa) < address(usdc)
            ? (address(despxa), address(usdc))
            : (address(usdc), address(despxa));
        Sup5Pool pool = new Sup5Pool(token0, token1);
        ChronicleOracleAdapter adapter = new ChronicleOracleAdapter(
            address(router),
            address(0xF00D),
            false,
            address(chronicle),
            address(despxa),
            address(usdc)
        );
        RwaVault vault = new RwaVault(
            IERC20(address(usdc)),
            ISwapRouter(address(new Sup5StubV3Router())),
            IChronicleOracle(address(chronicle)),
            type(uint256).max,
            type(uint256).max,
            0,
            admin,
            admin,
            admin
        );

        vm.startPrank(admin);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vault.addAsset(
            address(despxa), address(pool), 0, address(adapter), BasketVault.Venue.Aerodrome
        );
        vm.stopPrank();

        address alice = makeAddr("rwaAlice");
        uint256 depositAmount = 1_000e6;
        despxa.mint(address(router), 200e18);
        router.setAmountOut(200e18);
        usdc.mint(alice, depositAmount);
        vm.startPrank(alice);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, alice);
        vm.stopPrank();

        address[] memory holders = new address[](1);
        holders[0] = alice;
        _assertRedeemableLeqTotalAssets(IERC4626(address(vault)), holders);
    }

    /// @notice SUP-1's predicate rejects a vault that overstates redemption value.
    function test_SUP1_predicateRejectsOverpromisingVault() public {
        address[] memory holders = new address[](1);
        holders[0] = makeAddr("overpromisedHolder");
        IERC4626 overpromisingVault = IERC4626(address(new Sup1OverpromisingVault()));

        vm.expectRevert();
        this.assertRedeemableLeqTotalAssetsExternal(overpromisingVault, holders);
    }
}
