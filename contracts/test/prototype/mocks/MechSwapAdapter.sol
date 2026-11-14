// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md §4.2 (RB-13 "a fund copy with a deliberately wrong
//            purchase amount must revert inside the fund"; check 11 "forced with a mock venue"; reentrancy), E3;
//            docs/technical/one-vault-rebalancer-proposal.md §5.9.3 checks 9 to 11
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapRouter} from "../../../interfaces/ISwapRouter.sol";
import {TwapTickMath} from "../../../lib/TwapTickMath.sol";
import {IExactOutSwapAdapter} from "../src/interfaces/IFlowAdapters.sol";
import {ISwapRouterExactOut} from "../src/adapters/UniswapV3ExactOutSwapAdapter.sol";
import {MechReentry} from "./MechReentry.sol";

/// @title MechSwapAdapter
/// @notice A swap venue for `FlowQueue.t.sol` that `vm.etch` places over the harness's exact-output swap adapter (whose
///         code keeps no storage). It trades on the real Uniswap V3 pools through SwapRouter02, as the adapter copy
///         does, and can misbehave on purpose:
///         - `HONEST`: the same as `UniswapV3ExactOutSwapAdapter`.
///         - `UNDER_DELIVER`: an exact-output purchase buys `amountOut` but hands the fund `bps` less and keeps the
///           rest. It reports the true input. From the fund's side this is a purchase of the wrong amount, which the
///           fund's own proportion check (check 10, RB-13) must refuse.
///         - `CHARGE_MAX`: an exact-output purchase delivers `amountOut` and reports `maxAmountIn` as spent, keeping
///           the difference: every basket leg costs exactly its per-swap limit (the worst case the bound allows).
///         Any mode also runs the re-entry probe (`MechReentry`) while armed.
///         Basket tokens that a mode keeps stay in this contract: no new account is touched.
contract MechSwapAdapter is MechReentry, IExactOutSwapAdapter {
    using SafeERC20 for IERC20;

    uint8 public constant HONEST = 0;
    uint8 public constant UNDER_DELIVER = 1;
    uint8 public constant CHARGE_MAX = 2;

    address public immutable ROUTER;

    uint8 public mode;
    uint16 public underDeliverBps;

    error ZeroAddress();
    error ZeroWindow();
    error DeadlineExpired(uint256 deadline, uint256 nowTs);

    constructor(address router_) {
        if (router_ == address(0)) revert ZeroAddress();
        ROUTER = router_;
    }

    /// @notice Test knob (no access control: a test mock).
    function setMode(uint8 mode_, uint16 underDeliverBps_) external {
        mode = mode_;
        underDeliverBps = underDeliverBps_;
    }

    /// @notice Exact-input swap, as the production `UniswapV3SwapAdapter.swap` (the fund's sale, step legs).
    function swap(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        _reenter(this.swap.selector);
        if (tokenIn == address(0) || tokenOut == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        if (amountIn == 0) return 0;
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(ROUTER, amountIn);
        amountOut = ISwapRouter(ROUTER)
            .exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: recipient,
                    amountIn: amountIn,
                    amountOutMinimum: minAmountOut,
                    sqrtPriceLimitX96: 0
                })
            );
        IERC20(tokenIn).forceApprove(ROUTER, 0);
    }

    /// @notice TWAP quote, as the production adapter (the fund's NAV reads it).
    function twapPrice(
        address pool,
        address baseToken,
        address quoteToken,
        uint256 baseAmount,
        uint32 window
    ) external view returns (uint256 quoteAmount) {
        if (pool == address(0) || baseToken == address(0) || quoteToken == address(0)) revert ZeroAddress();
        if (window == 0) revert ZeroWindow();
        if (baseAmount == 0) return 0;
        TwapTickMath.checkPoolPair(pool, baseToken, quoteToken);
        int24 meanTick = TwapTickMath.meanTick(pool, window);
        quoteAmount = TwapTickMath.priceFromTick(meanTick, baseToken, quoteToken, baseAmount);
    }

    /// @notice Exact-output purchase (the fund's `mintInKind` basket legs), with the mode's misbehaviour.
    function swapExactOut(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountOut,
        uint256 maxAmountIn,
        address recipient,
        uint256 deadline
    ) external returns (uint256 amountIn) {
        _reenter(this.swapExactOut.selector);
        if (tokenIn == address(0) || tokenOut == address(0) || recipient == address(0)) {
            revert ZeroAddress();
        }
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        if (amountOut == 0) return 0;
        uint8 m = mode;
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), maxAmountIn);
        IERC20(tokenIn).forceApprove(ROUTER, maxAmountIn);
        amountIn = ISwapRouterExactOut(ROUTER)
            .exactOutputSingle(
                ISwapRouterExactOut.ExactOutputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: m == UNDER_DELIVER ? address(this) : recipient,
                    amountOut: amountOut,
                    amountInMaximum: maxAmountIn,
                    sqrtPriceLimitX96: 0
                })
            );
        IERC20(tokenIn).forceApprove(ROUTER, 0);
        if (m == UNDER_DELIVER) {
            uint256 kept = amountOut * underDeliverBps / 10_000;
            if (kept == 0) kept = 1;
            IERC20(tokenOut).safeTransfer(recipient, amountOut - kept);
        }
        if (m == CHARGE_MAX) return maxAmountIn; // the unused input stays here, reported as spent
        if (amountIn < maxAmountIn) {
            IERC20(tokenIn).safeTransfer(msg.sender, maxAmountIn - amountIn);
        }
    }
}
