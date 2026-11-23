// SPDX-License-Identifier: MIT
// Canonical: docs/code-reviews/20261121-214700-agy/05-meta-review-and-missed-findings.md (MISSED-04)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title FeeTransfer
/// @notice A fee payment that cannot block the flow it is part of (safety review 0.9.0, MISSED-04). USDC can refuse a
///         recipient (a Circle blacklist), and a push of the fee with `safeTransfer` then reverted every settlement,
///         claim and in-kind exit until governance rotated `feeRecipient`. The caller keeps an unpaid fee with the
///         holders and emits an event, so a refused fee costs the team its fee, never a customer an exit.
library FeeTransfer {
    /// @notice Transfer `amount` of `token` to `to`. True when paid (or zero); false when the token refused.
    function tryPay(address token, address to, uint256 amount) internal returns (bool) {
        if (amount == 0) return true;
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (data.length == 0) return token.code.length != 0;
        return data.length >= 32 && abi.decode(data, (bool));
    }
}
