// SPDX-License-Identifier: MIT
// Canonical: docs/technical/governance-decisions.md §3.2, §3.6, §3.7 — a receipt is applied, not voted on
// Canonical: docs/technical/governance-isomorphism.md — the test governance path is the production one
// Implements: issue #1698 — the weight setter applies a consensus receipt in one call; voting deleted
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {RouterGovernance} from "../RouterGovernance.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";
import {
    IConsensusRecommendationReceipt
} from "../gateway/interfaces/IConsensusRecommendationReceipt.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";

// ─── Test fixtures ────────────────────────────────────────────────────────────

/// @notice Minimal ERC-20 USDC mock (6 decimals) for the router.
contract MockUsdc is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Minimal ERC-4626-shaped vault mock.
contract MockGovVault is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable assetToken;

    constructor(address asset_) ERC20("Mock Vault Shares", "MVS") {
        assetToken = IERC20(asset_);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function totalAssets() external view returns (uint256) {
        return assetToken.balanceOf(address(this));
    }

    function previewDeposit(uint256 assets) external pure returns (uint256) {
        return assets;
    }

    /// @dev ERC-4626 `maxDeposit`: uncapped. The router skips a leg whose `maxDeposit` is 0 or
    ///      reverts (QA plan D4), so a router-leg mock must answer it.
    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        assetToken.safeTransferFrom(msg.sender, address(this), assets);
        shares = assets;
        _mint(receiver, shares);
    }

    /// @dev IRetirableVault deposit-halt stubs. MockGovVault has no registry
    ///      link, so these are no-ops that satisfy the interface without
    ///      reverting when the registry drives the pause/deposit-halt flag
    ///      (VaultRegistry.setVaultStatus calls retire()/unretire() on the
    ///      vault address when it has code).
    function retire() external {}

    function unretire() external {}
}

/// @notice Stand-in for the InvestmentCommitteePolicy role read the receipt
///         register makes: `hasRole(COMMITTEE_AGENT_ROLE, submitter)`.
contract MockCommitteePolicy {
    mapping(address => bool) public isMember;

    function setMember(address account, bool member) external {
        isMember[account] = member;
    }

    function hasRole(bytes32, address account) external view returns (bool) {
        return isMember[account];
    }
}

// ─── Shared topology ──────────────────────────────────────────────────────────

/// @dev The weight-setter topology stage 7 and stage 11 build: the weight setter
///      holds the router's ADMIN_ROLE and WEIGHT_SETTER_ROLE and the register's
///      ADMIN_ROLE, and points at the register. `govAdmin` is who holds the
///      weight setter's ADMIN_ROLE (the deployer before stage 11, the timelock
///      after it).
abstract contract RouterGovernanceFixture is SafeGovernance {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant WEIGHT_SETTER_ROLE = keccak256("WEIGHT_SETTER_ROLE");
    string internal constant PAYLOAD_URI = "https://robotmoney.net/api/swarm/receipts/session-1";

    MockUsdc internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RouterGovernance internal gov;
    ConsensusRecommendationReceipt internal register;
    MockCommitteePolicy internal policy;

    address internal routerAdmin = makeAddr("routerAdmin");
    address internal registryAdmin = makeAddr("registryAdmin");
    address internal receiptAdmin = makeAddr("receiptAdmin");
    address internal submitter = makeAddr("committee-submitter");
    address internal stranger = makeAddr("stranger");

    MockGovVault internal vaultA;
    MockGovVault internal vaultB;

    function _buildTopology(address govAdmin) internal {
        usdc = new MockUsdc();
        registry = new VaultRegistry(registryAdmin);
        vaultA = new MockGovVault(address(usdc));
        vaultB = new MockGovVault(address(usdc));
        vm.startPrank(registryAdmin);
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

        router = new PortfolioRouter(address(usdc), address(registry), routerAdmin);
        gov = new RouterGovernance(address(router), govAdmin);

        // Stage 7 (DeployRouterGovernance): the weight setter gets both router
        // roles and the deployer drops the setter.
        vm.startPrank(routerAdmin);
        router.grantRole(ADMIN_ROLE, address(gov));
        router.grantRole(WEIGHT_SETTER_ROLE, address(gov));
        router.revokeRole(WEIGHT_SETTER_ROLE, routerAdmin);
        vm.stopPrank();

        // The register. This test contract is its gateway, so `_record` writes
        // straight into it; the committee read goes to the mock policy.
        policy = new MockCommitteePolicy();
        policy.setMember(submitter, true);
        register = new ConsensusRecommendationReceipt(receiptAdmin, address(this), address(policy));

        // Stage 11: the weight setter can release (ADMIN_ROLE on the register)
        // and knows the register.
        vm.prank(receiptAdmin);
        register.grantRole(ADMIN_ROLE, address(gov));
        vm.prank(govAdmin);
        gov.setReceiptContract(address(register));
    }

    /// @dev Records `receiptId` with `digest` as the committee submitter would,
    ///      through the gateway (this contract).
    function _record(bytes32 receiptId, bytes32 digest) internal {
        register.recordReceipt(submitter, receiptId, digest, PAYLOAD_URI);
    }

    function _sixtyForty() internal view returns (address[] memory vaults, uint256[] memory bps) {
        vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        bps = new uint256[](2);
        bps[0] = 6_000;
        bps[1] = 4_000;
    }

    function _assertWeights(address[] memory vaults, uint256[] memory bps) internal view {
        (address[] memory gotVaults, uint256[] memory gotBps) = router.getWeights();
        assertEq(gotVaults.length, vaults.length, "weight vector length");
        for (uint256 i = 0; i < vaults.length; i++) {
            assertEq(gotVaults[i], vaults[i], "weight vector vault");
            assertEq(gotBps[i], bps[i], "weight vector bps");
        }
        (address[] memory effVaults, uint256[] memory effBps) = router.getEffectiveWeights();
        assertEq(effVaults.length, vaults.length, "effective vector length");
        for (uint256 i = 0; i < vaults.length; i++) {
            assertEq(effVaults[i], vaults[i], "effective vector vault");
            assertEq(effBps[i], bps[i], "effective vector bps");
        }
    }
}

// ─── RouterGovernanceTest: the weight setter, called by its admin ─────────────

contract RouterGovernanceTest is RouterGovernanceFixture {
    address internal govAdmin = makeAddr("govAdmin");

    bytes32 internal constant RECEIPT_ID = keccak256("receipt-1");
    bytes32 internal constant DIGEST = keccak256("payload-1");

    function setUp() public {
        _buildTopology(govAdmin);
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    function test_constructor_revertsOnZeroRouter() public {
        vm.expectRevert(RouterGovernance.ZeroAddress.selector);
        new RouterGovernance(address(0), govAdmin);
    }

    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(RouterGovernance.ZeroAddress.selector);
        new RouterGovernance(address(router), address(0));
    }

    function test_constructor_grantsSelfAdministeredAdminRole() public view {
        assertTrue(gov.hasRole(ADMIN_ROLE, govAdmin));
        assertEq(gov.getRoleAdmin(ADMIN_ROLE), ADMIN_ROLE, "ADMIN_ROLE administers itself");
        assertEq(address(gov.router()), address(router));
        assertEq(gov.BPS_DENOMINATOR(), 10_000);
    }

    function test_constructor_leavesTheRegisterUnset() public {
        RouterGovernance fresh = new RouterGovernance(address(router), govAdmin);
        assertEq(address(fresh.receiptContract()), address(0));
    }

    // ─── setReceiptContract ──────────────────────────────────────────────────

    function test_setReceiptContract_setsAndEmits() public {
        RouterGovernance fresh = new RouterGovernance(address(router), govAdmin);
        vm.expectEmit(address(fresh));
        emit RouterGovernance.ReceiptContractSet(address(0), address(register));
        vm.prank(govAdmin);
        fresh.setReceiptContract(address(register));
        assertEq(address(fresh.receiptContract()), address(register));
    }

    function test_setReceiptContract_revertsOnZeroAddress() public {
        vm.prank(govAdmin);
        vm.expectRevert(RouterGovernance.ZeroAddress.selector);
        gov.setReceiptContract(address(0));
    }

    function test_setReceiptContract_revertsOnAddressWithoutCode() public {
        vm.prank(govAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(RouterGovernance.ReceiptContractNotContract.selector, stranger)
        );
        gov.setReceiptContract(stranger);
    }

    function test_setReceiptContract_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, ADMIN_ROLE
            )
        );
        gov.setReceiptContract(address(register));
    }

    // ─── applyReceipt: the one call ──────────────────────────────────────────

    /// @notice One call releases the receipt and writes its vector: both halves
    ///         land, in one transaction, with the register, router and weight
    ///         setter events in that order.
    function test_applyReceipt_releasesAndSetsWeightsInOneTransaction() public {
        _record(RECEIPT_ID, DIGEST);
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        assertFalse(register.isReleased(RECEIPT_ID));
        assertFalse(router.votedWeightsActive());

        vm.expectEmit(address(register));
        emit IConsensusRecommendationReceipt.ReceiptReleased(
            RECEIPT_ID, address(gov), uint64(block.timestamp)
        );
        vm.expectEmit(address(router));
        emit PortfolioRouter.WeightsSet(vaults, bps);
        vm.expectEmit(address(gov));
        emit RouterGovernance.ReceiptApplied(RECEIPT_ID, DIGEST, vaults, bps);

        vm.prank(govAdmin);
        gov.applyReceipt(RECEIPT_ID, DIGEST, vaults, bps);

        assertTrue(register.isReleased(RECEIPT_ID), "receipt released");
        assertTrue(router.votedWeightsActive(), "applied vector routes");
        _assertWeights(vaults, bps);
        (address[] memory current, uint256[] memory currentBps) = gov.currentWeights();
        assertEq(current.length, 2);
        assertEq(currentBps[0], 6_000);
    }

    function test_applyReceipt_revertsForNonWeightSetter() public {
        _record(RECEIPT_ID, DIGEST);
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        address[3] memory callers = [stranger, routerAdmin, submitter];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector, callers[i], ADMIN_ROLE
                )
            );
            gov.applyReceipt(RECEIPT_ID, DIGEST, vaults, bps);
        }
        assertFalse(register.isReleased(RECEIPT_ID), "nothing released");
        assertFalse(router.votedWeightsActive(), "nothing routed");
    }

    function test_applyReceipt_revertsWhenRegisterUnset() public {
        RouterGovernance fresh = new RouterGovernance(address(router), govAdmin);
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        vm.prank(govAdmin);
        vm.expectRevert(RouterGovernance.ReceiptContractNotSet.selector);
        fresh.applyReceipt(RECEIPT_ID, DIGEST, vaults, bps);
    }

    function test_applyReceipt_revertsOnUnrecordedReceipt() public {
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        vm.prank(govAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(RouterGovernance.ReceiptNotRecorded.selector, RECEIPT_ID)
        );
        gov.applyReceipt(RECEIPT_ID, DIGEST, vaults, bps);
    }

    function test_applyReceipt_revertsOnReleasedReceipt() public {
        _record(RECEIPT_ID, DIGEST);
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        vm.prank(govAdmin);
        gov.applyReceipt(RECEIPT_ID, DIGEST, vaults, bps);

        // One operation per receipt: the second apply of the same id is refused.
        vm.prank(govAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(RouterGovernance.ReceiptAlreadyReleased.selector, RECEIPT_ID)
        );
        gov.applyReceipt(RECEIPT_ID, DIGEST, vaults, bps);
    }

    function test_applyReceipt_revertsOnReceiptReleasedElsewhere() public {
        _record(RECEIPT_ID, DIGEST);
        // The timelock-held ADMIN_ROLE on the register can still release directly
        // (the release-receipt row); a receipt released that way is not applicable.
        vm.prank(receiptAdmin);
        register.releaseReceipt(RECEIPT_ID);
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        vm.prank(govAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(RouterGovernance.ReceiptAlreadyReleased.selector, RECEIPT_ID)
        );
        gov.applyReceipt(RECEIPT_ID, DIGEST, vaults, bps);
        assertFalse(router.votedWeightsActive());
    }

    function test_applyReceipt_revertsOnDigestMismatch() public {
        _record(RECEIPT_ID, DIGEST);
        bytes32 wrong = keccak256("some-other-payload");
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        vm.prank(govAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                RouterGovernance.ReceiptDigestMismatch.selector, RECEIPT_ID, wrong, DIGEST
            )
        );
        gov.applyReceipt(RECEIPT_ID, wrong, vaults, bps);
        assertFalse(register.isReleased(RECEIPT_ID), "a mismatched digest releases nothing");
        assertFalse(router.votedWeightsActive(), "a mismatched digest routes nothing");
    }

    /// @notice A digest binds a vector but does not prove it is unique: the
    ///         router's duplicate check holds on the receipt path too (CS-5).
    function test_applyReceipt_revertsOnDuplicateVault() public {
        _record(RECEIPT_ID, DIGEST);
        address[] memory vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultA);
        uint256[] memory bps = new uint256[](2);
        bps[0] = 5_000;
        bps[1] = 5_000;
        vm.prank(govAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioRouter.DuplicateVault.selector, address(vaultA))
        );
        gov.applyReceipt(RECEIPT_ID, DIGEST, vaults, bps);
        assertFalse(register.isReleased(RECEIPT_ID), "a refused vector releases nothing");
    }

    function test_applyReceipt_revertsOnInvalidWeightSum_andReleasesNothing() public {
        _record(RECEIPT_ID, DIGEST);
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        bps[1] = 3_000; // 9 000
        vm.prank(govAdmin);
        vm.expectRevert(PortfolioRouter.InvalidWeightSum.selector);
        gov.applyReceipt(RECEIPT_ID, DIGEST, vaults, bps);
        assertFalse(register.isReleased(RECEIPT_ID), "release and weights are one operation");
    }

    function test_applyReceipt_revertsOnLengthMismatch() public {
        _record(RECEIPT_ID, DIGEST);
        (address[] memory vaults,) = _sixtyForty();
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;
        vm.prank(govAdmin);
        vm.expectRevert(PortfolioRouter.LengthMismatch.selector);
        gov.applyReceipt(RECEIPT_ID, DIGEST, vaults, bps);
    }

    /// @notice GOV-4 on the receipt path: a vector naming a paused vault is refused
    ///         by the router, and the receipt stays applicable for a later round.
    function test_applyReceipt_revertsOnPausedVault_andReleasesNothing() public {
        _record(RECEIPT_ID, DIGEST);
        vm.prank(registryAdmin);
        registry.setVaultStatus(address(vaultB), VaultRegistry.VaultStatus.DepositsPaused);
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        vm.prank(govAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioRouter.VaultNotActive.selector,
                address(vaultB),
                VaultRegistry.VaultStatus.DepositsPaused
            )
        );
        gov.applyReceipt(RECEIPT_ID, DIGEST, vaults, bps);
        assertFalse(register.isReleased(RECEIPT_ID));
        assertTrue(register.isRecorded(RECEIPT_ID), "the receipt is still recorded");
    }

    /// @notice Without the register's ADMIN_ROLE the weight setter cannot release,
    ///         so the whole call reverts: stage 11's grant is load-bearing.
    function test_applyReceipt_revertsWhenWeightSetterCannotRelease() public {
        _record(RECEIPT_ID, DIGEST);
        vm.prank(receiptAdmin);
        register.revokeRole(ADMIN_ROLE, address(gov));
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        vm.prank(govAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(gov), ADMIN_ROLE
            )
        );
        gov.applyReceipt(RECEIPT_ID, DIGEST, vaults, bps);
        assertFalse(router.votedWeightsActive());
    }

    /// @notice Without the router's WEIGHT_SETTER_ROLE (rotated away) the apply
    ///         reverts inside setWeights, and the release is rolled back with it.
    function test_applyReceipt_revertsWhenRotatedOut_andReleasesNothing() public {
        _record(RECEIPT_ID, DIGEST);
        // WEIGHT_SETTER_ROLE administers itself: the holder can give it up.
        vm.prank(address(gov));
        router.renounceRole(WEIGHT_SETTER_ROLE, address(gov));
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        vm.prank(govAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                address(gov),
                WEIGHT_SETTER_ROLE
            )
        );
        gov.applyReceipt(RECEIPT_ID, DIGEST, vaults, bps);
        assertFalse(register.isReleased(RECEIPT_ID), "release rolled back with the weights");
    }

    function test_applyReceipt_secondReceiptReplacesTheVector() public {
        _record(RECEIPT_ID, DIGEST);
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        vm.prank(govAdmin);
        gov.applyReceipt(RECEIPT_ID, DIGEST, vaults, bps);

        bytes32 second = keccak256("receipt-2");
        bytes32 secondDigest = keccak256("payload-2");
        _record(second, secondDigest);
        bps[0] = 2_500;
        bps[1] = 7_500;
        vm.prank(govAdmin);
        gov.applyReceipt(second, secondDigest, vaults, bps);
        assertTrue(register.isReleased(second));
        _assertWeights(vaults, bps);
    }

    // ─── Default vector and the emergency lever ──────────────────────────────

    function test_setDefaultWeights_forwardsToTheRouter() public {
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        vm.prank(govAdmin);
        gov.setDefaultWeights(vaults, bps);
        (address[] memory got, uint256[] memory gotBps) = router.getDefaultWeights();
        assertEq(got.length, 2);
        assertEq(got[0], address(vaultA));
        assertEq(gotBps[1], 4_000);
        assertFalse(router.votedWeightsActive(), "the default is not an applied vector");
    }

    function test_setDefaultWeights_revertsForNonAdmin() public {
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, ADMIN_ROLE
            )
        );
        gov.setDefaultWeights(vaults, bps);
    }

    function test_setDefaultWeights_rejectsDuplicateVaultThroughTheWeightSetter() public {
        address[] memory vaults = new address[](2);
        vaults[0] = address(vaultB);
        vaults[1] = address(vaultB);
        uint256[] memory bps = new uint256[](2);
        bps[0] = 5_000;
        bps[1] = 5_000;
        vm.prank(govAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioRouter.DuplicateVault.selector, address(vaultB))
        );
        gov.setDefaultWeights(vaults, bps);
    }

    function test_clearVotedWeights_returnsRoutingToTheDefault() public {
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        vm.prank(govAdmin);
        gov.setDefaultWeights(vaults, bps);
        _record(RECEIPT_ID, DIGEST);
        uint256[] memory applied = new uint256[](2);
        applied[0] = 1_000;
        applied[1] = 9_000;
        vm.prank(govAdmin);
        gov.applyReceipt(RECEIPT_ID, DIGEST, vaults, applied);
        assertTrue(router.votedWeightsActive());

        vm.prank(govAdmin);
        gov.clearVotedWeights();
        assertFalse(router.votedWeightsActive(), "applied vector cleared");
        (, uint256[] memory effBps) = router.getEffectiveWeights();
        assertEq(effBps[0], 6_000, "routing fell back to the default");
    }

    function test_clearVotedWeights_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, ADMIN_ROLE
            )
        );
        gov.clearVotedWeights();
    }

    // ─── No voting surface ───────────────────────────────────────────────────

    /// @notice Issue #1698: the deployed bytecode has no propose, vote, execute,
    ///         cancel, setVotingPower, quorum, voting period or execution delay.
    ///         A missing selector reverts with EMPTY data (the contract has no
    ///         fallback); a function that still existed would either succeed or
    ///         revert with a custom error, so the empty-data check is what
    ///         distinguishes "deleted" from "refused".
    function test_noVotingSurface() public {
        bytes[] memory gone = new bytes[](23);
        gone[0] = abi.encodeWithSignature(
            "propose(address[],uint256[])", new address[](0), new uint256[](0)
        );
        gone[1] = abi.encodeWithSignature("vote(uint256)", uint256(1));
        gone[2] = abi.encodeWithSignature("execute(uint256)", uint256(1));
        gone[3] = abi.encodeWithSignature("cancel(uint256)", uint256(1));
        gone[4] = abi.encodeWithSignature("setVotingPower(address,uint256)", stranger, uint256(1));
        gone[5] = abi.encodeWithSignature("votingPower(address)", stranger);
        gone[6] = abi.encodeWithSignature("getPastVotes(address,uint256)", stranger, uint256(0));
        gone[7] = abi.encodeWithSignature("hasVoted(uint256,address)", uint256(1), stranger);
        gone[8] = abi.encodeWithSignature("quorumThreshold()");
        gone[9] = abi.encodeWithSignature("votingPeriod()");
        gone[10] = abi.encodeWithSignature("executionDelay()");
        gone[11] = abi.encodeWithSignature("totalVotingPower()");
        gone[12] = abi.encodeWithSignature("currentProposalId()");
        gone[13] = abi.encodeWithSignature("cadenceParams()");
        gone[14] = abi.encodeWithSignature("activeProposal()");
        gone[15] = abi.encodeWithSignature("proposalState(uint256)", uint256(1));
        gone[16] = abi.encodeWithSignature("proposalVoteSnapshot(uint256)", uint256(1));
        gone[17] = abi.encodeWithSignature("setQuorumThreshold(uint256)", uint256(2));
        gone[18] = abi.encodeWithSignature("setVotingPeriod(uint64)", uint64(3600));
        gone[19] = abi.encodeWithSignature("setExecutionDelay(uint64)", uint64(3600));
        gone[20] = abi.encodeWithSignature("MIN_QUORUM_THRESHOLD()");
        gone[21] = abi.encodeWithSignature("MIN_VOTING_PERIOD()");
        gone[22] = abi.encodeWithSignature("MAX_HISTORY_BLOCKS()");
        for (uint256 i = 0; i < gone.length; i++) {
            vm.prank(govAdmin);
            (bool ok, bytes memory ret) = address(gov).call(gone[i]);
            assertFalse(ok, "a voting selector still answers");
            assertEq(ret.length, 0, "a voting selector still exists (it reverted with data)");
        }

        // The surface that remains answers.
        assertEq(address(gov.receiptContract()), address(register));
        assertEq(address(gov.router()), address(router));
        (address[] memory v,) = gov.currentWeights();
        assertEq(v.length, 0);
    }

    /// @notice The router keeps no voting surface either: no proposal, no quorum.
    function test_routerHasNoVotingSurface() public {
        bytes[] memory gone = new bytes[](3);
        gone[0] = abi.encodeWithSignature("quorumThreshold()");
        gone[1] = abi.encodeWithSignature("votingPower(address)", stranger);
        gone[2] = abi.encodeWithSignature("vote(uint256)", uint256(1));
        for (uint256 i = 0; i < gone.length; i++) {
            (bool ok, bytes memory ret) = address(router).call(gone[i]);
            assertFalse(ok);
            assertEq(ret.length, 0);
        }
    }
}

// ─── RouterGovernanceSafeTimelockTest: Safe -> timelock -> applyReceipt ───────

/// @notice The production route, with no vm.prank on any governed path: two of
///         three owners sign, the real SafeL2 proxy runs `execTransaction`, the
///         Safe schedules on the timelock, the delay passes, the Safe executes,
///         the timelock calls `applyReceipt`, and the weight setter releases the
///         receipt and sets the router weights in that one transaction.
contract RouterGovernanceSafeTimelockTest is RouterGovernanceFixture {
    uint256 internal constant DELAY = 2 days;

    address internal safe;
    TimelockController internal timelock;

    bytes32 internal constant RECEIPT_ID = keccak256("receipt-via-timelock");
    bytes32 internal constant DIGEST = keccak256("payload-via-timelock");

    function setUp() public {
        _installSafeSet();
        safe = _newDefaultSafe();
        timelock = _newGovTimelock(safe, DELAY);

        // Stage 7 and the register wiring with this contract as the deployer...
        _buildTopology(address(this));
        // ...then stage 11: the weight setter's ADMIN_ROLE moves to the timelock.
        gov.grantRole(ADMIN_ROLE, address(timelock));
        gov.revokeRole(ADMIN_ROLE, address(this));
        assertFalse(gov.hasRole(ADMIN_ROLE, address(this)), "deployer kept governance ADMIN_ROLE");
    }

    /// @notice The acceptance test of issue #1698: one scheduled call, executed
    ///         through the real Safe and timelock, leaves `isReleased` true and
    ///         the router weights equal to the vector. Before the delay nothing
    ///         moved; after it the operation cannot be replayed.
    function test_applyReceipt_setsWeightsInOneCall() public {
        _record(RECEIPT_ID, DIGEST);
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        bytes memory data =
            abi.encodeCall(RouterGovernance.applyReceipt, (RECEIPT_ID, DIGEST, vaults, bps));
        bytes32 salt = keccak256("apply-receipt-round-1");

        _govSchedule(safe, timelock, address(gov), data, salt, DELAY);
        assertFalse(register.isReleased(RECEIPT_ID), "scheduled, not released");
        assertFalse(router.votedWeightsActive(), "scheduled, not routed");
        _expectExecuteRefused(safe, timelock, address(gov), data, salt);

        vm.warp(block.timestamp + DELAY);
        vm.expectEmit(address(register));
        emit IConsensusRecommendationReceipt.ReceiptReleased(
            RECEIPT_ID, address(gov), uint64(block.timestamp)
        );
        vm.expectEmit(address(router));
        emit PortfolioRouter.WeightsSet(vaults, bps);
        vm.expectEmit(address(gov));
        emit RouterGovernance.ReceiptApplied(RECEIPT_ID, DIGEST, vaults, bps);
        _govExecute(safe, timelock, address(gov), data, salt);

        assertTrue(register.isReleased(RECEIPT_ID), "receipt released by the one call");
        assertTrue(router.votedWeightsActive(), "vector applied by the one call");
        _assertWeights(vaults, bps);

        // One operation per receipt: the timelock refuses the replay, and a fresh
        // round for the same id is refused by the weight setter itself.
        _expectExecuteRefused(safe, timelock, address(gov), data, salt);
        bytes32 salt2 = keccak256("apply-receipt-round-2");
        _govSchedule(safe, timelock, address(gov), data, salt2, DELAY);
        vm.warp(block.timestamp + DELAY);
        bytes memory exec =
            abi.encodeCall(timelock.execute, (address(gov), 0, data, bytes32(0), salt2));
        vm.expectRevert(bytes(GS013));
        _safeExecWith(
            safe,
            address(timelock),
            exec,
            _twoOwnerSignatures(_safeDigest(safe, address(timelock), exec))
        );
    }

    /// @notice The Safe calling the weight setter directly, with two real owner
    ///         signatures, is refused: only the timelock holds ADMIN_ROLE.
    function test_applyReceipt_directSafeCall_isRefused_exactReason() public {
        _record(RECEIPT_ID, DIGEST);
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        _expectDirectSafeCallRefused(
            safe,
            address(gov),
            abi.encodeCall(RouterGovernance.applyReceipt, (RECEIPT_ID, DIGEST, vaults, bps))
        );
        assertFalse(register.isReleased(RECEIPT_ID));
    }

    /// @notice A scheduled apply whose digest is not the recorded one fails at
    ///         execution: the Safe reports GS013, the receipt stays unreleased,
    ///         and no weight lands. The Safe records a new round instead.
    function test_applyReceipt_viaTimelock_digestMismatchReleasesNothing() public {
        _record(RECEIPT_ID, DIGEST);
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        bytes memory data = abi.encodeCall(
            RouterGovernance.applyReceipt, (RECEIPT_ID, keccak256("tampered-payload"), vaults, bps)
        );
        bytes32 salt = keccak256("apply-receipt-tampered");
        _govSchedule(safe, timelock, address(gov), data, salt, DELAY);
        vm.warp(block.timestamp + DELAY);

        bytes memory exec =
            abi.encodeCall(timelock.execute, (address(gov), 0, data, bytes32(0), salt));
        vm.expectRevert(bytes(GS013));
        _safeExecWith(
            safe,
            address(timelock),
            exec,
            _twoOwnerSignatures(_safeDigest(safe, address(timelock), exec))
        );

        assertFalse(register.isReleased(RECEIPT_ID), "nothing released");
        assertFalse(router.votedWeightsActive(), "nothing routed");
        assertFalse(
            timelock.isOperationDone(
                timelock.hashOperation(address(gov), 0, data, bytes32(0), salt)
            ),
            "operation not done"
        );
    }

    /// @notice The timelock cannot bypass the weight setter: it holds no
    ///         WEIGHT_SETTER_ROLE, so a scheduled router.setWeights fails.
    function test_timelockCannotCallSetWeightsDirectly() public {
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        bytes memory data = abi.encodeCall(PortfolioRouter.setWeights, (vaults, bps));
        bytes32 salt = keccak256("timelock-set-weights");
        _govSchedule(safe, timelock, address(router), data, salt, DELAY);
        vm.warp(block.timestamp + DELAY);
        bytes memory exec =
            abi.encodeCall(timelock.execute, (address(router), 0, data, bytes32(0), salt));
        vm.expectRevert(bytes(GS013));
        _safeExecWith(
            safe,
            address(timelock),
            exec,
            _twoOwnerSignatures(_safeDigest(safe, address(timelock), exec))
        );
        assertFalse(router.votedWeightsActive());
    }

    /// @notice The committee submitter that recorded the receipt holds no weight
    ///         authority, and the weight setter is no committee member (§3.4).
    function test_submitterAndWeightSetterAreDisjoint() public view {
        assertFalse(gov.hasRole(ADMIN_ROLE, submitter));
        assertFalse(router.hasRole(WEIGHT_SETTER_ROLE, submitter));
        assertFalse(router.hasRole(ADMIN_ROLE, submitter));
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), submitter));
        assertFalse(policy.isMember(address(gov)));
        assertFalse(policy.isMember(address(timelock)));
        assertFalse(policy.isMember(safe));
    }
}
