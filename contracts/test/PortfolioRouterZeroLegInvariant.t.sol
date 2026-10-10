// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0002-router-default-weights-on-chain.md
// Implements: issue #1746 — PortfolioRouter must skip zero-amount legs
//
// Stateful invariant test for the zero-amount-leg skip. A handler rewrites the weight
// vector (zeros included) and routes fuzzed deposits. After every sequence:
//
//   - the router holds no USDC (no funds stranded, the leg amounts plus the remainder
//     equal the deposit);
//   - every deposited base unit is held by exactly one vault (no funds lost);
//   - a vault whose weight was 0 at deposit time was never called.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {MockUSDC} from "./PortfolioRouter.t.sol";
import {StrictZeroRevertVault} from "./PortfolioRouterZeroLeg.t.sol";

contract ZeroLegHandler is Test {
    MockUSDC public immutable usdc;
    PortfolioRouter public immutable router;
    address public immutable admin;
    StrictZeroRevertVault[4] public v;

    uint256 public totalDeposited;
    uint256 public deposits;
    bool public zeroLegWasCalled;
    bool public depositReverted;

    constructor(
        MockUSDC usdc_,
        PortfolioRouter router_,
        address admin_,
        StrictZeroRevertVault[4] memory v_
    ) {
        usdc = usdc_;
        router = router_;
        admin = admin_;
        v = v_;
    }

    function setWeights(uint16 w0, uint16 w1, uint16 w2) external {
        uint256 a = bound(uint256(w0), 0, 10_000);
        uint256 b = bound(uint256(w1), 0, 10_000 - a);
        uint256 c = bound(uint256(w2), 0, 10_000 - a - b);
        uint256[4] memory w = [a, b, c, 10_000 - a - b - c];
        address[] memory vaults = new address[](4);
        uint256[] memory bps = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) {
            vaults[i] = address(v[i]);
            bps[i] = w[i];
        }
        vm.prank(admin);
        router.setWeights(vaults, bps);
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 1, 1e13);
        (, uint256[] memory bps) = router.getEffectiveWeights();
        uint256[4] memory callsBefore;
        for (uint256 i = 0; i < 4; i++) {
            callsBefore[i] = v[i].depositCalls();
        }

        address user = address(0xBEEF);
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(router), amount);
        try router.deposit(amount, new uint256[](0)) {}
        catch {
            vm.stopPrank();
            depositReverted = true;
            return;
        }
        vm.stopPrank();

        totalDeposited += amount;
        deposits++;
        for (uint256 i = 0; i < 4; i++) {
            if (bps[i] == 0 && v[i].depositCalls() != callsBefore[i]) zeroLegWasCalled = true;
        }
    }
}

contract PortfolioRouterZeroLegInvariantTest is StdInvariant, Test {
    MockUSDC internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    ZeroLegHandler internal handler;
    StrictZeroRevertVault[4] internal v;
    address internal admin = makeAddr("admin");

    function setUp() public {
        usdc = new MockUSDC();
        registry = new VaultRegistry(admin);
        router = new PortfolioRouter(address(usdc), address(registry), admin);
        for (uint256 i = 0; i < 4; i++) {
            v[i] = new StrictZeroRevertVault(address(usdc));
            vm.startPrank(admin);
            registry.registerVault(
                address(v[i]),
                VaultRegistry.VaultMetadata({name: "V", asset: address(usdc), registeredAt: 0})
            );
            registry.setRouterEligible(address(v[i]), true);
            vm.stopPrank();
        }
        handler = new ZeroLegHandler(usdc, router, admin, v);
        // The launch vector first, so deposits are live before the handler rewrites it.
        handler.setWeights(9500, 500, 0);

        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = ZeroLegHandler.setWeights.selector;
        selectors[1] = ZeroLegHandler.deposit.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice The router never keeps USDC: leg amounts plus the rounding remainder equal the deposit.
    function invariant_routerHoldsNoUsdc() public view {
        assertEq(usdc.balanceOf(address(router)), 0, "router stranded USDC");
    }

    /// @notice Every deposited base unit is held by exactly one vault.
    function invariant_depositsEqualVaultHoldings() public view {
        uint256 held;
        for (uint256 i = 0; i < 4; i++) {
            held += usdc.balanceOf(address(v[i]));
        }
        assertEq(held, handler.totalDeposited(), "funds lost or created");
    }

    /// @notice A deposit over a valid vector (any zeros) never reverts.
    function invariant_depositNeverReverts() public view {
        assertFalse(handler.depositReverted(), "a valid router deposit reverted");
    }

    /// @notice A leg whose weight is 0 is never called.
    function invariant_zeroWeightLegNeverCalled() public view {
        assertFalse(handler.zeroLegWasCalled(), "a 0 bps leg received a vault call");
    }
}
