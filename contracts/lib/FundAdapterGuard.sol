// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0019-fund-swap-adapters-governed-uups-proxies.md; docs/technical/security-model.md (adapter rows)
pragma solidity ^0.8.24;

import {IRobotMoneyFund} from "../interfaces/IRobotMoneyFund.sol";
import {FundState, FundStorage} from "./FundStorage.sol";

/// @notice A governed UUPS adapter proxy reports the implementation in its ERC-1967 slot.
interface IAdapterImplementation {
    function implementation() external view returns (address);
}

/// @title FundAdapterGuard
/// @notice ADR-0019: the fund's check of a basket swap adapter before each use. A direct-deployment adapter keeps the
///         rule it had before (its code hash is checked at admission and at `setAssetAdapter`). An adapter whose code
///         hash is a marked proxy hash (`adapterProxyCodeHash`) must keep that hash allowed AND report an
///         implementation whose code hash is allowed and is not itself a proxy hash, on every use. So an upgrade of
///         the proxy to an implementation the timelock has not allowed stops every swap and price read through it.
/// @dev Internal: inlined into each delegatecall-linked fund library, so it reads the fund's own storage.
library FundAdapterGuard {
    /// @notice Revert `AdapterCodeHashNotAllowed` unless `adapter` passes the ADR-0019 check; return it.
    function vet(address adapter) internal view returns (address) {
        return vet(FundStorage.layout(), adapter);
    }

    /// @notice As `vet(address)`, with the fund state the caller holds.
    function vet(FundState storage s, address adapter) internal view returns (address) {
        bytes32 h = adapter.codehash;
        if (!s.adapterProxyCodeHash[h]) return adapter;
        if (!s.codeHashAllowed[h]) revert IRobotMoneyFund.AdapterCodeHashNotAllowed(adapter, h);
        address impl = IAdapterImplementation(adapter).implementation();
        bytes32 ih = impl.codehash;
        if (!s.codeHashAllowed[ih] || s.adapterProxyCodeHash[ih]) {
            revert IRobotMoneyFund.AdapterCodeHashNotAllowed(impl, ih);
        }
        return adapter;
    }

    /// @notice Admission rule (`addAsset`, `setAssetAdapter`): the adapter's own code hash must be allowed, then the
    ///         proxy rule above applies.
    function requireAdmissible(FundState storage s, address adapter) internal view {
        bytes32 h = adapter.codehash;
        if (!s.codeHashAllowed[h]) revert IRobotMoneyFund.AdapterCodeHashNotAllowed(adapter, h);
        vet(s, adapter);
    }
}
