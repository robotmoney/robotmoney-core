// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md section 1 and 10 (gateway system), issue 1892
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {TestERC20} from "./helpers/TestERC20.sol";
import {MockVault} from "./helpers/MockVault.sol";
import {DeployGateway} from "../script/DeployGateway.s.sol";
import {HandoverGateway} from "../script/HandoverGateway.s.sol";

/// @dev Exposes the explicit upgrade-config reader of the gateway stage.
contract GatewayUpgradeHarness is DeployGateway {
    function readUpgrade() external view returns (UpgradeConfig memory) {
        return _readExplicitUpgradeConfig("", "GATEWAY_UPGRADE_TIMELOCK");
    }
}

/// @notice The gateway system names its own upgrade timelock and hands its roles over in its
///         own stage. Neither reads a vaults-system input.
contract GatewaySystemDeployTest is Test {
    address internal deployer = makeAddr("gw-deployer");
    address internal pauser = makeAddr("gw-pauser");
    address internal recv = makeAddr("gw-recv");
    address internal govHolder = makeAddr("gw-gov");
    address internal tl = makeAddr("gw-upgrade-timelock");
    address internal router = makeAddr("gw-router");
    IAccessControl internal gw;
    HandoverGateway internal h;

    function setUp() public {
        vm.etch(tl, hex"00");
        vm.etch(router, hex"00");
        TestERC20 usdc = new TestERC20();
        MockVault v = new MockVault(address(usdc));
        DeployGateway s = new DeployGateway();
        DeployGateway.Deployed memory d =
            s.runInProcessWith(deployer, pauser, recv, address(usdc), address(v), router);
        gw = IAccessControl(address(d.gateway));
        h = new HandoverGateway();
    }

    function _upgrade() internal returns (GatewayUpgradeHarness u) {
        u = new GatewayUpgradeHarness();
        vm.setEnv("UPGRADE_MODE", "upgradeable");
    }

    function test_upgradeTimelock_zeroRefused() public {
        GatewayUpgradeHarness u = _upgrade();
        vm.setEnv("GATEWAY_UPGRADE_TIMELOCK", vm.toString(address(0)));
        vm.expectRevert(bytes("GATEWAY_UPGRADE_TIMELOCK=0"));
        u.readUpgrade();
    }

    function test_upgradeTimelock_noCodeRefused() public {
        GatewayUpgradeHarness u = _upgrade();
        vm.setEnv("GATEWAY_UPGRADE_TIMELOCK", vm.toString(makeAddr("gw-nocode")));
        vm.expectRevert(bytes("GATEWAY_UPGRADE_TIMELOCK has no code on this chain"));
        u.readUpgrade();
    }

    function test_upgradeTimelock_explicitAccepted() public {
        GatewayUpgradeHarness u = _upgrade();
        vm.setEnv("GATEWAY_UPGRADE_TIMELOCK", vm.toString(tl));
        assertEq(u.readUpgrade().timelock, tl);
    }

    function test_handover_movesBothRolesAndDeployerKeepsNone() public {
        bytes32 admin = h.ADMIN_ROLE();
        bytes32 dflt = h.DEFAULT_ADMIN_ROLE();
        assertTrue(gw.hasRole(admin, deployer));
        h.runInProcessWith(address(gw), govHolder, deployer);
        assertTrue(gw.hasRole(admin, govHolder));
        assertTrue(gw.hasRole(dflt, govHolder));
        assertFalse(gw.hasRole(admin, deployer));
        assertFalse(gw.hasRole(dflt, deployer));
        assertFalse(gw.hasRole(h.AGENT_ROLE(), govHolder));
    }

    function test_handover_zeroAdminRefused() public {
        vm.expectRevert(bytes("GATEWAY_ADMIN_ADDRESS=0"));
        h.runInProcessWith(address(gw), address(0), deployer);
    }

    function test_handover_deployerAsAdminRefused() public {
        vm.expectRevert(bytes("GATEWAY_ADMIN_ADDRESS == deployer EOA"));
        h.runInProcessWith(address(gw), deployer, deployer);
    }

    function test_handover_pauserAsAdminRefused() public {
        vm.expectRevert(bytes("GATEWAY_ADMIN_ADDRESS == gateway pauser"));
        h.runInProcessWith(address(gw), pauser, deployer);
    }

    function test_handover_agentPreBoundAdminRefused() public {
        bytes32 agentRole = h.AGENT_ROLE();
        vm.prank(deployer);
        gw.grantRole(agentRole, govHolder);
        vm.expectRevert(bytes("ACL-7: GATEWAY_ADMIN_ADDRESS pre-bound as gateway AGENT"));
        h.runInProcessWith(address(gw), govHolder, deployer);
    }
}
