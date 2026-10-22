// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md (SYS-1, ACL-9), docs/architecture.md section 1
// Implements: issue 1892 (SS-1019-10, RS-1019-11). Static guard: scripts/ci/check-system-split.ts.
//
// SYS-1  No vaults-system contract depends on the rmpc gateway; rebalancing works with no gateway deployed.
// ACL-9  An agent's owner never changes, its share receiver is always its owner, no role registers an agent.
//
// Both registry entries are RED while the code the siblings remove is still on dev (SYS-1: the receipt binds a gateway,
// issue 1888. ACL-9: authorizeAgent, transferAgentOwnership and the ADMIN_ROLE exception, issue 1890). The tests here
// execute the parts that hold today and pin the registry status to what the bytecode says, so the entry cannot stay RED
// after the removal or flip HOLDS before it. They compile against names that survive both siblings (artifact names and
// selectors by string, not by import).
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {InvariantRegistry} from "./InvariantRegistry.sol";
import {RouterGovernance} from "../../RouterGovernance.sol";
import {PortfolioRouter} from "../../PortfolioRouter.sol";
import {VaultRegistry} from "../../VaultRegistry.sol";
import {CoreProxies} from "../helpers/CoreProxies.sol";
import {MockUsdc, MockGovVault} from "../RouterGovernance.t.sol";
import {GatewayAgentPolicyFixture} from "../GatewayAgentPolicyAuthorization.t.sol";

/// @dev Byte search shared by both suites.
library CodeSearch {
    function containsSelector(bytes memory code, bytes4 sel) internal pure returns (bool) {
        for (uint256 i = 0; i + 4 <= code.length; i++) {
            if (
                code[i] == sel[0] && code[i + 1] == sel[1] && code[i + 2] == sel[2]
                    && code[i + 3] == sel[3]
            ) {
                return true;
            }
        }
        return false;
    }
}

/// @title SystemSplitSys1Test
/// @notice SYS-1 executed assertions.
contract SystemSplitSys1Test is Test {
    MockUsdc internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RouterGovernance internal gov;
    MockGovVault internal vaultA;
    MockGovVault internal vaultB;

    address internal govAdmin = makeAddr("govAdmin");
    address internal routerAdmin = makeAddr("routerAdmin");
    address internal registryAdmin = makeAddr("registryAdmin");

    /// @dev The vaults system, deployed with NO gateway anywhere. The receipt register is a code-bearing stand-in:
    ///      setDefaultWeights never reads it.
    function setUp() public {
        usdc = new MockUsdc();
        registry = CoreProxies.vaultRegistry(registryAdmin);
        vaultA = new MockGovVault(address(usdc));
        vaultB = new MockGovVault(address(usdc));
        vm.startPrank(registryAdmin);
        registry.registerVault(
            address(vaultA),
            VaultRegistry.VaultMetadata({name: "Vault A", asset: address(usdc), registeredAt: 0})
        );
        registry.registerVault(
            address(vaultB),
            VaultRegistry.VaultMetadata({name: "Vault B", asset: address(usdc), registeredAt: 0})
        );
        registry.setRouterEligible(address(vaultA), true);
        registry.setRouterEligible(address(vaultB), true);
        vm.stopPrank();
        router = CoreProxies.portfolioRouter(address(usdc), address(registry), routerAdmin);
        gov = CoreProxies.routerGovernance(
            address(router), address(new MockGovVault(address(usdc))), govAdmin
        );
        vm.startPrank(routerAdmin);
        router.grantRole(router.ADMIN_ROLE(), address(gov));
        router.grantRole(router.WEIGHT_SETTER_ROLE(), address(gov));
        vm.stopPrank();
    }

    /// @notice Rebalancing works with no gateway deployed: the admin sets default weights and the router routes by them.
    function test_SYS1_defaultWeightsSetWithNoGateway() public {
        address[] memory vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        uint256[] memory bps = new uint256[](2);
        bps[0] = 9500;
        bps[1] = 500;
        vm.prank(govAdmin);
        gov.setDefaultWeights(vaults, bps);
        (address[] memory got, uint256[] memory gotBps) = router.getDefaultWeights();
        assertEq(got.length, 2, "default weights not set");
        assertEq(got[0], address(vaultA));
        assertEq(gotBps[0], 9500);
        assertEq(gotBps[1], 500);
    }

    /// @notice Router, registry and RouterGovernance expose no gateway getter or setter and no onlyGateway entrypoint.
    function test_SYS1_vaultsContractsHaveNoGatewaySurface() public view {
        _assertNoGateway("PortfolioRouter.sol:PortfolioRouter");
        _assertNoGateway("VaultRegistry.sol:VaultRegistry");
        _assertNoGateway("RouterGovernance.sol:RouterGovernance");
    }

    function _assertNoGateway(string memory artifact) internal view {
        bytes memory code = vm.getDeployedCode(artifact);
        assertGt(code.length, 1000, string.concat(artifact, ": no code read"));
        assertFalse(
            CodeSearch.containsSelector(code, bytes4(keccak256("gateway()"))),
            string.concat(artifact, " reads a gateway")
        );
        assertFalse(
            CodeSearch.containsSelector(code, bytes4(keccak256("setGateway(address)"))),
            string.concat(artifact, " sets a gateway")
        );
    }

    /// @notice Source scan: the vaults-system sources that are already clean import nothing from the gateway and
    ///         name no gateway type or modifier in code (comments are skipped). RouterGovernance and the receipt
    ///         are the known violations listed in scripts/ci/system-split-baseline.json.
    function test_SYS1_cleanVaultsSourcesNameNoGateway() public view {
        _assertSourceClean("contracts/PortfolioRouter.sol");
        _assertSourceClean("contracts/VaultRegistry.sol");
        _assertSourceClean("contracts/RobotMoneyVault.sol");
        _assertSourceClean("contracts/ProposerFloorTimelock.sol");
    }

    function _assertSourceClean(string memory path) internal view {
        string memory src = vm.readFile(path);
        assertGt(bytes(src).length, 1000, string.concat(path, ": no source read"));
        string[5] memory banned =
            ["RobotMoneyGateway", "IGateway", "onlyGateway", "GatewayWindows", "gateway/"];
        bytes memory b = bytes(src);
        uint256 lineStart;
        for (uint256 i = 0; i <= b.length; i++) {
            if (i == b.length || b[i] == bytes1("\n")) {
                bytes memory line = new bytes(i - lineStart);
                for (uint256 k = 0; k < line.length; k++) {
                    line[k] = b[lineStart + k];
                }
                if (!_isComment(line)) {
                    for (uint256 t = 0; t < banned.length; t++) {
                        assertFalse(
                            _has(line, bytes(banned[t])), string.concat(path, " names ", banned[t])
                        );
                    }
                }
                lineStart = i + 1;
            }
        }
    }

    function _isComment(bytes memory line) internal pure returns (bool) {
        uint256 i;
        while (i < line.length && (line[i] == bytes1(" ") || line[i] == bytes1("\t"))) i++;
        if (i >= line.length) return true;
        return (line[i] == bytes1("/")
                && i + 1 < line.length
                && (line[i + 1] == bytes1("/") || line[i + 1] == bytes1("*")))
            || line[i] == bytes1("*");
    }

    function _has(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length > hay.length) return false;
        for (uint256 i = 0; i + needle.length <= hay.length; i++) {
            bool ok = true;
            for (uint256 k = 0; k < needle.length; k++) {
                if (hay[i + k] != needle[k]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }

    /// @notice The registry status follows the code: SYS-1 is RED exactly while the receipt register still exposes a
    ///         gateway binding. The removal (1888) must flip the entry to HOLDS in the same PR.
    function test_SYS1_registryStatusFollowsReceiptBinding() public view {
        bytes memory code =
            vm.getDeployedCode("ConsensusRecommendationReceipt.sol:ConsensusRecommendationReceipt");
        bool bound = CodeSearch.containsSelector(code, bytes4(keccak256("gateway()")));
        InvariantRegistry.Entry memory e = InvariantRegistry.get("SYS-1");
        if (bound) {
            assertTrue(
                e.status == InvariantRegistry.Status.RED,
                "SYS-1 must be RED while the receipt binds a gateway"
            );
            assertEq(e.remediationIssue, 1888);
        } else {
            assertTrue(
                e.status == InvariantRegistry.Status.HOLDS,
                "SYS-1 must be HOLDS once the receipt binds no gateway"
            );
            assertEq(e.remediationIssue, 0);
        }
    }
}

/// @title SystemSplitAcl9Test
/// @notice ACL-9 executed assertions, written so they stay valid when authorizeAgent and transferAgentOwnership are removed.
contract SystemSplitAcl9Test is GatewayAgentPolicyFixture {
    /// @notice A permissionless owner cannot name another account as share receiver, at reveal or at setPolicy.
    function test_ACL9_nonAdminOwnerCannotNameAnotherShareReceiver() public {
        address agent = makeAddr("agentA");
        _reveal(user, agent, _policy(user));
        assertEq(_storedShareReceiver(agent), user, "share receiver is the owner");
        bytes32 before = _storedPolicyHash(agent);
        (bool ok, bytes4 sel) = _try(
            user,
            abi.encodeWithSignature(
                "setPolicy(address,(bool,uint64,uint256,uint256,address,address[],address,uint256,uint256,address[]))",
                agent,
                _policy(stranger)
            )
        );
        assertFalse(ok, "owner named another receiver");
        assertEq(sel, bytes4(keccak256("ShareReceiverNotAuthorized()")));
        assertEq(_storedPolicyHash(agent), before, "policy changed");
    }

    /// @dev A plain low-level call: a missing function reverts with no selector, which still counts as refused.
    function _callAs(address caller, bytes memory data) internal returns (bool ok) {
        vm.prank(caller);
        (ok,) = address(gateway).call(data);
    }

    /// @notice For any caller but the owner, setPolicy, revokeAgent and an ownership change leave the owner and the policy as they were.
    function testFuzz_ACL9_strangerCannotChangeOwnerOrPolicy(address caller, address newOwner)
        public
    {
        vm.assume(caller != user && caller != address(0));
        address agent = makeAddr("agentB");
        _reveal(user, agent, _policy(user));
        bytes32 before = _storedPolicyHash(agent);
        bytes memory setPol = abi.encodeWithSignature(
            "setPolicy(address,(bool,uint64,uint256,uint256,address,address[],address,uint256,uint256,address[]))",
            agent,
            _policy(caller)
        );
        bool ok1 = _callAs(caller, setPol);
        bool ok2 = _callAs(caller, abi.encodeWithSignature("revokeAgent(address)", agent));
        bool ok3 = _callAs(
            caller,
            abi.encodeWithSignature("transferAgentOwnership(address,address)", agent, newOwner)
        );
        assertFalse(ok1 || ok2 || ok3, "a stranger changed an agent");
        assertEq(gateway.agentOwner(agent), user, "owner changed");
        assertEq(_storedPolicyHash(agent), before, "policy changed");
    }

    /// @notice The registry status follows the code: ACL-9 is RED exactly while the gateway still has
    ///         authorizeAgent, transferAgentOwnership or lets ADMIN_ROLE grant AGENT_ROLE. The agent lifecycle change (1890)
    ///         must flip the entry to HOLDS in the same PR, and then the second branch executes the full rule.
    function test_ACL9_registryStatusFollowsGatewaySurface() public {
        bytes memory code = vm.getDeployedCode("RobotMoneyGateway.sol:RobotMoneyGateway");
        assertGt(code.length, 1000, "no gateway code read");
        bool hasAuthorize = CodeSearch.containsSelector(
            code,
            bytes4(
                keccak256(
                    "authorizeAgent(address,(bool,uint64,uint256,uint256,address,address[],address,uint256,uint256,address[]))"
                )
            )
        );
        bool hasTransfer = CodeSearch.containsSelector(
            code, bytes4(keccak256("transferAgentOwnership(address,address)"))
        );
        bool adminCanGrant;
        vm.prank(admin);
        (adminCanGrant,) = address(gateway)
            .call(
                abi.encodeWithSignature(
                    "grantRole(bytes32,address)", AGENT_ROLE, makeAddr("planted")
                )
            );
        bool violated = hasAuthorize || hasTransfer || adminCanGrant;
        InvariantRegistry.Entry memory e = InvariantRegistry.get("ACL-9");
        if (violated) {
            assertTrue(
                e.status == InvariantRegistry.Status.RED,
                "ACL-9 must be RED while a role can register an agent or an owner can change"
            );
            assertEq(e.remediationIssue, 1890);
        } else {
            assertTrue(
                e.status == InvariantRegistry.Status.HOLDS,
                "ACL-9 must be HOLDS once the surface is gone"
            );
            assertEq(e.remediationIssue, 0);
            assertFalse(hasAuthorize, "authorizeAgent exists");
            assertFalse(hasTransfer, "transferAgentOwnership exists");
            assertFalse(adminCanGrant, "ADMIN_ROLE granted AGENT_ROLE");
        }
    }
}
