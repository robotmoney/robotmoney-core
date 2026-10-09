// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §4 — Access control & admin (Timelock bypass → Mitigated)
// Canonical: docs/technical/governance-isomorphism.md — the test governance path is the production one
// Implements: issue #1644 — every vault admin setter runs Safe -> Timelock with two signatures
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {BasketVault} from "../vaults/BasketVault.sol";
import {ProtocolAssetVault} from "../vaults/ProtocolAssetVault.sol";
import {RwaBasketVault} from "../vaults/RwaBasketVault.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {RoleHolders} from "./helpers/RoleHolders.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";
import {ShortlistMockPool, ShortlistStubSwapRouter} from "./ProtocolAssetVaultShortlist.t.sol";

/// @title GovernedVaultSafeTimelockTest
/// @notice The vault admin setters (retire, setFeeRecipient, addAsset, removeAsset,
///         setExitFeeBps) on every governed vault family, driven the way production drives them:
///         two Safe owners sign, the real SafeL2 proxy runs `execTransaction`, the timelock waits
///         its delay, and the timelock calls the vault. Nothing pranks the Safe.
contract GovernedVaultSafeTimelockTest is SafeGovernance {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant DELAY = 2 days;
    uint24 internal constant POOL_FEE = 3000;
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    TestERC20 internal usdc;
    ShortlistStubSwapRouter internal swapRouter;
    address internal safe;
    TimelockController internal timelock;

    ProtocolAssetVault internal proto;
    RwaBasketVault internal rwa;
    RobotMoneyVault internal core;
    VaultRegistry internal registry;
    TestERC20 internal protoToken;
    ShortlistMockPool internal protoPool;

    address internal feeRecipient = makeAddr("feeRecipient");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        _installSafeSet();
        safe = _newDefaultSafe();
        timelock = _newGovTimelock(safe, DELAY);

        // Record from before the vaults exist so RoleHolders sees every ADMIN_ROLE grant.
        vm.recordLogs();
        usdc = new TestERC20();
        swapRouter = new ShortlistStubSwapRouter();
        proto = new ProtocolAssetVault(
            IERC20(address(usdc)),
            ISwapRouter(address(swapRouter)),
            10_000_000 * ONE_USDC,
            1_000_000 * ONE_USDC,
            0,
            feeRecipient,
            address(this),
            address(this)
        );
        rwa = new RwaBasketVault(
            IERC20(address(usdc)),
            ISwapRouter(address(swapRouter)),
            10_000_000 * ONE_USDC,
            1_000_000 * ONE_USDC,
            0,
            feeRecipient,
            address(this),
            address(this)
        );
        core = new RobotMoneyVault(
            usdc,
            type(uint256).max,
            type(uint256).max,
            0,
            feeRecipient,
            address(this),
            address(this)
        );
        registry = new VaultRegistry(address(this));

        // Seed one asset so removeAsset has a real target, then register + link the vault.
        protoToken = new TestERC20();
        protoPool = new ShortlistMockPool(address(protoToken), address(usdc), POOL_FEE);
        proto.addAsset(
            address(protoToken), address(protoPool), POOL_FEE, address(0), BasketVault.Venue.V3
        );
        proto.setRegistry(address(registry));
        registry.registerVault(
            address(proto),
            VaultRegistry.VaultMetadata({
                name: "Protocol", asset: address(usdc), registeredAt: block.timestamp
            })
        );

        // Handover: the timelock gets ADMIN_ROLE, the deployer gives it up.
        proto.grantRole(ADMIN_ROLE, address(timelock));
        proto.revokeRole(ADMIN_ROLE, address(this));
        rwa.grantRole(ADMIN_ROLE, address(timelock));
        rwa.revokeRole(ADMIN_ROLE, address(this));
        core.grantRole(ADMIN_ROLE, address(timelock));
        core.revokeRole(ADMIN_ROLE, address(this));
        registry.grantRole(ADMIN_ROLE, address(timelock));
        registry.revokeRole(ADMIN_ROLE, address(this));
    }

    // ─── Handover leaves exactly one admin ────────────────────────────────────

    function test_timelockIsTheOnlyAdminOnEveryGovernedVault() public {
        // setUp's logs were not consumed by a getRecordedLogs call, so read them here.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        address[4] memory governed =
            [address(proto), address(rwa), address(core), address(registry)];
        for (uint256 i = 0; i < governed.length; i++) {
            address[] memory holders = RoleHolders.holders(logs, governed[i], ADMIN_ROLE);
            assertEq(holders.length, 1, "exactly one ADMIN_ROLE holder");
            assertEq(holders[0], address(timelock), "the timelock is the only admin");
        }
    }

    // ─── ProtocolAssetVault: all four setters ─────────────────────────────────

    function test_protocolAssetVault_setFeeRecipient_viaSafeThenTimelock() public {
        address next = makeAddr("nextRecipient");
        bytes memory data = abi.encodeCall(BasketVault.setFeeRecipient, (next));
        bytes32 salt = keccak256("proto-fee-recipient");
        bytes32 id = _govSchedule(safe, timelock, address(proto), data, salt, DELAY);

        _expectExecuteRefused(safe, timelock, address(proto), data, salt);
        assertEq(proto.feeRecipient(), feeRecipient, "unchanged before the delay");

        vm.warp(block.timestamp + DELAY);
        _govExecute(safe, timelock, address(proto), data, salt);

        assertEq(proto.feeRecipient(), next, "fee recipient updated by the timelock");
        assertEq(
            uint256(timelock.getOperationState(id)),
            uint256(TimelockController.OperationState.Done),
            "operation Done"
        );
        _expectExecuteRefused(safe, timelock, address(proto), data, salt); // replay
    }

    function test_protocolAssetVault_setExitFeeBps_viaSafeThenTimelock() public {
        bytes memory data = abi.encodeCall(BasketVault.setExitFeeBps, (25));
        bytes32 salt = keccak256("proto-exit-fee");
        _govSchedule(safe, timelock, address(proto), data, salt, DELAY);
        _expectExecuteRefused(safe, timelock, address(proto), data, salt);
        vm.warp(block.timestamp + DELAY);
        _govExecute(safe, timelock, address(proto), data, salt);
        assertEq(proto.exitFeeBps(), 25, "exit fee updated by the timelock");
        _expectExecuteRefused(safe, timelock, address(proto), data, salt); // replay
    }

    function test_protocolAssetVault_addAsset_viaSafeThenTimelock() public {
        TestERC20 token = new TestERC20();
        ShortlistMockPool pool = new ShortlistMockPool(address(token), address(usdc), POOL_FEE);
        bytes memory data = abi.encodeCall(
            BasketVault.addAsset,
            (address(token), address(pool), POOL_FEE, address(0), BasketVault.Venue.V3)
        );
        bytes32 salt = keccak256("proto-add-asset");
        _govSchedule(safe, timelock, address(proto), data, salt, DELAY);
        _expectExecuteRefused(safe, timelock, address(proto), data, salt);
        vm.warp(block.timestamp + DELAY);
        _govExecute(safe, timelock, address(proto), data, salt);

        (address[] memory tokens,,, bool[] memory active,) = proto.shortlist();
        assertEq(tokens.length, 2, "asset appended");
        assertEq(tokens[1], address(token), "the new token is last");
        assertTrue(active[1], "the new token is active");
        _expectExecuteRefused(safe, timelock, address(proto), data, salt); // replay
    }

    function test_protocolAssetVault_removeAsset_viaSafeThenTimelock() public {
        bytes memory data = abi.encodeCall(BasketVault.removeAsset, (0));
        bytes32 salt = keccak256("proto-remove-asset");
        _govSchedule(safe, timelock, address(proto), data, salt, DELAY);
        _expectExecuteRefused(safe, timelock, address(proto), data, salt);
        vm.warp(block.timestamp + DELAY);
        _govExecute(safe, timelock, address(proto), data, salt);

        (,,, bool[] memory active,) = proto.shortlist();
        assertFalse(active[0], "the asset is deactivated");
        _expectExecuteRefused(safe, timelock, address(proto), data, salt); // replay
    }

    // ─── retire: Safe -> Timelock -> VaultRegistry -> vault ───────────────────

    function test_registryRetire_viaSafeThenTimelock_haltsTheVault() public {
        bytes memory data = abi.encodeCall(VaultRegistry.retire, (address(proto)));
        bytes32 salt = keccak256("retire-proto");
        _govSchedule(safe, timelock, address(registry), data, salt, DELAY);
        _expectExecuteRefused(safe, timelock, address(registry), data, salt);
        assertFalse(proto.retired(), "not retired before the delay");

        vm.warp(block.timestamp + DELAY);
        _govExecute(safe, timelock, address(registry), data, salt);

        (, VaultRegistry.VaultStatus status) = registry.getVault(address(proto));
        assertEq(uint256(status), uint256(VaultRegistry.VaultStatus.Retired), "registry: Retired");
        assertTrue(proto.retired(), "vault: deposits halted in the same call");
        _expectExecuteRefused(safe, timelock, address(registry), data, salt); // replay
    }

    function test_vaultRetire_directCallIsRegistryOnly() public {
        vm.prank(address(timelock));
        vm.expectRevert(BasketVault.OnlyRegistry.selector);
        proto.retire();
    }

    // ─── RwaBasketVault and RobotMoneyVault setters ───────────────────────────

    function test_rwaBasketVault_setters_viaSafeThenTimelock() public {
        address next = makeAddr("rwaRecipient");
        bytes memory feeData = abi.encodeCall(BasketVault.setFeeRecipient, (next));
        _govRun(safe, timelock, address(rwa), feeData, keccak256("rwa-recipient"), DELAY);
        assertEq(rwa.feeRecipient(), next, "rwa fee recipient updated");

        bytes memory bpsData = abi.encodeCall(BasketVault.setExitFeeBps, (10));
        _govRun(safe, timelock, address(rwa), bpsData, keccak256("rwa-exit-fee"), DELAY);
        assertEq(rwa.exitFeeBps(), 10, "rwa exit fee updated");
        _expectExecuteRefused(safe, timelock, address(rwa), bpsData, keccak256("rwa-exit-fee"));
    }

    function test_robotMoneyVault_setters_viaSafeThenTimelock() public {
        address next = makeAddr("coreRecipient");
        bytes memory feeData = abi.encodeCall(RobotMoneyVault.setFeeRecipient, (next));
        _govRun(safe, timelock, address(core), feeData, keccak256("core-recipient"), DELAY);
        assertEq(core.feeRecipient(), next, "core fee recipient updated");

        bytes memory bpsData = abi.encodeCall(RobotMoneyVault.setExitFeeBps, (10));
        bytes32 salt = keccak256("core-exit-fee");
        _govSchedule(safe, timelock, address(core), bpsData, salt, DELAY);
        _expectExecuteRefused(safe, timelock, address(core), bpsData, salt);
        vm.warp(block.timestamp + DELAY);
        _govExecute(safe, timelock, address(core), bpsData, salt);
        assertEq(core.exitFeeBps(), 10, "core exit fee updated");
        _expectExecuteRefused(safe, timelock, address(core), bpsData, salt); // replay
    }

    // ─── The quorum is real ───────────────────────────────────────────────────

    function test_oneSignature_cannotSchedule_GS020() public {
        bytes memory data = abi.encodeCall(BasketVault.setExitFeeBps, (1));
        bytes memory schedule = abi.encodeCall(
            timelock.schedule, (address(proto), 0, data, bytes32(0), bytes32(0), DELAY)
        );
        bytes memory oneSig = _oneOwnerSignature(_safeDigest(safe, address(timelock), schedule));
        vm.expectRevert(bytes("GS020"));
        _safeExecWith(safe, address(timelock), schedule, oneSig);
    }

    function test_directAdminCalls_revert_forEveryRoleLessCaller() public {
        // Neither a stranger nor the Safe's own address (not via execTransaction) holds ADMIN_ROLE.
        address[2] memory callers = [stranger, safe];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector, callers[i], ADMIN_ROLE
                )
            );
            vm.prank(callers[i]);
            proto.setFeeRecipient(stranger);
        }
    }

    function test_safeCancel_stopsAQueuedSetter() public {
        bytes memory data = abi.encodeCall(BasketVault.setExitFeeBps, (50));
        bytes32 salt = keccak256("cancel-me");
        bytes32 id = _govSchedule(safe, timelock, address(proto), data, salt, DELAY);
        _govCancel(safe, timelock, id);
        vm.warp(block.timestamp + DELAY);
        // A cancelled operation is Unset: not Ready.
        _expectExecuteRefused(safe, timelock, address(proto), data, salt);
        assertEq(proto.exitFeeBps(), 0, "the cancelled setter never ran");
    }
}
