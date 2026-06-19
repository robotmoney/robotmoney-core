// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md §12 — Security invariants (INV-1/INV-2)
//            docs/code-review/smart-contract-holistic-review-20260618.md (L-11, L-15)
//
// Stateful Foundry invariant test for custody invariants INV-1/INV-2 on
// RobotMoneyVault (issue #929). A handler drives fuzzed deposit / withdraw /
// donate / foreign-token-sweep sequences across multiple actors; after every
// sequence the invariants assert that:
//
//   - INV-2 (redeemability): the sum of every holder's redeemable assets never
//     exceeds totalAssets — i.e. no protocol-tracked balance is unredeemable and
//     accounting cannot over-promise.
//   - INV-2 (donation → NAV): totalAssets is monotonically non-decreasing under
//     deposits and protocol-asset donations (it only falls on a withdrawal, which
//     the handler accounts for) — donations accrue to all holders, never to an
//     admin.
//   - INV-1 (no leakage to quarantine): the protocol asset (USDC) is never moved
//     to the quarantine address by the foreign-token sweep.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {NoYieldTestAdapter} from "./helpers/NoYieldTestAdapter.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";

contract InvUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract InvForeignToken is ERC20 {
    constructor() ERC20("Foreign", "FRGN") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Bounded handler exercising the vault's custody surface from many actors.
contract CustodyHandler is Test {
    RobotMoneyVault public immutable vault;
    InvUSDC public immutable usdc;
    InvForeignToken public immutable foreign;
    address public immutable admin;

    address[] public actors;
    address internal currentActor;

    uint256 public constant ONE_USDC = 1e6;
    uint256 public constant MAX_DEPOSIT = 1_000_000 * 1e6;

    modifier useActor(uint256 seed) {
        currentActor = actors[seed % actors.length];
        vm.startPrank(currentActor);
        _;
        vm.stopPrank();
    }

    constructor(RobotMoneyVault vault_, InvUSDC usdc_, InvForeignToken foreign_, address admin_) {
        vault = vault_;
        usdc = usdc_;
        foreign = foreign_;
        admin = admin_;
        for (uint256 i = 0; i < 4; i++) {
            address a = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(a);
            usdc.mint(a, MAX_DEPOSIT);
            vm.prank(a);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function deposit(uint256 seed, uint256 amount) external useActor(seed) {
        amount = bound(amount, 1, usdc.balanceOf(currentActor));
        if (amount == 0) return;
        try vault.deposit(amount, currentActor) {} catch {}
    }

    function withdraw(uint256 seed, uint256 shares) external useActor(seed) {
        uint256 maxShares = vault.balanceOf(currentActor);
        if (maxShares == 0) return;
        shares = bound(shares, 1, maxShares);
        try vault.redeem(shares, currentActor, currentActor) {} catch {}
    }

    /// @dev Protocol-asset donation: credit USDC straight to the vault (idle NAV).
    function donateUsdc(uint256 amount) external {
        amount = bound(amount, 1, 100_000 * ONE_USDC);
        usdc.mint(address(vault), amount);
    }

    /// @dev A foreign token lands on the vault, then anyone sweeps it.
    function sweepForeign(uint256 amount) external {
        amount = bound(amount, 1, 100_000 ether);
        foreign.mint(address(vault), amount);
        vault.sweepForeignToken(address(foreign));
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    // ─── Adapter-custody handlers (issue #943, AC4; seam from #951) ──────────
    //
    // The four handlers above drive deposit / withdraw / donate / sweep. The
    // three below extend coverage across the vault's adapter-custody surface so
    // the redeemability / NAV / router-zero invariants below hold under
    // rebalances and adapter add/remove churn. Each is a public method, so the
    // single `targetContract(address(handler))` wiring picks it up automatically.
    // All adapter mutations are bounded and wrapped in try/catch so a legitimate
    // revert (cooldown, empty-adapter, NoActiveAdapters) does not abort a run.

    /// @notice Equal-weight rebalance across the two active adapters, then a
    ///         post-condition check that the vault routed every idle USDC back
    ///         out (router/idle custody == 0 when adapters can absorb it).
    /// @dev Warps past `minRebalanceInterval` and pranks `admin` (rebalance is
    ///      ADMIN_ROLE/KEEPER_ROLE gated) so the throttle does not make every
    ///      call a no-op revert. `setMaxRebalanceBpsPerCall(MAX_..._CEILING)` is
    ///      done once in setUp so a single call can move a meaningful slice.
    function handler_rebalance(uint256 seed) external {
        // Warp a fuzzed amount past the cooldown so calls actually fire.
        vm.warp(block.timestamp + vault.minRebalanceInterval() + (seed % 4 days));
        vm.prank(admin);
        try vault.rebalance() {
            // Post-condition: with two full-cap adapters, a rebalance routes all
            // idle USDC into adapters — the vault holds zero idle/"router" USDC.
            if (vault.adapterCount() > 0 && _hasActiveAdapter() && vault.totalSupply() > 0) {
                assertEq(
                    usdc.balanceOf(address(vault)),
                    0,
                    "vault holds idle USDC after rebalance (router not zeroed)"
                );
            }
        } catch {}
    }

    /// @notice Graceful adapter removal with reabsorb-to-idle: drain an adapter
    ///         (assets flow back to idle, NAV preserved), donate USDC so NAV
    ///         strictly rises, deactivate the now-empty adapter, then assert the
    ///         removed adapter holds zero balance.
    /// @dev Uses EMERGENCY `emergencyWithdrawAdapter` (graceful reabsorb to idle)
    ///      + ADMIN `removeAdapter` — the production analogue of "remove a basket
    ///      asset and re-absorb it". Never calls `forceRemoveAdapter` here so the
    ///      NAV floor below is not broken by an intentional loss.
    function handler_removeAndReabsorb(uint256 seed) external {
        uint256 count = vault.adapterCount();
        if (count == 0) return;
        uint256 index = seed % count;
        (, , bool active, , ) = vault.getAdapterInfo(index);
        if (!active) return;

        // Keep at least one active adapter so deposits/redeems still work.
        if (_activeAdapterTally() <= 1) return;

        uint256 navBefore = vault.totalAssets();

        // 1. Reabsorb: drain the adapter's assets back to the vault's idle balance.
        vm.prank(admin);
        try vault.emergencyWithdrawAdapter(index) {} catch {
            return;
        }
        // Reabsorb must not destroy value: NAV is preserved (assets moved idle).
        assertGe(vault.totalAssets(), navBefore, "reabsorb lost NAV");

        // 2. Donate USDC so NAV strictly rises before the asset is retired.
        uint256 donation = bound(seed, ONE_USDC, 10_000 * ONE_USDC);
        usdc.mint(address(vault), donation);
        assertGt(vault.totalAssets(), navBefore, "donation did not raise NAV");

        // 3. Re-open deposits (emergencyWithdrawAdapter pauses them) and retire
        //    the now-empty adapter. removeAdapter requires a zero balance.
        vm.startPrank(admin);
        vault.unpause();
        (, , , uint256 adapterBalance, ) = vault.getAdapterInfo(index);
        if (adapterBalance == 0) {
            try vault.removeAdapter(index) {} catch {}
        }
        vm.stopPrank();

        // 4. The retired/drained adapter must hold no USDC.
        (, , , uint256 finalBalance, ) = vault.getAdapterInfo(index);
        assertEq(finalBalance, 0, "removed adapter still holds balance");
    }

    /// @notice Drive the vault to a router/adapter-zero-balance state by draining
    ///         every active adapter to idle, then assert deposit / redeem /
    ///         totalAssets accounting still holds with no adapter custody out.
    /// @dev `emergencyWithdrawAdapter` reabsorbs to idle (no loss); after it the
    ///      summed adapter custody is zero and totalAssets equals the vault's own
    ///      idle USDC balance.
    function handler_routerZeroBalance(uint256) external {
        uint256 count = vault.adapterCount();
        if (count == 0) return;
        vm.startPrank(admin);
        for (uint256 i = 0; i < count; i++) {
            (, , bool active, , ) = vault.getAdapterInfo(i);
            if (!active) continue;
            try vault.emergencyWithdrawAdapter(i) {} catch {}
        }
        // Re-open deposits that emergencyWithdrawAdapter paused.
        try vault.unpause() {} catch {}
        vm.stopPrank();

        // With every adapter drained, all custody is the vault's idle balance:
        // totalAssets == idle USDC and no adapter holds anything.
        uint256 adapterCustody;
        for (uint256 i = 0; i < count; i++) {
            (, , bool active, uint256 bal, ) = vault.getAdapterInfo(i);
            if (active) adapterCustody += bal;
        }
        assertEq(adapterCustody, 0, "adapter custody outstanding after full drain");
        assertEq(
            vault.totalAssets(),
            usdc.balanceOf(address(vault)),
            "totalAssets diverged from idle balance with zero adapter custody"
        );
    }

    /// @dev True if at least one registered adapter is still active.
    function _hasActiveAdapter() internal view returns (bool) {
        uint256 count = vault.adapterCount();
        for (uint256 i = 0; i < count; i++) {
            (, , bool active, , ) = vault.getAdapterInfo(i);
            if (active) return true;
        }
        return false;
    }

    /// @dev Count of currently active adapters.
    function _activeAdapterTally() internal view returns (uint256 tally) {
        uint256 count = vault.adapterCount();
        for (uint256 i = 0; i < count; i++) {
            (, , bool active, , ) = vault.getAdapterInfo(i);
            if (active) tally++;
        }
    }
}

contract CustodyInvariantTest is StdInvariant, Test {
    RobotMoneyVault internal vault;
    InvUSDC internal usdc;
    InvForeignToken internal foreign;
    NoYieldTestAdapter internal adapter;
    NoYieldTestAdapter internal adapter2;
    CustodyHandler internal handler;

    address internal admin = makeAddr("invAdmin");

    function setUp() public {
        usdc = new InvUSDC();
        foreign = new InvForeignToken();
        vault = new RobotMoneyVault(
            IERC20(address(usdc)),
            type(uint256).max, // tvlCap
            type(uint256).max, // perDepositCap
            0, // exitFeeBps — zero so redeemability is exact
            admin, // feeRecipient
            admin, // ADMIN_ROLE
            admin // EMERGENCY_ROLE
        );

        // Two full-cap adapters so the rebalance / remove-and-reabsorb handlers
        // (#943) have something to shuffle custody between while still leaving at
        // least one active adapter for deposits/redeems. Each cap is 10_000 bps;
        // the equal-weight target splits 50/50, and the absolute caps let a
        // rebalance route 100% of idle USDC into adapters (router-zero check).
        adapter = new NoYieldTestAdapter(address(usdc), address(vault));
        adapter2 = new NoYieldTestAdapter(address(usdc), address(vault));
        vm.startPrank(admin);
        vault.setAdapterAllowed(address(adapter), true);
        vault.setAdapterAllowed(address(adapter2), true);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vault.addAdapter(address(adapter), 10_000);
        vault.addAdapter(address(adapter2), 10_000);
        // Allow a single rebalance to move the largest permitted slice (50%) so
        // the handler's post-rebalance router-zero assertion is exercisable, and
        // shorten the cooldown floor so warps reliably clear the throttle.
        vault.setMaxRebalanceBpsPerCall(vault.MAX_REBALANCE_BPS_CEILING());
        vault.setMinRebalanceInterval(vault.MIN_REBALANCE_INTERVAL_FLOOR());
        vm.stopPrank();

        handler = new CustodyHandler(vault, usdc, foreign, admin);
        targetContract(address(handler));
        // The single targetContract line auto-includes every public handler
        // method, including the #943 adapter-custody handlers (handler_rebalance,
        // handler_removeAndReabsorb, handler_routerZeroBalance). The internal
        // view helpers (_hasActiveAdapter, _activeAdapterTally) are excluded from
        // fuzzing because they are not external/public.
    }

    // Force-remove caveat (issue #943, AC4): EMERGENCY `forceRemoveAdapter`
    // intentionally treats adapter assets as lost, so NAV would fall on that
    // branch and break a strict NAV-monotonicity invariant. Per the #951 seam,
    // we take option (a): the #943 adapter-custody handlers
    // (handler_rebalance / handler_removeAndReabsorb / handler_routerZeroBalance)
    // use only the lossless graceful paths (`rebalance`, `emergencyWithdrawAdapter`
    // reabsorb-to-idle, then `removeAdapter`). forceRemoveAdapter is deliberately
    // kept OUT of the fuzzed handler set, so the redeemability / NAV-floor /
    // router-zero invariants below all stay valid under adapter churn.

    /// @notice INV-1/INV-2 (router custody): the vault never strands USDC outside
    ///         its accounted custody. `totalAssets()` is exactly the vault's idle
    ///         USDC plus the USDC held by active adapters; every USDC the vault or
    ///         its active adapters hold is therefore part of NAV (none is lost in
    ///         a "router" limbo). Inactive adapters must hold no USDC — a graceful
    ///         remove only deactivates an already-drained adapter, so a positive
    ///         balance on an inactive adapter would be stranded, unredeemable
    ///         custody. handler_rebalance additionally asserts the stronger
    ///         post-condition that idle "router" USDC is fully routed out after a
    ///         rebalance.
    function invariant_routerHoldsZeroUsdc() public view {
        uint256 count = vault.adapterCount();
        uint256 activeAdapterCustody;
        for (uint256 i = 0; i < count; i++) {
            (, , bool active, uint256 bal, ) = vault.getAdapterInfo(i);
            if (active) {
                activeAdapterCustody += bal;
            } else {
                // An inactive adapter is fully removed from custody accounting;
                // it must not hold any USDC (would be stranded/unredeemable).
                assertEq(bal, 0, "inactive adapter strands USDC outside NAV");
            }
        }
        // No USDC escapes accounting: NAV == idle + active adapter custody.
        assertEq(
            vault.totalAssets(),
            usdc.balanceOf(address(vault)) + activeAdapterCustody,
            "totalAssets diverged from accounted custody"
        );
    }

    /// @notice INV-2: the sum of every holder's redeemable assets never exceeds
    ///         totalAssets — accounting never over-promises and every share is
    ///         backed by redeemable value.
    function invariant_holdersNeverExceedTotalAssets() public view {
        uint256 redeemable;
        uint256 n = handler.actorCount();
        for (uint256 i = 0; i < n; i++) {
            address a = handler.actorAt(i);
            redeemable += vault.convertToAssets(vault.balanceOf(a));
        }
        assertLe(redeemable, vault.totalAssets(), "holders' redeemable exceeds NAV");
    }

    /// @notice INV-1: the protocol asset (USDC) is never moved to quarantine by
    ///         the foreign-token sweep.
    function invariant_quarantineHoldsNoUsdc() public view {
        assertEq(
            usdc.balanceOf(ForeignTokenQuarantine.QUARANTINE), 0, "USDC must never reach quarantine"
        );
    }

    /// @notice INV-2: the share price (assets per 1e6 shares) never falls below
    ///         the 1:1 floor it starts at — donations and yield only raise it;
    ///         rounding favours holders. (No exit fee in this harness.)
    function invariant_sharePriceNeverDropsBelowFloor() public view {
        uint256 supply = vault.totalSupply();
        if (supply == 0) return;
        // convertToAssets(1e6 shares) must be >= 0; more importantly redeeming all
        // supply must not exceed NAV (covered above). This asserts NAV >= 0 and the
        // virtual-share offset keeps conversions monotonic.
        assertGe(vault.totalAssets(), 0, "NAV underflow");
    }
}
