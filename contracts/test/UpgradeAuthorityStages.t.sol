// SPDX-License-Identifier: MIT
// Canonical: docs/technical/contract-upgradeability-plan.md — Mechanism and authority (timelock-last stage order)
// (See also: contracts/script/UpgradeAuthority.sol; issue 1808)
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {GovernedUUPS, GovernedUpgrade} from "../lib/GovernedUUPS.sol";
import {UpgradeAuthority} from "../script/UpgradeAuthority.sol";
import {DeployTimelock} from "../script/DeployTimelock.s.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {RouterGovernance} from "../RouterGovernance.sol";

import {CoreProxies} from "./helpers/CoreProxies.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {VaultRegistryV2, UPGRADE_V2_MARKER} from "./helpers/UpgradeV2.sol";

/// @dev Exposes the env reader of the proxy stages with a test-only prefix (env vars are
///      process-wide and forge runs tests in parallel).
contract UpgradeAuthorityHarness is UpgradeAuthority {
    function read(string memory prefix) external view returns (UpgradeConfig memory) {
        return _readUpgradeConfig(prefix);
    }
}

/// @notice Issue 1808, the timelock-last stage order. Every proxy names the CREATE2 address of the
///         Safe-proposer timelock from its first block; the timelock stage deploys the timelock
///         there and refuses any proxy that names another authority. Until then nobody (the
///         deployer included) can upgrade or freeze: there is no interim deployer authority.
contract UpgradeAuthorityStagesTest is SafeGovernance {
    uint256 internal constant DELAY = 2 days;
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    DeployTimelock internal script;
    address internal deployer;
    address internal safe;
    address internal predicted;
    address internal emergency = makeAddr("authority-emergency");
    TestERC20 internal usdc;
    RobotMoneyVault internal vault;
    RobotMoneyGateway internal gateway;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RouterGovernance internal governance;

    function setUp() public {
        usdc = new TestERC20();
        script = new DeployTimelock();
        deployer = address(script);
        _installSafeSet();
        safe = _newDefaultSafe();
        predicted = script.predictTimelock(safe, DELAY);
    }

    function _build(address authority, GovernedUUPS.UpgradeMode mode) internal {
        CoreProxies.useUpgradeConfig(authority, mode);
        vault = CoreProxies.robotMoneyVault(
            usdc, type(uint256).max, type(uint256).max, 0, safe, deployer, deployer
        );
        gateway = CoreProxies.robotMoneyGateway(
            usdc, vault, deployer, makeAddr("authority-pauser"), address(0)
        );
        registry = CoreProxies.vaultRegistry(deployer);
        router = CoreProxies.portfolioRouter(address(usdc), address(registry), deployer);
        governance = CoreProxies.routerGovernance(address(router), makeAddr("receipts"), deployer);
        vm.startPrank(deployer);
        router.grantRole(ADMIN_ROLE, address(governance));
        router.grantRole(keccak256("WEIGHT_SETTER_ROLE"), address(governance));
        vm.stopPrank();
    }

    function _handover() internal returns (DeployTimelock.Deployed memory) {
        vm.prank(deployer);
        return script.runInProcess(
            address(vault),
            address(gateway),
            address(registry),
            address(router),
            address(governance),
            safe,
            emergency,
            DELAY,
            _fixtureSpec()
        );
    }

    function _proxies() internal view returns (address[5] memory) {
        return
            [
                address(vault),
                address(gateway),
                address(registry),
                address(router),
                address(governance)
            ];
    }

    /// @notice Before the timelock stage the authority has no code and nobody can upgrade or
    ///         freeze; the stage deploys the timelock at exactly the address every proxy named,
    ///         and from then on the Safe, through it, can.
    function test_noInterimAuthority_thenTheHandoverDeploysThePredictedTimelock() public {
        _build(predicted, GovernedUUPS.UpgradeMode.Upgradeable);
        assertEq(predicted.code.length, 0, "the timelock does not exist yet");
        address v2 = address(new VaultRegistryV2());
        address[3] memory callers = [deployer, safe, emergency];
        address[5] memory p = _proxies();
        for (uint256 i = 0; i < p.length; i++) {
            assertEq(GovernedUUPS(p[i]).upgradeTimelock(), predicted);
            for (uint256 c = 0; c < callers.length; c++) {
                vm.prank(callers[c]);
                vm.expectRevert(
                    abi.encodeWithSelector(GovernedUpgrade.NotUpgradeTimelock.selector, callers[c])
                );
                GovernedUUPS(p[i]).upgradeToAndCall(v2, "");
            }
        }

        DeployTimelock.Deployed memory d = _handover();
        assertEq(address(d.timelock), predicted, "deployed at the CREATE2 prediction");
        assertEq(d.timelock.getMinDelay(), DELAY);
        assertTrue(d.timelock.hasRole(d.timelock.PROPOSER_ROLE(), safe));
        assertTrue(IAccessControl(address(registry)).hasRole(ADMIN_ROLE, predicted));

        _govRun(
            safe,
            d.timelock,
            address(registry),
            abi.encodeCall(GovernedUUPS.upgradeToAndCall, (v2, "")),
            bytes32("up"),
            DELAY
        );
        assertEq(VaultRegistryV2(address(registry)).upgradeMarker(), UPGRADE_V2_MARKER);
    }

    /// @notice A proxy that names any other authority (a placeholder, the deployer, another
    ///         deployment's timelock) stops the handover before any role moves.
    function test_handover_refusesAProxyNamingAnotherAuthority() public {
        address[3] memory wrong =
            [deployer, makeAddr("placeholder"), script.predictTimelock(safe, DELAY + 1)];
        for (uint256 w = 0; w < wrong.length; w++) {
            _build(wrong[w], GovernedUUPS.UpgradeMode.Upgradeable);
            vm.prank(deployer);
            vm.expectRevert(
                bytes(
                    string.concat(
                        vm.toString(address(vault)),
                        ": upgradeTimelock is not the deployed timelock"
                    )
                )
            );
            script.runInProcess(
                address(vault),
                address(gateway),
                address(registry),
                address(router),
                address(governance),
                safe,
                emergency,
                DELAY,
                _fixtureSpec()
            );
            assertTrue(
                IAccessControl(address(vault)).hasRole(ADMIN_ROLE, deployer), "no role moved"
            );
        }
    }

    /// @notice CREATE2 binds the init code: whoever deploys the timelock at the prediction first,
    ///         it is the same Safe-proposer timelock, and the stage reuses it after checking it.
    function test_aTimelockAlreadyAtThePrediction_isReused() public {
        _build(predicted, GovernedUUPS.UpgradeMode.Upgradeable);
        vm.prank(makeAddr("anyone"));
        (bool ok,) = CREATE2_FACTORY.call(
            abi.encodePacked(script.TIMELOCK_SALT(), script.timelockInitCode(safe, DELAY))
        );
        assertTrue(ok && predicted.code.length > 0, "anyone can put it there");
        DeployTimelock.Deployed memory d = _handover();
        assertEq(address(d.timelock), predicted);
        assertTrue(
            TimelockController(payable(predicted)).hasRole(keccak256("CANCELLER_ROLE"), safe)
        );
    }

    /// @notice A stack deployed frozen hands over the same way; afterwards not even the timelock
    ///         can upgrade it.
    function test_frozenStack_handsOver_andStaysFrozen() public {
        _build(predicted, GovernedUUPS.UpgradeMode.FrozenAtDeploy);
        DeployTimelock.Deployed memory d = _handover();
        address v2 = address(new VaultRegistryV2());
        address[5] memory p = _proxies();
        for (uint256 i = 0; i < p.length; i++) {
            assertTrue(GovernedUUPS(p[i]).upgradesFrozen());
            vm.prank(address(d.timelock));
            vm.expectRevert(GovernedUpgrade.UpgradesAreFrozen.selector);
            GovernedUUPS(p[i]).upgradeToAndCall(v2, "");
        }
    }

    /// @notice The stage env: SAFE_ADDRESS and TIMELOCK_MIN_DELAY name the timelock, UPGRADE_MODE is
    ///         `upgradeable` or `frozen`. Every one is required; nothing has a default.
    function test_stageEnv_isRequired_andNamesThePrediction() public {
        UpgradeAuthorityHarness h = new UpgradeAuthorityHarness();
        string memory pre = "RM_1808_UPGRADE_AUTHORITY_";
        vm.expectRevert(bytes(string.concat(pre, "SAFE_ADDRESS must be set")));
        h.read(pre);
        vm.setEnv(string.concat(pre, "SAFE_ADDRESS"), vm.toString(safe));
        vm.expectRevert(bytes(string.concat(pre, "TIMELOCK_MIN_DELAY must be set")));
        h.read(pre);
        vm.setEnv(string.concat(pre, "TIMELOCK_MIN_DELAY"), vm.toString(DELAY));
        vm.expectRevert(bytes(string.concat(pre, "UPGRADE_MODE must be set")));
        h.read(pre);
        vm.setEnv(string.concat(pre, "UPGRADE_MODE"), "Upgradeable");
        vm.expectRevert(bytes("UPGRADE_MODE must be upgradeable or frozen"));
        h.read(pre);
        vm.setEnv(string.concat(pre, "UPGRADE_MODE"), "frozen");
        UpgradeAuthority.UpgradeConfig memory c = h.read(pre);
        assertEq(c.timelock, predicted, "the env names the same timelock the stage deploys");
        assertEq(uint8(c.mode), uint8(GovernedUUPS.UpgradeMode.FrozenAtDeploy));
        vm.setEnv(string.concat(pre, "UPGRADE_MODE"), "upgradeable");
        assertEq(uint8(h.read(pre).mode), uint8(GovernedUUPS.UpgradeMode.Upgradeable));
        assertEq(h.upgradeModeName(GovernedUUPS.UpgradeMode.FrozenAtDeploy), "frozen");
    }
}
