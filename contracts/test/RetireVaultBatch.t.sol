// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0017-rmagent-retired-router-uses-three-vaults.md; docs/adr/ADR-0009-vault-retirement-no-assisted-migration.md
//            docs/operations/contract-release-runbooks.md section 4.14 (the governed retire batch)
// Implements: issue 1912 (retire rmAGENT so the router uses three vaults); issue 1988 (the retire with an active applied vector, no clear)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {MockVault} from "./helpers/MockVault.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";
import {MockPool, RecordingSwapRouter} from "./AgentTokenVault.t.sol";

/// @notice The governed retire batch of rmAGENT (ADR-0017, ADR-0009), replayed call by call from the timelock on a four-vault fixture with no fork.
///         rmUSDC, rmPROTO and rmRWA are 1:1 router legs. rmAGENT is the real AgentTokenVault over a flat 1:1 V3 pool double, so its deposit, redeem,
///         redeemInKind, retire and registry link run production code. The batch is the two calls `publish-contracts/src/retire-vault.ts` builds:
///         registry.migrateEligibility(rmAGENT, false, three legs) then registry.retire(rmAGENT), one atomic timelock batch in production.
///         The order is checked on the real contracts: retire first reverts, a four-leg vector after the flip reverts. Nothing here changes PortfolioRouter,
///         VaultRegistry or vault storage.
contract RetireVaultBatchTest is Test {
    uint256 internal constant ONE = 1e6;

    TestERC20 internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    MockVault internal rmUsdc;
    MockVault internal rmProto;
    MockVault internal rmRwa;
    AgentTokenVault internal rmAgent;
    TestERC20 internal bnkr;
    RecordingSwapRouter internal swaps;

    address internal admin = makeAddr("admin");
    address internal timelock = makeAddr("timelock");
    address internal holder = makeAddr("holder");
    address internal depositor = makeAddr("depositor");

    function setUp() public {
        usdc = new TestERC20();
        swaps = new RecordingSwapRouter();
        registry = CoreProxies.vaultRegistry(admin);
        router = CoreProxies.portfolioRouter(address(usdc), address(registry), admin);
        rmUsdc = new MockVault(address(usdc));
        rmProto = new MockVault(address(usdc));
        rmRwa = new MockVault(address(usdc));
        rmAgent = CoreProxies.agentTokenVault(
            IERC20(address(usdc)),
            ISwapRouter(address(swaps)),
            1_000_000 * ONE,
            100_000 * ONE,
            0,
            makeAddr("fees"),
            admin,
            admin
        );
        // One 1:1 asset so the vault holds a position: redeem sells it back through the swap double.
        bnkr = new TestERC20();
        MockPool pool = new MockPool(address(bnkr), address(usdc), 10_000);

        vm.startPrank(admin);
        rmAgent.addAsset(address(bnkr), address(pool), 10_000, address(0), BasketVault.Venue.V3);
        rmAgent.setRegistry(address(registry));
        _register(address(rmUsdc), "Robot Money USDC");
        _register(address(rmProto), "Robot Money Protocol");
        _register(address(rmAgent), "Robot Money Agent Tokens");
        _register(address(rmRwa), "Robot Money RWA");
        // the launch state of the live v0.5.0 deployment: four eligible vaults, the default 9500 / 500 / 0 / 0
        router.setDefaultWeights(_four(), _fourBps(9500, 500, 0, 0));
        registry.setRouter(address(router));
        // the timelock handover of the registry
        registry.grantRole(registry.ADMIN_ROLE(), timelock);
        registry.revokeRole(registry.ADMIN_ROLE(), admin);
        vm.stopPrank();
    }

    function _register(address vault, string memory name) internal {
        registry.registerVault(
            vault, VaultRegistry.VaultMetadata({name: name, asset: address(usdc), registeredAt: 0})
        );
        registry.setRouterEligible(vault, true);
    }

    function _four() internal view returns (address[] memory v) {
        v = new address[](4);
        v[0] = address(rmUsdc);
        v[1] = address(rmProto);
        v[2] = address(rmAgent);
        v[3] = address(rmRwa);
    }

    function _fourBps(uint256 a, uint256 b, uint256 c, uint256 d)
        internal
        pure
        returns (uint256[] memory x)
    {
        x = new uint256[](4);
        x[0] = a;
        x[1] = b;
        x[2] = c;
        x[3] = d;
    }

    function _three() internal view returns (address[] memory v) {
        v = new address[](3);
        v[0] = address(rmUsdc);
        v[1] = address(rmProto);
        v[2] = address(rmRwa);
    }

    function _threeBps(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory x) {
        x = new uint256[](3);
        x[0] = a;
        x[1] = b;
        x[2] = c;
    }

    /// @dev The two calls of the govern row, in the one order the contracts allow, sent as the timelock.
    function _retire(uint256[] memory bps) internal {
        vm.startPrank(timelock);
        registry.migrateEligibility(address(rmAgent), false, _three(), bps);
        registry.retire(address(rmAgent));
        vm.stopPrank();
    }

    /// @dev An existing holder: deposits into rmAGENT while it is Active.
    function _holderDeposit(uint256 amount) internal returns (uint256 shares) {
        usdc.mint(holder, amount);
        vm.startPrank(holder);
        usdc.approve(address(rmAgent), amount);
        shares = rmAgent.deposit(amount, holder);
        vm.stopPrank();
    }

    function _routerDeposit(uint256 amount) internal returns (uint256[] memory shares) {
        usdc.mint(depositor, amount);
        vm.startPrank(depositor);
        usdc.approve(address(router), amount);
        shares = router.deposit(amount, new uint256[](0));
        vm.stopPrank();
    }

    // ─── the state the batch starts from ───────────────────────────────────────

    function test_beforeTheBatchFourVaultsAreEligibleAndTheVectorHasFourLegs() public view {
        assertEq(registry.routerEligibleCount(), 4, "four eligible vaults");
        assertEq(router.defaultWeightsLength(), 4, "four default legs");
        assertTrue(registry.isRouterEligible(address(rmAgent)));
        assertFalse(rmAgent.retired());
    }

    // ─── the batch ──────────────────────────────────────────────────────────────

    function test_batchMovesEligibilityFourToThreeAndShrinksTheVectorToThreeLegs() public {
        _retire(_threeBps(9500, 500, 0));

        assertEq(registry.routerEligibleCount(), 3, "eligible count 4 to 3");
        assertFalse(registry.isRouterEligible(address(rmAgent)), "rmAGENT leaves the eligible set");
        assertEq(router.defaultWeightsLength(), 3, "the default vector has three legs");
        (address[] memory vaults, uint256[] memory bps) = router.getDefaultWeights();
        assertEq(vaults[0], address(rmUsdc));
        assertEq(vaults[1], address(rmProto));
        assertEq(vaults[2], address(rmRwa));
        assertEq(bps[0], 9500);
        assertEq(bps[1], 500);
        assertEq(bps[2], 0);
        (, VaultRegistry.VaultStatus status) = registry.getVault(address(rmAgent));
        assertEq(uint256(status), uint256(VaultRegistry.VaultStatus.Retired), "registry Retired");
        assertTrue(rmAgent.retired(), "the vault's own retired flag is set");
    }

    function test_theOrderIsForcedRetireBeforeTheFlipRevertsAndAFourLegVectorAfterItReverts()
        public
    {
        vm.prank(timelock);
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultRegistry.RetireWhileRouterEligible.selector, address(rmAgent)
            )
        );
        registry.retire(address(rmAgent));

        // the flip with the old four-leg vector: the router wants one leg per eligible vault
        vm.prank(timelock);
        vm.expectRevert(PortfolioRouter.LengthMismatch.selector);
        registry.migrateEligibility(address(rmAgent), false, _four(), _fourBps(9500, 500, 0, 0));

        // a vector that still names the vault being retired is refused too (it is no longer eligible)
        address[] memory bad = new address[](3);
        bad[0] = address(rmUsdc);
        bad[1] = address(rmProto);
        bad[2] = address(rmAgent);
        vm.prank(timelock);
        vm.expectRevert();
        registry.migrateEligibility(address(rmAgent), false, bad, _threeBps(9500, 500, 0));
    }

    // ─── after the batch: deposits are closed, withdrawals stay open ───────────────

    function test_depositIntoRmAgentRevertsAfterTheBatch() public {
        _retire(_threeBps(9500, 500, 0));
        assertEq(rmAgent.maxDeposit(depositor), 0, "a retired vault accepts no deposit");

        usdc.mint(depositor, 10 * ONE);
        vm.startPrank(depositor);
        usdc.approve(address(rmAgent), 10 * ONE);
        vm.expectPartialRevert(ERC4626.ERC4626ExceededMaxDeposit.selector);
        rmAgent.deposit(10 * ONE, depositor);
        vm.stopPrank();
        assertEq(rmAgent.totalSupply(), 0, "no share was minted");
    }

    function test_aRouterLegIntoRmAgentRevertsAfterTheBatch() public {
        _retire(_threeBps(9500, 500, 0));

        // a default vector of the right length that names the retired vault: eligible AND Active legs only (PortfolioRouter._requireActiveAndEligible)
        address[] memory withAgent = new address[](3);
        withAgent[0] = address(rmUsdc);
        withAgent[1] = address(rmProto);
        withAgent[2] = address(rmAgent);
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioRouter.VaultNotActive.selector,
                address(rmAgent),
                VaultRegistry.VaultStatus.Retired
            )
        );
        router.setDefaultWeights(withAgent, _threeBps(9500, 500, 0));

        // making it eligible again would stale the three-leg default vector: the registry refuses until the vector spans four legs
        vm.prank(timelock);
        vm.expectRevert(
            abi.encodeWithSelector(VaultRegistry.StaleDefaultWeightsLength.selector, 4, 3)
        );
        registry.setRouterEligible(address(rmAgent), true);

        // and the router deposit never reaches rmAGENT: it is not a leg of the default vector
        uint256[] memory shares = _routerDeposit(100 * ONE);
        assertEq(shares.length, 3, "three legs");
        assertEq(rmAgent.totalSupply(), 0, "no rmAGENT share is minted");
    }

    function test_redeemAndRedeemInKindStillPayExistingHoldersAfterTheBatch() public {
        uint256 shares = _holderDeposit(100 * ONE);
        assertGt(shares, 0, "the holder has rmAGENT shares");
        assertEq(bnkr.balanceOf(address(rmAgent)), 100 * ONE, "the vault holds the position");

        _retire(_threeBps(9500, 500, 0));

        // redeem: sells the position back through the swap double and pays USDC
        uint256 half = shares / 2;
        vm.prank(holder);
        uint256 paid = rmAgent.redeem(half, holder, holder);
        assertGt(paid, 0, "redeem still pays USDC");
        assertEq(usdc.balanceOf(holder), paid, "the holder received the USDC");

        // redeemInKind: the oracle-free exit pays the asset itself
        uint256 rest = rmAgent.balanceOf(holder);
        vm.prank(holder);
        rmAgent.redeemInKind(rest, holder, holder);
        assertEq(rmAgent.balanceOf(holder), 0, "all shares burned");
        assertGt(bnkr.balanceOf(holder), 0, "redeemInKind still pays the asset");
    }

    // ─── after the batch: the router splits over the three vaults ──────────────────

    function test_routerDepositsSplitOverRmUsdcRmProtoAndRmRwaAndNeverTouchRmAgent() public {
        // a vector that gives every remaining leg weight, to see the split on all three
        _retire(_threeBps(6000, 3000, 1000));

        uint256 amount = 1000 * ONE;
        uint256[] memory shares = _routerDeposit(amount);
        assertEq(shares.length, 3, "the router deposit has three legs");
        assertEq(rmUsdc.balanceOf(depositor), 600 * ONE, "rmUSDC leg 60 percent");
        assertEq(rmProto.balanceOf(depositor), 300 * ONE, "rmPROTO leg 30 percent");
        assertEq(rmRwa.balanceOf(depositor), 100 * ONE, "rmRWA leg 10 percent");
        assertEq(rmAgent.totalSupply(), 0, "no rmAGENT share is minted");
        assertEq(usdc.balanceOf(address(rmAgent)), 0, "no USDC reaches rmAGENT");
        assertEq(usdc.balanceOf(address(router)), 0, "the router holds no USDC");
    }

    function test_theLaunchVectorSendsEverythingToRmUsdcAndRmProto() public {
        _retire(_threeBps(9500, 500, 0));

        uint256[] memory shares = _routerDeposit(1000 * ONE);
        assertEq(shares[0], 950 * ONE, "rmUSDC 95 percent");
        assertEq(rmProto.balanceOf(depositor), 50 * ONE, "rmPROTO 5 percent");
        assertEq(rmRwa.balanceOf(depositor), 0, "rmRWA carries weight 0");
        assertEq(rmAgent.totalSupply(), 0, "rmAGENT is out of the split");
    }

    // ─── the retire while an applied (voted) vector is active: no clear (issue 1988) ─────────

    /// @dev An applied receipt over the four eligible vaults, as on the live deployment: the weight setter writes it.
    function _applyFourLegVector() internal returns (address[] memory v, uint256[] memory b) {
        v = _four();
        b = _fourBps(8000, 1000, 500, 500);
        vm.prank(admin);
        router.setWeights(v, b);
        assertTrue(router.votedWeightsActive(), "the applied vector is active");
    }

    /// @notice The batch runs while an applied vector names rmAGENT. Neither call touches the applied vector: it stays active and unchanged.
    function test_theBatchRunsWithAnActiveAppliedVectorAndLeavesItUnchanged() public {
        (address[] memory v, uint256[] memory b) = _applyFourLegVector();

        _retire(_threeBps(9500, 500, 0));

        (, VaultRegistry.VaultStatus status) = registry.getVault(address(rmAgent));
        assertEq(uint256(status), uint256(VaultRegistry.VaultStatus.Retired), "registry Retired");
        assertEq(registry.routerEligibleCount(), 3, "eligible count 4 to 3");
        assertEq(router.defaultWeightsLength(), 3, "the default vector has three legs");
        assertTrue(router.votedWeightsActive(), "nothing cleared the applied vector");
        (address[] memory ev, uint256[] memory eb) = router.getEffectiveWeights();
        assertEq(ev, v, "the effective vaults are the applied vector");
        assertEq(eb, b, "the effective bps are the applied vector");
    }

    /// @notice With the applied vector still naming the retired vault, the router skips that leg: the preview marks it unavailable with
    ///         amount 0, and a deposit spreads its share over the other legs by their bps. No USDC reaches rmAGENT.
    function test_theRouterSkipsTheRetiredLegOfAnActiveAppliedVector() public {
        _applyFourLegVector();
        _retire(_threeBps(9500, 500, 0));

        uint256 amount = 950 * ONE;
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);
        assertEq(legs.length, 4, "the preview has the applied vector's four legs");
        assertEq(legs[2].vault, address(rmAgent));
        assertTrue(legs[2].unavailable, "the retired leg is unavailable");
        assertEq(legs[2].legAmount, 0, "the retired leg gets nothing");
        assertFalse(
            legs[0].unavailable || legs[1].unavailable || legs[3].unavailable,
            "the other legs stay available"
        );

        _routerDeposit(amount);
        // the 9500 bps of the available legs share the whole amount: 8000, 1000 and 500 of 9500
        assertEq(rmUsdc.balanceOf(depositor), 800 * ONE, "rmUSDC 8000 of 9500");
        assertEq(rmProto.balanceOf(depositor), 100 * ONE, "rmPROTO 1000 of 9500");
        assertEq(rmRwa.balanceOf(depositor), 50 * ONE, "rmRWA 500 of 9500");
        assertEq(rmAgent.totalSupply(), 0, "no rmAGENT share is minted");
        assertEq(usdc.balanceOf(address(rmAgent)), 0, "no USDC reaches rmAGENT");
        assertEq(usdc.balanceOf(address(router)), 0, "the router holds no USDC");
    }

    /// @notice The next receipt sets the three-vault vector. A vector that still names the retired vault is refused, so the applied
    ///         vector can only move to the three vaults that stay.
    function test_theNextReceiptReplacesTheAppliedVectorWithTheThreeVaults() public {
        _applyFourLegVector();
        _retire(_threeBps(9500, 500, 0));

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioRouter.VaultNotActive.selector,
                address(rmAgent),
                VaultRegistry.VaultStatus.Retired
            )
        );
        router.setWeights(_four(), _fourBps(8000, 1000, 500, 500));

        vm.prank(admin);
        router.setWeights(_three(), _threeBps(8000, 1000, 1000));
        assertTrue(router.votedWeightsActive());
        (address[] memory ev, uint256[] memory eb) = router.getEffectiveWeights();
        assertEq(ev, _three(), "the effective vector is the three vaults that stay");
        assertEq(eb, _threeBps(8000, 1000, 1000));
    }

    // ─── nothing moves a holder's funds ─────────────────────────────────────────────

    function test_theBatchMovesNoHolderFunds() public {
        uint256 shares = _holderDeposit(100 * ONE);
        uint256 supply = rmAgent.totalSupply();
        uint256 position = bnkr.balanceOf(address(rmAgent));

        _retire(_threeBps(9500, 500, 0));

        assertEq(rmAgent.balanceOf(holder), shares, "the holder keeps the shares");
        assertEq(rmAgent.totalSupply(), supply, "supply is unchanged");
        assertEq(bnkr.balanceOf(address(rmAgent)), position, "the position is untouched");
    }
}
