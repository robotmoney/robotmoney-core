// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md §1–2 (SUP-1, CUST-4/5)
//            docs/prd.md §12 (INV-1/2/3)
//
// MULTI-VAULT CUSTODY STATEFUL-INVARIANT HARNESS (issue #964, AC3 — SCOUT STUB)
// ───────────────────────────────────────────────────────────────────────────────
// The existing custody stateful-invariant proof (CustodyInvariant.t.sol) drives
// RobotMoneyVault only. SUP-1 (Σ holder-redeemable ≤ totalAssets) and CUST-4/5
// are family-wide solvency properties that must hold for *every* vault family:
//
//   1. RobotMoneyVault     — proven by CustodyInvariant.t.sol (StdInvariant handler)
//   2. BasketVault         — seam below (needs a TWAP-pool/adapter test rig)
//   3. RwaVault            — seam below (needs a Chronicle oracle mock; see
//                            StaleOracleRedemption.t.sol)
//   4. AgentTokenVault     — seam below (BasketVault descendant)
//   5. ProtocolAssetVault  — seam below (BasketVault descendant)
//
// SCOUT SCOPE: this file stands up the *shape* of the cross-family suite — a
// shared invariant predicate (`_assertRedeemableLeqTotalAssets`) plus a per-family
// test that wires the simplest case (RobotMoneyVault) live and leaves the basket
// family as skipped seams. The basket family vaults price NAV through a TWAP
// adapter whose own vetting is the subject of ADP-2 (#966); building a faithful,
// non-reverting basket custody rig depends on that remediation, so those legs are
// `vm.skip`-ped with the issue that unblocks them rather than implemented against
// a known-broken surface. RobotMoneyVault is exercised live so the suite proves
// the predicate actually holds for at least one family today.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {RobotMoneyVault} from "../../RobotMoneyVault.sol";
import {InvUSDC} from "../CustodyInvariant.t.sol";
import {NoYieldTestAdapter} from "../helpers/NoYieldTestAdapter.sol";

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

    /// @notice SUP-1 (BasketVault family, seam). Extending the custody
    ///         stateful-invariant handler to BasketVault/AgentTokenVault/
    ///         ProtocolAssetVault requires a TWAP-pool + vetted-adapter test rig;
    ///         the adapter-vetting gap is ADP-2 (#966). Build the basket custody
    ///         handler here once that lands, then remove this skip.
    function test_SUP1_basketFamily_redeemableLeqTotalAssets() public {
        vm.skip(
            true,
            "basket-family custody handler needs vetted-adapter rig - remediation #966 (ADP-2)"
        );
        fail();
    }

    /// @notice SUP-5 (RwaVault, seam). The RWA family's redeemability under a
    ///         stale feed is the subject of StaleOracleRedemption.t.sol; the live
    ///         custody handler for RwaVault depends on the freshness short-circuit
    ///         landing (NC-1).
    function test_SUP1_rwaVault_redeemableLeqTotalAssets() public {
        vm.skip(
            true,
            "RwaVault custody handler needs stale-feed short-circuit - remediation #966 (NC-1/SUP-5)"
        );
        fail();
    }
}
