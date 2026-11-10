// SPDX-License-Identifier: MIT
// Canonical: scripts/deploy/stage-table.json vaults[].deployPaused (issue 1705 Q1 (a), core 1710)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {ForkSelect} from "./helpers/ForkSelect.sol";
import {VaultTestParams} from "./helpers/VaultTestParams.sol";
import {DeployVault} from "../script/DeployVault.s.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {DeployProtocolAssetVault} from "../script/DeployProtocolAssetVault.s.sol";
import {DeployRwaBasketVault} from "../script/DeployRwaBasketVault.s.sol";
import {DeployHardAssetsVault} from "../script/DeployHardAssetsVault.s.sol";
import {IAerodromePool} from "../interfaces/IAerodromePool.sol";
import {IAerodromeSlipstreamRouter} from "../interfaces/IAerodromeSlipstreamRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";

interface IAeroCardinalityNext {
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
}

interface IDepositsPaused {
    function depositsPaused() external view returns (bool);
}

/// @notice Issue 1705, ADR-0018: the four production vault deploy scripts run in process, and each vault's
///         `depositsPaused()` right after its stage equals the stage table's `deployPaused` for that
///         vault (scripts/deploy/stage-table.json, the one rule table). rmUSDC runs the seeded path
///         the broadcast run takes (the pause follows the seed), the baskets run their in-process
///         entry point. The table row is matched to the script by its `stage` name.
///
///         Runs on the Twin chain (a pinned lazy anvil fork of real Base state): the vault scripts
///         need the real USDC, lending venues and pools. CI runs it in forge-fork-vault-regressions
///         through scripts/devnet/forge-fork-tests.ts, which fails a run in which nothing executed.
///         With FORK_RPC_URL unset the test skips with a named reason.
contract FourVaultInitialStateForkTest is Test {
    using stdJson for string;

    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    string internal constant TABLE = "scripts/deploy/stage-table.json";

    address internal admin = makeAddr("admin");
    bool internal selected;

    function setUp() public {
        selected = ForkSelect.selectOrSkip(vm.envOr("FORK_RPC_URL", string("")));
    }

    function _basketParams(VaultRegistry registry)
        internal
        returns (BasketVaultDeployBase.Params memory)
    {
        return BasketVaultDeployBase.Params({
            admin: admin,
            swapRouter: 0x2626664c2603336E57B271c5C0b26F421741e481,
            usdc: USDC,
            registry: address(registry),
            tvlCap: 100_000 * 1e6,
            perDepositCap: 10_000 * 1e6,
            exitFeeBps: 0,
            feeRecipient: makeAddr("feeRecipient"),
            navDeviationGuardBps: 2000,
            minPoolLiquidity: 1e6,
            recorder: address(0)
        });
    }

    /// @dev The PAXG Aero pool ring holds 900 slots and `addAsset` needs 901 (core 2008): raise `observationCardinalityNext` and swap
    ///      two ways, one block apart, until the ring grows. An Aero CL pool writes an observation only when a swap moves the tick, so
    ///      each leg is 5,000 USDC. HardAssetsVaultFork.t.sol does the same; the production step is in the contract release runbook.
    function _raiseAeroCardinality(string memory cfg) internal {
        address pool = cfg.readAddress(".assets[0].pool");
        address paxg = cfg.readAddress(".assets[0].token");
        address router = cfg.readAddress(".aerodromeSlipstreamRouter");
        (,,, uint16 card,,) = IAerodromePool(pool).slot0();
        if (card >= 901) return;
        IAeroCardinalityNext(pool).increaseObservationCardinalityNext(901);
        address prepper = makeAddr("cardinalityPrepper");
        deal(USDC, prepper, 10_000 * 1e6);
        vm.startPrank(prepper);
        IERC20(USDC).approve(router, type(uint256).max);
        IERC20(paxg).approve(router, type(uint256).max);
        for (uint256 i = 0; i < 1_000 && card < 901; i++) {
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 2);
            bool buy = i % 2 == 0;
            address tokenIn = buy ? USDC : paxg;
            uint256 amountIn = IERC20(tokenIn).balanceOf(prepper);
            if (buy && amountIn > 5_000 * 1e6) amountIn = 5_000 * 1e6;
            IAerodromeSlipstreamRouter(router)
                .exactInputSingle(
                    IAerodromeSlipstreamRouter.ExactInputSingleParams({
                        tokenIn: tokenIn,
                        tokenOut: buy ? paxg : USDC,
                        tickSpacing: 10,
                        recipient: prepper,
                        deadline: block.timestamp,
                        amountIn: amountIn,
                        amountOutMinimum: 0,
                        sqrtPriceLimitX96: 0
                    })
                );
            (,,, card,,) = IAerodromePool(pool).slot0();
        }
        vm.stopPrank();
    }

    /// @dev Runs the vault stage named `stage` in process and returns the vault it deployed.
    function _deploy(string memory stage, VaultRegistry registry) internal returns (address) {
        bytes32 s = keccak256(bytes(stage));
        if (s == keccak256("vault")) {
            deal(USDC, admin, VaultTestParams.SEED_DEPOSIT_AMOUNT);
            return address(
                new DeployVault()
                .runInProcessWithSeed(
                    VaultTestParams.params(admin, USDC),
                    makeAddr("seedShareReceiver"),
                    VaultTestParams.SEED_DEPOSIT_AMOUNT
                )
                .vault
            );
        }
        if (s == keccak256("proto")) {
            return new DeployProtocolAssetVault()
            .runInProcess(_basketParams(registry), vm.readFile("config/protocol-assets.json"))
            .vault;
        }
        if (s == keccak256("rwa")) {
            return new DeployRwaBasketVault()
            .runInProcess(_basketParams(registry), vm.readFile("config/rwa-assets.json"))
            .vault;
        }
        if (s == keccak256("hard")) {
            string memory cfg = vm.readFile("config/hard-assets.json");
            _raiseAeroCardinality(cfg);
            return new DeployHardAssetsVault().runInProcess(_basketParams(registry), cfg).vault;
        }
        revert(string.concat("no in-process deploy for vault stage ", stage));
    }

    function test_fork_eachVaultDeploysWithTheTablesDepositState() public {
        if (!selected) return;
        string memory table = vm.readFile(TABLE);
        VaultRegistry registry = CoreProxies.vaultRegistry(admin);
        uint256 n;
        while (vm.keyExistsJson(table, string.concat(".vaults[", vm.toString(n), "]"))) n++;
        assertEq(n, 4, "the table lists the four vaults");
        for (uint256 i = 0; i < n; i++) {
            string memory row = string.concat(".vaults[", vm.toString(i), "]");
            string memory key = table.readString(string.concat(row, ".key"));
            bool want = table.readBool(string.concat(row, ".deployPaused"));
            address vault = _deploy(table.readString(string.concat(row, ".stage")), registry);
            assertEq(
                IDepositsPaused(vault).depositsPaused(),
                want,
                string.concat(key, ": depositsPaused() differs from the table's deployPaused")
            );
        }
    }
}
