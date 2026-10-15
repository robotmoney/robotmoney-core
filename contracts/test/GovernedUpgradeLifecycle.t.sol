// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §3–§6, "Tests this ADR requires (P1)"
// Canonical: docs/technical/smart-contract-invariants.md — UPG-1..UPG-7 (governed upgrade and freeze)
// Implements: core issue 1808 (QA plan v1 P1) — lifecycle tests for every proxied contract kind
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC1967} from "@openzeppelin/contracts/interfaces/IERC1967.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {GovernedUpgrade} from "../lib/GovernedUpgrade.sol";
import {ProposerFloorTimelock} from "../ProposerFloorTimelock.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {ExclusionLedgerFactory} from "../ExclusionLedgerFactory.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ProtocolAssetVault} from "../vaults/ProtocolAssetVault.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {RwaBasketVault} from "../vaults/RwaBasketVault.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {BasketAssetConfigGuard} from "../lib/BasketAssetConfigGuard.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {NoYieldTestAdapter} from "./helpers/NoYieldTestAdapter.sol";
import {Proxied} from "./helpers/Proxied.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";
import {MockPool, MockSwapRouter} from "./BasketVault.t.sol";

/// @dev A v2 of rmUSDC with one appended field and a reinitializer, the shape of a real upgrade
///      that needs a migration step (ADR-0014 §3: a reinitializer runs only as the `data` of a
///      timelock-executed `upgradeToAndCall`). `onlyUpgradeAuthority` is the pairing every
///      reinitializer carries: an upgrade installed with empty data leaves it pending, and only the
///      timelock may run it later.
contract RobotMoneyVaultV2 is RobotMoneyVault {
    uint256 public v2Marker;

    function initializeV2(uint256 marker) external onlyUpgradeAuthority reinitializer(2) {
        v2Marker = marker;
    }
}

/// @dev A hostile-shaped v2 whose reinitializer tries to re-run `__GovernedUpgrade_init` with a new
///      authority. UPG-3: the authority is write-once, so even a timelock-executed reinitializer
///      cannot rotate it.
contract RobotMoneyVaultV2RotatesAuthority is RobotMoneyVault {
    function rotateAuthority(address newAuthority) external onlyUpgradeAuthority reinitializer(2) {
        __GovernedUpgrade_init(newAuthority, UpgradeMode.Upgradeable);
    }
}

/// @title GovernedUpgradeLifecycleBase
/// @notice The ADR-0014 lifecycle, run once per proxied contract kind by the concrete contracts
///         below: born governed through an atomically initialized ERC1967Proxy, upgraded only by
///         the timelock after its delay, never by a role holder, the deployer, the Safe directly or
///         `RouterGovernance`; frozen one-way on a named implementation; and never re-initialized.
/// @dev The timelock is a real `ProposerFloorTimelock` with a real 2-of-3 SafeL2
///      (`helpers/SafeGovernance.sol`) as its one proposer and canceller and an open executor, as `DeployTimelock.runAuthority` deploys it. A second
///      implementation of the same contract plays "v2": it is a distinct address with a distinct
///      runtime code hash (UUPS bakes `address(this)` into the code), which is all the freeze binding
///      needs to tell two implementations apart.
abstract contract GovernedUpgradeLifecycleBase is SafeGovernance {
    /// @dev ERC-7201 slot of `GovernedUpgrade`, recomputed here from the namespace string.
    bytes32 internal constant NAMESPACE_SLOT = keccak256(
        abi.encode(uint256(keccak256("robotmoney.storage.GovernedUpgrade")) - 1)
    ) & ~bytes32(uint256(0xff));
    /// @dev The literal ADR-0014 §3 pins; the test fails if the namespace or the formula drifts.
    bytes32 internal constant PINNED_SLOT =
        0x5f8c19f69998101f56563e0013e2ccd167eee33eac647374045191b3bd187600;

    uint256 internal constant DELAY = 2 days;
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    ProposerFloorTimelock internal timelock;
    RouterGovernance internal routerGovernance;
    TestERC20 internal usdc;

    address internal safe;
    address internal deployer = makeAddr("deployer");
    address internal emergency = makeAddr("emergency");
    address internal stranger = makeAddr("stranger");
    address internal alice = makeAddr("alice");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal registryStandIn = makeAddr("registry");
    address internal gatewayStandIn = makeAddr("gateway");
    address internal icPolicyStandIn = makeAddr("icPolicy");

    address internal proxy;
    address internal implementationV1;
    uint256 internal saltNonce;

    // ─── Per-kind hooks ───────────────────────────────────────────────

    /// @dev A fresh implementation of the kind (no constructor arguments).
    function _newImplementation() internal virtual returns (address);

    /// @dev The kind's `initialize` call data, naming `authority` and `mode`.
    function _initData(address authority, GovernedUpgrade.UpgradeMode mode)
        internal
        virtual
        returns (bytes memory);

    /// @dev Business-role holders of the kind. None of them may upgrade or freeze.
    function _privileged() internal view virtual returns (address[] memory);

    /// @dev Give the proxy some business state (deposits, registrations, policies).
    function _populate() internal virtual {}

    /// @dev Digest of the business state an upgrade must keep.
    function _state() internal view virtual returns (bytes32);

    /// @dev Kind dependencies the initializer reads (a vault for the gateway, a factory ...).
    function _prepare() internal virtual {}

    // ─── Fixture ──────────────────────────────────────────────────────

    function setUp() public virtual {
        usdc = new TestERC20();
        _installSafeSet();
        safe = _newDefaultSafe();
        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new ProposerFloorTimelock(DELAY, proposers, executors, address(0));
        routerGovernance = new RouterGovernance(
            address(Proxied.portfolioRouter(address(usdc), registryStandIn, deployer)), deployer
        );

        _prepare();
        implementationV1 = _newImplementation();
        proxy = address(
            new ERC1967Proxy(
                implementationV1,
                _initData(address(timelock), GovernedUpgrade.UpgradeMode.Upgradeable)
            )
        );
        _populate();
    }

    function _schedule(address target, bytes memory data) internal returns (bytes32 salt) {
        salt = bytes32(++saltNonce);
        _govSchedule(safe, timelock, target, data, salt, DELAY);
    }

    function _execute(address target, bytes memory data, bytes32 salt) internal {
        timelock.execute(target, 0, data, bytes32(0), salt);
    }

    /// @dev Safe schedules, the delay runs, anyone executes.
    function _govern(address target, bytes memory data) internal {
        bytes32 salt = _schedule(target, data);
        vm.warp(block.timestamp + DELAY);
        _execute(target, data, salt);
    }

    function _upgradeCall(address implementation, bytes memory data)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (implementation, data));
    }

    function _freezeCall(address implementation) internal view returns (bytes memory) {
        return
            abi.encodeCall(
                GovernedUpgrade.freezeUpgrades, (implementation, implementation.codehash)
            );
    }

    function _implementationOf(address p) internal view returns (address) {
        return address(uint160(uint256(vm.load(p, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    /// @dev Everyone who must NOT be able to upgrade or freeze: the kind's role holders, the
    ///      deployer, a stranger, the Safe acting directly, and RouterGovernance.
    function _refused() internal view returns (address[] memory out) {
        address[] memory kind = _privileged();
        out = new address[](kind.length + 4);
        for (uint256 i = 0; i < kind.length; i++) {
            out[i] = kind[i];
        }
        out[kind.length] = deployer;
        out[kind.length + 1] = stranger;
        out[kind.length + 2] = safe;
        out[kind.length + 3] = address(routerGovernance);
    }

    // ─── Deploy ───────────────────────────────────────────────────────

    /// @notice UPG-1: born governed. The proxy is initialized in its own deployment, names the
    ///         timelock, is not frozen, and has zero ERC-1967 admin and beacon slots.
    function test_deploy_proxyBornGoverned() public view {
        assertEq(GovernedUpgrade(proxy).upgradeAuthority(), address(timelock), "authority");
        assertFalse(GovernedUpgrade(proxy).upgradesFrozen(), "born unfrozen");
        assertEq(_implementationOf(proxy), implementationV1, "implementation slot");
        assertEq(vm.load(proxy, ERC1967Utils.ADMIN_SLOT), bytes32(0), "admin slot");
        assertEq(vm.load(proxy, ERC1967Utils.BEACON_SLOT), bytes32(0), "beacon slot");
    }

    /// @notice ADR-0014 tests: test_governedUpgradeSlot_isPinned.
    function test_governedUpgradeSlot_isPinned() public {
        assertEq(NAMESPACE_SLOT, PINNED_SLOT, "ERC-7201 slot drifted from ADR-0014 section 3");
        uint256 word = uint256(vm.load(proxy, NAMESPACE_SLOT));
        assertEq(address(uint160(word)), address(timelock), "authority in the namespace");
        assertEq((word >> 160) & 0xff, 0, "frozen bit clear");

        _govern(proxy, _freezeCall(implementationV1));
        word = uint256(vm.load(proxy, NAMESPACE_SLOT));
        assertEq(address(uint160(word)), address(timelock), "authority kept by the freeze");
        assertEq((word >> 160) & 0xff, 1, "frozen bit set");
        assertTrue(GovernedUpgrade(proxy).upgradesFrozen(), "upgradesFrozen reads the bit");
    }

    // ─── Initialization ───────────────────────────────────────────────

    /// @notice UPG-2: the proxy's initializer ran once and can never run again.
    function test_initialize_cannotReplay() public {
        bytes memory init = _initData(stranger, GovernedUpgrade.UpgradeMode.Upgradeable);
        vm.prank(stranger);
        (bool ok, bytes memory ret) = proxy.call(init);
        assertFalse(ok, "re-initialize must revert");
        assertEq(bytes4(ret), Initializable.InvalidInitialization.selector, "InvalidInitialization");
        assertEq(GovernedUpgrade(proxy).upgradeAuthority(), address(timelock), "authority kept");
    }

    /// @notice UPG-2: the bare implementation can never be initialized.
    function test_implementation_initializersLocked() public {
        bytes memory init = _initData(address(timelock), GovernedUpgrade.UpgradeMode.Upgradeable);
        (bool ok, bytes memory ret) = implementationV1.call(init);
        assertFalse(ok, "initialize on the implementation must revert");
        assertEq(bytes4(ret), Initializable.InvalidInitialization.selector, "InvalidInitialization");
    }

    /// @notice The upgrade and freeze entry points refuse a call that is not through a proxy.
    function test_upgradeToAndCall_onImplementationReverts() public {
        address v2 = _newImplementation();
        vm.prank(address(timelock));
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        UUPSUpgradeable(implementationV1).upgradeToAndCall(v2, "");

        vm.prank(address(timelock));
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        GovernedUpgrade(implementationV1)
            .freezeUpgrades(implementationV1, implementationV1.codehash);
    }

    /// @notice A deployment must state its mode: `Unset` reverts inside the proxy's deployment.
    function test_initialize_refusesUnsetMode() public {
        address implementation = _newImplementation();
        bytes memory init = _initData(address(timelock), GovernedUpgrade.UpgradeMode.Unset);
        vm.expectRevert(GovernedUpgrade.UpgradeModeUnset.selector);
        new ERC1967Proxy(implementation, init);
    }

    /// @notice The authority must be a contract (the timelock), never an EOA.
    function test_initialize_refusesEoaAuthority() public {
        address implementation = _newImplementation();
        bytes memory init = _initData(stranger, GovernedUpgrade.UpgradeMode.Upgradeable);
        vm.expectRevert(
            abi.encodeWithSelector(GovernedUpgrade.UpgradeAuthorityNotContract.selector, stranger)
        );
        new ERC1967Proxy(implementation, init);
    }

    // ─── Governed upgrade ─────────────────────────────────────────────

    /// @notice UPG-3: Safe → timelock → delay → execute upgrades the proxy and keeps its state. The
    ///         operation cannot execute before the delay.
    function test_governedUpgrade_throughTimelock_keepsState() public {
        bytes32 before = _state();
        address v2 = _newImplementation();
        bytes memory data = _upgradeCall(v2, "");
        bytes32 salt = _schedule(proxy, data);

        vm.expectRevert(); // TimelockUnexpectedOperationState: the delay has not run.
        _execute(proxy, data, salt);

        vm.warp(block.timestamp + DELAY);
        vm.expectEmit(true, false, false, false, proxy);
        emit IERC1967.Upgraded(v2);
        _execute(proxy, data, salt);

        assertEq(_implementationOf(proxy), v2, "implementation slot moved to v2");
        assertEq(_state(), before, "business state kept across the upgrade");
        assertEq(GovernedUpgrade(proxy).upgradeAuthority(), address(timelock), "authority kept");
        assertFalse(GovernedUpgrade(proxy).upgradesFrozen(), "an upgrade does not freeze");
    }

    /// @notice ADR-0014 tests: test_upgrade_onlyTimelock. No role holder, the deployer, a stranger,
    ///         the Safe acting directly or RouterGovernance can upgrade.
    function test_upgrade_onlyTimelock() public {
        address v2 = _newImplementation();
        address[] memory refused = _refused();
        for (uint256 i = 0; i < refused.length; i++) {
            vm.prank(refused[i]);
            vm.expectRevert(
                abi.encodeWithSelector(GovernedUpgrade.UpgradeNotAuthorized.selector, refused[i])
            );
            UUPSUpgradeable(proxy).upgradeToAndCall(v2, "");
        }
        assertEq(_implementationOf(proxy), implementationV1, "no refused caller upgraded");
    }

    // ─── Freeze ───────────────────────────────────────────────────────

    /// @notice UPG-4: the timelock freezes the proxy on the named live implementation; nothing can
    ///         upgrade it afterwards, the timelock included, and a second freeze reverts.
    function test_freeze_throughTimelock_rejectsLaterUpgrade() public {
        vm.expectEmit(true, true, false, true, proxy);
        emit GovernedUpgrade.UpgradesFrozen(proxy, implementationV1, implementationV1.codehash);
        _govern(proxy, _freezeCall(implementationV1));
        assertTrue(GovernedUpgrade(proxy).upgradesFrozen(), "frozen");

        address v2 = _newImplementation();
        bytes memory data = _upgradeCall(v2, "");
        bytes32 salt = _schedule(proxy, data);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(GovernedUpgrade.UpgradesAreFrozen.selector);
        _execute(proxy, data, salt);

        vm.prank(address(timelock));
        vm.expectRevert(GovernedUpgrade.UpgradesAreFrozen.selector);
        UUPSUpgradeable(proxy).upgradeToAndCall(v2, "");

        vm.prank(address(timelock));
        vm.expectRevert(GovernedUpgrade.UpgradesAreFrozen.selector);
        GovernedUpgrade(proxy).freezeUpgrades(implementationV1, implementationV1.codehash);

        assertEq(_implementationOf(proxy), implementationV1, "frozen on v1");
    }

    /// @notice Only the authority can freeze.
    function test_freeze_onlyAuthority() public {
        address[] memory refused = _refused();
        for (uint256 i = 0; i < refused.length; i++) {
            vm.prank(refused[i]);
            vm.expectRevert(
                abi.encodeWithSelector(GovernedUpgrade.UpgradeNotAuthorized.selector, refused[i])
            );
            GovernedUpgrade(proxy).freezeUpgrades(implementationV1, implementationV1.codehash);
        }
        assertFalse(GovernedUpgrade(proxy).upgradesFrozen(), "no refused caller froze");
    }

    /// @notice ADR-0014 tests: test_freezeAtDeploy_rejectsUpgrade. `FrozenAtDeploy` freezes inside the
    ///         deployment transaction; no upgrade can ever run.
    function test_freezeAtDeploy_rejectsUpgrade() public {
        address implementation = _newImplementation();
        bytes memory init = _initData(address(timelock), GovernedUpgrade.UpgradeMode.FrozenAtDeploy);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectEmit(true, true, false, true, predicted);
        emit GovernedUpgrade.UpgradesFrozen(predicted, implementation, implementation.codehash);
        address frozen = address(new ERC1967Proxy(implementation, init));
        assertEq(frozen, predicted, "predicted proxy address");
        assertTrue(GovernedUpgrade(frozen).upgradesFrozen(), "frozen at deploy");
        assertEq(GovernedUpgrade(frozen).upgradeAuthority(), address(timelock), "authority stored");

        bytes memory data = _upgradeCall(_newImplementation(), "");
        bytes32 salt = _schedule(frozen, data);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(GovernedUpgrade.UpgradesAreFrozen.selector);
        _execute(frozen, data, salt);
        assertEq(_implementationOf(frozen), implementation, "still the deployed implementation");
    }

    /// @notice ADR-0014 tests: test_freeze_wrongTargetReverts. A freeze names its target: a wrong code
    ///         hash reverts, and so does a freeze scheduled for v1 when an upgrade to v2 executed
    ///         between scheduling and executing it.
    function test_freeze_wrongTargetReverts() public {
        // Wrong code hash for the live implementation.
        bytes memory badHash = abi.encodeCall(
            GovernedUpgrade.freezeUpgrades, (implementationV1, keccak256("not the code"))
        );
        bytes32 badSalt = _schedule(proxy, badHash);

        // A freeze for v1 and an upgrade to v2, both queued.
        address v2 = _newImplementation();
        bytes memory freezeV1 = _freezeCall(implementationV1);
        bytes memory upgradeV2 = _upgradeCall(v2, "");
        bytes32 freezeSalt = _schedule(proxy, freezeV1);
        bytes32 upgradeSalt = _schedule(proxy, upgradeV2);
        vm.warp(block.timestamp + DELAY);

        vm.expectRevert(
            abi.encodeWithSelector(
                GovernedUpgrade.FreezeTargetMismatch.selector,
                implementationV1,
                implementationV1.codehash
            )
        );
        _execute(proxy, badHash, badSalt);

        // The upgrade executes first; the freeze reviewed against v1 can no longer lock anything in.
        _execute(proxy, upgradeV2, upgradeSalt);
        vm.expectRevert(
            abi.encodeWithSelector(GovernedUpgrade.FreezeTargetMismatch.selector, v2, v2.codehash)
        );
        _execute(proxy, freezeV1, freezeSalt);
        assertFalse(GovernedUpgrade(proxy).upgradesFrozen(), "no freeze on an unreviewed target");
    }

    /// @notice ADR-0014 tests: test_freeze_queuedUpgradeFailsAfterFreeze.
    function test_freeze_queuedUpgradeFailsAfterFreeze() public {
        address v2 = _newImplementation();
        bytes memory upgradeV2 = _upgradeCall(v2, "");
        bytes memory freezeV1 = _freezeCall(implementationV1);
        bytes32 upgradeSalt = _schedule(proxy, upgradeV2);
        bytes32 freezeSalt = _schedule(proxy, freezeV1);
        vm.warp(block.timestamp + DELAY);

        _execute(proxy, freezeV1, freezeSalt);
        vm.expectRevert(GovernedUpgrade.UpgradesAreFrozen.selector);
        _execute(proxy, upgradeV2, upgradeSalt);
        assertEq(_implementationOf(proxy), implementationV1, "queued upgrade never landed");
    }

    /// @notice ADR-0014 tests: test_freeze_survivesRoleChangesAndReinitializers. Role changes never
    ///         touch the freeze or the authority, a re-initialize reverts, and an upgrade carrying a
    ///         reinitializer reverts too.
    function test_freeze_survivesRoleChangesAndReinitializers() public {
        _govern(proxy, _freezeCall(implementationV1));

        // A business-role change by the kind's admin: a second ADMIN_ROLE holder.
        vm.prank(deployer);
        IAccessControl(proxy).grantRole(ADMIN_ROLE, stranger);
        assertTrue(IAccessControl(proxy).hasRole(ADMIN_ROLE, stranger), "role change landed");
        assertTrue(GovernedUpgrade(proxy).upgradesFrozen(), "still frozen after role change");
        assertEq(GovernedUpgrade(proxy).upgradeAuthority(), address(timelock), "authority kept");

        // The new admin holds no upgrade power.
        address v2 = _newImplementation();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(GovernedUpgrade.UpgradeNotAuthorized.selector, stranger)
        );
        UUPSUpgradeable(proxy).upgradeToAndCall(v2, "");

        // No re-initialize.
        (bool ok,) = proxy.call(_initData(stranger, GovernedUpgrade.UpgradeMode.Upgradeable));
        assertFalse(ok, "re-initialize after freeze must revert");

        // No upgrade carrying an initializer call, through the timelock.
        bytes memory data =
            _upgradeCall(v2, _initData(address(timelock), GovernedUpgrade.UpgradeMode.Upgradeable));
        bytes32 salt = _schedule(proxy, data);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(GovernedUpgrade.UpgradesAreFrozen.selector);
        _execute(proxy, data, salt);

        assertTrue(GovernedUpgrade(proxy).upgradesFrozen(), "frozen forever");
        assertEq(_implementationOf(proxy), implementationV1, "frozen on v1");
    }
}

// ─── rmUSDC ──────────────────────────────────────────────────────────────────

contract GovernedUpgradeLifecycleRobotMoneyVaultTest is GovernedUpgradeLifecycleBase {
    ExclusionLedgerFactory internal factory;
    NoYieldTestAdapter internal adapter;

    function _prepare() internal override {
        factory = new ExclusionLedgerFactory();
    }

    function _newImplementation() internal override returns (address) {
        return address(new RobotMoneyVault());
    }

    function _initData(address authority, GovernedUpgrade.UpgradeMode mode)
        internal
        view
        override
        returns (bytes memory)
    {
        return abi.encodeCall(
            RobotMoneyVault.initialize,
            (
                IERC20(address(usdc)),
                type(uint256).max,
                type(uint256).max,
                0,
                feeRecipient,
                deployer,
                emergency,
                factory,
                authority,
                mode
            )
        );
    }

    function _privileged() internal view override returns (address[] memory a) {
        a = new address[](2);
        a[0] = deployer;
        a[1] = emergency;
    }

    function _populate() internal override {
        RobotMoneyVault vault = RobotMoneyVault(proxy);
        adapter = new NoYieldTestAdapter(address(usdc), proxy);
        vm.startPrank(deployer);
        vault.setAdapterAllowed(address(adapter), true);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vault.addAdapter(address(adapter), 10_000);
        vault.setExitFeeBps(25);
        vault.setPerDepositCap(5_000e6);
        vm.stopPrank();
        usdc.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usdc.approve(proxy, type(uint256).max);
        vault.deposit(1_000e6, alice);
        vault.approve(feeRecipient, 123e18);
        vm.stopPrank();
        assertGt(usdc.balanceOf(address(adapter)), 0, "the deposit reached the adapter");
    }

    /// @dev Balances, allowances, roles, fees, caps and the adapter position (#1808 test plan).
    function _state() internal view override returns (bytes32) {
        RobotMoneyVault v = RobotMoneyVault(proxy);
        (address a0, uint16 cap0, bool active0, uint256 balance0, uint256 target0) =
            v.getAdapterInfo(0);
        bytes32 position = keccak256(
            abi.encode(a0, cap0, active0, balance0, target0, usdc.balanceOf(address(adapter)))
        );
        return keccak256(
            abi.encode(
                keccak256(
                    abi.encode(
                        v.totalSupply(),
                        v.totalAssets(),
                        v.balanceOf(alice),
                        v.allowance(alice, feeRecipient),
                        v.tvlCap(),
                        v.perDepositCap(),
                        v.exitFeeBps(),
                        v.feeRecipient(),
                        v.adapterCount()
                    )
                ),
                keccak256(
                    abi.encode(
                        address(v.exclusionLedger()),
                        v.hasRole(ADMIN_ROLE, deployer),
                        v.hasRole(keccak256("EMERGENCY_ROLE"), emergency),
                        v.adapterAllowed(address(adapter)),
                        v.name(),
                        v.symbol(),
                        v.asset()
                    )
                ),
                position
            )
        );
    }

    /// @notice ADR-0014 tests: test_frozenProxyKeepsRedeemAndRedeemInKindOpen (rmUSDC has no in-kind
    ///         exit: its USDC `redeem` and `withdraw` are the exits). After a governed upgrade with a
    ///         reinitializer and a freeze, the holder still exits in full.
    function test_frozenProxyKeepsRedeemAndRedeemInKindOpen() public {
        RobotMoneyVault vault = RobotMoneyVault(proxy);
        RobotMoneyVaultV2 v2 = new RobotMoneyVaultV2();
        _govern(
            proxy, _upgradeCall(address(v2), abi.encodeCall(RobotMoneyVaultV2.initializeV2, (7)))
        );
        assertEq(RobotMoneyVaultV2(proxy).v2Marker(), 7, "reinitializer ran with the upgrade");
        vm.prank(address(timelock));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        RobotMoneyVaultV2(proxy).initializeV2(8);

        _govern(proxy, _freezeCall(address(v2)));
        assertTrue(GovernedUpgrade(proxy).upgradesFrozen(), "frozen");

        uint256 shares = vault.balanceOf(alice);
        vm.startPrank(alice);
        vault.withdraw(100e6, alice, alice);
        vault.redeem(vault.balanceOf(alice), alice, alice);
        vm.stopPrank();
        assertGt(shares, 0, "alice held shares");
        assertEq(vault.balanceOf(alice), 0, "alice exited in full");
        // `_populate` set a 25 bps exit fee; the fee survived the upgrade and the freeze.
        assertApproxEqAbs(
            usdc.balanceOf(alice), 1_000e6 * (10_000 - 25) / 10_000, 10, "alice got her USDC back"
        );
    }

    /// @notice #1808 test plan "unauthorized reinitializers". An upgrade installed with empty data
    ///         leaves v2's reinitializer pending. No stranger, role holder, deployer or Safe acting
    ///         directly can run it (`onlyUpgradeAuthority`); only a later timelock operation can,
    ///         and only once.
    function test_reinitializer_pendingAfterEmptyUpgrade_refusesEveryoneButTheTimelock() public {
        RobotMoneyVaultV2 v2 = new RobotMoneyVaultV2();
        bytes32 before = _state();
        _govern(proxy, _upgradeCall(address(v2), ""));
        assertEq(_implementationOf(proxy), address(v2), "upgraded with empty data");

        address[] memory refused = _refused();
        for (uint256 i = 0; i < refused.length; i++) {
            vm.prank(refused[i]);
            vm.expectRevert(
                abi.encodeWithSelector(GovernedUpgrade.UpgradeNotAuthorized.selector, refused[i])
            );
            RobotMoneyVaultV2(proxy).initializeV2(666);
        }
        assertEq(RobotMoneyVaultV2(proxy).v2Marker(), 0, "no refused caller ran the reinitializer");
        assertEq(_state(), before, "state untouched by the refused calls");

        _govern(proxy, abi.encodeCall(RobotMoneyVaultV2.initializeV2, (9)));
        assertEq(
            RobotMoneyVaultV2(proxy).v2Marker(), 9, "the timelock ran the pending reinitializer"
        );

        bytes memory again = abi.encodeCall(RobotMoneyVaultV2.initializeV2, (10));
        bytes32 salt = _schedule(proxy, again);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        _execute(proxy, again, salt);
        assertEq(RobotMoneyVaultV2(proxy).v2Marker(), 9, "a reinitializer runs once");
    }

    /// @notice UPG-3: the upgrade authority is write-once. A timelock-executed upgrade whose
    ///         reinitializer re-runs `__GovernedUpgrade_init` with a new authority reverts
    ///         `InvalidInitialization`, so the whole upgrade rolls back: the implementation, the
    ///         authority and the state stay as they were, and the timelock can still freeze.
    function test_reinitializer_cannotRotateUpgradeAuthority() public {
        RobotMoneyVaultV2RotatesAuthority v2 = new RobotMoneyVaultV2RotatesAuthority();
        // Any contract would pass the "authority has code" check; the write-once check fires first.
        address other = address(routerGovernance);
        bytes32 before = _state();
        bytes memory data = _upgradeCall(
            address(v2), abi.encodeCall(RobotMoneyVaultV2RotatesAuthority.rotateAuthority, (other))
        );
        bytes32 salt = _schedule(proxy, data);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        _execute(proxy, data, salt);

        assertEq(GovernedUpgrade(proxy).upgradeAuthority(), address(timelock), "authority kept");
        assertEq(_implementationOf(proxy), implementationV1, "the upgrade rolled back");
        assertEq(_state(), before, "state kept");
        _govern(proxy, _freezeCall(implementationV1));
        assertTrue(GovernedUpgrade(proxy).upgradesFrozen(), "the authority can still freeze");
    }
}

// ─── Basket kinds ────────────────────────────────────────────────────────────

/// @dev Shared basket fixture: one V3 asset priced 1:1 by `MockPool`, swaps filled by
///      `MockSwapRouter` (both from BasketVault.t.sol).
abstract contract GovernedUpgradeLifecycleBasketBase is GovernedUpgradeLifecycleBase {
    TestERC20 internal basketToken;
    MockSwapRouter internal swapRouter;
    MockPool internal pool;

    function _prepare() internal override {
        basketToken = new TestERC20();
        swapRouter = new MockSwapRouter();
        pool = new MockPool(address(basketToken), address(usdc), uint160(1 << 96));
    }

    function _initData(address authority, GovernedUpgrade.UpgradeMode mode)
        internal
        view
        override
        returns (bytes memory)
    {
        return abi.encodeCall(
            BasketVault.initialize,
            (
                IERC20(address(usdc)),
                ISwapRouter(address(swapRouter)),
                type(uint256).max,
                type(uint256).max,
                0,
                feeRecipient,
                deployer,
                emergency,
                authority,
                mode
            )
        );
    }

    function _privileged() internal view override returns (address[] memory a) {
        a = new address[](2);
        a[0] = deployer;
        a[1] = emergency;
    }

    function _populate() internal override {
        BasketVault vault = BasketVault(proxy);
        vm.prank(deployer);
        vault.addAsset(
            address(basketToken), address(pool), 500, address(0), BasketAssetConfigGuard.Venue.V3
        );
        usdc.mint(alice, 1_000e6);
        basketToken.mint(address(swapRouter), 1_000e6);
        swapRouter.setAmountOut(1_000e6);
        vm.startPrank(alice);
        usdc.approve(proxy, type(uint256).max);
        vault.deposit(1_000e6, alice);
        vault.approve(feeRecipient, 77e18);
        vm.stopPrank();
        vm.startPrank(deployer);
        vault.setExitFeeBps(30);
        vault.setPerDepositCap(9_000e6);
        vm.stopPrank();
    }

    /// @dev Balances, allowances, roles, fees, caps and the basket position (#1808 test plan).
    function _state() internal view override returns (bytes32) {
        BasketVault v = BasketVault(proxy);
        (bool ok, bytes memory asset0) =
            proxy.staticcall(abi.encodeWithSignature("assets(uint256)", uint256(0)));
        require(ok, "assets(0)");
        return keccak256(
            abi.encode(
                keccak256(
                    abi.encode(
                        v.totalSupply(),
                        v.totalAssets(),
                        v.balanceOf(alice),
                        v.allowance(alice, feeRecipient),
                        v.tvlCap(),
                        v.perDepositCap(),
                        v.exitFeeBps(),
                        v.feeRecipient(),
                        v.maxSlippageBps()
                    )
                ),
                keccak256(
                    abi.encode(
                        v.assetCount(),
                        keccak256(asset0),
                        basketToken.balanceOf(proxy),
                        v.effectiveTwapWindow(address(basketToken)),
                        address(v.SWAP_ROUTER()),
                        v.hasRole(ADMIN_ROLE, deployer),
                        v.hasRole(keccak256("EMERGENCY_ROLE"), emergency),
                        v.name(),
                        v.symbol(),
                        v.asset()
                    )
                )
            )
        );
    }

    /// @notice ADR-0014 tests: test_frozenProxyKeepsRedeemAndRedeemInKindOpen. After a governed
    ///         upgrade and a freeze, `redeemInKind` and the USDC `redeem` both pay the holder.
    function test_frozenProxyKeepsRedeemAndRedeemInKindOpen() public {
        BasketVault vault = BasketVault(proxy);
        address v2 = _newImplementation();
        _govern(proxy, _upgradeCall(v2, ""));
        _govern(proxy, _freezeCall(v2));
        assertTrue(GovernedUpgrade(proxy).upgradesFrozen(), "frozen");

        uint256 shares = vault.balanceOf(alice);
        assertGt(shares, 0, "alice held shares");

        // Oracle-free exit: half the shares in kind.
        vm.prank(alice);
        vault.redeemInKind(shares / 2, alice, alice);
        assertGt(basketToken.balanceOf(alice), 0, "redeemInKind paid the basket token");

        // USDC exit for the rest: the router fills the sale above the 1% TWAP floor.
        uint256 rest = vault.balanceOf(alice);
        usdc.mint(address(swapRouter), 500e6);
        swapRouter.setAmountOut(499e6);
        vm.prank(alice);
        uint256 out = vault.redeem(rest, alice, alice);
        assertGt(out, 0, "redeem paid USDC");
        assertEq(vault.balanceOf(alice), 0, "alice exited in full");
    }
}

contract GovernedUpgradeLifecycleProtocolAssetVaultTest is GovernedUpgradeLifecycleBasketBase {
    function _newImplementation() internal override returns (address) {
        return address(new ProtocolAssetVault());
    }
}

contract GovernedUpgradeLifecycleAgentTokenVaultTest is GovernedUpgradeLifecycleBasketBase {
    function _newImplementation() internal override returns (address) {
        return address(new AgentTokenVault());
    }
}

contract GovernedUpgradeLifecycleRwaBasketVaultTest is GovernedUpgradeLifecycleBasketBase {
    function _newImplementation() internal override returns (address) {
        return address(new RwaBasketVault());
    }
}

// ─── Router and registry ─────────────────────────────────────────────────────

contract GovernedUpgradeLifecyclePortfolioRouterTest is GovernedUpgradeLifecycleBase {
    VaultRegistry internal registry;
    RobotMoneyVault internal leg;

    /// @dev A real registry and one eligible vault, so the router can hold a weight vector.
    function _prepare() internal override {
        registry = Proxied.vaultRegistry(deployer);
        leg = Proxied.robotMoneyVault(
            IERC20(address(usdc)),
            type(uint256).max,
            type(uint256).max,
            0,
            feeRecipient,
            deployer,
            emergency
        );
        vm.startPrank(deployer);
        registry.registerVault(
            address(leg),
            VaultRegistry.VaultMetadata({name: "Leg", asset: address(usdc), registeredAt: 0})
        );
        registry.setRouterEligible(address(leg), true);
        vm.stopPrank();
    }

    function _newImplementation() internal override returns (address) {
        return address(new PortfolioRouter());
    }

    function _initData(address authority, GovernedUpgrade.UpgradeMode mode)
        internal
        view
        override
        returns (bytes memory)
    {
        return abi.encodeCall(
            PortfolioRouter.initialize,
            (address(usdc), address(registry), deployer, authority, mode)
        );
    }

    function _privileged() internal view override returns (address[] memory a) {
        a = new address[](1);
        a[0] = deployer; // ADMIN, WEIGHT_SETTER, ROTATOR and ROTATION_EXECUTOR at birth
    }

    /// @dev Caps and both weight vectors (#1808 test plan "weights").
    function _populate() internal override {
        PortfolioRouter r = PortfolioRouter(proxy);
        address[] memory vaults = new address[](1);
        vaults[0] = address(leg);
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;
        vm.startPrank(deployer);
        r.setRouterCap(123e6);
        r.setVaultCap(address(leg), 77e6);
        r.setDefaultWeights(vaults, bps);
        r.setWeights(vaults, bps);
        vm.stopPrank();
        assertTrue(r.votedWeightsActive(), "applied vector active");
    }

    function _state() internal view override returns (bytes32) {
        PortfolioRouter r = PortfolioRouter(proxy);
        (address[] memory wv, uint256[] memory wb) = r.getWeights();
        (address[] memory dv, uint256[] memory db) = r.getDefaultWeights();
        return keccak256(
            abi.encode(
                keccak256(abi.encode(wv, wb, dv, db, r.votedWeightsActive())),
                r.routerCap(),
                r.vaultCap(address(leg)),
                address(r.usdc()),
                address(r.registry()),
                r.quarantineAddress(),
                r.hasRole(ADMIN_ROLE, deployer),
                r.hasRole(r.WEIGHT_SETTER_ROLE(), deployer)
            )
        );
    }
}

contract GovernedUpgradeLifecycleVaultRegistryTest is GovernedUpgradeLifecycleBase {
    address internal listed = makeAddr("listedVault");

    function _newImplementation() internal override returns (address) {
        return address(new VaultRegistry());
    }

    function _initData(address authority, GovernedUpgrade.UpgradeMode mode)
        internal
        view
        override
        returns (bytes memory)
    {
        return abi.encodeCall(VaultRegistry.initialize, (deployer, authority, mode));
    }

    function _privileged() internal view override returns (address[] memory a) {
        a = new address[](1);
        a[0] = deployer;
    }

    function _populate() internal override {
        vm.prank(deployer);
        VaultRegistry(proxy)
            .registerVault(
                listed,
                VaultRegistry.VaultMetadata({name: "Listed", asset: address(usdc), registeredAt: 0})
            );
    }

    function _state() internal view override returns (bytes32) {
        VaultRegistry r = VaultRegistry(proxy);
        return keccak256(
            abi.encode(
                r.listVaults(),
                r.routerEligibleCount(),
                address(r.router()),
                r.hasRole(ADMIN_ROLE, deployer)
            )
        );
    }
}

// ─── Gateway, IC policy, receipt ─────────────────────────────────────────────

contract GovernedUpgradeLifecycleRobotMoneyGatewayTest is GovernedUpgradeLifecycleBase {
    RobotMoneyVault internal vault;
    address internal pauser = makeAddr("pauser");
    address internal agent = makeAddr("agent");

    function _prepare() internal override {
        vault = Proxied.robotMoneyVault(
            IERC20(address(usdc)),
            type(uint256).max,
            type(uint256).max,
            0,
            feeRecipient,
            deployer,
            emergency
        );
    }

    function _newImplementation() internal override returns (address) {
        return address(new RobotMoneyGateway());
    }

    function _initData(address authority, GovernedUpgrade.UpgradeMode mode)
        internal
        view
        override
        returns (bytes memory)
    {
        return abi.encodeCall(
            RobotMoneyGateway.initialize,
            (
                IERC20(address(usdc)),
                IERC4626(address(vault)),
                deployer,
                pauser,
                address(0),
                authority,
                mode
            )
        );
    }

    function _privileged() internal view override returns (address[] memory a) {
        a = new address[](3);
        a[0] = deployer; // ADMIN_ROLE and DEFAULT_ADMIN_ROLE
        a[1] = pauser; // DEPOSIT_PAUSER_ROLE
        a[2] = agent; // AGENT_ROLE after `_populate`
    }

    function _populate() internal override {
        address[] memory none = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: 100e6,
            maxPerWindow: 1_000e6,
            shareReceiver: alice,
            allowedDestinations: none,
            assetRecipient: alice,
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: none
        });
        vm.prank(deployer);
        RobotMoneyGateway(proxy).authorizeAgent(agent, p);
    }

    /// @dev The gateway policy itself (`agents(agent)`), its owner, roles and pause state.
    function _state() internal view override returns (bytes32) {
        RobotMoneyGateway g = RobotMoneyGateway(proxy);
        (bool ok, bytes memory policy) =
            proxy.staticcall(abi.encodeWithSignature("agents(address)", agent));
        require(ok, "agents(agent)");
        return keccak256(
            abi.encode(
                keccak256(policy),
                g.usdc(),
                g.vault(),
                g.router(),
                g.agentOwner(agent),
                g.agentConsentNonce(agent),
                g.hasRole(g.AGENT_ROLE(), agent),
                g.hasRole(ADMIN_ROLE, deployer),
                g.depositsPaused()
            )
        );
    }
}

contract GovernedUpgradeLifecycleInvestmentCommitteePolicyTest is GovernedUpgradeLifecycleBase {
    address internal member = makeAddr("member");

    function _newImplementation() internal override returns (address) {
        return address(new InvestmentCommitteePolicy());
    }

    function _initData(address authority, GovernedUpgrade.UpgradeMode mode)
        internal
        view
        override
        returns (bytes memory)
    {
        return abi.encodeCall(
            InvestmentCommitteePolicy.initialize, (deployer, gatewayStandIn, authority, mode)
        );
    }

    function _privileged() internal view override returns (address[] memory a) {
        a = new address[](2);
        a[0] = deployer;
        a[1] = member;
    }

    function _populate() internal override {
        vm.prank(deployer);
        InvestmentCommitteePolicy(proxy).registerAgent(member, "member-1");
        vm.prank(gatewayStandIn);
        InvestmentCommitteePolicy(proxy)
            .submitVote(
                InvestmentCommitteePolicy.VoteParams({
                    agent: member,
                    vault: makeAddr("votedVault"),
                    stance: InvestmentCommitteePolicy.Stance.Overweight,
                    targetWeightBps: 4_000,
                    confidence: 80,
                    rationaleUri: "https://example.invalid/rationale",
                    voteJsonHash: keccak256("vote"),
                    promptHash: keccak256("prompt"),
                    inputsDigest: keccak256("inputs"),
                    schemaVersion: "1",
                    timestamp: uint64(block.timestamp)
                })
            );
    }

    /// @dev The roster and the vote log.
    function _state() internal view override returns (bytes32) {
        InvestmentCommitteePolicy c = InvestmentCommitteePolicy(proxy);
        return keccak256(
            abi.encode(
                c.gateway(),
                c.agentId(member),
                c.hasRole(c.COMMITTEE_AGENT_ROLE(), member),
                c.hasRole(ADMIN_ROLE, deployer),
                c.voteCount(),
                keccak256(abi.encode(c.getVote(0))),
                c.latestVoteByAgent(member)
            )
        );
    }
}

contract GovernedUpgradeLifecycleConsensusRecommendationReceiptTest is
    GovernedUpgradeLifecycleBase
{
    function _newImplementation() internal override returns (address) {
        return address(new ConsensusRecommendationReceipt());
    }

    function _initData(address authority, GovernedUpgrade.UpgradeMode mode)
        internal
        view
        override
        returns (bytes memory)
    {
        return abi.encodeCall(
            ConsensusRecommendationReceipt.initialize,
            (deployer, gatewayStandIn, icPolicyStandIn, authority, mode)
        );
    }

    address internal submitter = makeAddr("submitter");

    function _privileged() internal view override returns (address[] memory a) {
        a = new address[](1);
        a[0] = deployer;
    }

    /// @dev Two recorded receipts, one released (#1808 test plan "receipts"). The IC policy is a
    ///      stand-in whose `hasRole` answers true for the submitter.
    function _populate() internal override {
        // Give the stand-in code so no extcodesize check can refuse the mocked call.
        vm.etch(icPolicyStandIn, hex"00");
        vm.mockCall(
            icPolicyStandIn,
            abi.encodeCall(IAccessControl.hasRole, (keccak256("COMMITTEE_AGENT_ROLE"), submitter)),
            abi.encode(true)
        );
        ConsensusRecommendationReceipt r = ConsensusRecommendationReceipt(proxy);
        vm.startPrank(gatewayStandIn);
        r.recordReceipt(submitter, keccak256("receipt-1"), keccak256("payload-1"), "https://x/1");
        r.recordReceipt(submitter, keccak256("receipt-2"), keccak256("payload-2"), "https://x/2");
        vm.stopPrank();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(deployer);
        r.releaseReceipt(keccak256("receipt-1"));
    }

    function _state() internal view override returns (bytes32) {
        ConsensusRecommendationReceipt r = ConsensusRecommendationReceipt(proxy);
        return keccak256(
            abi.encode(
                r.gateway(),
                r.icPolicy(),
                r.hasRole(ADMIN_ROLE, deployer),
                r.receiptCount(),
                keccak256(abi.encode(r.getReceipt(0), r.getReceipt(1))),
                r.isReleased(keccak256("receipt-1")),
                r.isReleased(keccak256("receipt-2")),
                r.isRecorded(keccak256("receipt-2"))
            )
        );
    }

    /// @notice #1808 test plan "receipts survive": both records and the release state read the same
    ///         after a governed upgrade, and the new implementation still records and releases.
    function test_receipts_surviveGovernedUpgrade() public {
        ConsensusRecommendationReceipt r = ConsensusRecommendationReceipt(proxy);
        assertEq(r.receiptCount(), 2, "populated");
        bytes32 before = _state();
        _govern(proxy, _upgradeCall(_newImplementation(), ""));
        assertEq(_state(), before, "receipts kept");
        vm.prank(gatewayStandIn);
        r.recordReceipt(submitter, keccak256("receipt-3"), keccak256("payload-3"), "https://x/3");
        vm.prank(deployer);
        r.releaseReceipt(keccak256("receipt-2"));
        assertEq(r.receiptCount(), 3, "v2 records");
        assertTrue(r.isReleased(keccak256("receipt-2")), "v2 releases a v1 receipt");
    }
}
