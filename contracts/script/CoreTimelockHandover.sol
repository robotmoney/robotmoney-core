// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §4 — Access control & admin (Timelock bypass → Mitigated);
//            docs/technical/contract-upgradeability-plan.md — Mechanism and authority (timelock-last stage order)
// Implements: issue #414, issue #422, issue 1727 (rehearsal delay floor), issue 1808 (CREATE2 timelock)
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {ProposerFloorTimelock} from "../ProposerFloorTimelock.sol";
import {GovernedUUPS} from "../lib/GovernedUUPS.sol";
import {UpgradeAuthority} from "./UpgradeAuthority.sol";

/// @dev Safe 1.4.1 read surface used by the full deploy-time Safe checks.
interface ISafeFull {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
    function isOwner(address owner) external view returns (bool);
    function VERSION() external view returns (string memory);
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);
}

/// @title CoreTimelockHandover
/// @notice What every timelock handover stage shares: the vaults system's `DeployTimelock` and the fund system's
///         `DeployFundTimelock` (Deploy 4). The delay floor keyed to chain id 8453 and to DEPLOYMENT_KIND, the full check of
///         the Safe that becomes the only proposer and canceller, the CREATE2 deployment of the `ProposerFloorTimelock`
///         at the address every proxy already names (`UpgradeAuthority.predictTimelock`) with its role and delay checks,
///         and the check that a proxy names that timelock. One copy, so the two systems' handovers cannot drift.
abstract contract CoreTimelockHandover is UpgradeAuthority {
    /// @dev security-model.md §4: production timelock delay floor, 48 hours. Enforced
    ///      by a require on chain id 8453 only. The timelock itself is stock OpenZeppelin.
    uint256 public constant MIN_PRODUCTION_DELAY = 172_800;
    /// @dev Issue 1727 (owner decision 2026-10-10): the delay floor of a rehearsal, an explicit mode selected by the env var DEPLOYMENT_KIND=rehearsal (the publish-contracts
    ///      sheet line of the same name). A rehearsal delay is 900 s up to 172799 s, on every chain, so the delay on chain always agrees with the kind. The default (variable
    ///      absent or "production") keeps the 8453 floor above unchanged. The kind is also recorded in timelock.json.
    uint256 public constant MIN_REHEARSAL_DELAY = 900;

    /// @dev Recorded in timelock.json as `executorPolicy` / `cancellerPolicy`.
    ///      `open`: EXECUTOR_ROLE is held by address(0). `safe-only`: only the Safe
    ///      (threshold >= 2) holds PROPOSER_ROLE and CANCELLER_ROLE.
    string public constant EXECUTOR_POLICY = "open";
    string public constant CANCELLER_POLICY = "safe-only";

    /// @dev Safe 1.4.1 canonical deployments (identical on Base and on the Twin chain,
    ///      whose state is a Base snapshot).
    address public constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address public constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    /// @dev Runtime codehash of the SafeProxy 1.4.1 the canonical factory deploys
    ///      (read from a live Base Safe proxy). A stub, a mock or any other proxy differs.
    bytes32 public constant SAFE_PROXY_1_4_1_CODEHASH =
        0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c;
    /// @dev Safe storage slots: keccak256("guard_manager.guard.address") and
    ///      keccak256("fallback_manager.handler.address").
    bytes32 public constant SAFE_GUARD_SLOT =
        0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 public constant SAFE_FALLBACK_HANDLER_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    /// @dev DEPLOYMENT_KIND (issue 1727): absent or "production" is production, "rehearsal" is the explicit rehearsal mode, anything else reverts.
    function _readRehearsal(string memory prefix) internal view returns (bool) {
        string memory kind =
            vm.envOr(string.concat(prefix, "DEPLOYMENT_KIND"), string("production"));
        if (keccak256(bytes(kind)) == keccak256("production")) return false;
        if (keccak256(bytes(kind)) == keccak256("rehearsal")) return true;
        revert("DEPLOYMENT_KIND must be production or rehearsal");
    }

    /// @dev A required comma-separated address list from env var `name`.
    function _readAddressList(string memory name) internal view returns (address[] memory) {
        require(vm.envExists(name), string.concat(name, " must be set"));
        require(bytes(vm.envString(name)).length != 0, string.concat(name, " is empty"));
        return vm.envAddress(name, ",");
    }

    /// @dev The delay floor, keyed to the chain id (security-model.md §4). A require, never a
    ///      different code path: 8453 refuses anything under 48 hours, every other chain
    ///      (the Twin chain 918453, anvil) accepts any non-zero delay. The contract is
    ///      stock OpenZeppelin and carries no floor of its own.
    function _requireDelayFloor(uint256 minDelay, bool rehearsal) internal view {
        if (rehearsal) {
            // Issue 1727: a rehearsal-kind run carries a short delay on any chain, and never a production one.
            require(
                minDelay >= MIN_REHEARSAL_DELAY && minDelay < MIN_PRODUCTION_DELAY,
                "rehearsal TIMELOCK_MIN_DELAY outside 900..172799"
            );
        } else if (block.chainid == BASE_MAINNET_CHAIN_ID) {
            require(
                minDelay >= MIN_PRODUCTION_DELAY,
                "TIMELOCK_MIN_DELAY below 172800 (48h) on Base mainnet"
            );
        }
    }

    /// @dev The full Safe check. The address must be a SafeProxy 1.4.1 (code and
    ///      codehash) that delegates to the canonical SafeL2 singleton (slot 0), with
    ///      exactly the expected owners and threshold, no modules, no guard and the
    ///      canonical CompatibilityFallbackHandler. A stub, a mock or an EOA fails.
    function _requireRealSafe(address safe, address[] memory owners, uint256 threshold)
        internal
        view
    {
        // An EOA at SAFE_ADDRESS would let one key control every ADMIN_ROLE operation.
        require(
            safe.code.length > 0, "SAFE_ADDRESS is an EOA: deploy a Safe multisig contract first"
        );
        require(
            safe.codehash == SAFE_PROXY_1_4_1_CODEHASH,
            "SAFE_ADDRESS is not a SafeProxy 1.4.1: codehash mismatch"
        );
        // SafeProxy keeps its singleton in storage slot 0: it must be the L2 singleton.
        require(
            address(uint160(uint256(vm.load(safe, bytes32(0))))) == SAFE_L2_SINGLETON,
            "SAFE_ADDRESS does not delegate to the canonical SafeL2 singleton"
        );
        require(SAFE_L2_SINGLETON.code.length > 0, "SafeL2 singleton has no code on this chain");

        require(owners.length >= 2, "SAFE_OWNERS must list at least 2 owners");
        require(threshold >= 2, "SAFE_THRESHOLD < 2: configure at least 2-of-N quorum");
        require(threshold <= owners.length, "SAFE_THRESHOLD exceeds SAFE_OWNERS");

        ISafeFull s = ISafeFull(safe);
        require(
            keccak256(bytes(s.VERSION())) == keccak256("1.4.1"), "SAFE_ADDRESS VERSION is not 1.4.1"
        );
        require(s.getThreshold() == threshold, "Safe threshold != SAFE_THRESHOLD");

        address[] memory actual = s.getOwners();
        require(actual.length == owners.length, "Safe owner count != SAFE_OWNERS");
        for (uint256 i = 0; i < owners.length; i++) {
            require(owners[i] != address(0), "SAFE_OWNERS contains the zero address");
            for (uint256 j = 0; j < i; j++) {
                require(owners[i] != owners[j], "SAFE_OWNERS contains a duplicate");
            }
            require(s.isOwner(owners[i]), "SAFE_OWNERS entry is not a Safe owner");
        }

        // No module may bypass the owner quorum.
        (address[] memory modules,) = s.getModulesPaginated(address(0x1), 10);
        require(modules.length == 0, "Safe has an enabled module");
        // No transaction guard: a guard can veto or rewrite every Safe transaction.
        require(vm.load(safe, SAFE_GUARD_SLOT) == bytes32(0), "Safe has a transaction guard set");
        // The canonical fallback handler, stored by setup().
        require(
            address(uint160(uint256(vm.load(safe, SAFE_FALLBACK_HANDLER_SLOT))))
                == SAFE_FALLBACK_HANDLER,
            "Safe fallback handler is not the canonical CompatibilityFallbackHandler"
        );
    }

    /// @dev Deploy the core timelock at `predictTimelock(safe, minDelay)` through the CREATE2
    ///      factory. CREATE2 binds the init code, so code already at that address can only be
    ///      this same timelock (anyone may have deployed it first): it is reused, and its roles
    ///      and delay are checked either way.
    function _deployTimelockAtPrediction(address safe, uint256 minDelay)
        internal
        returns (TimelockController timelock)
    {
        address predicted = predictTimelock(safe, minDelay);
        if (predicted.code.length == 0) {
            (bool ok,) = CREATE2_FACTORY.call(
                abi.encodePacked(TIMELOCK_SALT, timelockInitCode(safe, minDelay))
            );
            require(ok && predicted.code.length != 0, "timelock CREATE2 deployment failed");
        }
        timelock = TimelockController(payable(predicted));
        // The core timelock is a ProposerFloorTimelock (issue #1645 question 1, CS-3). The floor
        // counted the one proposer the constructor granted: a count of 1 is what makes the Safe's
        // own PROPOSER_ROLE irrevocable until a second proposer exists.
        require(
            ProposerFloorTimelock(payable(predicted)).proposerCount() == 1,
            "timelock proposer floor did not count the Safe"
        );
        require(
            timelock.getMinDelay() == minDelay, "timelock minDelay differs from TIMELOCK_MIN_DELAY"
        );
        require(
            timelock.hasRole(timelock.PROPOSER_ROLE(), safe)
                && timelock.hasRole(timelock.CANCELLER_ROLE(), safe),
            "timelock roles are not proposer/canceller = Safe"
        );
        // The executor this system's proxies predicted (`_timelockExecutor`): address(0) is ADR-0004's open executor; the
        // fund system's is the Safe alone (decision D4-10), and then address(0) must NOT hold it.
        address executor = _timelockExecutor(safe);
        require(
            timelock.hasRole(timelock.EXECUTOR_ROLE(), executor),
            executor == address(0)
                ? "timelock roles are not executor = anyone"
                : "timelock EXECUTOR_ROLE is not the Safe"
        );
        require(
            executor == address(0) || !timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)),
            "timelock executor is open, the policy is safe-only"
        );
        require(
            !timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), msg.sender),
            "deployer holds the timelock admin role"
        );
    }

    function _requireNamesTimelock(address proxy, address timelock) internal view {
        require(
            GovernedUUPS(proxy).upgradeTimelock() == timelock,
            string.concat(vm.toString(proxy), ": upgradeTimelock is not the deployed timelock")
        );
    }
}
