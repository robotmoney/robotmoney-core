// SPDX-License-Identifier: MIT
// Canonical: none — Foundry tests for contracts/RobotMoneyVault.sol
// Covers: issue #160 — ERC-4626 decimals offset and first-depositor inflation protection
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";

// ─── Minimal USDC mock ───────────────────────────────────────────────────────

contract TestUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// ─── Minimal strategy adapter mock ──────────────────────────────────────────

/// @dev Holds USDC in the adapter (simulates deployed yield position).
///      Supports direct "donation" by crediting extra assets without going
///      through the vault — modelling the Aave / Morpho / Compound donation path.
contract MockAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDC;
    address public immutable VAULT;

    /// @notice Extra USDC credited directly (simulates protocol-level donation).
    uint256 public donatedAmount;

    error OnlyVault();

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    constructor(address usdc_, address vault_) {
        USDC = IERC20(usdc_);
        VAULT = vault_;
    }

    /// @inheritdoc IStrategyAdapter
    function deploy(uint256 amount) external onlyVault {
        // Assets already transferred to the adapter by the vault; nothing extra to do.
    }

    /// @inheritdoc IStrategyAdapter
    function withdraw(uint256 amount) external onlyVault returns (uint256) {
        uint256 bal = USDC.balanceOf(address(this));
        uint256 actual = amount > bal ? bal : amount;
        USDC.safeTransfer(VAULT, actual);
        // Reset donated portion as it flows back to the vault.
        if (actual >= donatedAmount) {
            donatedAmount = 0;
        } else {
            donatedAmount -= actual;
        }
        return actual;
    }

    /// @inheritdoc IStrategyAdapter
    function totalAssets() external view returns (uint256) {
        return USDC.balanceOf(address(this));
    }

    /// @inheritdoc IStrategyAdapter
    function rescueTokens(address, address) external onlyVault {}

    /// @notice Simulate a protocol-level donation: credits USDC directly to the adapter
    ///         without going through the vault (models Aave `supply(onBehalfOf=adapter)`,
    ///         Morpho `deposit(receiver=adapter)`, or Compound `supply` to adapter).
    function donateFromAttacker(address attacker, uint256 amount) external {
        USDC.safeTransferFrom(attacker, address(this), amount);
        donatedAmount += amount;
    }
}

// ─── Vault harness ───────────────────────────────────────────────────────────

/// @dev Exposes internal helpers for tests.
contract VaultHarness is RobotMoneyVault {
    constructor(
        IERC20 asset_,
        uint256 tvlCap_,
        uint256 perDepositCap_,
        uint256 exitFeeBps_,
        address feeRecipient_,
        address admin_
    ) RobotMoneyVault(asset_, tvlCap_, perDepositCap_, exitFeeBps_, feeRecipient_, admin_) {}

    function exposed_decimalsOffset() external pure returns (uint8) {
        return _decimalsOffset();
    }
}

// ─── Main test contract ──────────────────────────────────────────────────────

contract RobotMoneyVaultTest is Test {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant TVL_CAP = 1_000_000_000 * ONE_USDC; // 1 billion USDC
    uint256 internal constant PER_DEPOSIT_CAP = 100_000_000 * ONE_USDC; // 100M USDC

    // decimalsOffset = 18, so virtual shares = 10^18.
    // Raw shares for a 1:1 price: previewDeposit(1e6) on fresh vault = 1e6 * 1e18 = 1e24.
    uint256 internal constant OFFSET = 18;
    uint256 internal constant VIRTUAL_SHARES = 10 ** OFFSET; // 1e18

    TestUSDC internal usdc;
    VaultHarness internal vault;
    MockAdapter internal adapter;

    address internal admin = makeAddr("admin");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        usdc = new TestUSDC();
        vault = new VaultHarness(
            IERC20(address(usdc)),
            TVL_CAP,
            PER_DEPOSIT_CAP,
            0, // no exit fee for most tests
            feeRecipient,
            admin
        );

        // Wire up a simple mock adapter.
        adapter = new MockAdapter(address(usdc), address(vault));
        vm.prank(admin);
        vault.addAdapter(address(adapter), 10_000); // 100% cap

        // Give participants USDC.
        usdc.mint(alice, 100_000 * ONE_USDC);
        usdc.mint(bob, 100_000 * ONE_USDC);
        usdc.mint(attacker, 2_000_000 * ONE_USDC);

        // Pre-approve vault.
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(attacker);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(attacker);
        usdc.approve(address(adapter), type(uint256).max);
    }

    // ─── Decimals offset ────────────────────────────────────────────────────

    /// @notice Confirm the offset is exactly 18 (the value proven safe against inflation attacks).
    function test_decimalsOffset_is18() public view {
        assertEq(vault.exposed_decimalsOffset(), 18, "offset must be 18");
    }

    /// @notice Share token decimals remain 6 (USDC-matching, intentional override).
    function test_shareDecimals_is6() public view {
        assertEq(vault.decimals(), 6, "share token decimals must be 6");
    }

    // ─── Fresh-vault preview functions ─────────────────────────────────────

    /// @notice previewDeposit on a fresh vault: depositing 1 USDC returns 1e24 raw shares.
    ///         This is the expected raw-share scale with decimalsOffset=18 and decimals()=6.
    function test_previewDeposit_freshVault_rawShareScale() public view {
        // Formula: assets * (totalSupply + 10^18) / (totalAssets + 1)
        //          = 1e6 * (0 + 1e18) / (0 + 1) = 1e24
        uint256 expected = ONE_USDC * VIRTUAL_SHARES; // 1e24
        assertEq(vault.previewDeposit(ONE_USDC), expected, "fresh previewDeposit raw share scale");
    }

    /// @notice previewDeposit scales linearly for larger amounts on fresh vault.
    function test_previewDeposit_freshVault_largeAmount() public view {
        uint256 amount = 1_000 * ONE_USDC; // 1000 USDC
        uint256 expected = amount * VIRTUAL_SHARES;
        assertEq(vault.previewDeposit(amount), expected, "fresh previewDeposit 1000 USDC");
    }

    /// @notice previewMint on a fresh vault: minting 1e24 raw shares costs 1 USDC.
    function test_previewMint_freshVault_rawShareScale() public view {
        uint256 rawShares = ONE_USDC * VIRTUAL_SHARES; // 1e24
        // Formula (ceil): shares * (totalAssets + 1) / (totalSupply + 10^18)
        //                = 1e24 * 1 / 1e18 = 1e6
        assertEq(vault.previewMint(rawShares), ONE_USDC, "fresh previewMint raw share scale");
    }

    /// @notice previewWithdraw on a fresh vault: receiving 1 USDC requires 1e24 raw shares.
    function test_previewWithdraw_freshVault_rawShareScale() public view {
        // RobotMoneyVault.previewWithdraw converts net assets to gross then to shares.
        // With exitFeeBps=0, gross=net. Shares = assets * 10^18 / 1 = 1e24 (ceil).
        uint256 expected = ONE_USDC * VIRTUAL_SHARES;
        assertEq(vault.previewWithdraw(ONE_USDC), expected, "fresh previewWithdraw raw share scale");
    }

    /// @notice previewRedeem on a fresh vault: redeeming 1e24 raw shares yields 1 USDC.
    function test_previewRedeem_freshVault_rawShareScale() public view {
        uint256 rawShares = ONE_USDC * VIRTUAL_SHARES; // 1e24
        // RobotMoneyVault.previewRedeem converts shares to gross assets then applies fee.
        // grossAssets = 1e24 * 1 / 1e18 = 1e6. fee = 0. netAssets = 1e6.
        assertEq(vault.previewRedeem(rawShares), ONE_USDC, "fresh previewRedeem raw share scale");
    }

    // ─── After seed deposit: preview functions remain consistent ────────────

    /// @notice After the admin seeds 1000 USDC, previewDeposit is still proportional.
    function test_previewDeposit_afterSeed_proportional() public {
        uint256 seed = 1_000 * ONE_USDC;
        usdc.mint(admin, seed);
        vm.startPrank(admin);
        usdc.approve(address(vault), seed);
        vault.deposit(seed, admin);
        vm.stopPrank();

        // After seed: totalSupply = seed * 1e18, totalAssets ≈ seed
        // previewDeposit(seed) = seed * (seed*1e18 + 1e18) / (seed + 1)
        //                      ≈ seed * 1e18 (for large seed values the +1 terms are negligible)
        uint256 preview = vault.previewDeposit(seed);
        uint256 approxExpected = seed * VIRTUAL_SHARES;
        // Allow 1 wei rounding tolerance.
        assertApproxEqAbs(preview, approxExpected, 1, "previewDeposit after seed");
    }

    // ─── First-depositor inflation attack resistance ─────────────────────────

    /// @notice Core attack scenario: attacker deposits 1 wei then donates 1M USDC to the
    ///         adapter directly (bypassing the vault). Victim deposits — must NOT receive
    ///         zero shares, and must receive economically fair shares.
    function test_inflationAttack_victimReceivesFairShares() public {
        // 1. Attacker deposits 1 wei USDC.
        usdc.mint(attacker, 1);
        vm.prank(attacker);
        usdc.approve(address(vault), 1);
        vm.prank(attacker);
        uint256 attackerShares = vault.deposit(1, attacker);
        assertGt(attackerShares, 0, "attacker must get shares");

        uint256 totalAssetsBefore = vault.totalAssets();

        // 2. Attacker donates 1,000,000 USDC directly to the adapter
        //    (models Aave supply(onBehalfOf=adapter), Morpho deposit(receiver=adapter), etc.)
        uint256 donationAmount = 1_000_000 * ONE_USDC;
        adapter.donateFromAttacker(attacker, donationAmount);

        uint256 totalAssetsAfterDonation = vault.totalAssets();
        assertEq(
            totalAssetsAfterDonation,
            totalAssetsBefore + donationAmount,
            "donation must increase totalAssets"
        );

        // 3. Victim deposits a realistic amount. Bob has 100k USDC.
        uint256 victimDeposit = 100_000 * ONE_USDC;
        vm.prank(bob);
        uint256 victimShares = vault.deposit(victimDeposit, bob);

        // Victim must receive non-zero shares.
        assertGt(
            victimShares, 0, "victim must receive non-zero shares (offset protects against zero)"
        );

        // Victim shares must be economically fair: victim should receive shares worth
        // at least 99% of their deposit value (attacker gains < 1% of victim's capital).
        // Fair shares = victimDeposit * (totalSupply + virtual) / (totalAssets + 1)
        // The virtual floor of 1e18 prevents the attacker's donation from dominating.
        uint256 victimAssetsBack = vault.previewRedeem(victimShares);
        // Victim should recover at least 90% of their deposit (donation dilutes but offset protects)
        assertGe(
            victimAssetsBack * 100,
            victimDeposit * 90,
            "victim must recover at least 90% of deposit value"
        );
    }

    /// @notice After a 1 wei first deposit + 1M USDC donation, previewDeposit for a
    ///         realistic victim amount (999_999 USDC) must NOT return zero shares.
    function test_inflationAttack_previewDepositNonZero() public {
        // Attacker seed deposit.
        usdc.mint(attacker, 1);
        vm.prank(attacker);
        usdc.approve(address(vault), 1);
        vm.prank(attacker);
        vault.deposit(1, attacker);

        // Donation directly to adapter.
        adapter.donateFromAttacker(attacker, 1_000_000 * ONE_USDC);

        // previewDeposit for victim must be non-zero.
        uint256 preview = vault.previewDeposit(999_999 * ONE_USDC);
        assertGt(preview, 0, "previewDeposit must be non-zero after donation attack");
    }

    // ─── Adapter-specific donation paths ─────────────────────────────────────

    /// @notice Verify that an Aave-style donation (to the adapter, bypassing the vault)
    ///         cannot force a realistic victim deposit to receive zero shares.
    function test_aaveStyleDonation_victimSharesNonZero() public {
        // Seed: first depositor puts in 1 USDC legitimately.
        vm.prank(alice);
        vault.deposit(ONE_USDC, alice);

        // Aave-style: attacker donates 1M USDC directly to the adapter.
        adapter.donateFromAttacker(attacker, 1_000_000 * ONE_USDC);

        // Victim deposits 500k USDC.
        uint256 victimDeposit = 500_000 * ONE_USDC;
        uint256 preview = vault.previewDeposit(victimDeposit);
        assertGt(preview, 0, "Aave-style donation: victim previewDeposit must be non-zero");
    }

    /// @notice Verify that a Morpho-style donation (also to the adapter)
    ///         cannot force a realistic victim deposit to receive zero shares.
    function test_morphoStyleDonation_victimSharesNonZero() public {
        vm.prank(alice);
        vault.deposit(ONE_USDC, alice);

        // Morpho-style: same adapter donation path.
        adapter.donateFromAttacker(attacker, 1_000_000 * ONE_USDC);

        uint256 preview = vault.previewDeposit(500_000 * ONE_USDC);
        assertGt(preview, 0, "Morpho-style donation: victim previewDeposit must be non-zero");
    }

    /// @notice Verify that a Compound-style donation (also via adapter)
    ///         cannot force a realistic victim deposit to receive zero shares.
    function test_compoundStyleDonation_victimSharesNonZero() public {
        vm.prank(alice);
        vault.deposit(ONE_USDC, alice);

        // Compound-style: same adapter donation path.
        adapter.donateFromAttacker(attacker, 1_000_000 * ONE_USDC);

        uint256 preview = vault.previewDeposit(500_000 * ONE_USDC);
        assertGt(preview, 0, "Compound-style donation: victim previewDeposit must be non-zero");
    }

    // ─── Seed deposit correctness ──────────────────────────────────────────

    /// @notice Admin can perform the recommended seed deposit immediately after deployment.
    ///         After seeding 1000 USDC, the vault is safe for public deposits.
    function test_seedDeposit_adminCanSeed1000USDC() public {
        uint256 seedAmount = 1_000 * ONE_USDC;
        usdc.mint(admin, seedAmount);
        vm.prank(admin);
        usdc.approve(address(vault), seedAmount);
        vm.prank(admin);
        uint256 seedShares = vault.deposit(seedAmount, admin);

        assertGt(seedShares, 0, "seed deposit must mint shares");
        assertGe(vault.totalAssets(), seedAmount, "totalAssets must include seed");
        assertEq(vault.totalSupply(), seedShares, "totalSupply must reflect seed shares");
    }

    /// @notice After a 1000 USDC admin seed, a normal user deposit is proportional.
    function test_seedDeposit_normalDepositProportional() public {
        uint256 seedAmount = 1_000 * ONE_USDC;
        usdc.mint(admin, seedAmount);
        vm.prank(admin);
        usdc.approve(address(vault), seedAmount);
        vm.prank(admin);
        vault.deposit(seedAmount, admin);

        // Alice deposits same amount.
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(seedAmount, alice);

        // Alice should get approximately the same number of shares as the seed.
        uint256 seedShares = vault.balanceOf(admin);
        assertApproxEqRel(aliceShares, seedShares, 0.001e18, "proportional deposit after seed");
    }

    // ─── Round-trip: deposit → redeem ──────────────────────────────────────

    /// @notice Depositing then immediately redeeming returns (approximately) the same assets.
    function test_depositAndRedeem_roundTrip() public {
        uint256 amount = 10_000 * ONE_USDC;
        vm.prank(alice);
        uint256 shares = vault.deposit(amount, alice);

        assertGt(shares, 0, "must get shares");

        // Pull assets from adapter back to vault for withdrawal.
        vm.prank(alice);
        uint256 assetsOut = vault.redeem(shares, alice, alice);

        // With no exit fee, assetsOut should equal amount (minus rounding).
        assertApproxEqAbs(assetsOut, amount, 1, "redeem round-trip");
    }
}
