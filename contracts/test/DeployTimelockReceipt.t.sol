// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.9 — Consensus Recommendation Receipt Contract
// Implements: issue #1319 — DeployTimelock hands over ADMIN_ROLE and
//             DEFAULT_ADMIN_ROLE on ConsensusRecommendationReceipt to the timelock (INV-3).
//             Issue 1888 — RouterGovernance keeps only RECEIPT_RELEASER_ROLE there; the
//             timelock holds the receipt ADMIN_ROLE alone.
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {DeployTimelock} from "../script/DeployTimelock.s.sol";
import {SafeFixture} from "./helpers/SafeFixture.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {ConsensusRecommendationReceipt} from "../ConsensusRecommendationReceipt.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {RoleHolders} from "./helpers/RoleHolders.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";
import {GovernedUUPS} from "../lib/GovernedUUPS.sol";

/// @title DeployTimelockReceiptTest
/// @notice Issue #1319: `DeployTimelock.s.sol` hands ADMIN_ROLE and DEFAULT_ADMIN_ROLE on the
///         ConsensusRecommendationReceipt to the timelock (INV-3). Issue 1888: RouterGovernance holds
///         only the narrow RECEIPT_RELEASER_ROLE, never the receipt ADMIN_ROLE. These tests exercise
///         `runInProcessWithReceipt` and prove: (1) the timelock ends up holding both roles, (2) the
///         real deployer identity loses both roles, (3) the timelock is the ONLY ADMIN_ROLE holder
///         and governance holds the release role, (4) the ceremony fails loudly when the configured
///         receipt admin does not match who is actually authorized to run the handover, and (5) the
///         handover refuses a governance that still holds the receipt ADMIN_ROLE.
///
///         In-process identity note (mirrors contracts/test/fv/DeployAssertions.t.sol): when a test
///         calls `script.runInProcessWithReceipt(..., _fixtureSpec())` directly, `msg.sender` INSIDE
///         the script's own code is `address(this)` (the test contract). When the script calls OUT to
///         a target contract, that target sees `address(script)`. So the receipt is constructed with
///         `address(this)` as its admin AND separately grants `address(script)` the same roles.
contract DeployTimelockReceiptTest is SafeFixture {
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

    DeployTimelock internal script;
    DeployTimelock.Deployed internal d;

    uint256 public constant MIN_DELAY = 2 days;

    /// @dev When set, the ceremony runs with address(script) as `msg.sender`, which is what a
    ///      real `forge script --broadcast` run is: one address both sends the grants and is
    ///      the deployer the script revokes. The role-holder tests need it, because only then
    ///      does the revoke target the address that actually holds the roles.
    bool internal runAsDeployer;

    function setUp() public {
        // Record from before any contract exists so RoleHolders can list every ADMIN_ROLE holder.
        vm.recordLogs();
        usdc = new TestERC20();
        script = new DeployTimelock();
        _installSafeSet();
        safe = _newDefaultSafe();
        // Issue 1808: every proxy names the timelock the handover deploys for this Safe.
        CoreProxies.useUpgradeConfig(
            script.predictTimelock(safe, MIN_DELAY), GovernedUUPS.UpgradeMode.Upgradeable
        );

        // The five core contracts: admin_ == address(script), matching
        // DeployTimelock.t.sol's convention (their revocation is already
        // covered there / in DeployAssertions.t.sol — not re-tested here).
        vault = CoreProxies.robotMoneyVault(
            usdc, type(uint256).max, type(uint256).max, 0, safe, address(script), address(script)
        );
        gateway = CoreProxies.robotMoneyGateway(usdc, vault, address(script), pauser, address(0));
        registry = CoreProxies.vaultRegistry(address(script));
        // The router is built with this test contract as its first admin so the setup below
        // needs no prank of the script (issue #1644): `_wireGovernance` wires governance,
        // then hands every router role to address(script) and drops this contract's own,
        // which leaves the router exactly as a script-built one. Governance is built per
        // test, after the receipt register it releases receipts through (issue 1698).
        router = CoreProxies.portfolioRouter(address(usdc), address(registry), address(this));
    }

    /// @dev Build RouterGovernance against `receipts_` and mirror DeployRouterGovernance's
    ///      router ADMIN_ROLE and WEIGHT_SETTER_ROLE grants (R7), then hand every router
    ///      role to address(script).
    function _wireGovernance(address receipts_) internal {
        governance = CoreProxies.routerGovernance(address(router), receipts_, address(script));
        router.grantRole(keccak256("ADMIN_ROLE"), address(governance));
        router.grantRole(keccak256("WEIGHT_SETTER_ROLE"), address(governance));
        bytes32[4] memory routerRoles = [
            keccak256("ADMIN_ROLE"),
            keccak256("WEIGHT_SETTER_ROLE"),
            keccak256("WEIGHT_SETTER_ROTATOR_ROLE"),
            keccak256("WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE")
        ];
        for (uint256 i = 0; i < routerRoles.length; i++) {
            router.grantRole(routerRoles[i], address(script));
            router.revokeRole(routerRoles[i], address(this));
        }
    }

    /// @dev Deploys the receipt contract with the given constructor admin and
    ///      runs the full ceremony through `runInProcessWithReceipt`.
    function _deployReceiptAndRun(address receiptConstructedAdmin, address receiptAdminArg)
        internal
        returns (ConsensusRecommendationReceipt receipts)
    {
        receipts = CoreProxies.consensusRecommendationReceipt(receiptConstructedAdmin);
        if (receiptConstructedAdmin != address(script)) {
            // Grant address(script) the roles too (see contract NatSpec):
            // whoever constructs the receipt must also authorize the identity
            // DeployTimelock's grant/revoke calls actually execute as.
            vm.prank(receiptConstructedAdmin);
            receipts.grantRole(ADMIN_ROLE, address(script));
            vm.prank(receiptConstructedAdmin);
            receipts.grantRole(DEFAULT_ADMIN_ROLE, address(script));
        }
        // DeployRouterGovernance's narrow release grant: applyReceipt releases.
        _wireGovernance(address(receipts));
        bytes32 releaserRole = receipts.RECEIPT_RELEASER_ROLE();
        vm.prank(receiptConstructedAdmin);
        receipts.grantRole(releaserRole, address(governance));
        if (runAsDeployer) vm.prank(address(script));
        d = script.runInProcessWithReceipt(
            address(vault),
            address(registry),
            address(router),
            address(governance),
            safe,
            emergency,
            MIN_DELAY,
            DeployTimelock.ReceiptHandover({
                consensusReceipt: address(receipts), receiptAdmin: receiptAdminArg
            }),
            _fixtureSpec()
        );
    }

    // ─── Positive: full handover ──────────────────────────────────────────────
    //
    // receipt constructed admin == address(this) (this test contract), and
    // receiptAdminArg == address(0) so DeployTimelock resolves the revoke
    // target to msg.sender — which, from inside the script, IS this test
    // contract (the actual caller of runInProcessWithCommittee below). This
    // exercises the address(0)-default path AND genuinely proves revocation.

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

    // ─── The timelock is the only ADMIN_ROLE holder (issue #1644) ─────────────
    //
    // `hasRole` can only clear addresses the test thought to name. RoleHolders replays every
    // RoleGranted / RoleRevoked log since before the contracts were built, so an address nobody
    // named (the script contract, say) cannot hide.

    /// @dev Makes the deployer identity match a real broadcast: address(script) is the only deployer.
    function _becomeScriptDeployer() internal {
        runAsDeployer = true;
    }

    function test_timelockIsTheOnlyAdminRoleHolder_onTheReceipt() public {
        _becomeScriptDeployer();
        ConsensusRecommendationReceipt receipts = _deployReceiptAndRun(address(script), address(0));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // RouterGovernance holds only the narrow release role (issue 1888). The timelock alone
        // holds ADMIN_ROLE, so it alone can grant or revoke the submitter and release roles.
        address[] memory receiptAdmins = RoleHolders.holders(logs, address(receipts), ADMIN_ROLE);
        assertEq(receiptAdmins.length, 1, "receipt: the timelock alone holds ADMIN_ROLE");
        assertEq(receiptAdmins[0], address(d.timelock), "receipt: an unexpected ADMIN_ROLE holder");
        assertTrue(
            receipts.hasRole(receipts.RECEIPT_RELEASER_ROLE(), address(governance)),
            "governance holds the release role"
        );
        assertFalse(receipts.hasRole(ADMIN_ROLE, address(governance)), "governance holds no admin");
        address[] memory releasers =
            RoleHolders.holders(logs, address(receipts), receipts.RECEIPT_RELEASER_ROLE());
        assertEq(releasers.length, 1, "receipt: governance alone holds the release role");
        assertEq(releasers[0], address(governance));
    }

    /// @dev A deploy whose governance still holds the receipt ADMIN_ROLE (the v0.5.0 shape) is
    ///      refused by the handover's R7 check.
    function test_handoverRefusesGovernanceHoldingReceiptAdminRole() public {
        ConsensusRecommendationReceipt receipts =
            CoreProxies.consensusRecommendationReceipt(address(this));
        receipts.grantRole(ADMIN_ROLE, address(script));
        receipts.grantRole(DEFAULT_ADMIN_ROLE, address(script));
        _wireGovernance(address(receipts));
        receipts.grantRole(receipts.RECEIPT_RELEASER_ROLE(), address(governance));
        receipts.grantRole(ADMIN_ROLE, address(governance));
        vm.expectRevert(
            bytes("R7: RouterGovernance holds the receipt ADMIN_ROLE - only the timelock may")
        );
        script.runInProcessWithReceipt(
            address(vault),
            address(registry),
            address(router),
            address(governance),
            safe,
            emergency,
            MIN_DELAY,
            DeployTimelock.ReceiptHandover({
                consensusReceipt: address(receipts), receiptAdmin: address(0)
            }),
            _fixtureSpec()
        );
    }

    function test_timelockIsTheOnlyAdminRoleHolder_onTheVaultsSystemContracts() public {
        _becomeScriptDeployer();
        _deployReceiptAndRun(address(script), address(0));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        address[4] memory core =
            [address(vault), address(registry), address(router), address(governance)];
        for (uint256 i = 0; i < core.length; i++) {
            address[] memory admins = RoleHolders.holders(logs, core[i], ADMIN_ROLE);
            // The router's ADMIN_ROLE also stays with RouterGovernance (the approving body,
            // granted at deploy time and asserted by DeployTimelock R7). Every other core
            // contract has the timelock alone.
            bool isRouter = core[i] == address(router);
            assertEq(admins.length, isRouter ? 2 : 1, "no second admin");
            for (uint256 j = 0; j < admins.length; j++) {
                assertTrue(
                    admins[j] == address(d.timelock)
                        || (isRouter && admins[j] == address(governance)),
                    "an unexpected ADMIN_ROLE holder"
                );
            }
        }
    }

    // ─── Skip: consensusReceipt_ == address(0) is a no-op ─────────────────────

    function test_zeroReceiptAddress_skipsHandover_fiveCoreStillWorks() public {
        _wireGovernance(makeAddr("receipts"));
        d = script.runInProcessWithReceipt(
            address(vault),
            address(registry),
            address(router),
            address(governance),
            safe,
            emergency,
            MIN_DELAY,
            DeployTimelock.ReceiptHandover({
                consensusReceipt: address(0), receiptAdmin: address(0)
            }),
            _fixtureSpec()
        );
        assertTrue(
            IAccessControl(address(vault)).hasRole(ADMIN_ROLE, address(d.timelock)),
            "five-core handover must still work when the receipt address is unset"
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
        ConsensusRecommendationReceipt receipts =
            CoreProxies.consensusRecommendationReceipt(independentReceiptAdmin);
        _wireGovernance(address(receipts));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                address(script),
                DEFAULT_ADMIN_ROLE
            )
        );
        script.runInProcessWithReceipt(
            address(vault),
            address(registry),
            address(router),
            address(governance),
            safe,
            emergency,
            MIN_DELAY,
            DeployTimelock.ReceiptHandover({
                consensusReceipt: address(receipts), receiptAdmin: independentReceiptAdmin
            }),
            _fixtureSpec()
        );
    }
}
