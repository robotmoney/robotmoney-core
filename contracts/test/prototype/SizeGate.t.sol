// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §13 gate G1 (EIP-170 headroom), §4 (fund), §5
//            (rebalancer), §6 and §6.1 (FlowQueue row, size); scaffold plan §1 item 5, §7.5 item 6
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {PrototypeHarness} from "./PrototypeHarness.sol";
import {FundValuationLib} from "./src/lib/FundValuationLib.sol";
import {FundAdminLib} from "./src/lib/FundAdminLib.sol";
import {FundFlowsLib} from "./src/lib/FundFlowsLib.sol";
import {FundPositionLib} from "./src/lib/FundPositionLib.sol";
import {FundStorage} from "./src/lib/FundStorage.sol";
import {FlowCheckLib} from "./src/lib/FlowCheckLib.sol";
import {FlowSettleLib} from "./src/lib/FlowSettleLib.sol";
import {FlowClaimLib} from "./src/lib/FlowClaimLib.sol";
import {PlanMath} from "./src/PlanMath.sol";

/// @notice One-vault experiment (plan Step 2.2, gate G1; step 3d adds the queue): the fund, the rebalancer and the
///         FlowQueue implementations each deploy under EIP-170 (24,576 bytes, a limit the chain enforces), and
///         every linked library they call deploys at all. Sizes are read from the code the harness actually
///         deployed (the ERC-1967 implementation behind each proxy, the libraries forge linked), compiled with the
///         repo's production optimizer settings. The limit is never edited to pass. The 1 KB headroom G1 first asked
///         for was a chosen margin, not a chain limit; the owner removed it on 2026-11-12 (proposal §13).
contract SizeGateTest is PrototypeHarness {
    /// @dev EIP-170 runtime code limit.
    uint256 internal constant EIP170_LIMIT = 24_576;
    /// @dev G1: the EIP-170 limit itself (owner, 2026-11-12: the earlier 1 KB headroom was arbitrary).
    uint256 internal constant G1_MAX = EIP170_LIMIT;

    function setUp() public override {
        super.setUp();
    }

    function _impl(address proxy) internal view returns (address impl) {
        impl = address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
        assertTrue(impl != address(0) && impl != proxy, "proxy has an implementation");
    }

    /// @notice G1 (§13): fund, rebalancer and queue implementation `code.length` <= 24,576 (EIP-170) each. Logs every size for
    ///         the evidence log, including governance, the fund's exclusion ledger and each linked library.
    function test_G1_fundRebalancerAndQueueFitWithHeadroom() public fixtureCovered {
        uint256 fundSize = _impl(address(fund)).code.length;
        uint256 rebalancerSize = _impl(address(rebalancer)).code.length;
        uint256 queueSize = _impl(address(queue)).code.length;
        uint256 governanceSize = _impl(address(governance)).code.length;
        uint256 ledgerSize = fund.exclusionLedger().code.length;

        console2.log("G1 limit (EIP-170)          ", G1_MAX);
        console2.log("RobotMoneyFund impl         ", fundSize);
        console2.log("Rebalancer impl             ", rebalancerSize);
        console2.log("FlowQueue impl              ", queueSize);
        console2.log("RebalanceGovernance impl    ", governanceSize);
        console2.log("FundExclusionLedger         ", ledgerSize);
        // Linked libraries (public functions, DELEGATECALLed): deployed separately, each under EIP-170.
        console2.log("FundValuationLib (linked)   ", address(FundValuationLib).code.length);
        console2.log("FundAdminLib (linked)       ", address(FundAdminLib).code.length);
        console2.log("FundFlowsLib (linked)       ", address(FundFlowsLib).code.length);
        console2.log("FundPositionLib (linked)    ", address(FundPositionLib).code.length);
        console2.log("FlowCheckLib (linked)       ", address(FlowCheckLib).code.length);
        console2.log("FlowSettleLib (linked)      ", address(FlowSettleLib).code.length);
        console2.log("FlowClaimLib (linked)       ", address(FlowClaimLib).code.length);
        // Internal-only libraries: inlined into callers; the stub below is never deployed.
        console2.log("FundStorage (inlined stub)  ", type(FundStorage).runtimeCode.length);
        console2.log("PlanMath (inlined stub)     ", type(PlanMath).runtimeCode.length);
        console2.log("Fund headroom under G1      ", fundSize <= G1_MAX ? G1_MAX - fundSize : 0);
        console2.log("Queue headroom under G1     ", queueSize <= G1_MAX ? G1_MAX - queueSize : 0);

        assertGt(fundSize, 0, "fund impl deployed");
        assertGt(rebalancerSize, 0, "rebalancer impl deployed");
        assertGt(queueSize, 0, "queue impl deployed");
        assertLe(fundSize, G1_MAX, "G1: RobotMoneyFund impl exceeds EIP-170 (24,576 bytes)");
        assertLe(rebalancerSize, G1_MAX, "G1: Rebalancer impl exceeds EIP-170 (24,576 bytes)");
        assertLe(queueSize, G1_MAX, "G1: FlowQueue impl exceeds EIP-170 (24,576 bytes)");
        // Every linked library must itself be deployable (EIP-170), or its caller cannot link.
        assertLe(
            address(FundValuationLib).code.length, EIP170_LIMIT, "FundValuationLib over EIP-170"
        );
        assertLe(address(FundAdminLib).code.length, EIP170_LIMIT, "FundAdminLib over EIP-170");
        assertLe(address(FundFlowsLib).code.length, EIP170_LIMIT, "FundFlowsLib over EIP-170");
        assertLe(address(FundPositionLib).code.length, EIP170_LIMIT, "FundPositionLib over EIP-170");
        assertLe(address(FlowCheckLib).code.length, EIP170_LIMIT, "FlowCheckLib over EIP-170");
        assertLe(address(FlowSettleLib).code.length, EIP170_LIMIT, "FlowSettleLib over EIP-170");
        assertLe(address(FlowClaimLib).code.length, EIP170_LIMIT, "FlowClaimLib over EIP-170");
        assertLe(ledgerSize, EIP170_LIMIT, "FundExclusionLedger over EIP-170");
        assertLe(governanceSize, EIP170_LIMIT, "RebalanceGovernance over EIP-170");
    }
}
