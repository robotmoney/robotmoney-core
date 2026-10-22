// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md section 1 and 10 (gateway system), issue 1892 (stage "gateway-handover")
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {ExpectedChainGuard} from "./ExpectedChainGuard.sol";

/// @title HandoverGateway
/// @notice The gateway system's own handover stage. The deployer, who holds ADMIN_ROLE and
///         DEFAULT_ADMIN_ROLE on the gateway after the `gateway` stage, grants both to the
///         explicitly configured `GATEWAY_ADMIN_ADDRESS` and revokes both from itself.
///         The deployer sends exactly 4 transactions: 2 grants, 2 revokes.
///         It authorizes no agent and transfers no agent. Who governs the gateway in production
///         is an open decision (architecture section 10): this script takes the holder as plain
///         explicit config and defaults nothing.
/// @dev Required env: GATEWAY_ADDRESS, GATEWAY_ADMIN_ADDRESS, DEPLOYMENT_OUT.
///      Optional env: EXPECTED_CHAIN_ID.
contract HandoverGateway is Script, ExpectedChainGuard {
    /// @notice Manifest file name the stage driver gives DEPLOYMENT_OUT.
    string public constant MANIFEST_FILE = "gateway-handover.json";

    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    bytes32 public constant DEPOSIT_PAUSER_ROLE = keccak256("DEPOSIT_PAUSER_ROLE");

    struct Params {
        address gateway;
        address admin;
    }

    function run() external {
        _requireExpectedChain("");
        Params memory p = Params({
            gateway: _envAddressRequired("GATEWAY_ADDRESS"),
            admin: _envAddressRequired("GATEWAY_ADMIN_ADDRESS")
        });
        _precheck(p, msg.sender);
        vm.startBroadcast();
        _handover(p, msg.sender);
        vm.stopBroadcast();
        _write(p, msg.sender);
    }

    /// @notice In-process variant for tests: acts as `deployer_` through a prank.
    function runInProcessWith(address gateway_, address admin_, address deployer_) external {
        Params memory p = Params({gateway: gateway_, admin: admin_});
        _precheck(p, deployer_);
        vm.startPrank(deployer_);
        _handover(p, deployer_);
        vm.stopPrank();
    }

    function _precheck(Params memory p, address deployer) internal view {
        require(p.gateway != address(0), "GATEWAY_ADDRESS=0");
        require(p.gateway.code.length > 0, "GATEWAY_ADDRESS has no code on this chain");
        require(p.admin != address(0), "GATEWAY_ADMIN_ADDRESS=0");
        require(p.admin != deployer, "GATEWAY_ADMIN_ADDRESS == deployer EOA");
        IAccessControl g = IAccessControl(p.gateway);
        require(g.hasRole(ADMIN_ROLE, deployer), "deployer lacks ADMIN_ROLE on gateway");
        require(
            g.hasRole(DEFAULT_ADMIN_ROLE, deployer), "deployer lacks DEFAULT_ADMIN_ROLE on gateway"
        );
        // ACL-7: an AGENT_ROLE holder cannot also hold an ADMIN-tier role.
        require(
            !g.hasRole(AGENT_ROLE, p.admin),
            "ACL-7: GATEWAY_ADMIN_ADDRESS pre-bound as gateway AGENT"
        );
        require(!g.hasRole(DEPOSIT_PAUSER_ROLE, p.admin), "GATEWAY_ADMIN_ADDRESS == gateway pauser");
    }

    function _handover(Params memory p, address deployer) internal {
        IAccessControl g = IAccessControl(p.gateway);
        g.grantRole(ADMIN_ROLE, p.admin);
        g.grantRole(DEFAULT_ADMIN_ROLE, p.admin);
        g.revokeRole(ADMIN_ROLE, deployer);
        g.revokeRole(DEFAULT_ADMIN_ROLE, deployer);
        require(g.hasRole(ADMIN_ROLE, p.admin), "admin missing ADMIN_ROLE on gateway");
        require(
            g.hasRole(DEFAULT_ADMIN_ROLE, p.admin), "admin missing DEFAULT_ADMIN_ROLE on gateway"
        );
        require(!g.hasRole(ADMIN_ROLE, deployer), "Deployer still has ADMIN_ROLE on gateway");
        require(
            !g.hasRole(DEFAULT_ADMIN_ROLE, deployer),
            "Deployer still has DEFAULT_ADMIN_ROLE on gateway"
        );
        console2.log("Gateway handed to", p.admin);
    }

    function _write(Params memory p, address deployer) internal {
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");
        IAccessControl g = IAccessControl(p.gateway);
        string memory roles = "gateway_handover_roles";
        vm.serializeBool(roles, "admin_holder_has_admin_role", g.hasRole(ADMIN_ROLE, p.admin));
        vm.serializeBool(
            roles, "admin_holder_has_default_admin_role", g.hasRole(DEFAULT_ADMIN_ROLE, p.admin)
        );
        vm.serializeBool(roles, "deployer_has_admin_role", g.hasRole(ADMIN_ROLE, deployer));
        string memory rolesJson = vm.serializeBool(
            roles, "deployer_has_default_admin_role", g.hasRole(DEFAULT_ADMIN_ROLE, deployer)
        );
        string memory hashes = "gateway_handover_hashes";
        string memory hashesJson = vm.serializeBytes32(hashes, "gateway", p.gateway.codehash);

        string memory obj = "gateway_handover";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "gateway", p.gateway);
        vm.serializeAddress(obj, "gateway_admin", p.admin);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeString(obj, "roles", rolesJson);
        string memory json = vm.serializeString(obj, "code_hashes", hashesJson);
        vm.writeJson(json, outPath);
    }
}
