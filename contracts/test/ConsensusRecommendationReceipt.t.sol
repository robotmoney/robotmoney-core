// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.9 — Consensus Recommendation Receipt Contract
// Implements: issue #1247 acceptance criteria 1, 2, 3, 11, 12, 13 and Test plan
//             items 1, 2, 3, 8. Discharges the second half of issue #1280.
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {
    IAccessControlEnumerable
} from "@openzeppelin/contracts/access/extensions/IAccessControlEnumerable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {AdminFloorAccessControl} from "../lib/AdminFloorAccessControl.sol";
import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";
import {
    IConsensusRecommendationReceipt
} from "../gateway/interfaces/IConsensusRecommendationReceipt.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {MockVault} from "./helpers/MockVault.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";

/// @title ConsensusRecommendationReceiptTest
/// @notice Full on-chain path for the consensus receipt anchor:
///         submitter Safe-held role → receipt contract → event, with no gateway and no
///         committee registry, plus the signalling-only boundary, the timelock-held
///         `ADMIN_ROLE`, the 3-topic event limit, and the anchoring-digest assertion that
///         closes issue #1280.
contract ConsensusRecommendationReceiptTest is SafeGovernance {
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

    address submitter = address(0xB1);
    /// Stands in for RouterGovernance: holds only RECEIPT_RELEASER_ROLE.
    address releaser = address(0xC1);
    address stranger = address(0xDEAD);
    /// A real SafeL2 1.4.1 proxy: the only proposer and canceller on the timelock.
    address safe;

    // ─── Contracts ───────────────────────────────────────────────────────────

    TestERC20 usdc;
    MockVault vault;
    ConsensusRecommendationReceipt receipts;
    TimelockController timelock;

    uint256 constant MIN_DELAY = 1 hours;

    string constant PAYLOAD_URI = "https://robotmoney.net/api/swarm/receipts/session-1";

    // ─── Setup ───────────────────────────────────────────────────────────────

    function setUp() public {
        usdc = new TestERC20();
        vault = new MockVault(address(usdc));

        // Timelock that will hold ADMIN_ROLE on the receipt contract (INV-3). The Safe is its
        // only proposer and canceller and EXECUTOR_ROLE is open, as in DeployTimelock.
        _installSafeSet();
        safe = _newDefaultSafe();
        timelock = _newGovTimelock(safe, MIN_DELAY);

        // The receipt contract's ADMIN_ROLE goes to the timelock and nowhere else.
        receipts = CoreProxies.consensusRecommendationReceipt(address(timelock));

        // The Safe, through the timelock, grants the submitter and the releaser: the only
        // path that can (the timelock alone holds the role admin).
        _grantViaTimelock(receipts.RECEIPT_SUBMITTER_ROLE(), submitter, bytes32(uint256(11)));
        _grantViaTimelock(receipts.RECEIPT_RELEASER_ROLE(), releaser, bytes32(uint256(12)));
    }

    function _grantViaTimelock(bytes32 role, address who, bytes32 salt) internal {
        bytes memory payload = abi.encodeCall(receipts.grantRole, (role, who));
        _govSchedule(safe, timelock, address(receipts), payload, salt, MIN_DELAY);
        vm.warp(block.timestamp + MIN_DELAY);
        _govExecute(safe, timelock, address(receipts), payload, salt);
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
        return receipts.recordReceipt(receiptId, digest, PAYLOAD_URI);
    }

    function _release(bytes32 id) internal {
        vm.prank(releaser);
        receipts.releaseReceipt(id);
    }

    // ─── Direct recording: the submitter role is the only gate ───────────────

    /// @dev Direct recording by the role holder succeeds with no gateway and no IC registry,
    ///      and the stored submitter is `msg.sender`.
    function testDirectRecordByRoleHolderStoresMsgSender() public {
        _record(keccak256("r"), keccak256("d"));
        assertEq(receipts.getReceiptById(keccak256("r")).submitter, submitter);
    }

    /// @dev Without the submitter role every caller reverts: EOAs, the timelock (which holds
    ///      ADMIN_ROLE but not the submitter role) and the releaser.
    function testRecordWithoutSubmitterRoleReverts() public {
        address[3] memory callers = [stranger, address(timelock), releaser];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(IConsensusRecommendationReceipt.SubmitterNotAllowlisted.selector);
            receipts.recordReceipt(keccak256("r"), keccak256("d"), PAYLOAD_URI);
        }
        assertEq(receipts.receiptCount(), 0);
    }

    /// @dev A revoked submitter can no longer record. The revoke is a delayed timelock call.
    function testRevokedSubmitterCannotRecord() public {
        bytes32 role = receipts.RECEIPT_SUBMITTER_ROLE();
        bytes memory payload = abi.encodeCall(receipts.revokeRole, (role, submitter));
        _govSchedule(safe, timelock, address(receipts), payload, bytes32(uint256(21)), MIN_DELAY);
        _expectExecuteRefused(safe, timelock, address(receipts), payload, bytes32(uint256(21)));
        vm.warp(block.timestamp + MIN_DELAY);
        _govExecute(safe, timelock, address(receipts), payload, bytes32(uint256(21)));

        assertFalse(receipts.hasRole(role, submitter));
        vm.prank(submitter);
        vm.expectRevert(IConsensusRecommendationReceipt.SubmitterNotAllowlisted.selector);
        receipts.recordReceipt(keccak256("r"), keccak256("d"), PAYLOAD_URI);
    }

    /// @dev Only the timelock (ADMIN_ROLE) administers the two roles. Neither the submitter,
    ///      the releaser nor a stranger can grant or revoke either.
    function testOnlyAdminRoleAdministersTheReceiptRoles() public {
        bytes32 sub = receipts.RECEIPT_SUBMITTER_ROLE();
        bytes32 rel = receipts.RECEIPT_RELEASER_ROLE();
        assertEq(receipts.getRoleAdmin(sub), receipts.ADMIN_ROLE());
        assertEq(receipts.getRoleAdmin(rel), receipts.ADMIN_ROLE());
        address[3] memory callers = [stranger, submitter, releaser];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.startPrank(callers[i]);
            vm.expectRevert();
            receipts.grantRole(sub, stranger);
            vm.expectRevert();
            receipts.grantRole(rel, stranger);
            vm.expectRevert();
            receipts.revokeRole(sub, submitter);
            vm.expectRevert();
            receipts.revokeRole(rel, releaser);
            vm.stopPrank();
        }
    }

    /// @dev The retired gateway and IC slots are never written by a fresh deploy.
    function testRetiredSlotsAreEmpty() public view {
        assertEq(receipts.gateway(), address(0));
        assertEq(receipts.icPolicy(), address(0));
    }

    // ─── Field guards ────────────────────────────────────────────────────────

    function testEmptyReceiptIdReverts() public {
        vm.prank(submitter);
        vm.expectRevert(IConsensusRecommendationReceipt.EmptyReceiptId.selector);
        receipts.recordReceipt(bytes32(0), keccak256("d"), PAYLOAD_URI);
    }

    function testEmptyPayloadDigestReverts() public {
        vm.prank(submitter);
        vm.expectRevert(IConsensusRecommendationReceipt.EmptyPayloadDigest.selector);
        receipts.recordReceipt(keccak256("r"), bytes32(0), PAYLOAD_URI);
    }

    function testEmptyPayloadUriReverts() public {
        vm.prank(submitter);
        vm.expectRevert(IConsensusRecommendationReceipt.EmptyPayloadUri.selector);
        receipts.recordReceipt(keccak256("r"), keccak256("d"), "");
    }

    /// @dev One receipt per session per subject — the uniqueness property the
    ///      receipt-id derivation exists to enforce.
    function testDuplicateReceiptIdReverts() public {
        bytes32 id = keccak256("r");
        _record(id, keccak256("d"));
        vm.prank(submitter);
        vm.expectRevert(IConsensusRecommendationReceipt.ReceiptAlreadyRecorded.selector);
        receipts.recordReceipt(id, keccak256("d2"), PAYLOAD_URI);
    }

    // ─── AC2 / Test plan 3: ADMIN_ROLE is the timelock ───────────────────────

    /// @dev The timelock, and only the timelock, holds `ADMIN_ROLE`. The
    ///      releaser (RouterGovernance's stand-in), the submitter and the deployer do not.
    function testAdminRoleHeldByTimelock() public view {
        bytes32 role = receipts.ADMIN_ROLE();
        assertTrue(receipts.hasRole(role, address(timelock)), "timelock must hold ADMIN_ROLE");
        assertFalse(receipts.hasRole(role, releaser), "releaser must not hold ADMIN_ROLE");
        assertFalse(receipts.hasRole(role, submitter), "submitter must not hold ADMIN_ROLE");
        assertFalse(receipts.hasRole(role, address(this)), "deployer must not hold ADMIN_ROLE");
        assertEq(
            IAccessControlEnumerable(address(receipts)).getRoleMemberCount(role),
            1,
            "ADMIN_ROLE holders are the timelock alone"
        );
        assertTrue(
            receipts.hasRole(receipts.DEFAULT_ADMIN_ROLE(), address(timelock)),
            "timelock must hold DEFAULT_ADMIN_ROLE"
        );
    }

    /// @dev Release needs the narrow release role. The timelock cannot release directly, and
    ///      neither can the submitter or a stranger.
    function testReleaseRevertsWithoutTheReleaseRole() public {
        bytes32 id = keccak256("r");
        _record(id, keccak256("d"));

        address[3] memory callers = [address(timelock), submitter, stranger];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert();
            receipts.releaseReceipt(id);
        }
        assertFalse(receipts.isReleased(id));
        _release(id);
        assertTrue(receipts.isReleased(id));
    }

    /// @dev Test plan 3: the timelock path (a delayed grant) works only after `minDelay`,
    ///      with the exact refusal reasons for early execution and for replay.
    function testGrantRevertsUnlessRoutedThroughTimelock() public {
        bytes32 id = keccak256("r");
        _record(id, keccak256("d"));
        bytes memory payload =
            abi.encodeCall(receipts.grantRole, (receipts.RECEIPT_SUBMITTER_ROLE(), stranger));

        bytes32 submitterRole = receipts.RECEIPT_SUBMITTER_ROLE();
        vm.prank(stranger);
        vm.expectRevert();
        receipts.grantRole(submitterRole, stranger);
        _govSchedule(safe, timelock, address(receipts), payload, bytes32(0), MIN_DELAY);

        // One owner signature is below the 2-of-3 threshold: the Safe itself refuses.
        bytes memory scheduleAgain = abi.encodeCall(
            timelock.schedule,
            (address(receipts), 0, payload, bytes32(0), bytes32(uint256(1)), MIN_DELAY)
        );
        bytes memory oneSig =
            _oneOwnerSignature(_safeDigest(safe, address(timelock), scheduleAgain));
        vm.expectRevert(bytes("GS020"));
        _safeExecWith(safe, address(timelock), scheduleAgain, oneSig);

        // Executing before the delay elapses is refused with the exact reasons.
        _expectExecuteRefused(safe, timelock, address(receipts), payload, bytes32(0));

        vm.warp(block.timestamp + MIN_DELAY);
        _govExecute(safe, timelock, address(receipts), payload, bytes32(0));

        // Replay of the executed release is refused with the exact reasons.
        _expectExecuteRefused(safe, timelock, address(receipts), payload, bytes32(0));

        assertTrue(
            receipts.hasRole(receipts.RECEIPT_SUBMITTER_ROLE(), stranger),
            "timelock-routed grant must succeed"
        );
    }

    function testDoubleReleaseReverts() public {
        bytes32 id = keccak256("r");
        _record(id, keccak256("d"));
        _release(id);
        vm.prank(releaser);
        vm.expectRevert(IConsensusRecommendationReceipt.ReceiptAlreadyReleased.selector);
        receipts.releaseReceipt(id);
    }

    function testReleaseUnknownReceiptReverts() public {
        vm.prank(releaser);
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
        _release(id);
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

    /// @dev AC1, the signalling-only boundary of the receipt contract.
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

        // 3. No weight-setter entry point: neither the deleted `execute(uint256)` nor
        //    `RouterGovernance.applyReceipt(bytes32,bytes32,address[],uint256[])`.
        (bool ok3,) =
            address(receipts).call(abi.encodeWithSignature("execute(uint256)", uint256(0)));
        assertFalse(ok3, "receipt contract must not have the old RouterGovernance.execute");
        (bool ok3b,) = address(receipts)
            .call(
                abi.encodeWithSignature(
                    "applyReceipt(bytes32,bytes32,address[],uint256[])",
                    bytes32(0),
                    bytes32(0),
                    new address[](0),
                    new uint256[](0)
                )
            );
        assertFalse(ok3b, "receipt contract must not have RouterGovernance.applyReceipt");

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
        _release(id);

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

    // ─── Last-admin floor (#1447, workstream L) ──────────────────────────────

    function test_receipt_lastAdminFloor_revokeAndRenounceRevert() public {
        bytes32 adminRole = receipts.ADMIN_ROLE();
        bytes32 defaultAdmin = receipts.DEFAULT_ADMIN_ROLE();
        vm.startPrank(address(timelock));
        vm.expectRevert(AdminFloorAccessControl.LastAdminFloor.selector);
        receipts.revokeRole(adminRole, address(timelock));
        vm.expectRevert(AdminFloorAccessControl.LastAdminFloor.selector);
        receipts.renounceRole(adminRole, address(timelock));
        vm.expectRevert(AdminFloorAccessControl.LastAdminFloor.selector);
        receipts.revokeRole(defaultAdmin, address(timelock));
        vm.expectRevert(AdminFloorAccessControl.LastAdminFloor.selector);
        receipts.renounceRole(defaultAdmin, address(timelock));
        vm.stopPrank();
        assertTrue(receipts.hasRole(adminRole, address(timelock)));
        assertTrue(receipts.hasRole(defaultAdmin, address(timelock)));
    }

    function test_receipt_lastAdminFloor_handoverSucceeds() public {
        address next = address(0xBEEF);
        bytes32 adminRole = receipts.ADMIN_ROLE();
        bytes32 defaultAdmin = receipts.DEFAULT_ADMIN_ROLE();
        vm.startPrank(address(timelock));
        receipts.grantRole(adminRole, next);
        receipts.grantRole(defaultAdmin, next);
        receipts.renounceRole(adminRole, address(timelock));
        receipts.renounceRole(defaultAdmin, address(timelock));
        vm.stopPrank();
        assertFalse(receipts.hasRole(adminRole, address(timelock)));
        assertFalse(receipts.hasRole(defaultAdmin, address(timelock)));
        // The new holder is now the last admin and is floored in turn.
        vm.startPrank(next);
        vm.expectRevert(AdminFloorAccessControl.LastAdminFloor.selector);
        receipts.renounceRole(defaultAdmin, next);
        vm.stopPrank();
    }
}
