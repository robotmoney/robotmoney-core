// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

/// @notice Fork selection for tests that need real Base state. The golden-fork runner serves the
///         pinned fixture on 127.0.0.1:8545 and sets FORK_REQUIRED=1: an unreachable endpoint then
///         fails the test. Without FORK_REQUIRED an unreachable endpoint skips the test, so the plain
///         unit run stays green on a machine with no chain.
library ForkSelect {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function selectOrSkip(string memory rpc) internal returns (bool selected) {
        try vm.createSelectFork(rpc) returns (uint256) {
            return true;
        } catch (bytes memory reason) {
            if (vm.envOr("FORK_REQUIRED", false)) {
                assembly {
                    revert(add(reason, 32), mload(reason))
                }
            }
            vm.skip(true);
            return false;
        }
    }
}
