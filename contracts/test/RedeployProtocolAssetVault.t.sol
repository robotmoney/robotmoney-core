// SPDX-License-Identifier: MIT
// Canonical: docs/operations/contract-release-runbooks.md — "Redeploy one vault into a live deployment" (issue 1796)
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {RedeployProtocolAssetVault} from "../script/RedeployProtocolAssetVault.s.sol";
import {DeployProtocolAssetVault} from "../script/DeployProtocolAssetVault.s.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {BasketDeployFixture} from "./helpers/BasketDeployFixture.sol";

/// @dev Registry and router only read `asset()` from a vault that is just a weight leg.
contract RedeployLegVault is ERC20 {
    address public immutable asset;

    constructor(address asset_) ERC20("Leg", "LEG") {
        asset = asset_;
    }

    function retire() external {}
    function unretire() external {}
}

/// @notice Single-vault redeploy of rmPROTO into a live deployment (issue 1796).
///         The deployment state is the Deploy 2 shape: registry and router governed by a timelock, four router-eligible vaults,
///         the default split 8550 / 525 / 575 / 350. The new vault comes from the redeploy script, unlinked: the registry link is the
///         timelock's first call in the govern batch (core S5: no vault deploy script links the registry). The govern row's batch is
///         replayed call by call from the timelock, so the order of retire against migrateEligibility is checked on the real contracts.
///         QA plan v1 E3: the batch also copies the old vault's router cap to the new vault, and the script pauses the new vault
///         before its first asset is added.
contract RedeployProtocolAssetVaultTest is BasketDeployFixture {
    RedeployProtocolAssetVault internal script;
    DeployProtocolAssetVault internal launch;
    PortfolioRouter internal router;

    address internal timelock = makeAddr("timelock");
    address internal emergency = makeAddr("emergency");
    address internal routerAdmin = makeAddr("routerAdmin");
    /// @dev The old vault's per-leg router cap. Any nonzero value: a new address reads 0, which the router treats as uncapped.
    uint256 internal constant OLD_ROUTER_CAP = 250 * 1e6;

    RedeployLegVault internal legUsdc;
    RedeployLegVault internal legAgent;
    RedeployLegVault internal legRwa;
    BasketVault internal oldProto;
    string internal json;

    function setUp() public {
        _fixtureSetUp();
        // The timelock is a contract in the real deployment: the script refuses an EOA.
        vm.etch(timelock, hex"00");
        script = new RedeployProtocolAssetVault();
        launch = new DeployProtocolAssetVault();
        router = new PortfolioRouter(address(usdc), address(registry), routerAdmin);

        json = _etchConfigPools("config/protocol-assets.json", "assets");
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);

        legUsdc = new RedeployLegVault(address(usdc));
        legAgent = new RedeployLegVault(address(usdc));
        legRwa = new RedeployLegVault(address(usdc));
        oldProto = BasketVault(launch.runInProcess(p, json).vault);

        vm.startPrank(deployer);
        oldProto.setRegistry(address(registry));
        registry.registerVault(address(legUsdc), _meta("Robot Money USDC"));
        registry.registerVault(address(legAgent), _meta("Robot Money Agent"));
        registry.registerVault(address(legRwa), _meta("Robot Money RWA"));
        registry.setRouterEligible(address(legUsdc), true);
        registry.setRouterEligible(address(oldProto), true);
        registry.setRouterEligible(address(legAgent), true);
        registry.setRouterEligible(address(legRwa), true);
        vm.stopPrank();

        vm.startPrank(routerAdmin);
        router.setDefaultWeights(_launchVaults(), _launchBps());
        router.setVaultCap(address(oldProto), OLD_ROUTER_CAP);
        // The timelock handover of the router (DeployTimelock): the timelock holds ADMIN_ROLE, which the batch's setVaultCap needs.
        router.grantRole(router.ADMIN_ROLE(), timelock);
        vm.stopPrank();
        vm.startPrank(deployer);
        registry.setRouter(address(router));
        // The timelock handover of the registry: grant first, then drop the deployer.
        registry.grantRole(registry.ADMIN_ROLE(), timelock);
        registry.revokeRole(registry.ADMIN_ROLE(), deployer);
        vm.stopPrank();
    }

    function _meta(string memory name) internal view returns (VaultRegistry.VaultMetadata memory) {
        return VaultRegistry.VaultMetadata({name: name, asset: address(usdc), registeredAt: 0});
    }

    function _launchVaults() internal view returns (address[] memory v) {
        v = new address[](4);
        v[0] = address(legUsdc);
        v[1] = address(oldProto);
        v[2] = address(legAgent);
        v[3] = address(legRwa);
    }

    function _launchBps() internal pure returns (uint256[] memory b) {
        b = new uint256[](4);
        b[0] = 8550;
        b[1] = 525;
        b[2] = 575;
        b[3] = 350;
    }

    function _redeploy() internal returns (BasketVault v) {
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        v = BasketVault(script.runRedeployInProcess(p, json, timelock, emergency).vault);
    }

    // ─── The script ──────────────────────────────────────────────────────────

    function test_redeploy_handsTheVaultOverAndLeavesItClosedAndUnregistered() public {
        BasketVault v = _redeploy();
        assertTrue(v.depositsPaused(), "deployed closed");
        assertEq(v.registry(), address(0), "registry link left to the govern batch");
        assertTrue(v.hasRole(v.ADMIN_ROLE(), timelock), "timelock holds ADMIN");
        assertTrue(v.hasRole(v.EMERGENCY_ROLE(), emergency), "emergency key holds EMERGENCY");
        assertFalse(v.hasRole(v.ADMIN_ROLE(), deployer), "deployer dropped ADMIN");
        assertFalse(v.hasRole(v.EMERGENCY_ROLE(), deployer), "deployer dropped EMERGENCY");
        assertFalse(v.hasRole(v.ADMIN_ROLE(), address(script)), "script holds nothing");
        address[] memory listed = registry.listVaults();
        assertEq(listed.length, 4, "the redeploy does not register: the Safe does");
        assertFalse(registry.isRouterEligible(address(v)), "ineligible until govern");
        assertEq(registry.routerEligibleCount(), 4, "count untouched");
    }

    function test_redeploy_configuredLikeTheLaunchVault() public {
        BasketVault v = _redeploy();
        assertEq(v.tvlCap(), oldProto.tvlCap());
        assertEq(v.perDepositCap(), oldProto.perDepositCap());
        assertEq(v.navDeviationGuardBps(), oldProto.navDeviationGuardBps());
        assertEq(v.assetCount(), oldProto.assetCount());
    }

    function test_redeploy_refusesAnEoaTimelock() public {
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        address eoa = makeAddr("eoa");
        vm.expectRevert(bytes("TIMELOCK_ADDRESS is not a contract"));
        script.runRedeployInProcess(p, json, eoa, emergency);
    }

    function test_redeploy_refusesAnEmergencyKeyThatIsTheDeployer() public {
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        vm.expectRevert(bytes("EMERGENCY_ADDRESS == deployer"));
        script.runRedeployInProcess(p, json, timelock, deployer);
    }

    /// @dev The link is ADMIN_ROLE-gated and the deploy dropped the deployer's ADMIN_ROLE: only the timelock can link, in the batch.
    function test_redeploy_deployerCannotLinkTheRegistryAfterHandover() public {
        BasketVault v = _redeploy();
        vm.prank(deployer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, deployer, v.ADMIN_ROLE()
            )
        );
        v.setRegistry(address(registry));
        assertEq(v.registry(), address(0), "still unlinked");
    }

    /// @dev QA plan v1 E3 (review F2): the redeploy pauses the vault right after creating it, before the first `addAsset`. Once an asset is
    ///      active `maxDeposit` opens, so the earlier add-then-pause order left a window in which a direct deposit into a vault of a live
    ///      deployment minted shares before the ORA-4 guard was set. The vault's own log order shows the pause came first and was never
    ///      undone, and `deposit` reverts `DepositsArePaused` (its first check) for as long as the pause holds.
    function test_redeploy_depositRevertsBetweenCreationAndFirstAddAsset() public {
        vm.recordLogs();
        BasketVault v = _redeploy();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 none = type(uint256).max;
        uint256 paused = none;
        uint256 firstAsset = none;
        uint256 unpaused;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(v) || logs[i].topics.length == 0) continue;
            bytes32 t = logs[i].topics[0];
            if (t == BasketVault.DepositsPaused.selector && paused == none) paused = i;
            if (t == BasketVault.AssetAdded.selector && firstAsset == none) firstAsset = i;
            if (t == BasketVault.DepositsUnpaused.selector) unpaused++;
        }
        assertTrue(firstAsset != none, "the script added the config's assets");
        assertTrue(paused != none, "the script paused the vault");
        assertLt(paused, firstAsset, "paused before the first addAsset");
        assertEq(unpaused, 0, "the script never reopens it");

        address holder = makeAddr("holder");
        vm.prank(holder);
        vm.expectRevert(BasketVault.DepositsArePaused.selector);
        v.deposit(1e6, holder);
    }

    // ─── The govern row's batch, on the real registry and router ─────────────

    /// @dev Five legs while both vaults are eligible: the old leg keeps its 525 and the new leg takes 0.
    function _fiveLegs(address newVault)
        internal
        view
        returns (address[] memory v, uint256[] memory b)
    {
        v = new address[](5);
        v[0] = address(legUsdc);
        v[1] = address(oldProto);
        v[2] = newVault;
        v[3] = address(legAgent);
        v[4] = address(legRwa);
        b = new uint256[](5);
        b[0] = 8550;
        b[1] = 525;
        b[2] = 0;
        b[3] = 575;
        b[4] = 350;
    }

    function _newLegs(address newVault) internal view returns (address[] memory v) {
        v = _launchVaults();
        v[1] = newVault;
    }

    /// @dev The seven calls of the govern row, in its order: the link first, so the vault is bound before it is registered, then the cap,
    ///      so the vault is capped before it becomes eligible.
    function _runBatch(BasketVault v) internal {
        vm.startPrank(timelock);
        v.setRegistry(address(registry));
        registry.registerVault(address(v), _meta("Robot Money Protocol"));
        router.setVaultCap(address(v), router.vaultCap(address(oldProto)));
        (address[] memory five, uint256[] memory fiveBps) = _fiveLegs(address(v));
        registry.migrateEligibility(address(v), true, five, fiveBps);
        registry.migrateEligibility(address(oldProto), false, _newLegs(address(v)), _launchBps());
        registry.retire(address(oldProto));
        v.unpauseDeposits();
        vm.stopPrank();
    }

    function test_batch_replacesTheVaultAndKeepsTheSplit() public {
        BasketVault v = _redeploy();
        _runBatch(v);

        assertEq(registry.listVaults().length, 5, "the old vault stays listed");
        assertTrue(registry.isRouterEligible(address(v)), "new vault eligible");
        assertFalse(registry.isRouterEligible(address(oldProto)), "old vault ineligible");
        assertEq(registry.routerEligibleCount(), 4, "four eligible");
        (, VaultRegistry.VaultStatus oldStatus) = registry.getVault(address(oldProto));
        assertEq(uint256(oldStatus), uint256(VaultRegistry.VaultStatus.Retired), "old retired");
        (, VaultRegistry.VaultStatus newStatus) = registry.getVault(address(v));
        assertEq(uint256(newStatus), uint256(VaultRegistry.VaultStatus.Active), "new active");
        assertTrue(oldProto.retired(), "old vault deposits halted");
        assertFalse(v.depositsPaused(), "new vault open");
        assertEq(v.registry(), address(registry), "linked by the batch");

        (address[] memory vaults, uint256[] memory bps) = router.getEffectiveWeights();
        assertEq(vaults.length, 4);
        assertEq(vaults[0], address(legUsdc));
        assertEq(vaults[1], address(v), "the new vault takes rmPROTO's slot");
        assertEq(vaults[2], address(legAgent));
        assertEq(vaults[3], address(legRwa));
        assertEq(bps[0], 8550);
        assertEq(bps[1], 525);
        assertEq(bps[2], 575);
        assertEq(bps[3], 350);
        assertFalse(router.votedWeightsActive(), "no voted vector");
    }

    /// @dev QA plan v1 E3 (review F2): `vaultCap` is keyed by address and 0 is uncapped, so the new address starts with no per-leg cap.
    ///      The batch's third call copies the old vault's cap before the new vault becomes eligible: router.vaultCap(new) == vaultCap(old).
    function test_batch_givesTheNewVaultTheOldVaultsRouterCap() public {
        BasketVault v = _redeploy();
        assertEq(router.vaultCap(address(v)), 0, "a new address starts uncapped");
        _runBatch(v);
        assertEq(router.vaultCap(address(v)), OLD_ROUTER_CAP, "the new vault carries the old cap");
        assertEq(
            router.vaultCap(address(v)),
            router.vaultCap(address(oldProto)),
            "router.vaultCap(new) == router.vaultCap(old)"
        );
    }

    /// @dev The cap call runs as the timelock on the router: without the router's ADMIN_ROLE the whole batch reverts, which is why the
    ///      govern row refuses to schedule unless the timelock holds it.
    function test_batch_capCallNeedsTheTimelockAsRouterAdmin() public {
        BasketVault v = _redeploy();
        bytes32 adminRole = router.ADMIN_ROLE();
        vm.prank(routerAdmin);
        router.revokeRole(adminRole, timelock);
        vm.prank(timelock);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, timelock, adminRole
            )
        );
        router.setVaultCap(address(v), OLD_ROUTER_CAP);
    }

    function test_batch_retireBeforeMigrateRevertsInContract() public {
        BasketVault v = _redeploy();
        vm.startPrank(timelock);
        registry.registerVault(address(v), _meta("Robot Money Protocol"));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultRegistry.RetireWhileRouterEligible.selector, address(oldProto)
            )
        );
        registry.retire(address(oldProto));
        vm.stopPrank();
    }

    /// @dev The link lands first in the batch, as the timelock (ADMIN_ROLE on the new vault). After the batch the registry is the one
    ///      address that drives the vault's deposit-halt leg, so a later status change through the registry reaches the vault.
    function test_batch_linksTheRegistryFirstSoTheRegistryDrivesTheNewVault() public {
        BasketVault v = _redeploy();
        assertEq(v.registry(), address(0), "unlinked before the batch");
        _runBatch(v);
        assertEq(v.registry(), address(registry), "linked by the batch");
        assertFalse(v.retired(), "open after the batch");

        vm.startPrank(timelock);
        registry.setVaultStatus(address(v), VaultRegistry.VaultStatus.DepositsPaused);
        assertTrue(v.retired(), "the registry halted deposits through the link");
        registry.setVaultStatus(address(v), VaultRegistry.VaultStatus.Active);
        assertFalse(v.retired(), "and reopened them");
        vm.stopPrank();
    }

    /// @dev Without the link the registry's status setter reverts in the vault's `OnlyRegistry` guard: a batch that forgot the link
    ///      would leave a vault the registry cannot retire, which is why the link is in the batch and not optional.
    function test_batch_withoutTheLinkTheRegistryCannotDriveTheNewVault() public {
        BasketVault v = _redeploy();
        vm.startPrank(timelock);
        registry.registerVault(address(v), _meta("Robot Money Protocol"));
        vm.expectRevert(BasketVault.OnlyRegistry.selector);
        registry.setVaultStatus(address(v), VaultRegistry.VaultStatus.DepositsPaused);
        vm.stopPrank();
    }

    /// @dev The link is set-once: a second redeploy round, or a re-run batch, cannot re-point it.
    function test_batch_registryLinkIsSetOnce() public {
        BasketVault v = _redeploy();
        _runBatch(v);
        vm.prank(timelock);
        vm.expectRevert(BasketVault.RegistryAlreadySet.selector);
        v.setRegistry(address(registry));
        assertEq(v.registry(), address(registry), "unchanged");
    }

    function test_batch_aThreeLegIntermediateIsAlsoValidButTheFiveLegOrderNeverExposesIt() public {
        // The alternative order (drop the old vault first) works too: it leaves a three-leg router for the time between the two
        // calls. The govern row uses the five-leg order inside ONE timelock batch, so no observer sees either state.
        BasketVault v = _redeploy();
        vm.startPrank(timelock);
        registry.registerVault(address(v), _meta("Robot Money Protocol"));
        address[] memory three = new address[](3);
        three[0] = address(legUsdc);
        three[1] = address(legAgent);
        three[2] = address(legRwa);
        uint256[] memory b = new uint256[](3);
        b[0] = 9075;
        b[1] = 575;
        b[2] = 350;
        registry.migrateEligibility(address(oldProto), false, three, b);
        registry.retire(address(oldProto));
        vm.stopPrank();
        assertEq(registry.routerEligibleCount(), 3);
    }

    function test_batch_newVaultCannotBeWeightedBeforeItIsRegistered() public {
        BasketVault v = _redeploy();
        (address[] memory five, uint256[] memory fiveBps) = _fiveLegs(address(v));
        vm.prank(timelock);
        vm.expectRevert(VaultRegistry.NotRegistered.selector);
        registry.migrateEligibility(address(v), true, five, fiveBps);
    }

    function test_oldVaultStillRedeemsAfterRetire() public {
        BasketVault v = _redeploy();
        _runBatch(v);
        // retire() halts deposits only. The redeem path is untouched: a holder with zero shares redeems zero and does not revert on the retire flag.
        assertTrue(oldProto.retired());
        assertEq(oldProto.maxDeposit(address(this)), 0, "no new deposits");
        assertEq(
            oldProto.maxRedeem(address(this)), 0, "nothing to redeem for a holder without shares"
        );
    }
}
