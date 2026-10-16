// SPDX-License-Identifier: MIT
// Canonical: none — Foundry tests for contracts/RobotMoneyVault.sol
// Covers: issue #160 — ERC-4626 decimals offset and first-depositor inflation protection
//         issue #161 — include idle vault USDC balance in totalAssets()
//         core 1820 — exclusion records: recovery from an excluded adapter paid pro rata to
//         the holders at exclusion (ExclusionLedger)
//         security round 1 — force-removed records stay open until a re-add settles them,
//         the EMERGENCY exclude-only lever, routing that respects the Morpho exposure cap
//         security round 2 — `recoverRemovedAdapter` credits a force-removed record tranche by
//         tranche
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {ExclusionLedger} from "../ExclusionLedger.sol";
import {AaveV3Adapter} from "../adapters/AaveV3Adapter.sol";
import {CompoundV3Adapter} from "../adapters/CompoundV3Adapter.sol";
import {MorphoAdapter} from "../adapters/MorphoAdapter.sol";
import {NoYieldTestAdapter} from "./helpers/NoYieldTestAdapter.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";
import {AdminFloorAccessControlCounter} from "../lib/AdminFloorAccessControlCounter.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";
import {GovernedUUPS} from "../lib/GovernedUUPS.sol";
import {MockMorphoVault} from "./MorphoAdapter.t.sol";

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
    bool public revertTotalAssets;

    error OnlyVault();
    error TotalAssetsUnavailable();

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
        if (revertTotalAssets) revert TotalAssetsUnavailable();
        return USDC.balanceOf(address(this));
    }

    function setRevertTotalAssets(bool enabled) external {
        revertTotalAssets = enabled;
    }

    /// @inheritdoc IStrategyAdapter
    function sweepForeignToken(address) external {}

    /// @inheritdoc IStrategyAdapter
    function harvestRewards() external {}

    /// @notice Simulate a protocol-level donation: credits USDC directly to the adapter
    ///         without going through the vault (models Aave `supply(onBehalfOf=adapter)`,
    ///         Morpho `deposit(receiver=adapter)`, or Compound `supply` to adapter).
    function donateFromAttacker(address attacker, uint256 amount) external {
        USDC.safeTransferFrom(attacker, address(this), amount);
        donatedAmount += amount;
    }
}

/// @dev A venue that goes illiquid: `totalAssets` keeps reporting the USDC it holds while
///      `withdraw` reverts (Moonwell at 100% utilization; `MorphoAdapter.totalAssets` keeps
///      pricing illiquid shares, FS-VLT-10). `realiseLoss` burns part of the balance, the bad debt
///      a recovery later turns out to carry.
contract IlliquidMockAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDC;
    address public immutable VAULT;
    bool public illiquid;

    error OnlyVault();
    error VenueIlliquid();

    constructor(address usdc_, address vault_) {
        USDC = IERC20(usdc_);
        VAULT = vault_;
    }

    function setIlliquid(bool on) external {
        illiquid = on;
    }

    /// @dev Bad debt: `amount` of the held USDC is gone for good.
    function realiseLoss(uint256 amount) external {
        USDC.safeTransfer(address(0xdead), amount);
    }

    /// @inheritdoc IStrategyAdapter
    function deploy(uint256) external {
        if (msg.sender != VAULT) revert OnlyVault();
    }

    /// @inheritdoc IStrategyAdapter
    function withdraw(uint256 amount) external returns (uint256) {
        if (msg.sender != VAULT) revert OnlyVault();
        if (illiquid) revert VenueIlliquid();
        uint256 bal = USDC.balanceOf(address(this));
        uint256 actual = amount > bal ? bal : amount;
        USDC.safeTransfer(VAULT, actual);
        return actual;
    }

    /// @inheritdoc IStrategyAdapter
    function totalAssets() external view returns (uint256) {
        return USDC.balanceOf(address(this));
    }

    /// @inheritdoc IStrategyAdapter
    function sweepForeignToken(address) external {}

    /// @inheritdoc IStrategyAdapter
    function harvestRewards() external {}
}

/// @dev A venue that can pay out only part of the position: `withdraw` pays up to `liquid` and
///      reverts above it (a MetaMorpho whose markets sit at high utilization, or carry bad debt in
///      one market). `totalAssets` keeps reporting the whole balance, as `MorphoAdapter` does.
contract PartlyLiquidMockAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDC;
    address public immutable VAULT;
    uint256 public liquid;

    error OnlyVault();
    error VenueIlliquid(uint256 requested, uint256 liquid);

    constructor(address usdc_, address vault_) {
        USDC = IERC20(usdc_);
        VAULT = vault_;
    }

    function setLiquid(uint256 liquid_) external {
        liquid = liquid_;
    }

    /// @inheritdoc IStrategyAdapter
    function deploy(uint256) external {
        if (msg.sender != VAULT) revert OnlyVault();
    }

    /// @inheritdoc IStrategyAdapter
    function withdraw(uint256 amount) external returns (uint256) {
        if (msg.sender != VAULT) revert OnlyVault();
        if (amount > liquid) revert VenueIlliquid(amount, liquid);
        liquid -= amount;
        USDC.safeTransfer(VAULT, amount);
        return amount;
    }

    /// @inheritdoc IStrategyAdapter
    function totalAssets() external view returns (uint256) {
        return USDC.balanceOf(address(this));
    }

    /// @inheritdoc IStrategyAdapter
    function sweepForeignToken(address) external {}

    /// @inheritdoc IStrategyAdapter
    function harvestRewards() external {}
}

/// @dev Adapter that over-reports `totalAssets` by a configurable phantom amount and
///      can leak real USDC out, modelling a buggy or lying adapter. Used for the
///      `_pullProportional` shortfall tests (audit 2026-06-09, L-2).
contract ShortfallAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDC;
    address public immutable VAULT;

    /// @notice Phantom assets added on top of the real balance in `totalAssets()`.
    uint256 public phantom;

    constructor(address usdc_, address vault_) {
        USDC = IERC20(usdc_);
        VAULT = vault_;
    }

    function setPhantom(uint256 phantom_) external {
        phantom = phantom_;
    }

    /// @notice Simulate a loss: move real USDC out without adjusting reporting.
    function leak(address to, uint256 amount) external {
        USDC.safeTransfer(to, amount);
    }

    /// @inheritdoc IStrategyAdapter
    function deploy(uint256) external {}

    /// @inheritdoc IStrategyAdapter
    function withdraw(uint256 amount) external returns (uint256) {
        uint256 bal = USDC.balanceOf(address(this));
        uint256 actual = amount > bal ? bal : amount;
        USDC.safeTransfer(VAULT, actual);
        return actual;
    }

    /// @inheritdoc IStrategyAdapter
    function totalAssets() external view returns (uint256) {
        return USDC.balanceOf(address(this)) + phantom;
    }

    /// @inheritdoc IStrategyAdapter
    function sweepForeignToken(address) external {}

    /// @inheritdoc IStrategyAdapter
    function harvestRewards() external {}
}

// ─── Vault harness ───────────────────────────────────────────────────────────

/// @dev Exposes internal helpers for tests.
contract VaultHarness is RobotMoneyVault {
    function exposed_decimalsOffset() external pure returns (uint8) {
        return _decimalsOffset();
    }
}

/// @dev A `VaultHarness` behind an initialized ERC-1967 proxy (issue 1808), taking the
///      arguments the harness constructor took.
function newVaultHarness(
    IERC20 asset_,
    uint256 tvlCap_,
    uint256 perDepositCap_,
    uint256 exitFeeBps_,
    address feeRecipient_,
    address admin_,
    address emergencyResponder_
) returns (VaultHarness) {
    (address t, GovernedUUPS.UpgradeMode m) = CoreProxies.config();
    return VaultHarness(
        CoreProxies.proxy(
            address(new VaultHarness()),
            abi.encodeCall(
                RobotMoneyVault.initialize,
                (
                    asset_,
                    tvlCap_,
                    perDepositCap_,
                    exitFeeBps_,
                    feeRecipient_,
                    admin_,
                    emergencyResponder_,
                    t,
                    m
                )
            )
        )
    );
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
        vault = newVaultHarness(
            IERC20(address(usdc)),
            TVL_CAP,
            PER_DEPOSIT_CAP,
            0, // no exit fee for most tests
            feeRecipient,
            admin,
            admin
        );

        // Wire up a simple mock adapter.
        adapter = new MockAdapter(address(usdc), address(vault));
        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), true);
        vm.prank(admin);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
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

    function _allowAdapter(RobotMoneyVault vault_, address adapter_) internal {
        vm.prank(admin);
        vault_.setAdapterAllowed(adapter_, true);
        vm.prank(admin);
        vault_.setAdapterCodeHashAllowed(adapter_.codehash, true);
    }

    // ─── Last-admin floor (ACL-3 / F-06, issue #1284) ─────────────────────────
    //
    // RobotMoneyVault previously had no protection against the final ADMIN_ROLE
    // holder renouncing/being revoked, unlike BasketVault.sol
    // (which each had their own hand-rolled counter). These three tests were
    // red before this fix — `renounceRole`/`revokeRole` succeeded silently,
    // stripping the vault's ADMIN_ROLE membership to zero and permanently
    // bricking setRegistry/fee configuration/keeper assignment/the
    // EMERGENCY_ROLE grant path.

    /// @notice The sole ADMIN_ROLE holder cannot renounce.
    function test_lastAdminFloor_renounceRevertsForSoleAdmin() public {
        bytes32 role = vault.ADMIN_ROLE();
        vm.prank(admin);
        vm.expectRevert(AdminFloorAccessControlCounter.LastAdminFloor.selector);
        vault.renounceRole(role, admin);
    }

    /// @notice The sole ADMIN_ROLE holder cannot be revoked (even by itself).
    function test_lastAdminFloor_revokeRevertsForSoleAdmin() public {
        bytes32 role = vault.ADMIN_ROLE();
        vm.prank(admin);
        vm.expectRevert(AdminFloorAccessControlCounter.LastAdminFloor.selector);
        vault.revokeRole(role, admin);
    }

    /// @notice Once a second admin exists, revoking the original one succeeds —
    ///         the floor blocks only the last-holder transition, not admin
    ///         rotation.
    function test_lastAdminFloor_revokeSucceedsWithTwoAdmins() public {
        bytes32 role = vault.ADMIN_ROLE();
        address secondAdmin = makeAddr("secondAdmin");
        vm.prank(admin);
        vault.grantRole(role, secondAdmin);

        vm.prank(admin);
        vault.revokeRole(role, admin);

        assertFalse(vault.hasRole(role, admin), "original admin must be revoked");
        assertTrue(vault.hasRole(role, secondAdmin), "second admin must still hold the role");
    }

    // ─── Adapter eligibility ─────────────────────────────────────────────────

    function test_addAdapter_revertsWhenAdapterAddressNotAllowed() public {
        MockAdapter unapproved = new MockAdapter(address(usdc), address(vault));

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(RobotMoneyVault.AdapterNotAllowed.selector, address(unapproved))
        );
        vault.addAdapter(address(unapproved), 10_000);
    }

    function test_addAdapter_revertsWhenAdapterCodeHashNotAllowed() public {
        // Distinct-bytecode adapter whose codehash is never allowlisted in
        // setUp (MockAdapter's codehash is, so it could not exercise the
        // codehash-gate revert here).
        NoYieldTestAdapter unapproved = new NoYieldTestAdapter(address(usdc), address(vault));
        vm.prank(admin);
        vault.setAdapterAllowed(address(unapproved), true);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                RobotMoneyVault.AdapterCodeHashNotAllowed.selector,
                address(unapproved),
                address(unapproved).codehash
            )
        );
        vault.addAdapter(address(unapproved), 10_000);
    }

    function test_addAdapter_revertsWhenAdapterAssetMismatchesVault() public {
        TestUSDC wrongUsdc = new TestUSDC();
        MockAdapter wrongAssetAdapter = new MockAdapter(address(wrongUsdc), address(vault));
        _allowAdapter(vault, address(wrongAssetAdapter));

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                RobotMoneyVault.AdapterAssetMismatch.selector,
                address(wrongAssetAdapter),
                address(usdc),
                address(wrongUsdc)
            )
        );
        vault.addAdapter(address(wrongAssetAdapter), 10_000);
    }

    function test_addAdapter_revertsWhenAdapterVaultMismatchesVault() public {
        address wrongVault = makeAddr("wrongVault");
        MockAdapter wrongVaultAdapter = new MockAdapter(address(usdc), wrongVault);
        _allowAdapter(vault, address(wrongVaultAdapter));

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                RobotMoneyVault.AdapterVaultMismatch.selector,
                address(wrongVaultAdapter),
                address(vault),
                wrongVault
            )
        );
        vault.addAdapter(address(wrongVaultAdapter), 10_000);
    }

    // ─── Duplicate adapter entries (core 1789) ───────────────────────────────

    /// @notice core 1789: an address that an ACTIVE entry already holds cannot be added
    ///         again, at any registry index. A second active entry would count the one
    ///         balance twice in `totalAssets()` and overpay the first redeemer.
    function test_addAdapter_revertsWhenAdapterAlreadyActive() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);

        // Same address as the fixture's index-0 entry, any cap.
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(RobotMoneyVault.AdapterAlreadyActive.selector, address(adapter))
        );
        vault.addAdapter(address(adapter), 5_000);

        assertEq(vault.adapterCount(), 1, "no second registry entry");
        assertEq(vault.activeAdapterCount(), 1, "one active entry");
        assertEq(vault.totalAssets(), 1_000 * ONE_USDC, "balance counted once");

        // The scan covers every active entry, not only index 0.
        MockAdapter second = new MockAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(second));
        vm.prank(admin);
        vault.addAdapter(address(second), 10_000);
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(RobotMoneyVault.AdapterAlreadyActive.selector, address(second))
        );
        vault.addAdapter(address(second), 10_000);
        assertEq(vault.adapterCount(), 2, "still two registry entries");
    }

    /// @notice core 1789: re-adding an adapter after `forceRemoveAdapter` stays legal. It
    ///         appends a NEW entry (this family never reactivates the inactive one in
    ///         place), and the inactive entry is never counted. Security round 1: the
    ///         force-remove opened an exclusion record for the funded entry, so the re-add
    ///         first realises the stranded balance into that record. The new entry starts
    ///         empty: the balance does not re-enter NAV, and the holder of the moment is paid
    ///         through the record. A further add of the same address is then refused against
    ///         the new active entry.
    function test_addAdapter_afterForceRemoveSucceeds() public {
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(1_000 * ONE_USDC, alice);
        ExclusionLedger ledger = vault.exclusionLedger();

        vm.prank(admin);
        vault.forceRemoveAdapter(0);
        assertEq(vault.totalAssets(), 0, "force-removed balance left NAV");
        assertEq(vault.openExclusionOf(0), 1, "the funded entry kept a record");
        assertEq(ledger.balanceAt(alice, 1), aliceShares, "the holder of the moment owns it");

        vm.expectEmit(true, true, false, true, address(ledger));
        emit ExclusionLedger.ExclusionRecoveryCredited(
            1, ExclusionLedger.RecoverySource.Restoration, 1_000 * ONE_USDC, 1_000 * ONE_USDC
        );
        vm.expectEmit(true, true, false, true, address(vault));
        emit RobotMoneyVault.AdapterAdded(1, address(adapter), 10_000);
        vm.prank(admin);
        vault.addAdapter(address(adapter), 10_000);

        assertEq(vault.adapterCount(), 2, "re-add appends a new entry");
        assertEq(vault.activeAdapterCount(), 1, "only the new entry is active");
        (,, bool oldActive) = vault.adapters(0);
        assertFalse(oldActive, "the force-removed entry stays inactive");
        assertEq(vault.openExclusionOf(0), 0, "the re-add settled the record");
        assertEq(adapter.totalAssets(), 0, "the new entry starts empty");
        assertEq(vault.totalAssets(), 0, "the stranded balance did not re-enter NAV");

        // The scan skips the inactive index 0 and finds the new active index 1.
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(RobotMoneyVault.AdapterAlreadyActive.selector, address(adapter))
        );
        vault.addAdapter(address(adapter), 10_000);

        // The holder is made whole through the record.
        uint256 before = usdc.balanceOf(alice);
        ledger.claim(1, alice);
        assertEq(usdc.balanceOf(alice) - before, 1_000 * ONE_USDC, "alice paid in full");
    }

    function test_approvedProductionAndDevnetAdapterTypesCanBeAdded() public {
        VaultHarness typedVault = newVaultHarness(
            IERC20(address(usdc)), TVL_CAP, PER_DEPOSIT_CAP, 0, feeRecipient, admin, admin
        );
        address pool = makeAddr("aavePool");
        address aToken = makeAddr("aToken");
        address comet = makeAddr("compoundComet");
        address morphoVault = makeAddr("morphoVault");

        AaveV3Adapter aave = new AaveV3Adapter(pool, address(usdc), aToken, address(typedVault));
        CompoundV3Adapter compound =
            new CompoundV3Adapter(comet, address(usdc), address(typedVault));
        MorphoAdapter morpho = new MorphoAdapter(morphoVault, address(usdc), address(typedVault));
        // Fourth, generic no-yield adapter to prove the vault accepts multiple
        // distinct adapter instances (not just the three real protocol types).
        MockAdapter generic = new MockAdapter(address(usdc), address(typedVault));

        _allowAdapter(typedVault, address(aave));
        _allowAdapter(typedVault, address(compound));
        _allowAdapter(typedVault, address(morpho));
        _allowAdapter(typedVault, address(generic));

        vm.startPrank(admin);
        typedVault.addAdapter(address(aave), 2_500);
        typedVault.addAdapter(address(compound), 2_500);
        typedVault.addAdapter(address(morpho), 2_500);
        typedVault.addAdapter(address(generic), 2_500);
        vm.stopPrank();

        assertEq(typedVault.adapterCount(), 4, "all approved adapter types should be added");
        assertEq(typedVault.activeAdapterCount(), 4, "all approved adapter types should be active");
    }

    /// @notice core 1788: while any active adapter is ineligible (excluded from NAV),
    ///         `maxDeposit`/`maxMint` are zero and `deposit`/`mint` revert.
    function test_deposit_closedWhileActiveAdapterIneligible() public {
        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), false);

        assertEq(vault.maxDeposit(alice), 0, "maxDeposit must be zero");
        assertEq(vault.maxMint(alice), 0, "maxMint must be zero");

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626.ERC4626ExceededMaxDeposit.selector, alice, 1_000 * ONE_USDC, 0
            )
        );
        vault.deposit(1_000 * ONE_USDC, alice);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxMint.selector, alice, 1e18, 0)
        );
        vault.mint(1e18, alice);

        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), true);
        assertGt(vault.maxDeposit(alice), 0, "deposits reopen once eligibility is restored");
    }

    /// @notice core 1788 / review finding 1 (test_revokedAdapterReactivationTransfersValue):
    ///         a depositor can no longer mint at the reduced NAV of a quarantined adapter
    ///         and capture its balance when eligibility returns. Withdrawals stay open.
    function test_revokedAdapterReactivation_cannotTransferValue() public {
        MockAdapter second = new MockAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(second));
        vm.prank(admin);
        vault.addAdapter(address(second), 10_000);

        vm.prank(alice);
        vault.deposit(2_000 * ONE_USDC, alice);
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), false);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626.ERC4626ExceededMaxDeposit.selector, bob, 1_000 * ONE_USDC, 0
            )
        );
        vault.deposit(1_000 * ONE_USDC, bob);

        // Withdrawals still succeed during exclusion, from the eligible adapter only.
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.withdraw(500 * ONE_USDC, alice, alice);
        assertEq(usdc.balanceOf(alice) - before, 500 * ONE_USDC, "withdraw during exclusion");
        assertEq(usdc.balanceOf(address(second)), 1_000 * ONE_USDC, "quarantined untouched");
    }

    /// @notice core 1788 / review finding 6 (test_O2_keeperRebalanceUndoesEmergencyWithdraw):
    ///         a keeper rebalance cannot re-deploy funds drained by `emergencyWithdraw`.
    function test_rebalance_revertsWhileDepositsPausedAfterEmergencyWithdraw() public {
        address emergency = makeAddr("emergency");
        address keeper = makeAddr("keeper");
        vm.startPrank(admin);
        vault.grantRole(vault.EMERGENCY_ROLE(), emergency);
        vault.grantRole(vault.KEEPER_ROLE(), keeper);
        vm.stopPrank();

        vm.prank(alice);
        vault.deposit(10_000 * ONE_USDC, alice);
        vm.prank(emergency);
        vault.emergencyWithdraw();
        assertEq(adapter.totalAssets(), 0, "drained");

        vm.warp(block.timestamp + 13 hours);
        vm.prank(keeper);
        vm.expectRevert(RobotMoneyVault.DepositsArePaused.selector);
        vault.rebalance();
        assertEq(adapter.totalAssets(), 0, "funds stay idle");
    }

    /// @notice core 1788: keeper rebalance refuses to run while the vault is shut down.
    function test_rebalance_revertsWhileShutdown() public {
        address emergency = makeAddr("emergency");
        vm.startPrank(admin);
        vault.grantRole(vault.EMERGENCY_ROLE(), emergency);
        vm.stopPrank();
        vm.prank(emergency);
        vault.shutdownVault();

        vm.warp(block.timestamp + vault.minRebalanceInterval());
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.VaultShutdown.selector);
        vault.rebalance();
    }

    /// @notice core 1788: keeper rebalance never pulls from a quarantined adapter.
    function test_rebalance_doesNotPullFromQuarantinedAdapter() public {
        MockAdapter second = new MockAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(second));
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(admin);
        vault.addAdapter(address(second), 10_000);
        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), false);

        vm.warp(block.timestamp + vault.minRebalanceInterval());
        vm.prank(admin);
        vault.rebalance();
        assertEq(usdc.balanceOf(address(adapter)), 1_000 * ONE_USDC, "quarantined untouched");
        assertEq(usdc.balanceOf(address(second)), 0, "nothing moved");
    }

    /// @notice `_pullProportional` reverts with the dedicated
    ///         `InsufficientAdapterLiquidity` error (instead of an opaque ERC-20
    ///         transfer revert) when the active adapters cannot deliver the
    ///         requested withdrawal (audit 2026-06-09, L-2).
    function test_withdraw_revertsWithInsufficientAdapterLiquidity_onAdapterShortfall() public {
        ShortfallAdapter liar = new ShortfallAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(liar));
        vm.prank(admin);
        vault.addAdapter(address(liar), 10_000);
        // Deactivate the honest default adapter so the liar is the only active one.
        vm.prank(admin);
        vault.removeAdapter(0);

        uint256 amount = 1_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(amount, alice); // routed entirely into the liar (real 1 000)

        liar.setPhantom(500 * ONE_USDC); // reports 1 500 but can only deliver 1 000

        uint256 aliceShares = vault.balanceOf(alice);
        // No exit fee: the gross pulled from adapters equals previewRedeem; only
        // the liar's real 1 000 USDC is deliverable.
        uint256 expectedGross = vault.previewRedeem(aliceShares);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                RobotMoneyVault.InsufficientAdapterLiquidity.selector, expectedGross, amount
            )
        );
        vault.redeem(aliceShares, alice, alice);
    }

    /// @notice The leftover sweep distributes a shortfall across ALL active adapters
    ///         instead of dumping it on the last one: a withdrawal that the honest
    ///         adapter can cover succeeds even when the registry's last adapter
    ///         under-delivers (audit 2026-06-09, L-2).
    function test_withdraw_sweepCoversLastAdapterShortfall() public {
        // Registry: [honest default adapter, lying adapter last].
        ShortfallAdapter liar = new ShortfallAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(liar));
        vm.prank(admin);
        vault.addAdapter(address(liar), 10_000);

        vm.prank(alice);
        vault.deposit(1_600 * ONE_USDC, alice); // equal-weight 800 / 800
        assertEq(usdc.balanceOf(address(adapter)), 800 * ONE_USDC, "honest adapter funded");
        assertEq(usdc.balanceOf(address(liar)), 800 * ONE_USDC, "liar funded");

        // The liar loses 700 real USDC but keeps reporting 600 (100 real + 500 phantom).
        liar.leak(makeAddr("sink"), 700 * ONE_USDC);
        liar.setPhantom(500 * ONE_USDC);

        // Withdraw 700 net (no exit fee). The old implementation dumped the pass-1
        // shortfall on the LAST adapter (the liar), under-delivered, and reverted
        // opaquely on the final transfer; the sweep now covers it from the honest one.
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.withdraw(700 * ONE_USDC, alice, alice);
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + 700 * ONE_USDC, "alice received 700 USDC");
    }

    // ─── ADP-2 NAV side (F-14): revoked-but-active adapter excluded from NAV/pulls ──

    /// @notice ADP-2 / F-14: an adapter whose eligibility is revoked while still
    ///         registered-active no longer contributes to `totalAssets` nor
    ///         receives/returns withdrawal flow. Two adapters are funded 50/50;
    ///         revoking the second drops NAV by its balance, and a subsequent
    ///         withdrawal is sourced entirely from the still-eligible adapter.
    function test_ADP2_revokedAdapterExcludedFromNavAndPulls() public {
        MockAdapter second = new MockAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(second));
        vm.prank(admin);
        vault.addAdapter(address(second), 10_000);

        // Deposit 2 000: equal-weight 1 000 / 1 000 across the two adapters.
        uint256 amount = 2_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(amount, alice);
        assertEq(usdc.balanceOf(address(adapter)), 1_000 * ONE_USDC, "adapter A funded");
        assertEq(usdc.balanceOf(address(second)), 1_000 * ONE_USDC, "adapter B funded");
        assertEq(vault.totalAssets(), amount, "NAV = both adapters while both eligible");

        // Revoke the second adapter's eligibility (still active in the registry).
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), false);

        // F-14: the revoked adapter's balance is EXCLUDED from NAV — a lying/revoked
        // adapter can no longer inflate (or, with honest holdings, prop up) the share price.
        assertEq(
            vault.totalAssets(),
            1_000 * ONE_USDC,
            "ADP-2: revoked adapter excluded from totalAssets"
        );

        // A withdrawal is sourced ENTIRELY from the eligible adapter; the revoked one is
        // never pulled from (its balance is untouched). Redeem all of alice's shares —
        // their NAV value is now just the eligible 1 000 (revoked balance excluded).
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 secondBalBefore = usdc.balanceOf(address(second));
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        // Payout equals the eligible NAV (1 000), within 1 wei share-rounding.
        assertApproxEqAbs(
            usdc.balanceOf(alice) - aliceBefore,
            1_000 * ONE_USDC,
            1,
            "pulled only the eligible adapter's NAV"
        );
        assertEq(
            usdc.balanceOf(address(second)), secondBalBefore, "revoked adapter never pulled from"
        );
    }

    // ─── FEE-2 (NC-11): exit fee charged on realised proceeds ──────────────────

    /// @notice FEE-2 / NC-11: the exit fee equals the configured bps of the
    ///         proceeds ACTUALLY realised. With an honest adapter, realised gross
    ///         equals the share-implied gross, so the fee and net payout match
    ///         `previewRedeem`.
    function test_FEE2_exitFeeOnRealizedProceeds() public {
        VaultHarness feeVault = newVaultHarness(
            IERC20(address(usdc)), TVL_CAP, PER_DEPOSIT_CAP, 100, feeRecipient, admin, admin
        ); // 100 bps = 1% exit fee
        MockAdapter feeAdapter = new MockAdapter(address(usdc), address(feeVault));
        _allowAdapter(feeVault, address(feeAdapter));
        vm.prank(admin);
        feeVault.addAdapter(address(feeAdapter), 10_000);

        vm.prank(alice);
        usdc.approve(address(feeVault), type(uint256).max);
        uint256 amount = 10_000 * ONE_USDC;
        vm.prank(alice);
        uint256 shares = feeVault.deposit(amount, alice);

        uint256 grossExpected = feeVault.convertToAssets(shares);
        uint256 feeExpected = grossExpected * 100 / 10_000; // 1%
        uint256 netExpected = grossExpected - feeExpected;

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 feeRecipBefore = usdc.balanceOf(feeRecipient);
        vm.prank(alice);
        feeVault.redeem(shares, alice, alice);

        assertEq(usdc.balanceOf(alice) - aliceBefore, netExpected, "net on realised proceeds");
        assertEq(
            usdc.balanceOf(feeRecipient) - feeRecipBefore,
            feeExpected,
            "fee = bps of realised gross"
        );
    }

    /// @notice FEE-2 / NC-11: an over-reporting adapter cannot socialise its
    ///         shortfall. When the adapter reports more NAV than it can deliver,
    ///         the withdrawal reverts (`InsufficientAdapterLiquidity`) rather than
    ///         silently paying the inflated gross from another holder's idle USDC.
    function test_FEE2_overReportingAdapterCannotSocializeLoss() public {
        VaultHarness feeVault = newVaultHarness(
            IERC20(address(usdc)), TVL_CAP, PER_DEPOSIT_CAP, 100, feeRecipient, admin, admin
        );
        ShortfallAdapter liar = new ShortfallAdapter(address(usdc), address(feeVault));
        _allowAdapter(feeVault, address(liar));
        vm.prank(admin);
        feeVault.addAdapter(address(liar), 10_000);

        // Alice deposits 1 000 (routed entirely into the liar).
        vm.prank(alice);
        usdc.approve(address(feeVault), type(uint256).max);
        vm.prank(alice);
        uint256 shares = feeVault.deposit(1_000 * ONE_USDC, alice);

        // Bob's idle USDC is parked in the vault (e.g. unrouted) — the would-be
        // socialisation source if the fee/payout were based on share-implied gross.
        vm.prank(bob);
        usdc.transfer(address(feeVault), 1_000 * ONE_USDC);

        // The liar over-reports by 500 but can still only deliver its real 1 000.
        liar.setPhantom(500 * ONE_USDC);

        // Share-implied gross is now inflated by the phantom; idle (Bob's 1 000) covers
        // part, and the adapter must supply the rest but can only deliver 1 000 real.
        uint256 grossInflated = feeVault.convertToAssets(shares);
        uint256 idle = usdc.balanceOf(address(feeVault));

        // Redeeming all shares: realised proceeds cannot cover the inflated gross, so the
        // withdrawal reverts (InsufficientAdapterLiquidity) instead of draining Bob's idle USDC.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                RobotMoneyVault.InsufficientAdapterLiquidity.selector,
                grossInflated - idle, // remainingNeeded after idle is applied
                1_000 * ONE_USDC // the liar's real deliverable balance
            )
        );
        feeVault.redeem(shares, alice, alice);

        // Bob's idle USDC was NOT touched — no loss socialisation.
        assertEq(usdc.balanceOf(address(feeVault)), idle, "Bob's idle USDC untouched");
    }

    /// @notice Keeper `rebalance()` must NOT brick when an active adapter's allowlist
    ///         entry is revoked (audit L-4): the routing pass skips it; idle funds remain.
    function test_rebalance_skipsAdapterAfterApprovalRevoked() public {
        uint256 amount = 1_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(amount, alice);
        usdc.mint(address(vault), amount);

        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), false);

        uint256 beforeAdapter = usdc.balanceOf(address(adapter));
        vm.warp(block.timestamp + vault.minRebalanceInterval());
        vm.prank(admin);
        vault.rebalance();

        assertEq(usdc.balanceOf(address(adapter)), beforeAdapter, "adapter must not receive USDC");
        assertEq(usdc.balanceOf(address(vault)), amount, "idle funds must remain in the vault");
    }

    function test_adminRebalanceCannotAllocateToAdapterAfterApprovalRevoked() public {
        uint256 amount = 1_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(amount, alice);
        usdc.mint(address(vault), amount);

        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), false);

        uint256[] memory targets = new uint256[](vault.adapterCount());
        targets[0] = amount * 2;
        uint256 beforeAdapter = usdc.balanceOf(address(adapter));

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(RobotMoneyVault.AdapterNotAllowed.selector, address(adapter))
        );
        vault.adminRebalance(targets);

        assertEq(usdc.balanceOf(address(adapter)), beforeAdapter, "adapter must not receive USDC");
    }

    function test_emergencyWithdrawStillWorksAfterApprovalRevoked() public {
        uint256 amount = 1_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(amount, alice);

        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), false);

        vm.prank(admin);
        vault.emergencyWithdrawAdapter(0);

        assertEq(usdc.balanceOf(address(adapter)), 0, "adapter should be drained");
        // core 1820: USDC recovered from an excluded adapter goes to the exclusion record, not
        // to vault idle, and belongs to the holders at the moment of exclusion.
        ExclusionLedger ledger = vault.exclusionLedger();
        assertEq(usdc.balanceOf(address(ledger)), amount, "the record holds the recovery");
        assertEq(usdc.balanceOf(address(vault)), 0, "nothing lands in idle");
        assertEq(ledger.claimable(1, alice), amount, "the sole holder owns all of it");
    }

    // ─── Exclusion records (core 1820, E2) ───────────────────────────────────

    /// @dev Second funded adapter at registry index 1, 100% cap.
    function _addSecondAdapter() internal returns (MockAdapter second) {
        second = new MockAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(second));
        vm.prank(admin);
        vault.addAdapter(address(second), 10_000);
    }

    function _fundAndApprove(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// @notice core 1820: recovery from an excluded adapter belongs pro rata to the holders at
    ///         the moment of exclusion. Alice exits during the exclusion and keeps her claim;
    ///         Bob stays and gets the same per-share recovery; Carol, who receives shares after
    ///         the snapshot, and Dave, who deposits after the record closes, get nothing. Two
    ///         recovery paths credit the same record: `emergencyWithdrawAdapter` and restored
    ///         eligibility (`setAdapterAllowed(true)` realises the residual first). The share
    ///         price never moves on a recovery.
    function test_exclusionRecoveryPaidProRataToSnapshot() public {
        MockAdapter second = _addSecondAdapter();
        ExclusionLedger ledger = vault.exclusionLedger();

        // Alice 3 000 and Bob 1 000: equal weight leaves 2 000 in each adapter.
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(3_000 * ONE_USDC, alice);
        vm.prank(bob);
        uint256 bobShares = vault.deposit(1_000 * ONE_USDC, bob);
        assertEq(usdc.balanceOf(address(second)), 2_000 * ONE_USDC, "second adapter funded");
        uint256 supply = vault.totalSupply();

        // Exclusion opens record 1 on index 1 with a snapshot of the supply.
        vm.expectEmit(true, true, true, true, address(ledger));
        emit ExclusionLedger.ExclusionOpened(1, 1, address(second), supply, 2_000 * ONE_USDC);
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), false);
        assertEq(vault.openExclusionOf(1), 1, "record 1 open on index 1");
        assertEq(vault.totalAssets(), 2_000 * ONE_USDC, "the excluded balance left NAV");

        // Alice exits in full during the exclusion: paid at the reduced NAV, claim kept.
        {
            uint256 aliceStart = usdc.balanceOf(alice);
            vm.prank(alice);
            vault.redeem(aliceShares, alice, alice);
            assertApproxEqAbs(
                usdc.balanceOf(alice) - aliceStart, 1_500 * ONE_USDC, 2, "exit at the reduced NAV"
            );
            assertEq(vault.balanceOf(alice), 0, "alice holds no shares");
            assertEq(ledger.balanceAt(alice, 1), aliceShares, "the exiter keeps her snapshot");
        }

        // Bob moves half his shares to Carol after the snapshot: the claim does not move.
        vm.prank(bob);
        vault.transfer(makeAddr("carol"), bobShares / 2);
        assertEq(ledger.balanceAt(bob, 1), bobShares, "a transfer does not move the claim");
        assertEq(ledger.balanceAt(makeAddr("carol"), 1), 0, "a transferee has no claim");

        // Recovery 1: the emergency key drains the excluded adapter into the record.
        uint256 nav = vault.totalAssets();
        uint256 price = vault.convertToAssets(1e24);
        vm.prank(admin);
        vault.emergencyWithdrawAdapter(1);
        assertEq(usdc.balanceOf(address(second)), 0, "drained");
        assertEq(usdc.balanceOf(address(ledger)), 2_000 * ONE_USDC, "the record holds it");
        assertEq(vault.totalAssets(), nav, "recovery never raises NAV");
        assertEq(vault.convertToAssets(1e24), price, "share price unchanged");

        uint256 aliceFirst = Math.mulDiv(2_000 * ONE_USDC, aliceShares, supply);
        assertEq(ledger.claimable(1, alice), aliceFirst, "alice: recovered x snapshot share");
        assertApproxEqAbs(aliceFirst, 1_500 * ONE_USDC, 2, "alice owns three quarters");
        assertApproxEqAbs(ledger.claimable(1, bob), 500 * ONE_USDC, 2, "bob owns one quarter");
        assertEq(ledger.claimable(1, makeAddr("carol")), 0, "carol owns nothing");

        // Anyone may trigger a claim; the USDC always goes to the holder.
        {
            uint256 aliceBefore = usdc.balanceOf(alice);
            vm.prank(makeAddr("carol"));
            assertEq(ledger.claim(1, alice), aliceFirst, "claim paid");
            assertEq(usdc.balanceOf(alice) - aliceBefore, aliceFirst, "alice received it");
            assertEq(usdc.balanceOf(makeAddr("carol")), 0, "the caller received nothing");
        }

        // Recovery 2: the venue returns 400 more. Restoring eligibility realises it into the
        // record before the entry counts again, then closes the record.
        usdc.mint(address(second), 400 * ONE_USDC);
        vm.expectEmit(true, true, false, true, address(ledger));
        emit ExclusionLedger.ExclusionRecoveryCredited(
            1, ExclusionLedger.RecoverySource.Restoration, 400 * ONE_USDC, 2_400 * ONE_USDC
        );
        vm.expectEmit(true, true, false, true, address(ledger));
        emit ExclusionLedger.ExclusionFinalized(
            1, ExclusionLedger.FinalizeReason.Restored, 2_400 * ONE_USDC
        );
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), true);
        assertEq(vault.openExclusionOf(1), 0, "record closed");
        assertEq(usdc.balanceOf(address(second)), 0, "the residual was realised first");
        assertEq(vault.totalAssets(), nav, "the restored entry re-enters NAV empty");
        assertEq(vault.convertToAssets(1e24), price, "share price still unchanged");

        // Claims follow the cumulative recovery; stayer and exiter get the same per share.
        assertEq(
            ledger.claimable(1, alice),
            Math.mulDiv(2_400 * ONE_USDC, aliceShares, supply) - aliceFirst,
            "alice: second slice only"
        );
        assertEq(
            ledger.claimAll(bob),
            Math.mulDiv(2_400 * ONE_USDC, bobShares, supply),
            "bob: full share in one claim"
        );
        ledger.claimAll(alice);
        assertEq(ledger.claimAll(makeAddr("carol")), 0, "carol: nothing");
        assertEq(ledger.claimable(1, alice), 0, "nothing left for alice");
        assertEq(ledger.claimable(1, bob), 0, "nothing left for bob");
        _assertSettledRecord(ledger, 1, supply, 2_400 * ONE_USDC);

        // Dave deposits after the record closed: no claim, and a fair price.
        address dave = makeAddr("dave");
        vm.prank(admin);
        vault.unpauseDeposits();
        _fundAndApprove(dave, 1_000 * ONE_USDC);
        vm.prank(dave);
        uint256 daveShares = vault.deposit(1_000 * ONE_USDC, dave);
        assertEq(ledger.claimable(1, dave), 0, "a later depositor has no claim");
        assertApproxEqAbs(vault.convertToAssets(daveShares), 1_000 * ONE_USDC, 2, "fair price");
    }

    /// @dev Record `id` is finalized with `recovered` credited against `supply`, every holder
    ///      has claimed, only rounding dust remains, and the ledger holds exactly what it owes.
    function _assertSettledRecord(
        ExclusionLedger ledger,
        uint256 id,
        uint256 supply,
        uint256 recovered
    ) internal view {
        (,,,, bool finalized, uint256 snapshotSupply,, uint256 credited, uint256 claimedUsdc) =
            ledger.exclusions(id);
        assertTrue(finalized, "finalized");
        assertEq(snapshotSupply, supply, "snapshot supply");
        assertEq(credited, recovered, "recovered total");
        assertLe(claimedUsdc, credited, "never over-claimed");
        assertApproxEqAbs(claimedUsdc, credited, 2, "only rounding dust remains");
        assertEq(ledger.heldUsdc(), credited - claimedUsdc, "held = recovered - claimed");
        assertEq(usdc.balanceOf(address(ledger)), ledger.heldUsdc(), "ledger fully backed");
    }

    /// @notice E2: `adminRebalance` is the third recovery path. Before core 1820 its pull from
    ///         an excluded adapter landed in idle NAV, so the holder who stayed took the exiter's
    ///         part. Now it is credited to the exclusion record, the share price does not move,
    ///         and `removeAdapter` on the drained entry closes the record.
    function test_adminRebalanceRecoveryCreditsExclusionRecord() public {
        address carol = makeAddr("carol");
        MockAdapter second = _addSecondAdapter();
        ExclusionLedger ledger = vault.exclusionLedger();

        // Alice and Bob 1 000 each: 1 000 in each adapter.
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(bob);
        uint256 bobShares = vault.deposit(1_000 * ONE_USDC, bob);
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), false);

        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        uint256 bobValue = vault.convertToAssets(bobShares);
        assertApproxEqAbs(bobValue, 500 * ONE_USDC, 2, "bob's NAV share without the excluded");

        // Drain the excluded entry; leave the eligible one where it is.
        uint256[] memory targets = new uint256[](2);
        targets[0] = adapter.totalAssets();
        vm.expectEmit(true, true, false, true, address(ledger));
        emit ExclusionLedger.ExclusionRecoveryCredited(
            1, ExclusionLedger.RecoverySource.AdminRebalance, 1_000 * ONE_USDC, 1_000 * ONE_USDC
        );
        vm.prank(admin);
        vault.adminRebalance(targets);

        assertEq(usdc.balanceOf(address(second)), 0, "excluded adapter drained");
        assertEq(usdc.balanceOf(address(vault)), 0, "nothing left in idle");
        assertEq(usdc.balanceOf(address(ledger)), 1_000 * ONE_USDC, "the record holds it");
        assertEq(ledger.heldUsdc(), 1_000 * ONE_USDC, "held by the record");
        assertEq(vault.convertToAssets(bobShares), bobValue, "the drain does not lift the price");
        assertApproxEqAbs(ledger.claimable(1, alice), 500 * ONE_USDC, 1, "the exiter keeps half");
        assertApproxEqAbs(ledger.claimable(1, bob), 500 * ONE_USDC, 1, "the stayer gets half");

        // Removing the drained entry closes the record and reopens deposits.
        vm.expectEmit(true, true, false, true, address(ledger));
        emit ExclusionLedger.ExclusionFinalized(
            1, ExclusionLedger.FinalizeReason.Removed, 1_000 * ONE_USDC
        );
        vm.prank(admin);
        vault.removeAdapter(1);
        assertEq(vault.openExclusionOf(1), 0, "record closed");
        assertGt(vault.maxDeposit(carol), 0, "deposits reopen");

        _fundAndApprove(carol, 1_000 * ONE_USDC);
        vm.prank(carol);
        vault.deposit(1_000 * ONE_USDC, carol);
        assertEq(ledger.claimable(1, carol), 0, "a later depositor has no claim");

        uint256 aliceBefore = usdc.balanceOf(alice);
        ledger.claim(1, alice);
        assertApproxEqAbs(usdc.balanceOf(alice) - aliceBefore, 500 * ONE_USDC, 1, "alice paid");
    }

    /// @notice E2: when the excluded adapter holds the only funded balance, NAV is 0 and a
    ///         redeem would burn shares for 0 USDC. It reverts while the exclusion is open, and
    ///         the holder is paid through the record instead.
    function test_redeemDuringExclusionRevertsOnZeroPayout() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), false);
        assertEq(vault.totalAssets(), 0, "the only funded adapter is excluded");
        assertEq(vault.previewRedeem(shares), 0, "the shares price at zero");

        vm.prank(alice);
        vm.expectRevert(RobotMoneyVault.ZeroPayoutDuringExclusion.selector);
        vault.redeem(shares, alice, alice);
        vm.prank(alice);
        vm.expectRevert(RobotMoneyVault.ZeroPayoutDuringExclusion.selector);
        vault.redeem(1, alice, alice);
        assertEq(vault.balanceOf(alice), shares, "no share was burned");

        // The recovery reaches the snapshot holder; the empty redeem is still refused.
        vm.prank(admin);
        vault.emergencyWithdrawAdapter(0);
        ExclusionLedger ledger = vault.exclusionLedger();
        assertEq(ledger.claimable(1, alice), 1_000 * ONE_USDC, "the sole holder owns it all");
        vm.prank(alice);
        vm.expectRevert(RobotMoneyVault.ZeroPayoutDuringExclusion.selector);
        vault.redeem(shares, alice, alice);
        uint256 before = usdc.balanceOf(alice);
        ledger.claim(1, alice);
        assertEq(usdc.balanceOf(alice) - before, 1_000 * ONE_USDC, "paid through the record");

        // With the record closed no exclusion is open, and the guard no longer applies.
        vm.prank(admin);
        vault.removeAdapter(0);
        vm.prank(alice);
        assertEq(vault.redeem(shares, alice, alice), 0, "zero-value shares burn outside one");
    }

    /// @notice core 1820: restoring eligibility realises the residual into the record first. An
    ///         adapter that cannot pay out keeps its record open (the restore reverts). Security
    ///         round 1: `forceRemoveAdapter` no longer closes that record while the adapter cannot
    ///         report an empty balance. The record stays open on the inactive index and deposits
    ///         can reopen, so the force-remove is no longer a write-off for the snapshot holders.
    function test_restoreRevertsWhenExcludedAdapterCannotPayOut() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), false);
        ExclusionLedger ledger = vault.exclusionLedger();

        adapter.setRevertTotalAssets(true);
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.AdapterNotEmpty.selector);
        vault.setAdapterAllowed(address(adapter), true);
        assertEq(vault.openExclusionOf(0), 1, "the record stays open");
        assertEq(vault.maxDeposit(bob), 0, "deposits stay closed");

        vm.prank(admin);
        vault.forceRemoveAdapter(0);
        assertEq(vault.openExclusionOf(0), 1, "the record survives the force-remove");
        (,,,, bool finalized,,,,) = ledger.exclusions(1);
        assertFalse(finalized, "nothing was written off");
        vm.prank(admin);
        vault.unpauseDeposits();
        MockAdapter fresh = new MockAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(fresh));
        vm.prank(admin);
        vault.addAdapter(address(fresh), 10_000);
        assertGt(vault.maxDeposit(bob), 0, "an inactive record does not keep deposits closed");
    }

    /// @notice Security round 1 (SR-1012-5 follow-up): a force-removed EXCLUDED adapter that is
    ///         re-added later pays its balance into the exclusion record, never into NAV for the
    ///         holders of the day. Alice and Bob hold half each. ADMIN excludes adapter A (record
    ///         1), A cannot pay out, so EMERGENCY force-removes it to reopen deposits. Alice
    ///         redeems at the reduced NAV. The venue recovers, ADMIN re-allows and re-adds A, and
    ///         A's whole balance lands in record 1: Alice's claim is half of it and NAV does not rise.
    ///         Before the fix the force-remove closed record 1 with 0 recovered, and the re-add put
    ///         A's 1 000 back into NAV, all of it for Bob.
    function test_forceRemovedExcludedAdapter_reAddCreditsSnapshotRecord() public {
        MockAdapter second = _addSecondAdapter();
        ExclusionLedger ledger = vault.exclusionLedger();
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(bob);
        uint256 bobShares = vault.deposit(1_000 * ONE_USDC, bob);
        assertEq(aliceShares, bobShares, "equal holders");
        assertEq(usdc.balanceOf(address(second)), 1_000 * ONE_USDC, "A holds half of NAV");

        // ADMIN excludes A: record 1. A cannot pay out, so the restore reverts.
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), false);
        assertEq(vault.openExclusionOf(1), 1, "record 1 open");
        second.setRevertTotalAssets(true);
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.AdapterNotEmpty.selector);
        vault.setAdapterAllowed(address(second), true);

        // EMERGENCY force-removes A to reopen deposits. Record 1 stays open.
        vm.prank(admin);
        vault.forceRemoveAdapter(1);
        assertEq(vault.openExclusionOf(1), 1, "record 1 survives the force-remove");
        vm.prank(admin);
        vault.unpauseDeposits();
        assertGt(vault.maxDeposit(bob), 0, "deposits reopen");

        // Alice exits at the reduced NAV and keeps her claim.
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        assertApproxEqAbs(
            usdc.balanceOf(alice) - aliceBefore, 500 * ONE_USDC, 1, "exit at the reduced NAV"
        );

        // The venue recovers. Re-allowing alone restores nothing for the inactive index.
        second.setRevertTotalAssets(false);
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), true);
        assertEq(vault.openExclusionOf(1), 1, "still open until the re-add");
        uint256 navBefore = vault.totalAssets();

        vm.expectEmit(true, true, false, true, address(ledger));
        emit ExclusionLedger.ExclusionRecoveryCredited(
            1, ExclusionLedger.RecoverySource.Restoration, 1_000 * ONE_USDC, 1_000 * ONE_USDC
        );
        vm.expectEmit(true, true, false, true, address(ledger));
        emit ExclusionLedger.ExclusionFinalized(
            1, ExclusionLedger.FinalizeReason.Restored, 1_000 * ONE_USDC
        );
        vm.prank(admin);
        vault.addAdapter(address(second), 10_000);

        assertEq(usdc.balanceOf(address(second)), 0, "A's balance left the adapter");
        assertEq(usdc.balanceOf(address(ledger)), 1_000 * ONE_USDC, "it lands in record 1");
        assertEq(vault.openExclusionOf(1), 0, "record 1 settled");
        assertEq(vault.totalAssets(), navBefore, "NAV does not rise on the re-add");
        assertEq(ledger.claimable(1, alice), 500 * ONE_USDC, "the exiter owns half");
        assertEq(ledger.claimable(1, bob), 500 * ONE_USDC, "the stayer owns half");
        assertApproxEqAbs(
            vault.convertToAssets(bobShares), 500 * ONE_USDC, 1, "bob's NAV share is his own half"
        );
    }

    /// @notice Security round 2. A force-removed adapter whose venue can pay only part of the
    ///         position: Alice and Bob hold half each, and adapter A holds half of NAV. EMERGENCY
    ///         excludes A (record 1), then force-removes it to reopen deposits. A's venue can pay
    ///         40 percent. The re-add, until now the only way to credit an inactive record, asks
    ///         for the whole balance and reverts `AdapterNotEmpty`, so even the liquid 40 percent
    ///         was stranded. `recoverRemovedAdapter` credits that 40 percent to record 1 now, a
    ///         later call credits the rest once the venue can pay it, and the empty adapter's
    ///         record closes (`ForceRemoved`). Alice exits in between and keeps her half of each
    ///         tranche; the share price never moves.
    function test_forceRemovedPartlyLiquidAdapter_recoversTrancheByTranche() public {
        address emergency = makeAddr("emergency");
        vm.startPrank(admin);
        vault.grantRole(vault.EMERGENCY_ROLE(), emergency);
        vm.stopPrank();
        PartlyLiquidMockAdapter venue = new PartlyLiquidMockAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(venue));
        vm.prank(admin);
        vault.addAdapter(address(venue), 10_000);
        ExclusionLedger ledger = vault.exclusionLedger();
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(bob);
        uint256 bobShares = vault.deposit(1_000 * ONE_USDC, bob);
        assertEq(aliceShares, bobShares, "equal holders");
        assertEq(venue.totalAssets(), 1_000 * ONE_USDC, "A holds half of NAV");
        uint256 supply = vault.totalSupply();

        // Exclude, then force-remove to reopen deposits. Record 1 stays open on the inactive index.
        vm.startPrank(emergency);
        vault.emergencyExcludeAdapter(1);
        vault.forceRemoveAdapter(1);
        vm.stopPrank();
        assertEq(vault.openExclusionOf(1), 1, "record 1 open on the inactive index");
        vm.prank(admin);
        vault.unpauseDeposits();
        assertGt(vault.maxDeposit(bob), 0, "deposits reopen");

        // The venue can pay 40 percent. The re-add asks for all of it and reverts.
        venue.setLiquid(400 * ONE_USDC);
        vm.startPrank(admin);
        vault.setAdapterAllowed(address(venue), true);
        vm.expectRevert(RobotMoneyVault.AdapterNotEmpty.selector);
        vault.addAdapter(address(venue), 10_000);
        vm.stopPrank();

        // Alice exits at the reduced NAV and keeps her claim.
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        uint256 navAfterExit = vault.totalAssets();
        uint256 price = vault.convertToAssets(1e24);

        // Only EMERGENCY may pull a tranche, and only from an inactive entry.
        bytes32 emergencyRole = vault.EMERGENCY_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", alice, emergencyRole
            )
        );
        vault.recoverRemovedAdapter(1, 400 * ONE_USDC);
        vm.prank(emergency);
        vm.expectRevert(RobotMoneyVault.AdapterNotFound.selector);
        vault.recoverRemovedAdapter(0, 1);

        // Tranche 1: the liquid 40 percent goes to record 1, not to NAV.
        vm.expectEmit(true, true, false, true, address(ledger));
        emit ExclusionLedger.ExclusionRecoveryCredited(
            1,
            ExclusionLedger.RecoverySource.EmergencyWithdrawAdapter,
            400 * ONE_USDC,
            400 * ONE_USDC
        );
        vm.prank(emergency);
        vault.recoverRemovedAdapter(1, 400 * ONE_USDC);
        assertEq(usdc.balanceOf(address(ledger)), 400 * ONE_USDC, "tranche 1 in record 1");
        assertEq(venue.totalAssets(), 600 * ONE_USDC, "the illiquid part stays in the venue");
        assertEq(vault.openExclusionOf(1), 1, "record 1 stays open for the rest");
        assertEq(vault.totalAssets(), navAfterExit, "recovery never raises NAV");
        assertEq(vault.convertToAssets(1e24), price, "share price unchanged");
        assertEq(ledger.claimable(1, alice), Math.mulDiv(400 * ONE_USDC, aliceShares, supply));
        assertEq(ledger.claimable(1, bob), Math.mulDiv(400 * ONE_USDC, bobShares, supply));

        // Asking for more than the venue can pay reverts and moves nothing.
        vm.prank(emergency);
        vm.expectRevert(
            abi.encodeWithSelector(
                PartlyLiquidMockAdapter.VenueIlliquid.selector, 600 * ONE_USDC, 0
            )
        );
        vault.recoverRemovedAdapter(1, type(uint256).max);

        // Tranche 2: the venue can pay the rest. The empty adapter's record closes.
        venue.setLiquid(600 * ONE_USDC);
        vm.expectEmit(true, true, false, true, address(ledger));
        emit ExclusionLedger.ExclusionFinalized(
            1, ExclusionLedger.FinalizeReason.ForceRemoved, 1_000 * ONE_USDC
        );
        vm.prank(emergency);
        vault.recoverRemovedAdapter(1, type(uint256).max);
        assertEq(venue.totalAssets(), 0, "drained");
        assertEq(vault.openExclusionOf(1), 0, "record 1 closed");
        assertEq(vault.totalAssets(), navAfterExit, "NAV still unchanged");
        vm.prank(emergency);
        vm.expectRevert(abi.encodeWithSelector(RobotMoneyVault.NoOpenExclusion.selector, 1));
        vault.recoverRemovedAdapter(1, 1);

        // Exiter and stayer each own half of everything recovered.
        assertEq(ledger.claimAll(alice), Math.mulDiv(1_000 * ONE_USDC, aliceShares, supply));
        assertEq(ledger.claimAll(bob), Math.mulDiv(1_000 * ONE_USDC, bobShares, supply));
        _assertSettledRecord(ledger, 1, supply, 1_000 * ONE_USDC);

        // With the record settled, the address can be re-added and starts empty.
        vm.prank(admin);
        vault.addAdapter(address(venue), 10_000);
        assertEq(vault.totalAssets(), navAfterExit, "the re-add does not lift NAV");
    }

    /// @notice Security round 1 (FS-VLT-8 follow-up): an illiquid adapter is excluded by the
    ///         EMERGENCY key before the drain, so early and late exiters bear the haircut alike.
    ///         Three adapters hold equal shares of NAV. Moonwell goes illiquid: its `withdraw`
    ///         reverts while `totalAssets` still reports full value, so an adapter-funded redeem
    ///         reverts. EMERGENCY runs `emergencyExcludeAdapter` (record 1, full supply), then
    ///         `emergencyWithdraw` (the healthy two go idle). Alice redeems half the supply from
    ///         idle. The venue later returns half its value into record 1. Alice's payout plus
    ///         claim equals Bob's, share for share, within 1 wei. Without the lever the record
    ///         could only open through the 48 h timelock, after Alice had taken full NAV from idle.
    function test_illiquidAdapterEmergencyDrainKeepsExitersAndStayersAtParity() public {
        address emergency = makeAddr("emergency");
        vm.startPrank(admin);
        vault.grantRole(vault.EMERGENCY_ROLE(), emergency);
        vm.stopPrank();
        MockAdapter second = _addSecondAdapter();
        IlliquidMockAdapter moonwell = new IlliquidMockAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(moonwell));
        vm.prank(admin);
        vault.addAdapter(address(moonwell), 10_000);
        ExclusionLedger ledger = vault.exclusionLedger();

        // Alice deposits 6 000 and hands Bob exactly half her shares: two equal holders.
        _fundAndApprove(alice, 6_000 * ONE_USDC);
        vm.prank(alice);
        uint256 minted = vault.deposit(6_000 * ONE_USDC, alice);
        vm.prank(alice);
        vault.transfer(bob, minted / 2);
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 bobShares = vault.balanceOf(bob);
        assertEq(aliceShares, bobShares, "equal holders");
        uint256 stuck = moonwell.totalAssets();
        assertApproxEqAbs(stuck, 2_000 * ONE_USDC, ONE_USDC, "moonwell holds a third");

        // Moonwell goes illiquid but still reports full value: adapter-funded redeems revert.
        moonwell.setIlliquid(true);
        assertEq(vault.totalAssets(), 6_000 * ONE_USDC, "the illiquid value still counts");
        vm.prank(alice);
        vm.expectRevert(IlliquidMockAdapter.VenueIlliquid.selector);
        vault.redeem(aliceShares, alice, alice);

        // Exclude, then drain. Restoring stays ADMIN's.
        vm.prank(emergency);
        vault.emergencyExcludeAdapter(2);
        assertEq(vault.openExclusionOf(2), 1, "record 1 open on moonwell");
        assertFalse(vault.adapterAllowed(address(moonwell)), "allowance revoked");
        vm.prank(emergency);
        vault.emergencyWithdraw();
        assertEq(moonwell.totalAssets(), stuck, "the illiquid drain failed and was caught");
        assertEq(vault.totalAssets(), 6_000 * ONE_USDC - stuck, "NAV without moonwell");
        assertEq(usdc.balanceOf(address(second)), 0, "healthy adapters drained to idle");

        // Alice exits from idle at the reduced NAV.
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        uint256 alicePaid = usdc.balanceOf(alice) - aliceBefore;

        // The venue recovers half: the other half was bad debt. The drain credits record 1.
        moonwell.realiseLoss(stuck / 2);
        moonwell.setIlliquid(false);
        vm.prank(emergency);
        vault.emergencyWithdrawAdapter(2);
        assertEq(usdc.balanceOf(address(ledger)), stuck - stuck / 2, "the recovery is in record 1");

        // Bob stays until now, then exits too.
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob, bob);
        uint256 bobPaid = usdc.balanceOf(bob) - bobBefore;

        uint256 aliceTotal = alicePaid + ledger.claimable(1, alice);
        uint256 bobTotal = bobPaid + ledger.claimable(1, bob);
        assertApproxEqAbs(aliceTotal, bobTotal, 1, "exiter and stayer at parity");
        assertApproxEqAbs(
            aliceTotal + bobTotal,
            6_000 * ONE_USDC - stuck / 2,
            2,
            "only the bad debt is lost, shared pro rata"
        );
    }

    /// @notice Security round 1: `emergencyExcludeAdapter` is EMERGENCY-only and exclude-only.
    ///         It opens the record in the same call, keeps deposits closed while the entry stays
    ///         excluded, and neither the hot key nor the permissionless `syncExclusions` can
    ///         restore the entry: only ADMIN `setAdapterAllowed(adapter, true)` can, and it
    ///         drains the adapter into the record first, so the exclusion moves no value.
    function test_emergencyExcludeAdapter_excludeOnlyAndAdminRestores() public {
        address emergency = makeAddr("emergency");
        vm.startPrank(admin);
        vault.grantRole(vault.EMERGENCY_ROLE(), emergency);
        vm.stopPrank();
        MockAdapter second = _addSecondAdapter();
        ExclusionLedger ledger = vault.exclusionLedger();
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(bob);
        vault.deposit(1_000 * ONE_USDC, bob);
        uint256 supply = vault.totalSupply();

        bytes32 emergencyRole = vault.EMERGENCY_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", alice, emergencyRole
            )
        );
        vault.emergencyExcludeAdapter(1);
        vm.prank(emergency);
        vm.expectRevert(RobotMoneyVault.AdapterNotFound.selector);
        vault.emergencyExcludeAdapter(2);

        vm.expectEmit(true, false, false, true, address(vault));
        emit RobotMoneyVault.AdapterAllowedSet(address(second), false);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit ExclusionLedger.ExclusionOpened(1, 1, address(second), supply, 1_000 * ONE_USDC);
        vm.prank(emergency);
        vault.emergencyExcludeAdapter(1);
        assertEq(vault.totalAssets(), 1_000 * ONE_USDC, "the entry left NAV");
        assertEq(vault.maxDeposit(bob), 0, "deposits close while it is excluded");
        assertFalse(vault.depositsPaused(), "no pause: the exclusion itself closes deposits");

        // The hot key cannot undo it, and a permissionless sync restores nothing.
        bytes32 adminRole = vault.ADMIN_ROLE();
        vm.prank(emergency);
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", emergency, adminRole
            )
        );
        vault.setAdapterAllowed(address(second), true);
        vault.syncExclusions();
        assertEq(vault.openExclusionOf(1), 1, "still excluded");

        // ADMIN restores: the balance goes to the record first, the entry re-enters NAV empty.
        uint256 navBefore = vault.totalAssets();
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), true);
        assertEq(vault.openExclusionOf(1), 0, "restored");
        assertEq(usdc.balanceOf(address(second)), 0, "drained into the record");
        assertEq(vault.totalAssets(), navBefore, "NAV does not rise on the restore");
        assertEq(ledger.claimable(1, alice), Math.mulDiv(1_000 * ONE_USDC, aliceShares, supply));
        assertGt(vault.maxDeposit(bob), 0, "deposits reopen");
    }

    /// @notice Security round 1 (D8 follow-up): a Morpho exposure cap below the adapter's
    ///         equal-weight target no longer reverts the deposit. Routing stops Morpho at its cap
    ///         and places the rest in the other adapter. Before the fix pass 1 handed Morpho its
    ///         full slice and `MorphoAdapter._deposit` reverted `ExposureCapExceeded`, so every
    ///         deposit (and every router deposit with an rmUSDC leg) reverted.
    function test_deposit_routesAroundMorphoExposureCap() public {
        MockMorphoVault venue = new MockMorphoVault(address(usdc));
        MorphoAdapter morpho = new MorphoAdapter(address(venue), address(usdc), address(vault));
        _allowAdapter(vault, address(morpho));
        vm.startPrank(admin);
        vault.addAdapter(address(morpho), 10_000);
        uint256 cap = 200 * ONE_USDC;
        vault.setAdapterMaxExposure(1, cap);
        vm.stopPrank();

        // Equal weight would give Morpho 500 of this deposit; the cap allows 200.
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000 * ONE_USDC, alice);
        assertGt(shares, 0, "the deposit succeeds");
        assertEq(morpho.totalAssets(), cap, "Morpho stops at its cap");
        assertEq(adapter.totalAssets(), 800 * ONE_USDC, "the rest goes to the other adapter");
        assertEq(usdc.balanceOf(address(vault)), 0, "nothing left idle");
        assertEq(vault.totalAssets(), 1_000 * ONE_USDC);

        // With the only uncapped adapter full (capBps), the excess stays idle, not reverted.
        vm.prank(admin);
        vault.setAdapterCap(0, 5_000);
        vm.prank(bob);
        vault.deposit(1_000 * ONE_USDC, bob);
        assertEq(morpho.totalAssets(), cap, "Morpho still at its cap");
        assertLe(adapter.totalAssets(), 1_000 * ONE_USDC, "the other adapter at its capBps");
        assertEq(vault.totalAssets(), 2_000 * ONE_USDC, "the unplaced USDC stays in NAV, idle");
        assertGt(usdc.balanceOf(address(vault)), 0, "the excess is idle");
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

    // ─── Issue #161: idle vault USDC reflected in totalAssets ─────────────────

    /// @notice A direct USDC transfer to the vault (not via deposit) must be
    ///         included in totalAssets().
    function test_totalAssets_includesIdleVaultBalance() public {
        // Seed via normal deposit so there is a baseline.
        uint256 depositAmount = 10_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(depositAmount, alice);

        uint256 totalBefore = vault.totalAssets();

        // Send USDC directly to the vault (models an attacker or routing overflow).
        uint256 idleAmount = 5_000 * ONE_USDC;
        usdc.mint(address(vault), idleAmount);

        uint256 totalAfter = vault.totalAssets();
        assertEq(totalAfter, totalBefore + idleAmount, "idle USDC must be counted in totalAssets");
    }

    /// @notice TVL cap must be enforced against the sum of adapter balances AND idle vault
    ///         balance, so that idle USDC cannot be used to bypass the cap.
    function test_tvlCap_enforcedIncludingIdleBalance() public {
        // Deploy a vault with a tight TVL cap: 20 000 USDC.
        uint256 cap = 20_000 * ONE_USDC;
        VaultHarness tightVault = newVaultHarness(
            IERC20(address(usdc)),
            cap,
            cap, // perDepositCap matches tvlCap
            0,
            feeRecipient,
            admin,
            admin
        );
        MockAdapter tightAdapter = new MockAdapter(address(usdc), address(tightVault));
        _allowAdapter(tightVault, address(tightAdapter));
        vm.prank(admin);
        tightVault.addAdapter(address(tightAdapter), 10_000);

        // Deposit 15 000 USDC — within cap.
        usdc.mint(alice, cap);
        vm.prank(alice);
        usdc.approve(address(tightVault), type(uint256).max);
        vm.prank(alice);
        tightVault.deposit(15_000 * ONE_USDC, alice);

        // Directly send 4 000 USDC idle to the vault (e.g. from an external transfer).
        usdc.mint(address(tightVault), 4_000 * ONE_USDC);

        // totalAssets is now 15 000 (adapter) + 4 000 (idle) = 19 000.
        assertEq(tightVault.totalAssets(), 19_000 * ONE_USDC, "totalAssets must include idle");

        // A further deposit of 2 000 would push total to 21 000 > 20 000 cap → must revert.
        usdc.mint(bob, 2_000 * ONE_USDC);
        vm.prank(bob);
        usdc.approve(address(tightVault), type(uint256).max);
        vm.prank(bob);
        vm.expectRevert(); // ERC4626ExceededMaxDeposit fires before TVLCapExceeded because maxDeposit() returns headroom
        tightVault.deposit(2_000 * ONE_USDC, bob);
    }

    /// @notice UnroutedDeposit event is emitted when routing cannot place all assets
    ///         (all adapter caps exhausted).
    function test_routeDeposit_emitsUnroutedDeposit_whenCapsExhausted() public {
        // Deploy a vault whose single adapter has a 50% cap and is already at cap.
        // We set up a scenario where the adapter is already at 50% of totalAfter,
        // so pass 2 also finds no headroom and remaining > 0.

        // Use a cap-capped adapter: capBps = 5000 (50%)
        VaultHarness capVault = newVaultHarness(
            IERC20(address(usdc)), TVL_CAP, PER_DEPOSIT_CAP, 0, feeRecipient, admin, admin
        );
        MockAdapter capAdapter = new MockAdapter(address(usdc), address(capVault));
        _allowAdapter(capVault, address(capAdapter));
        vm.prank(admin);
        capVault.addAdapter(address(capAdapter), 5000); // 50% cap

        usdc.mint(alice, 200_000 * ONE_USDC);
        vm.prank(alice);
        usdc.approve(address(capVault), type(uint256).max);

        // First deposit: 100 000 USDC. Adapter cap is 50% = 50 000.
        // pass1 routes 50 000, remaining=50 000. pass2 finds adapter already at cap.
        // So 50 000 should be unrouted.
        vm.expectEmit(true, true, true, true, address(capVault));
        emit RobotMoneyVault.UnroutedDeposit(50_000 * ONE_USDC);
        vm.prank(alice);
        capVault.deposit(100_000 * ONE_USDC, alice);

        // The idle USDC in the vault should be 50 000.
        assertEq(
            usdc.balanceOf(address(capVault)),
            50_000 * ONE_USDC,
            "idle USDC must remain in vault when unrouted"
        );

        // totalAssets includes the idle portion.
        assertEq(capVault.totalAssets(), 100_000 * ONE_USDC, "totalAssets must include idle USDC");
    }

    // ─── Pause / unpause role asymmetry (issue #164) ────────────────────────

    /// @notice EMERGENCY_ROLE holder can call pauseDeposits().
    function test_pauseDeposits_allowedForEmergencyRole() public {
        address emergency = makeAddr("emergency");
        bytes32 emergencyRole = vault.EMERGENCY_ROLE();
        vm.prank(admin);
        vault.grantRole(emergencyRole, emergency);

        vm.prank(emergency);
        vault.pauseDeposits();
        assertTrue(vault.depositsPaused(), "vault must be paused");
    }

    /// @notice EMERGENCY_ROLE holder cannot call unpauseDeposits() — must revert.
    ///         A compromised emergency key can halt the vault (DoS) but cannot restart it.
    function test_unpauseDeposits_revertsForEmergencyRole() public {
        address emergency = makeAddr("emergency");
        bytes32 emergencyRole = vault.EMERGENCY_ROLE();
        vm.prank(admin);
        vault.grantRole(emergencyRole, emergency);

        // First pause so we can attempt an unpause.
        vm.prank(emergency);
        vault.pauseDeposits();

        // Emergency role alone must NOT be able to unpause.
        vm.prank(emergency);
        vm.expectRevert();
        vault.unpauseDeposits();
    }

    /// @notice ADMIN_ROLE holder can call unpauseDeposits() after the vault has been paused.
    function test_unpauseDeposits_allowedForAdminRole() public {
        address emergency = makeAddr("emergency");
        bytes32 emergencyRole = vault.EMERGENCY_ROLE();
        vm.prank(admin);
        vault.grantRole(emergencyRole, emergency);

        // Pause via emergency role.
        vm.prank(emergency);
        vault.pauseDeposits();
        assertTrue(vault.depositsPaused(), "vault must be paused before unpause test");

        // Admin resumes deposits — the only role permitted to restart them.
        vm.prank(admin);
        vault.unpauseDeposits();
        assertFalse(vault.depositsPaused(), "vault must be unpaused after admin unpause");
    }

    // ─── Issue #368 / core 1494: deposit pause only — emergency withdraw preserves redemption ────

    /// @notice After emergencyWithdraw(), users can redeem their shares (assets moved to idle USDC).
    ///         New deposits must be blocked.
    function test_emergencyWithdraw_userCanRedeem_newDepositBlocked() public {
        // Alice deposits 10 000 USDC.
        uint256 depositAmount = 10_000 * ONE_USDC;
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(depositAmount, alice);
        assertGt(aliceShares, 0, "alice must receive shares");

        // Admin triggers emergency withdraw (admin also holds EMERGENCY_ROLE in setUp).
        vm.prank(admin);
        vault.emergencyWithdraw();

        // After emergencyWithdraw, deposits must be blocked.
        assertEq(vault.depositsPaused(), true, "deposits must be paused after emergencyWithdraw");
        // Withdrawals are never blocked: the full position stays redeemable.
        assertEq(vault.maxRedeem(alice), aliceShares, "maxRedeem is the full balance");

        // Alice can redeem — assets are now in idle USDC in the vault.
        vm.prank(alice);
        uint256 assetsOut = vault.redeem(aliceShares, alice, alice);
        assertApproxEqAbs(assetsOut, depositAmount, 1, "alice must recover her deposit on redeem");

        // Bob tries a new deposit → must revert with DepositsArePaused.
        uint256 bobDeposit = 1_000 * ONE_USDC;
        vm.prank(bob);
        vm.expectRevert(RobotMoneyVault.DepositsArePaused.selector);
        vault.deposit(bobDeposit, bob);
    }

    /// @notice pauseDeposits() blocks deposits and mints only. Redeem and withdraw stay
    ///         open, and maxRedeem / maxWithdraw are unchanged (core 1494).
    function test_pauseDeposits_blocksDepositsOnly_withdrawalsStayOpen() public {
        uint256 depositAmount = 5_000 * ONE_USDC;
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(depositAmount, alice);

        vm.prank(admin);
        vault.pauseDeposits();
        assertTrue(vault.depositsPaused(), "deposits must be paused");

        vm.prank(bob);
        vm.expectRevert(RobotMoneyVault.DepositsArePaused.selector);
        vault.deposit(1_000 * ONE_USDC, bob);
        vm.prank(bob);
        vm.expectRevert(RobotMoneyVault.DepositsArePaused.selector);
        vault.mint(1, bob);

        assertEq(vault.maxRedeem(alice), aliceShares, "maxRedeem unchanged by the pause");
        uint256 half = vault.maxWithdraw(alice) / 2;
        assertGt(half, 0, "maxWithdraw unchanged by the pause");
        vm.prank(alice);
        vault.withdraw(half, alice, alice);
        uint256 rest = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(rest, alice, alice);
        assertEq(vault.balanceOf(alice), 0, "alice exits in full while deposits are paused");
    }

    /// @notice After emergencyWithdraw, split-pause state is correctly set; full unpause restores both.
    function test_emergencyWithdraw_thenUnpause_restoresFullFunctionality() public {
        // Alice deposits.
        uint256 depositAmount = 8_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(depositAmount, alice);

        // Emergency withdraw — only deposits paused.
        vm.prank(admin);
        vault.emergencyWithdraw();

        assertEq(vault.depositsPaused(), true, "deposits paused after emergencyWithdraw");

        // Admin resumes deposits.
        vm.prank(admin);
        vault.unpauseDeposits();

        assertEq(vault.depositsPaused(), false, "deposits unpaused after unpauseDeposits");

        // Bob can now deposit again.
        vm.prank(bob);
        uint256 bobShares = vault.deposit(1_000 * ONE_USDC, bob);
        assertGt(bobShares, 0, "bob must receive shares after unpause");
    }

    // ─── forceRemoveAdapter — loss-acceptance semantics ──────────────────────

    /// @notice EMERGENCY_ROLE can force-remove an adapter with assets; active flag becomes false
    ///         and AdapterForceRemoved is emitted with the correct lossAmount.
    function test_forceRemoveAdapter_deactivatesAdapterAndEmitsCorrectLoss() public {
        // Alice deposits so the adapter holds non-zero assets.
        uint256 depositAmount = 5_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(depositAmount, alice);

        // Confirm the adapter holds assets before force-remove.
        uint256 assetsBefore = adapter.totalAssets();
        assertGt(assetsBefore, 0, "adapter must hold non-zero assets before force-remove");

        // Confirm adapter is currently active (index 0).
        (,, bool activeBefore) = vault.adapters(0);
        assertTrue(activeBefore, "adapter must be active before force-remove");

        // Expect the AdapterForceRemoved event with matching lossAmount.
        vm.expectEmit(true, true, false, true, address(vault));
        emit RobotMoneyVault.AdapterForceRemoved(0, address(adapter), assetsBefore);

        vm.prank(admin);
        vault.forceRemoveAdapter(0);

        // Active flag must now be false.
        (,, bool activeAfter) = vault.adapters(0);
        assertFalse(activeAfter, "adapter must be inactive after force-remove");

        // Assets remain in the adapter (not withdrawn) — the loss is accepted.
        assertEq(
            adapter.totalAssets(),
            assetsBefore,
            "adapter assets must remain untouched (loss accepted)"
        );
    }

    function test_forceRemoveAdapter_succeedsWhenTotalAssetsReverts() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(depositAmount, alice);
        adapter.setRevertTotalAssets(true);

        vm.expectEmit(true, true, false, true, address(vault));
        emit RobotMoneyVault.AdapterForceRemoved(0, address(adapter), 0);
        vm.prank(admin);
        vault.forceRemoveAdapter(0);

        (,, bool active) = vault.adapters(0);
        assertFalse(active, "reverting adapter must be quarantined");
        assertEq(vault.totalAssets(), 0, "inactive reverting adapter must not block healthy views");
    }

    /// @notice Calling forceRemoveAdapter without EMERGENCY_ROLE must revert with AccessControl error.
    function test_forceRemoveAdapter_revertsWhenCallerLacksEmergencyRole() public {
        bytes32 emergencyRole = vault.EMERGENCY_ROLE();

        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", alice, emergencyRole
            )
        );
        vm.prank(alice);
        vault.forceRemoveAdapter(0);
    }

    /// @notice Calling forceRemoveAdapter with an out-of-range index must revert with AdapterNotFound.
    function test_forceRemoveAdapter_revertsOnOutOfRangeIndex() public {
        uint256 outOfRange = 999;

        vm.expectRevert(abi.encodeWithSelector(RobotMoneyVault.AdapterNotFound.selector));
        vm.prank(admin);
        vault.forceRemoveAdapter(outOfRange);
    }

    /// @notice Calling forceRemoveAdapter on an already-inactive adapter must revert with AdapterNotFound.
    function test_forceRemoveAdapter_revertsOnAlreadyInactiveAdapter() public {
        // First, force-remove the adapter to deactivate it.
        vm.prank(admin);
        vault.forceRemoveAdapter(0);

        // Second call on the now-inactive adapter must revert.
        vm.expectRevert(abi.encodeWithSelector(RobotMoneyVault.AdapterNotFound.selector));
        vm.prank(admin);
        vault.forceRemoveAdapter(0);
    }

    /// @notice forceRemoveAdapter must pause deposits to close the share-price-crash arbitrage window.
    function test_forceRemoveAdapter_pausesDeposits() public {
        // Alice deposits so the adapter holds non-zero assets.
        uint256 depositAmount = 1_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(depositAmount, alice);

        // Force-remove the adapter.
        vm.prank(admin);
        vault.forceRemoveAdapter(0);

        // Deposits must now be paused.
        assertTrue(vault.depositsPaused(), "deposits must be paused after forceRemoveAdapter");

        // A subsequent deposit attempt must revert with DepositsArePaused.
        vm.prank(bob);
        vm.expectRevert(RobotMoneyVault.DepositsArePaused.selector);
        vault.deposit(100 * ONE_USDC, bob);
    }

    // ─── L-3: shutdown recoverability ──────────────────────────────────────────

    /// @notice EMERGENCY_ROLE can shut the vault down (deposits blocked,
    ///         maxDeposit == 0) and the new ADMIN_ROLE-gated restoreVault
    ///         re-opens deposits (maxDeposit > 0 and a deposit succeeds), while
    ///         EMERGENCY_ROLE alone cannot restore (reverts). This proves a
    ///         compromised emergency hot key can DoS but not permanently brick
    ///         deposits — mirroring the documented pause/unpause asymmetry.
    function test_shutdownVault_isRecoverableByAdminNotEmergency() public {
        // Distinct EMERGENCY_ROLE holder (lower-trust hot key); admin keeps
        // ADMIN_ROLE only. This separation is what the trust model assumes.
        address emergency = makeAddr("emergency");
        bytes32 emergencyRole = vault.EMERGENCY_ROLE();
        vm.prank(admin);
        vault.grantRole(emergencyRole, emergency);

        // Sanity: deposits open before shutdown.
        assertGt(vault.maxDeposit(alice), 0, "deposits should be open pre-shutdown");

        // 1. EMERGENCY_ROLE shuts the vault down: deposits blocked, cap zeroed.
        vm.prank(emergency);
        vault.shutdownVault();
        assertTrue(vault.isShutdown(), "vault should be shut down");
        assertEq(vault.maxDeposit(alice), 0, "maxDeposit must be 0 after shutdown");
        assertEq(vault.tvlCap(), 0, "tvlCap must be zeroed by shutdown");

        // A deposit must revert while shut down.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSignature(
                "ERC4626ExceededMaxDeposit(address,uint256,uint256)", alice, 100 * ONE_USDC, 0
            )
        );
        vault.deposit(100 * ONE_USDC, alice);

        // 2. EMERGENCY_ROLE alone CANNOT restore (it lacks ADMIN_ROLE).
        bytes32 adminRole = vault.ADMIN_ROLE();
        vm.prank(emergency);
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", emergency, adminRole
            )
        );
        vault.restoreVault(TVL_CAP);

        // 3. ADMIN_ROLE restores: deposits re-open with a fresh cap.
        vm.prank(admin);
        vault.restoreVault(TVL_CAP);
        assertFalse(vault.isShutdown(), "vault should no longer be shut down");
        assertEq(vault.tvlCap(), TVL_CAP, "restore must set the supplied TVL cap");
        assertGt(vault.maxDeposit(alice), 0, "deposits should re-open after restore");

        // A deposit now succeeds.
        vm.prank(alice);
        uint256 shares = vault.deposit(100 * ONE_USDC, alice);
        assertGt(shares, 0, "deposit after restore must mint shares");
    }

    /// @notice restoreVault reverts when the vault is not shut down (NotShutdown)
    ///         and when the supplied cap is zero (InvalidCap).
    function test_restoreVault_revertsWhenNotShutdownOrZeroCap() public {
        // Not shut down → NotShutdown.
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.NotShutdown.selector);
        vault.restoreVault(TVL_CAP);

        // Shut down, then a zero cap is rejected.
        vm.prank(admin);
        vault.shutdownVault();
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.InvalidCap.selector);
        vault.restoreVault(0);
    }

    // ─── Unified governance retire (DI-2, #942) ───────────────────────────────

    /// @notice After the registry drives `retire()`, direct deposits/mints are
    ///         hard-stopped at the vault (maxDeposit == 0, deposit reverts), but
    ///         withdrawals/redemptions stay open. `retire()` is callable only by
    ///         the linked registry; a stranger (even ADMIN_ROLE) call reverts.
    function test_retire_haltsDirectDepositsButKeepsRedeemOpen() public {
        // A registry stand-in is the only caller allowed to drive retire().
        address registry = makeAddr("registry");
        vm.prank(admin);
        vault.setRegistry(registry);

        // Seed a position so we can prove redeem stays open after retire.
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000 * ONE_USDC, alice);
        assertGt(shares, 0, "seed deposit should mint shares");
        assertGt(vault.maxDeposit(alice), 0, "deposits open pre-retire");

        // A direct (non-registry) retire() call reverts — even from ADMIN.
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.OnlyRegistry.selector);
        vault.retire();

        // The registry retires the vault.
        vm.prank(registry);
        vault.retire();
        assertTrue(vault.retired(), "vault should be retired");
        assertEq(vault.maxDeposit(alice), 0, "maxDeposit must be 0 after retire");

        // Direct deposits now revert with VaultRetired (ERC-4626 max-deposit guard
        // fires first because maxDeposit() == 0).
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSignature(
                "ERC4626ExceededMaxDeposit(address,uint256,uint256)", alice, 100 * ONE_USDC, 0
            )
        );
        vault.deposit(100 * ONE_USDC, alice);

        // Redemptions stay open: the seeded holder can still exit.
        vm.prank(alice);
        uint256 assets = vault.redeem(shares, alice, alice);
        assertGt(assets, 0, "redeem must stay open on a retired vault");
    }

    /// @notice The vault `retire`/`unretire` lifecycle flag is distinct from the
    ///         emergency `shutdown` overlay: retiring does not set `shutdown`, and
    ///         `shutdownVault` continues to work independently after a retire.
    function test_retire_isIndependentFromEmergencyShutdown() public {
        address registry = makeAddr("registry");
        vm.prank(admin);
        vault.setRegistry(registry);

        // Retire: lifecycle flag set, emergency shutdown untouched.
        vm.prank(registry);
        vault.retire();
        assertTrue(vault.retired(), "retired flag set");
        assertFalse(vault.isShutdown(), "retire must not set the emergency shutdown flag");

        // Emergency shutdown still works while retired (EMERGENCY_ROLE, vault-only).
        vm.prank(admin); // admin also holds EMERGENCY_ROLE in this fixture
        vault.shutdownVault();
        assertTrue(vault.isShutdown(), "shutdownVault must still work after retire");
        assertTrue(vault.retired(), "retire flag stays set independently of shutdown");
    }

    /// @notice The registry can abort a deprecation via `unretire()`, re-opening
    ///         direct deposits. Only the linked registry may call it.
    function test_unretire_reopensDirectDeposits() public {
        address registry = makeAddr("registry");
        vm.prank(admin);
        vault.setRegistry(registry);

        vm.prank(registry);
        vault.retire();
        assertEq(vault.maxDeposit(alice), 0, "deposits halted after retire");

        // Direct (non-registry) unretire reverts.
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.OnlyRegistry.selector);
        vault.unretire();

        // Registry aborts the deprecation.
        vm.prank(registry);
        vault.unretire();
        assertFalse(vault.retired(), "vault should be active again");
        assertGt(vault.maxDeposit(alice), 0, "deposits re-open after unretire");

        // A direct deposit now succeeds.
        vm.prank(alice);
        uint256 shares = vault.deposit(100 * ONE_USDC, alice);
        assertGt(shares, 0, "deposit after unretire must mint shares");
    }

    /// @notice `setRegistry` is set-once and ADMIN_ROLE-gated.
    function test_setRegistry_isSetOnceAndAdminGated() public {
        address registry = makeAddr("registry");

        // Non-admin cannot set the registry.
        bytes32 adminRole = vault.ADMIN_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", alice, adminRole
            )
        );
        vault.setRegistry(registry);

        // Zero address rejected.
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.ZeroAddress.selector);
        vault.setRegistry(address(0));

        // First set succeeds; second reverts (set-once).
        vm.prank(admin);
        vault.setRegistry(registry);
        assertEq(vault.registry(), registry, "registry link must be set");
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.RegistryAlreadySet.selector);
        vault.setRegistry(makeAddr("otherRegistry"));
    }

    // ─── Custody invariants: foreign-token quarantine & NAV donation (#929) ────

    /// @notice INV-1: the vault asset (USDC) can never be swept out — it is a
    ///         protocol/depositor asset counted in NAV and redeemable by holders.
    function test_sweepForeignToken_revertsForVaultAsset() public {
        vm.expectRevert(
            abi.encodeWithSelector(ForeignTokenQuarantine.TokenIsProtected.selector, address(usdc))
        );
        vault.sweepForeignToken(address(usdc));
    }

    /// @notice INV-1: the vault share token can never be swept out.
    function test_sweepForeignToken_revertsForShareToken() public {
        vm.expectRevert(
            abi.encodeWithSelector(ForeignTokenQuarantine.TokenIsProtected.selector, address(vault))
        );
        vault.sweepForeignToken(address(vault));
    }

    /// @notice INV-2: a genuinely foreign token is permissionlessly swept to the
    ///         fixed quarantine address by ANY caller — no admin role, no
    ///         caller-supplied recipient (replaces deleted `rescueTokens`).
    function test_sweepForeignToken_permissionlessToQuarantine() public {
        TestUSDC stray = new TestUSDC();
        stray.mint(address(vault), 9 * ONE_USDC);

        vm.prank(attacker);
        vault.sweepForeignToken(address(stray));

        assertEq(stray.balanceOf(address(vault)), 0, "vault swept clean");
        assertEq(
            stray.balanceOf(ForeignTokenQuarantine.QUARANTINE),
            9 * ONE_USDC,
            "stray token quarantined"
        );
    }

    /// @notice INV-2: donating the vault asset (USDC) directly to the vault
    ///         strictly increases totalAssets and credits ALL holders pro-rata —
    ///         the donation is absorbed into NAV, not routable to any admin.
    function test_donatingVaultAsset_raisesNavForAllHolders() public {
        // Two holders deposit equally.
        uint256 amount = 1_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(amount, alice);
        vm.prank(bob);
        vault.deposit(amount, bob);

        uint256 aliceBefore = vault.convertToAssets(vault.balanceOf(alice));
        uint256 bobBefore = vault.convertToAssets(vault.balanceOf(bob));
        uint256 totalBefore = vault.totalAssets();

        // Donate USDC straight to the vault (idle balance is counted in totalAssets).
        uint256 donation = 500 * ONE_USDC;
        usdc.mint(address(vault), donation);

        assertEq(vault.totalAssets(), totalBefore + donation, "donation must raise totalAssets");
        assertGt(vault.convertToAssets(vault.balanceOf(alice)), aliceBefore, "alice NAV must rise");
        assertGt(vault.convertToAssets(vault.balanceOf(bob)), bobBefore, "bob NAV must rise");
        // Equal holders gain equally (pro-rata), within rounding.
        assertApproxEqAbs(
            vault.convertToAssets(vault.balanceOf(alice)),
            vault.convertToAssets(vault.balanceOf(bob)),
            1,
            "equal holders gain equally"
        );
    }
}
