// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md (a reinitializer runs inside `upgradeToAndCall`);
//            docs/technical/one-vault-rebalancer-proposal.md §4.2 (exclusion ledger), §4.5 (pool rules), §5.11.5, §7 RB-22
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Roles} from "../FundTypes.sol";
import {ExclusionLedger} from "../ExclusionLedger.sol";
import {IRobotMoneyFund} from "../interfaces/IRobotMoneyFund.sol";
import {IRebalancer} from "../interfaces/IRebalancer.sol";
import {FundState, FundStorage} from "./FundStorage.sol";
import {FundDelistLib} from "./FundDelistLib.sol";
import {GovernedUpgrade} from "./GovernedUUPS.sol";
import {RobotMoneyVaultOps} from "./RobotMoneyVaultOps.sol";

/// @dev The two reads of an exclusion ledger the migration needs (the same in the 0.8.0 and the 0.9.0 ledger).
interface IExclusionLedgerBooks {
    function exclusionCount() external view returns (uint256);
    function heldUsdc() external view returns (uint256);
}

/// @title FundMigrateLib
/// @notice The one-time state migration of a `RobotMoneyFund` proxy upgraded in place from contracts 0.8.0 to 0.9.0.
///         It is the body of `RobotMoneyFund.migrateV090`, which the upgrade timelock passes as the data of
///         `upgradeToAndCall`, and it applies the `reinitializer(2)` gate itself (see below). A fund deployed at 0.9.0 never needs it (`initialize` and `bindRebalanceRoles` write
///         everything below).
///
///         `FundState` only grew at its end, so nothing moves. What an upgraded fund lacks is what the 0.9.0
///         `initialize` writes and a 0.8.0 one never did:
///
///         1. The five step 3f parameters read 0: `maxBasketBps` 0 refuses every plan with a basket weight, the two
///            delisting parameters 0 leave a delisting sale no band and no budget, and `minPoolDepthUsdc` and
///            `feeMarginBps` 0 switch two pool guards off. They get the defaults of a fresh fund.
///         2. The fund's exclusion ledger is a separate contract with 0.8.0 code, which reads the queue's shares of a
///            holder without the 0.9.0 match indexes. It is replaced by a new `FundExclusionLedger` bound to this
///            fund. That is only sound while the old one never opened a record and holds no recovery money, so the
///            migration requires both.
///         3. `fund.rebalancer` is new and 0, and `bindRebalanceRoles` (the only writer) already ran. It is set to
///            the address that holds `REBALANCER_ROLE`, which must already run 0.9.0 code: the queue calls
///            `lastBasketStepAt()` on it at the first settlement of every round.
library FundMigrateLib {
    /// @notice The fund's exclusion ledger was replaced.
    event ExclusionLedgerReplaced(address indexed oldLedger, address indexed newLedger);
    /// @notice `fund.rebalancer` was written by the migration.
    event RebalancerRecorded(address indexed rebalancer);

    /// @notice The exclusion ledger to replace has a record or holds recovery USDC.
    error OldLedgerNotEmpty(address ledger, uint256 exclusionCount, uint256 heldUsdc);
    /// @notice `rebalancer` does not hold the fund's `REBALANCER_ROLE`.
    error NotTheRebalancer(address rebalancer);
    /// @notice `rebalancer` does not answer `lastBasketStepAt()`: it still runs 0.8.0 code. Upgrade it first.
    error RebalancerNotUpgraded(address rebalancer);

    /// @notice Body of `RobotMoneyFund.migrateV090` (see the library note). Runs once, in the proxy's storage.
    /// @param rebalancer The Rebalancer proxy that holds `REBALANCER_ROLE`, already upgraded to 0.9.0.
    function migrateV090(FundState storage s, address rebalancer) public {
        // The caller of a DELEGATECALL chain is the proxy's caller. With the version gate below this leaves one way
        // in: the timelock's own `upgradeToAndCall` (or its direct call, once).
        if (msg.sender != GovernedUpgrade.layout().upgradeTimelock) {
            revert GovernedUpgrade.NotUpgradeTimelock(msg.sender);
        }
        // The gate of OpenZeppelin's `reinitializer(2)`, on the proxy's own `Initializable` storage. It is here and
        // not a modifier on the fund's entry point because the modifier costs the fund 191 bytes of the 382 it has
        // left under EIP-170. Same rule, same error, same event: version 1 (initialized, never migrated) passes
        // once; a locked implementation, a frozen proxy (version max) and a second call revert.
        GovernedUpgrade.InitializableLayout storage init;
        bytes32 initSlot = GovernedUpgrade.INITIALIZABLE_STORAGE;
        assembly {
            init.slot := initSlot
        }
        if (init.initializing || init.initialized >= 2) {
            revert GovernedUpgrade.InvalidInitialization();
        }
        init.initialized = 2;
        emit GovernedUpgrade.Initialized(2);

        s.minPoolDepthUsdc = FundStorage.DEFAULT_MIN_POOL_DEPTH_USDC;
        s.feeMarginBps = FundStorage.DEFAULT_FEE_MARGIN_BPS;
        s.delistBandBps = FundStorage.DEFAULT_DELIST_BAND_BPS;
        s.delistBudgetBps = FundStorage.DEFAULT_DELIST_BUDGET_BPS;
        s.maxBasketBps = FundStorage.DEFAULT_MAX_BASKET_BPS;
        emit IRobotMoneyFund.MinPoolDepthUsdcSet(FundStorage.DEFAULT_MIN_POOL_DEPTH_USDC);
        emit IRobotMoneyFund.FeeMarginBpsSet(FundStorage.DEFAULT_FEE_MARGIN_BPS);
        emit IRobotMoneyFund.DelistBandBpsSet(FundStorage.DEFAULT_DELIST_BAND_BPS);
        emit IRobotMoneyFund.DelistBudgetBpsSet(FundStorage.DEFAULT_DELIST_BUDGET_BPS);
        emit IRobotMoneyFund.MaxBasketBpsSet(FundStorage.DEFAULT_MAX_BASKET_BPS);

        RobotMoneyVaultOps.Exclusions storage x = RobotMoneyVaultOps.exclusions();
        address oldLedger = address(x.ledger);
        if (oldLedger != address(0)) {
            uint256 count = IExclusionLedgerBooks(oldLedger).exclusionCount();
            uint256 held = IExclusionLedgerBooks(oldLedger).heldUsdc();
            if (count != 0 || held != 0) revert OldLedgerNotEmpty(oldLedger, count, held);
            x.ledger = ExclusionLedger(address(0));
        }
        // The fund proxy creates it (this runs by DELEGATECALL), so the new ledger names the fund as its only writer.
        address newLedger = FundDelistLib.createLedger(s.usdc);
        emit ExclusionLedgerReplaced(oldLedger, newLedger);

        if (
            rebalancer == address(0)
                || !IAccessControl(address(this)).hasRole(Roles.REBALANCER_ROLE, rebalancer)
        ) revert NotTheRebalancer(rebalancer);
        if (rebalancer.code.length == 0) revert RebalancerNotUpgraded(rebalancer);
        try IRebalancer(rebalancer).lastBasketStepAt() returns (uint64) {}
        catch {
            revert RebalancerNotUpgraded(rebalancer);
        }
        s.rebalancer = rebalancer;
        emit RebalancerRecorded(rebalancer);
    }
}
