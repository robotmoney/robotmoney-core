// SPDX-License-Identifier: MIT
// Canonical: docs/technical/governance-decisions.md §3.2, §3.6, §3.7 — the Safe applies a consensus receipt through the weight setter
// Canonical: docs/technical/governance-isomorphism.md — the test governance path is the production one
// Implements: issue #1698 — applyReceipt in one call through the real Safe and timelock; no voting surface; no duplicate vault
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {RouterGovernance} from "../RouterGovernance.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";
import {DeployRouterGovernance} from "../script/DeployRouterGovernance.s.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";
import {MockUsdc, MockGovVault} from "./RouterGovernance.t.sol";

/// @title RouterGovernanceApplyReceiptTest
/// @notice A recorded consensus receipt is applied the production way: two of the three
///         Safe owners sign, the real SafeL2 proxy schedules `applyReceipt` on the
///         timelock, the delay passes, and the execute releases the receipt and sets the
///         router weights in one transaction. Nothing pranks the Safe or the timelock.
///         The governance contract is deployed and wired by the real
///         `DeployRouterGovernance` script; the handover mirrors `DeployTimelock`.
///
///         Refusals are asserted with their exact reason by executing the ready
///         operation straight on the open-executor timelock (the Safe would hide the
///         reason as GS013). The receipt register's gateway is this test contract: the
///         committee's record path is not under test here.
contract RouterGovernanceApplyReceiptTest is SafeGovernance {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant WEIGHT_SETTER_ROLE = keccak256("WEIGHT_SETTER_ROLE");
    uint256 internal constant DELAY = 2 days;

    address internal safe;
    TimelockController internal timelock;
    MockUsdc internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    InvestmentCommitteePolicy internal ic;
    ConsensusRecommendationReceipt internal receipts;
    RouterGovernance internal gov;
    MockGovVault internal vaultA;
    MockGovVault internal vaultB;

    address internal submitter = makeAddr("committee-submitter");

    bytes32 internal constant RECEIPT_ID = keccak256("receipt-1");
    bytes32 internal constant DIGEST = keccak256("canonical receipt bytes 1");

    function setUp() public {
        _installSafeSet();
        safe = _newDefaultSafe();
        timelock = _newGovTimelock(safe, DELAY);

        usdc = new MockUsdc();
        registry = new VaultRegistry(address(this));
        router = new PortfolioRouter(address(usdc), address(registry), address(this));
        vaultA = new MockGovVault(address(usdc));
        vaultB = new MockGovVault(address(usdc));
        registry.registerVault(
            address(vaultA),
            VaultRegistry.VaultMetadata({name: "A", asset: address(usdc), registeredAt: 0})
        );
        registry.registerVault(
            address(vaultB),
            VaultRegistry.VaultMetadata({name: "B", asset: address(usdc), registeredAt: 0})
        );
        registry.setRouterEligible(address(vaultA), true);
        registry.setRouterEligible(address(vaultB), true);

        ic = new InvestmentCommitteePolicy(address(this), address(this));
        ic.registerAgent(submitter, "submitter");
        receipts = new ConsensusRecommendationReceipt(address(this), address(this), address(ic));

        // The real governance stage: deploy, router ADMIN_ROLE, router WEIGHT_SETTER_ROLE
        // (the deployer's copy dropped), receipt ADMIN_ROLE. Each grant is read back.
        DeployRouterGovernance script = new DeployRouterGovernance();
        gov = script.runInProcessWith(address(this), address(router), address(receipts)).governance;

        // The timelock stage's handover, for the four contracts this test touches.
        _handOver(address(router));
        _handOver(address(gov));
        IAccessControl(address(gov)).grantRole(WEIGHT_SETTER_ROLE, address(timelock));
        IAccessControl(address(gov)).revokeRole(WEIGHT_SETTER_ROLE, address(this));
        receipts.grantRole(ADMIN_ROLE, address(timelock));
        receipts.grantRole(receipts.DEFAULT_ADMIN_ROLE(), address(timelock));
        receipts.revokeRole(ADMIN_ROLE, address(this));
        receipts.revokeRole(receipts.DEFAULT_ADMIN_ROLE(), address(this));

        // The committee records a receipt (this contract is the register's gateway).
        receipts.recordReceipt(submitter, RECEIPT_ID, DIGEST, "https://example.invalid/r1");
    }

    function _handOver(address target) internal {
        IAccessControl(target).grantRole(ADMIN_ROLE, address(timelock));
        IAccessControl(target).revokeRole(ADMIN_ROLE, address(this));
    }

    function _vector() internal view returns (address[] memory vaults, uint256[] memory bps) {
        vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        bps = new uint256[](2);
        bps[0] = 6_000;
        bps[1] = 4_000;
    }

    function _applyCall(bytes32 id, bytes32 digest, address[] memory vaults, uint256[] memory bps)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(RouterGovernance.applyReceipt, (id, digest, vaults, bps));
    }

    /// @dev Schedule through the Safe, mine the delay, then execute straight on the
    ///      open-executor timelock expecting exactly `reason`.
    function _expectApplyRefused(bytes memory data, bytes32 salt, bytes memory reason) internal {
        _govSchedule(safe, timelock, address(gov), data, salt, DELAY);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(reason);
        timelock.execute(address(gov), 0, data, bytes32(0), salt);
    }

    function _assertNothingApplied() internal view {
        assertFalse(receipts.isReleased(RECEIPT_ID), "receipt must stay unreleased");
        (address[] memory active,) = router.getWeights();
        assertEq(active.length, 0, "no active vector may land");
        assertFalse(router.votedWeightsActive(), "routing must stay on the default vector");
    }

    // ─── The governed path ───────────────────────────────────────────────────

    function test_applyReceipt_viaSafeAndTimelock() public {
        (address[] memory vaults, uint256[] memory bps) = _vector();
        bytes memory data = _applyCall(RECEIPT_ID, DIGEST, vaults, bps);
        bytes32 salt = keccak256("apply-1");

        _govSchedule(safe, timelock, address(gov), data, salt, DELAY);
        _expectExecuteRefused(safe, timelock, address(gov), data, salt);
        _assertNothingApplied();
        vm.warp(block.timestamp + DELAY);

        // One transaction: the Safe's execTransaction runs timelock.execute, which runs
        // applyReceipt, which releases the receipt and sets the weights.
        vm.recordLogs();
        _govExecute(safe, timelock, address(gov), data, salt);
        _assertOneReleaseOneSetOneApplied();

        assertTrue(receipts.isReleased(RECEIPT_ID), "receipt released");
        assertEq(receipts.getReceiptById(RECEIPT_ID).releasedAt, block.timestamp);
        _assertRouterVector(vaults, bps);

        _expectExecuteRefused(safe, timelock, address(gov), data, salt);
    }

    /// @dev The recorded execute transaction holds exactly one ReceiptReleased, one
    ///      WeightsSet and one ReceiptApplied, each from its own contract.
    function _assertOneReleaseOneSetOneApplied() internal {
        uint256 released;
        uint256 set;
        uint256 applied;
        VmLogs memory l = _logs();
        for (uint256 i = 0; i < l.emitters.length; i++) {
            if (
                l.emitters[i] == address(receipts)
                    && l.topic0[i] == keccak256("ReceiptReleased(bytes32,address,uint64)")
            ) released++;
            if (
                l.emitters[i] == address(router)
                    && l.topic0[i] == keccak256("WeightsSet(address[],uint256[])")
            ) set++;
            if (
                l.emitters[i] == address(gov)
                    && l.topic0[i]
                        == keccak256("ReceiptApplied(bytes32,bytes32,address[],uint256[])")
            ) applied++;
        }
        assertEq(released, 1, "one ReceiptReleased in the execute transaction");
        assertEq(set, 1, "one WeightsSet in the execute transaction");
        assertEq(applied, 1, "one ReceiptApplied in the execute transaction");
    }

    /// @dev The router's active and effective vectors both equal the applied vector.
    function _assertRouterVector(address[] memory vaults, uint256[] memory bps) internal view {
        (address[] memory gotVaults, uint256[] memory gotBps) = router.getWeights();
        assertEq(gotVaults, vaults, "router vaults equal the vector");
        assertEq(gotBps, bps, "router bps equal the vector");
        assertTrue(router.votedWeightsActive(), "the applied vector is the one routing uses");
        (address[] memory effVaults, uint256[] memory effBps) = router.getEffectiveWeights();
        assertEq(effVaults, vaults, "effective vaults equal the vector");
        assertEq(effBps, bps, "effective bps equal the vector");
    }

    // ─── Refusals ────────────────────────────────────────────────────────────

    function test_applyReceipt_revertsOnDigestMismatch() public {
        (address[] memory vaults, uint256[] memory bps) = _vector();
        bytes32 wrong = keccak256("some other payload");
        _expectApplyRefused(
            _applyCall(RECEIPT_ID, wrong, vaults, bps),
            keccak256("digest-mismatch"),
            abi.encodeWithSelector(
                RouterGovernance.PayloadDigestMismatch.selector, RECEIPT_ID, DIGEST, wrong
            )
        );
        _assertNothingApplied();
    }

    function test_applyReceipt_revertsOnUnrecordedReceipt() public {
        (address[] memory vaults, uint256[] memory bps) = _vector();
        bytes32 unknown = keccak256("never recorded");
        _expectApplyRefused(
            _applyCall(unknown, DIGEST, vaults, bps),
            keccak256("unrecorded"),
            abi.encodeWithSelector(RouterGovernance.ReceiptNotRecorded.selector, unknown)
        );
        _assertNothingApplied();
    }

    function test_applyReceipt_revertsOnReleasedReceipt() public {
        (address[] memory vaults, uint256[] memory bps) = _vector();
        bytes memory data = _applyCall(RECEIPT_ID, DIGEST, vaults, bps);
        _govRun(safe, timelock, address(gov), data, keccak256("first"), DELAY);
        assertTrue(receipts.isReleased(RECEIPT_ID));

        // A second round for the same receipt, with a different vector, is refused.
        bps[0] = 1_000;
        bps[1] = 9_000;
        _expectApplyRefused(
            _applyCall(RECEIPT_ID, DIGEST, vaults, bps),
            keccak256("second"),
            abi.encodeWithSelector(RouterGovernance.ReceiptAlreadyReleased.selector, RECEIPT_ID)
        );
        (, uint256[] memory gotBps) = router.getWeights();
        assertEq(gotBps[0], 6_000, "the first application stands");
    }

    /// @notice Every caller other than the timelock is refused: the Safe itself (with
    ///         two real owner signatures), the deployer, the committee submitter, the
    ///         router and the receipt register, and any fuzzed address.
    function test_applyReceipt_revertsForNonWeightSetter(address caller) public {
        vm.assume(caller != address(timelock));
        (address[] memory vaults, uint256[] memory bps) = _vector();
        bytes memory data = _applyCall(RECEIPT_ID, DIGEST, vaults, bps);

        _assertSafeCallReverts(safe, address(gov), data, _unauthorized(safe));
        bytes memory sigs = _twoOwnerSignatures(_safeDigest(safe, address(gov), data));
        vm.expectRevert(bytes(GS013));
        _safeExecWith(safe, address(gov), data, sigs);

        address[5] memory named =
            [address(this), submitter, address(router), address(receipts), caller];
        for (uint256 i = 0; i < named.length; i++) {
            if (named[i] == address(timelock)) continue;
            vm.prank(named[i]);
            vm.expectRevert(_unauthorized(named[i]));
            gov.applyReceipt(RECEIPT_ID, DIGEST, vaults, bps);
        }
        assertEq(gov.getRoleMemberCount(WEIGHT_SETTER_ROLE), 1, "one weight setter");
        assertEq(gov.getRoleMember(WEIGHT_SETTER_ROLE, 0), address(timelock));
        _assertNothingApplied();
    }

    function _unauthorized(address who) internal pure returns (bytes memory) {
        return abi.encodeWithSignature(
            "AccessControlUnauthorizedAccount(address,bytes32)", who, WEIGHT_SETTER_ROLE
        );
    }

    /// @notice ADMIN_ROLE (the timelock) cannot grant the weight-setter role: it is
    ///         self-administered, so the only way to change its holder is the holder.
    function test_weightSetterRoleIsSelfAdministered() public view {
        assertEq(gov.getRoleAdmin(WEIGHT_SETTER_ROLE), WEIGHT_SETTER_ROLE);
        assertEq(gov.getRoleAdmin(ADMIN_ROLE), ADMIN_ROLE);
    }

    // ─── Duplicate vault (security review 2026-10-12 finding 8, HR-L-9) ──────

    /// @notice A vector naming one vault twice is refused on every path that writes a
    ///         vector: the receipt path (setWeights), the governance default-weights
    ///         forwarder and the router's own setDefaultWeights. All through the Safe and
    ///         the timelock. The duplicate default has length 2 == routerEligibleCount,
    ///         the exact shape the finding describes (vault B silently omitted).
    function test_duplicateVault_revertsOnSettersAndReceiptPath() public {
        address[] memory dup = new address[](2);
        dup[0] = address(vaultA);
        dup[1] = address(vaultA);
        uint256[] memory bps = new uint256[](2);
        bps[0] = 5_000;
        bps[1] = 5_000;
        bytes memory reason =
            abi.encodeWithSelector(PortfolioRouter.DuplicateVault.selector, address(vaultA));

        _expectApplyRefused(
            _applyCall(RECEIPT_ID, DIGEST, dup, bps), keccak256("dup-apply"), reason
        );
        _assertNothingApplied();

        bytes memory govDefault = abi.encodeCall(RouterGovernance.setDefaultWeights, (dup, bps));
        _govSchedule(safe, timelock, address(gov), govDefault, keccak256("dup-gov-default"), DELAY);
        bytes memory routerDefault = abi.encodeCall(PortfolioRouter.setDefaultWeights, (dup, bps));
        _govSchedule(
            safe, timelock, address(router), routerDefault, keccak256("dup-router-default"), DELAY
        );
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(reason);
        timelock.execute(address(gov), 0, govDefault, bytes32(0), keccak256("dup-gov-default"));
        vm.expectRevert(reason);
        timelock.execute(
            address(router), 0, routerDefault, bytes32(0), keccak256("dup-router-default")
        );
        (address[] memory defaults,) = router.getDefaultWeights();
        assertEq(defaults.length, 0, "no duplicate default may land");
    }

    // ─── No voting surface ───────────────────────────────────────────────────

    /// @notice The deployed weight setter, router and receipt register expose no voting
    ///         function. Checked two ways on the deployed runtime code: no PUSH4 of any
    ///         voting selector (the dispatcher pushes every external selector), and each
    ///         zero-argument voting getter reverts with empty data (no such function, no
    ///         fallback).
    function test_noVotingSurface() public {
        string[13] memory sigs = [
            "propose(address[],uint256[])",
            "vote(uint256)",
            "execute(uint256)",
            "cancel(uint256)",
            "setVotingPower(address,uint256)",
            "votingPower(address)",
            "quorumThreshold()",
            "votingPeriod()",
            "executionDelay()",
            "setQuorumThreshold(uint256)",
            "activeProposal()",
            "cadenceParams()",
            "totalVotingPower()"
        ];
        address[3] memory deployed = [address(gov), address(router), address(receipts)];
        for (uint256 c = 0; c < deployed.length; c++) {
            for (uint256 i = 0; i < sigs.length; i++) {
                bytes4 sel = bytes4(keccak256(bytes(sigs[i])));
                assertFalse(
                    _pushes4(deployed[c].code, sel),
                    string.concat("voting selector in runtime code: ", sigs[i])
                );
            }
            string[3] memory getters = ["quorumThreshold()", "votingPeriod()", "executionDelay()"];
            for (uint256 i = 0; i < getters.length; i++) {
                (bool ok, bytes memory ret) = deployed[c].call(abi.encodeWithSignature(getters[i]));
                assertFalse(ok, string.concat("voting getter answered: ", getters[i]));
                assertEq(ret.length, 0, "no such function: empty revert");
            }
        }
        // The positive control: the scan does find a selector the contract has.
        assertTrue(_pushes4(address(gov).code, RouterGovernance.applyReceipt.selector));
    }

    /// @dev True when `code` contains a PUSH4 whose immediate is `sel`. Walks opcodes so
    ///      bytes inside other PUSH immediates are never read as instructions.
    function _pushes4(bytes memory code, bytes4 sel) internal pure returns (bool) {
        uint256 i = 0;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            if (op == 0x63 && i + 4 < code.length) {
                if (
                    code[i + 1] == sel[0] && code[i + 2] == sel[1] && code[i + 3] == sel[2]
                        && code[i + 4] == sel[3]
                ) return true;
            }
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
            i++;
        }
        return false;
    }

    // ─── Log helper ──────────────────────────────────────────────────────────

    struct VmLogs {
        address[] emitters;
        bytes32[] topic0;
    }

    function _logs() internal returns (VmLogs memory l) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        l.emitters = new address[](logs.length);
        l.topic0 = new bytes32[](logs.length);
        for (uint256 i = 0; i < logs.length; i++) {
            l.emitters[i] = logs[i].emitter;
            l.topic0[i] = logs[i].topics.length > 0 ? logs[i].topics[0] : bytes32(0);
        }
    }
}
