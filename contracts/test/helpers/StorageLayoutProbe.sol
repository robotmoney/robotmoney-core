// SPDX-License-Identifier: MIT
// Canonical: docs/technical/contract-upgradeability-plan.md (Mechanism and authority: pin and validate the storage layout for every upgrade),
//            docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md.
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {
    AccessControlEnumerableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {
    ERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {
    ERC4626Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {GovernedUpgrade} from "../../lib/GovernedUUPS.sol";
import {RobotMoneyVaultOps} from "../../lib/RobotMoneyVaultOps.sol";
import {FundState} from "../../lib/FundStorage.sol";
import {FlowState} from "../../lib/FlowStorage.sol";

// Layout probes for scripts/ci/check-core-storage-layout.sh. Test-only: no stage deploys them and no test calls them.
//
// solc reports a storage layout only for state variables. A contract that keeps its state in an ERC-7201 namespace reaches that struct
// through an assembly slot, so `forge inspect <C> storageLayout` lists none of it, and the gate used to pin a namespace as the flat source
// lines of its struct. The members of a struct reached through a namespace mapping (`mapping(uint256 id => Request) requests`) were never
// compared: release v0.9.0 changed `Request`, `Settlement` and `StepParams` in the middle and the gate passed (Deploy 4 v0.9.0 upgrade
// audit, regression test 1).
//
// Each probe holds one namespace struct as its only state variable, so solc lays the struct out from slot 0 and lists every type reachable
// from it (through mappings, arrays and nested structs) with each member's slot and offset. The gate reads that with
// `forge inspect LayoutProbe_<namespace id, dots as underscores> storageLayout` and pins it in the `nested` section of every snapshot whose
// contract carries the namespace. A namespace with no probe here, or a probe whose member names are not the namespace's, is a gate error.

/// @dev erc7201:openzeppelin.storage.Initializable
contract LayoutProbe_openzeppelin_storage_Initializable {
    Initializable.InitializableStorage internal s;
}

/// @dev erc7201:openzeppelin.storage.AccessControl
contract LayoutProbe_openzeppelin_storage_AccessControl {
    AccessControlUpgradeable.AccessControlStorage internal s;
}

/// @dev erc7201:openzeppelin.storage.AccessControlEnumerable
contract LayoutProbe_openzeppelin_storage_AccessControlEnumerable {
    AccessControlEnumerableUpgradeable.AccessControlEnumerableStorage internal s;
}

/// @dev erc7201:openzeppelin.storage.ReentrancyGuard
contract LayoutProbe_openzeppelin_storage_ReentrancyGuard {
    ReentrancyGuardUpgradeable.ReentrancyGuardStorage internal s;
}

/// @dev erc7201:openzeppelin.storage.ERC20
contract LayoutProbe_openzeppelin_storage_ERC20 {
    ERC20Upgradeable.ERC20Storage internal s;
}

/// @dev erc7201:openzeppelin.storage.ERC4626
contract LayoutProbe_openzeppelin_storage_ERC4626 {
    ERC4626Upgradeable.ERC4626Storage internal s;
}

/// @dev erc7201:robotmoney.storage.GovernedUUPS
contract LayoutProbe_robotmoney_storage_GovernedUUPS {
    GovernedUpgrade.Layout internal s;
}

/// @dev erc7201:robotmoney.storage.RobotMoneyVaultExclusions
contract LayoutProbe_robotmoney_storage_RobotMoneyVaultExclusions {
    RobotMoneyVaultOps.Exclusions internal s;
}

/// @dev erc7201:robotmoney.storage.RobotMoneyFund
contract LayoutProbe_robotmoney_storage_RobotMoneyFund {
    FundState internal s;
}

/// @dev erc7201:robotmoney.storage.FlowQueue
contract LayoutProbe_robotmoney_storage_FlowQueue {
    FlowState internal s;
}
