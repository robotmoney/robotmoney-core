// SPDX-License-Identifier: MIT
// Canonical: docs/audits.md FS-VLT-27 (issue 2055)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {RobotMoneyFund} from "../RobotMoneyFund.sol";
import {ForkSelect} from "./helpers/ForkSelect.sol";

/// @notice The live fund proxy stores underlying decimals 6, so an in-place swap to the new implementation (the
///         OpenZeppelin `decimals()` default) reports 24 and moves no balance. The swap is a local `vm.store` on the
///         fork, never a transaction. Skips only while FORK_RPC_URL is unset (see ForkSelect).
contract FundDecimalsForkTest is Test {
    address internal constant FUND = 0xb2c17a384b6fc03d96D77f39E016aD7b9E34af2B;
    bytes32 internal constant ERC4626_SLOT =
        0x0773e532dfede91f04b12a73d3d2acd361424f41f76b4fb79f090161e36b4e00;
    bytes32 internal constant IMPL_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function test_liveProxy_decimalsIs24AfterTheImplementationSwap() public {
        if (!ForkSelect.selectOrSkip(vm.envOr("FORK_RPC_URL", string("")))) return;
        uint256 slot = uint256(vm.load(FUND, ERC4626_SLOT));
        assertEq(uint8(slot >> 160), 6, "stored underlying decimals");
        uint256 supplyBefore = IERC20Metadata(FUND).totalSupply();

        vm.store(FUND, IMPL_SLOT, bytes32(uint256(uint160(address(new RobotMoneyFund())))));
        assertEq(IERC20Metadata(FUND).decimals(), 24, "decimals = 24");
        assertEq(IERC20Metadata(FUND).totalSupply(), supplyBefore, "supply unchanged");
    }
}
