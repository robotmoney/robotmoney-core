// SPDX-License-Identifier: MIT
// Canonical: docs/code-review/20261015-smart-contract-audit/08-adversarial-validation.md
pragma solidity ^0.8.24;

import {BasketVaultTest, MockPool} from "./BasketVault.t.sol";
import {GatewayCommitRevealTest} from "./RobotMoneyGateway.t.sol";
import {RobotMoneyVaultTest, IlliquidMockAdapter} from "./RobotMoneyVault.t.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";

// These are characterization PoCs: passing demonstrates the reported behavior,
// not a fixed vulnerability. Inherited suites remain unchanged.
contract AuditBasket20261016 is BasketVaultTest {
    function test_audit_mintIssuesMoreSharesThanRequested() public {
        uint256 requested = 100e6 * 1e18;
        uint256 charged = vault.previewMint(requested);
        usdc.mint(stranger, charged);
        basketToken.mint(address(router), charged);
        router.setAmountOut(charged);
        vm.startPrank(stranger);
        usdc.approve(address(vault), charged);
        uint256 spent = vault.mint(requested, stranger);
        vm.stopPrank();
        assertEq(spent, charged);
        assertEq(vault.balanceOf(stranger), charged * 1e18);
        assertGt(vault.balanceOf(stranger), requested);
    }

    function test_audit_positivePreviewAllDustPaysZero() public {
        TestERC20 second = new TestERC20();
        MockPool secondPool = new MockPool(address(second), address(usdc), uint160(1 << 96));
        vm.prank(admin);
        vault.addAsset(address(second), address(secondPool), 500, address(0), BasketVault.Venue.V3);
        usdc.mint(stranger, 4);
        basketToken.mint(address(router), 2);
        second.mint(address(router), 2);
        router.setAmountOut(2);
        vm.startPrank(stranger);
        usdc.approve(address(vault), 4);
        uint256 shares = vault.deposit(4, stranger);
        assertEq(vault.previewRedeem(shares), 3);
        assertEq(vault.redeem(shares, stranger, stranger), 0);
        vm.stopPrank();
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(vault.totalSupply(), 0);
        assertEq(basketToken.balanceOf(address(vault)), 2);
        assertEq(second.balanceOf(address(vault)), 2);
    }

    function test_audit_nonDustRedeemCanMissPreviewByOneUnit() public {
        uint256 amount = 100e6;
        usdc.mint(stranger, amount);
        basketToken.mint(address(router), amount);
        router.setAmountOut(amount);
        vm.startPrank(stranger);
        usdc.approve(address(vault), amount);
        uint256 shares = vault.deposit(amount, stranger);
        uint256 preview = vault.previewRedeem(shares);
        router.setAmountOut((amount - 1) * 9900 / 10000);
        uint256 paid = vault.redeem(shares, stranger, stranger);
        vm.stopPrank();
        assertEq(preview, 99e6);
        assertEq(paid + 1, preview);
        assertEq(usdc.balanceOf(stranger), paid);
    }

    function test_audit_degradedReabsorbIgnoresCallerFloorAndLeavesCustody() public {
        vm.prank(admin);
        vault.removeAsset(0);
        basketToken.mint(address(vault), 7e6);
        pool.setRevertObserve(true);
        vm.prank(stranger);
        vault.reabsorbRemovedAsset(0, type(uint256).max);
        assertEq(basketToken.balanceOf(address(vault)), 0);
        assertEq(basketToken.balanceOf(ForeignTokenQuarantine.QUARANTINE), 7e6);
        assertEq(vault.totalAssets(), 0);
        // Local fixture only; this does not establish live-chain control or code.
        assertEq(ForeignTokenQuarantine.QUARANTINE.code.length, 0);
    }
}

contract AuditConsent20261016 is GatewayCommitRevealTest {
    function test_audit_expiredAgentConsentAcceptedWithFreshOwnerCommit() public {
        bytes32 salt = keccak256("audit-stale-consent");
        IGateway.AgentPolicy memory policy = _defaultPolicy();
        bytes32 consent = keccak256(
            abi.encode(
                depositor,
                keccak256(abi.encodeCall(gateway.revealAuthorization, (agent, salt, policy)))
            )
        );
        vm.prank(agent);
        gateway.commitAuthorization(consent);
        vm.roll(block.number + gateway.COMMIT_EXPIRY_BLOCKS() + 1);
        vm.prank(depositor);
        gateway.commitAuthorization(_commitHash(agent, depositor, salt));
        vm.roll(block.number + 1);
        vm.prank(depositor);
        gateway.revealAuthorization(agent, salt, policy);
        assertEq(gateway.agentOwner(agent), depositor);
        assertTrue(gateway.hasRole(agentRole, agent));
    }
}

contract AuditLiquidity20261016 is RobotMoneyVaultTest {
    function test_audit_maxViewsOverstateExecutableLiquidity() public {
        IlliquidMockAdapter venue = new IlliquidMockAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(venue));
        vm.prank(admin);
        vault.addAdapter(address(venue), 10_000);
        vm.prank(alice);
        vault.deposit(100e6, alice);
        venue.setIlliquid(true);
        uint256 maxAssets = vault.maxWithdraw(alice);
        uint256 maxShares = vault.maxRedeem(alice);
        assertEq(maxAssets, 100e6);
        assertEq(maxShares, vault.balanceOf(alice));
        vm.startPrank(alice);
        vm.expectRevert(IlliquidMockAdapter.VenueIlliquid.selector);
        vault.withdraw(maxAssets, alice, alice);
        vm.expectRevert(IlliquidMockAdapter.VenueIlliquid.selector);
        vault.redeem(maxShares, alice, alice);
        vm.stopPrank();
    }
}
