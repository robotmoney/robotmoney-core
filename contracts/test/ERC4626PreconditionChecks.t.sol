// SPDX-License-Identifier: MIT
// Canonical: docs/development/ci-suites.md §19
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {PassthroughAdapter} from "../adapters/PassthroughAdapter.sol";
import {AaveV3Adapter} from "../adapters/AaveV3Adapter.sol";
import {CompoundV3Adapter} from "../adapters/CompoundV3Adapter.sol";
import {MorphoAdapter} from "../adapters/MorphoAdapter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @title Minimal ERC-4626 Morpho-vault stand-in.
/// @notice Only the surface `MorphoAdapter.totalAssets()` touches —
///         `balanceOf` and `convertToAssets` — is implemented. An empty
///         adapter holds zero shares, so `convertToAssets(0) == 0`.
contract MockMorpho4626 {
    /// @dev Adapter holds no shares in any precondition scenario.
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    /// @dev 1:1 share↔asset stub; only ever called with `shares == 0` here.
    function convertToAssets(uint256 shares) external pure returns (uint256) {
        return shares;
    }
}

/// @title ERC4626PreconditionChecks
/// @notice Suite-19 precondition gate. For every `exitFeeBps` tier
///         (0, 30, 100) × adapter (passthrough, aave, compound, morpho)
///         this asserts the vault's structural ERC-4626 preconditions on a
///         freshly-deployed, empty vault: `asset()`, `decimals()`, and the
///         empty-vault share-price invariants. The CI matrix re-runs this
///         contract once per `EXIT_FEE_BPS` value; the hardcoded per-tier
///         tests additionally cover all three tiers in a single local run.
///
/// @dev INTENTIONALLY-SKIPPED a16z erc4626-tests properties under non-zero
///      exit fees. The a16z `ERC4626Test` property suite assumes a vanilla,
///      fee-free vault. RobotMoneyVault charges an exit fee on the
///      redeem/withdraw path (`_grossToNet`/`_netToGross`), which breaks the
///      following vanilla properties for `exitFeeBps > 0`:
///        - `test_previewRedeem`  — `previewRedeem(s)` returns net-of-fee
///          assets, strictly below the vanilla `convertToAssets(s)`.
///        - `test_previewWithdraw` — `previewWithdraw(a)` grosses the request
///          up by the fee, so it exceeds the vanilla share count.
///        - `test_redeem` / `test_withdraw` round-trip parity — a
///          deposit→redeem round trip returns less than it put in by exactly
///          the exit fee, so `preview ↔ actual` parity holds but
///          `convertTo* ↔ redeem/withdraw` parity does not.
///      The deposit/mint side (`previewDeposit`, `previewMint`,
///      `convertToShares`, `convertToAssets`) carries no fee and remains
///      fully conformant, so those invariants are asserted below for every
///      tier. The exit-fee adjustment on the redeem path is asserted
///      explicitly rather than via the vanilla a16z property.
contract ERC4626PreconditionChecks is Test {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant OFFSET = 18; // RobotMoneyVault._decimalsOffset()
    uint256 internal constant VIRTUAL_SHARES = 10 ** OFFSET; // 1e18
    uint16 internal constant MAX_BPS = 10000;
    uint16 internal constant MAX_EXIT_FEE_BPS = 100;

    // Non-zero protocol stub for adapter immutables that are not exercised by
    // the empty-vault precondition reads (e.g. the Aave pool).
    address internal constant POOL_STUB = address(0xA00E);

    enum AdapterKind {
        Passthrough,
        Aave,
        Compound,
        Morpho
    }

    // ── Matrix entry points ───────────────────────────────────────────────

    function test_preconditions_exitFee0() public {
        _runAdapterMatrix(0);
    }

    function test_preconditions_exitFee30() public {
        _runAdapterMatrix(30);
    }

    function test_preconditions_exitFee100() public {
        _runAdapterMatrix(100);
    }

    /// @notice Mirrors the CI matrix: reads `EXIT_FEE_BPS` (default 0) so each
    ///         matrix shard exercises the precondition gate with its own tier.
    function test_preconditions_matrixEnvTier() public {
        uint256 envFee = vm.envOr("EXIT_FEE_BPS", uint256(0));
        if (envFee > MAX_EXIT_FEE_BPS) envFee = MAX_EXIT_FEE_BPS;
        _runAdapterMatrix(envFee);
    }

    // ── Matrix driver ─────────────────────────────────────────────────────

    function _runAdapterMatrix(uint256 exitFeeBps) internal {
        _assertPreconditions(AdapterKind.Passthrough, exitFeeBps);
        _assertPreconditions(AdapterKind.Aave, exitFeeBps);
        _assertPreconditions(AdapterKind.Compound, exitFeeBps);
        _assertPreconditions(AdapterKind.Morpho, exitFeeBps);
    }

    function _assertPreconditions(AdapterKind kind, uint256 exitFeeBps) internal {
        (RobotMoneyVault vault, TestERC20 usdc) = _deployVaultWithAdapter(kind, exitFeeBps);

        // ── Structural preconditions ──
        assertEq(vault.asset(), address(usdc), "asset() must equal underlying USDC");
        assertEq(vault.decimals(), 6, "decimals() must equal 6 (USDC parity)");

        // ── Empty-vault preconditions ──
        assertEq(vault.totalAssets(), 0, "fresh vault must hold zero assets");
        assertEq(vault.totalSupply(), 0, "fresh vault must have zero shares");
        assertEq(vault.exitFeeBps(), exitFeeBps, "exitFeeBps wired through constructor");

        // ── Empty-vault share-price invariants (fee-independent) ──
        // The 18-unit virtual-share offset makes a fresh vault price 1 USDC at
        // exactly 1e24 raw shares regardless of exit fee, because the exit fee
        // applies only to the redeem/withdraw path.
        assertEq(
            vault.previewDeposit(ONE_USDC),
            ONE_USDC * VIRTUAL_SHARES,
            "empty previewDeposit(1 USDC) must equal 1e24 shares"
        );
        assertEq(
            vault.previewMint(ONE_USDC * VIRTUAL_SHARES),
            ONE_USDC,
            "empty previewMint(1e24) must equal 1 USDC"
        );
        assertEq(
            vault.convertToShares(ONE_USDC),
            ONE_USDC * VIRTUAL_SHARES,
            "empty convertToShares(1 USDC) must equal 1e24"
        );
        assertEq(
            vault.convertToAssets(ONE_USDC * VIRTUAL_SHARES),
            ONE_USDC,
            "empty convertToAssets(1e24) must equal 1 USDC"
        );

        // ── Exit-fee adjustment on the redeem path ──
        // previewRedeem returns net-of-fee assets: gross - gross*fee/MAX_BPS.
        uint256 expectedNet = ONE_USDC - (ONE_USDC * exitFeeBps) / MAX_BPS;
        assertEq(
            vault.previewRedeem(ONE_USDC * VIRTUAL_SHARES),
            expectedNet,
            "empty previewRedeem must net the exit fee off the gross assets"
        );
    }

    // ── Vault + adapter wiring ────────────────────────────────────────────

    function _deployVaultWithAdapter(AdapterKind kind, uint256 exitFeeBps)
        internal
        returns (RobotMoneyVault vault, TestERC20 usdc)
    {
        usdc = new TestERC20();
        // This test contract holds ADMIN_ROLE / feeRecipient / emergencyResponder,
        // so adapter onboarding below needs no prank.
        vault = new RobotMoneyVault(
            IERC20(address(usdc)),
            type(uint256).max, // tvlCap — unbounded
            type(uint256).max, // perDepositCap — unbounded
            exitFeeBps,
            address(this), // feeRecipient
            address(this), // admin
            address(this) // emergencyResponder
        );

        address adapter = _deployAdapter(kind, vault, usdc);
        vault.setAdapterAllowed(adapter, true);
        vault.setAdapterCodeHashAllowed(adapter.codehash, true);
        vault.addAdapter(adapter, MAX_BPS); // 100% cap
    }

    function _deployAdapter(AdapterKind kind, RobotMoneyVault vault, TestERC20 usdc)
        internal
        returns (address)
    {
        if (kind == AdapterKind.Passthrough) {
            return address(new PassthroughAdapter(address(usdc), address(vault)));
        }
        if (kind == AdapterKind.Aave) {
            // aToken stub: balanceOf(adapter) == 0 on an empty adapter.
            TestERC20 aToken = new TestERC20();
            return
                address(
                    new AaveV3Adapter(POOL_STUB, address(usdc), address(aToken), address(vault))
                );
        }
        if (kind == AdapterKind.Compound) {
            // comet stub: balanceOf(adapter) == 0 on an empty adapter.
            TestERC20 comet = new TestERC20();
            return address(new CompoundV3Adapter(address(comet), address(usdc), address(vault)));
        }
        // Morpho: ERC-4626 stub returning zero assets for zero shares.
        MockMorpho4626 morphoVault = new MockMorpho4626();
        return address(new MorphoAdapter(address(morphoVault), address(usdc), address(vault)));
    }
}
