// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md §4.2 ("check 11: a realized price outside the bound,
//            forced with a mock venue"; "venue rounding of one or two units never fails the proportion check";
//            reentrancy during a claim); docs/technical/one-vault-rebalancer-proposal.md §5.9.3 checks 10 and 11
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAavePool} from "../../../interfaces/IAavePool.sol";
import {ILendingRateAdapter} from "../src/interfaces/IFlowAdapters.sol";
import {IAavePoolRate} from "../src/adapters/AaveV3RateAdapter.sol";
import {MechReentry} from "./MechReentry.sol";

/// @title MechAaveAdapter
/// @notice A lending venue for `FlowQueue.t.sol` that `vm.etch` places over the harness's Aave V3 rate adapter (whose
///         code keeps no storage). It sits at the same address, so the fund's real aUSDC position on the real Aave
///         pool stays its own. The test allowlists this code hash through the timelock first, so the asset stays
///         counted (ADP-2). Modes:
///         - `HONEST`: supply and withdraw as the production `AaveV3Adapter`, with the venue rate of the copy.
///         - `ROUND_AGAINST`: the venue rounds against the fund by `param` units on both sides, in its own books:
///           a supply of `a` raises the position it reports (`totalAssets`) by exactly `a - param` (whatever Aave's
///           own rounding of up to one unit did, the mock's `haircut` makes the total exactly `param`), and a
///           withdrawal of `a` pays `a - param`. Proposal §5.9.3 check 10 says one or two units must never fail the
///           proportion check. (Aave refuses a top-up supply that scales to zero, so the shortfall is booked in the
///           reported position rather than by supplying less.)
///         - `SHORT_PAY`: a withdrawal of `a` takes `a` out of the position but pays the fund `a × (1 − param / 10 000)`
///           and keeps the rest: a venue that pays short without reverting.
///         Any mode also runs the re-entry probe (`MechReentry`) while armed. USDC a mode keeps stays here.
contract MechAaveAdapter is MechReentry, ILendingRateAdapter {
    using SafeERC20 for IERC20;

    uint8 public constant HONEST = 0;
    uint8 public constant ROUND_AGAINST = 1;
    uint8 public constant SHORT_PAY = 2;

    uint256 private constant RAY_TO_WAD = 1e9;

    address public immutable USDC;
    IERC20 public immutable A_TOKEN;
    address public immutable POOL;
    address public immutable VAULT;

    uint8 public mode;
    uint256 public param;
    /// @notice Units of the real aUSDC balance this venue does not report as the fund's (`ROUND_AGAINST`).
    uint256 public haircut;
    /// @notice The last supply: what the fund asked to place and what the position grew by.
    uint256 public lastSupplyAsked;
    uint256 public lastSupplyCredited;

    error OnlyVault();

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    constructor(address pool_, address usdc_, address aToken_, address vault_) {
        POOL = pool_;
        USDC = usdc_;
        A_TOKEN = IERC20(aToken_);
        VAULT = vault_;
    }

    /// @notice Test knob (no access control: a test mock).
    function setMode(uint8 mode_, uint256 param_) external {
        mode = mode_;
        param = param_;
    }

    function deploy(uint256 amount) external onlyVault {
        _reenter(bytes4(keccak256("deploy(uint256)")));
        uint256 before = _reported();
        uint256 rawBefore = A_TOKEN.balanceOf(address(this));
        _supply(amount);
        if (mode == ROUND_AGAINST) {
            uint256 rawCredit = A_TOKEN.balanceOf(address(this)) - rawBefore;
            // Book exactly `amount - param` for the fund: keep back whatever is above it.
            if (rawCredit + param > amount) haircut += rawCredit + param - amount;
        }
        lastSupplyAsked = amount;
        lastSupplyCredited = _reported() - before;
    }

    function deploy(uint256 usdcIn, uint256) external onlyVault returns (uint256) {
        _supply(usdcIn);
        return usdcIn;
    }

    function withdraw(uint256 amount) external onlyVault returns (uint256 paid) {
        _reenter(bytes4(keccak256("withdraw(uint256)")));
        uint256 got = IAavePool(POOL).withdraw(USDC, amount, address(this));
        paid = got;
        if (mode == ROUND_AGAINST) paid = got > param ? got - param : 0;
        else if (mode == SHORT_PAY) paid = got - got * param / 10_000;
        IERC20(USDC).safeTransfer(VAULT, paid);
    }

    function withdraw(uint256 usdcWanted, uint256) external onlyVault returns (uint256) {
        return IAavePool(POOL).withdraw(USDC, usdcWanted, VAULT);
    }

    function totalAssets() external view returns (uint256) {
        return _reported();
    }

    /// @dev The position this venue reports to the fund: its aUSDC less the haircut.
    function _reported() private view returns (uint256) {
        uint256 raw = A_TOKEN.balanceOf(address(this));
        return raw > haircut ? raw - haircut : 0;
    }

    function ratePerUnit() external view returns (uint256) {
        return IAavePoolRate(POOL).getReserveNormalizedIncome(USDC) / RAY_TO_WAD;
    }

    function venueWithdrawable() external pure returns (bool) {
        return true;
    }

    function isExact() external pure returns (bool) {
        return true;
    }

    function sweepForeignToken(address) external pure {
        revert OnlyVault();
    }

    function harvestRewards() external {}

    function _supply(uint256 amount) private {
        IERC20(USDC).forceApprove(POOL, amount);
        IAavePool(POOL).supply(USDC, amount, address(this), 0);
        IERC20(USDC).forceApprove(POOL, 0);
    }
}
