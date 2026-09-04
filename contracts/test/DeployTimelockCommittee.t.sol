// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.9 — Consensus Recommendation Receipt Contract
// Implements: issue #1319 — DeployTimelock hands over ADMIN_ROLE and
//             DEFAULT_ADMIN_ROLE on InvestmentCommitteePolicy and
//             ConsensusRecommendationReceipt to the timelock (INV-3, extending
//             the one-ceremony rule of issue #1247 AC10 to these two contracts).
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {DeployTimelock} from "../script/DeployTimelock.s.sol";
import {MockHighThresholdSafe} from "./DeployTimelock.t.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @title DeployTimelockCommitteeTest
/// @notice Issue #1319: before this change, `DeployTimelock.s.sol` only handed
///         ADMIN_ROLE over to the timelock for the five core protocol
///         contracts, leaving InvestmentCommitteePolicy and
///         ConsensusRecommendationReceipt's ADMIN_ROLE/DEFAULT_ADMIN_ROLE on
///         an EOA after the "one ceremony" (#1247 AC10) — violating INV-3.
///         These tests exercise `runInProcessWithCommittee` and prove: (1) the
///         timelock ends up holding both roles on both contracts, (2) the
///         real deployer identity loses both roles, (3) a third-party role
///         holder that must survive the handover (the gateway's ADMIN_ROLE on
///         the IC policy, granted separately per docs/architecture.md §4.9)
///         is untouched, and (4) the ceremony fails loudly — never silently —
///         when the configured receipt admin does not match who is actually
///         authorized to run the handover.
///
///         In-process identity note (mirrors contracts/test/fv/DeployAssertions.t.sol):
///         when a test calls `script.runInProcessWithCommittee(...)` directly,
///         `msg.sender` INSIDE the script's own code is `address(this)` (the
///         test contract) — that is the value substituted wherever the script
///         revokes "from msg.sender" or defaults `receiptAdmin_ == address(0)`
///         to it. But when the script's internal code calls OUT to a target
///         contract (e.g. `icPolicy.grantRole(...)`), that target sees the
///         caller as `address(script)` (the script contract itself), because
///         the call originates from within the script's own code. So for a
///         grant/revoke round-trip to both succeed AND genuinely move a real
///         role, each committee contract here is constructed with
///         `address(this)` as its admin (matching the revoke-target identity)
///         AND separately grants `address(script)` the same roles (matching
///         the grant/revoke authority every one of the script's external
///         calls actually executes under).
contract DeployTimelockCommitteeTest is Test {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    address internal pauser = makeAddr("pauser");
    address internal safe;
    address internal emergency = makeAddr("emergency");
    /// @dev A genuinely independent receipt admin (issue #1319 amendment: the
    ///      receipt's admin is RECEIPT_ADMIN_ADDRESS, "not necessarily the
    ///      deployer"). Used only in the negative/loud-failure test.
    address internal independentReceiptAdmin = makeAddr("independentReceiptAdmin");

    TestERC20 internal usdc;
    RobotMoneyVault internal vault;
    RobotMoneyGateway internal gateway;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RouterGovernance internal governance;
    InvestmentCommitteePolicy internal icPolicy;

    DeployTimelock internal script;
    DeployTimelock.Deployed internal d;

    uint256 public constant MIN_DELAY = 2 days;

    function setUp() public {
        usdc = new TestERC20();
        script = new DeployTimelock();
        safe = address(new MockHighThresholdSafe());

        // The five core contracts: admin_ == address(script), matching
        // DeployTimelock.t.sol's convention (their revocation is already
        // covered there / in DeployAssertions.t.sol — not re-tested here).
        vault = new RobotMoneyVault(
            usdc, type(uint256).max, type(uint256).max, 0, safe, address(script), address(script)
        );
        gateway = new RobotMoneyGateway(usdc, vault, address(script), pauser, address(0));
        registry = new VaultRegistry(address(script));
        router = new PortfolioRouter(address(usdc), address(registry), address(script));
        governance = new RouterGovernance(address(router), address(script), 7 days, 1 days, 1);

        // InvestmentCommitteePolicy: admin_ == address(this) (this test
        // contract), so that DeployTimelock's `revokeRole(ADMIN_ROLE,
        // msg.sender)` — where msg.sender resolves to whichever address calls
        // runInProcessWithCommittee, i.e. this test contract — targets a real
        // holder. address(script) additionally needs the roles because that
        // is the identity every one of DeployTimelock's grant/revoke calls
        // actually executes as (see contract NatSpec above).
        icPolicy = new InvestmentCommitteePolicy(address(this), address(gateway));
        icPolicy.grantRole(ADMIN_ROLE, address(script));
        icPolicy.grantRole(DEFAULT_ADMIN_ROLE, address(script));
        // Gateway separately holds ADMIN_ROLE on the IC policy so it can
        // forward committeeRegister calls (DeployInvestmentCommitteePolicy's
        // wireGateway step) — grant it here to prove DeployTimelock leaves it
        // alone.
        icPolicy.grantRole(ADMIN_ROLE, address(gateway));
    }

    /// @dev Deploys the receipt contract with the given constructor admin and
    ///      runs the full seven-contract ceremony through
    ///      `runInProcessWithCommittee`.
    function _deployReceiptAndRun(address receiptConstructedAdmin, address receiptAdminArg)
        internal
        returns (ConsensusRecommendationReceipt receipts)
    {
        receipts = new ConsensusRecommendationReceipt(
            receiptConstructedAdmin, address(gateway), address(icPolicy)
        );
        if (receiptConstructedAdmin != address(script)) {
            // Grant address(script) the roles too (see contract NatSpec):
            // whoever constructs the receipt must also authorize the identity
            // DeployTimelock's grant/revoke calls actually execute as.
            vm.prank(receiptConstructedAdmin);
            receipts.grantRole(ADMIN_ROLE, address(script));
            vm.prank(receiptConstructedAdmin);
            receipts.grantRole(DEFAULT_ADMIN_ROLE, address(script));
        }
        d = script.runInProcessWithCommittee(
            address(vault),
            address(gateway),
            address(registry),
            address(router),
            address(governance),
            safe,
            emergency,
            MIN_DELAY,
            address(icPolicy),
            address(receipts),
            receiptAdminArg
        );
    }

    // ─── Positive: full handover ──────────────────────────────────────────────
    //
    // receipt constructed admin == address(this) (this test contract), and
    // receiptAdminArg == address(0) so DeployTimelock resolves the revoke
    // target to msg.sender — which, from inside the script, IS this test
    // contract (the actual caller of runInProcessWithCommittee below). This
    // exercises the address(0)-default path AND genuinely proves revocation.

    function test_timelock_holdsBothRolesOnICPolicy() public {
        _deployReceiptAndRun(address(this), address(0));
        assertTrue(
            icPolicy.hasRole(ADMIN_ROLE, address(d.timelock)), "timelock missing ADMIN_ROLE on IC"
        );
        assertTrue(
            icPolicy.hasRole(DEFAULT_ADMIN_ROLE, address(d.timelock)),
            "timelock missing DEFAULT_ADMIN_ROLE on IC"
        );
    }

    function test_deployer_noLongerHasRolesOnICPolicy() public {
        _deployReceiptAndRun(address(this), address(0));
        assertFalse(
            icPolicy.hasRole(ADMIN_ROLE, address(this)), "deployer still has ADMIN_ROLE on IC"
        );
        assertFalse(
            icPolicy.hasRole(DEFAULT_ADMIN_ROLE, address(this)),
            "deployer still has DEFAULT_ADMIN_ROLE on IC"
        );
    }

    /// @notice The gateway's ADMIN_ROLE on the IC policy — a second,
    ///         intentional holder unrelated to the deployer handover — must
    ///         survive untouched.
    function test_gateway_stillHasAdminRoleOnICPolicy_afterHandover() public {
        _deployReceiptAndRun(address(this), address(0));
        assertTrue(
            icPolicy.hasRole(ADMIN_ROLE, address(gateway)),
            "gateway lost its intentional ADMIN_ROLE on IC policy"
        );
    }

    function test_timelock_holdsBothRolesOnReceipt() public {
        ConsensusRecommendationReceipt receipts = _deployReceiptAndRun(address(this), address(0));
        assertTrue(
            receipts.hasRole(ADMIN_ROLE, address(d.timelock)),
            "timelock missing ADMIN_ROLE on receipt"
        );
        assertTrue(
            receipts.hasRole(DEFAULT_ADMIN_ROLE, address(d.timelock)),
            "timelock missing DEFAULT_ADMIN_ROLE on receipt"
        );
    }

    function test_deployer_noLongerHasRolesOnReceipt() public {
        ConsensusRecommendationReceipt receipts = _deployReceiptAndRun(address(this), address(0));
        assertFalse(
            receipts.hasRole(ADMIN_ROLE, address(this)), "deployer still has ADMIN_ROLE on receipt"
        );
        assertFalse(
            receipts.hasRole(DEFAULT_ADMIN_ROLE, address(this)),
            "deployer still has DEFAULT_ADMIN_ROLE on receipt"
        );
    }

    // ─── Positive: receiptAdmin_ passed explicitly (not the address(0) default) ─
    //
    // Mirrors the actual rehearsal/production case where RECEIPT_ADMIN_ADDRESS
    // is known and threaded through explicitly.

    function test_receiptAdminExplicit_handoverSucceeds() public {
        ConsensusRecommendationReceipt receipts = _deployReceiptAndRun(address(this), address(this));
        assertTrue(
            receipts.hasRole(ADMIN_ROLE, address(d.timelock)),
            "timelock missing ADMIN_ROLE on receipt (explicit-admin path)"
        );
        assertFalse(
            receipts.hasRole(ADMIN_ROLE, address(this)),
            "deployer still has ADMIN_ROLE on receipt (explicit-admin path)"
        );
    }

    // ─── Skip: icPolicy_ / consensusReceipt_ == address(0) is a no-op ─────────

    function test_zeroCommitteeAddresses_skipsHandover_fiveCoreStillWorks() public {
        d = script.runInProcessWithCommittee(
            address(vault),
            address(gateway),
            address(registry),
            address(router),
            address(governance),
            safe,
            emergency,
            MIN_DELAY,
            address(0), // icPolicy_ skipped
            address(0), // consensusReceipt_ skipped
            address(0)
        );
        assertTrue(
            IAccessControl(address(vault)).hasRole(ADMIN_ROLE, address(d.timelock)),
            "five-core handover must still work when committee addresses are unset"
        );
        // IC policy untouched: address(script) still holds both roles because
        // DeployTimelock was told to skip it.
        assertTrue(
            icPolicy.hasRole(ADMIN_ROLE, address(script)),
            "IC policy must be untouched when IC_POLICY_ADDRESS is unset"
        );
    }

    // ─── Negative / loud-skip: mismatched receiptAdmin fails loudly ──────────
    //
    // The receipt is constructed with `independentReceiptAdmin` (issue #1319
    // amendment: "not necessarily the deployer"), and NEITHER this test
    // contract NOR address(script) is ever granted a role on it. DeployTimelock
    // always executes its grant/revoke calls as address(script) (see contract
    // NatSpec), so the handover's first grantRole call on the receipt must
    // revert — proving the ceremony never silently no-ops or partially
    // succeeds when misconfigured.
    function test_receiptAdmin_notAuthorized_revertsLoudly() public {
        ConsensusRecommendationReceipt receipts = new ConsensusRecommendationReceipt(
            independentReceiptAdmin, address(gateway), address(icPolicy)
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                address(script),
                DEFAULT_ADMIN_ROLE
            )
        );
        script.runInProcessWithCommittee(
            address(vault),
            address(gateway),
            address(registry),
            address(router),
            address(governance),
            safe,
            emergency,
            MIN_DELAY,
            address(icPolicy),
            address(receipts),
            independentReceiptAdmin
        );
    }
}
