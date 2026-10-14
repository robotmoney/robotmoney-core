// SPDX-License-Identifier: MIT
// Canonical: docs/operations/contract-release-runbooks.md (Recorder keeper, issue 1779).
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BasketVault} from "../../../contracts/vaults/BasketVault.sol";
import {TwapTickMath} from "../../../contracts/lib/TwapTickMath.sol";

contract RecorderKeeperDepositTest is Test {
    function test_keeperRestoresActualNavGuardAndDeposit() public {
        vm.createSelectFork(vm.envString("KEEPER_FORK_RPC_URL"));
        BasketVault vault = BasketVault(0x22bD48C56c34A2C1C1baC77BD7c4E636a6f10D57);
        address usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        assertGt(address(vault).code.length, 0, "deployed rmAGENT must exist at the pin");
        uint256 limit = vault.navDeviationGuardBps();
        assertGt(limit, 0, "actual NAV guard must be enabled");
        assertEq(vault.assetCount(), 1);
        (address token, address pool,, bool active,,) = vault.assets(0);
        assertTrue(active);
        uint256 deviation = TwapTickMath.deviationBps(
            pool, token, usdc, vault.effectiveTwapWindow(token), vault.assetTokenValue(0, 1e6)
        );
        emit log_named_uint("actual NAV deviation bps", deviation);
        assertLe(deviation, limit, "keeper must restore the actual NAV TWAP guard");
        address depositor = makeAddr("keeper-fork-depositor");
        deal(usdc, depositor, 1e6);
        vm.startPrank(depositor);
        IERC20(usdc).approve(address(vault), 1e6);
        uint256 shares = vault.deposit(1e6, depositor);
        vm.stopPrank();
        assertGt(shares, 0, "1 USDC deposit mints shares");
        assertEq(vault.balanceOf(depositor), shares, "returned shares equal credited shares");
        assertEq(IERC20(usdc).balanceOf(depositor), 0, "deposit spent the USDC");
        emit log_named_uint("deposit shares", shares);
    }
}
