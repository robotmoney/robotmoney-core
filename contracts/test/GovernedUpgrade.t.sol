// SPDX-License-Identifier: MIT
// Canonical: docs/technical/contract-upgradeability-plan.md — Mechanism and authority, Delivery step 3
// (See also: docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md; issue 1808)
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {GovernedUUPS, GovernedUpgrade} from "../lib/GovernedUUPS.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ProtocolAssetVault} from "../vaults/ProtocolAssetVault.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {RwaBasketVault} from "../vaults/RwaBasketVault.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {ConsensusRecommendationReceipt} from "../ConsensusRecommendationReceipt.sol";
import {IConsensusRecommendationReceipt} from "../interfaces/IConsensusRecommendationReceipt.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";

import {CoreProxies} from "./helpers/CoreProxies.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {NoYieldTestAdapter} from "./helpers/NoYieldTestAdapter.sol";
import {
    RobotMoneyVaultV2,
    ProtocolAssetVaultV2,
    AgentTokenVaultV2,
    RwaBasketVaultV2,
    VaultRegistryV2,
    PortfolioRouterV2,
    RobotMoneyGatewayV2,
    ConsensusRecommendationReceiptV2,
    RouterGovernanceV2,
    VaultRegistryV2Reinit,
    NotUUPS,
    WrongUUID,
    UPGRADE_V2_MARKER
} from "./helpers/UpgradeV2.sol";
import {AgentRegistration} from "./helpers/AgentRegistration.sol";

interface IUpgradeMarker {
    function upgradeMarker() external view returns (uint256);
}

/// @notice Issue 1808: the nine proxied core contracts, their one upgrade authority (the Safe-controlled
///         timelock) and the one-way, target-bound freeze. Every governed call here goes through a
///         real SafeL2 1.4.1 (2-of-3) and a real `TimelockController` with the production shape.
///         The populated v1 -> v2 upgrade of the deployed stack on the Base fork is
///         UpgradeLifecycleFork.t.sol.
contract GovernedUpgradeTest is SafeGovernance {
    using stdJson for string;

    uint256 internal constant DELAY = 2 days;
    uint256 internal constant N = 9;
    uint256 internal constant CAP = 1_000_000e6;

    /// @dev keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Initializable")) - 1)) & ~0xff
    bytes32 internal constant INITIALIZABLE_SLOT =
        0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;
    /// @dev keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ReentrancyGuard")) - 1)) & ~0xff
    bytes32 internal constant REENTRANCY_SLOT =
        0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00;

    address internal safe;
    TimelockController internal timelock;

    address internal admin = makeAddr("admin");
    address internal emergency = makeAddr("emergency");
    address internal pauser = makeAddr("pauser");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal stranger = makeAddr("stranger");
    address internal swapRouter = makeAddr("swapRouter");
    address internal agent = makeAddr("agent");
    address internal submitter = makeAddr("submitter");

    TestERC20 internal usdc;
    RobotMoneyVault internal vault;
    ProtocolAssetVault internal proto;
    AgentTokenVault internal agentVault;
    RwaBasketVault internal rwa;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RobotMoneyGateway internal gateway;
    ConsensusRecommendationReceipt internal receipts;
    RouterGovernance internal governance;

    uint256 internal saltNonce;
    address internal positionAdapter;

    function setUp() public {
        _installSafeSet();
        safe = _newDefaultSafe();
        timelock = _newGovTimelock(safe, DELAY);
        CoreProxies.useUpgradeConfig(address(timelock), GovernedUUPS.UpgradeMode.Upgradeable);

        usdc = new TestERC20();
        vault = CoreProxies.robotMoneyVault(usdc, CAP, CAP, 0, feeRecipient, admin, emergency);
        proto = CoreProxies.protocolAssetVault(
            usdc, ISwapRouter(swapRouter), CAP, CAP, 0, feeRecipient, admin, emergency
        );
        agentVault = CoreProxies.agentTokenVault(
            usdc, ISwapRouter(swapRouter), CAP, CAP, 0, feeRecipient, admin, emergency
        );
        rwa = CoreProxies.rwaBasketVault(
            usdc, ISwapRouter(swapRouter), CAP, CAP, 0, feeRecipient, admin, emergency
        );
        registry = CoreProxies.vaultRegistry(admin);
        router = CoreProxies.portfolioRouter(address(usdc), address(registry), admin);
        gateway = CoreProxies.robotMoneyGateway(usdc, vault, admin, pauser, address(router));
        receipts = CoreProxies.consensusRecommendationReceipt(admin);
        governance = CoreProxies.routerGovernance(address(router), address(receipts), admin);
    }

    // ─── Tables over the nine contracts ─────────────────────────────────────────

    function _proxies() internal view returns (address[N] memory p) {
        p = [
            address(vault),
            address(proto),
            address(agentVault),
            address(rwa),
            address(registry),
            address(router),
            address(gateway),
            address(receipts),
            address(governance)
        ];
    }

    function _name(uint256 i) internal pure returns (string memory) {
        string[N] memory names = [
            "RobotMoneyVault",
            "ProtocolAssetVault",
            "AgentTokenVault",
            "RwaBasketVault",
            "VaultRegistry",
            "PortfolioRouter",
            "RobotMoneyGateway",
            "ConsensusRecommendationReceipt",
            "RouterGovernance"
        ];
        return names[i];
    }

    function _basket() internal view returns (BasketVault.InitParams memory) {
        return CoreProxies.basketParams(
            usdc, ISwapRouter(swapRouter), CAP, CAP, 0, feeRecipient, admin, emergency
        );
    }

    /// @dev The initializer call of contract `i`, with the same arguments its proxy was built with.
    function _init(uint256 i, address t, GovernedUUPS.UpgradeMode m)
        internal
        view
        returns (bytes memory)
    {
        if (i == 0) {
            return abi.encodeCall(
                RobotMoneyVault.initialize,
                (usdc, CAP, CAP, 0, feeRecipient, admin, emergency, t, m)
            );
        }
        if (i == 1) return abi.encodeCall(ProtocolAssetVault.initialize, (_basket(), t, m));
        if (i == 2) return abi.encodeCall(AgentTokenVault.initialize, (_basket(), t, m));
        if (i == 3) return abi.encodeCall(RwaBasketVault.initialize, (_basket(), t, m));
        if (i == 4) return abi.encodeCall(VaultRegistry.initialize, (admin, t, m));
        if (i == 5) {
            return abi.encodeCall(
                PortfolioRouter.initialize, (address(usdc), address(registry), admin, t, m)
            );
        }
        if (i == 6) {
            return abi.encodeCall(RobotMoneyGateway.initialize, (usdc, admin, pauser, t, m));
        }
        if (i == 7) {
            return abi.encodeCall(ConsensusRecommendationReceipt.initialize, (admin, t, m));
        }
        return abi.encodeCall(
            RouterGovernance.initialize, (address(router), address(receipts), admin, t, m)
        );
    }

    /// @dev A fresh v1 implementation of contract `i`.
    function _newImpl(uint256 i) internal returns (address) {
        if (i == 0) return address(new RobotMoneyVault());
        if (i == 1) return address(new ProtocolAssetVault());
        if (i == 2) return address(new AgentTokenVault());
        if (i == 3) return address(new RwaBasketVault());
        if (i == 4) return address(new VaultRegistry());
        if (i == 5) return address(new PortfolioRouter());
        if (i == 6) return address(new RobotMoneyGateway());
        if (i == 7) return address(new ConsensusRecommendationReceipt());
        return address(new RouterGovernance());
    }

    /// @dev The v2 implementation of contract `i`.
    function _newV2(uint256 i) internal returns (address) {
        if (i == 0) return address(new RobotMoneyVaultV2());
        if (i == 1) return address(new ProtocolAssetVaultV2());
        if (i == 2) return address(new AgentTokenVaultV2());
        if (i == 3) return address(new RwaBasketVaultV2());
        if (i == 4) return address(new VaultRegistryV2());
        if (i == 5) return address(new PortfolioRouterV2());
        if (i == 6) return address(new RobotMoneyGatewayV2());
        if (i == 7) return address(new ConsensusRecommendationReceiptV2());
        return address(new RouterGovernanceV2());
    }

    function _salt() internal returns (bytes32) {
        return keccak256(abi.encode("governed-upgrade", ++saltNonce));
    }

    /// @dev Safe -> timelock.schedule -> delay -> timelock.execute of `target.call(data)`.
    function _governed(address target, bytes memory data) internal {
        _govRun(safe, timelock, target, data, _salt(), DELAY);
    }

    function _upgradeCall(address impl, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeCall(GovernedUUPS.upgradeToAndCall, (impl, data));
    }

    function _freezeCall(address proxy) internal view returns (bytes memory) {
        address impl = CoreProxies.implementationOf(proxy);
        return abi.encodeCall(GovernedUUPS.freezeUpgrades, (impl, impl.codehash));
    }

    function _initializedVersion(address target) internal view returns (uint64) {
        return uint64(uint256(vm.load(target, INITIALIZABLE_SLOT)));
    }

    // ─── Initial state ─────────────────────────────────────────────────────────

    /// @notice Each core contract is an initialized ERC-1967 proxy that names the timelock, is not
    ///         frozen, and points at an implementation with code. `proxiableUUID` answers only on
    ///         the implementation.
    function test_everyCoreContract_isAnInitializedProxyNamingTheTimelock() public {
        address[N] memory p = _proxies();
        for (uint256 i = 0; i < N; i++) {
            GovernedUUPS g = GovernedUUPS(p[i]);
            address impl = CoreProxies.implementationOf(p[i]);
            assertTrue(impl.code.length > 0, _name(i));
            assertTrue(impl != p[i], _name(i));
            assertEq(g.upgradeTimelock(), address(timelock), _name(i));
            assertFalse(g.upgradesFrozen(), _name(i));
            assertEq(_initializedVersion(p[i]), 1, string.concat(_name(i), ": initialized once"));
            vm.expectRevert(GovernedUUPS.UUPSUnauthorizedCallContext.selector);
            g.proxiableUUID();
            assertEq(GovernedUUPS(impl).proxiableUUID(), ERC1967Utils.IMPLEMENTATION_SLOT, _name(i));
        }
    }

    /// @notice Every parent is initialized by the one `initialize` call: the ERC-20 / ERC-4626
    ///         state, the roles, the reentrancy guard and the upgrade authority are all set.
    function test_everyParentIsInitialized() public view {
        assertEq(vault.name(), "Robot Money USDC");
        assertEq(vault.symbol(), "rmUSDC");
        assertEq(vault.asset(), address(usdc));
        assertEq(vault.decimals(), 6);
        assertEq(proto.symbol(), "rmPROTO");
        assertEq(agentVault.symbol(), "rmAGENT");
        assertEq(rwa.symbol(), "rmRWA");
        assertEq(rwa.asset(), address(usdc));
        assertEq(address(rwa.SWAP_ROUTER()), swapRouter);
        assertTrue(vault.hasRole(vault.ADMIN_ROLE(), admin));
        assertTrue(vault.hasRole(vault.EMERGENCY_ROLE(), emergency));
        assertEq(vault.adminCount(), 1);
        assertTrue(proto.hasRole(proto.EMERGENCY_ROLE(), emergency));
        assertTrue(registry.hasRole(registry.ADMIN_ROLE(), admin));
        assertEq(address(router.usdc()), address(usdc));
        assertEq(address(router.registry()), address(registry));
        assertEq(gateway.usdc(), address(usdc));
        assertTrue(gateway.hasRole(gateway.DEPOSIT_PAUSER_ROLE(), pauser));
        assertEq(
            address(uint160(uint256(vm.load(address(receipts), bytes32(0))))),
            address(0),
            "retired receipt writer slot"
        );
        assertEq(receipts.icPolicy(), address(0), "retired receipt IC slot");
        assertEq(address(governance.receipts()), address(receipts));
        address[N] memory p = _proxies();
        for (uint256 i = 0; i < N; i++) {
            if (i == 4) continue; // VaultRegistry has no reentrancy guard
            assertEq(uint256(vm.load(p[i], REENTRANCY_SLOT)), 1, _name(i));
        }
    }

    // ─── Implementation takeover, replay, missing and double initialization ────

    /// @notice No implementation can be initialized, upgraded or frozen directly.
    function test_implementationTakeover_isImpossible() public {
        address[N] memory p = _proxies();
        for (uint256 i = 0; i < N; i++) {
            address impl = CoreProxies.implementationOf(p[i]);
            assertEq(_initializedVersion(impl), type(uint64).max, _name(i));
            vm.prank(stranger);
            vm.expectRevert(Initializable.InvalidInitialization.selector);
            (bool ok,) = impl.call(_init(i, stranger, GovernedUUPS.UpgradeMode.Upgradeable));
            ok;
            address target = address(new NotUUPS());
            vm.prank(stranger);
            vm.expectRevert(GovernedUUPS.UUPSUnauthorizedCallContext.selector);
            GovernedUUPS(impl).upgradeToAndCall(target, "");
            vm.prank(address(timelock));
            vm.expectRevert(GovernedUUPS.UUPSUnauthorizedCallContext.selector);
            GovernedUUPS(impl).freezeUpgrades(impl, impl.codehash);
        }
    }

    /// @notice An initializer runs once: a replay reverts for every caller, including the timelock.
    function test_initializerReplay_reverts() public {
        address[N] memory p = _proxies();
        address[3] memory callers = [stranger, admin, address(timelock)];
        for (uint256 i = 0; i < N; i++) {
            for (uint256 c = 0; c < callers.length; c++) {
                vm.prank(callers[c]);
                (bool ok, bytes memory ret) =
                    p[i].call(_init(i, callers[c], GovernedUUPS.UpgradeMode.Upgradeable));
                assertFalse(ok, _name(i));
                assertEq(bytes4(ret), Initializable.InvalidInitialization.selector, _name(i));
            }
        }
    }

    /// @notice A proxy built without its initializer call names no authority: nobody can upgrade
    ///         or freeze it. The deploy scripts never build one (the init call is in the proxy's
    ///         constructor), and the timelock stage refuses any proxy that does not name it.
    function test_missingInitialization_leavesNoUpgradeAuthority() public {
        address bare = CoreProxies.proxy(_newImpl(4), "");
        assertEq(GovernedUUPS(bare).upgradeTimelock(), address(0));
        address v2 = _newV2(4);
        vm.prank(address(timelock));
        vm.expectRevert(
            abi.encodeWithSelector(GovernedUpgrade.NotUpgradeTimelock.selector, address(timelock))
        );
        GovernedUUPS(bare).upgradeToAndCall(v2, "");
    }

    /// @notice A parent initializer outside an initializer reverts, and the upgrade authority
    ///         cannot be initialized a second time by a later reinitializer.
    function test_doubleParentInitialization_reverts() public {
        VaultRegistryV2Reinit v2 = new VaultRegistryV2Reinit();
        _governed(
            address(registry),
            _upgradeCall(address(v2), abi.encodeCall(VaultRegistryV2Reinit.initializeV2, (7)))
        );
        VaultRegistryV2Reinit r = VaultRegistryV2Reinit(address(registry));
        vm.expectRevert(Initializable.NotInitializing.selector);
        r.reinitParents();
        vm.expectRevert(GovernedUpgrade.InvalidInitialization.selector);
        r.initializeV3RenamesAuthority(stranger);
        assertEq(registry.upgradeTimelock(), address(timelock), "authority unchanged");
    }

    /// @notice A reinitializer runs once, inside the governed upgrade call. Anyone calling it
    ///         again, or the v1 initializer, is refused.
    function test_reinitializer_runsOnceInsideTheGovernedUpgrade() public {
        VaultRegistryV2Reinit v2 = new VaultRegistryV2Reinit();
        _governed(
            address(registry),
            _upgradeCall(address(v2), abi.encodeCall(VaultRegistryV2Reinit.initializeV2, (7)))
        );
        VaultRegistryV2Reinit r = VaultRegistryV2Reinit(address(registry));
        assertEq(r.v2Value(), 7);
        assertEq(_initializedVersion(address(registry)), 2);
        vm.prank(stranger);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        r.initializeV2(8);
        vm.prank(address(timelock));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        r.initializeV2(8);
        (bool ok, bytes memory ret) =
            address(registry).call(_init(4, stranger, GovernedUUPS.UpgradeMode.Upgradeable));
        assertFalse(ok);
        assertEq(bytes4(ret), Initializable.InvalidInitialization.selector);
    }

    // ─── Release mode ──────────────────────────────────────────────────────────

    /// @notice The release mode has no default: `Undeclared` reverts, and so does a zero timelock.
    function test_releaseMode_isRequired_andTheTimelockNonZero() public {
        for (uint256 i = 0; i < N; i++) {
            address impl = _newImpl(i);
            bytes memory undeclared =
                _init(i, address(timelock), GovernedUUPS.UpgradeMode.Undeclared);
            vm.expectRevert(GovernedUpgrade.UpgradeModeUndeclared.selector);
            CoreProxies.proxy(impl, undeclared);
            bytes memory zero = _init(i, address(0), GovernedUUPS.UpgradeMode.Upgradeable);
            vm.expectRevert(
                abi.encodeWithSelector(GovernedUpgrade.InvalidUpgradeTimelock.selector, address(0))
            );
            CoreProxies.proxy(impl, zero);
        }
    }

    /// @notice Freeze at deploy: the flag is set inside the atomic initialization (with the event),
    ///         so not even the timelock can ever upgrade the proxy.
    function test_freezeAtDeploy_isFrozenFromTheFirstBlock() public {
        for (uint256 i = 0; i < N; i++) {
            address impl = _newImpl(i);
            bytes memory init = _init(i, address(timelock), GovernedUUPS.UpgradeMode.FrozenAtDeploy);
            vm.recordLogs();
            address p = CoreProxies.proxy(impl, init);
            assertTrue(GovernedUUPS(p).upgradesFrozen(), _name(i));
            assertTrue(_sawFrozen(p, impl), string.concat(_name(i), ": UpgradesFrozen at init"));
            // Issue 1835: the same end state as freezeUpgrades, initializers disabled for good.
            assertEq(_initializedVersion(p), type(uint64).max, _name(i));
            address v2 = _newV2(i);
            vm.prank(address(timelock));
            vm.expectRevert(GovernedUpgrade.UpgradesAreFrozen.selector);
            GovernedUUPS(p).upgradeToAndCall(v2, "");
            vm.prank(address(timelock));
            vm.expectRevert(GovernedUpgrade.UpgradesAreFrozen.selector);
            GovernedUUPS(p).freezeUpgrades(impl, impl.codehash);
            assertEq(CoreProxies.implementationOf(p), impl, _name(i));
        }
    }

    /// @notice Issue 1835: a FrozenAtDeploy proxy reports the max initialized version, so a
    ///         reinitializer the implementation carries can never run on it (with version 1 left
    ///         behind, `reinitializer(2)` would still run).
    function test_freezeAtDeploy_disablesEveryReinitializer() public {
        VaultRegistryV2Reinit impl = new VaultRegistryV2Reinit();
        address p = CoreProxies.proxy(
            address(impl),
            abi.encodeCall(
                VaultRegistry.initialize,
                (admin, address(timelock), GovernedUUPS.UpgradeMode.FrozenAtDeploy)
            )
        );
        assertEq(_initializedVersion(p), type(uint64).max, "max initialized version");
        vm.prank(address(timelock));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        VaultRegistryV2Reinit(p).initializeV2(7);
        vm.prank(stranger);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        VaultRegistryV2Reinit(p).initializeV2(7);
        assertEq(VaultRegistryV2Reinit(p).v2Value(), 0, "the reinitializer never ran");
        assertTrue(GovernedUUPS(p).upgradesFrozen(), "frozen");
    }

    function _sawLog(address emitter, bytes32 topic0, bytes32 topic1) internal returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 j = 0; j < logs.length; j++) {
            if (
                logs[j].emitter == emitter && logs[j].topics.length > 1
                    && logs[j].topics[0] == topic0 && logs[j].topics[1] == topic1
            ) return true;
        }
        return false;
    }

    function _sawFrozen(address proxy, address impl) internal returns (bool) {
        bytes32 topic = keccak256("UpgradesFrozen(address,address,bytes32)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 j = 0; j < logs.length; j++) {
            if (
                logs[j].emitter == proxy && logs[j].topics[0] == topic
                    && address(uint160(uint256(logs[j].topics[1]))) == proxy
                    && address(uint160(uint256(logs[j].topics[2]))) == impl
            ) return abi.decode(logs[j].data, (bytes32)) == impl.codehash;
        }
        return false;
    }

    // ─── Authority ─────────────────────────────────────────────────────────────

    /// @notice Only the timelock upgrades or freezes. The admin, the emergency key, the deposit
    ///         pauser, the deployer, RouterGovernance, the Safe itself and a stranger are refused.
    function test_onlyTheTimelock_canUpgradeOrFreeze() public {
        address[N] memory p = _proxies();
        address[7] memory callers =
            [admin, emergency, pauser, address(this), address(governance), safe, stranger];
        for (uint256 i = 0; i < N; i++) {
            address v2 = _newV2(i);
            address impl = CoreProxies.implementationOf(p[i]);
            for (uint256 c = 0; c < callers.length; c++) {
                vm.prank(callers[c]);
                vm.expectRevert(
                    abi.encodeWithSelector(GovernedUpgrade.NotUpgradeTimelock.selector, callers[c])
                );
                GovernedUUPS(p[i]).upgradeToAndCall(v2, "");
                vm.prank(callers[c]);
                vm.expectRevert(
                    abi.encodeWithSelector(GovernedUpgrade.NotUpgradeTimelock.selector, callers[c])
                );
                GovernedUUPS(p[i]).freezeUpgrades(impl, impl.codehash);
            }
        }
    }

    /// @notice A direct, two-signature Safe call to upgrade is refused: the Safe is the
    ///         timelock's proposer, not the upgrade authority.
    function test_safeDirectUpgrade_isRefused() public {
        bytes memory call_ = _upgradeCall(_newV2(4), "");
        (bool ok, bytes memory ret) = _callAsSafe(safe, address(registry), call_);
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(GovernedUpgrade.NotUpgradeTimelock.selector, safe));
    }

    /// @notice No role change moves the upgrade authority: granting every role to a stranger and
    ///         revoking the admin's leaves `upgradeTimelock` as it was and the stranger refused.
    function test_roleChanges_doNotMoveUpgradeAuthority() public {
        bytes32 adminRole = keccak256("ADMIN_ROLE");
        vm.startPrank(admin);
        vault.grantRole(adminRole, stranger);
        vault.grantRole(vault.EMERGENCY_ROLE(), stranger);
        vault.revokeRole(adminRole, admin);
        gateway.grantRole(gateway.DEFAULT_ADMIN_ROLE(), stranger);
        gateway.grantRole(adminRole, stranger);
        router.grantRole(router.WEIGHT_SETTER_ROTATOR_ROLE(), stranger);
        registry.grantRole(adminRole, stranger);
        vm.stopPrank();
        address[N] memory p = _proxies();
        for (uint256 i = 0; i < N; i++) {
            assertEq(GovernedUUPS(p[i]).upgradeTimelock(), address(timelock), _name(i));
        }
        address v2 = _newV2(0);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(GovernedUpgrade.NotUpgradeTimelock.selector, stranger)
        );
        vault.upgradeToAndCall(v2, "");
    }

    // ─── Upgrade through the Safe and the timelock ─────────────────────────────

    /// @dev Populates v1 state on the non-vault contracts the unit fixture can reach without venues.
    function _populate() internal {
        vm.startPrank(admin);
        registry.registerVault(
            address(vault),
            VaultRegistry.VaultMetadata({
                name: "Robot Money USDC", asset: address(usdc), registeredAt: 0
            })
        );
        registry.setRouterEligible(address(vault), true);
        address[] memory vs = new address[](1);
        vs[0] = address(vault);
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;
        router.setDefaultWeights(vs, bps);
        router.setRouterCap(5_000e6);
        vault.setPerDepositCap(500_000e6);
        vault.setTvlCap(900_000e6);
        vault.setExitFeeBps(7);
        address[] memory none = new address[](0);
        vm.stopPrank();
        AgentRegistration.register(
            gateway,
            agent,
            IGateway.AgentPolicy({
                active: true,
                validUntil: uint64(block.timestamp + 365 days),
                maxPerPayment: 1_000e6,
                maxPerWindow: 10_000e6,
                shareReceiver: agent,
                allowedDestinations: CoreProxies.oneDestination(address(0xD357)),
                assetRecipient: address(0),
                maxWithdrawPerPayment: 0,
                maxWithdrawPerWindow: 0,
                allowedSourceVaults: none
            })
        );
        vm.startPrank(admin);
        receipts.grantRole(receipts.RECEIPT_SUBMITTER_ROLE(), submitter);
        vm.stopPrank();
        vm.prank(submitter);
        receipts.recordReceipt(keccak256("r1"), keccak256("bytes"), "https://x.invalid/r1");
        // An adapter position: rmUSDC routes the deposit into a no-yield test adapter.
        NoYieldTestAdapter adapter = new NoYieldTestAdapter(address(usdc), address(vault));
        vm.startPrank(admin);
        vault.setAdapterAllowed(address(adapter), true);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vault.addAdapter(address(adapter), 10_000);
        vm.stopPrank();
        positionAdapter = address(adapter);
        // Shares: a direct deposit into rmUSDC.
        usdc.mint(stranger, 100e6);
        vm.startPrank(stranger);
        usdc.approve(address(vault), 100e6);
        vault.deposit(100e6, stranger);
        vault.approve(agent, 12345);
        vm.stopPrank();
    }

    /// @notice Every proxy goes v1 -> v2 through Safe -> timelock with its address, implementation
    ///         slot history and state intact: balances, allowances, roles, caps, fees, weights,
    ///         gateway policies, receipt submitters and receipts read the same before and after, and the
    ///         redeem path still pays.
    function test_upgradeEveryProxy_throughSafeAndTimelock_keepsState() public {
        _populate();
        uint256 shares = vault.balanceOf(stranger);
        uint256 supply = vault.totalSupply();
        uint256 assets = vault.totalAssets();
        (,,,, address receiverBefore,,,) = gateway.agents(agent);
        address[N] memory p = _proxies();
        for (uint256 i = 0; i < N; i++) {
            address v2 = _newV2(i);
            vm.recordLogs();
            _governed(p[i], _upgradeCall(v2, ""));
            assertTrue(
                _sawLog(p[i], keccak256("Upgraded(address)"), bytes32(uint256(uint160(v2)))),
                string.concat(_name(i), ": Upgraded")
            );
            assertEq(CoreProxies.implementationOf(p[i]), v2, _name(i));
            assertEq(IUpgradeMarker(p[i]).upgradeMarker(), UPGRADE_V2_MARKER, _name(i));
            assertEq(GovernedUUPS(p[i]).upgradeTimelock(), address(timelock), _name(i));
            assertEq(_initializedVersion(p[i]), 1, _name(i));
        }
        assertEq(vault.balanceOf(stranger), shares, "balance");
        assertEq(IERC20(address(usdc)).balanceOf(positionAdapter), 100e6, "adapter position");
        (address adapterAddr,, bool active, uint256 adapterBalance,) = vault.getAdapterInfo(0);
        assertEq(adapterAddr, positionAdapter, "adapter registry");
        assertTrue(active, "adapter active");
        assertEq(adapterBalance, 100e6, "adapter balance");
        assertEq(vault.totalSupply(), supply, "supply");
        assertEq(vault.totalAssets(), assets, "assets");
        assertEq(vault.allowance(stranger, agent), 12345, "allowance");
        assertEq(vault.tvlCap(), 900_000e6, "tvl cap");
        assertEq(vault.exitFeeBps(), 7, "exit fee");
        assertEq(vault.feeRecipient(), feeRecipient, "fee recipient");
        assertTrue(vault.hasRole(vault.ADMIN_ROLE(), admin), "vault admin");
        assertTrue(vault.hasRole(vault.EMERGENCY_ROLE(), emergency), "vault emergency");
        assertTrue(registry.isRouterEligible(address(vault)), "eligibility");
        assertEq(registry.listVaults().length, 1, "registered");
        (address[] memory dv, uint256[] memory db) = router.getDefaultWeights();
        assertEq(dv.length, 1);
        assertEq(dv[0], address(vault));
        assertEq(db[0], 10_000, "default weights");
        assertEq(router.routerCap(), 5_000e6, "router cap");
        (,,,, address receiverAfter,,,) = gateway.agents(agent);
        assertEq(receiverAfter, receiverBefore, "gateway policy");
        assertEq(gateway.agentOwner(agent), agent, "agent owner");
        assertTrue(gateway.hasRole(gateway.AGENT_ROLE(), agent), "agent role");
        assertTrue(receipts.hasRole(receipts.RECEIPT_SUBMITTER_ROLE(), submitter), "submitter");
        assertEq(receipts.receiptCount(), 1, "receipt");
        IConsensusRecommendationReceipt.Receipt memory r = receipts.getReceiptById(keccak256("r1"));
        assertEq(r.payloadDigest, keccak256("bytes"), "receipt digest");
        assertEq(address(governance.router()), address(router), "governance router");
        // The synchronous redemption pays out after the upgrade.
        vm.prank(stranger);
        uint256 out = vault.redeem(shares, stranger, stranger);
        assertEq(out, 100e6 - (100e6 * 7) / 10_000, "redeem after upgrade, less the 7 bps exit fee");
    }

    /// @notice Upgrades refuse an implementation that is not UUPS, answers the wrong UUID, or has
    ///         no code: a proxy can never point at an incompatible implementation shape.
    function test_upgrade_refusesIncompatibleImplementations() public {
        address[3] memory bad = [address(new NotUUPS()), address(new WrongUUID()), stranger];
        for (uint256 b = 0; b < bad.length; b++) {
            vm.prank(address(timelock));
            vm.expectRevert(
                abi.encodeWithSelector(ERC1967Utils.ERC1967InvalidImplementation.selector, bad[b])
            );
            registry.upgradeToAndCall(bad[b], "");
        }
    }

    /// @notice Incompatible storage layouts. A v2 of the same contract keeps every committed
    ///         snapshot slot (contracts/test/fixtures/storage-layout, the CI layout gate). A
    ///         different contract's implementation is still UUPS-valid, so only the layout review
    ///         stops it: its committed layout differs at slot 0, and installed it misreads the
    ///         registry's state. This is why every upgrade passes the layout gate first.
    function test_incompatibleLayout_isWhatTheLayoutGateCatches() public {
        _populate();
        string memory snap =
            vm.readFile("contracts/test/fixtures/storage-layout/VaultRegistry.json");
        uint256 n;
        while (vm.keyExistsJson(snap, string.concat(".storage[", vm.toString(n), "]"))) n++;
        assertGt(n, 0, "the committed layout lists the registry's variables");
        bytes32[] memory before = new bytes32[](n);
        for (uint256 s = 0; s < n; s++) {
            uint256 slot =
                vm.parseUint(snap.readString(string.concat(".storage[", vm.toString(s), "].slot")));
            before[s] = vm.load(address(registry), bytes32(slot));
        }
        _governed(address(registry), _upgradeCall(_newV2(4), ""));
        for (uint256 s = 0; s < n; s++) {
            uint256 slot =
                vm.parseUint(snap.readString(string.concat(".storage[", vm.toString(s), "].slot")));
            assertEq(vm.load(address(registry), bytes32(slot)), before[s], "v2 keeps every v1 slot");
        }
        assertTrue(registry.isRouterEligible(address(vault)));

        string memory other =
            vm.readFile("contracts/test/fixtures/storage-layout/RouterGovernance.json");
        assertFalse(
            keccak256(bytes(snap.readString(".storage[0].label")))
                == keccak256(bytes(other.readString(".storage[0].label"))),
            "the two layouts differ at slot 0"
        );
        _governed(address(registry), _upgradeCall(address(new RouterGovernanceV2()), ""));
        // RouterGovernance reads slot 0 (the registry's first variable) as its router address.
        assertTrue(
            address(RouterGovernance(address(registry)).router()) != address(router),
            "an incompatible layout misreads the live state"
        );
    }

    // ─── Freeze ────────────────────────────────────────────────────────────────

    /// @notice The delayed freeze through Safe -> timelock, bound to the live implementation and
    ///         its code hash: afterwards no upgrade, no initializer and no reinitializer can run.
    function test_delayedFreeze_isOneWay() public {
        address[N] memory p = _proxies();
        for (uint256 i = 0; i < N; i++) {
            address impl = CoreProxies.implementationOf(p[i]);
            vm.recordLogs();
            _governed(p[i], _freezeCall(p[i]));
            assertTrue(_sawFrozen(p[i], impl), string.concat(_name(i), ": UpgradesFrozen"));
            assertTrue(GovernedUUPS(p[i]).upgradesFrozen(), _name(i));
            assertEq(_initializedVersion(p[i]), type(uint64).max, _name(i));
            address v2 = _newV2(i);
            vm.prank(address(timelock));
            vm.expectRevert(GovernedUpgrade.UpgradesAreFrozen.selector);
            GovernedUUPS(p[i]).upgradeToAndCall(v2, "");
            vm.prank(address(timelock));
            vm.expectRevert(GovernedUpgrade.UpgradesAreFrozen.selector);
            GovernedUUPS(p[i]).freezeUpgrades(impl, impl.codehash);
            (bool ok, bytes memory ret) =
                p[i].call(_init(i, address(timelock), GovernedUUPS.UpgradeMode.Upgradeable));
            assertFalse(ok);
            assertEq(bytes4(ret), Initializable.InvalidInitialization.selector, _name(i));
            assertEq(CoreProxies.implementationOf(p[i]), impl, _name(i));
        }
    }

    /// @notice A freeze naming the wrong implementation or the wrong code hash reverts.
    function test_freeze_wrongTarget_reverts() public {
        address impl = CoreProxies.implementationOf(address(gateway));
        address other = address(new RobotMoneyGatewayV2());
        vm.startPrank(address(timelock));
        vm.expectRevert(
            abi.encodeWithSelector(
                GovernedUpgrade.FreezeTargetMismatch.selector, impl, impl.codehash
            )
        );
        gateway.freezeUpgrades(other, other.codehash);
        vm.expectRevert(
            abi.encodeWithSelector(
                GovernedUpgrade.FreezeTargetMismatch.selector, impl, impl.codehash
            )
        );
        gateway.freezeUpgrades(impl, keccak256("another build"));
        vm.stopPrank();
        assertFalse(gateway.upgradesFrozen());
    }

    /// @notice A freeze queued for v1, then an intervening upgrade to v2 that executes first: the
    ///         queued freeze can no longer execute, so it never locks in a version nobody reviewed.
    function test_interveningUpgrade_beforeAQueuedFreeze_blocksTheFreeze() public {
        bytes memory freeze = _freezeCall(address(router));
        bytes memory upgrade = _upgradeCall(_newV2(5), "");
        bytes32 sf = _salt();
        bytes32 su = _salt();
        _govSchedule(safe, timelock, address(router), freeze, sf, DELAY);
        _govSchedule(safe, timelock, address(router), upgrade, su, DELAY);
        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(router), 0, upgrade, bytes32(0), su);
        address v2 = CoreProxies.implementationOf(address(router));
        vm.expectRevert(
            abi.encodeWithSelector(GovernedUpgrade.FreezeTargetMismatch.selector, v2, v2.codehash)
        );
        timelock.execute(address(router), 0, freeze, bytes32(0), sf);
        assertFalse(router.upgradesFrozen());
    }

    /// @notice An upgrade queued before the freeze cannot execute after it, through the timelock
    ///         or through the Safe. The operation stays pending (not Done) and keeps failing.
    function test_pendingUpgrade_afterTheFreeze_fails() public {
        bytes memory upgrade = _upgradeCall(_newV2(0), "");
        bytes memory freeze = _freezeCall(address(vault));
        bytes32 su = _salt();
        bytes32 sf = _salt();
        bytes32 id = _govSchedule(safe, timelock, address(vault), upgrade, su, DELAY);
        _govSchedule(safe, timelock, address(vault), freeze, sf, DELAY);
        vm.warp(block.timestamp + DELAY);
        _govExecute(safe, timelock, address(vault), freeze, sf);
        assertTrue(vault.upgradesFrozen());
        vm.expectRevert(GovernedUpgrade.UpgradesAreFrozen.selector);
        timelock.execute(address(vault), 0, upgrade, bytes32(0), su);
        bytes memory exec =
            abi.encodeCall(timelock.execute, (address(vault), 0, upgrade, bytes32(0), su));
        bytes memory sigs = _twoOwnerSignatures(_safeDigest(safe, address(timelock), exec));
        vm.expectRevert(bytes(GS013));
        _safeExecWith(safe, address(timelock), exec, sigs);
        assertTrue(timelock.isOperationReady(id), "still pending, never done");
        assertFalse(timelock.isOperationDone(id));
    }

    /// @notice No role change and no initializer or reinitializer route clears the freeze.
    function test_noRoleOrInitializerRoute_clearsTheFreeze() public {
        _governed(address(registry), _freezeCall(address(registry)));
        bytes32 adminRole = keccak256("ADMIN_ROLE");
        vm.prank(admin);
        registry.grantRole(adminRole, stranger);
        vm.prank(stranger);
        registry.revokeRole(adminRole, admin);
        vm.prank(stranger);
        registry.grantRole(adminRole, admin);
        vm.prank(stranger);
        registry.renounceRole(adminRole, stranger);
        assertTrue(registry.upgradesFrozen());
        // The v1 initializer, a v2 reinitializer through upgradeToAndCall, and a re-freeze.
        (bool ok,) =
            address(registry).call(_init(4, stranger, GovernedUUPS.UpgradeMode.Upgradeable));
        assertFalse(ok);
        address v2 = address(new VaultRegistryV2Reinit());
        vm.prank(address(timelock));
        vm.expectRevert(GovernedUpgrade.UpgradesAreFrozen.selector);
        registry.upgradeToAndCall(v2, abi.encodeCall(VaultRegistryV2Reinit.initializeV2, (1)));
        assertTrue(registry.upgradesFrozen(), "still frozen");
        // The flag's ERC-7201 slot holds `true` (offset 20, after the timelock address).
        uint256 word = uint256(vm.load(address(registry), GovernedUpgrade.STORAGE));
        assertEq(address(uint160(word)), address(timelock));
        assertEq(uint8(word >> 160), 1);
    }

    /// @notice Freezing upgrades never pauses or alters withdrawals.
    function test_freeze_neverBlocksWithdrawals() public {
        _populate();
        _governed(address(vault), _freezeCall(address(vault)));
        uint256 shares = vault.balanceOf(stranger);
        vm.prank(stranger);
        assertEq(vault.redeem(shares, stranger, stranger), 100e6 - (100e6 * 7) / 10_000);
    }

    /// @notice The GovernedUUPS namespace is the ERC-7201 location of its id.
    function test_storageNamespace_isTheErc7201Location() public pure {
        bytes32 expected = keccak256(
            abi.encode(uint256(keccak256("robotmoney.storage.GovernedUUPS")) - 1)
        ) & ~bytes32(uint256(0xff));
        assertEq(GovernedUpgrade.STORAGE, expected);
        bytes32 init = keccak256(
            abi.encode(uint256(keccak256("openzeppelin.storage.Initializable")) - 1)
        ) & ~bytes32(uint256(0xff));
        assertEq(GovernedUpgrade.INITIALIZABLE_STORAGE, init);
    }
}
