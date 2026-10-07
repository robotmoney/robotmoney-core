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
    /// @dev Same signature as the real vault's error, so the selector matches.
    error InsufficientGas(uint256 available, uint256 required);

    IERC20 public immutable assetToken;
    uint256 public redeemCost;
    uint256 public entryGas;
    /// @dev Models the real vault: a typed entry floor, and an extra cost paid by the first
    ///      redeem in a new timestamp (interest accrual, about 96k on the Base fork).
    uint256 public entryFloor;
    uint256 public accrualCost;
    uint256 public lastAccrual;

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

    function setRealistic(uint256 entryFloor_, uint256 cost, uint256 accrualCost_) external {
        entryFloor = entryFloor_;
        redeemCost = cost;
        accrualCost = accrualCost_;
    }

    function retire() external {}

    function unretire() external {}

    function redeem(uint256 shares, address receiver, address owner)
        external
        returns (uint256 assets)
    {
        entryGas = gasleft();
        if (entryGas < entryFloor) revert InsufficientGas(entryGas, entryFloor);
        uint256 cost = redeemCost;
        if (lastAccrual != block.timestamp) {
            lastAccrual = block.timestamp;
            cost += accrualCost;
        }
        uint256 start = gasleft();
        while (start - gasleft() < cost) {}
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        _burn(owner, shares);
        assets = shares;
        assetToken.transfer(receiver, assets);
    }
}

contract RedeemGasGuardsTest is Test {
    uint256 internal constant ONE = 1e6;
    /// @dev Stub cost of the vault fan-out. Well under every floor, so the floors are the binding guard.
    ///      The `_includeLater` tests switch the stubs to a cost modelled on the fork instead.
    uint256 internal constant STUB_COST = 400_000;

    TestERC20 internal usdc;
    GasMeteredStubVault internal vault;
    GasMeteredStubVault internal vault2;
    GasMeteredStubVault internal vault3;
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

        vault2 = new GasMeteredStubVault(address(usdc));
        vault3 = new GasMeteredStubVault(address(usdc));
        vault2.setRedeemCost(STUB_COST);
        vault3.setRedeemCost(STUB_COST);
        usdc.mint(address(vault2), 1_000_000 * ONE);
        usdc.mint(address(vault3), 1_000_000 * ONE);
        vm.startPrank(admin);
        registry.registerVault(
            address(vault2),
            VaultRegistry.VaultMetadata({name: "Stub2", asset: address(usdc), registeredAt: 0})
        );
        registry.registerVault(
            address(vault3),
            VaultRegistry.VaultMetadata({name: "Stub3", asset: address(usdc), registeredAt: 0})
        );
        vm.stopPrank();

        address[] memory sources = new address[](3);
        sources[0] = address(vault);
        sources[1] = address(vault2);
        sources[2] = address(vault3);
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
                allowedSourceVaults: sources
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
        GasMeteredStubVault[3] memory all = [vault, vault2, vault3];
        for (uint256 i = 0; i < 3; i++) {
            all[i].mint(alice, 100 * ONE);
            vm.prank(alice);
            all[i].approve(address(router), type(uint256).max);
            if (i > 0) {
                all[i].mint(shareReceiver, 100 * ONE);
                vm.prank(shareReceiver);
                all[i].approve(address(gateway), type(uint256).max);
            }
        }
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

    uint256 internal constant ROUTER_PER_LEG = 1_700_000;
    uint256 internal constant GATEWAY_WITHDRAW = 2_000_000;
    uint256 internal constant GATEWAY_ROUTER_BASE = 400_000;
    uint256 internal constant GATEWAY_ROUTER_PER_LEG = 1_850_000;
    uint256 internal constant VAULT_FLOOR = 1_600_000;

    function test_router_redeemFor_belowFloor_revertsInsufficientGas() public {
        (bool ok, bytes memory ret) = _routerCall(900_000);
        assertFalse(ok);
        assertEq(_sel(ret), PortfolioRouter.InsufficientGas.selector, "expected InsufficientGas");
        (, uint256 required) = abi.decode(_slice(ret), (uint256, uint256));
        assertEq(required, ROUTER_PER_LEG, "router floor for one leg");
    }

    function test_router_redeemFor_floorScalesWithNonZeroLegs() public {
        for (uint256 k = 1; k <= 3; k++) {
            (bool ok, bytes memory ret) = _routerCallN(900_000, k, false);
            assertFalse(ok);
            (, uint256 required) = abi.decode(_slice(ret), (uint256, uint256));
            assertEq(required, k * ROUTER_PER_LEG, "router floor is per non-zero leg");
        }
        // A zero-share leg does not count.
        (, bytes memory ret0) = _routerCallN(900_000, 3, true);
        (, uint256 req0) = abi.decode(_slice(ret0), (uint256, uint256));
        assertEq(req0, 2 * ROUTER_PER_LEG, "zero-share leg counted");
    }

    function test_router_redeemFor_atFullGas_pays() public {
        (bool ok,) = _routerCall(30_000_000);
        assertTrue(ok);
        assertEq(usdc.balanceOf(makeAddr("alice")), 10 * ONE);
    }

    /// @notice Estimate-then-execute with the gas-metered stub: the bisect estimate lands at the
    ///         floor, executing at exactly that limit pays in full, and the vault is entered with at
    ///         least its own 1_600_000 entry floor. Every limit below the estimate reverts typed.
    function test_router_redeemFor_estimateThenExecute() public {
        uint256 est = _estimate(0);
        assertGe(est, ROUTER_PER_LEG, "estimate below the router floor");
        assertLe(est, ROUTER_PER_LEG + 50_000, "estimate far above the floor");
        uint256 snap = vm.snapshotState();
        (bool ok,) = _routerCall(est);
        assertTrue(ok, "router redeem failed at the exact estimate");
        assertEq(usdc.balanceOf(makeAddr("alice")), 10 * ONE, "short payout at the estimate");
        assertGe(vault.entryGas(), VAULT_FLOOR, "vault entered below its own floor");
        vm.revertToState(snap);
        for (uint256 g = 400_000; g < est; g += 7_919) {
            (bool ok2, bytes memory ret) = _routerCall(g);
            vm.revertToState(snap);
            snap = vm.snapshotState();
            assertFalse(ok2);
            assertEq(_sel(ret), PortfolioRouter.InsufficientGas.selector, "opaque below estimate");
        }
    }

    // --- estimate in an accrued block, include one block later (the 1482 mechanism) ----------

    /// @dev Stubs modelled on the fork: a 1.6M typed entry floor, about 1.0M of real work and
    ///      96k extra for the first redeem in a new timestamp. Each vault accrues now, so the
    ///      estimate runs in the cheap state.
    function _realisticAndAccrued() internal {
        address alice = makeAddr("alice");
        GasMeteredStubVault[3] memory all = [vault, vault2, vault3];
        for (uint256 i = 0; i < 3; i++) {
            all[i].setRealistic(VAULT_FLOOR, 1_000_000, 96_000);
            vm.prank(alice);
            all[i].redeem(1, alice, alice);
        }
    }

    function _estimateWith(uint256 which, uint256 k) internal returns (uint256) {
        uint256 snap = vm.snapshotState();
        uint256 lo = 21_000;
        uint256 hi = 12_000_000;
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            bool ok;
            if (which == 0) (ok,) = _routerCallN(mid, k, false);
            else if (which == 1) (ok,) = _gatewayWithdrawCall(mid, bytes32(uint256(1)));
            else (ok,) = _gatewayRouterCallN(mid, bytes32(uint256(1)), k);
            vm.revertToState(snap);
            snap = vm.snapshotState();
            if (ok) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    function _includeLater(uint256 which, uint256 k) internal {
        _realisticAndAccrued();
        uint256 est = _estimateWith(which, k);
        vm.warp(block.timestamp + 2);
        vm.roll(block.number + 1);
        bool ok;
        bytes memory ret;
        if (which == 0) (ok, ret) = _routerCallN(est, k, false);
        else if (which == 1) (ok, ret) = _gatewayWithdrawCall(est, bytes32(uint256(1)));
        else (ok, ret) = _gatewayRouterCallN(est, bytes32(uint256(1)), k);
        emit log_named_uint("estimate", est);
        assertTrue(ok, "failed at the estimate one block later");
    }

    function test_router_estimateThenIncludeNextBlock_1leg() public {
        _includeLater(0, 1);
    }

    function test_router_estimateThenIncludeNextBlock_2legs() public {
        _includeLater(0, 2);
    }

    function test_router_estimateThenIncludeNextBlock_3legs() public {
        _includeLater(0, 3);
    }

    function test_gateway_withdraw_estimateThenIncludeNextBlock() public {
        _includeLater(1, 1);
    }

    function test_gateway_withdrawFromRouter_estimateThenIncludeNextBlock_1leg() public {
        _includeLater(2, 1);
    }

    function test_gateway_withdrawFromRouter_estimateThenIncludeNextBlock_2legs() public {
        _includeLater(2, 2);
    }

    function test_gateway_withdrawFromRouter_estimateThenIncludeNextBlock_3legs() public {
        _includeLater(2, 3);
    }

    // --- gateway.withdraw --------------------------------------------------------------------

    function test_gateway_withdraw_belowFloor_revertsInsufficientGas() public {
        (bool ok, bytes memory ret) = _gatewayWithdrawCall(900_000, bytes32(uint256(7)));
        assertFalse(ok);
        assertEq(_sel(ret), RobotMoneyGateway.InsufficientGas.selector, "expected InsufficientGas");
        (, uint256 required) = abi.decode(_slice(ret), (uint256, uint256));
        assertEq(required, GATEWAY_WITHDRAW, "gateway withdraw floor");
    }

    function test_gateway_withdraw_estimateThenExecute() public {
        uint256 est = _estimate(1);
        // The floor is checked at entry, so the estimate is the floor plus the call prelude.
        assertGe(est, GATEWAY_WITHDRAW, "estimate below the gateway floor");
        assertLe(est, GATEWAY_WITHDRAW + 50_000, "estimate far above the floor");
        (bool ok,) = _gatewayWithdrawCall(est, bytes32(uint256(1)));
        assertTrue(ok, "gateway withdraw failed at the exact estimate");
        assertEq(usdc.balanceOf(assetRecipient), 10 * ONE, "short payout at the estimate");
        assertGe(vault.entryGas(), VAULT_FLOOR, "vault entered below its own floor");
    }

    // --- gateway.withdrawFromRouter ----------------------------------------------------------

    function test_gateway_withdrawFromRouter_belowFloor_revertsInsufficientGas() public {
        for (uint256 k = 1; k <= 3; k++) {
            (bool ok, bytes memory ret) = _gatewayRouterCallN(900_000, bytes32(uint256(9)), k);
            assertFalse(ok);
            assertEq(
                _sel(ret), RobotMoneyGateway.InsufficientGas.selector, "expected InsufficientGas"
            );
            (, uint256 required) = abi.decode(_slice(ret), (uint256, uint256));
            assertEq(
                required, GATEWAY_ROUTER_BASE + k * GATEWAY_ROUTER_PER_LEG, "gateway router floor"
            );
        }
    }

    function test_gateway_withdrawFromRouter_estimateThenExecute() public {
        uint256 floor = GATEWAY_ROUTER_BASE + GATEWAY_ROUTER_PER_LEG;
        uint256 est = _estimate(2);
        assertGe(est, floor, "estimate below the gateway floor");
        assertLe(est, floor + 50_000, "estimate far above the floor");
        (bool ok,) = _gatewayRouterCall(est, bytes32(uint256(1)));
        assertTrue(ok, "router withdraw failed at the exact estimate");
        assertEq(usdc.balanceOf(assetRecipient), 10 * ONE, "short payout at the estimate");
        assertGe(vault.entryGas(), VAULT_FLOOR, "vault entered below its own floor");
    }

    // --- multi-leg call builders -------------------------------------------------------------

    function _legs(uint256 k, bool zeroMiddle)
        internal
        view
        returns (address[] memory vs, uint256[] memory sh)
    {
        GasMeteredStubVault[3] memory all = [vault, vault2, vault3];
        vs = new address[](k);
        sh = new uint256[](k);
        for (uint256 i = 0; i < k; i++) {
            vs[i] = address(all[i]);
            sh[i] = (zeroMiddle && i == 1) ? 0 : 10 * ONE;
        }
    }

    function _routerCallN(uint256 gasLimit, uint256 k, bool zeroMiddle)
        internal
        returns (bool ok, bytes memory ret)
    {
        address alice = makeAddr("alice");
        (address[] memory vs, uint256[] memory sh) = _legs(k, zeroMiddle);
        vm.prank(alice);
        (ok, ret) = address(router).call{gas: gasLimit}(
            abi.encodeCall(
                router.redeemFor, (alice, alice, vs, sh, new uint256[](k), type(uint256).max)
            )
        );
    }

    function _gatewayRouterCallN(uint256 gasLimit, bytes32 salt, uint256 k)
        internal
        returns (bool ok, bytes memory ret)
    {
        (address[] memory vs, uint256[] memory sh) = _legs(k, false);
        vm.prank(agent);
        (ok, ret) = address(gateway).call{gas: gasLimit}(
            abi.encodeCall(
                gateway.withdrawFromRouter,
                (salt, vs, sh, new uint256[](k), uint64(block.timestamp + 60), salt)
            )
        );
    }

    function _slice(bytes memory ret) internal pure returns (bytes memory out) {
        out = new bytes(ret.length - 4);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = ret[i + 4];
        }
    }

    // --- deposit entry floors (core 1482) ----------------------------------------------------

    /// @dev Weight the router equally over the first `k` stub vaults.
    function _weigh(uint256 k) internal {
        GasMeteredStubVault[3] memory all = [vault, vault2, vault3];
        address[] memory vs = new address[](k);
        uint256[] memory bps = new uint256[](k);
        uint256 used;
        for (uint256 i = 0; i < k; i++) {
            vs[i] = address(all[i]);
            bps[i] = i == k - 1 ? 10_000 - used : 10_000 / k;
            used += bps[i];
            vm.prank(admin);
            registry.setRouterEligible(vs[i], true);
        }
        vm.prank(admin);
        router.setWeights(vs, bps);
    }

    function test_router_deposit_belowFloor_scalesWithWeightedLegs() public {
        for (uint256 k = 1; k <= 3; k++) {
            _weigh(k);
            address alice = makeAddr("alice");
            vm.prank(alice);
            (bool ok, bytes memory ret) = address(router).call{gas: 900_000}(
                abi.encodeCall(router.deposit, (10 * ONE, new uint256[](0)))
            );
            assertFalse(ok);
            assertEq(
                _sel(ret), PortfolioRouter.InsufficientGas.selector, "expected InsufficientGas"
            );
            (, uint256 required) = abi.decode(_slice(ret), (uint256, uint256));
            assertEq(required, k * ROUTER_PER_LEG, "router deposit floor per weighted leg");
        }
    }

    function test_gateway_deposit_belowFloor_revertsInsufficientGas() public {
        vm.prank(agent);
        (bool ok, bytes memory ret) = address(gateway).call{gas: 900_000}(
            abi.encodeCall(
                gateway.deposit,
                (bytes32(uint256(5)), 10 * ONE, uint64(block.timestamp + 60), bytes32(uint256(5)))
            )
        );
        assertFalse(ok);
        assertEq(_sel(ret), RobotMoneyGateway.InsufficientGas.selector, "expected InsufficientGas");
        (, uint256 required) = abi.decode(_slice(ret), (uint256, uint256));
        assertEq(required, GATEWAY_WITHDRAW, "gateway deposit floor");
    }

    function test_gateway_depositTo_router_belowFloor_scalesWithWeightedLegs() public {
        for (uint256 k = 1; k <= 3; k++) {
            _weigh(k);
            vm.prank(agent);
            (bool ok, bytes memory ret) = address(gateway).call{gas: 900_000}(
                abi.encodeCall(
                    gateway.depositTo,
                    (
                        bytes32(uint256(6)),
                        10 * ONE,
                        uint64(block.timestamp + 60),
                        bytes32(uint256(6)),
                        address(router),
                        new uint256[](0)
                    )
                )
            );
            assertFalse(ok);
            assertEq(
                _sel(ret), RobotMoneyGateway.InsufficientGas.selector, "expected InsufficientGas"
            );
            (, uint256 required) = abi.decode(_slice(ret), (uint256, uint256));
            assertEq(required, 400_000 + k * GATEWAY_ROUTER_PER_LEG, "gateway deposit router floor");
        }
    }
}
