// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.9 — Consensus Recommendation Receipt Contract
// Implements: issue #1247 acceptance criteria 1, 2, 3, 11, 12, 13 and Test plan
//             items 1, 2, 3, 8. Discharges the second half of issue #1280.
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
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
import {MockVault} from "../gateway/MockVault.sol";

/// @title ConsensusRecommendationReceiptTest
/// @notice Full on-chain path for the consensus receipt anchor:
///         gateway → receipt contract → event, plus the signalling-only
///         boundary, the timelock-held `ADMIN_ROLE`, the 3-topic event limit,
///         and the anchoring-digest assertion that closes issue #1280.
contract ConsensusRecommendationReceiptTest is Test {
    // ─── Fixture paths (goldens are byte-identical to robotmoney-frontend's
    //     contract/src/__fixtures__/ — that byte identity IS the cross-repo
    //     pin, issue #1244 AC5; nothing here may edit them). ────────────────

    string constant VALID_CANONICAL = "tests/fixtures/consensus-receipt.valid.canonical.txt";
    string constant ESCAPING_CANONICAL = "tests/fixtures/consensus-receipt.escaping.canonical.txt";
    string constant VALID_JSON = "tests/fixtures/consensus-receipt.valid.json";
    string constant ESCAPING_JSON = "tests/fixtures/consensus-receipt.escaping.json";
    string constant ANCHOR_DIGEST = "tests/fixtures/consensus-receipt.anchor-digest.json";

    /// @dev Receipt-id domain separator, pinned by
    ///      consensus-receipt.canonicalization.json#receipt_id_derivation.
    string constant RECEIPT_ID_DOMAIN = "robotmoney:consensus-receipt-id:v1\n";

    // ─── Actors ──────────────────────────────────────────────────────────────

    address admin = address(0xA0);
    address pauser = address(0xA1);
    address shareReceiver = address(0xA2);
    address submitter = address(0xB1);
    address stranger = address(0xDEAD);
    address proposer = address(0xC0);
    address executor = address(0xC1);

    // ─── Contracts ───────────────────────────────────────────────────────────

    TestERC20 usdc;
    MockVault vault;
    RobotMoneyGateway gateway;
    InvestmentCommitteePolicy ic;
    ConsensusRecommendationReceipt receipts;
    TimelockController timelock;

    uint256 constant MIN_DELAY = 1 hours;

    string constant PAYLOAD_URI = "https://robotmoney.net/api/swarm/receipts/session-1";

    // ─── Setup ───────────────────────────────────────────────────────────────

    function setUp() public {
        usdc = new TestERC20();
        vault = new MockVault(address(usdc));

        gateway = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(0)
        );
        ic = new InvestmentCommitteePolicy(admin, address(gateway));

        // Timelock that will hold ADMIN_ROLE on the receipt contract (INV-3).
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = executor;
        timelock = new TimelockController(MIN_DELAY, proposers, executors, address(0));

        // The receipt contract's ADMIN_ROLE goes to the timelock and nowhere
        // else — deliberately NOT to the gateway, because a gateway-routed
        // release would need the gateway to hold it (see docs/architecture.md
        // §4.9, "why release is not a gateway entrypoint").
        receipts =
            new ConsensusRecommendationReceipt(address(timelock), address(gateway), address(ic));

        bytes32 icAdminRole = ic.ADMIN_ROLE();
        vm.prank(admin);
        ic.grantRole(icAdminRole, address(gateway));

        vm.prank(admin);
        gateway.setICPolicy(address(ic));
        vm.prank(admin);
        gateway.setConsensusReceipt(address(receipts));

        address[] memory noList = new address[](0);
        IGateway.AgentPolicy memory policy = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 30 days),
            maxPerPayment: 1e6,
            maxPerWindow: 10e6,
            shareReceiver: shareReceiver,
            allowedDestinations: noList,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: noList
        });
        vm.prank(admin);
        gateway.authorizeAgent(submitter, policy);

        vm.prank(admin);
        gateway.committeeRegister(submitter, "swarm-submitter-v1");
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// @dev Read the committed golden canonical bytes exactly — trailing
    ///      newline included, nothing trimmed or re-encoded.
    function _goldenBytes(string memory path) internal view returns (bytes memory) {
        return vm.readFileBinary(path);
    }

    /// @dev Read the pinned digest constant for `file` out of the core-only
    ///      sidecar. The constant is COMPARED against a freshly derived hash;
    ///      it is never the source of the value under test.
    function _pinnedDigest(uint256 goldenIndex)
        internal
        view
        returns (bytes32 digest, uint256 byteLength, string memory file)
    {
        string memory json = vm.readFile(ANCHOR_DIGEST);
        string memory base = string.concat(".goldens[", vm.toString(goldenIndex), "]");
        digest = vm.parseJsonBytes32(json, string.concat(base, ".keccak256"));
        byteLength = vm.parseJsonUint(json, string.concat(base, ".byte_length"));
        file = vm.parseJsonString(json, string.concat(base, ".file"));
    }

    function _receiptIdFor(string memory receiptJsonPath) internal view returns (bytes32) {
        string memory json = vm.readFile(receiptJsonPath);
        string memory sessionId = vm.parseJsonString(json, ".session_id");
        string memory subjectId = vm.parseJsonString(json, ".subject_id");
        return keccak256(abi.encodePacked(RECEIPT_ID_DOMAIN, sessionId, "\n", subjectId));
    }

    function _record(bytes32 receiptId, bytes32 digest) internal returns (uint256) {
        vm.prank(submitter);
        return gateway.consensusRecordReceipt(receiptId, digest, PAYLOAD_URI);
    }

    // ─── AC1 / Test plan 2: only the gateway may write ───────────────────────

    /// @dev A direct call to `recordReceipt` reverts even from the allowlisted
    ///      submitter: the gateway is the sole choke point.
    function testDirectRecordReverts() public {
        vm.prank(submitter);
        vm.expectRevert(IConsensusRecommendationReceipt.CallerNotGateway.selector);
        receipts.recordReceipt(submitter, keccak256("r"), keccak256("d"), PAYLOAD_URI);
    }

    /// @dev Even an ADMIN_ROLE holder cannot bypass the gateway.
    function testDirectRecordFromTimelockReverts() public {
        vm.prank(address(timelock));
        vm.expectRevert(IConsensusRecommendationReceipt.CallerNotGateway.selector);
        receipts.recordReceipt(submitter, keccak256("r"), keccak256("d"), PAYLOAD_URI);
    }

    /// @dev A gateway caller without `AGENT_ROLE` is rejected by the gateway.
    function testNonAgentCannotRecordViaGateway() public {
        vm.prank(stranger);
        vm.expectRevert();
        gateway.consensusRecordReceipt(keccak256("r"), keccak256("d"), PAYLOAD_URI);
    }

    /// @dev A gateway agent that is not on the IC allowlist is rejected by the
    ///      receipt contract — role administration stays on the IC policy.
    function testSubmitterNotAllowlistedReverts() public {
        address[] memory noList = new address[](0);
        IGateway.AgentPolicy memory policy = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 30 days),
            maxPerPayment: 1e6,
            maxPerWindow: 10e6,
            shareReceiver: shareReceiver,
            allowedDestinations: noList,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: noList
        });
        address rogue = address(0xB9);
        vm.prank(admin);
        gateway.authorizeAgent(rogue, policy);

        vm.prank(rogue);
        vm.expectRevert(IConsensusRecommendationReceipt.SubmitterNotAllowlisted.selector);
        gateway.consensusRecordReceipt(keccak256("r"), keccak256("d"), PAYLOAD_URI);
    }

    function testRecordRequiresConfiguredReceiptContract() public {
        vm.prank(admin);
        gateway.setConsensusReceipt(address(0));
        vm.prank(submitter);
        vm.expectRevert(RobotMoneyGateway.ConsensusReceiptNotSet.selector);
        gateway.consensusRecordReceipt(keccak256("r"), keccak256("d"), PAYLOAD_URI);
    }

    // ─── Field guards ────────────────────────────────────────────────────────

    function testEmptyReceiptIdReverts() public {
        vm.prank(submitter);
        vm.expectRevert(IConsensusRecommendationReceipt.EmptyReceiptId.selector);
        gateway.consensusRecordReceipt(bytes32(0), keccak256("d"), PAYLOAD_URI);
    }

    function testEmptyPayloadDigestReverts() public {
        vm.prank(submitter);
        vm.expectRevert(IConsensusRecommendationReceipt.EmptyPayloadDigest.selector);
        gateway.consensusRecordReceipt(keccak256("r"), bytes32(0), PAYLOAD_URI);
    }

    function testEmptyPayloadUriReverts() public {
        vm.prank(submitter);
        vm.expectRevert(IConsensusRecommendationReceipt.EmptyPayloadUri.selector);
        gateway.consensusRecordReceipt(keccak256("r"), keccak256("d"), "");
    }

    /// @dev One receipt per session per subject — the uniqueness property the
    ///      receipt-id derivation exists to enforce.
    function testDuplicateReceiptIdReverts() public {
        bytes32 id = keccak256("r");
        _record(id, keccak256("d"));
        vm.prank(submitter);
        vm.expectRevert(IConsensusRecommendationReceipt.ReceiptAlreadyRecorded.selector);
        gateway.consensusRecordReceipt(id, keccak256("d2"), PAYLOAD_URI);
    }

    // ─── AC2 / Test plan 3: ADMIN_ROLE is the timelock ───────────────────────

    /// @dev The timelock, and only the timelock, holds `ADMIN_ROLE`. The
    ///      deployer, the gateway and the protocol admin all do not.
    function testAdminRoleHeldByTimelock() public view {
        bytes32 role = receipts.ADMIN_ROLE();
        assertTrue(receipts.hasRole(role, address(timelock)), "timelock must hold ADMIN_ROLE");
        assertFalse(receipts.hasRole(role, admin), "protocol admin must not hold ADMIN_ROLE");
        assertFalse(receipts.hasRole(role, address(gateway)), "gateway must not hold ADMIN_ROLE");
        assertFalse(receipts.hasRole(role, address(this)), "deployer must not hold ADMIN_ROLE");
        assertTrue(
            receipts.hasRole(receipts.DEFAULT_ADMIN_ROLE(), address(timelock)),
            "timelock must hold DEFAULT_ADMIN_ROLE"
        );
    }

    /// @dev Test plan 3: `ADMIN_ROLE` operations revert unless routed through
    ///      the timelock — and succeed when they are, only after `minDelay`.
    function testReleaseRevertsUnlessRoutedThroughTimelock() public {
        bytes32 id = keccak256("r");
        _record(id, keccak256("d"));

        vm.prank(admin);
        vm.expectRevert();
        receipts.releaseReceipt(id);

        vm.prank(stranger);
        vm.expectRevert();
        receipts.releaseReceipt(id);

        // Routed through the timelock: schedule, wait out the delay, execute.
        bytes memory payload = abi.encodeCall(IConsensusRecommendationReceipt.releaseReceipt, (id));
        vm.prank(proposer);
        timelock.schedule(address(receipts), 0, payload, bytes32(0), bytes32(0), MIN_DELAY);

        // Executing before the delay elapses is refused.
        vm.prank(executor);
        vm.expectRevert();
        timelock.execute(address(receipts), 0, payload, bytes32(0), bytes32(0));

        vm.warp(block.timestamp + MIN_DELAY + 1);
        vm.prank(executor);
        timelock.execute(address(receipts), 0, payload, bytes32(0), bytes32(0));

        assertTrue(receipts.isReleased(id), "timelock-routed release must succeed");
        IConsensusRecommendationReceipt.Receipt memory r = receipts.getReceiptById(id);
        assertEq(r.releasedAt, uint64(block.timestamp));
    }

    function testDoubleReleaseReverts() public {
        bytes32 id = keccak256("r");
        _record(id, keccak256("d"));
        vm.prank(address(timelock));
        receipts.releaseReceipt(id);
        vm.prank(address(timelock));
        vm.expectRevert(IConsensusRecommendationReceipt.ReceiptAlreadyReleased.selector);
        receipts.releaseReceipt(id);
    }

    function testReleaseUnknownReceiptReverts() public {
        vm.prank(address(timelock));
        vm.expectRevert(IConsensusRecommendationReceipt.ReceiptNotFound.selector);
        receipts.releaseReceipt(keccak256("never-recorded"));
    }

    // ─── Recording writes what it says ───────────────────────────────────────

    function testRecordStoresEveryField() public {
        bytes32 id = keccak256("r");
        bytes32 digest = keccak256("d");
        uint256 index = _record(id, digest);

        assertEq(index, 0);
        assertEq(receipts.receiptCount(), 1);
        assertTrue(receipts.isRecorded(id));
        assertFalse(receipts.isReleased(id), "a fresh receipt is unreleased");

        IConsensusRecommendationReceipt.Receipt memory r = receipts.getReceipt(0);
        assertEq(r.receiptId, id);
        assertEq(r.payloadDigest, digest);
        assertEq(r.payloadUri, PAYLOAD_URI);
        assertEq(r.submitter, submitter);
        assertEq(r.recordedAt, uint64(block.timestamp));
        assertEq(r.releasedAt, 0);
        assertFalse(r.released);
    }

    /// @dev The never-released case (issue #1247 task 4.0, third question): an
    ///      unreleased receipt is a permanent public record. Nothing expires
    ///      it, nothing deletes it, and no on-chain state changes with time.
    function testUnreleasedReceiptNeverExpires() public {
        bytes32 id = keccak256("r");
        _record(id, keccak256("d"));
        uint64 recordedAt = receipts.getReceiptById(id).recordedAt;

        vm.warp(block.timestamp + 3650 days);

        IConsensusRecommendationReceipt.Receipt memory r = receipts.getReceiptById(id);
        assertTrue(receipts.isRecorded(id), "record survives indefinitely");
        assertFalse(r.released, "no timeout releases a receipt");
        assertEq(r.recordedAt, recordedAt, "no timeout mutates a receipt");
        assertEq(r.releasedAt, 0);
    }

    // ─── AC3 / Test plan: no indexed signature parameter ─────────────────────

    /// @dev AC3: no event may use an indexed signature parameter. The receipt
    ///      events carry no signature parameter at all — analyst signatures are
    ///      payload data, never event data — and both events stay within the
    ///      EVM's 3-topic non-anonymous limit, which a `uint8[64] indexed`
    ///      signature would blow past.
    function testEventsCarryNoIndexedSignatureParameter() public {
        bytes32 id = keccak256("r");

        vm.recordLogs();
        _record(id, keccak256("d"));
        Vm.Log[] memory recordLogs = vm.getRecordedLogs();
        bool sawRecorded;
        for (uint256 i = 0; i < recordLogs.length; i++) {
            if (recordLogs[i].emitter != address(receipts)) continue;
            sawRecorded = true;
            // Three indexed values, each a 32-byte word: a receipt id, an
            // address, an index. None is, or could hold, a 64-byte ed25519
            // signature — which is precisely why the topic count stays legal.
            assertEq(recordLogs[i].topics.length, 4, "ReceiptRecorded must have exactly 3 topics");
        }
        assertTrue(sawRecorded, "ReceiptRecorded must be emitted");

        vm.recordLogs();
        vm.prank(address(timelock));
        receipts.releaseReceipt(id);
        Vm.Log[] memory releaseLogs = vm.getRecordedLogs();
        bool sawReleased;
        for (uint256 i = 0; i < releaseLogs.length; i++) {
            if (releaseLogs[i].emitter != address(receipts)) continue;
            sawReleased = true;
            assertLe(releaseLogs[i].topics.length, 4, "ReceiptReleased exceeds the 3-topic limit");
        }
        assertTrue(sawReleased, "ReceiptReleased must be emitted");
    }

    // ─── AC1 / Test plan 1: signalling-only boundary ─────────────────────────

    /// @dev AC1, mirroring `InvestmentCommitteePolicyTest.testSignallingOnlyBoundary`.
    ///      No path from any receipt entrypoint reaches `setWeights` or moves
    ///      value: the contract has no `receive`/`fallback`, no ERC-20 surface,
    ///      no router or governance selector, and its only state effect is an
    ///      append plus a boolean flip.
    function testSignallingOnlyBoundary() public {
        // 1. No ether receive: sending ETH reverts (no `receive`/`fallback`).
        (bool ok,) = address(receipts).call{value: 1 wei}("");
        assertFalse(ok, "receipt contract must not accept ETH");

        // 2. No ERC-20 `transfer(address,uint256)`.
        (bool ok2,) = address(receipts)
            .call(abi.encodeWithSignature("transfer(address,uint256)", address(this), 1));
        assertFalse(ok2, "receipt contract must not have ERC-20 transfer");

        // 3. No `RouterGovernance.execute(uint256)`.
        (bool ok3,) =
            address(receipts).call(abi.encodeWithSignature("execute(uint256)", uint256(0)));
        assertFalse(ok3, "receipt contract must not have RouterGovernance.execute");

        // 4. No `PortfolioRouter.setWeights(address[],uint16[])`.
        address[] memory vaults = new address[](0);
        uint16[] memory bps = new uint16[](0);
        (bool ok4,) = address(receipts)
            .call(abi.encodeWithSignature("setWeights(address[],uint16[])", vaults, bps));
        assertFalse(ok4, "receipt contract must not have PortfolioRouter.setWeights");

        // 5. No `RobotMoneyGateway.deposit(...)`.
        (bool ok5,) = address(receipts)
            .call(
                abi.encodeWithSignature(
                    "deposit(address,uint256,uint256,bytes32)",
                    address(this),
                    uint256(1),
                    uint256(0),
                    bytes32(0)
                )
            );
        assertFalse(ok5, "receipt contract must not have gateway deposit");

        // 6. Recording and releasing move no value and touch no vault.
        uint256 vaultAssetsBefore = usdc.balanceOf(address(vault));
        bytes32 id = keccak256("r");
        _record(id, keccak256("d"));
        vm.prank(address(timelock));
        receipts.releaseReceipt(id);

        assertEq(address(receipts).balance, 0, "receipt contract balance must stay zero");
        assertEq(usdc.balanceOf(address(receipts)), 0, "receipt contract must hold no USDC");
        assertEq(usdc.balanceOf(address(vault)), vaultAssetsBefore, "no vault balance may move");
        assertEq(receipts.receiptCount(), 1, "the only state effect is an append");
    }

    // ─── AC11 / AC12 / AC13 — the anchoring digest (closes issue #1280) ──────

    /// @dev The receipt-id derivation implemented on chain must agree with
    ///      `consensus-receipt.canonicalization.json#receipt_id_derivation`,
    ///      computed here from the fixture's own `session_id` / `subject_id`.
    function testComputeReceiptIdMatchesCanonicalizationContract() public view {
        string memory json = vm.readFile(VALID_JSON);
        string memory sessionId = vm.parseJsonString(json, ".session_id");
        string memory subjectId = vm.parseJsonString(json, ".subject_id");

        assertEq(
            receipts.computeReceiptId(sessionId, subjectId),
            keccak256(
                abi.encodePacked("robotmoney:consensus-receipt-id:v1\n", sessionId, "\n", subjectId)
            ),
            "on-chain receipt-id derivation must match the pinned preimage"
        );
    }

    /// @dev AC11 + AC12 — the assertion `robotmoney-frontend` structurally
    ///      cannot make, because only this repo sees the transaction.
    ///
    ///      The digest is **derived** by hashing the committed golden bytes,
    ///      never transcribed. It is then compared with the pinned constant in
    ///      `consensus-receipt.anchor-digest.json` (so changing either side
    ///      alone turns this red), and finally asserted to be exactly what the
    ///      anchoring path carries: the `payloadDigest` in the emitted
    ///      `ReceiptRecorded` topic set and in the stored receipt.
    function testAnchoringPathSubmitsTheGoldenDigest() public {
        bytes memory goldenBytes = _goldenBytes(VALID_CANONICAL);
        bytes32 derived = keccak256(goldenBytes);

        (bytes32 pinned, uint256 pinnedLength, string memory file) = _pinnedDigest(0);
        assertEq(file, "consensus-receipt.valid.canonical.txt", "sidecar golden[0] identity");
        assertEq(goldenBytes.length, pinnedLength, "golden byte length drifted from the sidecar");
        assertEq(derived, pinned, "derived keccak256 must equal the pinned anchor digest");

        bytes32 receiptId = _receiptIdFor(VALID_JSON);

        vm.recordLogs();
        uint256 index = _record(receiptId, derived);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // The digest actually carried by the emitted anchoring event.
        bytes32 emittedDigest;
        bool found;
        bytes32 sig = keccak256("ReceiptRecorded(bytes32,address,uint256,bytes32,string,uint64)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(receipts) || logs[i].topics[0] != sig) continue;
            found = true;
            assertEq(logs[i].topics[1], receiptId, "event receiptId");
            (emittedDigest,,) = abi.decode(logs[i].data, (bytes32, string, uint64));
        }
        assertTrue(found, "ReceiptRecorded must be emitted by the anchoring path");
        assertEq(emittedDigest, derived, "the anchored event must carry the derived digest");

        // ...and what the contract durably stored.
        assertEq(
            receipts.getReceipt(index).payloadDigest,
            derived,
            "the stored commitment must be the derived digest"
        );
        assertEq(
            receipts.getReceiptById(receiptId).payloadDigest,
            pinned,
            "the anchored digest must equal the pinned constant"
        );
    }

    /// @dev AC13 — the non-ASCII conformance receipt gets the same treatment.
    ///      An ASCII-only digest check cannot detect a serializer that escapes
    ///      non-ASCII, U+2028, or the HTML-sensitive characters, and the two
    ///      most likely non-JS implementations each diverge that way BY
    ///      DEFAULT while still reproducing an all-ASCII golden exactly.
    function testAnchoringPathSubmitsTheEscapingGoldenDigest() public {
        bytes memory goldenBytes = _goldenBytes(ESCAPING_CANONICAL);
        bytes32 derived = keccak256(goldenBytes);

        (bytes32 pinned, uint256 pinnedLength, string memory file) = _pinnedDigest(1);
        assertEq(file, "consensus-receipt.escaping.canonical.txt", "sidecar golden[1] identity");
        assertEq(goldenBytes.length, pinnedLength, "escaping golden byte length drifted");
        assertEq(derived, pinned, "derived keccak256 must equal the pinned escaping digest");

        bytes32 receiptId = _receiptIdFor(ESCAPING_JSON);
        uint256 index = _record(receiptId, derived);

        assertEq(
            receipts.getReceipt(index).payloadDigest,
            pinned,
            "the anchored digest must equal the pinned escaping constant"
        );
    }

    /// @dev The two goldens are distinct receipts and must anchor distinct
    ///      digests — a serializer that collapsed them would pass a
    ///      single-fixture check.
    function testGoldensAnchorDistinctDigests() public view {
        assertTrue(
            keccak256(_goldenBytes(VALID_CANONICAL)) != keccak256(_goldenBytes(ESCAPING_CANONICAL)),
            "the two goldens must not share a digest"
        );
    }
}
