// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §9 (EIP-170 size budget, item 2)
// (See also: contracts/gateway/RobotMoneyGateway.sol — `withdraw`, `withdrawFromRouter`; issue #967 / F-03,
//  NC-5 (explicit vault legs), GW-5 / F-11 (per-leg floors, deadline), AZ-GW-3 (empty allowlist),
//  audit 2026-06-09 L-12 (op-kind prefix))
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {IPortfolioRouter} from "../gateway/interfaces/IPortfolioRouter.sol";

/// @title GatewayWithdrawOps
/// @notice The policy checks of `RobotMoneyGateway.withdraw`, and the policy checks, intent hash
///         and multi-leg execution of `RobotMoneyGateway.withdrawFromRouter`. A CREATE2-linked library: `public` functions run
///         as the gateway through `DELEGATECALL`, so `address(this)` is the gateway proxy,
///         `msg.sender` is the agent, token transfers and approvals are the gateway's, and the
///         policy is read from the gateway's own storage.
/// @dev Why it exists (ADR-0014 §9): it keeps the gateway under EIP-170 with the 1,024-byte margin
///      the ADR requires. The gateway keeps the AGENT_ROLE gate, `nonReentrant`, the entry gas
///      floor (measured in the gateway's own frame), the rolling-window accrual, the payment-id
///      reservation and the event. No pause applies to this path (core 1494). Errors mirror the
///      gateway's declarations (same selectors).
library GatewayWithdrawOps {
    using SafeERC20 for IERC20;

    /// @dev Mirror of `RobotMoneyGateway.OP_WITHDRAW_ROUTER`: namespaces router-withdrawal payment ids
    ///      away from the three sibling op kinds (L-12).
    uint8 internal constant OP_WITHDRAW_ROUTER = 4;

    /// @notice What `checkRouterWithdraw` hands back to the gateway.
    /// @param totalShares          Sum of `sharesPerLeg`, for the per-payment and window caps.
    /// @param shareHolder          The policy's `shareReceiver`: whose shares are pulled.
    /// @param assetRecipient       The policy's `assetRecipient`: where every leg's USDC goes.
    /// @param maxWithdrawPerWindow The policy's rolling-window cap.
    /// @param deadline             The agent's deadline, forwarded to the router (F-11).
    struct RouterWithdraw {
        uint256 totalShares;
        address shareHolder;
        address assetRecipient;
        uint256 maxWithdrawPerWindow;
        uint64 deadline;
    }

    error WithdrawalNotEnabled();
    error DeadlineExpired();
    error DeadlineTooFar();
    error AgentNotAuthorized();
    error AgentPolicyExpired();
    error RouterLegLengthMismatch();
    error InvalidSourceVault();
    error InvalidAmount();
    error SharesExceedWithdrawPerPaymentCap();
    error ShareCustodyInvariantViolated();

    /// @notice Steps 1–5 of `withdraw` against the caller's policy `p`: withdrawal enabled, `shares`
    ///         within `(0, maxWithdrawPerPayment]`, deadline inside `(now, now + maxDeadlineSkew]`,
    ///         policy active and not expired, and `sourceVault` the pinned vault and, when the policy's
    ///         `allowedSourceVaults` is non-empty, listed there.
    /// @return maxWithdrawPerWindow The policy's rolling-window cap.
    /// @return assetRecipient       The policy's `assetRecipient`, captured before any external call.
    function checkWithdraw(
        IGateway.AgentPolicy storage p,
        address pinnedVault,
        address sourceVault,
        uint256 shares,
        uint64 deadline,
        uint256 maxDeadlineSkew
    ) public view returns (uint256 maxWithdrawPerWindow, address assetRecipient) {
        // 1. Withdrawal must be enabled for this agent.
        if (p.maxWithdrawPerPayment == 0) revert WithdrawalNotEnabled();

        // 2. shares > 0 && shares <= maxWithdrawPerPayment
        if (shares == 0) revert InvalidAmount();
        if (shares > p.maxWithdrawPerPayment) revert SharesExceedWithdrawPerPaymentCap();

        // 3. deadline window
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (deadline > block.timestamp + maxDeadlineSkew) revert DeadlineTooFar();

        // 4. policy active and not expired.
        // coverage:unreachable
        if (!p.active) revert AgentNotAuthorized();
        if (p.validUntil < block.timestamp) revert AgentPolicyExpired();

        // 5. sourceVault: the pinned vault, and in the allowlist when it is non-empty.
        if (sourceVault != pinnedVault) revert InvalidSourceVault();
        uint256 len = p.allowedSourceVaults.length;
        if (len > 0) {
            bool found;
            for (uint256 i = 0; i < len && !found; i++) {
                found = p.allowedSourceVaults[i] == sourceVault;
            }
            if (!found) revert InvalidSourceVault();
        }
        return (p.maxWithdrawPerWindow, p.assetRecipient);
    }

    /// @notice Steps 2–6 of `withdrawFromRouter` against the caller's policy `p`: withdrawal enabled,
    ///         deadline inside `(now, now + maxDeadlineSkew]`, policy active and not expired, leg arrays
    ///         parallel and non-empty, every non-zero leg allowed, and the total within the per-payment
    ///         cap.
    /// @dev The vault set is the caller-supplied `vaults[]` (issue #967, F-03), not the router's live
    ///      weight vector, so a holder can redeem a position the router has reweighted away from; the
    ///      router re-validates each named vault against the registry in `redeemFor`. AZ-GW-3: an
    ///      empty `allowedSourceVaults` is NOT an open allowlist; it means the pinned vault only.
    function checkRouterWithdraw(
        IGateway.AgentPolicy storage p,
        address pinnedVault,
        address[] calldata vaults,
        uint256[] calldata sharesPerLeg,
        uint64 deadline,
        uint256 maxDeadlineSkew
    ) public view returns (RouterWithdraw memory w) {
        // 2. Withdrawal must be enabled for this agent.
        if (p.maxWithdrawPerPayment == 0) revert WithdrawalNotEnabled();

        // 3. deadline window.
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (deadline > block.timestamp + maxDeadlineSkew) revert DeadlineTooFar();

        // 4. policy active and not expired.
        // coverage:unreachable
        if (!p.active) revert AgentNotAuthorized();
        if (p.validUntil < block.timestamp) revert AgentPolicyExpired();

        // 5. The leg arrays are parallel and name at least one vault.
        if (vaults.length == 0) revert RouterLegLengthMismatch();
        if (sharesPerLeg.length != vaults.length) revert RouterLegLengthMismatch();

        // 5a. Every vault with non-zero shares is in the policy allowlist when it is non-empty,
        //     or is the pinned vault when it is empty.
        uint256 slen = p.allowedSourceVaults.length;
        for (uint256 i = 0; i < vaults.length; i++) {
            if (sharesPerLeg[i] == 0) continue;
            if (slen == 0) {
                if (vaults[i] != pinnedVault) revert InvalidSourceVault();
                continue;
            }
            bool found;
            for (uint256 j = 0; j < slen && !found; j++) {
                found = p.allowedSourceVaults[j] == vaults[i];
            }
            if (!found) revert InvalidSourceVault();
        }

        // 6. totalShares for cap accounting.
        for (uint256 i = 0; i < sharesPerLeg.length; i++) {
            w.totalShares += sharesPerLeg[i];
        }
        if (w.totalShares == 0) revert InvalidAmount();
        if (w.totalShares > p.maxWithdrawPerPayment) revert SharesExceedWithdrawPerPaymentCap();

        // Policy fields captured now, so nothing reads the policy across the external calls.
        w.shareHolder = p.shareReceiver;
        w.assetRecipient = p.assetRecipient;
        w.maxWithdrawPerWindow = p.maxWithdrawPerWindow;
        w.deadline = deadline;
    }

    /// @notice The router-withdrawal payment id. DEADLINE INTENTIONALLY EXCLUDED (a deadline is
    ///         liveness, not intent). The explicit `vaults`/`sharesPerLeg` are committed so two
    ///         withdrawals naming different legs never collide (#967, NC-5), and `minAssetsPerLeg` is
    ///         bound so a replay can never re-execute the same order under a weaker (e.g. zeroed)
    ///         slippage floor (GW-5 / F-11). Runs as the gateway: `address(this)` is the gateway
    ///         proxy and `msg.sender` the agent.
    function routerWithdrawPaymentId(
        bytes32 orderId,
        uint256 totalShares,
        address[] calldata vaults,
        uint256[] calldata sharesPerLeg,
        uint256[] calldata minAssetsPerLeg,
        bytes32 idempotencyKey
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                OP_WITHDRAW_ROUTER,
                block.chainid,
                address(this),
                msg.sender,
                orderId,
                totalShares,
                vaults,
                sharesPerLeg,
                keccak256(abi.encode(minAssetsPerLeg)),
                idempotencyKey
            )
        );
    }

    /// @notice Steps 11–14 of `withdrawFromRouter`: pull each non-zero leg's shares from
    ///         `w.shareHolder` into the gateway, approve the router for exactly that amount, call
    ///         `router.redeemFor` (USDC goes straight to `w.assetRecipient`, each leg under its
    ///         caller-supplied floor, with the agent's real deadline), clear the approvals, and require
    ///         the gateway's share balance of every leg vault to be unchanged.
    /// @dev The callers' state effects (payment id, rolling window) are written before this runs
    ///      (CEI), and the gateway holds `nonReentrant`.
    // slither-disable-start reentrancy-balance
    function executeRouterWithdraw(
        IPortfolioRouter router,
        RouterWithdraw memory w,
        address[] memory vaults,
        uint256[] memory sharesPerLeg,
        uint256[] memory minAssetsPerLeg
    ) public returns (uint256[] memory assetsPerLeg) {
        uint256[] memory shareBalancesBefore = new uint256[](vaults.length);
        for (uint256 i = 0; i < sharesPerLeg.length; i++) {
            shareBalancesBefore[i] = IERC20(vaults[i]).balanceOf(address(this));
            if (sharesPerLeg[i] == 0) continue;
            IERC20(vaults[i]).safeTransferFrom(w.shareHolder, address(this), sharesPerLeg[i]);
            IERC20(vaults[i]).forceApprove(address(router), sharesPerLeg[i]);
        }

        assetsPerLeg = router.redeemFor(
            address(this), w.assetRecipient, vaults, sharesPerLeg, minAssetsPerLeg, w.deadline
        );

        // Clear residual vault share approvals (defense-in-depth).
        for (uint256 i = 0; i < sharesPerLeg.length; i++) {
            if (sharesPerLeg[i] == 0) continue;
            IERC20(vaults[i]).forceApprove(address(router), 0);
        }

        // Post-call custody invariant: the gateway holds no vault shares it did not hold before.
        for (uint256 i = 0; i < vaults.length; i++) {
            if (IERC20(vaults[i]).balanceOf(address(this)) != shareBalancesBefore[i]) {
                revert ShareCustodyInvariantViolated();
            }
        }
    }
    // slither-disable-end reentrancy-balance
}
