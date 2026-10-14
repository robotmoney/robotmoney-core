// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md (ADP-2, ORA-3)
//            docs/code-review/20260619-code-review-pekshield.md (NC-2, F-09)
pragma solidity ^0.8.24;

import {IUniswapV3Pool} from "../interfaces/IUniswapV3Pool.sol";
import {IAerodromePool} from "../interfaces/IAerodromePool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IObservablePool} from "../interfaces/IObservablePool.sol";

/// @title BasketAssetConfigGuard
/// @notice The config-validation interface the 2026-06-19 audit recommended for
///         `BasketVault.addAsset`: it enforces the ADP-2 adapter codehash
///         allowlist and the ORA-3 execution-pool == TWAP-pool equality (F-09).
/// @dev Declared `public` (external, DELEGATECALL-linked) so the checks live in a
///      single deployed library instead of being inlined into every vault in the
///      already-EIP-170-tight basket family.
/// @dev The vault getters `payInKind` reads from `address(this)`.
interface IInKindVault {
    function asset() external view returns (address);
    function exitFeeBps() external view returns (uint256);
    function feeRecipient() external view returns (address);
}

/// @dev The vault getters `deactivateAsset` reads from `address(this)` to price a leftover balance (QA plan D6).
interface IDustPricedVault {
    function maxSlippageBps() external view returns (uint256);
    function assetUsdcValue(uint256 index, uint256 amount) external view returns (uint256);
}

library BasketAssetConfigGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /// @dev Mirror of `BasketVault.Venue`. Kept value-compatible (same ordinals). V4 is the Uniswap V4 venue: its "pool"
    ///      is the `UniswapV4PriceRecorder`, which answers `token0`, `token1`, `fee`, `liquidity`, `slot0` and `observe`
    ///      like a V3 pool, so every check below applies to it unchanged (core 1676).
    enum Venue {
        V3,
        V4,
        Aerodrome
    }

    /// @dev Layout-compatible mirror of `BasketVault.AssetInfo`. Field order and
    ///      types MUST match exactly so the delegatecall-linked dedup scan below
    ///      reads/writes the vault's `assets` storage correctly.
    struct AssetInfo {
        address token;
        address pool;
        uint24 swapFee;
        bool active;
        address adapter;
        Venue venue;
    }

    /// @dev Mirror of `BasketVault.InsufficientGas` (same selector): gas left at in-kind redeem entry is below the floor.
    error InsufficientGas(uint256 available, uint256 required);
    /// @dev Adapter runtime-bytecode hash not on the ADMIN-approved allowlist (ADP-2).
    error AdapterCodeHashNotAllowed();
    /// @dev Execution pool (resolved from swapFee) != registered TWAP pool (ORA-3).
    error ExecutionPoolMismatch();
    /// @dev `addAsset` re-add of a token that already has an ACTIVE entry (NC-8).
    error AssetAlreadyActive();
    /// @dev Pool does not pair `token` with USDC.
    error PoolTokenMismatch();
    /// @dev Pool observation cardinality below the minimum required for TWAP.
    error InsufficientPoolCardinality(address pool, uint16 required, uint16 actual);
    /// @dev Pool lacks the observation history to service a full TWAP window.
    error InsufficientObservationHistory(address pool, uint32 requiredWindow);
    /// @dev Pool in-range liquidity below the synchronous-redemption minimum.
    error InsufficientPoolLiquidity(address pool, uint128 required, uint128 actual);
    /// @dev Token has no usable bytecode and its code hash is not the allowed B20 marker.
    error TokenHasNoCode(address token);
    /// @dev Mirror of `BasketVault.AssetNotFound` (same selector): no ACTIVE entry at the index.
    error AssetNotFound();
    /// @dev Mirror of `BasketVault.AssetStillHeld` (same selector): the vault holds more than dust of the token.
    error AssetStillHeld();

    /// @dev Code hash of the single byte `0xef`. Coinbase B20 tokenized stocks are protocol
    ///      precompiles: the account code on Base is exactly `0xef`, so a plain "has code"
    ///      check would be the only thing standing between a typo and a codeless token. This
    ///      is the one explicit code-hash allowance for tokens with a 1-byte code (core 1500).
    bytes32 internal constant B20_PRECOMPILE_CODEHASH = keccak256(hex"ef");

    /// @dev Base block time in seconds, the cadence the cardinality floor is derived from.
    uint32 internal constant BASE_BLOCK_SECONDS = 2;

    /// @notice Assert `pool` is usable as an `addAsset` venue: it pairs `token`
    ///         with `usdc`, has enough observation cardinality and history to serve
    ///         a `twapWindow`-second TWAP, and has at least `minLiquidity` in-range
    ///         liquidity. Extracted from `BasketVault.addAsset` into this
    ///         delegatecall-linked guard to keep the EIP-170-tight basket-vault
    ///         bytecode small. Behaviour-identical to the prior inline checks.
    function requirePoolUsable(
        address pool,
        address token,
        address usdc,
        uint32 twapWindow,
        uint128 minLiquidity
    ) public view {
        // A token with no bytecode is rejected. A 1-byte code is accepted only when it is the
        // B20 precompile marker. Any other bytecode is accepted as before.
        if (token.code.length < 2 && token.codehash != B20_PRECOMPILE_CODEHASH) {
            revert TokenHasNoCode(token);
        }
        address t0 = IUniswapV3Pool(pool).token0();
        address t1 = IUniswapV3Pool(pool).token1();
        if (!((t0 == token && t1 == usdc) || (t1 == token && t0 == usdc))) {
            revert PoolTokenMismatch();
        }
        requireObservationHistory(pool, twapWindow);
        uint128 poolLiquidity = IUniswapV3Pool(pool).liquidity();
        if (poolLiquidity < minLiquidity) {
            revert InsufficientPoolLiquidity(pool, minLiquidity, poolLiquidity);
        }
    }

    /// @notice Assert `pool` holds enough observation history to serve a
    ///         `twapWindow`-second TWAP right now: `observe([twapWindow, 0])` must
    ///         not revert. Used by `addAsset` (via `requirePoolUsable`) and by
    ///         `setTwapWindow`, so governance can never set a window the pool's
    ///         oldest observation does not reach. Such a window would make every
    ///         NAV read revert ("OLD") and block every redeem (core 1494).
    function requireObservationHistory(address pool, uint32 twapWindow) public view {
        // Window-derived cardinality floor (core 1665). Uniswap V3 writes at most one observation
        // per block and cardinality never decreases, so a ring of `twapWindow / BLOCK_SECONDS + 1`
        // slots cannot be churned below the window by griefing swaps at Base's 2 s cadence. The
        // 1800 s default window needs 901. IObservablePool.slot0() decodes only the 4 leading
        // fields, which is ABI-compatible with both the 7-field Uniswap V3 layout and the 6-field
        // Aerodrome Slipstream layout (issue #1125).
        (,,, uint16 cardinality) = IObservablePool(pool).slot0();
        uint16 required = uint16(twapWindow / BASE_BLOCK_SECONDS + 1);
        if (cardinality < required) {
            revert InsufficientPoolCardinality(pool, required, cardinality);
        }
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;
        try IUniswapV3Pool(pool).observe(secondsAgos) returns (int56[] memory, uint160[] memory) {}
        catch {
            revert InsufficientObservationHistory(pool, twapWindow);
        }
    }

    /// @notice NC-8 (no duplicate AssetInfo): if `token` already has an entry in
    ///         `assets`, reuse it instead of letting the caller append a second
    ///         one. An ACTIVE duplicate is rejected; an INACTIVE (removed) entry is
    ///         refreshed to the new config and re-activated in place. Lives in this
    ///         delegatecall-linked library so the scan/write logic stays out of the
    ///         EIP-170-tight basket-vault bytecode.
    /// @return reusedIndex The registry index of the inactive entry that was
    ///         reactivated in place (the caller must NOT push); or
    ///         `type(uint256).max` when the token is new and the caller must push.
    function reuseOrRejectDuplicate(
        AssetInfo[] storage assets,
        address token,
        address pool,
        uint24 swapFee,
        address adapter,
        Venue venue
    ) public returns (uint256 reusedIndex) {
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (assets[i].token != token) continue;
            if (assets[i].active) revert AssetAlreadyActive();
            assets[i].pool = pool;
            assets[i].swapFee = swapFee;
            assets[i].adapter = adapter;
            assets[i].venue = venue;
            assets[i].active = true;
            return i;
        }
        return type(uint256).max;
    }

    /// @notice The body of `BasketVault.removeAsset` (QA plan D6, SR-L12), delegatecall-linked so it runs as the vault
    ///         and stays out of the EIP-170-tight vault bytecode. Deactivates the ACTIVE entry at `index` when the vault
    ///         holds none of its token, or only dust: a balance whose TWAP sale floor
    ///         (`value * (10_000 - maxSlippageBps) / 10_000`, the vault's `_applySlippage`) rounds to zero USDC units.
    ///         That is the same test on which `BasketVault.emergencyUnwind` and `redeem` skip a leg, so an unwind always
    ///         leaves a removable balance.
    /// @dev Why dust and not zero: anyone can send the vault one wei after the unwind. The Uniswap V4 adapter refuses a
    ///      sale that pays zero (`UniswapV4SwapAdapter.unlockCallback`), so that wei could never be sold, and a zero
    ///      balance check reverted `AssetStillHeld` forever. The dust check reads the TWAP through the vault, so it fails
    ///      closed while the oracle is down. A zero balance needs no price. The dust left on the removed entry drops out
    ///      of NAV (at most about one USDC unit), and `reabsorbRemovedAsset` sells it back once it grows past dust.
    /// @return token The deactivated token, for the vault's `AssetRemoved` event.
    function deactivateAsset(AssetInfo[] storage assets, uint256 index)
        public
        returns (address token)
    {
        if (index >= assets.length || !assets[index].active) revert AssetNotFound();
        token = assets[index].token;
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) {
            // Runs as the vault (delegatecall): price the balance through the vault's own TWAP view.
            IDustPricedVault self = IDustPricedVault(address(this));
            uint256 floor = self.assetUsdcValue(index, bal) * (10_000 - self.maxSlippageBps()) / 10_000;
            if (floor > 0) revert AssetStillHeld();
        }
        assets[index].active = false;
    }

    /// @notice Vet a non-zero adapter's codehash against the allowlist (ADP-2 / NC-2).
    ///         The default Uniswap V3 path (adapter == 0) needs no vetting.
    function requireAllowedAdapter(address adapter, bool allowed) public pure {
        if (adapter != address(0) && !allowed) revert AdapterCodeHashNotAllowed();
    }

    /// @notice Assert the execution pool resolved from `swapFee` is the SAME pool
    ///         the NAV TWAP reads from (ORA-3 / F-09): fee tier for V3/V4, tick
    ///         spacing for Aerodrome. `swapFee == 0` is the pool-independent-pricing
    ///         sentinel and is exempt. No shipped asset uses it: the basket deploy
    ///         script requires a non-zero `poolFee` (`contracts/script/BasketVaultDeployBase.sol`).
    function requireExecutionPoolMatchesTwap(address pool, uint24 swapFee, Venue venue)
        public
        view
    {
        if (swapFee == 0) return;
        uint256 poolParam = venue == Venue.Aerodrome
            ? uint256(uint24(IAerodromePool(pool).tickSpacing()))
            : uint256(IUniswapV3Pool(pool).fee());
        if (poolParam != uint256(swapFee)) revert ExecutionPoolMismatch();
    }

    /// @notice The payout loop of `BasketVault.redeemInKind` (core 1665), delegatecall-linked so it
    ///         runs as the vault (`address(this)` is the vault) and stays out of the EIP-170-tight
    ///         vault bytecode. Pays `receiver` the floor-pro-rata share (`shares / supplyBefore`) of
    ///         the vault's idle USDC and of each ACTIVE basket token. `exitFeeBps` of each leg goes to
    ///         `feeRecipient`. No oracle read and no swap. The caller has already burned `shares`.
    function payInKind(
        AssetInfo[] storage assets,
        address receiver,
        uint256 shares,
        uint256 supplyBefore
    ) public {
        // Runs as the vault (delegatecall): read the vault's own public config through a self-call.
        IInKindVault self = IInKindVault(address(this));
        address usdc = self.asset();
        uint256 exitFeeBps = self.exitFeeBps();
        address feeRecipient = self.feeRecipient();
        uint256 len = assets.length;
        // Same entry gas floor as `BasketVault.redeem` (REDEEM_BASE_GAS 300_000 + 400_000 per listed asset).
        uint256 floor = 300_000 + len * 400_000;
        if (gasleft() < floor) revert InsufficientGas(gasleft(), floor);
        _payLeg(IERC20(usdc), receiver, shares, supplyBefore, exitFeeBps, feeRecipient);
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            _payLeg(
                IERC20(assets[i].token), receiver, shares, supplyBefore, exitFeeBps, feeRecipient
            );
        }
    }

    function _payLeg(
        IERC20 token,
        address receiver,
        uint256 shares,
        uint256 supplyBefore,
        uint256 exitFeeBps,
        address feeRecipient
    ) private {
        uint256 amount = token.balanceOf(address(this)).mulDiv(shares, supplyBefore);
        if (amount == 0) return;
        uint256 fee = amount.mulDiv(exitFeeBps, 10_000);
        if (fee > 0) token.safeTransfer(feeRecipient, fee);
        token.safeTransfer(receiver, amount - fee);
    }
}
