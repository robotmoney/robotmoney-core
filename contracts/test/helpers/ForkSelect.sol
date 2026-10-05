// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

/// @notice Fork selection for tests that need real Base state. The state comes from the Twin chain
///         (chain id 918453), a pinned lazy anvil fork of real Base, whose RPC URL the caller puts in
///         FORK_RPC_URL (scripts/devnet/twin-fork.ts, .github/actions/twin-fork). With FORK_RPC_URL
///         unset the test skips with a named reason, so the plain unit run stays green on a machine
///         with no chain. With it set, an unreachable endpoint fails the test: a configured fork that
///         cannot be reached is never a silent skip.
library ForkSelect {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant SKIP_REASON =
        "FORK_RPC_URL unset: start the Twin fork (bun scripts/devnet/twin-fork.ts start) and export its URL";

    function selectOrSkip(string memory rpc) internal returns (bool selected) {
        if (bytes(rpc).length == 0) {
            vm.skip(true, SKIP_REASON);
            return false;
        }
        vm.createSelectFork(rpc);
        return true;
    }
}
