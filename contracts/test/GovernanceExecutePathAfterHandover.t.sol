// SPDX-License-Identifier: MIT
// Canonical: project-fusion.md §4.3 — Governance topology, three bodies
// Canonical: docs/technical/security-model.md §4 — Access control & admin
// Canonical: docs/technical/governance-isomorphism.md — the Safe is a real
//            2-of-3 SafeProxy on the canonical SafeL2 singleton (R5, R6, R9)
// Implements: fusion round-2 task R7 — the RouterGovernance weight path must
//             actually reach PortfolioRouter.setWeights on a FRESH deployment,
//             while the deployer EOA must not be able to call setWeights at all.
// Implements: issue #1698 — that path is applyReceipt, driven by the Safe through
//             the timelock; there is no voting.
// Implements: issue #1447 (QA plan v1 B6) — the recovery procedures of core 1788 (a quarantined,
//             excluded adapter) and core 1789 (a duplicate adapter) through the real Safe and
//             timelock, not through an impersonated admin
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

import {DeployRouterGovernance} from "../script/DeployRouterGovernance.s.sol";
import {DeployTimelock} from "../script/DeployTimelock.s.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {ConsensusRecommendationReceipt} from "../ConsensusRecommendationReceipt.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {MockUsdc, MockGovVault} from "./RouterGovernance.t.sol";
import {ISafe, ISafeProxyFactory, _ISafeSetup} from "./SafeIntegration.t.sol";
import {ForkSelect} from "./helpers/ForkSelect.sol";
import {NoYieldTestAdapter} from "./helpers/NoYieldTestAdapter.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";
import {GovernedUUPS} from "../lib/GovernedUUPS.sol";

/// @title GovernanceExecutePathAfterHandover
/// @notice R7's two halves, proved on one topology built the way the deploy
///         scripts build it — not on a hand-wired fixture.
///
///         Before this task, `DeployRouterGovernance` deployed the governance
///         contract and stopped. Nothing ever granted it the router's weight
///         role, so an approved weight change still reverted inside
///         `router.setWeights` — the approving body could approve and could not
///         act. Since issue 1698 the approved change is a Safe-scheduled
///         `applyReceipt` through the timelock. The only thing that
///         COULD move weights was the deployer EOA, which is exactly the
///         inversion §4.3 describes as the gap.
///
///         `DeployTimelock` then revokes the deployer's router `ADMIN_ROLE`,
///         so after a complete ceremony the honest end state is: governance
///         can act, the deployer cannot, and the timelock administers both.
///
/// @dev    Fork test. The Safe that drives the timelock is the one stage now
///         runs (issue #1447): a SafeProxy created through the canonical
///         SafeProxyFactory on the canonical SafeL2 singleton, 2-of-3, driven
///         by `execTransaction` with two owner signatures. Those contracts
///         exist only on a Base fork, so CI runs this file with
///         FORK_RPC_URL set to the Twin chain (a pinned lazy fork of real Base), like
///         SafeIntegration.t.sol. Unset, it skips with a named reason.
contract GovernanceExecutePathAfterHandoverTest is Test {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant WEIGHT_SETTER_ROLE = keccak256("WEIGHT_SETTER_ROLE");

    // ─── Scripts (the "deployer EOA" is the timelock script address) ─────────

    DeployRouterGovernance internal govScript;
    DeployTimelock internal timelockScript;

    /// @dev Every privileged role starts here. Inside `DeployTimelock`'s
    ///      internal calls the EVM records `msg.sender` as the script address,
    ///      so the script address IS the deployer EOA for this fixture.
    address internal deployer;

    // ─── Topology ────────────────────────────────────────────────────────────

    MockUsdc internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RouterGovernance internal gov;
    RobotMoneyVault internal vault;
    RobotMoneyGateway internal gateway;
    ConsensusRecommendationReceipt internal receipts;
    TimelockController internal timelock;

    MockGovVault internal vaultA;
    MockGovVault internal vaultB;

    // ─── The Safe (canonical Safe v1.4.1 on Base) ────────────────────────────

    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_SINGLETON_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    address internal constant SAFE_MULTISEND = 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526;
    /// @dev FallbackManager's handler slot: keccak256("fallback_manager.handler.address").
    bytes32 internal constant FALLBACK_HANDLER_STORAGE_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    /// @dev A real 2-of-3 Safe, the topology stage's ceremony creates: the
    ///      post-handover path is only proved if an actual quorum-enforcing
    ///      Safe can drive the timelock.
    ISafe internal safe;
    uint256[3] internal ownerPks;
    address internal emergency = makeAddr("emergency");
    address internal pauser = makeAddr("pauser");

    // Recommending body: receipt submitters, deliberately disjoint (INV-4).
    address internal agentAthena = makeAddr("submitter-athena");
    address internal agentWoon = makeAddr("submitter-woon");

    uint256 internal constant MIN_DELAY = 2 days;

    bytes32 internal constant RECEIPT_ID = keccak256("handover-receipt-1");
    bytes32 internal constant DIGEST = keccak256("handover canonical receipt bytes");

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (!ForkSelect.selectOrSkip(rpc)) return;

        timelockScript = new DeployTimelock();
        govScript = new DeployRouterGovernance();
        deployer = address(timelockScript);

        safe = _createSafe();
        // Issue 1808: every proxy (the governance stage's too) names the timelock the handover
        // deploys for this Safe.
        address upgradeTimelock = timelockScript.predictTimelock(address(safe), MIN_DELAY);
        CoreProxies.useUpgradeConfig(upgradeTimelock, GovernedUUPS.UpgradeMode.Upgradeable);
        govScript.setUpgradeConfig(upgradeTimelock, GovernedUUPS.UpgradeMode.Upgradeable);
        usdc = new MockUsdc();

        vault = CoreProxies.robotMoneyVault(
            usdc,
            type(uint256).max,
            type(uint256).max,
            0,
            address(safe), // feeRecipient
            deployer, // admin
            deployer // emergencyResponder
        );
        gateway = CoreProxies.robotMoneyGateway(usdc, vault, deployer, pauser, address(0));
        registry = CoreProxies.vaultRegistry(deployer);
        router = CoreProxies.portfolioRouter(address(usdc), address(registry), deployer);

        // Two weightable vaults, registered and router-eligible.
        vaultA = new MockGovVault(address(usdc));
        vaultB = new MockGovVault(address(usdc));
        vm.startPrank(deployer);
        registry.registerVault(
            address(vaultA),
            VaultRegistry.VaultMetadata({name: "Vault A", asset: address(usdc), registeredAt: 0})
        );
        registry.registerVault(
            address(vaultB),
            VaultRegistry.VaultMetadata({name: "Vault B", asset: address(usdc), registeredAt: 0})
        );
        registry.setRouterEligible(address(vaultA), true);
        registry.setRouterEligible(address(vaultB), true);
        vm.stopPrank();

        // The recommending body: receipt submitters. Separately administered; no weight authority.
        receipts = CoreProxies.consensusRecommendationReceipt(deployer);
        vm.startPrank(deployer);
        receipts.grantRole(receipts.RECEIPT_SUBMITTER_ROLE(), agentAthena);
        receipts.grantRole(receipts.RECEIPT_SUBMITTER_ROLE(), agentWoon);
        vm.stopPrank();

        // The deployment under test: the governance script.
        DeployRouterGovernance.Deployed memory d =
            govScript.runInProcessWith(deployer, address(router), address(receipts));
        gov = d.governance;

        // The handover ceremony: every ADMIN_ROLE moves to the timelock and is
        // revoked from the deployer EOA.
        // Call the script FROM the script's own address. `DeployTimelock`
        // revokes roles from `msg.sender` while its own external calls
        // originate from the script address; only when those two coincide does
        // the fixture model a real ceremony, where one EOA does both. (A test
        // that lets them differ revokes from an address that never held the
        // role, and the script's "deployer no longer has ADMIN_ROLE" requires
        // pass vacuously.)
        vm.prank(deployer);
        DeployTimelock.Deployed memory t = timelockScript.runInProcessWithReceipt(
            address(vault),
            address(registry),
            address(router),
            address(gov),
            address(safe),
            emergency,
            MIN_DELAY,
            DeployTimelock.ReceiptHandover({
                consensusReceipt: address(receipts), receiptAdmin: deployer
            }),
            DeployTimelock.SafeSpec({owners: _ownersOfSafe(), threshold: 2})
        );
        timelock = t.timelock;

        // A submitter records a receipt directly.
        vm.prank(agentAthena);
        receipts.recordReceipt(RECEIPT_ID, DIGEST, "https://example.invalid/r1");
    }

    // ─── Half 1: the approving body can act ──────────────────────────────────

    /// @notice The deploy script leaves governance able to call setWeights.
    function test_governanceHoldsRouterAdminRole() public view {
        assertTrue(
            IAccessControl(address(router)).hasRole(ADMIN_ROLE, address(gov)),
            "RouterGovernance cannot reach the router fallbacks: setDefaultWeights is dead on arrival"
        );
    }

    /// @notice `setWeights` is gated by WEIGHT_SETTER_ROLE: governance holds it,
    ///         the timelock, the deployer, the Safe, the pauser and the
    ///         emergency key do not.
    function test_onlyGovernanceHoldsWeightSetterRole() public view {
        IAccessControl r = IAccessControl(address(router));
        assertTrue(r.hasRole(WEIGHT_SETTER_ROLE, address(gov)), "governance lacks the setter");
        assertFalse(r.hasRole(WEIGHT_SETTER_ROLE, address(timelock)), "timelock holds the setter");
        assertFalse(r.hasRole(WEIGHT_SETTER_ROLE, deployer), "deployer holds the setter");
        assertFalse(r.hasRole(WEIGHT_SETTER_ROLE, address(safe)), "safe holds the setter");
        assertFalse(r.hasRole(WEIGHT_SETTER_ROLE, pauser), "pauser holds the setter");
        assertFalse(r.hasRole(WEIGHT_SETTER_ROLE, emergency), "emergency holds the setter");
    }

    /// @notice THE R7 regression: the Safe schedules `applyReceipt` on the
    ///         timelock (which holds the governance WEIGHT_SETTER_ROLE), the delay
    ///         elapses, and the execute releases the receipt and lands the
    ///         weights on the router.
    function test_applyReceiptReachesSetWeightsOnAFreshDeployment() public {
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        bytes memory data =
            abi.encodeCall(RouterGovernance.applyReceipt, (RECEIPT_ID, DIGEST, vaults, bps));
        bytes32 salt = keccak256("apply-receipt");

        _safeExec(
            address(timelock),
            abi.encodeCall(
                TimelockController.schedule, (address(gov), 0, data, bytes32(0), salt, MIN_DELAY)
            )
        );
        vm.warp(block.timestamp + MIN_DELAY + 1);
        _safeExec(
            address(timelock),
            abi.encodeCall(TimelockController.execute, (address(gov), 0, data, bytes32(0), salt))
        );

        assertTrue(receipts.isReleased(RECEIPT_ID), "receipt not released");
        (address[] memory appliedVaults, uint256[] memory appliedBps) = router.getWeights();
        assertEq(appliedVaults.length, 2, "no active weight vector on the router");
        assertEq(appliedVaults[0], address(vaultA));
        assertEq(appliedVaults[1], address(vaultB));
        assertEq(appliedBps[0], 6_000, "vault A weight not applied");
        assertEq(appliedBps[1], 4_000, "vault B weight not applied");
    }

    /// @notice After the handover the timelock alone holds the governance
    ///         WEIGHT_SETTER_ROLE, and RouterGovernance can release receipts.
    function test_timelockAloneAppliesReceipts() public view {
        assertEq(gov.getRoleMemberCount(WEIGHT_SETTER_ROLE), 1, "one applyReceipt caller");
        assertEq(gov.getRoleMember(WEIGHT_SETTER_ROLE, 0), address(timelock));
        assertTrue(
            IAccessControl(address(receipts))
                .hasRole(receipts.RECEIPT_RELEASER_ROLE(), address(gov)),
            "governance cannot release the receipt it applies"
        );
        assertFalse(
            IAccessControl(address(receipts)).hasRole(ADMIN_ROLE, address(gov)),
            "governance must not hold the receipt ADMIN_ROLE"
        );
        assertEq(address(gov.receipts()), address(receipts));
    }

    // ─── Half 2: the deployer EOA cannot ─────────────────────────────────────

    /// @notice After the ceremony a direct setWeights from the deployer EOA
    ///         reverts. This is the assertion the deploy script now makes too.
    function test_deployerEoaCannotCallSetWeightsDirectly() public {
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        vm.prank(deployer);
        vm.expectRevert();
        router.setWeights(vaults, bps);
    }

    function test_deployerEoaHasNoRouterAdminRole() public view {
        assertFalse(
            IAccessControl(address(router)).hasRole(ADMIN_ROLE, deployer),
            "deployer EOA still holds router ADMIN_ROLE"
        );
    }

    // ─── The timelock cannot bypass RouterGovernance ─────────────────────────

    /// @notice The Safe schedules and executes router.setWeights through the
    ///         timelock. The operation is ready and the Safe signs it with real
    ///         owner signatures (no vm.prank of the Safe), yet the router
    ///         rejects the timelock, so the execute fails and no weight lands.
    function test_timelockSetWeightsThroughRealSafeScheduleExecute_reverts() public {
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        bytes memory data = abi.encodeCall(PortfolioRouter.setWeights, (vaults, bps));
        bytes32 salt = keccak256("timelock-set-weights");

        _safeExec(
            address(timelock),
            abi.encodeCall(
                TimelockController.schedule, (address(router), 0, data, bytes32(0), salt, MIN_DELAY)
            )
        );
        vm.warp(block.timestamp + MIN_DELAY + 1);
        bytes32 opId = timelock.hashOperation(address(router), 0, data, bytes32(0), salt);
        assertTrue(timelock.isOperationReady(opId), "operation should be ready");

        // The Safe reports GS013 when the inner timelock call fails.
        _safeExecExpectRevert(
            address(timelock),
            abi.encodeCall(
                TimelockController.execute, (address(router), 0, data, bytes32(0), salt)
            ),
            bytes("GS013")
        );
        assertFalse(timelock.isOperationDone(opId), "operation must not be done");
        (address[] memory applied,) = router.getWeights();
        assertEq(applied.length, 0, "the timelock must not have set active weights");
    }

    /// @notice The same Safe -> Timelock path still reaches setDefaultWeights,
    ///         the fallback the timelock keeps through ADMIN_ROLE.
    function test_timelockSetDefaultWeightsThroughRealSafeScheduleExecute_succeeds() public {
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        bytes memory data = abi.encodeCall(PortfolioRouter.setDefaultWeights, (vaults, bps));
        bytes32 salt = keccak256("timelock-set-default-weights");

        _safeExec(
            address(timelock),
            abi.encodeCall(
                TimelockController.schedule, (address(router), 0, data, bytes32(0), salt, MIN_DELAY)
            )
        );
        vm.warp(block.timestamp + MIN_DELAY + 1);
        _safeExec(
            address(timelock),
            abi.encodeCall(TimelockController.execute, (address(router), 0, data, bytes32(0), salt))
        );

        (address[] memory defaults, uint256[] memory defaultBps) = router.getDefaultWeights();
        assertEq(defaults.length, 2, "default weights not set");
        assertEq(defaults[0], address(vaultA));
        assertEq(defaultBps[0], 6_000);
        assertEq(defaultBps[1], 4_000);
    }

    // ─── INV-4: the two bodies are disjoint ──────────────────────────────────

    /// @notice No receipt submitter holds any weight authority: not the
    ///         governance WEIGHT_SETTER_ROLE or ADMIN_ROLE, not the router's.
    function test_submittersHoldNoWeightAuthority() public view {
        address[2] memory agents = [agentAthena, agentWoon];
        for (uint256 i = 0; i < agents.length; i++) {
            assertFalse(gov.hasRole(WEIGHT_SETTER_ROLE, agents[i]), "agent can apply receipts");
            assertFalse(gov.hasRole(ADMIN_ROLE, agents[i]), "agent administers governance");
            assertFalse(
                IAccessControl(address(router)).hasRole(WEIGHT_SETTER_ROLE, agents[i]),
                "agent can set router weights"
            );
        }
    }

    // ─── The Safe ────────────────────────────────────────────────────────────

    /// @notice The Safe is the timelock's proposer, EXECUTOR_ROLE is open (address(0)),
    ///         and the Safe is a real 2-of-3: threshold and owner set read back from the Safe.
    function test_safeIsTheTimelockDriverAndIsTwoOfThree() public view {
        assertTrue(
            timelock.hasRole(timelock.PROPOSER_ROLE(), address(safe)), "safe is not a proposer"
        );
        assertTrue(
            timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)), "executor role is not open"
        );
        assertEq(safe.getThreshold(), 2, "safe threshold must be 2");
        assertEq(safe.getOwners().length, 3, "safe must have 3 owners");
        // The fallback handler setup() stored is the canonical one, and it and
        // MultiSend are real code on this fork (governance-isomorphism.md R2).
        assertEq(
            address(uint160(uint256(vm.load(address(safe), FALLBACK_HANDLER_STORAGE_SLOT)))),
            SAFE_FALLBACK_HANDLER,
            "safe fallback handler must be the canonical CompatibilityFallbackHandler"
        );
        assertGt(SAFE_FALLBACK_HANDLER.code.length, 0, "fallback handler has no code on this fork");
        assertGt(SAFE_MULTISEND.code.length, 0, "MultiSend has no code on this fork");
    }

    /// @notice One owner's signature cannot schedule anything (GS020), so no
    ///         single key drives governance (governance-isomorphism.md R10).
    function test_oneOwnerCannotDriveTheTimelock() public {
        bytes memory data = abi.encodeCall(
            TimelockController.schedule,
            (
                address(gov),
                0,
                abi.encodeCall(
                    RouterGovernance.setDefaultWeights, (new address[](0), new uint256[](0))
                ),
                bytes32(0),
                keccak256("one-owner"),
                MIN_DELAY
            )
        );
        bytes memory oneSig = _sign(_sortedOwnerPks()[0], _safeTxHash(address(timelock), data));

        vm.prank(makeAddr("intruder"));
        vm.expectRevert(bytes("GS020"));
        safe.execTransaction(
            address(timelock), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), oneSig
        );
    }

    // ─── Recovery procedures for core 1788 and core 1789 (issue #1447) ───────
    //
    // The 2026-10-12 security review exercised these recoveries with an impersonated admin
    // (vm.prank). Here every ADMIN_ROLE step takes the production route: the Safe schedules on
    // the timelock with two owner signatures, the delay passes, the Safe executes. The steps of
    // the EMERGENCY_ADDRESS key are direct calls from that key: in production it is a single hot
    // key (an EOA), so a call from it is the real path, not a stand-in for a quorum.

    NoYieldTestAdapter internal adapterA;
    NoYieldTestAdapter internal adapterB;
    address internal holder = makeAddr("recovery-holder");
    address internal latecomer = makeAddr("recovery-latecomer");
    uint256 internal constant HOLDER_DEPOSIT = 2_000e6;

    /// @notice core 1788, the documented recovery (`setAdapterAllowed` NatSpec). The Safe
    ///         quarantines a funded adapter through the timelock: its balance leaves NAV and
    ///         deposits close at once. The emergency key drains it into the exclusion record
    ///         (core 1820), which also pauses deposits. The Safe removes the empty entry and
    ///         reopens deposits in ONE timelock batch. The holder who stayed keeps the full
    ///         claim and nobody minted in between.
    function test_recovery1788_quarantineDrainRemoveReopenThroughSafeAndTimelock() public {
        _onboardTwoFundedAdapters();
        uint256 shares = vault.balanceOf(holder);
        uint256 inA = adapterA.totalAssets();
        bytes memory quarantine =
            abi.encodeCall(RobotMoneyVault.setAdapterAllowed, (address(adapterA), false));

        // No shortcut: neither the Safe on its own nor the deployer holds the vault's ADMIN_ROLE.
        _safeExecExpectRevert(address(vault), quarantine, bytes("GS013"));
        vm.prank(deployer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, deployer, ADMIN_ROLE
            )
        );
        vault.setAdapterAllowed(address(adapterA), false);

        // 1. Quarantine through the Safe and the timelock.
        _govVault(quarantine, keccak256("quarantine-a"));
        assertEq(vault.totalAssets(), HOLDER_DEPOSIT - inA, "the quarantined balance left NAV");
        assertEq(vault.maxDeposit(latecomer), 0, "deposits close while it stays active");
        usdc.mint(latecomer, 1_000e6);
        vm.startPrank(latecomer);
        usdc.approve(address(vault), 1_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626.ERC4626ExceededMaxDeposit.selector, latecomer, 1_000e6, 0
            )
        );
        vault.deposit(1_000e6, latecomer);
        vm.stopPrank();

        // 2. Drain: the emergency key pulls the quarantined balance into the exclusion record.
        vm.prank(emergency);
        vault.emergencyWithdrawAdapter(0);
        assertEq(adapterA.totalAssets(), 0, "drained");
        assertTrue(vault.depositsPaused(), "the drain pauses deposits");

        // 3. Remove the empty entry and reopen deposits: one timelock batch through the Safe.
        bytes[] memory p = new bytes[](2);
        p[0] = abi.encodeCall(RobotMoneyVault.removeAdapter, (0));
        p[1] = abi.encodeCall(RobotMoneyVault.unpauseDeposits, ());
        _govVaultBatch(p, keccak256("remove-a-and-reopen"));

        // 4. core 1820: the drained value sits in the exclusion record, not in NAV. The holder
        //    who stayed keeps the full claim: the shares plus the record claim.
        assertEq(vault.totalAssets(), HOLDER_DEPOSIT - inA, "the recovery stays out of NAV");
        assertApproxEqAbs(
            vault.convertToAssets(shares) + vault.exclusionLedger().claimable(1, holder),
            HOLDER_DEPOSIT,
            1,
            "full claim"
        );
        assertEq(vault.openExclusionOf(0), 0, "removing the entry closed the record");
        assertEq(vault.activeAdapterCount(), 1, "the quarantined entry is inactive");
        assertFalse(vault.depositsPaused(), "deposits unpaused");
        assertGt(vault.maxDeposit(latecomer), 0, "deposits reopen");
    }

    /// @notice core 1788, the ADMIN-only recovery: `adminRebalance` stays the explicit recovery
    ///         path for a quarantined adapter. ONE timelock batch through the Safe drains it into
    ///         the exclusion record (core 1820) and removes its entry, so the accounting repair
    ///         is atomic and needs no emergency key. The eligible adapter is untouched.
    function test_recovery1788_adminRebalanceDrainsAndRemovesInOneTimelockBatch() public {
        _onboardTwoFundedAdapters();
        uint256 shares = vault.balanceOf(holder);
        uint256 inB = adapterB.totalAssets();
        _govVault(
            abi.encodeCall(RobotMoneyVault.setAdapterAllowed, (address(adapterA), false)),
            keccak256("quarantine-a")
        );
        assertEq(vault.maxDeposit(latecomer), 0, "deposits close while it stays active");

        uint256[] memory drain = new uint256[](2);
        drain[1] = inB;
        bytes[] memory p = new bytes[](2);
        p[0] = abi.encodeCall(RobotMoneyVault.adminRebalance, (drain));
        p[1] = abi.encodeCall(RobotMoneyVault.removeAdapter, (0));
        _govVaultBatch(p, keccak256("drain-and-remove-a"));

        assertEq(adapterA.totalAssets(), 0, "drained");
        assertEq(adapterB.totalAssets(), inB, "the eligible adapter is untouched");
        // core 1820: the drain is credited to the exclusion record, not to NAV.
        assertEq(vault.totalAssets(), inB, "the recovery stays out of NAV");
        assertApproxEqAbs(
            vault.convertToAssets(shares) + vault.exclusionLedger().claimable(1, holder),
            HOLDER_DEPOSIT,
            1,
            "full claim"
        );
        assertGt(vault.maxDeposit(latecomer), 0, "no ineligible active adapter: deposits reopen");
    }

    /// @notice core 1788, recovery by restored eligibility: the Safe allows the adapter again
    ///         through the timelock and the excluded value returns to the holder who stayed.
    ///         Since core 1820 the restore realises the adapter's balance into the exclusion
    ///         record first, so the value reaches the holder as a record claim.
    function test_recovery1788_restoredEligibilityReturnsTheValueThroughSafeAndTimelock() public {
        _onboardTwoFundedAdapters();
        uint256 shares = vault.balanceOf(holder);
        uint256 inA = adapterA.totalAssets();
        _govVault(
            abi.encodeCall(RobotMoneyVault.setAdapterAllowed, (address(adapterA), false)),
            keccak256("quarantine-a")
        );
        assertApproxEqAbs(vault.convertToAssets(shares), HOLDER_DEPOSIT - inA, 1, "excluded");

        _govVault(
            abi.encodeCall(RobotMoneyVault.setAdapterAllowed, (address(adapterA), true)),
            keccak256("restore-a")
        );
        assertEq(adapterA.totalAssets(), 0, "the residual was realised into the record");
        assertEq(vault.totalAssets(), HOLDER_DEPOSIT - inA, "the restored entry re-enters empty");
        assertApproxEqAbs(
            vault.convertToAssets(shares) + vault.exclusionLedger().claimable(1, holder),
            HOLDER_DEPOSIT,
            1,
            "full claim"
        );
        assertGt(vault.maxDeposit(latecomer), 0, "deposits reopen");
    }

    /// @notice core 1789 through the production route: the Safe schedules a second `addAdapter`
    ///         for an address an active entry holds; after the delay the execute reverts
    ///         `AdapterAlreadyActive` (GS013 through the Safe). No duplicate entry exists to
    ///         repair, and NAV counts the balance once.
    function test_recovery1789_duplicateAddIsRefusedAtExecuteThroughSafeAndTimelock() public {
        _onboardTwoFundedAdapters();
        bytes memory dup = abi.encodeCall(RobotMoneyVault.addAdapter, (address(adapterA), 5_000));
        bytes32 salt = keccak256("duplicate-a");
        _safeExec(
            address(timelock),
            abi.encodeCall(
                TimelockController.schedule, (address(vault), 0, dup, bytes32(0), salt, MIN_DELAY)
            )
        );
        vm.warp(block.timestamp + MIN_DELAY + 1);

        // The exact reason, straight on the open-executor timelock.
        vm.expectRevert(
            abi.encodeWithSelector(RobotMoneyVault.AdapterAlreadyActive.selector, address(adapterA))
        );
        timelock.execute(address(vault), 0, dup, bytes32(0), salt);
        // Through the Safe the inner reason is hidden as GS013.
        _safeExecExpectRevert(
            address(timelock),
            abi.encodeCall(TimelockController.execute, (address(vault), 0, dup, bytes32(0), salt)),
            bytes("GS013")
        );

        assertEq(vault.adapterCount(), 2, "no duplicate entry");
        assertEq(vault.totalAssets(), HOLDER_DEPOSIT, "the balance is counted once");
    }

    /// @notice core 1789, the legal re-registration (review finding 2: drain, remove, re-add,
    ///         exercised through the actual governance path). The emergency key pauses deposits,
    ///         then ONE atomic timelock batch through the Safe drains the adapter to idle, removes
    ///         its entry, adds it again as a NEW entry, refills it and reopens deposits. The
    ///         balance is counted once throughout and the holder is paid at par. The new active
    ///         entry still refuses a duplicate.
    function test_recovery1789_drainRemoveReAddIsOneAtomicTimelockBatch() public {
        _onboardTwoFundedAdapters();
        uint256 shares = vault.balanceOf(holder);
        uint256 inA = adapterA.totalAssets();
        uint256 inB = adapterB.totalAssets();
        vm.prank(emergency);
        vault.pauseDeposits();

        uint256[] memory drain = new uint256[](2);
        drain[1] = inB;
        uint256[] memory refill = new uint256[](3);
        refill[1] = inB;
        refill[2] = inA;
        bytes[] memory p = new bytes[](5);
        p[0] = abi.encodeCall(RobotMoneyVault.adminRebalance, (drain));
        p[1] = abi.encodeCall(RobotMoneyVault.removeAdapter, (0));
        p[2] = abi.encodeCall(RobotMoneyVault.addAdapter, (address(adapterA), 10_000));
        p[3] = abi.encodeCall(RobotMoneyVault.adminRebalance, (refill));
        p[4] = abi.encodeCall(RobotMoneyVault.unpauseDeposits, ());
        _govVaultBatch(p, keccak256("re-register-a"));

        assertEq(vault.adapterCount(), 3, "the re-add appended a new entry");
        assertEq(vault.activeAdapterCount(), 2, "one active entry per address");
        assertEq(adapterA.totalAssets(), inA, "refilled");
        assertEq(vault.totalAssets(), HOLDER_DEPOSIT, "counted once");
        assertApproxEqAbs(vault.convertToAssets(shares), HOLDER_DEPOSIT, 1, "paid at par");
        assertFalse(vault.depositsPaused(), "deposits unpaused");

        bytes memory dup = abi.encodeCall(RobotMoneyVault.addAdapter, (address(adapterA), 10_000));
        bytes32 salt = keccak256("duplicate-a-after-re-add");
        _safeExec(
            address(timelock),
            abi.encodeCall(
                TimelockController.schedule, (address(vault), 0, dup, bytes32(0), salt, MIN_DELAY)
            )
        );
        vm.warp(block.timestamp + MIN_DELAY + 1);
        vm.expectRevert(
            abi.encodeWithSelector(RobotMoneyVault.AdapterAlreadyActive.selector, address(adapterA))
        );
        timelock.execute(address(vault), 0, dup, bytes32(0), salt);
    }

    /// @dev Two funded adapters onboarded through the Safe and the timelock in ONE batch (allow
    ///      both instances and their code hashes, add both at a 100 % cap), then a holder whose
    ///      deposit the vault routes across them.
    function _onboardTwoFundedAdapters() internal {
        adapterA = new NoYieldTestAdapter(address(usdc), address(vault));
        adapterB = new NoYieldTestAdapter(address(usdc), address(vault));
        bytes[] memory p = new bytes[](6);
        p[0] = abi.encodeCall(RobotMoneyVault.setAdapterAllowed, (address(adapterA), true));
        p[1] = abi.encodeCall(RobotMoneyVault.setAdapterAllowed, (address(adapterB), true));
        p[2] = abi.encodeCall(
            RobotMoneyVault.setAdapterCodeHashAllowed, (address(adapterA).codehash, true)
        );
        p[3] = abi.encodeCall(
            RobotMoneyVault.setAdapterCodeHashAllowed, (address(adapterB).codehash, true)
        );
        p[4] = abi.encodeCall(RobotMoneyVault.addAdapter, (address(adapterA), 10_000));
        p[5] = abi.encodeCall(RobotMoneyVault.addAdapter, (address(adapterB), 10_000));
        _govVaultBatch(p, keccak256("onboard-two-adapters"));

        usdc.mint(holder, HOLDER_DEPOSIT);
        vm.startPrank(holder);
        usdc.approve(address(vault), HOLDER_DEPOSIT);
        vault.deposit(HOLDER_DEPOSIT, holder);
        vm.stopPrank();
        assertGt(adapterA.totalAssets(), 0, "adapter A holds part of the deposit");
        assertGt(adapterB.totalAssets(), 0, "adapter B holds part of the deposit");
        assertEq(vault.totalAssets(), HOLDER_DEPOSIT, "NAV is the deposit");
    }

    /// @dev One vault ADMIN_ROLE call: Safe -> timelock.schedule, the delay, Safe -> execute.
    function _govVault(bytes memory data, bytes32 salt) internal {
        _safeExec(
            address(timelock),
            abi.encodeCall(
                TimelockController.schedule, (address(vault), 0, data, bytes32(0), salt, MIN_DELAY)
            )
        );
        vm.warp(block.timestamp + MIN_DELAY + 1);
        _safeExec(
            address(timelock),
            abi.encodeCall(TimelockController.execute, (address(vault), 0, data, bytes32(0), salt))
        );
    }

    /// @dev Several vault ADMIN_ROLE calls as ONE atomic timelock operation: Safe ->
    ///      scheduleBatch, the delay, Safe -> executeBatch.
    function _govVaultBatch(bytes[] memory payloads, bytes32 salt) internal {
        address[] memory targets = new address[](payloads.length);
        uint256[] memory values = new uint256[](payloads.length);
        for (uint256 i = 0; i < payloads.length; i++) {
            targets[i] = address(vault);
        }
        _safeExec(
            address(timelock),
            abi.encodeCall(
                TimelockController.scheduleBatch,
                (targets, values, payloads, bytes32(0), salt, MIN_DELAY)
            )
        );
        vm.warp(block.timestamp + MIN_DELAY + 1);
        _safeExec(
            address(timelock),
            abi.encodeCall(
                TimelockController.executeBatch, (targets, values, payloads, bytes32(0), salt)
            )
        );
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _sixtyForty() internal view returns (address[] memory vaults, uint256[] memory bps) {
        vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        bps = new uint256[](2);
        bps[0] = 6_000;
        bps[1] = 4_000;
    }

    /// @dev A 2-of-3 SafeProxy on SafeL2 through the canonical factory — the
    ///      same call the stage deploy makes through the Safe SDK.
    function _createSafe() internal returns (ISafe created) {
        ownerPks[0] = uint256(keccak256("handover-safe-owner-1"));
        ownerPks[1] = uint256(keccak256("handover-safe-owner-2"));
        ownerPks[2] = uint256(keccak256("handover-safe-owner-3"));
        address[] memory owners = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            owners[i] = vm.addr(ownerPks[i]);
        }
        bytes memory setup = abi.encodeCall(
            _ISafeSetup.setup,
            (owners, 2, address(0), "", SAFE_FALLBACK_HANDLER, address(0), 0, payable(address(0)))
        );
        created = ISafe(
            ISafeProxyFactory(SAFE_PROXY_FACTORY)
                .createProxyWithNonce(SAFE_SINGLETON_L2, setup, uint256(keccak256("handover-safe")))
        );
    }

    /// @dev The owners `_createSafe` set up, for DeployTimelock's SAFE_OWNERS check.
    function _ownersOfSafe() internal view returns (address[] memory owners) {
        owners = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            owners[i] = vm.addr(ownerPks[i]);
        }
    }

    /// @dev Owner keys ordered by owner address, ascending (Safe requirement).
    function _sortedOwnerPks() internal view returns (uint256[3] memory pks) {
        pks = ownerPks;
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = i + 1; j < 3; j++) {
                if (vm.addr(pks[j]) < vm.addr(pks[i])) (pks[i], pks[j]) = (pks[j], pks[i]);
            }
        }
    }

    function _safeTxHash(address to, bytes memory data) internal view returns (bytes32) {
        return safe.getTransactionHash(
            to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), safe.nonce()
        );
    }

    /// @dev One 65-byte (r, s, v) owner signature over a SafeTx digest.
    function _sign(uint256 pk, bytes32 txHash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, txHash);
        return abi.encodePacked(r, s_, v);
    }

    /// @dev Like `_safeExec`, but expects the Safe itself to revert. The digest and
    ///      signatures are built first so `expectRevert` binds to `execTransaction`.
    function _safeExecExpectRevert(address to, bytes memory data, bytes memory reason) internal {
        bytes32 txHash = _safeTxHash(to, data);
        uint256[3] memory pks = _sortedOwnerPks();
        bytes memory sigs = bytes.concat(_sign(pks[0], txHash), _sign(pks[1], txHash));
        vm.expectRevert(reason);
        safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
    }

    /// @dev execTransaction with the two lowest-address owners' signatures.
    function _safeExec(address to, bytes memory data) internal {
        bytes32 txHash = _safeTxHash(to, data);
        uint256[3] memory pks = _sortedOwnerPks();
        bytes memory sigs = bytes.concat(_sign(pks[0], txHash), _sign(pks[1], txHash));
        assertTrue(
            safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs),
            "safe.execTransaction failed"
        );
    }
}
