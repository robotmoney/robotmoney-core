// SPDX-License-Identifier: MIT
// Canonical: none -- Foundry unit tests for core issue 1482 (router and gateway redeem gas guards).
// The vault guard is tested in RobotMoneyVaultRedeemGas.t.sol. These tests cover the three paths
// that fan out to a vault: PortfolioRouter.redeemFor, RobotMoneyGateway.withdraw and
// RobotMoneyGateway.withdrawFromRouter. The vault is a gas-metered stub (it burns a fixed
// amount of gas and records the gas it was entered with). A fork run is still needed to prove the
// root cause on the real adapters: see docs/technical/redeem-gas-1482.md.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev ERC-4626-shaped stub whose `redeem` burns `redeemCost` gas (a stand-in for the adapter
///      fan-out) and records `gasleft()` at entry. 1:1 shares to assets.
contract GasMeteredStubVault is ERC20 {
    IERC20 public immutable assetToken;
    uint256 public redeemCost;
    uint256 public entryGas;

    constructor(address asset_) ERC20("Gas Metered Shares", "GMS") {
        assetToken = IERC20(asset_);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setRedeemCost(uint256 cost) external {
        redeemCost = cost;
    }

    function retire() external {}

    function unretire() external {}

    function redeem(uint256 shares, address receiver, address owner)
        external
        returns (uint256 assets)
    {
        entryGas = gasleft();
        uint256 start = gasleft();
        while (start - gasleft() < redeemCost) {}
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        _burn(owner, shares);
        assets = shares;
        assetToken.transfer(receiver, assets);
    }
}

contract RedeemGasGuardsTest is Test {
    uint256 internal constant ONE = 1e6;
    /// @dev Stub cost of the vault fan-out. Well under every floor, so the floors are the binding guard.
    uint256 internal constant STUB_COST = 400_000;

    TestERC20 internal usdc;
    GasMeteredStubVault internal vault;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RobotMoneyGateway internal gateway;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal agent = makeAddr("agent");
    address internal shareReceiver = makeAddr("shareReceiver");
    address internal assetRecipient = makeAddr("assetRecipient");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new TestERC20();
        vault = new GasMeteredStubVault(address(usdc));
        vault.setRedeemCost(STUB_COST);
        usdc.mint(address(vault), 1_000_000 * ONE);

        registry = new VaultRegistry(admin);
        vm.prank(admin);
        registry.registerVault(
            address(vault),
            VaultRegistry.VaultMetadata({name: "Stub", asset: address(usdc), registeredAt: 0})
        );
        router = new PortfolioRouter(address(usdc), address(registry), admin);
        gateway = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(router)
        );

        address[] memory none = new address[](0);
        address[] memory dest = new address[](1);
        dest[0] = address(router);
        vm.prank(admin);
        gateway.authorizeAgent(
            agent,
            IGateway.AgentPolicy({
                active: true,
                validUntil: uint64(block.timestamp + 365 days),
                maxPerPayment: 1_000 * ONE,
                maxPerWindow: 5_000 * ONE,
                shareReceiver: shareReceiver,
                allowedDestinations: dest,
                assetRecipient: assetRecipient,
                maxWithdrawPerPayment: 1_000 * ONE,
                maxWithdrawPerWindow: 5_000 * ONE,
                allowedSourceVaults: none
            })
        );

        // Shares: the agent holds them for gateway.withdraw, shareReceiver for the router path.
        vault.mint(agent, 100 * ONE);
        vault.mint(shareReceiver, 100 * ONE);
        vm.prank(agent);
        vault.approve(address(gateway), type(uint256).max);
        vm.prank(shareReceiver);
        vault.approve(address(gateway), type(uint256).max);
        address alice = makeAddr("alice");
        vault.mint(alice, 100 * ONE);
        vm.prank(alice);
        vault.approve(address(router), type(uint256).max);
    }

    // --- call builders -----------------------------------------------------------------------

    function _routerCall(uint256 gasLimit) internal returns (bool ok, bytes memory ret) {
        address alice = makeAddr("alice");
        address[] memory vs = new address[](1);
        vs[0] = address(vault);
        uint256[] memory sh = new uint256[](1);
        sh[0] = 10 * ONE;
        vm.prank(alice);
        (ok, ret) = address(router).call{gas: gasLimit}(
            abi.encodeCall(
                router.redeemFor, (alice, alice, vs, sh, new uint256[](1), type(uint256).max)
            )
        );
    }

    function _gatewayWithdrawCall(uint256 gasLimit, bytes32 salt)
        internal
        returns (bool ok, bytes memory ret)
    {
        vm.prank(agent);
        (ok, ret) = address(gateway).call{gas: gasLimit}(
            abi.encodeCall(
                gateway.withdraw,
                (salt, 10 * ONE, address(vault), uint64(block.timestamp + 60), salt)
            )
        );
    }

    function _gatewayRouterCall(uint256 gasLimit, bytes32 salt)
        internal
        returns (bool ok, bytes memory ret)
    {
        address[] memory vs = new address[](1);
        vs[0] = address(vault);
        uint256[] memory sh = new uint256[](1);
        sh[0] = 10 * ONE;
        // The gateway pulls from shareReceiver and the router redeems for the gateway.
        vm.prank(agent);
        (ok, ret) = address(gateway).call{gas: gasLimit}(
            abi.encodeCall(
                gateway.withdrawFromRouter,
                (salt, vs, sh, new uint256[](1), uint64(block.timestamp + 60), salt)
            )
        );
    }

    function _sel(bytes memory ret) internal pure returns (bytes4 s) {
        require(ret.length >= 4, "opaque revert: no reason returned");
        assembly {
            s := mload(add(ret, 32))
        }
    }

    /// @dev Bisect the smallest gas limit that succeeds (what eth_estimateGas does), restoring state.
    function _estimate(uint256 which) internal returns (uint256) {
        uint256 snap = vm.snapshotState();
        uint256 lo = 21_000;
        uint256 hi = 8_000_000;
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            bool ok;
            if (which == 0) (ok,) = _routerCall(mid);
            else if (which == 1) (ok,) = _gatewayWithdrawCall(mid, bytes32(uint256(1)));
            else (ok,) = _gatewayRouterCall(mid, bytes32(uint256(1)));
            vm.revertToState(snap);
            snap = vm.snapshotState();
            if (ok) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    // --- router.redeemFor --------------------------------------------------------------------

    function test_router_redeemFor_belowFloor_revertsInsufficientGas() public {
        (bool ok, bytes memory ret) = _routerCall(900_000);
        assertFalse(ok);
        assertEq(_sel(ret), PortfolioRouter.InsufficientGas.selector, "expected InsufficientGas");
        (, uint256 required) = abi.decode(_slice(ret), (uint256, uint256));
        assertEq(required, 1_650_000, "router leg floor");
    }

    function test_router_redeemFor_atFullGas_pays() public {
        (bool ok,) = _routerCall(30_000_000);
        assertTrue(ok);
        assertEq(usdc.balanceOf(makeAddr("alice")), 10 * ONE);
    }

    /// @notice Estimate-then-execute with the gas-metered stub: the bisect estimate lands at the
    ///         floor, executing at exactly that limit pays in full, and the vault is entered with at
    ///         least its own 1_600_000 entry floor. Every limit below the estimate (past the router's
    ///         own pre-guard work) reverts typed, never opaque.
    function test_router_redeemFor_estimateThenExecute() public {
        uint256 est = _estimate(0);
        assertGe(est, 1_650_000, "estimate below the router floor");
        assertLe(est, 1_700_000, "estimate far above the floor");
        uint256 snap = vm.snapshotState();
        (bool ok,) = _routerCall(est);
        assertTrue(ok, "router redeem failed at the exact estimate");
        assertEq(usdc.balanceOf(makeAddr("alice")), 10 * ONE, "short payout at the estimate");
        assertGe(vault.entryGas(), 1_600_000, "vault entered below its own floor");
        vm.revertToState(snap);
        for (uint256 g = 400_000; g < est; g += 7_919) {
            (bool ok2, bytes memory ret) = _routerCall(g);
            vm.revertToState(snap);
            snap = vm.snapshotState();
            assertFalse(ok2);
            assertEq(_sel(ret), PortfolioRouter.InsufficientGas.selector, "opaque below estimate");
        }
    }

    // --- gateway.withdraw --------------------------------------------------------------------

    function test_gateway_withdraw_belowFloor_revertsInsufficientGas() public {
        (bool ok, bytes memory ret) = _gatewayWithdrawCall(900_000, bytes32(uint256(7)));
        assertFalse(ok);
        assertEq(_sel(ret), RobotMoneyGateway.InsufficientGas.selector, "expected InsufficientGas");
        (, uint256 required) = abi.decode(_slice(ret), (uint256, uint256));
        assertEq(required, 1_700_000, "gateway withdraw floor");
    }

    function test_gateway_withdraw_estimateThenExecute() public {
        uint256 est = _estimate(1);
        assertGe(est, 1_700_000, "estimate below the gateway floor");
        // The floor is checked after the gateway's own cold writes (window, payment id, share pull),
        // so the estimate is the floor plus that spend.
        assertLe(est, 1_700_000 + 400_000, "estimate far above the floor");
        (bool ok,) = _gatewayWithdrawCall(est, bytes32(uint256(1)));
        assertTrue(ok, "gateway withdraw failed at the exact estimate");
        assertEq(usdc.balanceOf(assetRecipient), 10 * ONE, "short payout at the estimate");
    }

    // --- gateway.withdrawFromRouter ----------------------------------------------------------

    function test_gateway_withdrawFromRouter_belowFloor_revertsInsufficientGas() public {
        (bool ok, bytes memory ret) = _gatewayRouterCall(900_000, bytes32(uint256(9)));
        assertFalse(ok);
        assertEq(_sel(ret), RobotMoneyGateway.InsufficientGas.selector, "expected InsufficientGas");
        (, uint256 required) = abi.decode(_slice(ret), (uint256, uint256));
        assertEq(required, 1_700_000, "gateway withdraw floor");
    }

    function test_gateway_withdrawFromRouter_estimateThenExecute() public {
        uint256 est = _estimate(2);
        assertGe(est, 1_700_000, "estimate below the gateway floor");
        assertLe(est, 1_700_000 + 400_000, "estimate far above the floor");
        (bool ok,) = _gatewayRouterCall(est, bytes32(uint256(1)));
        assertTrue(ok, "router withdraw failed at the exact estimate");
        assertEq(usdc.balanceOf(assetRecipient), 10 * ONE, "short payout at the estimate");
        assertGe(vault.entryGas(), 1_600_000, "vault entered below its own floor");
    }

    function _slice(bytes memory ret) internal pure returns (bytes memory out) {
        out = new bytes(ret.length - 4);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = ret[i + 4];
        }
    }
}
