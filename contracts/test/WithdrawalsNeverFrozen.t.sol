// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md §6 — withdrawals are never blocked
// Canonical: docs/technical/security-model.md §4 — EMERGENCY pauses, ADMIN (timelock) unpauses
// Implements: core 1494 — owner decision 2026-10-05: "We do not ever freeze withdrawals."
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {DeployTimelock} from "../script/DeployTimelock.s.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ProtocolAssetVault} from "../vaults/ProtocolAssetVault.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {RwaBasketVault} from "../vaults/RwaBasketVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {SafeFixture} from "./helpers/SafeFixture.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {NoYieldTestAdapter} from "./helpers/NoYieldTestAdapter.sol";
import {ISafe} from "./SafeIntegration.t.sol";
import {MockPool, MockSwapRouter} from "./BasketVault.t.sol";

/// @title WithdrawalsNeverFrozenTest
/// @notice Withdrawals are never frozen, by anyone. Each shipped vault (rmUSDC, rmPROTO,
///         rmAGENT, rmRWA), the gateway and the router are built on the governance topology
///         we ship: the production `DeployTimelock` handover moves ADMIN_ROLE to the timelock
///         and EMERGENCY_ROLE to the emergency key. Every emergency lever, the gateway pauser
///         and the governance status levers are pulled, then holders with shares and
///         sufficient liquidity redeem the exact assets. Governance actions run through a
///         real 2-of-3 Safe 1.4.1 (`execTransaction` with two owner signatures) on the
///         timelock at the 172800 s production delay. No stub Safe and no pranked Safe.
contract WithdrawalsNeverFrozenTest is SafeFixture {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant AMOUNT = 1_000 * ONE_USDC;
    /// @dev Swap proceeds for selling `AMOUNT` basket tokens: above the 1% TWAP floor.
    uint256 internal constant SWAP_OUT = 995 * ONE_USDC;
    /// @dev The Base mainnet floor DeployTimelock enforces (security-model.md §4).
    uint256 internal constant MIN_DELAY = 172_800;

    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    TestERC20 internal usdc;
    TestERC20 internal basketToken;
    MockSwapRouter internal swapRouter;
    MockPool internal pool;
    RobotMoneyVault internal vault;
    ProtocolAssetVault internal rmProto;
    AgentTokenVault internal rmAgent;
    RwaBasketVault internal rmRwa;
    RobotMoneyGateway internal gateway;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    DeployTimelock.Deployed internal d;
    ISafe internal safe;
    uint256 internal saltNonce;

    address internal emergency = makeAddr("emergency");
    address internal pauser = makeAddr("pauser");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        usdc = new TestERC20();
        basketToken = new TestERC20();
        swapRouter = new MockSwapRouter();
        pool = new MockPool(address(basketToken), address(usdc), uint160(1 << 96));
        DeployTimelock script = new DeployTimelock();
        address deployer = address(script);
        _installSafeSet();
        safe = ISafe(_newDefaultSafe());

        // rmUSDC with one no-yield adapter, built while the deployer holds every role.
        vault = new RobotMoneyVault(
            usdc,
            type(uint256).max,
            type(uint256).max,
            0,
            makeAddr("feeRecipient"),
            deployer,
            deployer
        );
        NoYieldTestAdapter adapter = new NoYieldTestAdapter(address(usdc), address(vault));
        vm.startPrank(deployer);
        vault.setAdapterAllowed(address(adapter), true);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vault.addAdapter(address(adapter), 10_000);
        vm.stopPrank();

        // The three shipped basket vaults, each with one V3 asset priced 1:1 by its pool TWAP.
        ISwapRouter sr = ISwapRouter(address(swapRouter));
        address fees = makeAddr("basketFees");
        rmProto =
            new ProtocolAssetVault(usdc, sr, 1_000_000e6, 100_000e6, 0, fees, deployer, deployer);
        rmAgent = new AgentTokenVault(usdc, sr, 1_000_000e6, 100_000e6, 0, fees, deployer, deployer);
        rmRwa = new RwaBasketVault(usdc, sr, 1_000_000e6, 100_000e6, 0, fees, deployer, deployer);
        BasketVault[3] memory baskets = [BasketVault(rmProto), rmAgent, rmRwa];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(deployer);
            baskets[i].addAsset(
                address(basketToken), address(pool), 500, address(0), BasketVault.Venue.V3
            );
        }

        gateway = new RobotMoneyGateway(usdc, vault, deployer, pauser, address(0));
        registry = new VaultRegistry(deployer);
        router = new PortfolioRouter(address(usdc), address(registry), deployer);
        RouterGovernance governance =
            new RouterGovernance(address(router), deployer, 7 days, 1 days, 2);
        vm.prank(deployer);
        router.grantRole(ADMIN_ROLE, address(governance));

        address[] memory vaults = new address[](4);
        vaults[0] = address(vault);
        vaults[1] = address(rmProto);
        vaults[2] = address(rmAgent);
        vaults[3] = address(rmRwa);
        vm.prank(deployer);
        d = script.runInProcessVaults(
            vaults,
            address(gateway),
            address(registry),
            address(router),
            address(governance),
            address(safe),
            emergency,
            MIN_DELAY,
            _fixtureSpec()
        );

        // Register every vault through the Safe and the timelock, as stage does.
        bytes[] memory calls = new bytes[](4);
        for (uint256 i = 0; i < 4; i++) {
            calls[i] = abi.encodeCall(
                VaultRegistry.registerVault,
                (
                    vaults[i],
                    VaultRegistry.VaultMetadata({
                        name: "vault", asset: address(usdc), registeredAt: block.timestamp
                    })
                )
            );
        }
        _govern(address(registry), calls);
    }

    // ─── rmUSDC ───────────────────────────────────────────────────────────────

    /// @notice Every lever with funds still in the adapter: emergency pause and shutdown,
    ///         gateway pause, governance Paused then Retired. Redeem and withdraw still pay.
    function test_rmUSDC_noLeverFreezesExit_fundsInAdapter() public {
        uint256 aliceShares = _depositRmUsdc(alice, AMOUNT);
        _depositRmUsdc(bob, AMOUNT);

        vm.startPrank(emergency);
        vault.pause();
        vault.shutdownVault();
        vm.stopPrank();
        vm.prank(pauser);
        gateway.pause();
        _setStatus(address(vault), VaultRegistry.VaultStatus.Paused);
        _setStatus(address(vault), VaultRegistry.VaultStatus.Retired);
        assertEq(vault.maxDeposit(alice), 0, "deposits halted");

        assertEq(vault.maxRedeem(alice), aliceShares, "maxRedeem is the full balance");
        vm.prank(alice);
        assertEq(vault.redeem(aliceShares, alice, alice), AMOUNT, "alice redeems in full");
        assertEq(usdc.balanceOf(alice), AMOUNT, "alice holds the USDC");
        uint256 bobMax = vault.maxWithdraw(bob);
        assertEq(bobMax, AMOUNT, "maxWithdraw is the full position");
        vm.prank(bob);
        vault.withdraw(bobMax, bob, bob);
        assertEq(usdc.balanceOf(bob), AMOUNT, "bob withdraws in full");
    }

    /// @notice Every emergency drain lever: `emergencyWithdrawAdapter`, `emergencyWithdraw`,
    ///         `forceRemoveAdapter`, pause and shutdown. Funds move back to the vault and the
    ///         holders still exit in full.
    function test_rmUSDC_noLeverFreezesExit_afterEmergencyDrain() public {
        uint256 aliceShares = _depositRmUsdc(alice, AMOUNT);
        uint256 bobShares = _depositRmUsdc(bob, AMOUNT);

        vm.startPrank(emergency);
        vault.emergencyWithdrawAdapter(0);
        vault.emergencyWithdraw();
        vault.forceRemoveAdapter(0);
        vault.pause();
        vault.shutdownVault();
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(vault)), 2 * AMOUNT, "funds back in the vault");

        vm.prank(alice);
        assertEq(vault.redeem(aliceShares, alice, alice), AMOUNT, "alice redeems after a drain");
        vm.prank(bob);
        assertEq(vault.redeem(bobShares, bob, bob), AMOUNT, "bob redeems after a drain");
    }

    /// @notice Pause, redeem while paused, then unpause through the Safe.
    function test_rmUSDC_pauseThenRedeem_thenSafeUnpause() public {
        uint256 aliceShares = _depositRmUsdc(alice, AMOUNT);

        vm.prank(emergency);
        vault.pause();
        assertTrue(vault.paused(), "paused");

        usdc.mint(bob, AMOUNT);
        vm.startPrank(bob);
        usdc.approve(address(vault), AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, bob, AMOUNT, 0)
        );
        vault.deposit(AMOUNT, bob);
        vm.stopPrank();

        vm.prank(alice);
        assertEq(vault.redeem(aliceShares, alice, alice), AMOUNT, "redeem while paused");

        vm.prank(emergency);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, emergency, ADMIN_ROLE
            )
        );
        vault.unpause();

        _governOne(address(vault), abi.encodeCall(RobotMoneyVault.unpause, ()));
        assertFalse(vault.paused(), "unpaused by the timelock");
        vm.startPrank(bob);
        assertGt(vault.deposit(AMOUNT, bob), 0, "deposits restored after the Safe unpause");
        vm.stopPrank();
    }

    // ─── Basket vaults ────────────────────────────────────────────────────────

    function test_rmPROTO_noLeverFreezesExit() public {
        _basketNoLeverFreezesExit(rmProto);
    }

    function test_rmAGENT_noLeverFreezesExit() public {
        _basketNoLeverFreezesExit(rmAgent);
    }

    function test_rmRWA_noLeverFreezesExit() public {
        _basketNoLeverFreezesExit(rmRwa);
    }

    /// @notice Pause, redeem while paused, then unpause through the Safe (rmPROTO).
    function test_basket_pauseThenRedeem_thenSafeUnpause() public {
        uint256 shares = _depositBasket(rmProto, alice, AMOUNT);

        vm.prank(emergency);
        rmProto.pause();
        assertEq(rmProto.maxDeposit(bob), 0, "maxDeposit 0 while paused");

        _fundSwapOut(SWAP_OUT);
        vm.prank(alice);
        assertEq(rmProto.redeem(shares, alice, alice), SWAP_OUT, "redeem while paused");

        vm.prank(emergency);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, emergency, ADMIN_ROLE
            )
        );
        rmProto.unpause();

        _governOne(address(rmProto), abi.encodeCall(BasketVault.unpause, ()));
        assertFalse(rmProto.paused(), "unpaused by the timelock");
        assertGt(rmProto.maxDeposit(bob), 0, "deposits restored after the Safe unpause");
    }

    /// @notice `emergencyUnwind` sets only `depositsPaused`. The Safe unpause must clear it
    ///         instead of reverting `ExpectedPause`.
    function test_basket_emergencyUnwind_thenSafeUnpause_reopensDeposits() public {
        _depositBasket(rmProto, alice, AMOUNT);
        _fundSwapOut(SWAP_OUT);

        vm.prank(emergency);
        rmProto.emergencyUnwind();
        assertTrue(rmProto.depositsPaused(), "deposits halted by the unwind");

        _governOne(address(rmProto), abi.encodeCall(BasketVault.unpause, ()));
        assertFalse(rmProto.depositsPaused(), "deposits reopened by the timelock");
        assertGt(rmProto.maxDeposit(bob), 0, "maxDeposit restored");
    }

    // ─── Router and gateway ───────────────────────────────────────────────────

    /// @notice The router redeems from a vault that governance marked Paused, then Retired.
    function test_router_redeemsWhileVaultPausedAndRetired() public {
        uint256 shares = _depositRmUsdc(alice, AMOUNT);
        vm.prank(alice);
        vault.approve(address(router), shares);
        address[] memory legs = new address[](1);
        legs[0] = address(vault);
        uint256[] memory half = new uint256[](1);
        half[0] = shares / 2;

        vm.prank(emergency);
        vault.pause();
        _setStatus(address(vault), VaultRegistry.VaultStatus.Paused);
        vm.prank(alice);
        uint256[] memory out =
            router.redeemFor(alice, alice, legs, half, new uint256[](1), type(uint256).max);
        assertEq(out[0], AMOUNT / 2, "router redeems from a Paused vault");

        _setStatus(address(vault), VaultRegistry.VaultStatus.Retired);
        half[0] = vault.balanceOf(alice);
        vm.prank(alice);
        out = router.redeemFor(alice, alice, legs, half, new uint256[](1), type(uint256).max);
        assertEq(out[0], AMOUNT / 2, "router redeems from a Retired vault");
        assertEq(usdc.balanceOf(alice), AMOUNT, "alice exits in full through the router");
    }

    /// @notice A gateway agent withdraws while the pauser has paused the gateway and the
    ///         emergency key has paused the vault.
    function test_gateway_withdrawsWhileGatewayAndVaultPaused() public {
        address agent = makeAddr("agent");
        address recipient = makeAddr("recipient");
        _selfAuthorize(agent, recipient);

        usdc.mint(agent, AMOUNT);
        vm.startPrank(agent);
        usdc.approve(address(gateway), AMOUNT);
        (, uint256 shares) =
            gateway.deposit(bytes32("o-dep"), AMOUNT, uint64(block.timestamp + 60), bytes32("i"));
        vm.stopPrank();

        vm.prank(pauser);
        gateway.pause();
        vm.prank(emergency);
        vault.pause();

        vm.startPrank(agent);
        vault.approve(address(gateway), shares);
        (, uint256 assetsOut) = gateway.withdraw(
            bytes32("o-wd"), shares, address(vault), uint64(block.timestamp + 60), bytes32("i")
        );
        vm.stopPrank();
        assertEq(assetsOut, AMOUNT, "gateway withdraw pays in full while paused");
        assertEq(usdc.balanceOf(recipient), AMOUNT, "USDC to the policy recipient");
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// @dev Pull every basket lever, then redeem on both the swap path and the idle path.
    function _basketNoLeverFreezesExit(BasketVault v) internal {
        uint256 aliceShares = _depositBasket(v, alice, AMOUNT);
        uint256 bobShares = _depositBasket(v, bob, AMOUNT);

        vm.startPrank(emergency);
        v.pause();
        v.shutdownVault();
        vm.stopPrank();
        vm.prank(pauser);
        gateway.pause();
        _setStatus(address(v), VaultRegistry.VaultStatus.Paused);
        _setStatus(address(v), VaultRegistry.VaultStatus.Retired);
        assertEq(v.maxDeposit(alice), 0, "deposits halted");

        // Swap path: alice sells her half of the basket.
        assertEq(v.maxRedeem(alice), aliceShares, "maxRedeem is the full balance");
        _fundSwapOut(SWAP_OUT);
        vm.prank(alice);
        assertEq(v.redeem(aliceShares, alice, alice), SWAP_OUT, "alice redeems the swap proceeds");

        // Idle path: the emergency unwind sells the rest to USDC, then bob redeems it.
        _fundSwapOut(SWAP_OUT);
        vm.prank(emergency);
        v.emergencyUnwind();
        vm.prank(bob);
        assertEq(v.redeem(bobShares, bob, bob), SWAP_OUT, "bob redeems after the unwind");
        assertEq(usdc.balanceOf(bob), SWAP_OUT, "bob holds the USDC");
    }

    function _depositRmUsdc(address who, uint256 amount) internal returns (uint256 shares) {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(vault), amount);
        shares = vault.deposit(amount, who);
        vm.stopPrank();
    }

    function _depositBasket(BasketVault v, address who, uint256 amount)
        internal
        returns (uint256 shares)
    {
        usdc.mint(who, amount);
        basketToken.mint(address(swapRouter), amount);
        swapRouter.setAmountOut(amount);
        vm.startPrank(who);
        usdc.approve(address(v), amount);
        shares = v.deposit(amount, who);
        vm.stopPrank();
    }

    function _fundSwapOut(uint256 amountOut) internal {
        usdc.mint(address(swapRouter), amountOut);
        swapRouter.setAmountOut(amountOut);
    }

    /// @dev The permissionless commit/reveal route; a non-admin agent names itself as share
    ///      receiver.
    function _selfAuthorize(address agent, address recipient) internal {
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 30 days),
            maxPerPayment: AMOUNT,
            maxPerWindow: 10 * AMOUNT,
            shareReceiver: agent,
            allowedDestinations: new address[](0),
            assetRecipient: recipient,
            maxWithdrawPerPayment: type(uint128).max,
            maxWithdrawPerWindow: type(uint128).max,
            allowedSourceVaults: new address[](0)
        });
        bytes32 salt = keccak256("agent-salt");
        vm.prank(agent);
        gateway.commitAuthorization(keccak256(abi.encode(agent, agent, salt)));
        vm.roll(block.number + 1);
        vm.prank(agent);
        gateway.revealAuthorization(agent, salt, p);
    }

    function _setStatus(address v, VaultRegistry.VaultStatus status) internal {
        _governOne(address(registry), abi.encodeCall(VaultRegistry.setVaultStatus, (v, status)));
    }

    function _governOne(address target, bytes memory data) internal {
        bytes[] memory calls = new bytes[](1);
        calls[0] = data;
        _govern(target, calls);
    }

    /// @dev The real governance route: the Safe schedules a batch on the timelock,
    ///      execution before the delay fails, and the Safe executes after 172800 s.
    function _govern(address target, bytes[] memory calls) internal {
        uint256 n = calls.length;
        address[] memory targets = new address[](n);
        uint256[] memory values = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            targets[i] = target;
        }
        bytes32 salt = keccak256(abi.encode(++saltNonce));
        TimelockController timelock = d.timelock;
        _safeExec(
            address(timelock),
            abi.encodeCall(
                TimelockController.scheduleBatch,
                (targets, values, calls, bytes32(0), salt, MIN_DELAY)
            ),
            true
        );
        bytes memory exec = abi.encodeCall(
            TimelockController.executeBatch, (targets, values, calls, bytes32(0), salt)
        );
        _safeExec(address(timelock), exec, false);
        vm.warp(block.timestamp + MIN_DELAY);
        _safeExec(address(timelock), exec, true);
    }

    /// @dev `execTransaction` signed by two of the three fixture owners, sorted by address.
    ///      `expectOk == false` asserts the Safe refuses (GS013: the inner call reverted).
    function _safeExec(address to, bytes memory data, bool expectOk) internal {
        bytes32 txHash = safe.getTransactionHash(
            to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), safe.nonce()
        );
        (address a1, uint256 k1) = makeAddrAndKey("safe-owner-1");
        (address a2, uint256 k2) = makeAddrAndKey("safe-owner-2");
        (uint256 lo, uint256 hi) = a1 < a2 ? (k1, k2) : (k2, k1);
        bytes memory sigs = bytes.concat(_sign(lo, txHash), _sign(hi, txHash));
        if (!expectOk) vm.expectRevert(bytes("GS013"));
        safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
    }

    function _sign(uint256 pk, bytes32 txHash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, txHash);
        return abi.encodePacked(r, s, v);
    }
}
