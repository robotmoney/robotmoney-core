// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0006-despxa-rwa-vault-design.md — deSPXA asset, Chronicle
//              oracle, Aerodrome swap-only entry/exit, freeze risk;
//            docs/adr/ADR-0010-unified-vault-architecture.md §4 (AssetPositionAdapter);
//            docs/technical/unified-vault-spec.md §4.3, §4.4 (Chronicle variant);
//            docs/technical/unified-vault-seam-map.json (contracts/adapters/ entry,
//              "Chronicle-priced deSPXA AssetPositionAdapter" row, #1126).
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {IBasketSwapAdapter} from "../interfaces/IBasketSwapAdapter.sol";
import {IChronicleOracle} from "../interfaces/IChronicleOracle.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";

/// @title DeSpxaAssetPositionAdapter
/// @notice The Chronicle-priced `IPositionAdapter` for rmRWA (ADR-0010 §4,
///         unified-vault-spec §4.3/§4.4): it custodies deSPXA and prices it via
///         a Chronicle on-chain push oracle instead of a DEX TWAP — Aerodrome
///         liquidity for deSPXA is too thin for a manipulation-resistant TWAP
///         (ADR-0006 §2). `deploy`/`withdraw` convert USDC<->deSPXA through the
///         `SWAP_ADAPTER` venue seam (a `ChronicleOracleAdapter` instance, which
///         itself routes execution through Aerodrome and reads Chronicle for
///         pricing — see unified-vault-seam-map.json's "ChronicleOracleAdapter
///         remain stateless executors" row). This adapter is the ONE place that
///         enforces the Chronicle heartbeat-staleness gate: `ChronicleOracleAdapter`
///         is deliberately stateless and does not check staleness itself.
///
/// @dev    ## Heartbeat staleness (ORA-2 fail-closed)
///         Every price-dependent path (`deploy`, `withdraw`, and `totalAssets`
///         when the position is non-empty) reverts `StalePriceFeed` when the
///         Chronicle feed's `latestTimestamp()` is older than `oracleHeartbeat`
///         seconds. A stale price is REJECTED, never silently used. Mirrors
///         `RwaVault.oracleHeartbeat` / `MAX_HEARTBEAT` / `StalePriceFeed`
///         (spec §4.4: "default 24h, cap MAX_HEARTBEAT 48h").
///
///         ## Freeze-safety (deSPXA issuer freeze-control risk, ADR-0006 §3)
///         The deSPXA issuer may freeze token transfers at any time. A freeze
///         makes `deploy`/`withdraw` revert (the underlying Aerodrome swap
///         cannot move a frozen token) — existing custody is neither lost nor
///         mis-marked. `totalAssets()` NEVER attempts a transfer: it is a pure
///         `balanceOf` read (unaffected by a transfer freeze) combined with a
///         view-only Chronicle price read, so a freeze cannot brick vault NAV
///         summation. This is the adapter half of "excluded-not-confiscated":
///         a frozen position keeps accruing/reporting its last-known-good NAV
///         mark instead of reverting the whole vault's `totalAssets()`.
///
///         ## Zero-balance short-circuit (SUP-5)
///         `totalAssets()` returns 0 on an empty position WITHOUT touching the
///         oracle — matches `RwaVault._holdsPricedRwa()` / `UniswapV3AssetPositionAdapter`.
///
///         `isExact()` is hardcoded `false`: like the DEX-TWAP asset adapters,
///         `deploy`/`withdraw` are slippage-priced swaps and `totalAssets()` is
///         an oracle mark, not a 1:1 redemption claim.
contract DeSpxaAssetPositionAdapter is IPositionAdapter {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ─── Constants ────────────────────────────────────────────────────

    uint256 internal constant MAX_BPS = 10_000;

    /// @notice Hard ceiling for the per-swap slippage tolerance (5%). Mirrors
    ///         `UniswapV3AssetPositionAdapter.MAX_SLIPPAGE_BPS`.
    uint256 public constant MAX_SLIPPAGE_BPS = 500;

    /// @notice Default per-swap slippage tolerance (0.5%), tighter than the DEX-TWAP
    ///         adapters because slippage is anchored to the Chronicle NAV price,
    ///         not an Aerodrome TWAP. Mirrors `RwaVault._DEFAULT_SLIPPAGE_BPS`.
    uint256 public constant DEFAULT_SLIPPAGE_BPS = 50;

    /// @notice Minimum permitted heartbeat (1 hour). Prevents ADMIN from setting
    ///         an unreasonably tight window that would halt operations on normal
    ///         Chronicle push cadence.
    uint256 public constant MIN_HEARTBEAT = 1 hours;

    /// @notice Maximum permitted heartbeat (48 hours). Prevents ADMIN from setting
    ///         an arbitrarily long window that would allow a stale price to be
    ///         used for days. Mirrors `RwaVault.MAX_HEARTBEAT`.
    uint256 public constant MAX_HEARTBEAT = 48 hours;

    /// @notice Default Chronicle heartbeat window (24 hours). Mirrors
    ///         `RwaVault.DEFAULT_HEARTBEAT`.
    uint256 public constant DEFAULT_HEARTBEAT = 24 hours;

    /// @notice The `ADMIN_ROLE` bytes32 queried on `VAULT` for config setters.
    /// @dev Matches `BasketVault.ADMIN_ROLE` / `RobotMoneyVault.ADMIN_ROLE`.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── Immutables ───────────────────────────────────────────────────

    /// @inheritdoc IPositionAdapter
    address public immutable USDC;
    /// @inheritdoc IPositionAdapter
    address public immutable VAULT;
    /// @notice The deSPXA token this adapter custodies and prices.
    address public immutable TOKEN;
    /// @notice Chronicle NAV oracle for `TOKEN`. Must be "kissed" (whitelisted)
    ///         for this adapter's address before `latestAnswer`/`latestTimestamp`
    ///         can be read — see `IChronicleOracle`.
    IChronicleOracle public immutable CHRONICLE;
    /// @notice Venue executor implementing the `IBasketSwapAdapter` swap+price
    ///         seam. Expected to be a `ChronicleOracleAdapter` instance (Aerodrome
    ///         execution, Chronicle pricing) bound to the same `CHRONICLE` feed.
    IBasketSwapAdapter public immutable SWAP_ADAPTER;

    // ─── Per-instance config (onlyVaultAdmin) ─────────────────────────

    /// @notice Per-swap slippage tolerance in bps (the min-out floor). Bounded
    ///         above by `MAX_SLIPPAGE_BPS`.
    uint256 public maxSlippageBps;

    /// @notice Staleness heartbeat window in seconds. Price-dependent operations
    ///         revert `StalePriceFeed` when the Chronicle feed age exceeds this
    ///         value. Admin-settable within `[MIN_HEARTBEAT, MAX_HEARTBEAT]`.
    uint256 public oracleHeartbeat;

    // ─── Errors ───────────────────────────────────────────────────────
    // OnlyVault / SlippageExceeded are inherited from IPositionAdapter and are
    // NOT re-declared here (#1116 frozen surface).

    /// @dev A constructor immutable was the zero address.
    error ZeroAddress();
    /// @dev A config setter received an out-of-range value.
    error InvalidParam();
    /// @dev The caller is not the `VAULT`'s ADMIN_ROLE holder (config setters).
    error OnlyVaultAdmin();
    /// @dev Raised when the Chronicle feed has not been updated within
    ///      `oracleHeartbeat` seconds. Rejects a stale price rather than using it
    ///      (ORA-2 fail-closed) — see `RwaVault.StalePriceFeed`.
    error StalePriceFeed(uint256 updatedAt, uint256 heartbeat);

    // ─── Events ───────────────────────────────────────────────────────

    event MaxSlippageUpdated(uint256 oldBps, uint256 newBps);
    event OracleHeartbeatUpdated(uint256 oldHeartbeat, uint256 newHeartbeat);
    event Deployed(uint256 usdcIn, uint256 valueAdded);
    event Withdrawn(uint256 usdcWanted, uint256 usdcOut);

    // ─── Modifiers ─────────────────────────────────────────────────────

    /// @dev Every mutating position path is `onlyVault` (INV-1 authority binding).
    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    /// @dev Config setters are gated by the VAULT's transitive `ADMIN_ROLE`; the
    ///      adapter carries no independent role tree (seam-map contracts/adapters/).
    modifier onlyVaultAdmin() {
        if (!IAccessControl(VAULT).hasRole(ADMIN_ROLE, msg.sender)) revert OnlyVaultAdmin();
        _;
    }

    // ─── Constructor ────────────────────────────────────────────────────

    /// @param usdc_        USDC token this adapter denominates in.
    /// @param vault_       The single vault this adapter is bound to (INV-1).
    /// @param token_       The deSPXA token custodied and priced.
    /// @param chronicle_   Chronicle NAV oracle for `token_`.
    /// @param swapAdapter_ Venue executor implementing `IBasketSwapAdapter`
    ///                     (Aerodrome execution + Chronicle pricing).
    constructor(
        address usdc_,
        address vault_,
        address token_,
        address chronicle_,
        address swapAdapter_
    ) {
        if (
            usdc_ == address(0) || vault_ == address(0) || token_ == address(0)
                || chronicle_ == address(0) || swapAdapter_ == address(0)
        ) {
            revert ZeroAddress();
        }

        USDC = usdc_;
        VAULT = vault_;
        TOKEN = token_;
        CHRONICLE = IChronicleOracle(chronicle_);
        SWAP_ADAPTER = IBasketSwapAdapter(swapAdapter_);

        maxSlippageBps = DEFAULT_SLIPPAGE_BPS;
        oracleHeartbeat = DEFAULT_HEARTBEAT;
    }

    // ─── IPositionAdapter: position lifecycle ───────────────────────────

    /// @inheritdoc IPositionAdapter
    /// @dev Choreography: the vault has already `safeTransfer`ed `usdcIn` USDC to
    ///      this adapter. Fails closed on a stale Chronicle price (ORA-2), swaps
    ///      USDC→TOKEN through the venue seam with a Chronicle-derived min-out,
    ///      and credits the realized USDC-denominated increase in `totalAssets()`.
    ///      Reverts `SlippageExceeded` when `valueAdded < minValueOut` (no clamp).
    ///      Reverts (bubbling the venue's revert) if deSPXA transfers are frozen —
    ///      this is expected fail-closed behavior on the mutating path (ADR-0006
    ///      §3); it does NOT brick `totalAssets()` (see contract-level NatSpec).
    function deploy(uint256 usdcIn, uint256 minValueOut)
        external
        onlyVault
        returns (uint256 valueAdded)
    {
        if (usdcIn == 0) return 0;
        _checkOracleFreshness();

        // slither-disable-start reentrancy-balance
        // Justification: `taBefore`/post-swap `totalAssets()` is the standard
        // balance-delta pattern to measure the realized NAV increase the swap
        // delivered. Only the `VAULT` (whose deposit entrypoint is `nonReentrant`
        // at the call site) can call this `onlyVault` function, so re-entry via
        // `SWAP_ADAPTER.swap` is not reachable; USDC/TOKEN are not ERC777 tokens.
        uint256 taBefore = totalAssets();

        // Venue min-out floor = Chronicle-priced TOKEN estimate haircut by the
        // configured slippage bound. `pool`/`window` are unused by the Chronicle
        // pricing path (pool-independent, epoch-independent — see
        // `ChronicleOracleAdapter.twapPrice`).
        uint256 expectedToken = SWAP_ADAPTER.twapPrice(address(0), USDC, TOKEN, usdcIn, 0);
        uint256 minTokenOut = expectedToken.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);

        IERC20(USDC).forceApprove(address(SWAP_ADAPTER), usdcIn);
        SWAP_ADAPTER.swap(USDC, TOKEN, 0, usdcIn, minTokenOut, address(this), block.timestamp);
        IERC20(USDC).forceApprove(address(SWAP_ADAPTER), 0);

        // Credit the realized NAV delta (spec §2.2). taBefore/after are Chronicle
        // oracle marks.
        valueAdded = totalAssets() - taBefore;
        // slither-disable-end reentrancy-balance
        if (valueAdded < minValueOut) revert SlippageExceeded();
        emit Deployed(usdcIn, valueAdded);
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Liquidates enough TOKEN to raise `usdcWanted` USDC (Chronicle-estimated),
    ///      clamped at the held balance (`type(uint256).max` ⇒ sell all). The
    ///      effective floor is `max(minUsdcOut, adapterInternalFloor)` where the
    ///      internal floor is the slippage-haircut Chronicle value of the tokens
    ///      sold; shortfall against the floor reverts `SlippageExceeded`, shortfall
    ///      against `usdcWanted` above the floor clamps. Proceeds are delivered
    ///      straight to `VAULT`. Fails closed on a stale Chronicle price (ORA-2)
    ///      whenever the position is non-empty. Reverts (bubbling the venue's
    ///      revert) if deSPXA transfers are frozen — expected fail-closed
    ///      behavior on the mutating path; does NOT brick `totalAssets()`.
    function withdraw(uint256 usdcWanted, uint256 minUsdcOut)
        external
        onlyVault
        returns (uint256 usdcOut)
    {
        // slither-disable-start reentrancy-balance
        // Justification: `tokenBal` is the standard held-balance read used to size
        // and clamp the liquidation, and `usdcOut` is the swap's realized proceeds.
        // Only the `VAULT` (whose withdraw entrypoint is `nonReentrant` at the call
        // site) can call this `onlyVault` function, so re-entry via
        // `SWAP_ADAPTER.swap`/`twapPrice` is not reachable; TOKEN/USDC are not
        // ERC777 tokens.
        uint256 tokenBal = IERC20(TOKEN).balanceOf(address(this));
        if (tokenBal == 0) return 0;
        _checkOracleFreshness();

        // How much TOKEN to sell to raise usdcWanted (clamped at balance).
        uint256 tokenToSell;
        if (usdcWanted == type(uint256).max) {
            tokenToSell = tokenBal;
        } else {
            tokenToSell = SWAP_ADAPTER.twapPrice(address(0), USDC, TOKEN, usdcWanted, 0);
            if (tokenToSell > tokenBal) tokenToSell = tokenBal;
        }
        if (tokenToSell == 0) return 0;

        // Adapter-internal floor = slippage-haircut Chronicle USDC value of
        // tokens sold.
        uint256 chronicleUsdc = SWAP_ADAPTER.twapPrice(address(0), TOKEN, USDC, tokenToSell, 0);
        uint256 internalFloor = chronicleUsdc.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);
        uint256 effectiveFloor = minUsdcOut > internalFloor ? minUsdcOut : internalFloor;

        // Pass the internal floor as the venue amountOutMinimum (defence-in-depth);
        // the composed `effectiveFloor` is enforced below with the canonical
        // SlippageExceeded selector (spec §2.2 floor composition).
        IERC20(TOKEN).forceApprove(address(SWAP_ADAPTER), tokenToSell);
        usdcOut =
            SWAP_ADAPTER.swap(TOKEN, USDC, 0, tokenToSell, internalFloor, VAULT, block.timestamp);
        IERC20(TOKEN).forceApprove(address(SWAP_ADAPTER), 0);

        if (usdcOut < effectiveFloor) revert SlippageExceeded();
        // slither-disable-end reentrancy-balance
        emit Withdrawn(usdcWanted, usdcOut);
    }

    // ─── IPositionAdapter: views ────────────────────────────────────────

    /// @inheritdoc IPositionAdapter
    /// @dev Chronicle-priced USDC value of the held TOKEN. Returns 0 on a zero
    ///      balance WITHOUT touching the oracle (SUP-5). Fails closed with
    ///      `StalePriceFeed` when the Chronicle feed is stale AND the position is
    ///      non-empty (ORA-2) — matches `RwaVault.totalAssets`/`_holdsPricedRwa`.
    ///      Freeze-safe: this is a pure `balanceOf` + view-only oracle read, never
    ///      a token transfer, so a deSPXA transfer freeze cannot brick this value
    ///      (contract-level NatSpec).
    function totalAssets() public view returns (uint256) {
        uint256 bal = IERC20(TOKEN).balanceOf(address(this));
        if (bal == 0) return 0;
        _checkOracleFreshness();
        return SWAP_ADAPTER.twapPrice(address(0), TOKEN, USDC, bal, 0);
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Always `false`: oracle-priced asset custody swapped through a venue
    ///      is never a 1:1 redemption claim.
    function isExact() external pure returns (bool) {
        return false;
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Spot deSPXA custody has no discrete claimable reward tokens — this is
    ///      a no-op and MUST NOT revert (INV-2). NAV appreciation accrues in the
    ///      held TOKEN balance / Chronicle mark and is already reflected in
    ///      `totalAssets()`.
    function harvestRewards() external {}

    /// @inheritdoc IPositionAdapter
    /// @dev Protected set: USDC and the custodied `TOKEN` (both stay in NAV and
    ///      accrue pro-rata) — reverts on those (INV-2). Everything else is swept
    ///      permissionlessly to the fixed quarantine sink (never caller-supplied,
    ///      INV-1).
    function sweepForeignToken(address token) external {
        if (token == USDC || token == TOKEN) {
            revert ForeignTokenQuarantine.TokenIsProtected(token);
        }
        ForeignTokenQuarantine.sweep(token, msg.sender);
    }

    // ─── Oracle freshness ─────────────────────────────────────────────

    /// @notice Reverts with `StalePriceFeed` if the Chronicle feed has not been
    ///         updated within `oracleHeartbeat` seconds.
    /// @dev Called by `deploy`, `withdraw` (unconditionally — both are
    ///      price-dependent regardless of current custody), and `totalAssets`
    ///      (gated on non-zero balance, SUP-5). Any price-sensitive operation
    ///      halts when the feed is stale, consistent with the "fail closed"
    ///      philosophy in ADR-0006 §2 / unified-vault-spec §4.4 ORA-2.
    function _checkOracleFreshness() internal view {
        uint256 updatedAt = CHRONICLE.latestTimestamp();
        uint256 heartbeat = oracleHeartbeat;
        if (block.timestamp > updatedAt + heartbeat) {
            revert StalePriceFeed(updatedAt, heartbeat);
        }
    }

    // ─── Config setters (onlyVaultAdmin) ────────────────────────────────

    /// @notice Set the per-swap slippage tolerance (min-out floor). Bounded above
    ///         by `MAX_SLIPPAGE_BPS`.
    function setMaxSlippageBps(uint256 newBps) external onlyVaultAdmin {
        if (newBps > MAX_SLIPPAGE_BPS) revert InvalidParam();
        emit MaxSlippageUpdated(maxSlippageBps, newBps);
        maxSlippageBps = newBps;
    }

    /// @notice Update the Chronicle staleness heartbeat. Restricted to
    ///         `onlyVaultAdmin`. Must fall in `[MIN_HEARTBEAT, MAX_HEARTBEAT]`.
    function setOracleHeartbeat(uint256 newHeartbeat) external onlyVaultAdmin {
        if (newHeartbeat < MIN_HEARTBEAT || newHeartbeat > MAX_HEARTBEAT) {
            revert InvalidParam();
        }
        emit OracleHeartbeatUpdated(oracleHeartbeat, newHeartbeat);
        oracleHeartbeat = newHeartbeat;
    }
}
