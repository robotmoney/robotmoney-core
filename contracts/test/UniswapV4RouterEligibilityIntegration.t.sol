// SPDX-License-Identifier: MIT
// Canonical: docs/technical/asset-valuation-hybrid.md (hybrid NAV, PR #1324);
//            docs/audits.md FS-VLT-17.
//
// Issue #1186 acceptance criterion: "The V4 adapter is router-eligible
// (registry accepts it and the guard passes) with executed tests asserting
// it." Every existing `UniswapV4AssetPositionAdapter` test drives the adapter
// through the bespoke `UniV4PositionMockVault` stub (mechanics-only harness);
// none compose a real `Vault`, register it in `VaultRegistry`, flip
// `setRouterEligible`, and drive a deposit through `PortfolioRouter`. This
// file closes that gap end-to-end, reusing the same mock V4 pool/venue
// fixtures the adapter unit suite already uses (contracts/test/
// UniswapV4AssetPositionAdapter.t.sol) — the DEX mechanics are a harness
// there too; what's new here is the registry/router composition, not the V4
// pool model (that gap is separately tracked, docs/audits.md FS-VLT-17/16).
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Vault} from "../Vault.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {UniswapV4AssetPositionAdapter} from "../adapters/UniswapV4AssetPositionAdapter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {
    UniV4PositionMockToken18,
    UniV4PositionMockVenue,
    UniV4PositionMockPool
} from "./UniswapV4AssetPositionAdapter.t.sol";

/// @notice Proves `UniswapV4AssetPositionAdapter` is router-eligible against the
///         REAL `Vault` + `VaultRegistry` + `PortfolioRouter` stack, not just the
///         mock-vault mechanics harness (#1186).
contract UniswapV4RouterEligibilityIntegrationTest is Test {
    uint24 internal constant FEE = 3000;
    uint256 internal constant ONE_USDC = 1e6;

    TestERC20 internal usdc;
    UniV4PositionMockToken18 internal token;
    UniV4PositionMockVenue internal venue;
    UniV4PositionMockPool internal pool;

    Vault internal vault;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    UniswapV4AssetPositionAdapter internal adapter;

    address internal admin = makeAddr("admin");
    address internal emergency = makeAddr("emergency");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal depositor = makeAddr("depositor");

    function setUp() public {
        usdc = new TestERC20();
        token = new UniV4PositionMockToken18();
        venue = new UniV4PositionMockVenue(address(usdc), address(token));
        pool = new UniV4PositionMockPool(address(token), address(usdc), FEE);

        // Venue reserves both legs (mirrors UniswapV4AssetPositionAdapter.t.sol setUp).
        usdc.mint(address(venue), 100_000_000 * ONE_USDC);
        token.mint(address(venue), 100_000 ether);

        vault = new Vault({
            asset_: IERC20(address(usdc)),
            name_: "Robot Money USDC",
            symbol_: "rmUSDC",
            tvlCap_: 10_000_000 * ONE_USDC,
            perDepositCap_: 1_000_000 * ONE_USDC,
            exitFeeBps_: 0,
            maxSlippageBps_: 100,
            maxNavGrowthRateBps_: 10_000,
            feeRecipient_: feeRecipient,
            admin_: admin,
            emergency_: emergency
        });

        adapter = new UniswapV4AssetPositionAdapter(
            address(usdc),
            address(vault),
            address(token),
            address(pool),
            FEE,
            address(0), // hooks: M-S6 requires address(0)
            address(venue)
        );

        vm.startPrank(admin);
        vault.setAdapterAllowed(address(adapter), true);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vault.addAdapter(address(adapter), vault.MAX_BPS(), false);
        vm.stopPrank();

        registry = new VaultRegistry(admin);
        router = new PortfolioRouter(address(usdc), address(registry), admin);

        vm.startPrank(admin);
        registry.registerVault(
            address(vault),
            VaultRegistry.VaultMetadata({
                name: "Robot Money USDC", asset: address(usdc), registeredAt: 0
            })
        );
        vm.stopPrank();

        usdc.mint(depositor, 1_000 * ONE_USDC);
        vm.prank(depositor);
        usdc.approve(address(router), 1_000 * ONE_USDC);
    }

    /// @notice The registry gate is load-bearing: an unregistered-eligible
    ///         vault cannot enter the router's weight vector at all.
    function test_setWeights_revertsBeforeRouterEligible() public {
        address[] memory vaults = new address[](1);
        uint256[] memory bps = new uint256[](1);
        vaults[0] = address(vault);
        bps[0] = 10_000;

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioRouter.VaultNotRouterEligible.selector, address(vault))
        );
        router.setWeights(vaults, bps);
    }

    /// @notice Once router-eligible, a real deposit routes through
    ///         PortfolioRouter -> Vault -> UniswapV4AssetPositionAdapter.deploy(),
    ///         exercising the ORA-4 TWAP-deviation guard on a genuine deploy path
    ///         (not the UniV4PositionMockVault stub) and minting real vault shares
    ///         to the depositor.
    function test_deposit_throughRouter_deploysIntoV4Adapter() public {
        vm.prank(admin);
        registry.setRouterEligible(address(vault), true);

        address[] memory vaults = new address[](1);
        uint256[] memory bps = new uint256[](1);
        vaults[0] = address(vault);
        bps[0] = 10_000;
        vm.prank(admin);
        router.setWeights(vaults, bps);

        uint256 amount = 1_000 * ONE_USDC;
        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        assertEq(shares.length, 1, "single leg");
        assertGt(shares[0], 0, "depositor must receive vault shares");
        assertEq(vault.balanceOf(depositor), shares[0], "shares minted to depositor");

        // The adapter actually custodied the token via a real deploy() call —
        // proof the router/registry/vault composition reached the V4 adapter,
        // not merely that the registry flag flipped.
        assertGt(token.balanceOf(address(adapter)), 0, "adapter must hold TOKEN post-deploy");
        assertApproxEqAbs(adapter.totalAssets(), amount, 1, "adapter NAV ~ routed USDC");
        assertApproxEqAbs(vault.totalAssets(), amount, 1, "vault NAV ~ deposited USDC");
    }
}
