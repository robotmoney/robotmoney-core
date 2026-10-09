// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §4 — Access control & admin (Timelock bypass → Mitigated)
// Canonical: docs/technical/governance-isomorphism.md — the test governance path is the production one
// Implements: issue #1644 — governed-path tests run through a real two-signature Safe execTransaction
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {SafeFixture} from "./SafeFixture.sol";
import {RoleHolders} from "./RoleHolders.sol";

/// @dev The two Safe 1.4.1 calls the helper makes.
interface ISafeTx {
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool success);

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        uint256 _nonce
    ) external view returns (bytes32);

    function nonce() external view returns (uint256);
}

/// @dev Runs one call from inside the Safe's own context (the Safe delegatecalls it through
///      `simulateAndRevert`), so the target sees `msg.sender == the Safe` with no prank.
contract SafeCallRelay {
    function relay(address target, bytes calldata data)
        external
        returns (bool ok, bytes memory ret)
    {
        (ok, ret) = target.call(data);
    }
}

/// @title SafeGovernance
/// @notice Runs a governed call the way production does: two of the three Safe owners sign a
///         `SafeTx`, the real SafeL2 proxy runs `execTransaction`, the Safe calls the
///         `TimelockController`, and the timelock calls the governed contract. TEST HELPER ONLY.
/// @dev Pranking the Safe address skips the quorum, so a test that uses it proves nothing about the Safe.
///      Every helper here signs with the owner keys behind `SafeFixture._fixtureOwners()`
///      (`makeAddr("safe-owner-N")` is `vm.addr(keccak256("safe-owner-N"))`).
///      The timelock mirrors DeployTimelock: the Safe is the only proposer and so the only
///      canceller (issue #1521, security-model.md line 89), EXECUTOR_ROLE is open, and the
///      timelock administers itself.
abstract contract SafeGovernance is SafeFixture {
    using RoleHolders for Vm.Log[];

    /// @dev `Safe.execTransaction` reverts with this reason when the inner call fails and the
    ///      transaction set neither `safeTxGas` nor `gasPrice`. It hides the inner error.
    string internal constant GS013 = "GS013";

    /// @dev The timelock operation states, as a bitmap, the way TimelockController encodes the
    ///      `expectedStates` argument of `TimelockUnexpectedOperationState`.
    function _stateMask(TimelockController.OperationState s) internal pure returns (bytes32) {
        return bytes32(1 << uint8(s));
    }

    // ─── Signing ──────────────────────────────────────────────────────────────

    /// @dev The three owner keys, sorted ascending by owner address (Safe requires that order).
    function _sortedOwnerKeys() internal pure returns (uint256[3] memory ks) {
        ks = [
            uint256(keccak256("safe-owner-1")),
            uint256(keccak256("safe-owner-2")),
            uint256(keccak256("safe-owner-3"))
        ];
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = i + 1; j < 3; j++) {
                if (_addr(ks[j]) < _addr(ks[i])) (ks[i], ks[j]) = (ks[j], ks[i]);
            }
        }
    }

    function _addr(uint256 pk) private pure returns (address) {
        return vm.addr(pk);
    }

    function _sig(uint256 pk, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Signatures of the two lowest-address owners: exactly the 2-of-3 quorum.
    function _twoOwnerSignatures(bytes32 digest) internal pure returns (bytes memory) {
        uint256[3] memory ks = _sortedOwnerKeys();
        return bytes.concat(_sig(ks[0], digest), _sig(ks[1], digest));
    }

    /// @dev One owner only: below the threshold.
    function _oneOwnerSignature(bytes32 digest) internal pure returns (bytes memory) {
        return _sig(_sortedOwnerKeys()[0], digest);
    }

    // ─── Safe execution ───────────────────────────────────────────────────────

    function _safeDigest(address safe_, address to, bytes memory data)
        internal
        view
        returns (bytes32)
    {
        return ISafeTx(safe_)
            .getTransactionHash(
                to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), ISafeTx(safe_).nonce()
            );
    }

    /// @dev Two owners sign and the Safe runs `to.call(data)`. Reverts with GS013 when the
    ///      inner call fails.
    function _safeExec(address safe_, address to, bytes memory data) internal returns (bool) {
        return _safeExecWith(safe_, to, data, _twoOwnerSignatures(_safeDigest(safe_, to, data)));
    }

    function _safeExecWith(address safe_, address to, bytes memory data, bytes memory signatures)
        internal
        returns (bool)
    {
        return ISafeTx(safe_)
            .execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), signatures);
    }

    // ─── Timelock ─────────────────────────────────────────────────────────────

    /// @dev Builds the production timelock shape and proves who holds each role from the
    ///      `RoleGranted` logs: the Safe is the only proposer and the only canceller, the
    ///      executor role is open (address(0)), and the timelock alone administers itself.
    function _newGovTimelock(address safe_, uint256 minDelay)
        internal
        returns (TimelockController tl)
    {
        vm.recordLogs();
        address[] memory proposers = new address[](1);
        proposers[0] = safe_;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        tl = new TimelockController(minDelay, proposers, executors, address(0));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        _assertOnly(logs.holders(address(tl), tl.PROPOSER_ROLE()), safe_, "proposer");
        _assertOnly(logs.holders(address(tl), tl.CANCELLER_ROLE()), safe_, "canceller");
        _assertOnly(logs.holders(address(tl), tl.EXECUTOR_ROLE()), address(0), "executor");
        _assertOnly(logs.holders(address(tl), tl.DEFAULT_ADMIN_ROLE()), address(tl), "admin");
    }

    function _assertOnly(address[] memory holders, address expected, string memory what)
        private
        pure
    {
        require(holders.length == 1 && holders[0] == expected, string.concat("role holder: ", what));
    }

    /// @dev Safe -> timelock.schedule.
    function _govSchedule(
        address safe_,
        TimelockController tl,
        address target,
        bytes memory data,
        bytes32 salt,
        uint256 delay
    ) internal returns (bytes32 id) {
        bool ok = _safeExec(
            safe_,
            address(tl),
            abi.encodeCall(tl.schedule, (target, 0, data, bytes32(0), salt, delay))
        );
        require(ok, "safe.execTransaction(schedule) failed");
        id = tl.hashOperation(target, 0, data, bytes32(0), salt);
    }

    /// @dev Safe -> timelock.execute.
    function _govExecute(
        address safe_,
        TimelockController tl,
        address target,
        bytes memory data,
        bytes32 salt
    ) internal {
        bool ok = _safeExec(
            safe_, address(tl), abi.encodeCall(tl.execute, (target, 0, data, bytes32(0), salt))
        );
        require(ok, "safe.execTransaction(execute) failed");
    }

    /// @dev Safe -> timelock.cancel.
    function _govCancel(address safe_, TimelockController tl, bytes32 id) internal {
        bool ok = _safeExec(safe_, address(tl), abi.encodeCall(tl.cancel, (id)));
        require(ok, "safe.execTransaction(cancel) failed");
    }

    /// @dev Schedule through the Safe, mine the delay, execute through the Safe.
    function _govRun(
        address safe_,
        TimelockController tl,
        address target,
        bytes memory data,
        bytes32 salt,
        uint256 delay
    ) internal returns (bytes32 id) {
        id = _govSchedule(safe_, tl, target, data, salt, delay);
        vm.warp(block.timestamp + delay);
        _govExecute(safe_, tl, target, data, salt);
    }

    /// @dev Executing an operation that is not Ready (still Waiting, or already Done after a
    ///      replay) fails with the exact reasons on both paths. Through the Safe the
    ///      reason is GS013. Called straight on the open-executor timelock the reason is
    ///      `TimelockUnexpectedOperationState(id, Ready)`.
    function _expectExecuteRefused(
        address safe_,
        TimelockController tl,
        address target,
        bytes memory data,
        bytes32 salt
    ) internal {
        bytes32 id = tl.hashOperation(target, 0, data, bytes32(0), salt);
        vm.expectRevert(
            abi.encodeWithSelector(
                TimelockController.TimelockUnexpectedOperationState.selector,
                id,
                _stateMask(TimelockController.OperationState.Ready)
            )
        );
        tl.execute(target, 0, data, bytes32(0), salt);

        bytes memory exec = abi.encodeCall(tl.execute, (target, 0, data, bytes32(0), salt));
        bytes memory sigs = _twoOwnerSignatures(_safeDigest(safe_, address(tl), exec));
        vm.expectRevert(bytes(GS013));
        _safeExecWith(safe_, address(tl), exec, sigs);
    }

    /// @dev A direct call from the Safe to a governed contract, with two real owner signatures,
    ///      fails: the Safe holds no admin role on it, only the timelock does. The Safe hides the
    ///      inner error as `GS013`, so the exact `AccessControlUnauthorizedAccount(safe, ADMIN_ROLE)`
    ///      is asserted by replaying the call with the Safe as `msg.sender`.
    function _expectDirectSafeCallRefused(address safe_, address target, bytes memory data)
        internal
    {
        // The exact inner reason: replayed with the Safe as msg.sender (no prank).
        _assertSafeCallReverts(
            safe_,
            target,
            data,
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", safe_, keccak256("ADMIN_ROLE")
            )
        );
        // And the real two-signature execTransaction is refused with GS013.
        bytes memory sigs = _twoOwnerSignatures(_safeDigest(safe_, target, data));
        vm.expectRevert(bytes(GS013));
        _safeExecWith(safe_, target, data, sigs);
    }

    SafeCallRelay private _relay;

    /// @dev Replays `target.call(data)` with the real Safe as `msg.sender` and returns the exact
    ///      inner result, including revert data that `execTransaction` would hide as `GS013`.
    ///      It uses the Safe's own `simulateAndRevert` (StorageAccessible), which reverts after
    ///      the call with `success, size, data`: no prank, and every state change is rolled
    ///      back. It proves who the callee sees, not the signature quorum (the
    ///      `execTransaction` helpers above prove the quorum).
    function _callAsSafe(address safe_, address target, bytes memory data)
        internal
        returns (bool ok, bytes memory ret)
    {
        if (address(_relay) == address(0)) _relay = new SafeCallRelay();
        (bool simulated, bytes memory out) = safe_.call(
            abi.encodeWithSignature(
                "simulateAndRevert(address,bytes)",
                address(_relay),
                abi.encodeCall(SafeCallRelay.relay, (target, data))
            )
        );
        require(!simulated && out.length >= 64, "simulateAndRevert did not revert as designed");
        bytes memory packed = new bytes(out.length - 64);
        for (uint256 i = 0; i < packed.length; i++) {
            packed[i] = out[i + 64];
        }
        (ok, ret) = abi.decode(packed, (bool, bytes));
    }

    /// @dev The Safe, called straight on `target` (no timelock), is refused with exactly
    ///      `expectedRevert`.
    function _assertSafeCallReverts(
        address safe_,
        address target,
        bytes memory data,
        bytes memory expectedRevert
    ) internal {
        (bool ok, bytes memory ret) = _callAsSafe(safe_, target, data);
        assertFalse(ok, "the Safe call should have reverted");
        assertEq(ret, expectedRevert, "exact inner revert");
    }
}
