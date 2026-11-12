// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md §4.2 ("Reentrancy: a hostile token callback during
//            `mintInKind`, the sale or a claim cannot mint, pay twice or re-enter the queue"), §6 ("the rounding and
//            reentrancy tests in §4.2 carry more weight than usual"); scaffold plan §6 (`P/mocks/*.sol`: test agents add
//            theirs; mechanism-tests owns the files named `Mech*`)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

/// @title MechReentry
/// @notice Re-entry probe shared by the hostile venue mocks of `FlowQueue.t.sol`. While armed, every hook the venue
///         exposes to the fund (a swap, a supply, a withdrawal) first tries each state-changing entry point of the
///         FlowQueue and the fund from the venue's own address, records how each call ended, and then carries on
///         honestly. The fund's basket tokens (wETH, cbBTC) and USDC have no transfer hooks, so the only external
///         code the fund and the queue hand control to mid-flow is the venue adapter: this models the "hostile token
///         callback" of the eng plan at that seam.
///
///         Storage: the venue mocks are etched over adapters whose own code keeps no storage (immutables only), so
///         the fields below start at slot 0 without colliding with anything.
abstract contract MechReentry {
    /// @notice One re-entry attempt: the hook it ran from, the target, the selector called, whether it succeeded and
    ///         the first four bytes of its revert data.
    struct Attempt {
        bytes4 hook;
        address target;
        bytes4 selector;
        bool ok;
        bytes4 err;
    }

    Attempt[] internal _attempts;
    address public reQueue;
    address public reFund;
    address public reVictim;
    uint256 public reRequestId;
    bool public reArmed;

    /// @notice Arm the probe: every later hook tries to re-enter `queue` and `fund`. `victim` is an owner whose
    ///         claims a thief would want; `requestId` a request the probe tries to cancel or exit.
    function arm(address queue, address fund, address victim, uint256 requestId) external {
        reQueue = queue;
        reFund = fund;
        reVictim = victim;
        reRequestId = requestId;
        reArmed = true;
    }

    function disarm() external {
        reArmed = false;
    }

    function attemptCount() external view returns (uint256) {
        return _attempts.length;
    }

    function attemptAt(uint256 i) external view returns (Attempt memory) {
        return _attempts[i];
    }

    /// @dev Try every entry point once from this hook. Each call is expected to fail: the queue's one reentrancy
    ///      lock, the fund's own lock, or the fund's role checks.
    function _reenter(bytes4 hook) internal {
        if (!reArmed) return;
        address q = reQueue;
        address f = reFund;
        address v = reVictim;
        uint256 id = reRequestId;
        _try(hook, q, abi.encodeWithSignature("settle(uint256,uint256)", uint256(256), type(uint256).max));
        _try(hook, q, abi.encodeWithSignature("withdrawCredit()"));
        _try(hook, q, abi.encodeWithSignature("mint(uint256,address)", uint256(1), v));
        _try(hook, q, abi.encodeWithSignature("deposit(uint256,address)", uint256(1), v));
        _try(hook, q, abi.encodeWithSignature("redeem(uint256,address,address)", uint256(1), address(this), v));
        _try(hook, q, abi.encodeWithSignature("cancel(uint256)", id));
        _try(hook, q, abi.encodeWithSignature("exitInKind(uint256)", id));
        _try(hook, q, abi.encodeWithSignature("withdrawExpired(uint256)", id));
        _try(hook, q, abi.encodeWithSignature("takeReturn(uint256)", uint256(1)));
        _try(
            hook,
            q,
            abi.encodeWithSignature("requestDeposit(uint256,uint256,address)", uint256(100e6), type(uint256).max, v)
        );
        _try(hook, f, abi.encodeWithSignature("redeemInKind(uint256,address,address)", uint256(1), address(this), v));
        _try(hook, f, abi.encodeWithSignature("mintInKind(uint256,uint256,uint256[])", uint256(1), uint256(0), new uint256[](0)));
        _try(hook, f, abi.encodeWithSignature("sellForFlow(uint256,uint256[])", uint256(1), new uint256[](0)));
        _try(hook, f, abi.encodeWithSignature("claimPosition(uint256,address)", uint256(0), address(this)));
    }

    function _try(bytes4 hook, address target, bytes memory data) private {
        (bool ok, bytes memory ret) = target.call(data);
        bytes4 sel;
        bytes4 err;
        bytes32 mask = bytes32(type(uint256).max << 224);
        assembly {
            sel := and(mload(add(data, 32)), mask)
        }
        if (ret.length >= 4) {
            assembly {
                err := and(mload(add(ret, 32)), mask)
            }
        }
        _attempts.push(Attempt({hook: hook, target: target, selector: sel, ok: ok, err: err}));
    }
}
