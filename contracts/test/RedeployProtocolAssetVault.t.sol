// SPDX-License-Identifier: MIT
// Canonical: docs/operations/contract-release-runbooks.md — "Redeploy one vault into a live deployment" (issue 1796)
pragma solidity ^0.8.24;
import {Vm} from "forge-std/Vm.sol";

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

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

    /// @dev A leg that accepts a router deposit: pulls the USDC and mints one share per unit.
    function deposit(uint256 assets, address receiver) external returns (uint256) {
        ERC20(asset).transferFrom(msg.sender, address(this), assets);
        _mint(receiver, assets);
        return assets;
    }
}

/// @dev A broadcast that died after the deploy and the configuration and before the handover: only `_deployConfigured` ran.
contract InterruptedRedeploy is RedeployProtocolAssetVault {
    function deployOnly(Params memory p, string memory json) external returns (address vault) {
        Cfg memory cfg = _parseCfg(json, "assets");
        vm.startPrank(p.admin);
        vault = _deployConfigured(p, cfg).vault;
        vm.stopPrank();
    }
}

/// @notice Single-vault redeploy of rmPROTO into a live deployment (issue 1796).
///         The deployment state is the Deploy 2 shape: registry and router governed by a timelock, four router-eligible vaults,
///         the default split 8550 / 525 / 575 / 350. The new vault comes from the redeploy script. The govern row's batch is
///         replayed call by call from the timelock, so the order of retire against migrateEligibility is checked on the real contracts.
contract RedeployProtocolAssetVaultTest is BasketDeployFixture, SafeGovernance {
    RedeployProtocolAssetVault internal script;
    DeployProtocolAssetVault internal launch;
    PortfolioRouter internal router;

    address internal timelock;
    TimelockController internal governor;
    address internal committee;
    uint256 internal constant DELAY = 1800;
    address internal emergency = makeAddr("emergency");
    address internal routerAdmin = makeAddr("routerAdmin");

    RedeployLegVault internal legUsdc;
    RedeployLegVault internal legAgent;
    RedeployLegVault internal legRwa;
    BasketVault internal oldProto;
    string internal json;

    function setUp() public {
        _fixtureSetUp();
        // The timelock is a contract in the real deployment: the script refuses an EOA.
        _installSafeSet();
        committee = _newDefaultSafe();
        governor = _newGovTimelock(committee, DELAY);
        timelock = address(governor);
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

        vm.prank(routerAdmin);
        router.setDefaultWeights(_launchVaults(), _launchBps());
        vm.startPrank(deployer);
        registry.setRouter(address(router));
        // The timelock handover of the registry: grant first, then drop the deployer.
        registry.grantRole(registry.ADMIN_ROLE(), timelock);
        registry.revokeRole(registry.ADMIN_ROLE(), deployer);
        vm.stopPrank();
        vm.startPrank(routerAdmin);
        router.setVaultCap(address(oldProto), 525000);
        router.grantRole(router.ADMIN_ROLE(), timelock);
        router.revokeRole(router.ADMIN_ROLE(), routerAdmin);
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
        assertEq(v.registry(), address(registry), "registry linked");
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

    function test_redeploy_pausePrecedesFirstActiveAsset() public {
        vm.recordLogs();
        BasketVault v = _redeploy();
        Vm.Log[] memory events = vm.getRecordedLogs();
        bool paused;
        bool assetSeen;
        for (uint256 i; i < events.length; i++) {
            if (events[i].emitter != address(v)) continue;
            if (events[i].topics[0] == keccak256("DepositsPaused(address)")) paused = true;
            if (
                events[i].topics[0]
                    == keccak256("AssetAdded(uint256,address,address,uint24,address,uint8)")
            ) {
                assertTrue(paused, "active asset configured before pause");
                assetSeen = true;
            }
        }
        // Asset count makes the assertion meaningful even if the event signature changes.
        assertGt(v.assetCount(), 0);
        assertTrue(paused);
        assertTrue(assetSeen, "asset-add events must be covered");
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

    function _batch(BasketVault v)
        internal
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory data)
    {
        targets = new address[](6);
        values = new uint256[](6);
        data = new bytes[](6);
        targets[0] = address(registry);
        targets[1] = address(router);
        targets[2] = address(registry);
        targets[3] = address(registry);
        targets[4] = address(registry);
        targets[5] = address(v);
        (address[] memory five, uint256[] memory fiveBps) = _fiveLegs(address(v));
        data[0] =
            abi.encodeCall(registry.registerVault, (address(v), _meta("Robot Money Protocol")));
        data[1] = abi.encodeCall(router.setVaultCap, (address(v), uint256(525000)));
        data[2] = abi.encodeCall(registry.migrateEligibility, (address(v), true, five, fiveBps));
        data[3] = abi.encodeCall(
            registry.migrateEligibility,
            (address(oldProto), false, _newLegs(address(v)), _launchBps())
        );
        data[4] = abi.encodeCall(registry.retire, (address(oldProto)));
        data[5] = abi.encodeCall(v.unpauseDeposits, ());
    }

    function _schedule(BasketVault v, bytes32 salt) internal returns (bytes32 id) {
        (address[] memory targets, uint256[] memory values, bytes[] memory data) = _batch(v);
        assertTrue(
            _safeExec(
                committee,
                timelock,
                abi.encodeCall(
                    governor.scheduleBatch, (targets, values, data, bytes32(0), salt, DELAY)
                )
            )
        );
        return governor.hashOperationBatch(targets, values, data, bytes32(0), salt);
    }

    function _execute(BasketVault v, bytes32 salt) internal {
        (address[] memory targets, uint256[] memory values, bytes[] memory data) = _batch(v);
        governor.executeBatch(targets, values, data, bytes32(0), salt);
    }

    function _runBatch(BasketVault v) internal {
        _schedule(v, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        _execute(v, bytes32(0));
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

    function test_batch_quorumDelayCancellationReplay() public {
        BasketVault v = _redeploy();
        (address[] memory targets, uint256[] memory values, bytes[] memory data) = _batch(v);
        bytes memory schedule = abi.encodeCall(
            governor.scheduleBatch, (targets, values, data, bytes32(0), bytes32(0), DELAY)
        );
        bytes memory oneSignature = _oneOwnerSignature(_safeDigest(committee, timelock, schedule));
        vm.expectRevert(bytes("GS020"));
        _safeExecWith(committee, timelock, schedule, oneSignature);
        bytes32 id = _schedule(v, bytes32(0));
        vm.expectRevert();
        _execute(v, bytes32(0));
        _govCancel(committee, governor, id);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert();
        _execute(v, bytes32(0));
        _schedule(v, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        _execute(v, bytes32(0));
        assertTrue(governor.isOperationDone(id));
        vm.expectRevert();
        _execute(v, bytes32(0));
    }

    function test_batch_revertAtEveryCallRestoresAllState() public {
        BasketVault v = _redeploy();
        (address[] memory targets,, bytes[] memory data) = _batch(v);
        bytes32 id = _schedule(v, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        for (uint256 i; i < targets.length; i++) {
            vm.mockCallRevert(targets[i], data[i], bytes("injected failure"));
            vm.expectRevert();
            _execute(v, bytes32(0));
            vm.clearMockedCalls();
            assertFalse(governor.isOperationDone(id));
            assertEq(registry.listVaults().length, 4);
            assertEq(registry.routerEligibleCount(), 4);
            assertTrue(registry.isRouterEligible(address(oldProto)));
            assertFalse(registry.isRouterEligible(address(v)));
            assertFalse(oldProto.retired());
            assertTrue(v.depositsPaused());
            assertEq(router.vaultCap(address(v)), 0);
            (address[] memory legs, uint256[] memory weights) = router.getEffectiveWeights();
            assertEq(legs, _launchVaults());
            assertEq(weights, _launchBps());
        }
        _execute(v, bytes32(0));
        assertEq(router.vaultCap(address(v)), 525000);
    }

    function test_oldVaultStillRedeemsAfterRetire() public {
        BasketVault v = _redeploy();
        address holder = makeAddr("old holder");
        deal(address(oldProto), holder, 1_000e18, true);
        uint256 supplyBefore = oldProto.totalSupply();
        _runBatch(v);
        // Registered, retired and ineligible: the old vault is still listed with its history.
        assertTrue(oldProto.retired());
        (, VaultRegistry.VaultStatus st) = registry.getVault(address(oldProto));
        assertEq(uint256(st), uint256(VaultRegistry.VaultStatus.Retired));
        assertFalse(registry.isRouterEligible(address(oldProto)));
        address[] memory listed = registry.listVaults();
        bool found;
        for (uint256 i; i < listed.length; i++) {
            if (listed[i] == address(oldProto)) found = true;
        }
        assertTrue(found, "still listed");
        // Old shares are not moved by the cutover.
        assertEq(oldProto.balanceOf(holder), 1_000e18, "holder shares untouched");
        assertEq(oldProto.totalSupply(), supplyBefore, "supply untouched");
        // Retirement stops deposits only. The holder still exits in kind and the shares burn.
        assertEq(oldProto.maxDeposit(holder), 0, "no new deposits");
        assertEq(oldProto.maxRedeem(holder), 1_000e18, "redeem stays open");
        vm.expectEmit(true, true, false, true, address(oldProto));
        emit BasketVault.RedeemedInKind(holder, holder, 400e18);
        vm.prank(holder);
        oldProto.redeemInKind(400e18, holder, holder);
        assertEq(
            oldProto.balanceOf(holder), 600e18, "in-kind exit burned the shares after retirement"
        );
    }

    // ─── Bootstrap: interrupted, mis-bound, bound once, no self-granted admin (issue 1796) ──────────────────────────────────

    function test_bootstrap_interruptedBeforeHandoverStaysClosedUnregisteredAndUnbound() public {
        InterruptedRedeploy died = new InterruptedRedeploy();
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        BasketVault v = BasketVault(died.deployOnly(p, json));
        // The state a dead broadcast leaves: configured, but closed, unregistered, unbound and not governed by anyone but the deployer.
        assertTrue(v.depositsPaused(), "closed");
        assertGt(v.assetCount(), 0, "configured");
        assertEq(v.registry(), address(0), "unbound");
        assertEq(registry.listVaults().length, 4, "unregistered");
        assertFalse(registry.isRouterEligible(address(v)), "ineligible");
        assertEq(v.maxDeposit(address(this)), 0, "no deposit can enter");
        assertTrue(v.hasRole(v.ADMIN_ROLE(), deployer), "only the deployer governs it so far");
        assertFalse(v.hasRole(v.ADMIN_ROLE(), timelock), "the timelock holds nothing yet");
        // The registry cannot adopt it as a retirable vault: it refuses an unregistered vault and the router never lists it.
        vm.prank(timelock);
        vm.expectRevert(VaultRegistry.NotRegistered.selector);
        registry.retire(address(v));
        // The router default vector does not hold it: a deposit cannot reach it.
        (address[] memory legs,) = router.getEffectiveWeights();
        for (uint256 i; i < legs.length; i++) {
            assertTrue(legs[i] != address(v));
        }
    }

    function _bindTo(address reg) internal {
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        p.registry = reg;
        script.runRedeployInProcess(p, json, timelock, emergency);
    }

    function test_bootstrap_incorrectBindingFailsClosed_noCode() public {
        vm.expectRevert(bytes("REGISTRY_ADDRESS has no code"));
        this.bindExternal(makeAddr("nothing"));
    }

    function test_bootstrap_incorrectBindingFailsClosed_notARegistry() public {
        vm.expectRevert();
        this.bindExternal(address(usdc));
    }

    function test_bootstrap_incorrectBindingFailsClosed_registryTheTimelockDoesNotGovern() public {
        VaultRegistry other = new VaultRegistry(deployer);
        vm.expectRevert(bytes("timelock lacks ADMIN_ROLE on REGISTRY_ADDRESS"));
        this.bindExternal(address(other));
    }

    function bindExternal(address reg) external {
        _bindTo(reg);
    }

    function test_bootstrap_registryIsBoundExactlyOnce() public {
        BasketVault v = _redeploy();
        assertEq(v.registry(), address(registry));
        // Neither the timelock (ADMIN_ROLE holder) nor anyone else can rebind it, even to the same registry.
        vm.startPrank(timelock);
        vm.expectRevert(BasketVault.RegistryAlreadySet.selector);
        v.setRegistry(address(registry));
        vm.expectRevert(BasketVault.RegistryAlreadySet.selector);
        v.setRegistry(makeAddr("other registry"));
        vm.stopPrank();
        vm.prank(deployer);
        vm.expectRevert();
        v.setRegistry(makeAddr("other registry"));
        assertEq(v.registry(), address(registry), "binding unchanged");
    }

    function test_bootstrap_deployerKeepsNoRoleAnywhere() public {
        BasketVault v = _redeploy();
        assertFalse(v.hasRole(v.ADMIN_ROLE(), deployer));
        assertFalse(v.hasRole(v.EMERGENCY_ROLE(), deployer));
        assertFalse(registry.hasRole(registry.ADMIN_ROLE(), deployer), "no live registry role");
        assertFalse(router.hasRole(router.ADMIN_ROLE(), deployer), "no live router role");
        assertFalse(router.hasRole(router.ADMIN_ROLE(), routerAdmin), "router admin handed over");
    }

    function test_bootstrap_aTimelockWithoutAdminCannotGrantItselfAdmin() public {
        InterruptedRedeploy died = new InterruptedRedeploy();
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        BasketVault v = BasketVault(died.deployOnly(p, json));
        bytes32 admin = v.ADMIN_ROLE();
        // The timelock holds no ADMIN_ROLE on a vault that has not been handed over: a direct call and a scheduled batch both fail.
        vm.prank(timelock);
        vm.expectRevert();
        v.grantRole(admin, timelock);
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory data = new bytes[](1);
        targets[0] = address(v);
        data[0] = abi.encodeCall(v.grantRole, (admin, timelock));
        _safeExec(
            committee,
            timelock,
            abi.encodeCall(
                governor.scheduleBatch, (targets, values, data, bytes32(0), bytes32(0), DELAY)
            )
        );
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert();
        governor.executeBatch(targets, values, data, bytes32(0), bytes32(0));
        assertFalse(v.hasRole(admin, timelock), "still not admin");
        // The script's own order is the only grant path: the deployer, still admin, grants it.
        assertTrue(_redeploy().hasRole(admin, timelock));
    }

    // ─── Local pause, stale operations, restore-old recovery (issue 1796) ───────────────────────────────────────────────────

    function _fundDeposit(uint256 amount) internal {
        usdc.mint(address(this), amount);
        usdc.approve(address(router), amount);
    }

    function test_localPause_ofALiveLegRevertsTheWholeRouterDeposit() public {
        BasketVault v = _redeploy();
        _runBatch(v);
        // Mock legs take deposits; the new vault is the registry-Active, router-eligible rmPROTO leg.
        _fundDeposit(1_000_000);
        vm.prank(emergency);
        v.pauseDeposits();
        // The registry still says Active and eligible, so the router counts the leg as depositable and the leg's own pause reverts the WHOLE deposit.
        uint256 before = usdc.balanceOf(address(this));
        vm.expectRevert();
        router.deposit(1_000_000, new uint256[](0));
        assertEq(usdc.balanceOf(address(this)), before, "nothing moved: all-or-revert");
        assertEq(legUsdc.balanceOf(address(this)), 0);
        // Only the registry status (a governance retire or pause of the vault in the registry) makes the router skip the leg.
        assertTrue(registry.isRouterEligible(address(v)));
    }

    function test_stale_unpauseOfTheRetiredOldVaultIsHarmlessToRouting() public {
        BasketVault v = _redeploy();
        _runBatch(v);
        // A stale unpause scheduled for the OLD vault before the cutover would still execute (the timelock holds ADMIN_ROLE on it), so the tool
        // must cancel it: the contract-side facts it relies on are that the old vault is retired, ineligible and never routed to, whatever happens.
        assertTrue(oldProto.retired());
        assertFalse(registry.isRouterEligible(address(oldProto)));
        vm.prank(deployer); // the old vault was never handed over in this fixture: its admin is the deployer
        oldProto.unpauseDeposits();
        assertEq(oldProto.maxDeposit(address(this)), 0, "retired: still no deposits");
        (address[] memory legs,) = router.getEffectiveWeights();
        for (uint256 i; i < legs.length; i++) {
            assertTrue(legs[i] != address(oldProto));
        }
    }

    function _restoreBatch(BasketVault v)
        internal
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory data)
    {
        targets = new address[](4);
        values = new uint256[](4);
        data = new bytes[](4);
        for (uint256 i; i < 4; i++) {
            targets[i] = address(registry);
        }
        // The mirror of the forward batch: the new vault stays in its slot, the old one joins right after it at 0 bps.
        address[] memory five = new address[](5);
        five[0] = address(legUsdc);
        five[1] = address(v);
        five[2] = address(oldProto);
        five[3] = address(legAgent);
        five[4] = address(legRwa);
        uint256[] memory fiveBps = new uint256[](5);
        fiveBps[0] = 8550;
        fiveBps[1] = 525;
        fiveBps[2] = 0;
        fiveBps[3] = 575;
        fiveBps[4] = 350;
        data[0] = abi.encodeCall(registry.reactivate, (address(oldProto)));
        data[1] =
            abi.encodeCall(registry.migrateEligibility, (address(oldProto), true, five, fiveBps));
        data[2] = abi.encodeCall(
            registry.migrateEligibility, (address(v), false, _launchVaults(), _launchBps())
        );
        data[3] = abi.encodeCall(registry.retire, (address(v)));
    }

    function _runRestore(BasketVault v) internal {
        (address[] memory targets, uint256[] memory values, bytes[] memory data) = _restoreBatch(v);
        assertTrue(
            _safeExec(
                committee,
                timelock,
                abi.encodeCall(
                    governor.scheduleBatch,
                    (targets, values, data, bytes32(0), bytes32(uint256(1)), DELAY)
                )
            )
        );
        vm.warp(block.timestamp + DELAY);
        governor.executeBatch(targets, values, data, bytes32(0), bytes32(uint256(1)));
    }

    function test_restoreOld_putsTheOldVaultBackAndRetiresTheNewOneKeepingItsExits() public {
        BasketVault v = _redeploy();
        _runBatch(v);
        // A holder of the new vault.
        address holder = makeAddr("holder");
        deal(address(v), holder, 1_000e18, true);
        _runRestore(v);

        (, VaultRegistry.VaultStatus oldStatus) = registry.getVault(address(oldProto));
        (, VaultRegistry.VaultStatus newStatus) = registry.getVault(address(v));
        assertEq(uint256(oldStatus), uint256(VaultRegistry.VaultStatus.Active), "old active again");
        assertEq(uint256(newStatus), uint256(VaultRegistry.VaultStatus.Retired), "new retired");
        assertFalse(oldProto.retired(), "old reopened");
        assertTrue(v.retired(), "new deposits halted");
        assertTrue(registry.isRouterEligible(address(oldProto)));
        assertFalse(registry.isRouterEligible(address(v)));
        assertEq(registry.listVaults().length, 5, "both generations stay listed");
        (address[] memory legs, uint256[] memory bps) = router.getEffectiveWeights();
        assertEq(legs, _launchVaults(), "old vault back in its slot");
        assertEq(bps, _launchBps(), "split unchanged");
        // Retirement stops deposits only: the new vault's holder keeps the exit.
        assertEq(v.maxDeposit(holder), 0);
        assertEq(v.maxRedeem(holder), 1_000e18, "holder exit retained");
    }

    function test_restoreOld_reactivationMustComeBeforeEligibility() public {
        BasketVault v = _redeploy();
        _runBatch(v);
        (address[] memory targets, uint256[] memory values, bytes[] memory data) = _restoreBatch(v);
        // Reorder: eligibility first. The router refuses a default vector naming the Retired old vault, so the whole batch reverts.
        bytes memory first = data[0];
        data[0] = data[1];
        data[1] = first;
        _safeExec(
            committee,
            timelock,
            abi.encodeCall(
                governor.scheduleBatch,
                (targets, values, data, bytes32(0), bytes32(uint256(2)), DELAY)
            )
        );
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert();
        governor.executeBatch(targets, values, data, bytes32(0), bytes32(uint256(2)));
        (, VaultRegistry.VaultStatus oldStatus) = registry.getVault(address(oldProto));
        assertEq(uint256(oldStatus), uint256(VaultRegistry.VaultStatus.Retired), "nothing applied");
        assertTrue(registry.isRouterEligible(address(v)));
    }
}
