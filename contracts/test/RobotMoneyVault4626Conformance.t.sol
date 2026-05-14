// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626Test} from "erc4626-tests/ERC4626.test.sol";
import {IERC20 as OZIERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {PassthroughAdapter} from "../adapters/PassthroughAdapter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @title RobotMoneyVault4626Conformance
/// @notice Property-based ERC-4626 conformance tests for RobotMoneyVault, built on
///         the a16z `erc4626-tests` suite.
///
/// @dev Configured for the *vanilla* ERC-4626 surface: `exitFeeBps == 0` so that
///      `preview*` ↔ `redeem`/`withdraw` parity holds without fee adjustment. A
///      single `PassthroughAdapter` is registered with a 100% cap so that
///      `_deposit`'s `NoActiveAdapters` guard passes and yield can be simulated
///      by minting to the vault's idle balance (counted by `totalAssets()`).
///
///      Direct invocation must skip the deprecated `testFail_*` names that the
///      a16z suite still ships (modern forge rejects them and aborts the
///      whole contract). CI (suite-01-02-forge-tests.yml) passes the same
///      filter globally for `forge test` and `forge coverage`:
///
///        forge test --match-contract RobotMoneyVault4626Conformance \
///          --no-match-test "^testFail_"
contract RobotMoneyVault4626Conformance is ERC4626Test {
    function setUp() public override {
        TestERC20 underlying = new TestERC20();

        RobotMoneyVault vault = new RobotMoneyVault(
            OZIERC20(address(underlying)),
            type(uint256).max, // tvlCap — unbounded for fuzzing
            type(uint256).max, // perDepositCap — unbounded for fuzzing
            0, // exitFeeBps — zero so vanilla 4626 props hold
            address(this), // feeRecipient (unused at zero fee)
            address(this) // admin — this test contract
        );

        PassthroughAdapter adapter = new PassthroughAdapter(address(underlying), address(vault));
        vault.addAdapter(address(adapter), 10000); // 100% cap

        _underlying_ = address(underlying);
        _vault_ = address(vault);
        _delta_ = 0;
        _vaultMayBeEmpty = true;
        _unlimitedAmount = false;
    }
}
