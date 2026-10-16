// SPDX-License-Identifier: MIT
// Canonical: scripts/deploy/stage-table.json vaultRuleDecisions.emergencyLevers (issue 1705 Q2 (a))
//            docs/technical/smart-contracts.md (Emergency levers per vault, issue 1705)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {TestUSDC, MockAdapter} from "./RobotMoneyVault.t.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";

/// @notice Issue 1705 Q2 (a), the rule for the mainnet test, shown on a real RobotMoneyVault:
///         - Only EMERGENCY_ROLE (the emergency key) may write off an adapter, through
///           `forceRemoveAdapter`. ADMIN_ROLE (the timelock), the keeper and anyone else cannot.
///         - The write-off pauses deposits, so nobody buys shares at the written-down price.
///         - Only ADMIN_ROLE (the Safe through the timelock) recovers: it adds the adapter back and
///           unpauses. The emergency key cannot do either.
///         - A recovery is credited to the write-off's exclusion record (core 1820), never to NAV, and
///           paid pro rata to whoever held shares when the write-off opened. A holder who exits
///           during the write-off is paid at the reduced NAV and keeps the claim.
///         - Withdrawals are never frozen: redeem works throughout.
///         The baskets have no write-off lever at all (their EMERGENCY_ROLE functions are
///         `emergencyLevers` in the stage table, asserted by scripts/deploy/stage-table.test.ts).
contract AdapterWriteOffRuleTest is Test {
    uint256 internal constant ONE_USDC = 1e6;

    TestUSDC internal usdc;
    RobotMoneyVault internal vault;
    MockAdapter internal adapterA;
    MockAdapter internal adapterB;

    address internal timelock = makeAddr("timelock");
    address internal emergency = makeAddr("emergency");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        usdc = new TestUSDC();
        // The handover state: ADMIN_ROLE is the timelock, EMERGENCY_ROLE the emergency key.
        vault = CoreProxies.robotMoneyVault(
            IERC20(address(usdc)),
            1_000_000 * ONE_USDC,
            100_000 * ONE_USDC,
            0,
            makeAddr("fees"),
            timelock,
            emergency
        );
        adapterA = new MockAdapter(address(usdc), address(vault));
        adapterB = new MockAdapter(address(usdc), address(vault));
        vm.startPrank(timelock);
        for (uint256 i = 0; i < 2; i++) {
            address a = i == 0 ? address(adapterA) : address(adapterB);
            vault.setAdapterAllowed(a, true);
            vault.setAdapterCodeHashAllowed(a.codehash, true);
            vault.addAdapter(a, 5_000);
        }
        vault.grantRole(vault.KEEPER_ROLE(), keeper);
        vm.stopPrank();
        for (uint256 i = 0; i < 3; i++) {
            address who = i == 0 ? alice : (i == 1 ? bob : carol);
            usdc.mint(who, 10_000 * ONE_USDC);
            vm.prank(who);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function _unauthorized(address who, bytes32 role) internal pure returns (bytes memory) {
        return
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, who, role
            );
    }

    function test_onlyTheEmergencyKeyWritesOffAnAdapter() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        bytes32 em = vault.EMERGENCY_ROLE();
        address[3] memory others = [timelock, keeper, alice];
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(_unauthorized(others[i], em));
            vault.forceRemoveAdapter(1);
        }
        vm.prank(emergency);
        vault.forceRemoveAdapter(1);
        (,, bool active) = vault.adapters(1);
        assertFalse(active, "written off");
        assertTrue(vault.depositsPaused(), "the write-off pauses deposits");
        assertEq(vault.totalAssets(), 500 * ONE_USDC, "the written-off half leaves NAV");
        vm.prank(carol);
        vm.expectRevert(RobotMoneyVault.DepositsArePaused.selector);
        vault.deposit(1_000 * ONE_USDC, carol);
    }

    function test_onlyTheTimelockRecoversAndReopens() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(emergency);
        vault.forceRemoveAdapter(1);

        bytes32 adm = vault.ADMIN_ROLE();
        vm.startPrank(emergency);
        vm.expectRevert(_unauthorized(emergency, adm));
        vault.addAdapter(address(adapterB), 5_000);
        vm.expectRevert(_unauthorized(emergency, adm));
        vault.unpauseDeposits();
        vm.stopPrank();

        uint256 recordId = vault.openExclusionOf(1);
        assertGt(recordId, 0, "the write-off opened an exclusion record");

        vm.startPrank(timelock);
        vault.addAdapter(address(adapterB), 5_000);
        vault.unpauseDeposits();
        vm.stopPrank();
        // core 1820: the adapter's balance is realised into the record, not into NAV.
        assertEq(vault.totalAssets(), 500 * ONE_USDC, "the recovery stays out of NAV");
        assertEq(adapterB.totalAssets(), 0, "the adapter was drained into the record");
        assertApproxEqAbs(
            vault.exclusionLedger().claimable(recordId, alice),
            500 * ONE_USDC,
            2,
            "the sole holder at the snapshot is owed the recovery"
        );
        assertFalse(vault.depositsPaused());
    }

    function test_aRecoveryIsCreditedToTheHoldersWhenItLands() public {
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(bob);
        uint256 bobShares = vault.deposit(1_000 * ONE_USDC, bob);
        assertEq(adapterB.totalAssets(), 1_000 * ONE_USDC);

        vm.prank(emergency);
        vault.forceRemoveAdapter(1);

        // Withdrawals stay open. Alice exits during the write-off at the reduced NAV.
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        uint256 alicePaid = usdc.balanceOf(alice) - before;
        assertApproxEqAbs(alicePaid, 500 * ONE_USDC, 2, "alice is paid at half value");

        // The timelock recovers the position into the exclusion record. Both holders at the
        // snapshot are owed their pro-rata share, alice included although she exited.
        uint256 recordId = vault.openExclusionOf(1);
        vm.prank(timelock);
        vault.addAdapter(address(adapterB), 5_000);
        assertApproxEqAbs(
            vault.previewRedeem(bobShares), 500 * ONE_USDC, 2, "bob's NAV share stays reduced"
        );
        assertApproxEqAbs(
            vault.exclusionLedger().claimable(recordId, alice),
            500 * ONE_USDC,
            2,
            "alice keeps her pro-rata claim after her exit"
        );
        assertApproxEqAbs(
            vault.exclusionLedger().claimable(recordId, bob),
            500 * ONE_USDC,
            2,
            "bob is owed the other half"
        );
        assertEq(vault.totalSupply(), bobShares, "alice holds no shares after her exit");
    }
}
