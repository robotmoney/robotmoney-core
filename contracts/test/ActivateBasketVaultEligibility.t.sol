// SPDX-License-Identifier: MIT
// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops), core S4 (issue 1486)
pragma solidity ^0.8.24;

import {ActivateBasketVaultEligibility} from "../script/ActivateBasketVaultEligibility.s.sol";
import {DeployProtocolAssetVault} from "../script/DeployProtocolAssetVault.s.sol";
import {DeployAgentTokenVault} from "../script/DeployAgentTokenVault.s.sol";
import {DeployRwaBasketVault} from "../script/DeployRwaBasketVault.s.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {BasketDeployFixture} from "./helpers/BasketDeployFixture.sol";

/// @notice The governed eligibility step covers rmPROTO, rmAGENT and rmRWA. Each flip is one
///         atomic `registry.migrateEligibility`, so it works with a default vector in place.
contract ActivateBasketVaultEligibilityTest is BasketDeployFixture {
    ActivateBasketVaultEligibility internal script;
    PortfolioRouter internal router;

    address internal protoVault;
    address internal agentVault;
    address internal rwaVault;

    function setUp() public {
        _fixtureSetUp();
        script = new ActivateBasketVaultEligibility();
        router = new PortfolioRouter(address(usdc), address(registry), deployer);

        string memory empty = _emptyJson("assets");
        protoVault = new DeployProtocolAssetVault().runInProcess(_params(), empty).vault;
        agentVault =
        new DeployAgentTokenVault().runInProcess(_params(), _emptyJson("shortlist")).vault;
        rwaVault = new DeployRwaBasketVault().runInProcess(_params(), empty).vault;
    }

    function _emptyJson(string memory key) internal view returns (string memory) {
        return string.concat('{"swapRouter02":"', vm.toString(router02), '","', key, '":[]}');
    }

    function _link() internal {
        vm.startPrank(deployer);
        registry.setRouter(address(router));
        registry.grantRole(registry.ADMIN_ROLE(), address(script));
        vm.stopPrank();
    }

    function test_allThreeBecomeRouterEligible() public {
        _link();
        assertFalse(registry.isRouterEligible(protoVault));
        assertFalse(registry.isRouterEligible(agentVault));
        assertFalse(registry.isRouterEligible(rwaVault));

        ActivateBasketVaultEligibility.Activated memory a =
            script.runInProcessWith(address(registry), protoVault, agentVault, rwaVault);

        assertTrue(registry.isRouterEligible(protoVault), "rmPROTO eligible");
        assertTrue(registry.isRouterEligible(agentVault), "rmAGENT eligible");
        assertTrue(registry.isRouterEligible(rwaVault), "rmRWA eligible");
        assertEq(registry.routerEligibleCount(), 3);
        assertEq(a.rwaVault, rwaVault);
        assertEq(a.registry, address(registry));
    }

    function test_defaultVectorSpansTheEligibleSetAtEveryStep() public {
        _link();
        script.runInProcessWith(address(registry), protoVault, agentVault, rwaVault);
        assertEq(router.defaultWeightsLength(), 3, "vector length equals eligible count");
        (address[] memory vaults, uint256[] memory bps) = router.getDefaultWeights();
        assertEq(vaults.length, 3);
        uint256 total;
        for (uint256 i = 0; i < 3; i++) {
            total += bps[i];
        }
        assertEq(total, 10_000, "weights sum to 10000");
        assertEq(vaults[0], protoVault);
        assertEq(vaults[1], agentVault);
        assertEq(vaults[2], rwaVault);
    }

    function test_separateSetterDeadlocksOnceAVectorExists() public {
        _link();
        // Activate two, so a default vector of length 2 exists.
        vm.startPrank(deployer);
        address[] memory v1 = new address[](1);
        uint256[] memory w1 = new uint256[](1);
        v1[0] = protoVault;
        w1[0] = 10_000;
        registry.migrateEligibility(protoVault, true, v1, w1);
        vm.stopPrank();
        // The non-atomic setter now reverts: this is why the script uses migrateEligibility.
        vm.prank(deployer);
        vm.expectRevert();
        registry.setRouterEligible(agentVault, true);
    }

    function test_rerunSkipsVaultsAlreadyEligible() public {
        _link();
        script.runInProcessWith(address(registry), protoVault, agentVault, rwaVault);
        script.runInProcessWith(address(registry), protoVault, agentVault, rwaVault);
        assertEq(registry.routerEligibleCount(), 3);
        assertEq(router.defaultWeightsLength(), 3);
    }

    function test_reverts_whenNoRouterLinked() public {
        bytes32 adminRole = registry.ADMIN_ROLE();
        vm.prank(deployer);
        registry.grantRole(adminRole, address(script));
        vm.expectRevert(bytes("registry has no linked router: link it at stage 4 first"));
        script.runInProcessWith(address(registry), protoVault, agentVault, rwaVault);
    }

    function test_reverts_onZeroInputs() public {
        vm.expectRevert(bytes("registry=0"));
        script.runInProcessWith(address(0), protoVault, agentVault, rwaVault);
        vm.expectRevert(bytes("protocolVault=0"));
        script.runInProcessWith(address(registry), address(0), agentVault, rwaVault);
        vm.expectRevert(bytes("agentVault=0"));
        script.runInProcessWith(address(registry), protoVault, address(0), rwaVault);
        vm.expectRevert(bytes("rwaVault=0"));
        script.runInProcessWith(address(registry), protoVault, agentVault, address(0));
    }
}
