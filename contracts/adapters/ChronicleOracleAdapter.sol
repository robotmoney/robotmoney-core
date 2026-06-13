// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0006-despxa-rwa-vault-design.md §2 — Chronicle NAV oracle
//            docs/adr/ADR-0006-despxa-rwa-vault-design.md §3 — Aerodrome swap routing
// (See also: docs/technical/real-four-vault-demo-seams.md §3 — BasketVault swap seam;
//            docs/architecture.md §4.1 — Vault Family)
//
// Implements IBasketSwapAdapter for the deSPXA RWA vault:
//   - Swaps are routed through the Aerodrome Router (same as AerodromeSwapAdapter).
//   - NAV pricing uses the Chronicle push oracle instead of a DEX TWAP.
//     The `window` parameter accepted by `twapPrice()` is ignored; Chronicle provides
//     a single signed price that is authoritative regardless of the lookback window.
//   - The Chronicle oracle heartbeat staleness check is enforced at the RwaVault level
//     (in RwaVault._checkOracleFreshness), not here, to keep this adapter stateless.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IBasketSwapAdapter} from "../interfaces/IBasketSwapAdapter.sol";
import {IChronicleOracle} from "../interfaces/IChronicleOracle.sol";
import {IAerodromeRouter} from "../interfaces/IAerodromeRouter.sol";

/// @title ChronicleOracleAdapter
/// @notice BasketVault swap adapter that routes trades through Aerodrome Finance
///         and prices NAV via a Chronicle on-chain push oracle.
///
///         **Why Chronicle instead of TWAP?**
///         deSPXA is a thinly-traded RWA token — Aerodrome DEX liquidity is
///         insufficient to derive a manipulation-resistant TWAP. Chronicle's
///         attestor network pushes signed NAV prices directly on-chain, providing
///         an issuer-sanctioned price reference independent of DEX spot conditions.
///         See ADR-0006 §2 for the full rationale.
///
///         **Staleness enforcement** is handled by RwaVault (via the `heartbeat`
///         parameter at vault construction) rather than in this adapter.
///         This keeps the adapter stateless and reusable across any vault that
///         wants Chronicle pricing with Aerodrome routing.
///
///         **Freeze-control risk:** If the deSPXA issuer freezes token transfers,
///         all Aerodrome swaps through this adapter will revert. This is an
///         inherent property of the RWA asset and is disclosed in ADR-0006 §4.
///
///         **Price scaling:**
///         Chronicle returns prices in 18-decimal WAD format (1e18 = 1 USD).
///         USDC uses 6 decimals. deSPXA uses 18 decimals (standard ERC-20).
///         All arithmetic is normalised to 18-decimal precision before scaling
///         down to the output token's decimals.
contract ChronicleOracleAdapter is IBasketSwapAdapter {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ─── Constants ────────────────────────────────────────────────────

    /// @dev 1e18 — Chronicle oracle price scale. Chronicle reports NAV in
    ///      units of USDC per deSPXA, scaled to 18 decimal places (WAD).
    uint256 private constant WAD = 1e18;

    /// @notice Minimum acceptable NAV price from the Chronicle oracle in WAD.
    ///         Any price below this threshold is considered invalid and will
    ///         cause twapPrice() to revert. Set to 1e12 (0.000001 USD per RWA
    ///         token) — well below any realistic deSPXA peg but safely above
    ///         zero to catch malfunctioning or manipulated oracles.
    /// @dev    1e12 in WAD corresponds to 1e-6 USD given WAD = 1e18.
    uint256 public constant MIN_NAV = 1e12;

    /// @notice Maximum acceptable NAV price from the Chronicle oracle in WAD.
    ///         Any price above this threshold is considered invalid and will
    ///         cause twapPrice() to revert. Set to 1e24 (1,000,000 USD per RWA
    ///         token) — far above any plausible deSPXA price but tight enough
    ///         to guard against extreme oracle malfunctions.
    /// @dev    1e24 in WAD corresponds to 1e6 USD given WAD = 1e18.
    uint256 public constant MAX_NAV = 1e24;

    // ─── Immutables ───────────────────────────────────────────────────

    /// @notice Aerodrome Router used for all swaps.
    IAerodromeRouter public immutable ROUTER;

    /// @notice Pool factory embedded in Aerodrome Route structs.
    address public immutable FACTORY;

    /// @notice Whether the Aerodrome route uses the stable-swap curve.
    bool public immutable STABLE;

    /// @notice Chronicle NAV oracle for the RWA asset (deSPXA on Base).
    /// @dev Must be whitelisted ("kissed") for this adapter's address before
    ///      `twapPrice()` can be called. See IChronicleOracle for details.
    IChronicleOracle public immutable ORACLE;

    /// @notice RWA asset token address (deSPXA). Used to determine price
    ///         direction: USDC→deSPXA or deSPXA→USDC.
    address public immutable RWA_TOKEN;

    /// @notice USDC token address. Used for price direction calculation.
    address public immutable USDC;

    // ─── Errors ───────────────────────────────────────────────────────

    /// @dev Raised when any required address argument is address(0).
    error ZeroAddress();

    /// @dev Raised when the price direction cannot be determined —
    ///      neither (baseToken=RWA, quoteToken=USDC) nor
    ///      (baseToken=USDC, quoteToken=RWA) matches the expected pair.
    error UnknownPricePair(address baseToken, address quoteToken);

    /// @dev Raised when the Chronicle oracle returns a NAV price that is
    ///      zero or outside the accepted [MIN_NAV, MAX_NAV] range.
    error BadNavPrice(uint256 navPrice);

    /// @dev Raised when the Aerodrome Router returns an empty amounts array,
    ///      which would otherwise underflow the output-index read
    ///      (audit 2026-06-09, L-7).
    error EmptyRouterAmounts();

    // ─── Constructor ─────────────────────────────────────────────────

    /// @param router_   Aerodrome Router address.
    /// @param factory_  Pool factory address embedded in Aerodrome Route structs.
    /// @param stable_   Whether the Aerodrome route uses the stable-swap curve.
    /// @param oracle_   Chronicle NAV feed for `rwaToken_`.
    /// @param rwaToken_ RWA asset token (deSPXA).
    /// @param usdc_     USDC token address.
    constructor(
        address router_,
        address factory_,
        bool stable_,
        address oracle_,
        address rwaToken_,
        address usdc_
    ) {
        if (
            router_ == address(0) || factory_ == address(0) || oracle_ == address(0)
                || rwaToken_ == address(0) || usdc_ == address(0)
        ) revert ZeroAddress();
        ROUTER = IAerodromeRouter(router_);
        FACTORY = factory_;
        STABLE = stable_;
        ORACLE = IChronicleOracle(oracle_);
        RWA_TOKEN = rwaToken_;
        USDC = usdc_;
    }

    // ─── IBasketSwapAdapter: swap ─────────────────────────────────────

    /// @inheritdoc IBasketSwapAdapter
    /// @dev Routes via Aerodrome. The `fee` parameter is ignored (Aerodrome
    ///      derives fee from pool config). The swap reverts if the deSPXA
    ///      issuer has frozen transfers — see ADR-0006 §4 (freeze-control risk).
    ///      The caller-chosen `deadline` is forwarded to the Aerodrome Router,
    ///      which reverts when expired (audit 2026-06-09, L-5).
    function swap(
        address tokenIn,
        address tokenOut,
        uint24, /* fee — unused by Aerodrome */
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        if (tokenIn == address(0) || tokenOut == address(0)) revert ZeroAddress();
        if (amountIn == 0) return 0;

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(ROUTER), amountIn);

        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] =
            IAerodromeRouter.Route({from: tokenIn, to: tokenOut, stable: STABLE, factory: FACTORY});

        uint256[] memory amounts =
            ROUTER.swapExactTokensForTokens(amountIn, minAmountOut, routes, recipient, deadline);

        IERC20(tokenIn).forceApprove(address(ROUTER), 0);

        // The router returns one amount per hop; the last element is the output.
        // Guard the index read against a malformed empty return (audit L-7).
        if (amounts.length == 0) revert EmptyRouterAmounts();
        amountOut = amounts[amounts.length - 1];
    }

    // ─── IBasketSwapAdapter: twapPrice (Chronicle NAV) ────────────────

    /// @inheritdoc IBasketSwapAdapter
    /// @dev Uses the Chronicle NAV oracle instead of a DEX TWAP.
    ///      The `pool` and `window` parameters are unused — Chronicle provides
    ///      a single signed price that is authoritative regardless of DEX state
    ///      or lookback window. Both parameters are kept for interface uniformity.
    ///
    ///      Price direction:
    ///      - (baseToken=RWA, quoteToken=USDC): RWA → USDC
    ///        quoteAmount = baseAmount * navPrice / WAD * usdcScale / rwaScale
    ///      - (baseToken=USDC, quoteToken=RWA): USDC → RWA
    ///        quoteAmount = baseAmount * WAD / navPrice * rwaScale / usdcScale
    ///
    ///      Decimal scaling:
    ///        navPrice is in WAD (18 dec). deSPXA is 18 dec. USDC is 6 dec.
    ///        navPrice units: USDC per deSPXA, both expressed in WAD.
    ///        e.g. if 1 deSPXA = 5.00 USDC: navPrice = 5e18.
    ///
    ///      Staleness check: NOT enforced here — RwaVault calls
    ///      `_checkOracleFreshness()` on every price-sensitive operation before
    ///      delegating to this adapter.
    function twapPrice(
        address, /* pool — unused; Chronicle is pool-independent */
        address baseToken,
        address quoteToken,
        uint256 baseAmount,
        uint32 /* window — unused; Chronicle is epoch-independent */
    )
        external
        view
        returns (uint256 quoteAmount)
    {
        if (baseToken == address(0) || quoteToken == address(0)) revert ZeroAddress();
        if (baseAmount == 0) return 0;

        uint256 navPrice = ORACLE.latestAnswer(); // WAD: USDC per RWA, 18 dec

        if (navPrice < MIN_NAV || navPrice > MAX_NAV) {
            revert BadNavPrice(navPrice);
        }

        if (baseToken == RWA_TOKEN && quoteToken == USDC) {
            // RWA → USDC: quoteAmount in USDC (6 dec)
            // navPrice: 1e18 units of RWA = navPrice units of USDC (both 1e18 scaled)
            // quoteAmount [6 dec] = baseAmount [18 dec] * navPrice [18 dec] / 1e18 / 1e12
            quoteAmount = baseAmount.mulDiv(navPrice, WAD * 1e12);
        } else if (baseToken == USDC && quoteToken == RWA_TOKEN) {
            // USDC → RWA: quoteAmount in RWA (18 dec)
            // quoteAmount [18 dec] = baseAmount [6 dec] * 1e12 * WAD / navPrice
            quoteAmount = (baseAmount * 1e12).mulDiv(WAD, navPrice);
        } else {
            revert UnknownPricePair(baseToken, quoteToken);
        }
    }
}
