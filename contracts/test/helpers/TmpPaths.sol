// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

/// @title TmpPaths
/// @notice Scratch-file paths for forge tests that no other test, thread or forge process shares (issue #1735).
/// @dev Forge runs the test contracts, and the tests inside one contract, in parallel threads. Three
///      facts make a "random" file name collide. `vm.randomUint` is seeded the same way for every
///      test. Every test contract is deployed at the same address, so `address(this)` is not a
///      salt. `setUp` runs once per test, so a path built there is shared by the tests of a
///      contract unless it is claimed. The first flake of this kind was one shared manifest name:
///      a sibling's `setUp` removed the file a test had just written. Two ways out:
///      `claimTmpPath` takes a directory atomically (`createDir` without `recursive` fails when the
///      directory exists), so concurrent callers always get different paths and `releaseTmpPath` frees it.
///      `uniqueTmpPath` has no claim and no clean-up duty. It is unique only if the tag is unique to
///      one test contract (it adds the wall clock for separate forge processes). The guard
///      `.github/scripts/check_test_tmp_paths.py` fails CI when a tag or a /tmp literal is shared.

/// @dev Atomically claims a fresh directory under /tmp and returns a file path inside it. The caller
///      must call `releaseTmpPath` when done. `tag` documents the owner.
function claimTmpPath(Vm cheats, string memory tag) returns (string memory) {
    uint256 start = cheats.unixTime();
    for (uint256 i = 0; i < 100_000; i++) {
        string memory dir =
            string.concat("/tmp/rm-test-", tag, "-", cheats.toString(start + i), ".claim");
        try cheats.createDir(dir, false) {
            return string.concat(dir, "/file.json");
        } catch {}
    }
    revert("claimTmpPath: no free directory");
}

/// @dev Removes the directory `claimTmpPath` created, and the file in it. Removes only that claim.
function releaseTmpPath(Vm cheats, string memory path) {
    string memory dir = path;
    bytes memory b = bytes(path);
    uint256 n = b.length;
    // Strip the "/file.json" suffix (10 bytes) that claimTmpPath appended.
    require(n > 10, "releaseTmpPath: not a claimed path");
    bytes memory d = new bytes(n - 10);
    for (uint256 i = 0; i < d.length; i++) {
        d[i] = b[i];
    }
    dir = string(d);
    require(cheats.contains(dir, ".claim"), "releaseTmpPath: not a claimed path");
    if (cheats.exists(dir)) cheats.removeDir(dir, true);
}

/// @dev A path for a tag that is unique to one test contract. The wall clock keeps two forge
///      processes on one machine apart.
function uniqueTmpPath(Vm cheats, string memory tag) view returns (string memory) {
    return string.concat("/tmp/rm-test-", tag, "-", cheats.toString(cheats.unixTime()), ".json");
}
