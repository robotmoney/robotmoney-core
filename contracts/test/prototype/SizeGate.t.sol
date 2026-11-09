// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §13 gate G1 (EIP-170 headroom), §4 (fund), §5 (rebalancer)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {PrototypeHarness} from "./PrototypeHarness.sol";
import {FundValuationLib} from "./src/lib/FundValuationLib.sol";
import {FundAdminLib} from "./src/lib/FundAdminLib.sol";
import {FundFlowsLib} from "./src/lib/FundFlowsLib.sol";
import {FundStorage} from "./src/lib/FundStorage.sol";
import {PlanMath} from "./src/PlanMath.sol";

/// @notice One-vault experiment (plan Step 2.2, gate G1): the fund implementation and the rebalancer
///         implementation each deploy with at least 1 KB of headroom under EIP-170 (24,576 bytes).
///         Sizes are read from the code the harness actually deployed (the ERC-1967 implementation
///         behind each proxy), compiled with the repo's production optimizer settings.
contract SizeGateTest is PrototypeHarness {
    /// @dev EIP-170 runtime code limit.
    uint256 internal constant EIP170_LIMIT = 24_576;
    /// @dev G1 headroom: 1 KB under the EIP-170 limit.
    uint256 internal constant G1_MAX = EIP170_LIMIT - 1024; // 23,552

    function setUp() public override {
        super.setUp();
    }

    function _impl(address proxy) internal view returns (address impl) {
        impl = address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
        assertTrue(impl != address(0) && impl != proxy, "proxy has an implementation");
    }

    /// @notice G1 (§13): fund implementation and rebalancer implementation `code.length` <= 23,552 each.
    ///         Logs governance and every prototype library for the §14 evidence log.
    function test_G1_fundAndRebalancerFitWithHeadroom() public fixtureCovered {
        uint256 fundSize = _impl(address(fund)).code.length;
        uint256 rebalancerSize = _impl(address(rebalancer)).code.length;
        uint256 governanceSize = _impl(address(governance)).code.length;

        console2.log("G1 limit (EIP-170 - 1 KB)   ", G1_MAX);
        console2.log("RobotMoneyFund impl         ", fundSize);
        console2.log("Rebalancer impl             ", rebalancerSize);
        console2.log("RebalanceGovernance impl    ", governanceSize);
        // Linked libraries (public functions, DELEGATECALLed by the fund): deployed separately.
        console2.log("FundValuationLib (linked)   ", address(FundValuationLib).code.length);
        console2.log("FundAdminLib (linked)       ", address(FundAdminLib).code.length);
        console2.log("FundFlowsLib (linked)       ", address(FundFlowsLib).code.length);
        // Internal-only libraries: inlined into callers; the stub below is never deployed.
        console2.log("FundStorage (inlined stub)  ", type(FundStorage).runtimeCode.length);
        console2.log("PlanMath (inlined stub)     ", type(PlanMath).runtimeCode.length);

        assertGt(fundSize, 0, "fund impl deployed");
        assertGt(rebalancerSize, 0, "rebalancer impl deployed");
        assertLe(fundSize, G1_MAX, "G1: RobotMoneyFund impl exceeds 23,552 bytes");
        assertLe(rebalancerSize, G1_MAX, "G1: Rebalancer impl exceeds 23,552 bytes");
        // Every linked library must itself be deployable (EIP-170), or the fund cannot link.
        assertLe(address(FundValuationLib).code.length, EIP170_LIMIT, "FundValuationLib over EIP-170");
        assertLe(address(FundAdminLib).code.length, EIP170_LIMIT, "FundAdminLib over EIP-170");
        assertLe(address(FundFlowsLib).code.length, EIP170_LIMIT, "FundFlowsLib over EIP-170");
        assertLe(governanceSize, EIP170_LIMIT, "RebalanceGovernance over EIP-170");
    }
}
