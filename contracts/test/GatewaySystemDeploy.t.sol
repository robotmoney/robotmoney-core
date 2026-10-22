// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md section 1 and 10 (gateway system), issue 1892
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {TestERC20} from "./helpers/TestERC20.sol";
import {DeployGateway} from "../script/DeployGateway.s.sol";
import {HandoverGateway} from "../script/HandoverGateway.s.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {AgentRegistration} from "./helpers/AgentRegistration.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";

/// @dev Exposes the explicit upgrade-config reader of the gateway stage.
contract GatewayUpgradeHarness is DeployGateway {
    function readUpgrade(string memory prefix) external view returns (UpgradeConfig memory) {
        return _readExplicitUpgradeConfig(prefix, "GATEWAY_UPGRADE_TIMELOCK");
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
    IAccessControl internal gw;
    HandoverGateway internal h;

    function setUp() public {
        vm.etch(tl, hex"00");
        TestERC20 usdc = new TestERC20();
        DeployGateway s = new DeployGateway();
        DeployGateway.Deployed memory d = s.runInProcessWith(deployer, pauser, recv, address(usdc));
        gw = IAccessControl(address(d.gateway));
        h = new HandoverGateway();
    }

    function _upgrade(string memory prefix) internal returns (GatewayUpgradeHarness u) {
        u = new GatewayUpgradeHarness();
        vm.setEnv(string.concat(prefix, "UPGRADE_MODE"), "upgradeable");
    }

    function test_upgradeTimelock_zeroRefused() public {
        string memory p = "GWSD_ZERO_";
        GatewayUpgradeHarness u = _upgrade(p);
        vm.setEnv(string.concat(p, "GATEWAY_UPGRADE_TIMELOCK"), vm.toString(address(0)));
        vm.expectRevert(bytes("GATEWAY_UPGRADE_TIMELOCK=0"));
        u.readUpgrade(p);
    }

    function test_upgradeTimelock_noCodeRefused() public {
        string memory p = "GWSD_NOCODE_";
        GatewayUpgradeHarness u = _upgrade(p);
        vm.setEnv(string.concat(p, "GATEWAY_UPGRADE_TIMELOCK"), vm.toString(makeAddr("gw-nocode")));
        vm.expectRevert(bytes("GATEWAY_UPGRADE_TIMELOCK has no code on this chain"));
        u.readUpgrade(p);
    }

    function test_upgradeTimelock_explicitAccepted() public {
        string memory p = "GWSD_OK_";
        GatewayUpgradeHarness u = _upgrade(p);
        vm.setEnv(string.concat(p, "GATEWAY_UPGRADE_TIMELOCK"), vm.toString(tl));
        assertEq(u.readUpgrade(p).timelock, tl);
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
        // The only way to bind an address as an agent is the owner's consented registration. A pre-bound admin address would make the handover brick, so it is refused up front.
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 30 days),
            maxPerPayment: 100e6,
            maxPerWindow: 1_000e6,
            shareReceiver: recv,
            allowedDestinations: CoreProxies.oneDestination(address(0xD357)),
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: new address[](0)
        });
        AgentRegistration.registerAs(IGateway(address(gw)), recv, govHolder, p);
        vm.expectRevert(bytes("ACL-7: GATEWAY_ADMIN_ADDRESS pre-bound as gateway AGENT"));
        h.runInProcessWith(address(gw), govHolder, deployer);
    }
}
