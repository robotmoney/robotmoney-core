// SPDX-License-Identifier: MIT
// Canonical: robotmoney/devops issue 53 / core issue 1499, core S1 (issue 1483): no default cap or recipient in a deploy script.
pragma solidity ^0.8.24;

import {DeployVault} from "../../script/DeployVault.s.sol";

/// @notice Test-only inputs for the in-process `DeployVault` entrypoints. The production script
///         holds no default cap, recipient or seed: every in-process caller passes explicit
///         params, and the test constants live here.
library VaultTestParams {
    uint256 internal constant TEST_TVL_CAP = 10_000_000 * 1e6;
    uint256 internal constant TEST_PER_DEPOSIT_CAP = 1_000_000 * 1e6;
    /// @dev 1 USDC (6 decimals), the seed the fork tests deposit.
    uint256 internal constant SEED_DEPOSIT_AMOUNT = 1 * 1e6;
    /// @dev A fee recipient that is never the admin or the test contract (the script rejects both).
    address internal constant TEST_FEE_RECIPIENT =
        address(uint160(uint256(keccak256("rmpc.test.fee-recipient"))));

    function params(address admin_, address usdc_)
        internal
        pure
        returns (DeployVault.Params memory p)
    {
        p.admin = admin_;
        p.feeRecipient = TEST_FEE_RECIPIENT;
        p.tvlCap = TEST_TVL_CAP;
        p.perDepositCap = TEST_PER_DEPOSIT_CAP;
        p.usdcAddress = usdc_;
    }
}
