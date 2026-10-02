// SPDX-License-Identifier: MIT
// Canonical: the one-deployment-scheme plan, core 1492 (AC2)
//            docs/prd.md §11.4 — RWA / Thematic Vault (rmRWA)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployRwaBasketVault} from "../script/DeployRwaBasketVault.s.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {RwaBasketVault} from "../vaults/RwaBasketVault.sol";
import {UniswapV3SwapAdapter} from "../adapters/UniswapV3SwapAdapter.sol";

/// @notice Fork regression for rmRWA. The real `DeployRwaBasketVault` script runs against the real
///         deSPXA fee 500 pool, real SwapRouter02 and real USDC at Base block 52082423. A deposit
///         buys real deSPXA. NAV (`totalAssets`) must equal the idle USDC plus the pool TWAP value
///         of the held deSPXA, and must sit within the vault slippage bound of the deposit.
///
///         Run through scripts/devnet/run-golden-forge-forks.sh (pinned fixture) or with
///         FORK_RPC_URL pointing at an archive node. It never silent-skips: `setUp` reverts
///         when no fork resolves.
contract RwaBasketVaultFork is Test {
    using stdJson for string;

    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 internal constant FORK_BLOCK = 52082423;
    uint256 internal constant DEPOSIT = 1_000 * 1e6;
    /// @dev Same tolerance the other basket vault tests use: the vault slippage bound (100 bps)
    ///      plus the pool fee (5 bps) between spot execution and the TWAP.
    uint256 internal constant TOLERANCE_BPS = 150;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");

    RwaBasketVault internal vault;
    address internal adapter;
    string internal cfg;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string("http://127.0.0.1:8545"));
        vm.createSelectFork(rpc);
        // The pinned fixture is already at the pinned block. A live fork selects it explicitly.
        if (bytes(vm.envOr("FORK_RPC_URL", string(""))).length != 0) {
            vm.rollFork(FORK_BLOCK);
        }

        cfg = vm.readFile("config/rwa-assets.json");
        VaultRegistry registry = new VaultRegistry(admin);
        BasketVaultDeployBase.Params memory p = BasketVaultDeployBase.Params({
            admin: admin,
            swapRouter: cfg.readAddress(".swapRouter02"),
            usdc: BASE_USDC,
            registry: address(registry),
            tvlCap: 100_000 * 1e6,
            perDepositCap: 10_000 * 1e6,
            exitFeeBps: 0,
            feeRecipient: makeAddr("feeRecipient")
        });
        BasketVaultDeployBase.Deployed memory d = new DeployRwaBasketVault().runInProcess(p, cfg);
        vault = RwaBasketVault(d.vault);
        adapter = d.adapter;
        deal(BASE_USDC, alice, DEPOSIT);
    }

    function test_fork_rmrwa_navEqualsPoolTwapValue() public {
        address token = cfg.readAddress(".assets[0].token");
        address pool = cfg.readAddress(".assets[0].pool");

        vm.prank(admin);
        vault.unpause();

        vm.startPrank(alice);
        IERC20(BASE_USDC).approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, alice);
        vm.stopPrank();

        uint256 held = IERC20(token).balanceOf(address(vault));
        assertGt(held, 0, "deposit bought deSPXA");

        uint256 twapValue = UniswapV3SwapAdapter(adapter)
            .twapPrice(pool, token, BASE_USDC, held, vault.effectiveTwapWindow(token));
        uint256 expectedNav = IERC20(BASE_USDC).balanceOf(address(vault)) + twapValue;
        assertEq(
            vault.totalAssets(),
            expectedNav,
            "NAV equals idle USDC plus the fee 500 pool TWAP value"
        );

        // And the NAV sits within tolerance of what the depositor paid.
        uint256 nav = vault.totalAssets();
        uint256 lo = DEPOSIT * (10_000 - TOLERANCE_BPS) / 10_000;
        uint256 hi = DEPOSIT * (10_000 + TOLERANCE_BPS) / 10_000;
        assertGe(nav, lo, "NAV not below the deposit by more than the tolerance");
        assertLe(nav, hi, "NAV not above the deposit by more than the tolerance");
    }
}
