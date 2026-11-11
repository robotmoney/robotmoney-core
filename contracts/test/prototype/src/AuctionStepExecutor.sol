// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §10 phase 3c (G4 fallback), §12 (auction-based
//            rebalance), §13 (scoring), §5.3 (one step), §7 RB-2, RB-3, RB-4, RB-5
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

// ─── Model note (phase 3c) ─────────────────────────────────────────────────────────────────────────────
//
// What this is. A descending-price (Dutch) auction for each basket leg of one rebalance step. It sits behind
// the existing `executeStep` interface as the basket assets' swap adapter. The fund, the Rebalancer and the
// step order do not change. Every assumption below is chosen to make the auction look worse, not better,
// unless it says otherwise.
//
// The auction.
// - Anyone may `open()` it once `Rebalancer.previewStep()` says a step would trade. That starts the clock.
// - Anyone may `fill()` it. The filler is the solver. `fill()` calls `Rebalancer.step()`, so legs, notional
//   and floors come from chain state as before. The filler chooses only when (RB-2).
// - Each basket leg is priced against its own TWAP quote q (the fund's valuation path). The fund is owed
//   q × (1 + START_PREMIUM_BPS) at the open. That falls linearly to the step's own TWAP floor (`minOut`, the
//   same floor the swap path uses) over DURATION seconds. It then stays at the floor. It is never below it.
// - Fills are allowed until openedAt + 2 × DURATION. After that the auction lapses and anyone may reopen it.
// - The filler receives the fund's input tokens and must pay the owed output to the fund in the same call.
//   The recipient is always the fund (RB-3). A short payment reverts the whole fill: no step, no backoff.
// - A fill that does not execute a step reverts. So a filler cannot book a fake failure or force a backoff.
// - Outside a fill (deposits, redemptions, emergency unwind, or a direct keeper or grace `step()`), `swap`
//   passes through to the pool adapter unchanged.
//
// Solver behaviour (modelled in sim/RebalanceSim.t.sol, PROTO_SIM_RUN=auction).
// - One solver. No competition, so the fund gets that solver's reservation price, never a better bid.
// - No inventory. The solver sources each leg after it receives the fund's tokens.
// - Venues: the same real Base pool, through SwapRouter02, at the fill block. Or an external venue:
//   wETH and cbBTC at the sim's reference price less 15 bps, at any hour (CEX fee, spread, transfer and
//   hedge). deSPXA at the reference less 25 bps, only in US equity hours (issuer mint or redeem). deSPXA has
//   no external venue when the S&P is closed.
// - The solver takes the better venue per leg, then keeps a 5 bps margin and 0.25 USDC gas per leg.
// - The external venue has unlimited depth at its spread. This one favours the auction. A step is at most
//   50,000 USDC, so it is a small fill for a CEX or an issuer.
// - An external fill leaves no impact in the pool. This also favours the auction. It is the reason to use one.
//
// Fill price and latency.
// - The solver fills at the first 2-second block where the owed amount is at or below its reservation,
//   plus one more block of latency. So the fund gets up to two block decrements less than the reservation.
// - The solver re-quotes at that fill block. The TWAP, the path notional and the floor move with time. If the
//   owed amount is now above its reservation, it waits for the new fill block and re-quotes again. After four
//   re-quotes it gives up and the auction lapses. The solver never fills at a loss to its own margin.
// - The sim moves pools only 600 s after a slot starts. So the market is static during the auction, and
//   the solver's quote at the open is its exact cost. The margin is pure take.
// - If the reservation is below the floor, nobody fills. The sim counts that attempt as a blocked StepFailed.
// - A filled slot lasts the step interval plus the fill delay, because the cooldown counts from the fill.
//   So auction latency costs the plan steps.

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBasketSwapAdapter} from "../../../interfaces/IBasketSwapAdapter.sol";
import {AssetConfig, AssetKind, SkipReason, BPS} from "./FundTypes.sol";
import {IRobotMoneyFund} from "./interfaces/IRobotMoneyFund.sol";
import {IRebalancer} from "./interfaces/IRebalancer.sol";

/// @notice The solver side of a fill. Called once per basket leg, after the fund's `amountIn` of `tokenIn`
///         reached the filler. Before it returns, the filler must approve this executor for `amountOwed` of
///         `tokenOut`. The executor then pulls it straight to the fund.
interface IAuctionFiller {
    function onAuctionLeg(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOwed,
        uint256 twapQuote,
        uint256 floor
    ) external;
}

/// @title AuctionStepExecutor
/// @notice Phase 3c fallback for G4. It is the basket assets' `IBasketSwapAdapter`. It forwards TWAP reads
///         to the pool adapter, so NAV and ORA-4 are unchanged. Inside `fill()` it prices each basket leg as a
///         Dutch auction against the TWAP and settles with the filler. Elsewhere it passes swaps through.
///         It holds no funds between calls. See the model note at the top of this file.
contract AuctionStepExecutor is IBasketSwapAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Events ──────────────────────────────────────────────────────────────

    event AuctionOpened(uint64 openedAt, uint256 expiresAt);
    event AuctionFilled(address indexed filler, uint256 elapsed);
    event AuctionLeg(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 twapQuote,
        uint256 floor,
        uint256 owed,
        uint256 elapsed,
        address filler
    );

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error InvalidParam();
    error NotDeployer();
    error AlreadyBound();
    error NotReady(SkipReason reason);
    error AuctionLive(uint256 expiresAt);
    error NoAuction();
    error AuctionExpired(uint256 expiredAt);
    error FillNotExecuted(SkipReason reason);
    error NotFundRecipient(address recipient);
    error NotABasketAsset(address token);
    error Underpaid(address token, uint256 owed, uint256 received);

    // ─── Configuration ───────────────────────────────────────────────────────

    /// @notice The pool adapter: TWAP quotes and pass-through swaps.
    IBasketSwapAdapter public immutable INNER;
    /// @notice The only caller whose swaps can be auctioned, and the only recipient of an auction leg.
    address public immutable FUND;
    address public immutable USDC;
    /// @notice May bind the Rebalancer once.
    address public immutable DEPLOYER;
    /// @notice Seconds from the open until the owed amount reaches the floor.
    uint32 public immutable DURATION;
    /// @notice Owed amount at the open, in bps above the leg's TWAP quote.
    uint16 public immutable START_PREMIUM_BPS;

    IRebalancer public rebalancer;

    // ─── State ───────────────────────────────────────────────────────────────

    /// @notice Start of the live auction. 0 when none is live.
    uint64 public openedAt;
    /// @dev Set only for the length of `fill()`. Zero means every swap passes through.
    address private _filler;
    uint256 private _elapsed;

    constructor(address inner, address fund, address usdc, uint32 duration, uint16 startPremiumBps) {
        if (inner == address(0) || fund == address(0) || usdc == address(0)) revert ZeroAddress();
        if (duration == 0 || startPremiumBps > BPS) revert InvalidParam();
        INNER = IBasketSwapAdapter(inner);
        FUND = fund;
        USDC = usdc;
        DEPLOYER = msg.sender;
        DURATION = duration;
        START_PREMIUM_BPS = startPremiumBps;
    }

    /// @notice Bind the Rebalancer whose `step()` a fill runs. Once, by the deployer. The Rebalancer's admin
    ///         (the timelock) must also grant this contract KEEPER_ROLE.
    function bindRebalancer(address rebalancer_) external {
        if (msg.sender != DEPLOYER) revert NotDeployer();
        if (address(rebalancer) != address(0)) revert AlreadyBound();
        if (rebalancer_ == address(0)) revert ZeroAddress();
        rebalancer = IRebalancer(rebalancer_);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Auction
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Start the clock for the next step. Anyone. Takes no input (RB-2). Reverts unless the
    ///         Rebalancer would trade now (so the cooldown and ORA-4 hold first, RB-5), or while one is live.
    function open() external nonReentrant {
        uint256 at = openedAt;
        if (at != 0 && block.timestamp <= at + 2 * uint256(DURATION)) revert AuctionLive(at + 2 * uint256(DURATION));
        (SkipReason r,,,) = rebalancer.previewStep();
        if (r != SkipReason.None) revert NotReady(r);
        openedAt = uint64(block.timestamp);
        emit AuctionOpened(uint64(block.timestamp), block.timestamp + 2 * uint256(DURATION));
    }

    /// @notice Fill the live auction: run one `Rebalancer.step()` with the caller as the solver of every basket
    ///         leg. Takes no input (RB-2). Reverts unless the step executed, so a fill never records a skip or
    ///         a backoff. Returns the seconds since the open.
    function fill() external nonReentrant returns (uint256 elapsed) {
        uint256 at = openedAt;
        if (at == 0) revert NoAuction();
        uint256 expires = at + 2 * uint256(DURATION);
        if (block.timestamp > expires) revert AuctionExpired(expires);
        elapsed = block.timestamp - at;
        _filler = msg.sender;
        _elapsed = elapsed;
        (bool executed, SkipReason reason) = rebalancer.step();
        _filler = address(0);
        _elapsed = 0;
        if (!executed) revert FillNotExecuted(reason);
        openedAt = 0;
        emit AuctionFilled(msg.sender, elapsed);
    }

    /// @notice What the fund is owed for a leg with TWAP quote `q` and floor `floor`, `elapsed` seconds after
    ///         the open. Starts at q × (1 + premium), falls linearly, and is never below `floor`.
    function owedAt(uint256 q, uint256 floor, uint256 elapsed) public view returns (uint256) {
        uint256 start = q * (BPS + START_PREMIUM_BPS) / BPS;
        if (start <= floor || elapsed >= DURATION) return floor;
        return start - (start - floor) * elapsed / DURATION;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  IBasketSwapAdapter
    // ═════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IBasketSwapAdapter
    /// @dev A leg of a live fill when the fund calls: TWAP-priced Dutch auction, settled with the filler.
    ///      Any other call passes through to `INNER` with the same arguments.
    function swap(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        address filler = _filler;
        if (filler == address(0) || msg.sender != FUND) {
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
            IERC20(tokenIn).forceApprove(address(INNER), amountIn);
            amountOut = INNER.swap(tokenIn, tokenOut, fee, amountIn, minAmountOut, recipient, deadline);
            IERC20(tokenIn).forceApprove(address(INNER), 0);
            return amountOut;
        }
        if (recipient != FUND) revert NotFundRecipient(recipient);
        if (amountIn == 0) return 0;
        uint256 q = _twapQuote(tokenIn, tokenOut, amountIn);
        uint256 elapsed = _elapsed;
        amountOut = owedAt(q, minAmountOut, elapsed);
        IERC20(tokenIn).safeTransferFrom(FUND, filler, amountIn);
        IAuctionFiller(filler).onAuctionLeg(tokenIn, tokenOut, amountIn, amountOut, q, minAmountOut);
        uint256 before = IERC20(tokenOut).balanceOf(FUND);
        IERC20(tokenOut).safeTransferFrom(filler, FUND, amountOut);
        uint256 got = IERC20(tokenOut).balanceOf(FUND) - before;
        if (got < amountOut) revert Underpaid(tokenOut, amountOut, got);
        emit AuctionLeg(tokenIn, tokenOut, amountIn, q, minAmountOut, amountOut, elapsed, filler);
    }

    /// @inheritdoc IBasketSwapAdapter
    function twapPrice(address pool, address baseToken, address quoteToken, uint256 baseAmount, uint32 window)
        external
        view
        returns (uint256)
    {
        return INNER.twapPrice(pool, baseToken, quoteToken, baseAmount, window);
    }

    /// @dev The fund's own TWAP quote for the leg: the active basket asset holding the non-USDC token, its pool
    ///      and window, through `INNER` (the same read as `FundValuationLib`).
    function _twapQuote(address tokenIn, address tokenOut, uint256 amountIn) internal view returns (uint256) {
        address token = tokenIn == USDC ? tokenOut : tokenIn;
        AssetConfig[] memory cfgs = IRobotMoneyFund(FUND).assetConfigs();
        for (uint256 i; i < cfgs.length; ++i) {
            AssetConfig memory c = cfgs[i];
            if (c.kind == AssetKind.Basket && c.active && c.token == token) {
                return INNER.twapPrice(c.pool, tokenIn, tokenOut, amountIn, c.twapWindow);
            }
        }
        revert NotABasketAsset(token);
    }
}
