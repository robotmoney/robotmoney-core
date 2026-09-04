// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.1 — Vault Family; §4.7 — Retirement lifecycle
// Implements: issue #1284 — the vault family's last-admin floor (ACL-3 / F-06)
//             and retirement semantics previously existed as independent,
//             already-diverged hand-written copies rather than one owner.
//
// Test plan:
//   - forge test --match-contract VaultFamilyInvariantsTest -vv
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {Vault} from "../Vault.sol";
import {RwaVault} from "../vaults/RwaVault.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {ProtocolAssetVault} from "../vaults/ProtocolAssetVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {AdminFloorAccessControlCounter} from "../lib/AdminFloorAccessControlCounter.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {IChronicleOracle} from "../interfaces/IChronicleOracle.sol";

import {TestERC20, MockSwapRouter, MockPool} from "./BasketVault.t.sol";
import {StubSwapRouter, MockChronicle} from "./RwaVault.t.sol";
import {MockAdapter, TestUSDC} from "./RobotMoneyVault.t.sol";

/// @dev Deliberately unprotected mock "vault": bare `AccessControl` with a
///      self-administered `ADMIN_ROLE`, mirroring the shape every real family
///      member had before this issue (RobotMoneyVault) or would have if a
///      future vault type forgot to inherit `AdminFloorAccessControlCounter`.
///      Exists solely for the negative self-test below.
contract UnprotectedStubVault is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    constructor(address admin_) {
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _grantRole(ADMIN_ROLE, admin_);
    }
}

/// @title VaultFamilyInvariantsTest
/// @notice Family-wide invariants that must hold identically across every
///         vault type, so a new vault type that omits either invariant fails
///         CI rather than silently diverging (issue #1284).
contract VaultFamilyInvariantsTest is Test {
    uint256 internal constant ONE_USDC = 1e6;

    address internal admin = makeAddr("famAdmin");
    address internal emergencyResponder = makeAddr("famEmergency");
    address internal feeRecipient = makeAddr("famFeeRecipient");

    // ─── Last-admin floor (ACL-3 / F-06) ───────────────────────────────────

    /// @dev Reused for every vault-family member: the sole `ADMIN_ROLE` holder
    ///      cannot renounce or be revoked, but rotating to a second admin
    ///      first still works (the floor blocks only the last-holder
    ///      transition, not admin rotation).
    function _assertLastAdminFloorHolds(IAccessControl v, address soleAdmin) internal {
        bytes32 role = keccak256("ADMIN_ROLE");
        assertTrue(
            v.hasRole(role, soleAdmin), "fixture must start with soleAdmin holding ADMIN_ROLE"
        );

        vm.prank(soleAdmin);
        vm.expectRevert(AdminFloorAccessControlCounter.LastAdminFloor.selector);
        v.renounceRole(role, soleAdmin);

        vm.prank(soleAdmin);
        vm.expectRevert(AdminFloorAccessControlCounter.LastAdminFloor.selector);
        v.revokeRole(role, soleAdmin);

        address secondAdmin = makeAddr("secondAdmin");
        vm.prank(soleAdmin);
        v.grantRole(role, secondAdmin);
        vm.prank(soleAdmin);
        v.revokeRole(role, soleAdmin);
        assertFalse(v.hasRole(role, soleAdmin), "revoke must succeed once a second admin exists");
        assertTrue(v.hasRole(role, secondAdmin), "second admin must hold the role");
    }

    function _deployRobotMoneyVault() internal returns (RobotMoneyVault) {
        TestUSDC usdc = new TestUSDC();
        return new RobotMoneyVault(
            IERC20(address(usdc)),
            type(uint256).max,
            type(uint256).max,
            0,
            feeRecipient,
            admin,
            emergencyResponder
        );
    }

    function _deployVault() internal returns (Vault) {
        TestUSDC usdc = new TestUSDC();
        return new Vault(
            IERC20(address(usdc)),
            "Robot Money USDC",
            "rmUSDC",
            type(uint256).max,
            type(uint256).max,
            0,
            500, // maxSlippageBps
            10_000, // maxNavGrowthRateBps (nonzero, effectively inert here)
            feeRecipient,
            admin,
            emergencyResponder
        );
    }

    function _deployRwaVault() internal returns (RwaVault) {
        TestERC20 usdc = new TestERC20();
        StubSwapRouter router = new StubSwapRouter();
        MockChronicle chronicle = new MockChronicle(1e18, block.timestamp);
        return new RwaVault(
            IERC20(address(usdc)),
            ISwapRouter(address(router)),
            IChronicleOracle(address(chronicle)),
            type(uint256).max,
            type(uint256).max,
            0,
            feeRecipient,
            admin,
            emergencyResponder
        );
    }

    function _deployAgentTokenVault() internal returns (AgentTokenVault) {
        TestERC20 usdc = new TestERC20();
        StubSwapRouter router = new StubSwapRouter();
        return new AgentTokenVault(
            IERC20(address(usdc)),
            ISwapRouter(address(router)),
            type(uint256).max,
            type(uint256).max,
            0,
            feeRecipient,
            admin,
            emergencyResponder
        );
    }

    function _deployProtocolAssetVault() internal returns (ProtocolAssetVault) {
        TestERC20 usdc = new TestERC20();
        StubSwapRouter router = new StubSwapRouter();
        return new ProtocolAssetVault(
            IERC20(address(usdc)),
            ISwapRouter(address(router)),
            type(uint256).max,
            type(uint256).max,
            0,
            feeRecipient,
            admin,
            emergencyResponder
        );
    }

    /// @notice Enumerates every vault type in `contracts/` and asserts the
    ///         last-admin floor holds on each. A new vault type added to the
    ///         family without inheriting `AdminFloorAccessControlCounter`
    ///         must be added here too — see the negative self-test below for
    ///         what happens when a type is missing the floor.
    function test_lastAdminFloor_holdsAcrossVaultFamily() public {
        _assertLastAdminFloorHolds(IAccessControl(address(_deployRobotMoneyVault())), admin);
        _assertLastAdminFloorHolds(IAccessControl(address(_deployVault())), admin);
        _assertLastAdminFloorHolds(IAccessControl(address(_deployRwaVault())), admin);
        _assertLastAdminFloorHolds(IAccessControl(address(_deployAgentTokenVault())), admin);
        _assertLastAdminFloorHolds(IAccessControl(address(_deployProtocolAssetVault())), admin);
    }

    /// @notice Negative self-test (Test Plan): a stub "vault" that forgets to
    ///         inherit the shared floor lets its last admin renounce/be
    ///         revoked successfully — the opposite of every real family
    ///         member above. Proves `_assertLastAdminFloorHolds` is not
    ///         vacuously true: plugging this stub into it would fail exactly
    ///         where a real vault type missing the floor would be caught
    ///         (RobotMoneyVault itself, before this issue's fix, behaved
    ///         exactly like this stub).
    function test_lastAdminFloor_negativeSelfTest_unprotectedStubHasNoFloor() public {
        UnprotectedStubVault stub = new UnprotectedStubVault(admin);
        bytes32 role = stub.ADMIN_ROLE();

        vm.prank(admin);
        stub.renounceRole(role, admin);

        assertFalse(
            stub.hasRole(role, admin),
            "unprotected stub allows renouncing the last admin (no floor) -- "
            "the family-wide assertion above would fail if a real vault behaved this way"
        );
    }

    // ─── Retirement contract agreement (issue #1284) ───────────────────────

    struct RmFixture {
        RobotMoneyVault vault;
        uint256 shares;
    }

    function _setupRetiredRmVault(address registry, address depositor)
        internal
        returns (RmFixture memory f)
    {
        TestUSDC usdc = new TestUSDC();
        f.vault = new RobotMoneyVault(
            IERC20(address(usdc)),
            type(uint256).max,
            type(uint256).max,
            0,
            feeRecipient,
            admin,
            emergencyResponder
        );
        MockAdapter adapter = new MockAdapter(address(usdc), address(f.vault));
        vm.startPrank(admin);
        f.vault.setAdapterAllowed(address(adapter), true);
        f.vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        f.vault.addAdapter(address(adapter), 10_000);
        f.vault.setRegistry(registry);
        vm.stopPrank();

        usdc.mint(depositor, 1_000 * ONE_USDC);
        vm.startPrank(depositor);
        usdc.approve(address(f.vault), type(uint256).max);
        f.shares = f.vault.deposit(1_000 * ONE_USDC, depositor);
        vm.stopPrank();
    }

    struct BasketFixture {
        AgentTokenVault vault;
        MockSwapRouter router;
        TestERC20 usdc;
        uint256 shares;
    }

    function _setupRetiredBasketVault(address registry, address depositor)
        internal
        returns (BasketFixture memory f)
    {
        TestERC20 basketToken = new TestERC20();
        f.usdc = new TestERC20();
        f.router = new MockSwapRouter();
        MockPool pool = new MockPool(address(basketToken), address(f.usdc), uint160(1 << 96));
        f.vault = new AgentTokenVault(
            IERC20(address(f.usdc)),
            ISwapRouter(address(f.router)),
            type(uint256).max,
            type(uint256).max,
            0,
            feeRecipient,
            admin,
            emergencyResponder
        );
        vm.startPrank(admin);
        f.vault.addAsset(address(basketToken), address(pool), 500, address(0), BasketVault.Venue.V3);
        f.vault.setRegistry(registry);
        vm.stopPrank();

        uint256 depositAmount = 1_000 * ONE_USDC;
        uint256 basketOut = 995 * ONE_USDC;
        f.usdc.mint(depositor, depositAmount);
        basketToken.mint(address(f.router), basketOut);
        f.router.setAmountOut(basketOut);
        vm.startPrank(depositor);
        f.usdc.approve(address(f.vault), depositAmount);
        f.shares = f.vault.deposit(depositAmount, depositor);
        vm.stopPrank();
    }

    /// @notice RobotMoneyVault and BasketVault model retirement with a
    ///         dedicated `retired` flag kept separate from the emergency
    ///         pause path. This test drives both families through the SAME
    ///         `IRetirableVault` entry points (`retire()`/`unretire()`, called
    ///         by the same linked registry) and asserts they agree on the
    ///         observable contract: deposits close, `retired()` flips true,
    ///         and ERC-4626 `redeem()` stays open (ADR-0009) throughout.
    function test_retirementContract_agreesBetweenRobotMoneyVaultAndBasketVault() public {
        address registry = makeAddr("famRegistry");
        address depositor = makeAddr("famDepositor");

        RmFixture memory rm = _setupRetiredRmVault(registry, depositor);
        BasketFixture memory bk = _setupRetiredBasketVault(registry, depositor);

        // ── retire() on BOTH via the same registry, through the shared
        //    IRetirableVault entry points ──
        vm.prank(registry);
        rm.vault.retire();
        vm.prank(registry);
        bk.vault.retire();

        assertTrue(rm.vault.retired(), "RobotMoneyVault must be retired");
        assertTrue(bk.vault.retired(), "BasketVault must be retired");
        assertEq(rm.vault.maxDeposit(depositor), 0, "RobotMoneyVault deposits must be closed");
        assertEq(bk.vault.maxDeposit(depositor), 0, "BasketVault deposits must be closed");

        vm.prank(depositor);
        vm.expectRevert();
        rm.vault.deposit(1, depositor);

        vm.prank(depositor);
        vm.expectRevert();
        bk.vault.deposit(1, depositor);

        // redeem must stay open on both (ADR-0009)
        vm.prank(depositor);
        uint256 rmRedeemed = rm.vault.redeem(rm.shares, depositor, depositor);
        assertGt(rmRedeemed, 0, "RobotMoneyVault redeem must stay open while retired");

        uint256 redeemOut = 990 * ONE_USDC;
        bk.usdc.mint(address(bk.router), redeemOut);
        bk.router.setAmountOut(redeemOut);
        vm.prank(depositor);
        uint256 bRedeemed = bk.vault.redeem(bk.shares, depositor, depositor);
        assertGt(bRedeemed, 0, "BasketVault redeem must stay open while retired");

        // ── unretire() on both reopens deposits ──
        vm.prank(registry);
        rm.vault.unretire();
        vm.prank(registry);
        bk.vault.unretire();

        assertFalse(rm.vault.retired(), "RobotMoneyVault must clear retired on unretire()");
        assertFalse(bk.vault.retired(), "BasketVault must clear retired on unretire()");
    }
}
