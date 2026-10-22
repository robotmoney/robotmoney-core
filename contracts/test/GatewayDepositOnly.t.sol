// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §5.2 (Agent Permissions Gateway), docs/technical/smart-contract-invariants.md GW-1..GW-7
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {MockVault} from "./helpers/MockVault.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";

/// @title GatewayDepositOnlyTest
/// @notice Issue 1889: the gateway's only agent action is a deposit into a contract named in the
///         depositor's non-empty `allowedDestinations`. The gateway pins no vault, has no registry
///         lookup, never accepts the router, and has no withdrawal path.
contract GatewayDepositOnlyTest is Test {
    TestERC20 internal usdc;
    MockVault internal vaultA;
    MockVault internal vaultB;
    MockVault internal vaultC; // never listed anywhere
    RobotMoneyGateway internal gateway;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");

    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant MAX_PER_PAYMENT = 1_000 * ONE_USDC;
    uint256 internal constant MAX_PER_WINDOW = 5_000 * ONE_USDC;

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new TestERC20();
        vaultA = new MockVault(address(usdc));
        vaultB = new MockVault(address(usdc));
        vaultC = new MockVault(address(usdc));
        // The vault and router arguments are ignored: the gateway pins neither.
        gateway = CoreProxies.robotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(0)), admin, pauser, address(0)
        );
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    function _policy(address[] memory dests) internal view returns (IGateway.AgentPolicy memory) {
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: owner,
            allowedDestinations: dests,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: new address[](0)
        });
    }

    function _two(address a, address b) internal pure returns (address[] memory d) {
        d = new address[](2);
        d[0] = a;
        d[1] = b;
    }

    function _one(address a) internal pure returns (address[] memory d) {
        d = new address[](1);
        d[0] = a;
    }

    /// @dev Register `agent` for `owner` through consent + commit + reveal (the only path).
    function _register(IGateway.AgentPolicy memory p) internal {
        bytes32 salt = keccak256("salt");
        bytes memory reveal = abi.encodeCall(gateway.revealAuthorization, (agent, salt, p));
        vm.prank(agent);
        gateway.commitAuthorization(keccak256(abi.encode(owner, keccak256(reveal))));
        vm.prank(owner);
        gateway.commitAuthorization(keccak256(abi.encode(agent, owner, salt)));
        vm.roll(block.number + 1);
        vm.prank(owner);
        gateway.revealAuthorization(agent, salt, p);
    }

    function _fund(uint256 amt) internal {
        usdc.mint(agent, amt);
        vm.prank(agent);
        usdc.approve(address(gateway), amt);
    }

    /// @dev Give the agent vault shares directly (what an old withdraw would have pulled).
    function _giveShares(uint256 amt) internal {
        usdc.mint(agent, amt);
        vm.startPrank(agent);
        usdc.approve(address(vaultA), amt);
        vaultA.deposit(amt, agent);
        vm.stopPrank();
    }

    function _deposit(bytes32 tag, uint256 amount, address dest) internal returns (bytes32) {
        vm.prank(agent);
        return
            gateway.depositTo(
                tag, amount, uint64(block.timestamp + 60), tag, dest, new uint256[](0)
            );
    }

    function _storedPolicyHash(address who) internal view returns (bytes32) {
        (
            bool active,
            uint64 validUntil,
            uint256 maxPay,
            uint256 maxWin,
            address recv,
            address assetRecipient,
            uint256 maxWdPay,
            uint256 maxWdWin
        ) = gateway.agents(who);
        return keccak256(
            abi.encode(active, validUntil, maxPay, maxWin, recv, assetRecipient, maxWdPay, maxWdWin)
        );
    }

    // ─── AC1: explicit destinations, two vaults, no pin, no registry ─────────

    function test_depositsIntoTwoDifferentAllowedVaults_sharesReachOwner() public {
        _register(_policy(_two(address(vaultA), address(vaultB))));
        _fund(300 * ONE_USDC);

        _deposit("a", 100 * ONE_USDC, address(vaultA));
        _deposit("b", 200 * ONE_USDC, address(vaultB));

        assertEq(vaultA.balanceOf(owner), 100 * ONE_USDC, "owner shares in A");
        assertEq(vaultB.balanceOf(owner), 200 * ONE_USDC, "owner shares in B");
        assertEq(vaultA.balanceOf(agent) + vaultB.balanceOf(agent), 0, "agent holds no shares");
        assertEq(vaultA.balanceOf(address(gateway)) + vaultB.balanceOf(address(gateway)), 0);
        assertEq(usdc.balanceOf(address(gateway)), 0, "gateway holds no USDC");
        assertEq(usdc.balanceOf(agent), 0);
    }

    function test_unlistedDestinationRefused_evenWhenCapsExpiryAndReceiverPass() public {
        _register(_policy(_two(address(vaultA), address(vaultB))));
        _fund(100 * ONE_USDC);

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidDestination.selector);
        gateway.depositTo(
            "c",
            100 * ONE_USDC,
            uint64(block.timestamp + 60),
            "c",
            address(vaultC),
            new uint256[](0)
        );
        assertEq(usdc.balanceOf(agent), 100 * ONE_USDC, "no USDC moved");
        assertEq(vaultC.balanceOf(owner), 0, "no shares minted");
    }

    function test_noFixedGatewayTargetAuthorizes_onlyThePolicyList() public {
        // The gateway was built with no vault and no router. A vault it never heard of is
        // authorized purely by the policy list, and the zero address (the old "no router") is not.
        _register(_policy(_one(address(vaultC))));
        _fund(100 * ONE_USDC);
        _deposit("c", 100 * ONE_USDC, address(vaultC));
        assertEq(vaultC.balanceOf(owner), 100 * ONE_USDC);

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidDestination.selector);
        gateway.depositTo("z", 1, uint64(block.timestamp + 60), "z", address(0), new uint256[](0));
    }

    function test_destinationMembership_hitsSecondEntryAndMissesBoth() public {
        _register(_policy(_two(address(vaultA), address(vaultB))));
        _fund(10 * ONE_USDC);
        _deposit("second", ONE_USDC, address(vaultB)); // hit on the second entry
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidDestination.selector);
        gateway.depositTo(
            "miss", 1, uint64(block.timestamp + 60), "miss", address(vaultC), new uint256[](0)
        );
    }

    // ─── surviving guards stay effective ─────────────────────────────────────

    function test_guards_capPauseExpiryDeadlineReplay() public {
        _register(_policy(_one(address(vaultA))));
        _fund(10_000 * ONE_USDC);

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.AmountExceedsPerPaymentCap.selector);
        gateway.depositTo(
            "cap",
            MAX_PER_PAYMENT + 1,
            uint64(block.timestamp + 60),
            "cap",
            address(vaultA),
            new uint256[](0)
        );

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.DeadlineExpired.selector);
        gateway.depositTo(
            "dl", 1, uint64(block.timestamp - 1), "dl", address(vaultA), new uint256[](0)
        );

        _deposit("once", ONE_USDC, address(vaultA));
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.PaymentIdAlreadyUsed.selector);
        gateway.depositTo(
            "once",
            ONE_USDC,
            uint64(block.timestamp + 60),
            "once",
            address(vaultA),
            new uint256[](0)
        );

        vm.prank(pauser);
        gateway.pauseDeposits();
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.DepositsArePaused.selector);
        gateway.depositTo(
            "p", 1, uint64(block.timestamp + 60), "p", address(vaultA), new uint256[](0)
        );
        vm.prank(admin);
        gateway.unpauseDeposits();

        vm.warp(block.timestamp + 366 days);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.AgentPolicyExpired.selector);
        gateway.depositTo(
            "x", 1, uint64(block.timestamp + 60), "x", address(vaultA), new uint256[](0)
        );
    }

    // ─── AC2: policy validator ───────────────────────────────────────────────

    function _expectRevealRevert(IGateway.AgentPolicy memory p, bytes4 sel) internal {
        bytes32 salt = keccak256("salt");
        bytes memory reveal = abi.encodeCall(gateway.revealAuthorization, (agent, salt, p));
        vm.prank(agent);
        gateway.commitAuthorization(keccak256(abi.encode(owner, keccak256(reveal))));
        vm.prank(owner);
        gateway.commitAuthorization(keccak256(abi.encode(agent, owner, salt)));
        vm.roll(block.number + 1);
        vm.prank(owner);
        vm.expectRevert(sel);
        gateway.revealAuthorization(agent, salt, p);
        assertEq(gateway.agentOwner(agent), address(0), "nothing stored");
    }

    function _badPolicies() internal returns (IGateway.AgentPolicy[6] memory bad) {
        IGateway.AgentPolicy memory base = _policy(_one(address(vaultA)));
        bad[0] = _policy(new address[](0)); // empty destinations
        bad[1] = _policy(_two(address(vaultA), address(0))); // zero entry
        bad[2] = base;
        bad[2].assetRecipient = makeAddr("recipient");
        bad[3] = _policy(_one(address(vaultA)));
        bad[3].maxWithdrawPerPayment = 1;
        bad[4] = _policy(_one(address(vaultA)));
        bad[4].maxWithdrawPerWindow = 1;
        bad[5] = _policy(_one(address(vaultA)));
        bad[5].allowedSourceVaults = _one(address(vaultA));
    }

    function _badSelector(uint256 i) internal pure returns (bytes4) {
        return i < 2
            ? RobotMoneyGateway.EmptyAllowedDestinations.selector
            : RobotMoneyGateway.RetiredPolicyFieldNonZero.selector;
    }

    function test_reveal_rejectsEmptyDestinationsAndEachRetiredMember() public {
        IGateway.AgentPolicy[6] memory bad = _badPolicies();
        for (uint256 i = 0; i < bad.length; i++) {
            uint256 snap = vm.snapshotState();
            _expectRevealRevert(bad[i], _badSelector(i));
            vm.revertToState(snap);
        }
    }

    function test_setPolicy_rejectsEmptyDestinationsAndEachRetiredMember_policyUnchanged() public {
        _register(_policy(_one(address(vaultA))));
        bytes32 before = _storedPolicyHash(agent);
        IGateway.AgentPolicy[6] memory bad = _badPolicies();
        for (uint256 i = 0; i < bad.length; i++) {
            vm.prank(owner);
            vm.expectRevert(_badSelector(i));
            gateway.setPolicy(agent, bad[i]);
            assertEq(_storedPolicyHash(agent), before, "stored policy unchanged");
        }
        // A valid update still lands and keeps its exact destinations.
        vm.prank(owner);
        gateway.setPolicy(agent, _policy(_two(address(vaultA), address(vaultB))));
        _fund(ONE_USDC);
        _deposit("b", ONE_USDC, address(vaultB));
        assertEq(vaultB.balanceOf(owner), ONE_USDC);
    }

    // ─── AC3: removed selectors refuse with no movement ──────────────────────

    function test_removedSelectors_refuseWithNoMovement() public {
        _register(_policy(_one(address(vaultA))));
        _fund(100 * ONE_USDC);
        _giveShares(50 * ONE_USDC); // shares an old withdraw would have pulled

        bytes[6] memory calls = [
            abi.encodeWithSignature(
                "deposit(bytes32,uint256,uint64,bytes32)",
                bytes32("o"),
                ONE_USDC,
                uint64(block.timestamp + 60),
                bytes32("i")
            ),
            abi.encodeWithSignature(
                "withdraw(bytes32,uint256,address,uint64,bytes32)",
                bytes32("o"),
                ONE_USDC,
                address(vaultA),
                uint64(block.timestamp + 60),
                bytes32("i")
            ),
            abi.encodeWithSignature(
                "withdrawFromRouter(bytes32,address[],uint256[],uint256[],uint64,bytes32)",
                bytes32("o"),
                _one(address(vaultA)),
                new uint256[](1),
                new uint256[](1),
                uint64(block.timestamp + 60),
                bytes32("i")
            ),
            abi.encodeWithSignature("vault()"),
            abi.encodeWithSignature("router()"),
            abi.encodeWithSignature("effectiveWithdrawWindowGross(address)", agent)
        ];

        uint256 usdcBefore = usdc.balanceOf(agent);
        uint256 sharesBefore = vaultA.balanceOf(agent);
        for (uint256 i = 0; i < calls.length; i++) {
            vm.prank(agent);
            (bool ok,) = address(gateway).call(calls[i]);
            assertFalse(ok, "removed selector must not execute");
        }
        assertEq(usdc.balanceOf(agent), usdcBefore, "no USDC moved");
        assertEq(vaultA.balanceOf(agent), sharesBefore, "no shares moved");
        assertEq(usdc.balanceOf(address(gateway)), 0);
        assertEq(vaultA.balanceOf(address(gateway)), 0);
    }

    // ─── legacy rollout: a stored pre-upgrade policy is inert, never a wildcard ──

    /// @dev `agents` is the mapping at slot 4 (storage-layout snapshot). A policy struct is:
    ///      +0 active/validUntil, +1 maxPerPayment, +2 maxPerWindow, +3 shareReceiver,
    ///      +4 allowedDestinations length, +5 assetRecipient, +6 maxWithdrawPerPayment,
    ///      +7 maxWithdrawPerWindow, +8 allowedSourceVaults length.
    function test_legacyStoredPolicy_emptyDestinationsAndRetiredFields_isInert() public {
        _register(_policy(_one(address(vaultA))));
        uint256 base = uint256(keccak256(abi.encode(agent, uint256(4))));
        vm.store(address(gateway), bytes32(base + 4), bytes32(uint256(0))); // empty destinations
        vm.store(address(gateway), bytes32(base + 5), bytes32(uint256(uint160(owner))));
        vm.store(address(gateway), bytes32(base + 6), bytes32(uint256(1_000 * ONE_USDC)));
        vm.store(address(gateway), bytes32(base + 7), bytes32(uint256(5_000 * ONE_USDC)));
        (,,,,, address recipient, uint256 wdPay, uint256 wdWin) = gateway.agents(agent);
        assertEq(recipient, owner, "fixture wrote the legacy withdraw fields");
        assertGt(wdPay, 0);
        assertGt(wdWin, 0);

        _fund(100 * ONE_USDC);
        // Empty list: no destination at all is accepted, the old pinned vault included.
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidDestination.selector);
        gateway.depositTo(
            "legacy", ONE_USDC, uint64(block.timestamp + 60), "l", address(vaultA), new uint256[](0)
        );
        // The non-zero legacy withdraw fields grant nothing: the selector does not exist.
        _giveShares(ONE_USDC);
        vm.prank(agent);
        (bool ok,) = address(gateway)
            .call(
                abi.encodeWithSignature(
                    "withdraw(bytes32,uint256,address,uint64,bytes32)",
                    bytes32("w"),
                    ONE_USDC,
                    address(vaultA),
                    uint64(block.timestamp + 60),
                    bytes32("w")
                )
            );
        assertFalse(ok, "no withdrawal authority from legacy fields");
        assertEq(usdc.balanceOf(owner), 0);

        // The owner heals the policy through setPolicy: the retired fields are overwritten to zero.
        vm.prank(owner);
        gateway.setPolicy(agent, _policy(_one(address(vaultA))));
        (,,,,, recipient, wdPay, wdWin) = gateway.agents(agent);
        assertEq(recipient, address(0));
        assertEq(wdPay, 0);
        assertEq(wdWin, 0);
        _deposit("healed", ONE_USDC, address(vaultA));
        assertEq(vaultA.balanceOf(owner), ONE_USDC);
    }
}
