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
import {IAerodromeSlipstreamRouter} from "../interfaces/IAerodromeSlipstreamRouter.sol";
import {IAerodromePool} from "../interfaces/IAerodromePool.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";

interface IAeroCardinality {
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
}

/// @notice Fork regression for rmHARD (core 2008). The real `DeployHardAssetsVault` script runs against the real PAXG token, its
///         real Aero (Aerodrome Slipstream) CL USDC pool, the real Aero factory and router, and real USDC on the Twin chain pin. This
///         proves the existing `AerodromeSwapAdapter` against PAXG's pool factory: the deploy's canonical-pool check, the TWAP price
///         and both swap directions. A deposit buys real PAXG. A redeem sells it in one transaction within the vault slippage cap.
///
///         The pool's observation ring holds 900 slots and `addAsset` needs 901 for the 1800 s window. As in production
///         (docs/operations/contract-release-runbooks.md), `_prepareCardinality` raises `observationCardinalityNext` and drives
///         small two-way swaps, one block apart, until the ring grows.
///
///         Runs on the Twin chain (a pinned lazy anvil fork of real Base state): CI runs it in forge-fork-vault-regressions through
///         scripts/devnet/forge-fork-tests.ts, which fails a run in which nothing executed. With FORK_RPC_URL unset it skips with a
///         named reason.
contract HardAssetsVaultForkTest is Test {
    using stdJson for string;

    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 internal constant DEPOSIT = 1_000 * 1e6;
    uint16 internal constant REQUIRED_CARDINALITY = 901;
    /// @dev Upper bound on prep swaps: one full ring plus slack.
    uint256 internal constant MAX_PREP_SWAPS = 1_000;
    /// @dev An Aero CL pool writes an observation only when a swap moves the tick (CLPool.swap). 5,000 USDC moves the PAXG pool
    ///      a few ticks; 1 USDC does not move it at all.
    uint256 internal constant PREP_SWAP_USDC = 5_000 * 1e6;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal prepper = makeAddr("prepper");

    HardAssetsVault internal vault;
    AerodromeSwapAdapter internal adapter;
    string internal cfg;
    address internal paxg;
    address internal pool;
    address internal router;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (!ForkSelect.selectOrSkip(rpc)) return;

        cfg = vm.readFile("config/hard-assets.json");
        paxg = cfg.readAddress(".assets[0].token");
        pool = cfg.readAddress(".assets[0].pool");
        router = cfg.readAddress(".aerodromeSlipstreamRouter");
        _prepareCardinality();

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

    /// @dev Raise the ring to 901 the production way: `increaseObservationCardinalityNext`, then swaps in later blocks until the
    ///      write index wraps and the cardinality takes the new size. Each round buys PAXG with 5,000 USDC and sells it back, so the
    ///      price returns near where it started.
    function _prepareCardinality() internal {
        (,,, uint16 cardinality,,) = IAerodromePool(pool).slot0();
        if (cardinality >= REQUIRED_CARDINALITY) return;
        IAeroCardinality(pool).increaseObservationCardinalityNext(REQUIRED_CARDINALITY);
        deal(BASE_USDC, prepper, PREP_SWAP_USDC * 2);
        vm.startPrank(prepper);
        IERC20(BASE_USDC).approve(router, type(uint256).max);
        IERC20(paxg).approve(router, type(uint256).max);
        for (uint256 i = 0; i < MAX_PREP_SWAPS && cardinality < REQUIRED_CARDINALITY; i++) {
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 2);
            bool buy = i % 2 == 0;
            address tokenIn = buy ? BASE_USDC : paxg;
            uint256 amountIn = IERC20(tokenIn).balanceOf(prepper);
            if (buy && amountIn > PREP_SWAP_USDC) amountIn = PREP_SWAP_USDC;
            IAerodromeSlipstreamRouter(router)
                .exactInputSingle(
                    IAerodromeSlipstreamRouter.ExactInputSingleParams({
                        tokenIn: tokenIn,
                        tokenOut: buy ? paxg : BASE_USDC,
                        tickSpacing: 10,
                        recipient: prepper,
                        deadline: block.timestamp,
                        amountIn: amountIn,
                        amountOutMinimum: 0,
                        sqrtPriceLimitX96: 0
                    })
                );
            (,,, cardinality,,) = IAerodromePool(pool).slot0();
        }
        vm.stopPrank();
        assertGe(cardinality, REQUIRED_CARDINALITY, "prep raised the PAXG pool ring to 901");
    }

    function test_fork_rmhard_adapterResolvesPaxgPoolThroughTheAeroFactory() public view {
        assertEq(
            address(adapter.FACTORY()),
            cfg.readAddress(".aerodromeSlipstreamFactory"),
            "Aero factory"
        );
        assertEq(address(adapter.ROUTER()), router, "Aero router");
        // The adapter's own canonical-pool check (PoolFactoryMismatch) passes, and 1 PAXG prices in a sane USDC band.
        uint256 oneOz = adapter.twapPrice(pool, paxg, BASE_USDC, 1e18, vault.DEFAULT_TWAP_WINDOW());
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
        uint256 twapValue =
            adapter.twapPrice(pool, paxg, BASE_USDC, held, vault.effectiveTwapWindow(paxg));
        assertEq(
            vault.totalAssets(),
            IERC20(BASE_USDC).balanceOf(address(vault)) + twapValue,
            "NAV equals idle USDC plus the Aero pool TWAP value of the PAXG held"
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
