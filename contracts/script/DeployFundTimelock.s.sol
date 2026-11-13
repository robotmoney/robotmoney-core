// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §4 (timelock bypass mitigated); docs/technical/one-vault-rebalancer-proposal.md
//            RB-1 (every plan and flow parameter through the timelock), INV-3 (the receipt register's ADMIN_ROLE is the
//            timelock's); PrototypeHarness.sol (_handOverToTimelock).
// Deploy 4 (owner exception 2026-11-12): the one-vault prototype through the real deploy tool, as a rehearsal.
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {Roles} from "../test/prototype/src/FundTypes.sol";
import {CoreTimelockHandover} from "./CoreTimelockHandover.sol";
import {FundTimelockPolicy} from "./FundTimelockPolicy.sol";
import {UpgradeAuthority} from "./UpgradeAuthority.sol";

/// @title DeployFundTimelock
/// @notice The fund system's handover, its LAST stage (Deploy 4). `DeployTimelock.s.sol` cannot be used: it hands over the
///         vaults system (vaults, registry, router, RouterGovernance). This stage deploys the same `ProposerFloorTimelock`
///         (Safe = only proposer, canceller AND executor, no admin: decision D4-10, `FundTimelockPolicy`; the vaults system's
///         executor stays open, ADR-0004) at the CREATE2 address every fund-system
///         proxy already names, with the same Safe check and delay floor (`CoreTimelockHandover`), asserts each of the
///         five proxies names it, and only then moves the roles:
///         - fund, rebalancer, queue: ADMIN_ROLE to the timelock, the deployer's copy renounced;
///         - governance: ADMIN_ROLE and TARGET_SETTER_ROLE to the timelock (a receipt is applied only by a Safe-scheduled
///           timelock operation), the deployer's copies renounced;
///         - receipt register: ADMIN_ROLE and DEFAULT_ADMIN_ROLE to the timelock, revoked from RECEIPT_ADMIN_ADDRESS (INV-3).
///         After it the deployer holds no role on any fund-system contract. EMERGENCY_ROLE (fund, queue) is the emergency
///         key's from initialization, KEEPER_ROLE (queue, rebalancer) the keeper's: both are read back here.
///
///         Required env vars (no defaults): FUND_ADDRESS, REBALANCER_ADDRESS, FUND_GOVERNANCE_ADDRESS, QUEUE_ADDRESS,
///         FUND_RECEIPT_ADDRESS, RECEIPT_ADMIN_ADDRESS, SAFE_ADDRESS, SAFE_OWNERS, SAFE_THRESHOLD, EMERGENCY_ADDRESS,
///         KEEPER_ADDRESS, TIMELOCK_MIN_DELAY, DEPLOYMENT_OUT. DEPLOYMENT_KIND selects the rehearsal delay floor.
contract DeployFundTimelock is CoreTimelockHandover, FundTimelockPolicy {
    /// @notice Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "fund-timelock.json";

    bytes32 internal constant DEFAULT_ADMIN = 0x00;

    /// @dev The fund system's executor policy (decision D4-10): the Safe.
    function _timelockExecutor(address safe)
        internal
        pure
        override(UpgradeAuthority, FundTimelockPolicy)
        returns (address)
    {
        return FundTimelockPolicy._timelockExecutor(safe);
    }

    struct Deployed {
        address timelock;
        address fund;
        address rebalancer;
        address governance;
        address queue;
        address receipts;
        address receiptAdmin;
        address safe;
        address emergency;
        address keeper;
        uint256 minDelay;
        bool rehearsal;
    }

    /// @notice Forge broadcast entrypoint.
    function run() external returns (Deployed memory d) {
        d.fund = _envAddressRequired("FUND_ADDRESS");
        d.rebalancer = _envAddressRequired("REBALANCER_ADDRESS");
        d.governance = _envAddressRequired("FUND_GOVERNANCE_ADDRESS");
        d.queue = _envAddressRequired("QUEUE_ADDRESS");
        d.receipts = _envAddressRequired("FUND_RECEIPT_ADDRESS");
        d.receiptAdmin = _envAddressRequired("RECEIPT_ADMIN_ADDRESS");
        d.safe = _envAddressRequired("SAFE_ADDRESS");
        d.emergency = _envAddressRequired("EMERGENCY_ADDRESS");
        d.keeper = _envAddressRequired("KEEPER_ADDRESS");
        d.minDelay = _envUintRequired("TIMELOCK_MIN_DELAY");
        d.rehearsal = _readRehearsal("");
        address[] memory owners = _readAddressList("SAFE_OWNERS"); // a required vm.envAddress list
        uint256 threshold = _envUintRequired("SAFE_THRESHOLD");
        _envStringRequired("DEPLOYMENT_OUT");
        _requireExpectedChain("");
        _validate(d, owners, threshold);

        vm.startBroadcast();
        d.timelock = address(_deployTimelockAtPrediction(d.safe, d.minDelay));
        _requireNamesTimelock(d.fund, d.timelock);
        _requireNamesTimelock(d.rebalancer, d.timelock);
        _requireNamesTimelock(d.governance, d.timelock);
        _requireNamesTimelock(d.queue, d.timelock);
        _requireNamesTimelock(d.receipts, d.timelock);
        _handOver(d);
        vm.stopBroadcast();

        _check(d);
        _writeJson(d);
    }

    function _validate(Deployed memory d, address[] memory owners, uint256 threshold)
        internal
        view
    {
        address[6] memory c = [d.fund, d.rebalancer, d.governance, d.queue, d.receipts, d.safe];
        for (uint256 i = 0; i < c.length; i++) {
            require(
                c[i] != address(0) && c[i].code.length > 0,
                "a fund-system address is zero or has no code"
            );
        }
        require(d.receiptAdmin != address(0), "RECEIPT_ADMIN_ADDRESS=0");
        require(
            d.emergency != address(0) && d.keeper != address(0),
            "EMERGENCY_ADDRESS or KEEPER_ADDRESS is zero"
        );
        require(d.minDelay > 0, "TIMELOCK_MIN_DELAY=0");
        // ACL-1 / F-01: the emergency key is independent of the deployer EOA.
        require(d.emergency != msg.sender, "EMERGENCY_ADDRESS == deployer EOA");
        _requireDelayFloor(d.minDelay, d.rehearsal);
        _requireRealSafe(d.safe, owners, threshold);
    }

    /// @dev Grant first, then drop the deployer's copy: no contract is ever left without an admin.
    function _handOver(Deployed memory d) internal {
        _moveRole(d.fund, Roles.ADMIN_ROLE, d.timelock);
        _moveRole(d.rebalancer, Roles.ADMIN_ROLE, d.timelock);
        _moveRole(d.governance, Roles.ADMIN_ROLE, d.timelock);
        _moveRole(d.governance, Roles.TARGET_SETTER_ROLE, d.timelock);
        _moveRole(d.queue, Roles.ADMIN_ROLE, d.timelock);

        IAccessControl r = IAccessControl(d.receipts);
        r.grantRole(Roles.ADMIN_ROLE, d.timelock);
        r.grantRole(DEFAULT_ADMIN, d.timelock);
        r.revokeRole(Roles.ADMIN_ROLE, d.receiptAdmin);
        r.revokeRole(DEFAULT_ADMIN, d.receiptAdmin);
    }

    function _moveRole(address target, bytes32 role, address timelock) internal {
        IAccessControl(target).grantRole(role, timelock);
        IAccessControl(target).renounceRole(role, msg.sender);
    }

    /// @dev The state this stage exists to establish, read back from the chain.
    function _check(Deployed memory d) internal view {
        TimelockController tl = TimelockController(payable(d.timelock));
        require(tl.getMinDelay() == d.minDelay, "timelock minDelay");
        // Decision D4-10: the Safe alone executes; nobody else, and not address(0) (an open executor).
        require(tl.hasRole(tl.EXECUTOR_ROLE(), d.safe), "fund timelock EXECUTOR_ROLE is not the Safe");
        require(!tl.hasRole(tl.EXECUTOR_ROLE(), address(0)), "fund timelock executor is open");
        require(!tl.hasRole(tl.EXECUTOR_ROLE(), msg.sender), "deployer holds the fund timelock EXECUTOR_ROLE");
        address[4] memory admins = [d.fund, d.rebalancer, d.governance, d.queue];
        for (uint256 i = 0; i < admins.length; i++) {
            IAccessControl c = IAccessControl(admins[i]);
            require(c.hasRole(Roles.ADMIN_ROLE, d.timelock), "timelock lacks ADMIN_ROLE");
            require(!c.hasRole(Roles.ADMIN_ROLE, msg.sender), "deployer still holds ADMIN_ROLE");
            require(!c.hasRole(DEFAULT_ADMIN, msg.sender), "deployer holds DEFAULT_ADMIN_ROLE");
        }
        IAccessControl g = IAccessControl(d.governance);
        require(
            g.hasRole(Roles.TARGET_SETTER_ROLE, d.timelock)
                && !g.hasRole(Roles.TARGET_SETTER_ROLE, msg.sender),
            "governance TARGET_SETTER_ROLE is not the timelock alone"
        );
        IAccessControl r = IAccessControl(d.receipts);
        require(
            r.hasRole(Roles.ADMIN_ROLE, d.timelock) && r.hasRole(DEFAULT_ADMIN, d.timelock),
            "receipt admin is not the timelock"
        );
        require(
            !r.hasRole(Roles.ADMIN_ROLE, msg.sender) && !r.hasRole(DEFAULT_ADMIN, msg.sender),
            "deployer still administers the receipt register"
        );
        require(
            !r.hasRole(Roles.ADMIN_ROLE, d.governance), "governance holds the receipt ADMIN_ROLE"
        );
        require(
            IAccessControl(d.fund).hasRole(Roles.EMERGENCY_ROLE, d.emergency),
            "fund EMERGENCY_ROLE is not the emergency key"
        );
        require(
            IAccessControl(d.queue).hasRole(Roles.EMERGENCY_ROLE, d.emergency),
            "queue EMERGENCY_ROLE is not the emergency key"
        );
        require(
            !IAccessControl(d.fund).hasRole(Roles.EMERGENCY_ROLE, msg.sender),
            "deployer holds fund EMERGENCY_ROLE"
        );
        require(
            !IAccessControl(d.queue).hasRole(Roles.EMERGENCY_ROLE, msg.sender),
            "deployer holds queue EMERGENCY_ROLE"
        );
        require(
            IAccessControl(d.queue).hasRole(Roles.KEEPER_ROLE, d.keeper),
            "queue KEEPER_ROLE is not the keeper"
        );
        require(
            IAccessControl(d.rebalancer).hasRole(Roles.KEEPER_ROLE, d.keeper),
            "rebalancer KEEPER_ROLE is not the keeper"
        );
    }

    /// @dev ADR-0014: keccak256 of the code of `proxy`'s ERC-1967 implementation.
    function _implementationCodeHash(address proxy) internal view returns (bytes32) {
        address impl = _implementationOf(proxy);
        return impl == address(0) ? bytes32(0) : keccak256(impl.code);
    }

    function _writeJson(Deployed memory d) internal {
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");
        string memory hashes = "fund_timelock_code_hashes";
        vm.serializeBytes32(hashes, "timelock", d.timelock.codehash);
        vm.serializeBytes32(hashes, "safe", d.safe.codehash);
        vm.serializeBytes32(hashes, "fund_implementation", _implementationCodeHash(d.fund));
        vm.serializeBytes32(
            hashes, "rebalancer_implementation", _implementationCodeHash(d.rebalancer)
        );
        vm.serializeBytes32(
            hashes, "governance_implementation", _implementationCodeHash(d.governance)
        );
        vm.serializeBytes32(hashes, "queue_implementation", _implementationCodeHash(d.queue));
        string memory hashesJson = vm.serializeBytes32(
            hashes, "consensus_receipt_implementation", _implementationCodeHash(d.receipts)
        );

        string memory obj = "fund_timelock";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeUint(obj, "min_delay", d.minDelay);
        vm.serializeString(obj, "deployment_kind", d.rehearsal ? "rehearsal" : "production");
        vm.serializeString(obj, "executorPolicy", FUND_EXECUTOR_POLICY);
        vm.serializeString(obj, "cancellerPolicy", CANCELLER_POLICY);
        vm.serializeAddress(obj, "timelock", d.timelock);
        vm.serializeAddress(obj, "safe", d.safe);
        vm.serializeAddress(obj, "emergency", d.emergency);
        vm.serializeAddress(obj, "keeper", d.keeper);
        vm.serializeAddress(obj, "fund", d.fund);
        vm.serializeAddress(obj, "rebalancer", d.rebalancer);
        vm.serializeAddress(obj, "governance", d.governance);
        vm.serializeAddress(obj, "queue", d.queue);
        vm.serializeAddress(obj, "consensus_receipt", d.receipts);
        string memory json = vm.serializeString(obj, "code_hashes", hashesJson);
        vm.writeJson(json, outPath);
        console2.log("Wrote fund-timelock deployment manifest to", outPath);
    }
}
