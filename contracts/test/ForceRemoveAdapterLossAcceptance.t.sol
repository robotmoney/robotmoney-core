// SPDX-License-Identifier: MIT
// Scout stub for issue #701 — forceRemoveAdapter loss-acceptance test scaffold.
//
// SEAM: This file is the integration point for issue #677
// (test(contracts): add forceRemoveAdapter loss-acceptance tests).
//
// When #677 is implemented, replace every TODO_STUB comment below with a
// real assertion. The scaffold compiles and passes today so that #677 has a
// compile-safe target from day one.
//
// Canonical: docs/technical/security-model.md §9, issue #677.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {PassthroughAdapter} from "../adapters/PassthroughAdapter.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";

// ─── Minimal USDC mock ───────────────────────────────────────────────────────

contract LossAcceptanceUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// ─── Insolvent mock adapter ───────────────────────────────────────────────────
//
// Models an adapter whose underlying protocol becomes insolvent: `totalAssets()`
// still returns a non-zero value but the adapter holds zero USDC (simulating a
// protocol hack where the adapter's position is zeroed externally).
//
// Issue #677 tests use this mock to exercise the loss-acceptance path in
// `forceRemoveAdapter`, verifying that the vault correctly records the lost
// value as an off-chain accounting event without reverting.

contract InsolventMockAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDC;
    address public immutable VAULT;

    /// @notice Simulated insolvent balance — what the adapter reports via
    ///         `totalAssets()` even though the funds are gone.
    uint256 public reportedAssets;

    error OnlyVault();

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    constructor(address usdc_, address vault_) {
        USDC = IERC20(usdc_);
        VAULT = vault_;
    }

    /// @notice Set the amount the adapter claims it holds (decoupled from
    ///         actual balance to simulate insolvency).
    function setReportedAssets(uint256 amount) external {
        reportedAssets = amount;
    }

    /// @inheritdoc IStrategyAdapter
    function deploy(uint256) external onlyVault {
        // Scout stub: no-op. Issue #677 exercises full deploy→hack→forceRemove.
    }

    /// @inheritdoc IStrategyAdapter
    function withdraw(uint256) external onlyVault returns (uint256 recovered) {
        // Insolvent: return 0 regardless of the request.
        recovered = 0;
    }

    /// @inheritdoc IStrategyAdapter
    function totalAssets() external view returns (uint256) {
        return reportedAssets;
    }

    /// @inheritdoc IStrategyAdapter
    function rescueTokens(address, address) external onlyVault {}
}

// ─── Test contract ────────────────────────────────────────────────────────────

/// @title ForceRemoveAdapterLossAcceptanceTest
/// @notice Scout stub scaffold for issue #677.
///
/// Each test below is a compile-safe placeholder that verifies the skeleton
/// compiles and the helpers work. Issue #677 replaces the stub bodies with
/// real assertions that cover the full loss-acceptance behaviour required by
/// docs/technical/security-model.md §9.
///
/// Tests that #677 must implement (replace TODO_STUB bodies):
///
///   1. `test_forceRemoveAdapter_recordsLoss`
///      Assert `AdapterForceRemoved` is emitted with the exact `lossAmount`
///      equal to `adapter.totalAssets()` at the time of the call.
///
///   2. `test_forceRemoveAdapter_deactivatesAdapter`
///      Assert `adapters[index].active == false` after the call; the adapter
///      is excluded from future `totalAssets()` tallies.
///
///   3. `test_forceRemoveAdapter_reducesTotalAssets`
///      Assert that `vault.totalAssets()` decreases by exactly the insolvent
///      adapter's reported value — proving the share price reflects the loss.
///
///   4. `test_forceRemoveAdapter_revertsForInvalidIndex`
///      Assert the call reverts with `AdapterNotFound` for an out-of-bounds
///      or already-inactive adapter index.
///
///   5. `test_forceRemoveAdapter_revertsIfNotEmergencyRole`
///      Assert the call reverts when the caller lacks `EMERGENCY_ROLE`.
///
///   6. `test_forceRemoveAdapter_survivingAdaptersUnaffected`
///      Assert that `totalAssets()` from non-removed adapters is unchanged and
///      depositors who have not triggered a withdrawal retain their pro-rata claim.
contract ForceRemoveAdapterLossAcceptanceTest is Test {
    LossAcceptanceUSDC internal usdc;
    RobotMoneyVault internal vault;
    InsolventMockAdapter internal insolventAdapter;

    address internal admin = makeAddr("admin");
    address internal emergency = makeAddr("emergency");
    address internal depositor = makeAddr("depositor");

    uint256 internal constant INITIAL_DEPOSIT = 1_000e6; // 1 000 USDC

    function setUp() public {
        usdc = new LossAcceptanceUSDC();

        // Deploy vault with full constructor args:
        //   asset, tvlCap (0=uncapped), perDepositCap (0=uncapped),
        //   exitFeeBps (0), feeRecipient, admin, emergencyResponder.
        vault = new RobotMoneyVault(
            IERC20(address(usdc)),
            0, // tvlCap: uncapped
            0, // perDepositCap: uncapped
            0, // exitFeeBps: 0
            admin, // feeRecipient
            admin, // admin
            emergency // emergencyResponder
        );

        // Deploy the insolvent adapter and register it.
        insolventAdapter = new InsolventMockAdapter(address(usdc), address(vault));
        vm.startPrank(admin);
        vault.setAdapterAllowed(address(insolventAdapter), true);
        vault.setAdapterCodeHashAllowed(address(insolventAdapter).codehash, true);
        vault.addAdapter(address(insolventAdapter), 10_000); // 100% cap bps
        vm.stopPrank();

        // Depositor setup.
        usdc.mint(depositor, INITIAL_DEPOSIT * 2);
        vm.prank(depositor);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ── Test 1: loss recording ────────────────────────────────────────────────

    /// @dev Scout stub — no-op skeleton. Issue #677 adds real assertions.
    ///
    /// TODO_STUB (#677): verify `AdapterForceRemoved` is emitted with the
    /// correct `lossAmount` equal to `insolventAdapter.totalAssets()`.
    function test_forceRemoveAdapter_recordsLoss() public {
        // Simulate insolvent position: adapter claims 500 USDC but holds 0.
        insolventAdapter.setReportedAssets(500e6);

        // STUB: confirm the call does not revert (full assertions in #677).
        vm.prank(emergency);
        vault.forceRemoveAdapter(0);
    }

    // ── Test 2: adapter deactivation ──────────────────────────────────────────

    /// @dev Scout stub — no-op skeleton. Issue #677 adds real assertions.
    ///
    /// TODO_STUB (#677): assert `adapters[0].active == false` after the call.
    function test_forceRemoveAdapter_deactivatesAdapter() public {
        insolventAdapter.setReportedAssets(500e6);
        vm.prank(emergency);
        vault.forceRemoveAdapter(0);
        // STUB: no assertion yet — #677 adds the adapters[0].active check.
    }

    // ── Test 3: share-price reflects the loss ─────────────────────────────────

    /// @dev Scout stub — no-op skeleton. Issue #677 adds real assertions.
    ///
    /// TODO_STUB (#677): deposit USDC, record pre-forceRemove totalAssets,
    /// then assert that post-forceRemove totalAssets == pre - lossAmount.
    function test_forceRemoveAdapter_reducesTotalAssets() public {
        insolventAdapter.setReportedAssets(500e6);
        vm.prank(emergency);
        vault.forceRemoveAdapter(0);
        // STUB: no assertion yet — #677 adds totalAssets delta check.
    }

    // ── Test 4: invalid index reverts ─────────────────────────────────────────

    /// @dev Scout stub — no-op skeleton. Issue #677 adds real assertions.
    ///
    /// TODO_STUB (#677): expect `vm.expectRevert(RobotMoneyVault.AdapterNotFound.selector)`
    /// for an out-of-bounds index and for an already-inactive adapter.
    function test_forceRemoveAdapter_revertsForInvalidIndex() public {
        vm.prank(emergency);
        // STUB: expect revert for out-of-bounds index (full check in #677).
        vm.expectRevert();
        vault.forceRemoveAdapter(999);
    }

    // ── Test 5: role guard ────────────────────────────────────────────────────

    /// @dev Scout stub — no-op skeleton. Issue #677 adds real assertions.
    ///
    /// TODO_STUB (#677): expect an AccessControl revert when caller lacks
    /// `EMERGENCY_ROLE`.
    function test_forceRemoveAdapter_revertsIfNotEmergencyRole() public {
        vm.prank(depositor); // not emergency
        vm.expectRevert();
        vault.forceRemoveAdapter(0);
    }

    // ── Test 6: surviving adapters unaffected ─────────────────────────────────

    /// @dev Scout stub — no-op skeleton. Issue #677 adds real assertions.
    ///
    /// TODO_STUB (#677): add a second PassthroughAdapter with real USDC,
    /// forceRemove only the insolvent adapter, and assert the surviving
    /// adapter's totalAssets contribution is unchanged.
    function test_forceRemoveAdapter_survivingAdaptersUnaffected() public {
        insolventAdapter.setReportedAssets(500e6);
        vm.prank(emergency);
        vault.forceRemoveAdapter(0);
        // STUB: no assertion yet — #677 adds multi-adapter check.
    }
}
