// SPDX-License-Identifier: MIT
// Canonical: docs/technical/consensus-receipt-submitter-runbook.md (issue 1750, owner decision 2026-10-10: the receipt submitter is a multisig)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";
import {
    IConsensusRecommendationReceipt
} from "../gateway/interfaces/IConsensusRecommendationReceipt.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {MockVault} from "./helpers/MockVault.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";

/// @title ConsensusReceiptSafeSubmitterTest
/// @notice The consensus receipt SUBMITTER is a real SafeL2 1.4.1 proxy (a second Safe, separate from the governing Safe). It holds
///         AGENT_ROLE on the gateway and COMMITTEE_AGENT_ROLE on the IC policy and nothing else. The contracts make no msg.sender,
///         tx.origin, isContract or ecrecover check on the role holder, so a contract account is accepted unchanged. The policy is the
///         smallest legal one the publish tooling registers (1 raw unit per payment and per window, no withdrawals, shares to the timelock).
contract ConsensusReceiptSafeSubmitterTest is SafeGovernance {
    address admin = address(0xA0);
    address pauser = address(0xA1);
    address governingSafe;
    address submitterSafe;

    TestERC20 usdc;
    MockVault vault;
    RobotMoneyGateway gateway;
    InvestmentCommitteePolicy ic;
    ConsensusRecommendationReceipt receipts;
    TimelockController timelock;

    string constant URI = "https://twin.invalid/r.json";

    function setUp() public {
        usdc = new TestERC20();
        vault = new MockVault(address(usdc));
        gateway = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(0)
        );
        ic = new InvestmentCommitteePolicy(admin, address(gateway));
        _installSafeSet();
        governingSafe = _newDefaultSafe();
        submitterSafe = _newDefaultSafe(); // a SECOND Safe: same owner keys, a different address and its own nonce
        timelock = _newGovTimelock(governingSafe, 1 hours);
        receipts =
            new ConsensusRecommendationReceipt(address(timelock), address(gateway), address(ic));

        bytes32 icAdmin = ic.ADMIN_ROLE();
        vm.prank(admin);
        ic.grantRole(icAdmin, address(gateway));
        vm.startPrank(admin);
        gateway.setICPolicy(address(ic));
        gateway.setConsensusReceipt(address(receipts));
        address[] memory none = new address[](0);
        gateway.authorizeAgent(
            submitterSafe,
            IGateway.AgentPolicy({
                active: true,
                validUntil: uint64(block.timestamp + 90 days),
                maxPerPayment: 1,
                maxPerWindow: 1,
                shareReceiver: address(timelock),
                allowedDestinations: none,
                assetRecipient: address(0),
                maxWithdrawPerPayment: 0,
                maxWithdrawPerWindow: 0,
                allowedSourceVaults: none
            })
        );
        gateway.committeeRegister(submitterSafe, "safe-submitter");
        vm.stopPrank();
    }

    function _recordCall(bytes32 id, bytes32 digest) internal pure returns (bytes memory) {
        return abi.encodeCall(IGateway.consensusRecordReceipt, (id, digest, URI));
    }

    /// The Safe holds both roles and the receipt contract stores the Safe as the submitter.
    function testSafeSubmitterRecordsAReceiptWithTwoOwnerSignatures() public {
        assertTrue(gateway.hasRole(gateway.AGENT_ROLE(), submitterSafe), "AGENT_ROLE");
        assertTrue(ic.hasRole(ic.COMMITTEE_AGENT_ROLE(), submitterSafe), "COMMITTEE_AGENT_ROLE");
        bytes32 id = keccak256("receipt");
        bytes32 digest = keccak256("digest");
        uint256 nonceBefore = _nonce(submitterSafe);
        assertTrue(_safeExec(submitterSafe, address(gateway), _recordCall(id, digest)));
        assertEq(_nonce(submitterSafe), nonceBefore + 1, "the submitter Safe's own nonce moved");
        assertEq(_nonce(governingSafe), 0, "the governing Safe was not touched");
        IConsensusRecommendationReceipt.Receipt memory r = receipts.getReceiptById(id);
        assertEq(r.submitter, submitterSafe, "submitter == the Safe");
        assertEq(r.payloadDigest, digest);
        assertEq(r.payloadUri, URI);
    }

    /// One owner signature is below the 2-of-3 threshold: the Safe refuses (GS020) and nothing is recorded.
    function testOneOwnerSignatureCannotRecord() public {
        bytes32 id = keccak256("receipt");
        bytes memory data = _recordCall(id, keccak256("d"));
        bytes memory oneSig = _oneOwnerSignature(_safeDigest(submitterSafe, address(gateway), data));
        vm.expectRevert(bytes("GS020"));
        _safeExecWith(submitterSafe, address(gateway), data, oneSig);
        assertFalse(receipts.isRecorded(id));
    }

    /// The governing Safe is NOT a submitter: its signatures through the governing Safe cannot record (it holds no role).
    function testGoverningSafeCannotRecord() public {
        bytes memory data = _recordCall(keccak256("r"), keccak256("d"));
        bytes memory sigs = _twoOwnerSignatures(_safeDigest(governingSafe, address(gateway), data));
        vm.expectRevert(bytes("GS013"));
        _safeExecWith(governingSafe, address(gateway), data, sigs);
        assertFalse(receipts.isRecorded(keccak256("r")));
    }

    /// Signatures made for the governing Safe's hash do not execute on the submitter Safe (different address, different domain).
    function testSignaturesDoNotTransferBetweenTheTwoSafes() public {
        bytes memory data = _recordCall(keccak256("r"), keccak256("d"));
        bytes memory forGoverning =
            _twoOwnerSignatures(_safeDigest(governingSafe, address(gateway), data));
        vm.expectRevert();
        _safeExecWith(submitterSafe, address(gateway), data, forGoverning);
    }

    /// The signalling-only policy holds for a Safe holder: withdrawals are disabled and a deposit above 1 raw unit reverts.
    function testPolicyStillCapsTheSafeAtOneUnitAndNoWithdrawals() public {
        vm.startPrank(submitterSafe);
        vm.expectRevert(RobotMoneyGateway.WithdrawalNotEnabled.selector);
        gateway.withdraw(
            keccak256("o"), 1, address(vault), uint64(block.timestamp + 60), keccak256("i")
        );
        vm.expectRevert(RobotMoneyGateway.AmountExceedsPerPaymentCap.selector);
        gateway.deposit(keccak256("o"), 2, uint64(block.timestamp + 60), keccak256("i"));
        vm.stopPrank();
        (
            ,,
            uint256 maxPerPayment,
            uint256 maxPerWindow,
            address receiver,,
            uint256 maxWd,
            uint256 maxWdWin
        ) = gateway.agents(submitterSafe);
        assertEq(maxPerPayment, 1);
        assertEq(maxPerWindow, 1);
        assertEq(receiver, address(timelock), "shares go to the timelock");
        assertEq(maxWd, 0);
        assertEq(maxWdWin, 0);
        assertEq(
            gateway.agentOwner(submitterSafe),
            admin,
            "the registrar (the timelock in production) owns the policy"
        );
    }

    /// An unregistered Safe cannot record, even with a full quorum.
    function testUnregisteredSafeCannotRecord() public {
        address other = _newDefaultSafe();
        bytes memory data = _recordCall(keccak256("r"), keccak256("d"));
        bytes memory sigs = _twoOwnerSignatures(_safeDigest(other, address(gateway), data));
        vm.expectRevert(bytes("GS013"));
        _safeExecWith(other, address(gateway), data, sigs);
    }

    function _nonce(address safe_) internal view returns (uint256) {
        (bool ok, bytes memory out) = safe_.staticcall(abi.encodeWithSignature("nonce()"));
        require(ok, "nonce");
        return abi.decode(out, (uint256));
    }
}
