// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md §11.5 — Hard Assets Vault (rmHARD)
//            docs/adr/ADR-0018-hard-assets-vault-fourth-router-vault.md (core 2008)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ForkSelect} from "./helpers/ForkSelect.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployHardAssetsVault} from "../script/DeployHardAssetsVault.s.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {HardAssetsVault} from "../vaults/HardAssetsVault.sol";
import {AerodromeSwapAdapter} from "../adapters/AerodromeSwapAdapter.sol";
import {IAerodromePool} from "../interfaces/IAerodromePool.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";

/// @notice Fork regression for rmHARD (core 2008). The real `DeployHardAssetsVault` script runs against the real PAXG token, its
///         real Aero (Aerodrome Slipstream) CL USDC pool, the real Aero factory and router, and real USDC on the fork pin. This
///         proves the existing `AerodromeSwapAdapter` against PAXG's pool factory: the deploy's canonical-pool check, `addAsset`,
///         the TWAP price and both swap directions. A deposit buys real PAXG. A redeem sells it in one transaction within the vault
///         slippage cap.
///
///         The pool is used exactly as it is: nothing in this test changes its state before the deploy (owner correction
///         2026-11-10). Its observation ring has 900 slots, so the vault reads PAXG over the 1798 s window that ring serves
///         (config `twapWindow`, ADR-0018), and `addAsset` vets the pool for that window.
///
///         Runs on the Twin chain (a pinned lazy anvil fork of real Base state): CI runs it in forge-fork-vault-regressions through
///         scripts/devnet/forge-fork-tests.ts, which fails a run in which nothing executed. With FORK_RPC_URL unset it skips with a
///         named reason.
contract HardAssetsVaultForkTest is Test {
    using stdJson for string;

    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 internal constant DEPOSIT = 1_000 * 1e6;
    /// @dev The PAXG window: what a 900-slot ring covers at 2 s blocks (1798 / 2 + 1 = 900).
    uint32 internal constant PAXG_TWAP_WINDOW = 1_798;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");

    HardAssetsVault internal vault;
    AerodromeSwapAdapter internal adapter;
    string internal cfg;
    address internal paxg;
    address internal pool;
    uint16 internal ringBefore;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (!ForkSelect.selectOrSkip(rpc)) return;

        cfg = vm.readFile("config/hard-assets.json");
        paxg = cfg.readAddress(".assets[0].token");
        pool = cfg.readAddress(".assets[0].pool");
        (,,, ringBefore,,) = IAerodromePool(pool).slot0();

        VaultRegistry registry = CoreProxies.vaultRegistry(admin);
        BasketVaultDeployBase.Params memory p = BasketVaultDeployBase.Params({
            admin: admin,
            swapRouter: cfg.readAddress(".swapRouter02"),
            usdc: BASE_USDC,
            registry: address(registry),
            tvlCap: 100_000 * 1e6,
            perDepositCap: 10_000 * 1e6,
            exitFeeBps: 0,
            feeRecipient: makeAddr("feeRecipient"),
            navDeviationGuardBps: 400,
            minPoolLiquidity: 1e6,
            recorder: address(0)
        });
        BasketVaultDeployBase.Deployed memory d = new DeployHardAssetsVault().runInProcess(p, cfg);
        vault = HardAssetsVault(d.vault);
        adapter = AerodromeSwapAdapter(d.adapter);
        deal(BASE_USDC, alice, DEPOSIT);
    }

    function test_fork_rmhard_addAssetOnTheUnmodifiedPoolWithThePaxgWindow() public view {
        (,,, uint16 ring,,) = IAerodromePool(pool).slot0();
        assertEq(ring, ringBefore, "the deploy changed nothing in the pool's ring");
        assertGe(
            uint256(ring), uint256(PAXG_TWAP_WINDOW) / 2 + 1, "the real ring serves the PAXG window"
        );
        assertEq(uint256(cfg.readUint(".assets[0].twapWindow")), PAXG_TWAP_WINDOW, "config window");
        assertEq(
            vault.effectiveTwapWindow(paxg),
            PAXG_TWAP_WINDOW,
            "the vault reads PAXG over its window"
        );
        assertEq(vault.assetCount(), 1, "addAsset registered PAXG");
        (address token, address p,,,,) = vault.assets(0);
        assertEq(token, paxg);
        assertEq(p, pool);
    }

    function test_fork_rmhard_adapterResolvesPaxgPoolThroughTheAeroFactory() public view {
        assertEq(
            address(adapter.FACTORY()),
            cfg.readAddress(".aerodromeSlipstreamFactory"),
            "Aero factory"
        );
        assertEq(
            address(adapter.ROUTER()), cfg.readAddress(".aerodromeSlipstreamRouter"), "Aero router"
        );
        // The adapter's own canonical-pool check (PoolFactoryMismatch) passes, and 1 PAXG over the PAXG window prices in a sane band.
        uint256 oneOz = adapter.twapPrice(pool, paxg, BASE_USDC, 1e18, PAXG_TWAP_WINDOW);
        assertGt(oneOz, 1_000 * 1e6, "1 PAXG is above 1,000 USDC");
        assertLt(oneOz, 20_000 * 1e6, "1 PAXG is below 20,000 USDC");
    }

    function test_fork_rmhard_depositHoldsPaxgAndRedeemsInOneTxWithinSlippageCap() public {
        vm.prank(admin);
        vault.unpauseDeposits();

        vm.startPrank(alice);
        IERC20(BASE_USDC).approve(address(vault), DEPOSIT);
        uint256 shares = vault.deposit(DEPOSIT, alice);
        vm.stopPrank();
        assertGt(shares, 0, "shares minted");

        uint256 held = IERC20(paxg).balanceOf(address(vault));
        assertGt(held, 0, "deposit bought PAXG");
        uint256 twapValue = adapter.twapPrice(pool, paxg, BASE_USDC, held, PAXG_TWAP_WINDOW);
        assertEq(
            vault.totalAssets(),
            IERC20(BASE_USDC).balanceOf(address(vault)) + twapValue,
            "NAV equals idle USDC plus the Aero pool TWAP value of the PAXG held, over the PAXG window"
        );

        uint256 preview = vault.previewRedeem(shares);
        uint256 before = IERC20(BASE_USDC).balanceOf(alice);
        vm.prank(alice);
        vault.redeem(shares, alice, alice);
        uint256 received = IERC20(BASE_USDC).balanceOf(alice) - before;
        assertGe(
            received,
            preview * (10_000 - vault.maxSlippageBps()) / 10_000,
            "redeem proceeds within the slippage cap of previewRedeem"
        );
        assertEq(IERC20(paxg).balanceOf(address(vault)), 0, "PAXG sold on the full redeem");
        assertEq(vault.balanceOf(alice), 0, "shares burned");
    }
}
