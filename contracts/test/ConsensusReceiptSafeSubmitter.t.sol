// SPDX-License-Identifier: MIT
// Canonical: docs/technical/consensus-receipt-submitter-runbook.md (issue 1750, owner decision 2026-10-10: the receipt submitter is a multisig)
// Implements: QA plan v1 B6 (issue #1447, review CS-2): register-committee with no public window, the submitter Safe self-authorizes in private first
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
import {Proxied} from "./helpers/Proxied.sol";

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
        gateway = Proxied.robotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(0)
        );
        ic = Proxied.investmentCommitteePolicy(admin, address(gateway));
        _installSafeSet();
        governingSafe = _newDefaultSafe();
        submitterSafe = _newDefaultSafe(); // a SECOND Safe: same owner keys, a different address and its own nonce
        timelock = _newGovTimelock(governingSafe, 1 hours);
        receipts = Proxied.consensusRecommendationReceipt(
            address(timelock), address(gateway), address(ic)
        );

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

    // ─── Registration with no public window (QA plan v1 B6, review CS-2) ───
    //
    // `govern --row register-committee` used to schedule authorizeAgent(submitter) + committeeRegister in public for the whole timelock delay. Anyone could
    // read the submitter address from that batch, authorize it first through commit/reveal, and own its agent for good (review CS-2). Two layers close it:
    // the gateway refuses a stranger's reveal for another address without that address's consent signature (issue #1791; a Safe has no key), and the tool
    // runs a PRIVATE half first: the submitter Safe commits (the commit names no agent), reveals its own authorization a block later and hands the agent to
    // the timelock. The PUBLIC batch is then setPolicy + committeeRegister (publish-contracts/src/committee-register.ts) and carries no first-time
    // authorization. Every Safe step below is a real two-signature execTransaction; only the squatter, an EOA, is a prank. The timelock receives the
    // gateway's ADMIN_ROLE the way the handover gives it.

    /// @dev The handover: the timelock holds the gateway's ADMIN_ROLE (in production DeployTimelock grants it), so it can own an agent, write that agent's
    ///      policy and register a committee agent.
    function _handOverGatewayAdmin() internal {
        bytes32 adminRole = gateway.ADMIN_ROLE();
        vm.prank(admin);
        gateway.grantRole(adminRole, address(timelock));
    }

    /// @dev The signalling-only policy the publish tooling registers (1 raw unit, no withdrawals), paying shares to `receiver`.
    function _submitterPolicy(address receiver)
        internal
        view
        returns (IGateway.AgentPolicy memory)
    {
        address[] memory none = new address[](0);
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 90 days),
            maxPerPayment: 1,
            maxPerWindow: 1,
            shareReceiver: receiver,
            allowedDestinations: none,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: none
        });
    }

    /// @dev The PRIVATE half: three transactions of the submitter Safe itself. A caller without ADMIN_ROLE must name itself as shareReceiver; an agent
    ///      revealing for itself consents by the call, so the consent argument is empty (issue #1791).
    function _selfAuthorize(address safe_, bytes32 salt) internal {
        bytes32 commitHash = keccak256(abi.encode(safe_, safe_, salt));
        assertTrue(
            _safeExec(
                safe_, address(gateway), abi.encodeCall(IGateway.commitAuthorization, (commitHash))
            ),
            "commit"
        );
        vm.roll(block.number + 1); // the reveal needs a later block (CommitmentTooRecent)
        assertTrue(
            _safeExec(
                safe_,
                address(gateway),
                abi.encodeCall(
                    IGateway.revealAuthorization, (safe_, salt, _submitterPolicy(safe_), bytes(""))
                )
            ),
            "reveal"
        );
        assertEq(gateway.agentOwner(safe_), safe_, "after the reveal the Safe owns its own agent");
        assertTrue(
            _safeExec(
                safe_,
                address(gateway),
                abi.encodeCall(IGateway.transferAgentOwnership, (safe_, address(timelock)))
            ),
            "hand-over"
        );
    }

    /// @dev A two-call timelock batch on the gateway: `first`, then committeeRegister(safe_).
    function _gatewayBatch(address safe_, bytes memory first)
        internal
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        targets = new address[](2);
        values = new uint256[](2);
        payloads = new bytes[](2);
        targets[0] = address(gateway);
        targets[1] = address(gateway);
        payloads[0] = first;
        payloads[1] = abi.encodeCall(RobotMoneyGateway.committeeRegister, (safe_, "new-submitter"));
    }

    /// @dev Governing Safe -> timelock.scheduleBatch, with two owner signatures.
    function _govScheduleBatch(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory payloads,
        bytes32 salt
    ) internal returns (bytes32 id) {
        assertTrue(
            _safeExec(
                governingSafe,
                address(timelock),
                abi.encodeCall(
                    TimelockController.scheduleBatch,
                    (targets, values, payloads, bytes32(0), salt, 1 hours)
                )
            ),
            "schedule"
        );
        id = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), salt);
    }

    /// The register batch is public on the timelock for the whole delay. With the submitter Safe's private self-authorization done first, the batch is
    /// setPolicy + committeeRegister and carries no first-time authorization. A squatter who reads the submitter address from the scheduled batch can
    /// neither authorize it (AgentAlreadyOwned) nor revoke, re-point or take it (NotAgentOwner), and the batch executes after the delay. Before the
    /// private half a squatter cannot claim the Safe's address either: it has no key to consent with (InvalidAgentConsent, issue #1791).
    function test_publicRegisterBatchCannotBeFrontRun() public {
        address fresh = _newDefaultSafe();
        _handOverGatewayAdmin();

        // 0. A squatter who guesses the address early cannot claim it: the Safe has no key to consent with.
        _assertSquatterCannotClaim(fresh);

        // 1. PRIVATE: nothing public names this Safe as the submitter yet.
        _selfAuthorize(fresh, keccak256("private-salt"));
        assertEq(
            gateway.agentOwner(fresh),
            address(timelock),
            "the timelock owns the agent before anything is public"
        );
        assertTrue(
            gateway.hasRole(gateway.AGENT_ROLE(), fresh), "AGENT_ROLE from the Safe's own reveal"
        );
        assertFalse(
            ic.hasRole(ic.COMMITTEE_AGENT_ROLE(), fresh), "not a committee agent before the batch"
        );
        assertTrue(
            gateway.agentConsented(fresh),
            "a consented binding: only its owner, the timelock, can end it"
        );

        // 2. PUBLIC: the governing Safe schedules the batch. From here anyone can read the submitter address.
        (address[] memory t, uint256[] memory v, bytes[] memory p) = _gatewayBatch(
            fresh, abi.encodeCall(IGateway.setPolicy, (fresh, _submitterPolicy(address(timelock))))
        );
        bytes32 opSalt = keccak256("register-committee");
        bytes32 id = _govScheduleBatch(t, v, p, opSalt);

        // 3. During the delay the squatter tries every agent write the gateway exposes.
        _assertSquatterCannotTouch(fresh);

        // 4. The delay passes and the governing Safe executes: the batch lands untouched.
        vm.warp(block.timestamp + 1 hours);
        assertTrue(timelock.isOperationReady(id), "ready");
        assertTrue(
            _safeExec(
                governingSafe,
                address(timelock),
                abi.encodeCall(TimelockController.executeBatch, (t, v, p, bytes32(0), opSalt))
            ),
            "execute"
        );
        assertTrue(timelock.isOperationDone(id), "done");
        assertTrue(ic.hasRole(ic.COMMITTEE_AGENT_ROLE(), fresh), "COMMITTEE_AGENT_ROLE");
        assertEq(gateway.agentOwner(fresh), address(timelock), "the timelock still owns the agent");
        assertEq(
            _shareReceiver(fresh), address(timelock), "setPolicy moved the shares to the timelock"
        );

        // 5. The new submitter anchors a receipt with two owner signatures.
        bytes32 rid = keccak256("new-submitter-receipt");
        assertTrue(_safeExec(fresh, address(gateway), _recordCall(rid, keccak256("new-digest"))));
        assertEq(receipts.getReceiptById(rid).submitter, fresh, "submitter == the new Safe");
    }

    /// @dev Before the private half: a squatter commits and reveals for `agent` with no consent. A caller without ADMIN_ROLE binds another address only
    ///      with that address's EIP-712 signature (issue #1791), and a Safe has no key, so the reveal is refused and `agent` stays unowned.
    function _assertSquatterCannotClaim(address agent) internal {
        address squatter = makeAddr("squatter");
        IGateway.AgentPolicy memory squat = _submitterPolicy(squatter);
        bytes32 salt = keccak256("squatter-early");
        vm.prank(squatter);
        gateway.commitAuthorization(keccak256(abi.encode(agent, squatter, salt)));
        vm.roll(block.number + 1);
        vm.prank(squatter);
        vm.expectRevert(RobotMoneyGateway.InvalidAgentConsent.selector);
        gateway.revealAuthorization(agent, salt, squat, "");
        assertEq(gateway.agentOwner(agent), address(0), "the squatter could not claim the Safe");
    }

    /// @dev During the delay: the squatter, who read `agent` from the scheduled batch, tries every agent write the gateway exposes. The timelock owns
    ///      the agent, so a first-time authorization reverts AgentAlreadyOwned and every owner-gated write reverts NotAgentOwner.
    function _assertSquatterCannotTouch(address agent) internal {
        address squatter = makeAddr("squatter");
        IGateway.AgentPolicy memory squat = _submitterPolicy(squatter);
        bytes32 salt = keccak256("squatter-salt");
        vm.prank(squatter);
        gateway.commitAuthorization(keccak256(abi.encode(agent, squatter, salt)));
        vm.roll(block.number + 1);
        vm.startPrank(squatter);
        vm.expectRevert(RobotMoneyGateway.AgentAlreadyOwned.selector);
        gateway.revealAuthorization(agent, salt, squat, "");
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.revokeAgent(agent);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.setPolicy(agent, squat);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.transferAgentOwnership(agent, squatter);
        vm.stopPrank();
        assertEq(gateway.agentOwner(agent), address(timelock), "the timelock still owns it");
    }

    /// @dev The stored policy's share receiver (the public getter returns the eight non-array fields).
    function _shareReceiver(address agent) internal view returns (address receiver) {
        (,,,, receiver,,,) = gateway.agents(agent);
    }

    /// The private commit is bound to the submitter Safe: the commit hash carries msg.sender, so a watcher who sees the Safe's commit, and even learns its
    /// salt, cannot reveal it. The Safe's own reveal still lands.
    function test_privateCommitCannotBeRevealedByAnotherAccount() public {
        address fresh = _newDefaultSafe();
        bytes32 salt = keccak256("private-salt");
        assertTrue(
            _safeExec(
                fresh,
                address(gateway),
                abi.encodeCall(
                    IGateway.commitAuthorization, (keccak256(abi.encode(fresh, fresh, salt)))
                )
            )
        );
        vm.roll(block.number + 1);
        address watcher = makeAddr("watcher");
        IGateway.AgentPolicy memory wp = _submitterPolicy(watcher);
        vm.prank(watcher);
        vm.expectRevert(RobotMoneyGateway.CommitmentNotFound.selector);
        gateway.revealAuthorization(fresh, salt, wp, "");
        assertEq(gateway.agentOwner(fresh), address(0), "nobody owns it yet");
        assertTrue(
            _safeExec(
                fresh,
                address(gateway),
                abi.encodeCall(
                    IGateway.revealAuthorization, (fresh, salt, _submitterPolicy(fresh), bytes(""))
                )
            )
        );
        assertEq(gateway.agentOwner(fresh), fresh, "the Safe's own reveal lands");
        assertTrue(
            gateway.agentConsented(fresh),
            "revealing for itself is consent: the Safe cannot release its binding later"
        );
    }

    function _nonce(address safe_) internal view returns (uint256) {
        (bool ok, bytes memory out) = safe_.staticcall(abi.encodeWithSignature("nonce()"));
        require(ok, "nonce");
        return abi.decode(out, (uint256));
    }
}
