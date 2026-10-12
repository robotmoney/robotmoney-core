// SPDX-License-Identifier: MIT
// Canonical: none -- core issue 1513 (BasketVault redeem estimate-then-include, follow-up to core 1482).
// See docs/technical/redeem-gas-1482.md.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ForkSelect} from "./helpers/ForkSelect.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {DeployProtocolAssetVault} from "../script/DeployProtocolAssetVault.s.sol";
import {DeployAgentTokenVault} from "../script/DeployAgentTokenVault.s.sol";
import {DeployRwaBasketVault} from "../script/DeployRwaBasketVault.s.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {BasketVault} from "../vaults/BasketVault.sol";

/// @notice Fork test: for each basket vault (rmPROTO, rmAGENT, rmRWA) a redeem estimated in one
///         block must execute at exactly that limit in a later block. Estimation is the smallest
///         passing limit by bisection, as `eth_estimateGas` does. Requires FORK_RPC_URL.
contract BasketVaultRedeemGasForkTest is Test {
    using stdJson for string;

    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address internal constant DESPXA = 0x9c5C365e764829876243d0b289733B9D2b729685;
    uint256 internal constant DEPOSIT = 1_000 * 1e6;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    bool internal selected;

    function setUp() public {
        selected = ForkSelect.selectOrSkip(vm.envOr("FORK_RPC_URL", string("")));
    }

    function _params() internal returns (BasketVaultDeployBase.Params memory) {
        VaultRegistry registry = new VaultRegistry(admin);
        return BasketVaultDeployBase.Params({
            admin: admin,
            swapRouter: 0x2626664c2603336E57B271c5C0b26F421741e481,
            usdc: USDC,
            registry: address(registry),
            tvlCap: 100_000 * 1e6,
            perDepositCap: 10_000 * 1e6,
            exitFeeBps: 25,
            feeRecipient: makeAddr("feeRecipient"),
            navDeviationGuardBps: 2000,
            minPoolLiquidity: 1e6,
            recorder: address(0)
        });
    }

    function _proto() internal returns (BasketVault) {
        string memory cfg = vm.readFile("config/protocol-assets.json");
        return BasketVault(new DeployProtocolAssetVault().runInProcess(_params(), cfg).vault);
    }

    /// @dev rmAGENT ships holding only RM, so the fork test gives it the real wETH and
    ///      cbBTC pools to make the redeem sell through Uniswap.
    function _agent() internal returns (BasketVault) {
        return BasketVault(new DeployAgentTokenVault().runInProcess(_params(), _agentCfg()).vault);
    }

    function _agentCfg() internal pure returns (string memory) {
        return string.concat(
            '{"swapRouter02":"0x2626664c2603336E57B271c5C0b26F421741e481","shortlist":[',
            '{"symbol":"wETH","token":"0x4200000000000000000000000000000000000006",',
            '"venue":"UniswapV3","pool":"0xd0b53D9277642d899DF5C87A3966A349A798F224","poolFee":500},',
            '{"symbol":"cbBTC","token":"0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",',
            '"venue":"UniswapV3","pool":"0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef","poolFee":500}]}'
        );
    }

    function _rwa() internal returns (BasketVault) {
        string memory cfg = vm.readFile("config/rwa-assets.json");
        return BasketVault(new DeployRwaBasketVault().runInProcess(_params(), cfg).vault);
    }

    function _try(BasketVault v, bytes memory data, uint256 gasLimit) internal returns (bool ok) {
        vm.prank(alice);
        (ok,) = address(v).call{gas: gasLimit}(data);
    }

    function _estimate(BasketVault v, bytes memory data) internal returns (uint256) {
        uint256 snap = vm.snapshotState();
        uint256 lo = 21_000;
        uint256 hi = 8_000_000;
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            bool ok = _try(v, data, mid);
            vm.revertToState(snap);
            snap = vm.snapshotState();
            if (ok) hi = mid;
            else lo = mid;
        }
        vm.revertToState(snap);
        return hi;
    }

    function _fund(BasketVault v) internal {
        vm.prank(admin);
        v.unpauseDeposits();
        deal(USDC, alice, DEPOSIT);
        vm.startPrank(alice);
        IERC20(USDC).approve(address(v), DEPOSIT);
        v.deposit(DEPOSIT, alice);
        vm.stopPrank();
    }

    function _estimateThenIncludeLater(BasketVault v, string memory label) internal {
        _fund(v);
        bytes memory data = abi.encodeCall(v.redeem, (v.balanceOf(alice) / 2, alice, alice));
        uint256[4] memory gaps = [uint256(2), 1 hours, 1 days, 7 days];
        uint256 t0 = block.timestamp;
        uint256 n0 = block.number;
        uint256 snap = vm.snapshotState();
        for (uint256 i = 0; i < gaps.length; i++) {
            uint256 est = _estimate(v, data);
            vm.warp(t0 + gaps[i]);
            vm.roll(n0 + 1 + gaps[i] / 2);
            emit log_named_uint(string.concat(label, " estimate"), est);
            emit log_named_uint(
                string.concat(label, " smallest passing limit later"), _estimate(v, data)
            );
            assertTrue(_try(v, data, est), string.concat(label, ": redeem failed at the estimate"));
            vm.revertToState(snap);
            snap = vm.snapshotState();
            vm.warp(t0);
            vm.roll(n0);
        }
    }

    /// @dev The other drift direction: the estimate runs in a later block, the transaction is
    ///      included in the state of the deposit block. Also a third party swaps a large size in
    ///      the first pool between estimate and inclusion, so the redeem crosses more ticks.
    function _estimateThenIncludeShifted(BasketVault v, string memory label) internal {
        _fund(v);
        bytes memory data = abi.encodeCall(v.redeem, (v.balanceOf(alice) / 2, alice, alice));
        uint256 t0 = block.timestamp;
        uint256 n0 = block.number;
        uint256 snap = vm.snapshotState();

        // Estimate later, include in the earlier state.
        vm.warp(t0 + 1 hours);
        vm.roll(n0 + 1800);
        uint256 estLater = _estimate(v, data);
        vm.revertToState(snap);
        vm.warp(t0);
        vm.roll(n0);
        assertTrue(
            _try(v, data, estLater), string.concat(label, ": failed at a later-block estimate")
        );
        vm.revertToState(snap);
        snap = vm.snapshotState();

        // Estimate now, then a large third-party buy moves the pool before inclusion.
        uint256 est = _estimate(v, data);
        address whale = makeAddr("whale");
        deal(USDC, whale, 5_000_000 * 1e6);
        vm.startPrank(whale);
        IERC20(USDC).approve(SWAP_ROUTER, type(uint256).max);
        bool swapped;
        for (uint256 i = 0; i < 3; i++) {
            address token = i == 0 ? WETH : (i == 1 ? CBBTC : DESPXA);
            if (v.balanceOf(alice) == 0 || !_holds(v, token)) continue;
            (bool ok,) = SWAP_ROUTER.call(
                abi.encodeWithSignature(
                    "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
                    USDC,
                    token,
                    uint24(500),
                    whale,
                    100_000 * 1e6,
                    uint256(0),
                    uint160(0)
                )
            );
            swapped = swapped || ok;
        }
        vm.stopPrank();
        assertTrue(swapped, string.concat(label, ": third-party swap did not execute"));
        vm.warp(t0 + 2);
        vm.roll(n0 + 1);
        emit log_named_uint(string.concat(label, " estimate before the third-party swap"), est);
        emit log_named_uint(
            string.concat(label, " smallest passing limit after it"), _estimate(v, data)
        );
        assertTrue(_try(v, data, est), string.concat(label, ": failed after a third-party swap"));
    }

    function _holds(BasketVault v, address token) internal view returns (bool) {
        return IERC20(token).balanceOf(address(v)) > 0;
    }

    function test_fork_rmproto_redeemEstimateThenIncludeLater() public {
        if (!selected) return;
        _estimateThenIncludeLater(_proto(), "rmPROTO");
    }

    function test_fork_rmagent_redeemEstimateThenIncludeLater() public {
        if (!selected) return;
        _estimateThenIncludeLater(_agent(), "rmAGENT");
    }

    function test_fork_rmrwa_redeemEstimateThenIncludeLater() public {
        if (!selected) return;
        _estimateThenIncludeLater(_rwa(), "rmRWA");
    }

    function test_fork_rmproto_redeemEstimateThenIncludeShifted() public {
        if (!selected) return;
        _estimateThenIncludeShifted(_proto(), "rmPROTO");
    }

    function test_fork_rmagent_redeemEstimateThenIncludeShifted() public {
        if (!selected) return;
        _estimateThenIncludeShifted(_agent(), "rmAGENT");
    }

    function test_fork_rmrwa_redeemEstimateThenIncludeShifted() public {
        if (!selected) return;
        _estimateThenIncludeShifted(_rwa(), "rmRWA");
    }

    /// @notice Core 1778. A position worth a few cents leaves the vault holding a handful of
    ///         cbBTC base units (8 decimals, one unit is worth about 0.001 USDC). The Uniswap V3
    ///         pool rounds the fee-adjusted input down by one unit, which for 31 units is a 3.2
    ///         percent shortfall against the TWAP. The old floor (TWAP of the full amount at 1
    ///         percent slippage) then reverted "Too little received" on the real swap router. The
    ///         floor now prices one unit less, so the dust redeem executes.
    function test_fork_rmproto_dustRedeemSellsEveryLeg_core1778() public {
        if (!selected) return;
        BasketVault v = _proto();
        vm.prank(admin);
        v.unpauseDeposits();
        uint256 dust = 52_224; // 0.052224 USDC, the size of the failed mainnet position
        deal(USDC, alice, dust);
        vm.startPrank(alice);
        IERC20(USDC).approve(address(v), dust);
        v.deposit(dust, alice);
        vm.stopPrank();

        uint256 cbBtcHeld = IERC20(CBBTC).balanceOf(address(v));
        emit log_named_uint("cbBTC base units held by the vault", cbBtcHeld);
        assertGt(cbBtcHeld, 0, "the position holds cbBTC");
        assertLt(cbBtcHeld, 1000, "the cbBTC leg is dust");

        uint256 shares = v.balanceOf(alice);
        vm.prank(alice);
        uint256 out = v.redeem(shares, alice, alice);
        assertEq(v.balanceOf(alice), 0, "all shares redeemed");
        assertEq(IERC20(USDC).balanceOf(alice), out, "alice holds the payout");
        assertGt(out, dust * 90 / 100, "the payout is within 10 percent of the deposit");
    }
}
