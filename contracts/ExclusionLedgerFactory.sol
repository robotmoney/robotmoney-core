// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §9 (EIP-170 size budget, item 3)
// (See also: contracts/ExclusionLedger.sol; contracts/RobotMoneyVault.sol — `initialize`)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ExclusionLedger} from "./ExclusionLedger.sol";

/// @title ExclusionLedgerFactory
/// @notice Creates the `ExclusionLedger` of one `RobotMoneyVault` proxy. Stateless; deployed once
///         per chain by CREATE2 in the libs stage.
/// @dev Why it exists: before ADR-0014 the vault constructor ran `new ExclusionLedger(asset)`, which
///      is initcode. Behind a proxy that line would sit in `initialize`, an ordinary function, and
///      embed the ledger's ~5.9 KB creation code in the vault's EIP-170-tight runtime. The factory
///      holds that creation code instead. The ledger is bound to `msg.sender`, so a vault can only
///      ever create its own ledger; the vault initializer checks `VAULT() == address(this)`.
contract ExclusionLedgerFactory {
    /// @notice A ledger was created for `vault`.
    /// @param vault  The calling vault: the ledger's only writer.
    /// @param ledger The new ledger.
    /// @param asset  The vault's asset the ledger holds and pays.
    event ExclusionLedgerCreated(address indexed vault, address indexed ledger, address asset);

    /// @notice Create the exclusion ledger of the calling vault.
    /// @param asset The vault's asset (USDC).
    /// @return ledger The new ledger, whose `VAULT()` is `msg.sender`.
    function create(IERC20 asset) external returns (ExclusionLedger ledger) {
        ledger = new ExclusionLedger(msg.sender, asset);
        emit ExclusionLedgerCreated(msg.sender, address(ledger), address(asset));
    }
}
