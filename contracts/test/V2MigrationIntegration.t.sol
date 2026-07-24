// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0010-unified-vault-architecture.md,
//            docs/adr/ADR-0009-vault-retirement-no-assisted-migration.md,
//            docs/adr/ADR-0002-router-default-weights-on-chain.md,
//            docs/technical/unified-vault-open-questions-resolution.md
//            ("The migration interlock fix (H-A1) — one atomic entry point").
//
// Integration coverage for issue #1130: bringing a v2 vault set online on the
// DEV environment (NOT a mainnet deploy). Exercises the full migration ordering
// against the shipped VaultRegistry + PortfolioRouter contracts:
//
//     register  ->  eligible (+ weights, atomic)  ->  weights  ->  retire
//
//   1. register the v2 vault(s) in VaultRegistry;
//   2. make each v2 vault router-eligible via the atomic eligibility+weights
//      interlock call (VaultRegistry.migrateEligibility, H-A1) so the
//      routerEligibleCount == defaultWeights.length invariant is never observed
//      inconsistent;
//   3. migrate the router weight vector to span the v2 set and assert the router
//      actually allocates a deposit across v2 with consistent eligibility/weights;
//   4. govern retire() on each v1 vault (ADR-0009): v1 withdrawals stay open
//      indefinitely (ERC-4626 redeem never revoked, router honors redemptions
//      from a Retired vault) with NO assisted-migration path — retire() moves no
//      depositor funds.
//
// DEV-ONLY: this runs on a fresh local EVM (the dev environment), driving the
// same production contracts that ship to every environment — environments differ
// only by configuration and seeded state
// (docs/development/single-production-codebase.md). No mainnet deploy, no live
// RPC fork, and no external resource is required, so the suite runs identically
// in CI and locally.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";

// ─── Test fixtures ──────────────────────────────────────────────────────────

/// @notice Minimal ERC-20 USDC mock (6 decimals) with an open mint for funding.
contract MigUsdc is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice ERC-4626-shaped vault mock supporting the full deposit/redeem cycle
///         the router drives, plus the `IRetirableVault` deposit-halt hooks the
///         registry calls on `retire()`/`unretire()`. 1:1 shares. This is the
///         smallest mock that lets the integration test prove real allocation
///         (deposit) and real redemption (redeem) — not just view consistency.
contract MigVault is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable assetToken;

    /// @dev Registry-driven deposit-halt flag (IRetirableVault). Deposits revert
    ///      once retired; redemptions are never gated (ADR-0009 withdraw-only).
    bool public retired;

    constructor(address asset_, string memory sym) ERC20("Mig Vault Shares", sym) {
        assetToken = IERC20(asset_);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function totalAssets() external view returns (uint256) {
        return assetToken.balanceOf(address(this));
    }

    function previewDeposit(uint256 assets) external pure returns (uint256) {
        return assets; // 1:1
    }

    /// @dev IRetirableVault deposit-halt hooks. Registry-gated in production; the
    ///      integration test calls them only through the registry's retire path.
    function retire() external {
        retired = true;
    }

    function unretire() external {
        retired = false;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        // Hard-stop direct deposits once retired (mirrors the production vault's
        // deposit-halt). Redemption below is deliberately never gated.
        require(!retired, "MigVault: retired");
        assetToken.safeTransferFrom(msg.sender, address(this), assets);
        shares = assets;
        _mint(receiver, shares);
    }

    function redeem(uint256 shares, address receiver, address owner)
        external
        returns (uint256 assets)
    {
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _burn(owner, shares);
        assets = shares;
        assetToken.safeTransfer(receiver, assets);
    }
}

// ─── V2MigrationIntegrationTest ──────────────────────────────────────────────

contract V2MigrationIntegrationTest is Test {
    MigUsdc internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;

    // v1 set (legacy, online at dev-deploy time).
    MigVault internal v1a;
    MigVault internal v1b;
    // v2 set (successor, brought online by the migration).
    MigVault internal v2a;
    MigVault internal v2b;

    // A single admin holds ADMIN_ROLE on both registry and router — the
    // production TimelockController equivalent (INV-3).
    address internal admin = makeAddr("admin");
    address internal legacyDepositor = makeAddr("legacyDepositor");
    address internal newDepositor = makeAddr("newDepositor");

    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant DEPOSIT = 100 * ONE_USDC;

    /// @dev Stand up the DEV deployment with the v1 set online: registry + router
    ///      linked, v1a/v1b registered + router-eligible, and a full-length
    ///      (length-2) default weight vector spanning the v1 set. This is the
    ///      steady state the migration starts from.
    function setUp() public {
        usdc = new MigUsdc();
        registry = new VaultRegistry(admin);
        router = new PortfolioRouter(address(usdc), address(registry), admin);

        v1a = new MigVault(address(usdc), "V1A");
        v1b = new MigVault(address(usdc), "V1B");
        v2a = new MigVault(address(usdc), "V2A");
        v2b = new MigVault(address(usdc), "V2B");

        vm.startPrank(admin);
        registry.registerVault(address(v1a), _meta("Robot Money v1 A"));
        registry.registerVault(address(v1b), _meta("Robot Money v1 B"));
        registry.setRouterEligible(address(v1a), true);
        registry.setRouterEligible(address(v1b), true);

        // Full-length default vector spanning the eligible v1 set (ADR-0002).
        router.setDefaultWeights(_vaults2(address(v1a), address(v1b)), _bps2(5000, 5000));

        // Link the router so the atomic interlock is armed — this is the state
        // that would deadlock every non-atomic eligibility flip (H-A1).
        registry.setRouter(address(router));
        vm.stopPrank();

        assertEq(registry.routerEligibleCount(), 2, "setup: 2 eligible");
        assertEq(router.defaultWeightsLength(), 2, "setup: length-2 default");
    }

    // ─── AC1: register -> eligible -> weights -> allocate across v2 ──────────

    /// @notice The full migration ordering on dev: register the v2 set, make it
    ///         router-eligible via the atomic interlock while migrating the
    ///         default weight vector to span v2, then prove the router actually
    ///         allocates a deposit across the v2 set with consistent
    ///         eligibility/weights. Also drives retire() last so the ordering
    ///         register -> eligible -> weights -> retire is executed end to end.
    function test_migration_registerEligibleWeightsRetire_ordering() public {
        // ── Baseline: a legacy holder is deposited into the v1 set (default
        //    vector), giving us a position that must survive retirement. ──
        _fundApprove(legacyDepositor, DEPOSIT);
        vm.prank(legacyDepositor);
        router.deposit(DEPOSIT, new uint256[](0));
        assertEq(v1a.balanceOf(legacyDepositor), 50 * ONE_USDC, "legacy in v1a");
        assertEq(v1b.balanceOf(legacyDepositor), 50 * ONE_USDC, "legacy in v1b");

        // ── 1. REGISTER the v2 set (Active, not yet router-eligible). ──
        vm.startPrank(admin);
        registry.registerVault(address(v2a), _meta("Robot Money v2 A"));
        registry.registerVault(address(v2b), _meta("Robot Money v2 B"));
        vm.stopPrank();
        assertFalse(registry.isRouterEligible(address(v2a)), "v2a not yet eligible");
        assertFalse(registry.isRouterEligible(address(v2b)), "v2b not yet eligible");
        assertEq(registry.routerEligibleCount(), 2, "count unchanged by register");

        // ── 2/3. ELIGIBLE + WEIGHTS via the atomic interlock. Each call flips
        //    one vault's eligibility AND re-sets the full default vector, so the
        //    count == length invariant is never observed inconsistent. Walk the
        //    default vector from {v1a,v1b} all the way to {v2a,v2b}. ──
        vm.startPrank(admin);

        // + v2a  -> eligible {v1a,v1b,v2a}
        registry.migrateEligibility(
            address(v2a),
            true,
            _vaults3(address(v1a), address(v1b), address(v2a)),
            _bps3(4000, 3000, 3000)
        );
        _assertInvariant(3);

        // + v2b  -> eligible {v1a,v1b,v2a,v2b}
        registry.migrateEligibility(
            address(v2b),
            true,
            _vaults4(address(v1a), address(v1b), address(v2a), address(v2b)),
            _bps4(2500, 2500, 2500, 2500)
        );
        _assertInvariant(4);

        // - v1a  -> eligible {v1b,v2a,v2b}
        registry.migrateEligibility(
            address(v1a),
            false,
            _vaults3(address(v1b), address(v2a), address(v2b)),
            _bps3(4000, 3000, 3000)
        );
        _assertInvariant(3);

        // - v1b  -> eligible {v2a,v2b}: default now spans the v2 set only.
        registry.migrateEligibility(
            address(v1b), false, _vaults2(address(v2a), address(v2b)), _bps2(5000, 5000)
        );
        _assertInvariant(2);
        vm.stopPrank();

        // Eligibility is consistent: exactly the v2 set is eligible.
        assertTrue(registry.isRouterEligible(address(v2a)), "v2a eligible");
        assertTrue(registry.isRouterEligible(address(v2b)), "v2b eligible");
        assertFalse(registry.isRouterEligible(address(v1a)), "v1a no longer eligible");
        assertFalse(registry.isRouterEligible(address(v1b)), "v1b no longer eligible");

        // The migrated weight vector spans exactly the v2 set.
        (address[] memory effVaults, uint256[] memory effBps) = router.getEffectiveWeights();
        assertEq(effVaults.length, 2, "effective vector spans v2 set");
        assertEq(effVaults[0], address(v2a), "leg 0 = v2a");
        assertEq(effVaults[1], address(v2b), "leg 1 = v2b");
        assertEq(effBps[0], 5000, "v2a weight");
        assertEq(effBps[1], 5000, "v2b weight");

        // ── ASSERT: the router allocates a NEW deposit across the v2 set. ──
        _fundApprove(newDepositor, DEPOSIT);
        vm.prank(newDepositor);
        router.deposit(DEPOSIT, new uint256[](0));
        assertEq(v2a.balanceOf(newDepositor), 50 * ONE_USDC, "new deposit -> v2a");
        assertEq(v2b.balanceOf(newDepositor), 50 * ONE_USDC, "new deposit -> v2b");
        assertEq(v1a.balanceOf(newDepositor), 0, "no new deposit into v1a");
        assertEq(v1b.balanceOf(newDepositor), 0, "no new deposit into v1b");

        // ── 4. RETIRE the v1 set last (ADR-0009 governance retire). ──
        vm.startPrank(admin);
        registry.retire(address(v1a));
        registry.retire(address(v1b));
        vm.stopPrank();
        (, VaultRegistry.VaultStatus s1a) = registry.getVault(address(v1a));
        (, VaultRegistry.VaultStatus s1b) = registry.getVault(address(v1b));
        assertEq(uint256(s1a), uint256(VaultRegistry.VaultStatus.Retired), "v1a Retired");
        assertEq(uint256(s1b), uint256(VaultRegistry.VaultStatus.Retired), "v1b Retired");

        // Retire moved NO depositor funds (no assisted migration): the legacy
        // holder still holds exactly the v1 shares minted at deposit time.
        assertEq(v1a.balanceOf(legacyDepositor), 50 * ONE_USDC, "legacy v1a untouched");
        assertEq(v1b.balanceOf(legacyDepositor), 50 * ONE_USDC, "legacy v1b untouched");

        // The router refuses to weight (and therefore route new deposits into) a
        // retired vault — retirement is one-way, withdraw-only.
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioRouter.VaultNotActive.selector,
                address(v1a),
                VaultRegistry.VaultStatus.Retired
            )
        );
        router.setWeights(_vaults2(address(v1a), address(v2a)), _bps2(5000, 5000));
    }

    // ─── AC2: retired v1 keeps withdrawals open, no assisted migration ──────

    /// @notice A retired v1 vault still honors redemptions indefinitely
    ///         (ADR-0009): the holder redeems both directly on the vault and
    ///         through the router, and no admin/contract path ever moved the
    ///         holder's funds. Runs the register/eligible/weights migration first
    ///         so retirement happens against a fully-migrated dev deployment.
    function test_retiredV1_honorsRedemptions_noAssistedMigration() public {
        // Legacy holder deposits into the v1 set.
        _fundApprove(legacyDepositor, DEPOSIT);
        vm.prank(legacyDepositor);
        router.deposit(DEPOSIT, new uint256[](0));
        uint256 sharesA = v1a.balanceOf(legacyDepositor);
        uint256 sharesB = v1b.balanceOf(legacyDepositor);
        assertEq(sharesA, 50 * ONE_USDC, "legacy v1a shares");
        assertEq(sharesB, 50 * ONE_USDC, "legacy v1b shares");

        // Migrate eligibility + weights fully over to the v2 set, then retire v1.
        _migrateToV2();
        vm.startPrank(admin);
        registry.retire(address(v1a));
        registry.retire(address(v1b));
        vm.stopPrank();

        // No assisted migration: retire() left the holder's positions exactly as
        // they were — the protocol never moved funds to a successor vault.
        assertEq(v1a.balanceOf(legacyDepositor), sharesA, "v1a position unchanged by retire");
        assertEq(v1b.balanceOf(legacyDepositor), sharesB, "v1b position unchanged by retire");

        // Withdrawals stay open — path 1: direct ERC-4626 redeem on the retired
        // vault. redeem is never revoked (ADR-0009).
        vm.prank(legacyDepositor);
        uint256 outA = v1a.redeem(sharesA, legacyDepositor, legacyDepositor);
        assertEq(outA, sharesA, "direct redeem returns full assets");
        assertEq(v1a.balanceOf(legacyDepositor), 0, "v1a shares burned on redeem");
        assertEq(usdc.balanceOf(legacyDepositor), 50 * ONE_USDC, "USDC out from v1a redeem");

        // Withdrawals stay open — path 2: redeem through the PortfolioRouter,
        // which permits Active OR Retired for redemption (only Paused blocks the
        // exit). The holder approves the router on the vault share token for the
        // gateway-style self-custody redeem.
        vm.prank(legacyDepositor);
        v1b.approve(address(router), sharesB);
        address[] memory rv = new address[](1);
        rv[0] = address(v1b);
        uint256[] memory rs = new uint256[](1);
        rs[0] = sharesB;
        uint256[] memory rMin = new uint256[](1);
        rMin[0] = 0;
        vm.prank(legacyDepositor);
        uint256[] memory got =
            router.redeemFor(legacyDepositor, legacyDepositor, rv, rs, rMin, type(uint256).max);
        assertEq(got[0], sharesB, "router redeem returns full assets from retired vault");
        assertEq(v1b.balanceOf(legacyDepositor), 0, "v1b shares burned on router redeem");
        assertEq(usdc.balanceOf(legacyDepositor), 100 * ONE_USDC, "USDC out from both redeems");
    }

    /// @notice A retired v1 vault rejects NEW deposits at the vault itself
    ///         (deposit-halt) and at the router (non-Active status), so
    ///         retirement is genuinely withdraw-only — the withdraw path proven
    ///         open above is the ONLY path that remains.
    function test_retiredV1_blocksNewDeposits() public {
        _migrateToV2();
        vm.startPrank(admin);
        registry.retire(address(v1a));
        vm.stopPrank();

        // Vault deposit-halt: a direct deposit into the retired vault reverts.
        usdc.mint(newDepositor, DEPOSIT);
        vm.startPrank(newDepositor);
        usdc.approve(address(v1a), DEPOSIT);
        vm.expectRevert(bytes("MigVault: retired"));
        v1a.deposit(DEPOSIT, newDepositor);
        vm.stopPrank();

        // Router refuses to route a fresh deposit into a retired vault: the
        // effective (v2-only) vector never includes v1a, and it cannot be
        // re-weighted in.
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioRouter.VaultNotActive.selector,
                address(v1a),
                VaultRegistry.VaultStatus.Retired
            )
        );
        router.setDefaultWeights(_vaults2(address(v1a), address(v2a)), _bps2(5000, 5000));
    }

    // ─── Router-weight (voted) migration also spans the v2 set ──────────────

    /// @notice Beyond the default (below-quorum) vector, the governance-voted
    ///         weight vector migrates to the v2 set too: after `setWeights` on
    ///         the v2 set, the router routes a deposit by the voted weights.
    function test_migration_votedWeightsSpanV2Set() public {
        _migrateToV2();

        // Governance votes an (asymmetric) weight vector over the v2 set.
        vm.prank(admin);
        router.setWeights(_vaults2(address(v2a), address(v2b)), _bps2(3000, 7000));
        assertTrue(router.votedWeightsActive(), "voted vector active");

        (address[] memory ev, uint256[] memory eb) = router.getEffectiveWeights();
        assertEq(ev[0], address(v2a), "voted leg 0 = v2a");
        assertEq(ev[1], address(v2b), "voted leg 1 = v2b");
        assertEq(eb[0], 3000, "voted v2a weight");
        assertEq(eb[1], 7000, "voted v2b weight");

        _fundApprove(newDepositor, DEPOSIT);
        vm.prank(newDepositor);
        router.deposit(DEPOSIT, new uint256[](0));
        assertEq(v2a.balanceOf(newDepositor), 30 * ONE_USDC, "voted deposit -> 30% v2a");
        assertEq(v2b.balanceOf(newDepositor), 70 * ONE_USDC, "voted deposit -> 70% v2b");
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    /// @dev Run the full atomic eligibility+weights migration from the v1 set to
    ///      the v2 set (steps 1–3 of the ordering), leaving the default vector
    ///      spanning exactly {v2a, v2b}. Shared by the retirement-focused tests.
    function _migrateToV2() internal {
        vm.startPrank(admin);
        registry.registerVault(address(v2a), _meta("Robot Money v2 A"));
        registry.registerVault(address(v2b), _meta("Robot Money v2 B"));
        registry.migrateEligibility(
            address(v2a),
            true,
            _vaults3(address(v1a), address(v1b), address(v2a)),
            _bps3(4000, 3000, 3000)
        );
        registry.migrateEligibility(
            address(v2b),
            true,
            _vaults4(address(v1a), address(v1b), address(v2a), address(v2b)),
            _bps4(2500, 2500, 2500, 2500)
        );
        registry.migrateEligibility(
            address(v1a),
            false,
            _vaults3(address(v1b), address(v2a), address(v2b)),
            _bps3(4000, 3000, 3000)
        );
        registry.migrateEligibility(
            address(v1b), false, _vaults2(address(v2a), address(v2b)), _bps2(5000, 5000)
        );
        vm.stopPrank();
        _assertInvariant(2);
    }

    /// @dev The ADR-0002 length invariant: the router's default vector length
    ///      always equals the registry's router-eligible count. Never observed
    ///      inconsistent across the atomic migration.
    function _assertInvariant(uint256 expected) internal view {
        assertEq(registry.routerEligibleCount(), expected, "routerEligibleCount");
        assertEq(router.defaultWeightsLength(), expected, "defaultWeightsLength");
        assertEq(
            registry.routerEligibleCount(),
            router.defaultWeightsLength(),
            "count == default length invariant"
        );
    }

    function _fundApprove(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.prank(user);
        usdc.approve(address(router), amount);
    }

    function _meta(string memory name) internal view returns (VaultRegistry.VaultMetadata memory) {
        return VaultRegistry.VaultMetadata({name: name, asset: address(usdc), registeredAt: 0});
    }

    function _vaults2(address a, address b) internal pure returns (address[] memory v) {
        v = new address[](2);
        v[0] = a;
        v[1] = b;
    }

    function _vaults3(address a, address b, address c) internal pure returns (address[] memory v) {
        v = new address[](3);
        v[0] = a;
        v[1] = b;
        v[2] = c;
    }

    function _vaults4(address a, address b, address c, address d)
        internal
        pure
        returns (address[] memory v)
    {
        v = new address[](4);
        v[0] = a;
        v[1] = b;
        v[2] = c;
        v[3] = d;
    }

    function _bps2(uint256 a, uint256 b) internal pure returns (uint256[] memory bps) {
        bps = new uint256[](2);
        bps[0] = a;
        bps[1] = b;
    }

    function _bps3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory bps) {
        bps = new uint256[](3);
        bps[0] = a;
        bps[1] = b;
        bps[2] = c;
    }

    function _bps4(uint256 a, uint256 b, uint256 c, uint256 d)
        internal
        pure
        returns (uint256[] memory bps)
    {
        bps = new uint256[](4);
        bps[0] = a;
        bps[1] = b;
        bps[2] = c;
        bps[3] = d;
    }
}
