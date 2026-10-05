// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §4 — Access control & admin
// Canonical: docs/technical/governance-isomorphism.md — the Safe is a real SafeProxy on the
//            canonical SafeL2 singleton, threshold >= 2, driven by execTransaction
// Implements: issue #1447, workstream E — real Safe -> TimelockController coverage of the
//             governed setters. No vm.prank(safe), no stub Safe: every governed call is
//             scheduled and executed by `Safe.execTransaction` carrying two distinct owner
//             signatures, and lands through the real TimelockController at its delay.
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {DeployTimelock} from "../script/DeployTimelock.s.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {RoleHolders} from "./helpers/RoleHolders.sol";
import {SafeFixture} from "./helpers/SafeFixture.sol";
import {ISafe} from "./SafeIntegration.t.sol";
import {MockPool, RecordingSwapRouter} from "./AgentTokenVault.t.sol";
import {ManifestHarness, RunEntrypointRelay} from "./DeployTimelock.t.sol";

/// @dev A call probe the real Safe delegatecalls (the pattern of Safe's own SimulateTxAccessor).
///      It runs in the Safe's context, so the target sees `msg.sender == safe`. It swallows the
///      target's revert and emits its raw revert data, because `execTransaction` alone reports any
///      inner revert as the bare `GS013`. Used only to read the exact inner reason of a negative
///      control. The Safe still checks two owner signatures before it runs.
contract SafeCallProbe {
    event Probe(address indexed target, bool ok, bytes ret);

    function probe(address target, bytes calldata data) external {
        (bool ok, bytes memory ret) = target.call(data);
        emit Probe(target, ok, ret);
    }
}

/// @title RealSafeGovernedSetters
/// @notice One deployment handed over by the production ceremony itself, then governed by a real
///         TimelockController driven by a factory-made canonical SafeL2 proxy (2-of-3). Every
///         governed setter is scheduled and executed by two distinct owner signatures through
///         `execTransaction` at the timelock delay. Negative controls assert exact revert reasons.
/// @dev The handover is `DeployTimelock._runFrom`, the body of the broadcast `run()`, reached through
///      the test-side `ManifestHarness` and `RunEntrypointRelay` of DeployTimelock.t.sol. It reads
///      every input from env vars under a prefix only this file sets, broadcasts from the deployer and
///      performs the committee handover (IC policy and consensus receipt) exactly as production does.
///      No in-process shortcut entry point and no hand-copied grant or revoke is used.
///      In process: SafeFixture installs the vendored SafeL2 at the canonical address, builds the
///      proxy through a SafeProxyFactory and etches the canonical SafeProxy runtime. No fork, so this
///      file never skips for want of FORK_RPC_URL. DeployTimelock accepts the Safe by the same checks
///      it runs on a real chain. Known fixture gap: the vendored singleton is compiled with this
///      repo's solc settings, so its codehash is not compared with Base's deployed SafeL2.
contract RealSafeGovernedSettersTest is SafeFixture {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 internal constant AGENT_ROLE = keccak256("AGENT_ROLE");
    bytes32 internal constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");
    bytes32 internal constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    bytes32 internal constant CANCELLER_ROLE = keccak256("CANCELLER_ROLE");
    uint256 internal constant MIN_DELAY = 2 days;
    uint256 internal constant ONE_USDC = 1e6;
    /// @dev Env vars are process-wide and forge runs tests in parallel: this prefix is ours alone.
    string internal constant PREFIX = "RM_1447E_REAL_SAFE_";
    /// @dev Every test's setUp writes identical content here (the deployment is deterministic).
    string internal constant MANIFEST_OUT = "/tmp/rm-1447e-real-safe-governed-manifest.json";

    // ─── Topology ────────────────────────────────────────────────────────────

    ManifestHarness internal harness;
    /// @dev The broadcaster and the script's msg.sender, as in a real `forge script` run: the
    ///      default broadcaster is tx.origin, and a relay etched there calls run()'s body.
    address internal deployer;

    TestERC20 internal usdc;
    RecordingSwapRouter internal swapRouter;
    RobotMoneyVault internal rmVault;
    AgentTokenVault internal agentVault;
    RobotMoneyGateway internal gateway;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RouterGovernance internal gov;
    InvestmentCommitteePolicy internal icPolicy;
    ConsensusRecommendationReceipt internal receipt;
    TimelockController internal timelock;
    SafeCallProbe internal probe;

    ISafe internal safe;
    uint256[3] internal ownerPks;

    TestERC20 internal seededToken;
    address internal pauser = makeAddr("pauser");
    address internal emergency = makeAddr("emergency");
    address internal stranger = makeAddr("stranger");
    address internal committeeAgent = makeAddr("committee-agent");
    bytes32 internal constant RECEIPT_ID = keccak256("receipt-1");

    address[8] internal governed;
    mapping(address => address[]) internal adminHolders;
    mapping(address => address[]) internal rootHolders;
    mapping(bytes32 => address[]) internal timelockRoleHolders;

    function _set(string memory name, string memory value) internal {
        vm.setEnv(string.concat(PREFIX, name), value);
    }

    function setUp() public {
        vm.recordLogs();
        harness = new ManifestHarness();
        deployer = tx.origin;
        vm.etch(deployer, address(new RunEntrypointRelay()).code);
        usdc = new TestERC20();
        swapRouter = new RecordingSwapRouter();
        probe = new SafeCallProbe();

        // A real Safe proxy from the factory: 2-of-3, three distinct owner keys.
        _installSafeSet();
        address[] memory owners = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            ownerPks[i] = uint256(keccak256(abi.encode("real-safe-governed-owner", i)));
            owners[i] = vm.addr(ownerPks[i]);
        }
        safe = ISafe(_newSafe(owners, FIXTURE_THRESHOLD));

        rmVault = new RobotMoneyVault(
            usdc, type(uint256).max, type(uint256).max, 0, address(safe), deployer, deployer
        );
        agentVault = new AgentTokenVault(
            IERC20(address(usdc)),
            ISwapRouter(address(swapRouter)),
            10_000_000 * ONE_USDC,
            1_000_000 * ONE_USDC,
            0,
            address(safe),
            deployer,
            deployer
        );
        gateway = new RobotMoneyGateway(usdc, rmVault, deployer, pauser, address(0));
        registry = new VaultRegistry(deployer);
        router = new PortfolioRouter(address(usdc), address(registry), deployer);
        gov = new RouterGovernance(address(router), deployer, 7 days, 1 days, 2);
        icPolicy = new InvestmentCommitteePolicy(deployer, address(gateway));
        receipt = new ConsensusRecommendationReceipt(deployer, address(gateway), address(icPolicy));

        vm.startPrank(deployer);
        // R7: governance holds the router ADMIN_ROLE, as DeployRouterGovernance leaves it.
        router.grantRole(ADMIN_ROLE, address(gov));
        // One removable shortlist asset, seeded by the deployer before the handover.
        seededToken = new TestERC20();
        agentVault.addAsset(
            address(seededToken),
            address(new MockPool(address(seededToken), address(usdc), 3000)),
            3000,
            address(0),
            BasketVault.Venue.V3
        );
        registry.registerVault(
            address(rmVault),
            VaultRegistry.VaultMetadata({name: "rmVault", asset: address(usdc), registeredAt: 0})
        );
        registry.registerVault(
            address(agentVault),
            VaultRegistry.VaultMetadata({name: "rmAGENT", asset: address(usdc), registeredAt: 0})
        );
        // The committee submitter: a gateway agent (no deployer ownership) and a committee member.
        gateway.setConsensusReceipt(address(receipt));
        gateway.grantRole(AGENT_ROLE, committeeAgent);
        icPolicy.grantRole(icPolicy.COMMITTEE_AGENT_ROLE(), committeeAgent);
        vm.stopPrank();
        // One receipt to release later, recorded through the real gateway path.
        vm.prank(committeeAgent);
        gateway.consensusRecordReceipt(RECEIPT_ID, keccak256("digest"), "ipfs://receipt-1");

        // The production ceremony inputs: every one `run()` requires.
        _set("AGENT_ADDRESSES", "none");
        _set(
            "VAULT_ADDRESSES",
            string.concat(vm.toString(address(rmVault)), ",", vm.toString(address(agentVault)))
        );
        _set("GATEWAY_ADDRESS", vm.toString(address(gateway)));
        _set("REGISTRY_ADDRESS", vm.toString(address(registry)));
        _set("ROUTER_ADDRESS", vm.toString(address(router)));
        _set("GOVERNANCE_ADDRESS", vm.toString(address(gov)));
        _set("SAFE_ADDRESS", vm.toString(address(safe)));
        _set(
            "SAFE_OWNERS",
            string.concat(
                vm.toString(owners[0]), ",", vm.toString(owners[1]), ",", vm.toString(owners[2])
            )
        );
        _set("SAFE_THRESHOLD", vm.toString(FIXTURE_THRESHOLD));
        _set("EMERGENCY_ADDRESS", vm.toString(emergency));
        _set("TIMELOCK_MIN_DELAY", vm.toString(MIN_DELAY));
        _set("IC_POLICY_ADDRESS", vm.toString(address(icPolicy)));
        _set("CONSENSUS_RECEIPT_ADDRESS", vm.toString(address(receipt)));
        _set("RECEIPT_ADMIN_ADDRESS", vm.toString(deployer));
        _set("DEPLOYMENT_OUT", MANIFEST_OUT);

        DeployTimelock.Deployed memory d = RunEntrypointRelay(deployer).runFrom(harness, PREFIX);
        timelock = d.timelock;
        require(d.icPolicy == address(icPolicy), "committee handover skipped the IC policy");
        require(d.consensusReceipt == address(receipt), "committee handover skipped the receipt");

        governed = [
            address(rmVault),
            address(agentVault),
            address(gateway),
            address(registry),
            address(router),
            address(gov),
            address(receipt),
            address(icPolicy)
        ];
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < governed.length; i++) {
            adminHolders[governed[i]] = RoleHolders.holders(logs, governed[i], ADMIN_ROLE);
            rootHolders[governed[i]] = RoleHolders.holders(logs, governed[i], DEFAULT_ADMIN_ROLE);
        }
        bytes32[4] memory tlRoles =
            [PROPOSER_ROLE, EXECUTOR_ROLE, CANCELLER_ROLE, DEFAULT_ADMIN_ROLE];
        for (uint256 i = 0; i < tlRoles.length; i++) {
            timelockRoleHolders[tlRoles[i]] =
                RoleHolders.holders(logs, address(timelock), tlRoles[i]);
        }
    }

    // ─── Positive: BasketVault setters through Safe -> Timelock ──────────────

    function test_setFeeRecipient_andExitFee_throughRealSafe() public {
        address newRecipient = makeAddr("new-fee-recipient");
        _govern(
            address(agentVault),
            abi.encodeCall(BasketVault.setFeeRecipient, (newRecipient)),
            keccak256("fee-recipient")
        );
        assertEq(agentVault.feeRecipient(), newRecipient, "fee recipient not set");

        _govern(
            address(agentVault),
            abi.encodeCall(BasketVault.setExitFeeBps, (25)),
            keccak256("exit-fee")
        );
        assertEq(agentVault.exitFeeBps(), 25, "exit fee not set");
    }

    function test_retire_throughRealSafe() public {
        assertFalse(agentVault.retired(), "vault starts active");
        _govern(
            address(registry),
            abi.encodeCall(VaultRegistry.retire, (address(agentVault))),
            keccak256("retire")
        );
        assertTrue(agentVault.retired(), "vault not retired");
        (, VaultRegistry.VaultStatus st) = registry.getVault(address(agentVault));
        assertEq(
            uint256(st), uint256(VaultRegistry.VaultStatus.Retired), "registry status not Retired"
        );
    }

    function test_setQuarantineAddress_throughRealSafe() public {
        address newQuarantine = makeAddr("new-quarantine");
        _govern(
            address(rmVault),
            abi.encodeCall(RobotMoneyVault.setQuarantineAddress, (newQuarantine)),
            keccak256("quarantine-vault")
        );
        assertEq(rmVault.quarantineAddress(), newQuarantine, "vault quarantine not set");

        address routerQuarantine = makeAddr("router-quarantine");
        _govern(
            address(router),
            abi.encodeCall(PortfolioRouter.setQuarantineAddress, (routerQuarantine)),
            keccak256("quarantine-router")
        );
        assertEq(router.quarantineAddress(), routerQuarantine, "router quarantine not set");
    }

    // ─── Positive: gateway agent authorization and AGENT grant ───────────────

    function test_authorizeAgent_throughRealSafe() public {
        address agent = makeAddr("authorized-agent");
        IGateway.AgentPolicy memory p = _policy();
        _govern(
            address(gateway),
            abi.encodeCall(IGateway.authorizeAgent, (agent, p)),
            keccak256("authorize-agent")
        );
        assertTrue(gateway.hasRole(AGENT_ROLE, agent), "agent lacks AGENT_ROLE");
        assertEq(gateway.agentOwner(agent), address(timelock), "timelock must own the agent");
    }

    function test_gatewayAgentRoleGrant_throughRealSafe() public {
        address agent = makeAddr("granted-agent");
        assertFalse(gateway.hasRole(AGENT_ROLE, agent));
        // Direct grant is closed to every holder of a key.
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger, ADMIN_ROLE));
        gateway.grantRole(AGENT_ROLE, agent);

        _govern(
            address(gateway),
            abi.encodeCall(IAccessControl.grantRole, (AGENT_ROLE, agent)),
            keccak256("grant-agent")
        );
        assertTrue(gateway.hasRole(AGENT_ROLE, agent), "AGENT_ROLE not granted");
    }

    // ─── Positive: AgentTokenVault shortlist and the cancel path ─────────────

    function test_addAsset_andRemoveAsset_throughRealSafe() public {
        TestERC20 token = new TestERC20();
        MockPool pool = new MockPool(address(token), address(usdc), 3000);
        _govern(
            address(agentVault),
            abi.encodeCall(
                BasketVault.addAsset,
                (address(token), address(pool), 3000, address(0), BasketVault.Venue.V3)
            ),
            keccak256("add-asset")
        );
        (address[] memory tokens,,, bool[] memory active,) = agentVault.shortlist();
        assertEq(tokens.length, 2, "asset not appended");
        assertEq(tokens[1], address(token));
        assertTrue(active[1]);

        _govern(
            address(agentVault), abi.encodeCall(BasketVault.removeAsset, (0)), keccak256("rm-asset")
        );
        (,,, active,) = agentVault.shortlist();
        assertFalse(active[0], "seeded asset not removed");
        assertTrue(active[1], "other asset must stay");
    }

    function test_cancel_throughRealSafe_blocksExecution() public {
        TestERC20 token = new TestERC20();
        MockPool pool = new MockPool(address(token), address(usdc), 3000);
        bytes memory data = abi.encodeCall(
            BasketVault.addAsset,
            (address(token), address(pool), 3000, address(0), BasketVault.Venue.V3)
        );
        bytes32 salt = keccak256("cancelled-add");
        bytes32 id = timelock.hashOperation(address(agentVault), 0, data, bytes32(0), salt);

        _safeExec(address(timelock), _schedule(address(agentVault), data, salt, MIN_DELAY));
        assertEq(
            uint256(timelock.getOperationState(id)),
            _state(TimelockController.OperationState.Waiting)
        );

        // The Safe (a proposer, so a canceller) vetoes through its own quorum.
        _safeExec(address(timelock), abi.encodeCall(TimelockController.cancel, (id)));
        assertEq(
            uint256(timelock.getOperationState(id)), _state(TimelockController.OperationState.Unset)
        );

        vm.warp(block.timestamp + MIN_DELAY + 1);
        // Exact inner reason: the op is Unset, execute wants Ready.
        (bool ok, bytes memory ret) = _probeSafe(
            address(timelock),
            abi.encodeCall(
                TimelockController.execute, (address(agentVault), 0, data, bytes32(0), salt)
            )
        );
        assertFalse(ok, "a cancelled operation executed");
        assertEq(ret, _notReady(id), "wrong revert reason for a cancelled operation");
        // The normal Safe call of the same execute reverts GS013.
        _expectGS013(
            address(timelock),
            abi.encodeCall(
                TimelockController.execute, (address(agentVault), 0, data, bytes32(0), salt)
            )
        );

        (address[] memory tokens,,,,) = agentVault.shortlist();
        assertEq(tokens.length, 1, "cancelled addAsset must not land");
    }

    // ─── Positive: ConsensusRecommendationReceipt.releaseReceipt ─────────────

    function test_releaseReceipt_throughRealSafe() public {
        assertTrue(receipt.isRecorded(RECEIPT_ID));
        assertFalse(receipt.isReleased(RECEIPT_ID));
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger, ADMIN_ROLE));
        receipt.releaseReceipt(RECEIPT_ID);

        _govern(
            address(receipt),
            abi.encodeCall(ConsensusRecommendationReceipt.releaseReceipt, (RECEIPT_ID)),
            keccak256("release-receipt")
        );
        assertTrue(receipt.isReleased(RECEIPT_ID), "receipt not released");
    }

    // ─── Negative controls: exact revert reasons ─────────────────────────────

    /// @notice One owner's signature is below the threshold: Safe's GS020. The same SafeTx then
    ///         succeeds with a second distinct owner, so the revert is quorum and nothing else.
    function test_negative_oneOwnerSignature_GS020() public {
        bytes memory data = _schedule(
            address(agentVault),
            abi.encodeCall(BasketVault.setExitFeeBps, (10)),
            keccak256("gs020"),
            MIN_DELAY
        );
        bytes32 txHash = _safeTxHash(address(timelock), data);
        uint256[3] memory pks = _sortedPks();

        bytes memory oneSig = _sign(pks[0], txHash);
        vm.expectRevert(bytes("GS020"));
        safe.execTransaction(
            address(timelock), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), oneSig
        );

        bytes memory twoSigs = bytes.concat(oneSig, _sign(pks[1], txHash));
        assertTrue(
            safe.execTransaction(
                address(timelock), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), twoSigs
            ),
            "the same SafeTx must pass with a second distinct owner"
        );
    }

    /// @notice One owner signing twice has the byte length of a quorum and one owner's authority:
    ///         Safe's GS026.
    function test_negative_sameOwnerTwice_GS026() public {
        bytes memory data = _schedule(
            address(agentVault),
            abi.encodeCall(BasketVault.setExitFeeBps, (10)),
            keccak256("gs026-dup"),
            MIN_DELAY
        );
        bytes memory one = _sign(_sortedPks()[0], _safeTxHash(address(timelock), data));
        vm.expectRevert(bytes("GS026"));
        safe.execTransaction(
            address(timelock),
            0,
            data,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            bytes.concat(one, one)
        );
    }

    /// @notice Two signatures from keys that are not Safe owners: Safe's GS026.
    function test_negative_nonOwnerSigners_GS026() public {
        bytes memory data = _schedule(
            address(agentVault),
            abi.encodeCall(BasketVault.setExitFeeBps, (10)),
            keccak256("gs026-foreign"),
            MIN_DELAY
        );
        bytes32 txHash = _safeTxHash(address(timelock), data);
        uint256 pkA = uint256(keccak256("foreign-1"));
        uint256 pkB = uint256(keccak256("foreign-2"));
        if (vm.addr(pkB) < vm.addr(pkA)) (pkA, pkB) = (pkB, pkA);
        bytes memory sigs = bytes.concat(_sign(pkA, txHash), _sign(pkB, txHash));
        vm.expectRevert(bytes("GS026"));
        safe.execTransaction(
            address(timelock), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs
        );
    }

    /// @notice Executing before the delay: the Safe reports GS013, and the exact inner reason is
    ///         TimelockUnexpectedOperationState(id, Ready), read through the Safe's own context.
    function test_negative_executeBeforeDelay_GS013_andExactReason() public {
        bytes memory data = abi.encodeCall(BasketVault.setExitFeeBps, (30));
        bytes32 salt = keccak256("early");
        bytes32 id = timelock.hashOperation(address(agentVault), 0, data, bytes32(0), salt);
        _safeExec(address(timelock), _schedule(address(agentVault), data, salt, MIN_DELAY));

        bytes memory exec = abi.encodeCall(
            TimelockController.execute, (address(agentVault), 0, data, bytes32(0), salt)
        );

        (bool ok, bytes memory ret) = _probeSafe(address(timelock), exec);
        assertFalse(ok, "executed before the delay");
        assertEq(ret, _notReady(id), "wrong reason for an early execute");

        bytes memory sigs = _twoSigs(address(timelock), exec);
        vm.expectRevert(bytes("GS013"));
        safe.execTransaction(
            address(timelock), 0, exec, 0, 0, 0, 0, address(0), payable(address(0)), sigs
        );
        assertEq(agentVault.exitFeeBps(), 0, "setter landed before the delay");
    }

    /// @notice Replaying an executed operation reverts with the same exact state error (now Done).
    function test_negative_replayAfterExecution_exactReason() public {
        bytes memory data = abi.encodeCall(BasketVault.setExitFeeBps, (40));
        bytes32 salt = keccak256("replay");
        bytes32 id = timelock.hashOperation(address(agentVault), 0, data, bytes32(0), salt);
        _govern(address(agentVault), data, salt);
        assertEq(
            uint256(timelock.getOperationState(id)), _state(TimelockController.OperationState.Done)
        );

        (bool ok, bytes memory ret) = _probeSafe(
            address(timelock),
            abi.encodeCall(
                TimelockController.execute, (address(agentVault), 0, data, bytes32(0), salt)
            )
        );
        assertFalse(ok, "a Done operation executed twice");
        assertEq(ret, _notReady(id), "wrong reason for a replay");
        _expectGS013(
            address(timelock),
            abi.encodeCall(
                TimelockController.execute, (address(agentVault), 0, data, bytes32(0), salt)
            )
        );
    }

    /// @notice Scheduling below the minimum delay is refused by the timelock, exactly.
    function test_negative_scheduleBelowMinDelay_exactReason() public {
        bytes memory data = abi.encodeCall(BasketVault.setExitFeeBps, (30));
        (bool ok, bytes memory ret) = _probeSafe(
            address(timelock),
            _schedule(address(agentVault), data, keccak256("short"), MIN_DELAY - 1)
        );
        assertFalse(ok, "a below-minimum delay was accepted");
        assertEq(
            ret,
            abi.encodeWithSelector(
                TimelockController.TimelockInsufficientDelay.selector, MIN_DELAY - 1, MIN_DELAY
            ),
            "wrong reason for a short delay"
        );
        _expectGS013(
            address(timelock),
            _schedule(address(agentVault), data, keccak256("short"), MIN_DELAY - 1)
        );
    }

    /// @notice Boundary: one second before the ready time the execute fails (exact reason and
    ///         GS013). At the ready time the very same execute succeeds.
    function test_negative_executeOneSecondBeforeReady() public {
        bytes memory data = abi.encodeCall(BasketVault.setExitFeeBps, (35));
        bytes32 salt = keccak256("boundary");
        bytes32 id = timelock.hashOperation(address(agentVault), 0, data, bytes32(0), salt);
        _safeExec(address(timelock), _schedule(address(agentVault), data, salt, MIN_DELAY));
        uint256 readyAt = timelock.getTimestamp(id);
        assertEq(readyAt, block.timestamp + MIN_DELAY, "ready time is not schedule time + delay");
        bytes memory exec = abi.encodeCall(
            TimelockController.execute, (address(agentVault), 0, data, bytes32(0), salt)
        );

        vm.warp(readyAt - 1);
        (bool ok, bytes memory ret) = _probeSafe(address(timelock), exec);
        assertFalse(ok, "executed one second before the ready time");
        assertEq(ret, _notReady(id), "wrong reason one second before ready");
        _expectGS013(address(timelock), exec);
        assertEq(agentVault.exitFeeBps(), 0, "setter landed before the ready time");

        vm.warp(readyAt);
        _safeExec(address(timelock), exec);
        assertEq(agentVault.exitFeeBps(), 35, "setter did not land at the ready time");
    }

    /// @notice No key bypasses the timelock: the deployer, a Safe owner and a stranger are each
    ///         refused with the exact AccessControl error on every governed target.
    function test_negative_directCallsRefused() public {
        address owner0 = vm.addr(ownerPks[0]);
        address[3] memory callers = [deployer, owner0, stranger];
        TestERC20 token = new TestERC20();
        MockPool pool = new MockPool(address(token), address(usdc), 3000);
        IGateway.AgentPolicy memory p = _policy();
        for (uint256 i = 0; i < callers.length; i++) {
            vm.startPrank(callers[i]);
            vm.expectRevert(_unauthorized(callers[i], ADMIN_ROLE));
            agentVault.setFeeRecipient(callers[i]);
            vm.expectRevert(_unauthorized(callers[i], ADMIN_ROLE));
            agentVault.setExitFeeBps(1);
            vm.expectRevert(_unauthorized(callers[i], ADMIN_ROLE));
            agentVault.removeAsset(0);
            vm.expectRevert(_unauthorized(callers[i], ADMIN_ROLE));
            rmVault.setQuarantineAddress(callers[i]);
            vm.expectRevert(_unauthorized(callers[i], ADMIN_ROLE));
            registry.retire(address(agentVault));
            vm.expectRevert(_unauthorized(callers[i], ADMIN_ROLE));
            receipt.releaseReceipt(RECEIPT_ID);
            vm.expectRevert(_unauthorized(callers[i], ADMIN_ROLE));
            router.setQuarantineAddress(callers[i]);
            vm.expectRevert(_unauthorized(callers[i], ADMIN_ROLE));
            agentVault.addAsset(
                address(token), address(pool), 3000, address(0), BasketVault.Venue.V3
            );
            vm.expectRevert(_unauthorized(callers[i], ADMIN_ROLE));
            gateway.authorizeAgent(makeAddr("direct-agent"), p);
            vm.stopPrank();
        }
        // The Safe itself holds no role on any target: it can only reach them through the timelock.
        for (uint256 i = 0; i < governed.length; i++) {
            assertFalse(
                IAccessControl(governed[i]).hasRole(ADMIN_ROLE, address(safe)),
                "the Safe holds ADMIN directly, bypassing the timelock"
            );
        }
    }

    // ─── Handover: only the timelock holds ADMIN ─────────────────────────────

    /// @notice Replays every RoleGranted/RoleRevoked log since before construction (the contracts
    ///         are not enumerable). ADMIN_ROLE: the timelock is the only holder of each governed
    ///         contract, except that the router also lists RouterGovernance, which acts through
    ///         router.setWeights by design (R7). DEFAULT_ADMIN_ROLE: the timelock is the only
    ///         holder wherever the role exists.
    function test_noNonTimelockAddressHoldsAdminAfterHandover() public view {
        for (uint256 i = 0; i < governed.length; i++) {
            address target = governed[i];
            address[] storage holders = adminHolders[target];
            bool isRouter = target == address(router);
            assertEq(holders.length, isRouter ? 2 : 1, "unexpected ADMIN holder count");
            for (uint256 j = 0; j < holders.length; j++) {
                bool allowed =
                    holders[j] == address(timelock) || (isRouter && holders[j] == address(gov));
                assertTrue(allowed, "a non-timelock address holds ADMIN");
            }
            assertTrue(IAccessControl(target).hasRole(ADMIN_ROLE, address(timelock)));
            assertFalse(IAccessControl(target).hasRole(ADMIN_ROLE, deployer));

            address[] storage roots = rootHolders[target];
            bool hasRoot = target == address(gateway) || target == address(icPolicy)
                || target == address(receipt);
            assertEq(roots.length, hasRoot ? 1 : 0, "unexpected DEFAULT_ADMIN holder count");
            for (uint256 j = 0; j < roots.length; j++) {
                assertEq(roots[j], address(timelock), "a non-timelock address holds DEFAULT_ADMIN");
            }
            assertFalse(IAccessControl(target).hasRole(DEFAULT_ADMIN_ROLE, deployer));
        }
    }

    /// @notice The Safe is the timelock's sole proposer, executor and canceller, the timelock is
    ///         its own sole admin, and the Safe is exactly 2-of-3.
    function test_timelockRolesAndSafeShape() public view {
        bytes32[3] memory safeRoles = [PROPOSER_ROLE, EXECUTOR_ROLE, CANCELLER_ROLE];
        for (uint256 i = 0; i < safeRoles.length; i++) {
            address[] storage h = timelockRoleHolders[safeRoles[i]];
            assertEq(h.length, 1, "timelock role must have exactly one holder");
            assertEq(h[0], address(safe), "the Safe must be the sole holder");
        }
        address[] storage admins = timelockRoleHolders[DEFAULT_ADMIN_ROLE];
        assertEq(admins.length, 1, "timelock DEFAULT_ADMIN must have exactly one holder");
        assertEq(admins[0], address(timelock), "the timelock must administer itself");

        assertEq(safe.getThreshold(), 2, "threshold must be exactly 2");
        address[] memory owners = safe.getOwners();
        assertEq(owners.length, 3, "the Safe must have exactly 3 owners");
        for (uint256 i = 0; i < 3; i++) {
            assertTrue(safe.isOwner(vm.addr(ownerPks[i])), "owner key is not a Safe owner");
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// @dev Schedule through the Safe, check Waiting, wait the full delay, execute through the Safe.
    function _govern(address target, bytes memory data, bytes32 salt) internal {
        bytes32 id = timelock.hashOperation(target, 0, data, bytes32(0), salt);
        _safeExec(address(timelock), _schedule(target, data, salt, MIN_DELAY));
        assertEq(
            uint256(timelock.getOperationState(id)),
            _state(TimelockController.OperationState.Waiting)
        );
        vm.warp(block.timestamp + MIN_DELAY);
        assertEq(
            uint256(timelock.getOperationState(id)), _state(TimelockController.OperationState.Ready)
        );
        _safeExec(
            address(timelock),
            abi.encodeCall(TimelockController.execute, (target, 0, data, bytes32(0), salt))
        );
        assertEq(
            uint256(timelock.getOperationState(id)), _state(TimelockController.OperationState.Done)
        );
    }

    /// @dev The normal Safe call (operation 0, two owner signatures) reverts with GS013.
    function _expectGS013(address to, bytes memory data) internal {
        bytes memory sigs = _twoSigs(to, data);
        vm.expectRevert(bytes("GS013"));
        safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
    }

    function _policy() internal returns (IGateway.AgentPolicy memory) {
        address[] memory none = new address[](0);
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: ONE_USDC,
            maxPerWindow: 10 * ONE_USDC,
            shareReceiver: makeAddr("share-receiver"),
            allowedDestinations: none,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: none
        });
    }

    function _schedule(address target, bytes memory data, bytes32 salt, uint256 delay)
        internal
        pure
        returns (bytes memory)
    {
        return
            abi.encodeCall(TimelockController.schedule, (target, 0, data, bytes32(0), salt, delay));
    }

    function _state(TimelockController.OperationState s) internal pure returns (uint256) {
        return uint256(s);
    }

    /// @dev TimelockUnexpectedOperationState(id, Ready): what execute raises on a non-Ready op.
    function _notReady(bytes32 id) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            TimelockController.TimelockUnexpectedOperationState.selector,
            id,
            bytes32(uint256(1) << uint8(TimelockController.OperationState.Ready))
        );
    }

    function _unauthorized(address account, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, account, role
        );
    }

    function _sortedPks() internal view returns (uint256[3] memory pks) {
        pks = ownerPks;
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = i + 1; j < 3; j++) {
                if (vm.addr(pks[j]) < vm.addr(pks[i])) (pks[i], pks[j]) = (pks[j], pks[i]);
            }
        }
    }

    function _safeTxHash(address to, bytes memory data) internal view returns (bytes32) {
        return _safeTxHashOp(to, data, 0);
    }

    function _safeTxHashOp(address to, bytes memory data, uint8 op)
        internal
        view
        returns (bytes32)
    {
        return safe.getTransactionHash(
            to, 0, data, op, 0, 0, 0, address(0), payable(address(0)), safe.nonce()
        );
    }

    function _sign(uint256 pk, bytes32 txHash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, txHash);
        return abi.encodePacked(r, s_, v);
    }

    /// @dev Two distinct owners' signatures (the two lowest addresses), ascending as Safe requires.
    function _twoSigs(address to, bytes memory data) internal view returns (bytes memory) {
        bytes32 txHash = _safeTxHash(to, data);
        uint256[3] memory pks = _sortedPks();
        return bytes.concat(_sign(pks[0], txHash), _sign(pks[1], txHash));
    }

    function _safeExec(address to, bytes memory data) internal {
        bytes memory sigs = _twoSigs(to, data);
        assertTrue(
            safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs),
            "safe.execTransaction failed"
        );
    }

    /// @dev Runs `target.call(data)` in the Safe's context (delegatecall to the probe) under two
    ///      owner signatures, and returns the call's success flag and raw revert data.
    function _probeSafe(address target, bytes memory data)
        internal
        returns (bool ok, bytes memory ret)
    {
        bytes memory wrapped = abi.encodeCall(SafeCallProbe.probe, (target, data));
        bytes32 txHash = _safeTxHashOp(address(probe), wrapped, 1);
        uint256[3] memory pks = _sortedPks();
        bytes memory sigs = bytes.concat(_sign(pks[0], txHash), _sign(pks[1], txHash));
        vm.recordLogs();
        assertTrue(
            safe.execTransaction(
                address(probe), 0, wrapped, 1, 0, 0, 0, address(0), payable(address(0)), sigs
            ),
            "probe tx failed"
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter == address(safe) && logs[i].topics.length == 2
                    && logs[i].topics[0] == keccak256("Probe(address,bool,bytes)")
            ) {
                return abi.decode(logs[i].data, (bool, bytes));
            }
        }
        revert("probe event not found");
    }
}
