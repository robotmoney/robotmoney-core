// SPDX-License-Identifier: MIT
// Canonical: docs/code-review/20260618-code-review-internal-claude.md (L-11, L-15)
// (See also: docs/prd.md — Security invariants (INV-1/INV-2/INV-3);
//            docs/architecture.md — no-arbitrary-admin-routing / permissionless quarantine)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ForeignTokenQuarantine
/// @notice Shared logic for the permissionless foreign-token sweep that enforces
///         custody invariants INV-1 and INV-2.
///
///         INV-1 (no arbitrary admin routing): no admin/role-gated function may
///         route a PROTOCOL or DEPOSITOR asset to a caller-supplied recipient.
///         The old `rescueTokens`/`rescueUsdc` functions did exactly that and are
///         deleted across the protocol.
///
///         INV-2 (no stranded assets): every protocol/depositor asset is either
///         redeemable by holders or absorbed into NAV. Non-whitelisted "foreign"
///         tokens that land on a contract via a raw ERC-20 transfer cannot be
///         rejected on receipt nor returned-to-sender (the sender is not knowable
///         on-chain), and are inert (uncounted, un-redeemable). For storage
///         hygiene they get a *deterministic, permissionless* sweep to a governed
///         quarantine ("trash") address. Anyone may trigger the sweep; no caller
///         can choose the destination (INV-1). An offline multisig governance
///         process can later empty the trash address (the reverse-mistakes safety
///         valve).
///
/// @dev Two sweep overloads are provided:
///
///      `sweep(token, triggeredBy)` — uses the hardcoded `QUARANTINE` constant.
///      Used by adapters that have no on-chain admin (immutable contracts).
///
///      `sweep(token, destination, triggeredBy)` — uses a caller-supplied
///      `destination` that must be the per-contract governance-controlled
///      quarantine address (see `quarantineAddress` on RobotMoneyVault,
///      BasketVault, and PortfolioRouter). The destination is never the raw
///      `msg.sender`; it is set only through the TimelockController (INV-3)
///      and therefore cannot be steered by a calling-time argument.
library ForeignTokenQuarantine {
    using SafeERC20 for IERC20;

    /// @notice The protocol-wide default quarantine ("trash") address used by
    ///         adapters that have no on-chain governance (immutable contracts).
    ///         Main protocol contracts (RobotMoneyVault, BasketVault,
    ///         PortfolioRouter) store a timelock-settable `quarantineAddress`
    ///         state variable and call the three-argument `sweep` overload.
    address internal constant QUARANTINE = 0x0000000000000000000000000000000000deaD11;

    /// @notice Emitted when a foreign token is swept to the quarantine address.
    /// @param token  Foreign ERC-20 swept to quarantine.
    /// @param amount Amount swept (the contract's full balance of `token`).
    /// @param caller The (unprivileged) account that triggered the sweep.
    event ForeignTokenQuarantined(address indexed token, uint256 amount, address indexed caller);

    /// @notice A sweep was attempted on a protected (protocol/depositor) token.
    /// @param token The protected token that may not be swept.
    error TokenIsProtected(address token);

    /// @notice Quarantine address must not be the zero address.
    error ZeroQuarantineAddress();

    /// @notice Move the caller contract's full balance of `token` to the fixed
    ///         `QUARANTINE` constant address. Used by adapters that are
    ///         immutable and have no on-chain access control.
    /// @param token Foreign ERC-20 to sweep. Must not be protected.
    /// @param triggeredBy The unprivileged account that triggered the sweep.
    /// @return amount The amount swept to quarantine.
    /// @dev `internal` (inlined), NOT an external delegatecall-linked library:
    ///      strategy adapters are forbidden from containing the `DELEGATECALL`
    ///      opcode by `AdapterBytecodeGuard` / `AdapterDelegatecallGuard`
    ///      (confused-deputy defence), and an external library call compiles to a
    ///      delegatecall. Inlining keeps the adapters delegatecall-free.
    function sweep(address token, address triggeredBy) internal returns (uint256 amount) {
        amount = IERC20(token).balanceOf(address(this));
        // A zero balance is a harmless no-op transfer; no dedicated revert keeps
        // the inlined body small in every balance-holding caller.
        IERC20(token).safeTransfer(QUARANTINE, amount);
        emit ForeignTokenQuarantined(token, amount, triggeredBy);
    }

    /// @notice Move the caller contract's full balance of `token` to a
    ///         governance-controlled `destination`. Use this overload when the
    ///         quarantine address is stored as a timelock-settable state variable
    ///         on the calling contract (RobotMoneyVault, BasketVault,
    ///         PortfolioRouter). The `destination` MUST NOT be a caller-supplied
    ///         argument; it must be read from the contract's governed storage.
    /// @param token       Foreign ERC-20 to sweep. Must not be protected.
    /// @param destination Governed quarantine address. Must not be address(0).
    /// @param triggeredBy The unprivileged account that triggered the sweep.
    /// @return amount The amount swept to `destination`.
    function sweep(address token, address destination, address triggeredBy)
        internal
        returns (uint256 amount)
    {
        if (destination == address(0)) revert ZeroQuarantineAddress();
        amount = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(destination, amount);
        emit ForeignTokenQuarantined(token, amount, triggeredBy);
    }
}
