// SPDX-License-Identifier: MIT
// Canonical: docs/code-review/smart-contract-holistic-review-20260618.md (L-11, L-15)
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
///         hygiene they get a *deterministic, permissionless* sweep to a single
///         fixed quarantine ("trash") address. Anyone may trigger the sweep; no
///         one can choose the destination. An offline multisig governance process
///         can later empty the trash address (the reverse-mistakes safety valve).
///
/// @dev The quarantine destination is a compile-time constant so that the sweep
///      destination can never be steered by a caller or by any on-chain role —
///      this is the structural property that keeps the sweep from becoming a
///      re-skin of the deleted arbitrary-recipient rescue functions.
library ForeignTokenQuarantine {
    using SafeERC20 for IERC20;

    /// @notice The fixed, protocol-wide quarantine ("trash") address. All
    ///         permissionless foreign-token sweeps deposit here. This address is
    ///         a hardcoded constant: no role and no caller can change it, so the
    ///         sweep can never route value to an arbitrary recipient (INV-1).
    ///         An offline multisig governance process empties it if a genuine
    ///         mistake needs reversing (INV-2 safety valve).
    address internal constant QUARANTINE = 0x0000000000000000000000000000000000deaD11;

    /// @notice Emitted when a foreign token is swept to the quarantine address.
    /// @param token  Foreign ERC-20 swept to quarantine.
    /// @param amount Amount swept (the contract's full balance of `token`).
    /// @param caller The (unprivileged) account that triggered the sweep.
    event ForeignTokenQuarantined(address indexed token, uint256 amount, address indexed caller);

    /// @notice A sweep was attempted on a protected (protocol/depositor) token.
    /// @param token The protected token that may not be swept.
    error TokenIsProtected(address token);

    /// @notice Move the caller contract's full balance of `token` to the fixed
    ///         quarantine address. The caller MUST have already verified that
    ///         `token` is non-protected (not the vault asset, a basket asset, the
    ///         share token, or an adapter strategy token).
    /// @param token Foreign ERC-20 to sweep. Must not be protected.
    /// @param triggeredBy The unprivileged account that triggered the sweep
    ///        (forwarded for event attribution).
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
}
