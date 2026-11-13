// SPDX-License-Identifier: MIT
// Canonical: docs/technical/contract-upgradeability-plan.md — Mechanism and authority (timelock-last stage order)
// (See also: contracts/script/UpgradeAuthority.sol; publish-contracts/src/timelock-pin.ts; issue 1853)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {UpgradeAuthority} from "../script/UpgradeAuthority.sol";
import {FundTimelockPolicy} from "../script/FundTimelockPolicy.sol";

/// @dev The prediction every proxy stage names, with nothing else.
contract PredictionHarness is UpgradeAuthority {}

/// @dev The fund system's prediction (decision D4-10): the Safe is the timelock's only executor.
contract FundPredictionHarness is FundTimelockPolicy {}

/// @notice Issue 1853. publish-contracts derives the core timelock address in TypeScript
///         (`predictCoreTimelock`) from the build artifact and the stage table, pins it at the
///         first proxy stage and refuses a later stage whose recomputed prediction differs. Its
///         runner tests use a stub forge that calls the same TypeScript, so they cannot show it
///         equals `UpgradeAuthority.predictTimelock`, which the stage scripts really use. This test
///         writes the Solidity prediction for fixed vectors to `VECTORS`;
///         `scripts/ci/check-timelock-prediction-parity.ts` recomputes each one in TypeScript from
///         the same `out/` build and fails on any difference.
contract UpgradeAuthorityPredictionTest is Test {
    string internal constant VECTORS = "out/timelock-prediction-vectors.json";

    function test_writesPredictionVectors() public {
        UpgradeAuthority h = new PredictionHarness();
        UpgradeAuthority f = new FundPredictionHarness();
        address[4] memory safes = [
            address(uint160(0x50fe)),
            makeAddr("robotmoney.core.safe"),
            address(uint160(0xdead)),
            address(type(uint160).max)
        ];
        uint256[4] memory delays = [uint256(1), 60, 2 days, type(uint64).max];
        string memory rows;
        for (uint256 k = 0; k < 2 * safes.length; k++) {
            uint256 i = k % safes.length;
            bool fund = k >= safes.length;
            UpgradeAuthority a = fund ? f : h;
            address predicted = a.predictTimelock(safes[i], delays[i]);
            bytes32 initCodeHash = keccak256(a.timelockInitCode(safes[i], delays[i]));
            if (fund) {
                assertTrue(predicted != h.predictTimelock(safes[i], delays[i]), "the executor moves the address");
            }
            assertEq(
                predicted,
                vm.computeCreate2Address(h.TIMELOCK_SALT(), initCodeHash, CREATE2_FACTORY)
            );
            rows = string.concat(
                rows,
                k == 0 ? "" : ",",
                '{"executor":"',
                fund ? "safe" : "open",
                '","safe":"',
                vm.toString(safes[i]),
                '","minDelay":"',
                vm.toString(delays[i]),
                '","address":"',
                vm.toString(predicted),
                '","initCodeHash":"',
                vm.toString(initCodeHash),
                '"}'
            );
        }
        vm.writeFile(VECTORS, string.concat('{"vectors":[', rows, "]}"));
    }
}
