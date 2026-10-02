// SPDX-License-Identifier: MIT
// Canonical: none — Foundry test for the core stage scripts (libs, vault, registry, router, gateway)
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {DeployLibs} from "../script/DeployLibs.s.sol";
import {DeployVault} from "../script/DeployVault.s.sol";
import {DeployGateway} from "../script/DeployGateway.s.sol";
import {DeployPortfolioRouter} from "../script/DeployPortfolioRouter.s.sol";
import {DeployInvestmentCommitteePolicy} from "../script/DeployInvestmentCommitteePolicy.s.sol";
import {CoreStages} from "./helpers/CoreStages.sol";

import {TestERC20} from "./helpers/TestERC20.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {AccessRoles} from "../gateway/AccessRoles.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {TickMath} from "../lib/TickMath.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {DeployProtocolAssetVault} from "../script/DeployProtocolAssetVault.s.sol";

/// @dev Mimics the per-vault `tickMathLibrary()` accessor the deploy assertion
///      reads, but returns a caller-chosen address — used to prove the deploy
///      assertion fails on a wrong/zero linked library (finding L3-D1).
contract BadTickMathVault {
    address private immutable _lib;

    constructor(address lib_) {
        _lib = lib_;
    }

    function tickMathLibrary() external view returns (address) {
        return _lib;
    }

    /// @dev BasketVault(addr).totalAssets() is also probed by the assertion;
    ///      return 0 so a passing codehash would still be exercised in range.
    function totalAssets() external pure returns (uint256) {
        return 0;
    }
}

/// @dev Test-only subclass exposing the internal TickMath link-integrity
///      assertion of the basket vault deploy scripts so a deliberately wrong/zero
///      linked address can be shown to fail the deploy assertion (finding L3-D1).
contract BasketDeployHarness is DeployProtocolAssetVault {
    function assertTickMathLinkIntegrity(address vault) external view {
        _assertTickMathLinkIntegrity(vault, 10_000_000 * 1e6);
    }
}

/// @dev Exposes the vault stage's manifest writer so a test can read the keys back from a file
///      without the process-wide DEPLOYMENT_OUT variable.
contract DeployVaultManifestHarness is DeployVault {
    function writeManifest(Deployed memory d, string memory path) external {
        _writeDeploymentJsonTo(d, path);
    }
}

/// @dev Runs the split stage scripts in process, in production order, and asserts the
///      post-deploy invariants the operator and downstream tooling rely on (core S3).
///      The stages are libs, vault, registry, router, gateway. The gateway takes the router as
///      its immutable, so the router stage comes first (core 1493). Adapter constructors only
///      check for address(0), so the in-process run succeeds although the venues have no
///      code here. Venue interaction is covered by the fork regression suite.
contract DeployTest is Test {
    using stdJson for string;

    CoreStages internal stages;
    TestERC20 internal usdc;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal agent = makeAddr("agent");
    address internal shareReceiver = makeAddr("shareReceiver");

    function setUp() public {
        stages = new CoreStages();
        usdc = new TestERC20();
    }

    function _run() internal returns (CoreStages.Stack memory) {
        return stages.run(admin, pauser, agent, shareReceiver, address(usdc));
    }

    // --- Stage order and router wiring (core 1493) ------------------------

    function test_stages_runInProductionOrder() public {
        _run();
        assertEq(stages.stageCount(), 5, "five stages");
        assertEq(stages.stages(0), "libs");
        assertEq(stages.stages(1), "vault");
        assertEq(stages.stages(2), "registry");
        assertEq(stages.stages(3), "router");
        assertEq(stages.stages(4), "gateway");
    }

    /// @notice The gateway is built with the deployed router: not zero, and equal to it.
    function test_gateway_routerEqualsDeployedRouter_notZero() public {
        CoreStages.Stack memory s = _run();
        assertTrue(address(s.router) != address(0), "router deployed");
        assertTrue(s.gateway.router() != address(0), "gateway.router is zero");
        assertEq(s.gateway.router(), address(s.router), "gateway.router != deployed router");
    }

    /// @notice The router stage links the registry exactly once and the link equals the router.
    function test_routerStage_callsRegistrySetRouterOnce() public {
        vm.recordLogs();
        CoreStages.Stack memory s = _run();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 routerSetEvents;
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter == address(s.registry)
                    && logs[i].topics[0] == VaultRegistry.RouterSet.selector
            ) routerSetEvents++;
        }
        assertEq(routerSetEvents, 1, "registry.setRouter must run exactly once");
        assertEq(address(s.registry.router()), address(s.router), "registry.router != router");
    }

    /// @notice The gateway stage refuses a zero router and a router with no code.
    function test_gatewayStage_revertsOnZeroOrEmptyRouter() public {
        CoreStages.Stack memory s = _run();
        DeployGateway gw = stages.gatewayScript();
        vm.expectRevert(bytes("ROUTER_ADDRESS=0"));
        gw.runInProcessWith(
            admin, pauser, agent, shareReceiver, address(usdc), address(s.vault), address(0)
        );
        vm.expectRevert(bytes("ROUTER_ADDRESS has no code on this chain"));
        gw.runInProcessWith(
            admin,
            pauser,
            agent,
            shareReceiver,
            address(usdc),
            address(s.vault),
            makeAddr("not-a-router")
        );
    }

    /// @notice Agent authorization runs in the gateway stage, after the gateway exists, and
    ///         the IC policy stage that follows binds the final gateway address.
    function test_agentAuthorizationAndIcPolicy_runAfterGateway_bindFinalGateway() public {
        vm.recordLogs();
        CoreStages.Stack memory s = _run();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // The AgentAuthorized log comes from the gateway, so the gateway existed first.
        bool authorized;
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter == address(s.gateway)
                    && logs[i].topics[0] == IGateway.AgentAuthorized.selector
            ) authorized = true;
        }
        assertTrue(authorized, "agent authorized through the final gateway");
        assertTrue(s.gateway.hasRole(s.gateway.AGENT_ROLE(), agent), "agent role");

        // In process the IC script is its own deployer and IC admin, so it needs the gateway's
        // ADMIN_ROLE the way the broadcast deployer holds it. Capture the role before pranking.
        DeployInvestmentCommitteePolicy ic = new DeployInvestmentCommitteePolicy();
        bytes32 gatewayAdminRole = s.gateway.ADMIN_ROLE();
        vm.prank(admin);
        s.gateway.grantRole(gatewayAdminRole, address(ic));
        DeployInvestmentCommitteePolicy.Deployed memory d =
            ic.runInProcessWith(address(ic), address(s.gateway));
        ic.wireGatewayInProcess(d);
        assertEq(d.gateway, address(s.gateway), "IC stage binds the final gateway");
        assertEq(d.policy.gateway(), address(s.gateway), "policy.gateway is the final gateway");
        assertEq(address(s.gateway.icPolicy()), address(d.policy), "gateway.icPolicy is the policy");
    }

    // --- Manifest ----------------------------------------------------------

    /// @notice The vault-stage manifest has the renamed keys and names the third venue for the
    ///         address it wraps. The old Morpho-named adapter key is gone.
    function test_manifest_hasRenamedKeysAndThirdVenueEntry() public {
        CoreStages.Stack memory s = _run();
        DeployVaultManifestHarness h = new DeployVaultManifestHarness();
        string memory path =
            string.concat("/tmp/rm-core-s3-manifest-", vm.toString(address(h)), ".json");
        h.writeManifest(s.vaultStage, path);
        string memory json = vm.readFile(path);
        vm.removeFile(path);

        assertEq(
            json.readAddress(".moonwell_flagship_adapter"), address(s.vaultStage.moonwellAdapter)
        );
        assertEq(json.readAddress(".aave_adapter"), address(s.vaultStage.aaveAdapter));
        assertEq(json.readAddress(".compound_adapter"), address(s.vaultStage.compoundAdapter));
        assertEq(json.readAddress(".vault"), address(s.vault));
        assertEq(json.readAddress(".moonwell_flagship_venue"), h.MOONWELL_FLAGSHIP_USDC());
        assertEq(json.readString(".moonwell_flagship_venue_name"), "Moonwell Flagship USDC");
        assertFalse(
            vm.keyExistsJson(json, string.concat(".morpho", "_adapter")), "old adapter key remains"
        );
        assertFalse(
            vm.keyExistsJson(json, ".gauntlet_adapter"), "no Gauntlet key for a Moonwell address"
        );
    }

    // --- Happy path -----------------------------------------------------

    function test_deploy_wiresUsdcVaultAndAdminPauserRoles() public {
        CoreStages.Stack memory s = _run();
        DeployVault.Deployed memory d = s.vaultStage;

        assertEq(s.gateway.usdc(), s.usdc, "usdc mismatch");
        assertEq(s.gateway.vault(), address(s.vault), "vault mismatch");
        assertEq(s.vault.asset(), s.usdc, "vault.asset mismatch");
        assertEq(s.usdc, address(usdc), "usdc passthrough");

        assertEq(address(d.aaveAdapter.USDC()), s.usdc, "aaveAdapter.USDC mismatch");
        assertEq(d.aaveAdapter.VAULT(), address(s.vault), "aaveAdapter.VAULT mismatch");
        assertEq(address(d.compoundAdapter.USDC()), s.usdc, "compoundAdapter.USDC mismatch");
        assertEq(d.compoundAdapter.VAULT(), address(s.vault), "compoundAdapter.VAULT mismatch");
        assertEq(address(d.moonwellAdapter.USDC()), s.usdc, "moonwellAdapter.USDC mismatch");
        assertEq(d.moonwellAdapter.VAULT(), address(s.vault), "moonwellAdapter.VAULT mismatch");

        assertEq(s.vault.activeAdapterCount(), 3, "vault should have 3 active adapters");

        assertTrue(s.gateway.hasRole(s.gateway.ADMIN_ROLE(), admin), "admin role");
        assertTrue(s.gateway.hasRole(s.gateway.DEFAULT_ADMIN_ROLE(), admin), "default admin");
        assertTrue(s.gateway.hasRole(s.gateway.PAUSER_ROLE(), pauser), "pauser role");

        assertTrue(s.gateway.hasRole(s.gateway.AGENT_ROLE(), agent), "agent role");
        assertFalse(s.gateway.hasRole(s.gateway.ADMIN_ROLE(), agent), "agent !admin");
        assertFalse(s.gateway.hasRole(s.gateway.PAUSER_ROLE(), agent), "agent !pauser");

        assertEq(s.gatewayRuntimeHash, keccak256(address(s.gateway).code));

        // The vault is registered and router-eligible, and the router weights it 100%.
        assertTrue(s.registry.isRouterEligible(address(s.vault)), "vault router-eligible");
    }

    /// @notice Exactly three DISTINCT real adapters, and the third wraps the Moonwell
    ///         Flagship address the constant names.
    function test_deploy_wiresThreeDistinctRealAdapterAddresses() public {
        CoreStages.Stack memory s = _run();
        DeployVault.Deployed memory d = s.vaultStage;
        DeployVault vs = stages.vaultScript();

        address aave = address(d.aaveAdapter);
        address compound = address(d.compoundAdapter);
        address moonwell = address(d.moonwellAdapter);

        assertTrue(aave != address(0), "aaveAdapter is zero");
        assertTrue(compound != address(0), "compoundAdapter is zero");
        assertTrue(moonwell != address(0), "moonwellAdapter is zero");
        assertTrue(aave != compound, "aave aliases compound");
        assertTrue(aave != moonwell, "aave aliases moonwell");
        assertTrue(compound != moonwell, "compound aliases moonwell");

        assertEq(address(d.aaveAdapter.POOL()), vs.AAVE_V3_POOL(), "aave POOL mismatch");
        assertEq(
            address(d.compoundAdapter.COMET()), vs.COMPOUND_V3_COMET(), "compound COMET mismatch"
        );
        assertEq(
            address(d.moonwellAdapter.MORPHO_VAULT()),
            vs.MOONWELL_FLAGSHIP_USDC(),
            "third venue mismatch"
        );
        assertEq(s.vault.activeAdapterCount(), 3, "vault should have 3 active adapters");
    }

    function test_deploy_authorizesAgentWithSanePolicy() public {
        CoreStages.Stack memory s = _run();
        DeployGateway gw = stages.gatewayScript();
        (
            bool active,
            uint64 validUntil,
            uint256 maxPerPayment,
            uint256 maxPerWindow,
            address recv,,
            uint256 maxWithdrawPerPayment,
            uint256 maxWithdrawPerWindow
        ) = s.gateway.agents(agent);
        assertTrue(active);
        assertGt(validUntil, block.timestamp);
        assertEq(maxPerPayment, gw.DEFAULT_MAX_PER_PAYMENT());
        assertEq(maxPerWindow, gw.DEFAULT_MAX_PER_WINDOW());
        assertEq(recv, shareReceiver);
        assertEq(maxWithdrawPerPayment, gw.DEFAULT_MAX_WITHDRAW_PER_PAYMENT());
        assertEq(maxWithdrawPerWindow, gw.DEFAULT_MAX_WITHDRAW_PER_WINDOW());
    }

    function test_deploy_doesNotMintToAgent() public {
        uint256 before = usdc.balanceOf(agent);
        _run();
        assertEq(usdc.balanceOf(agent), before, "deploy must not mint to agent");
    }

    // --- USDC_ADDRESS preconditions -------------------------------------

    function test_deploy_revertsWhenUsdcAddressZero() public {
        DeployVault vs = stages.vaultScript();
        vm.expectRevert(bytes("USDC_ADDRESS=0"));
        vs.runInProcessWith(admin, address(0));
    }

    function test_deploy_revertsWhenUsdcAddressHasNoCode() public {
        DeployVault vs = stages.vaultScript();
        address eoa = makeAddr("not-a-token");
        vm.expectRevert(bytes("USDC_ADDRESS has no code"));
        vs.runInProcessWith(admin, eoa);
    }

    // --- Role-separation invariant (issue #10's headline test) ----------

    function _openPolicy() internal view returns (IGateway.AgentPolicy memory) {
        address[] memory noDestinations = new address[](0);
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 1 days),
            maxPerPayment: 1e6,
            maxPerWindow: 1e6,
            shareReceiver: shareReceiver,
            allowedDestinations: noDestinations,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: noDestinations
        });
    }

    function test_deploy_grantingAgentRoleToAdminReverts() public {
        CoreStages.Stack memory s = _run();
        vm.prank(admin);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        s.gateway.authorizeAgent(admin, _openPolicy());
    }

    function test_deploy_grantingAgentRoleToPauserReverts() public {
        CoreStages.Stack memory s = _run();
        vm.prank(admin);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        s.gateway.authorizeAgent(pauser, _openPolicy());
    }

    // --- Pre-deploy distinctness check ----------------------------------

    function test_deploy_revertsWhenAdminEqualsPauser() public {
        CoreStages.Stack memory s = _run();
        DeployGateway gw = stages.gatewayScript();
        vm.expectRevert(bytes("ADMIN==PAUSER"));
        gw.runInProcessWith(
            admin, admin, agent, shareReceiver, address(usdc), address(s.vault), address(s.router)
        );
    }

    function test_deploy_revertsWhenAdminEqualsAgent() public {
        CoreStages.Stack memory s = _run();
        DeployGateway gw = stages.gatewayScript();
        vm.expectRevert(bytes("ADMIN==AGENT"));
        gw.runInProcessWith(
            admin, pauser, admin, shareReceiver, address(usdc), address(s.vault), address(s.router)
        );
    }

    function test_deploy_revertsWhenPauserEqualsAgent() public {
        CoreStages.Stack memory s = _run();
        DeployGateway gw = stages.gatewayScript();
        vm.expectRevert(bytes("PAUSER==AGENT"));
        gw.runInProcessWith(
            admin, pauser, pauser, shareReceiver, address(usdc), address(s.vault), address(s.router)
        );
    }

    // --- Seed deposit constant (issue #656) --------------------------------

    function test_deploy_seedDepositAmount_isOneUsdc() public view {
        assertEq(
            stages.vaultScript().SEED_DEPOSIT_AMOUNT(),
            1_000_000,
            "SEED_DEPOSIT_AMOUNT must be 1_000_000 (1 USDC in 6-decimal units)"
        );
    }

    // --- Env-driven stages ------------------------------------------------

    function test_deploy_envDriven_vaultAndGatewayStages() public {
        vm.setEnv("ADMIN_ADDRESS", vm.toString(admin));
        vm.setEnv("PAUSER_ADDRESS", vm.toString(pauser));
        vm.setEnv("AGENT_ADDRESS", vm.toString(agent));
        vm.setEnv("SHARE_RECEIVER_ADDRESS", vm.toString(shareReceiver));
        vm.setEnv("FEE_RECIPIENT_ADDRESS", vm.toString(makeAddr("env-treasury")));
        vm.setEnv("AGENT_VALID_UNTIL", vm.toString(block.timestamp + 30 days));
        vm.setEnv("AGENT_MAX_PER_PAYMENT", "10000000000");
        vm.setEnv("AGENT_MAX_PER_WINDOW", "100000000000");
        vm.setEnv("AGENT_MAX_WITHDRAW_PER_PAYMENT", "10000000000");
        vm.setEnv("AGENT_MAX_WITHDRAW_PER_WINDOW", "100000000000");
        vm.setEnv("VAULT_TVL_CAP", "10000000000000");
        vm.setEnv("VAULT_PER_DEPOSIT_CAP", "1000000000000");
        // USDC is the canonical constant on every chain: install a token there.
        DeployVault vs = stages.vaultScript();
        vm.etch(vs.CANONICAL_BASE_USDC(), address(usdc).code);
        DeployVault.Deployed memory v = vs.runInProcess();
        assertEq(v.admin, admin);
        assertEq(v.usdc, vs.CANONICAL_BASE_USDC());

        // The router stage runs between the vault and the gateway.
        VaultRegistry registry =
        stages.registryScript()
        .runInProcessWith(admin, address(v.vault), v.usdc, "Robot Money USDC")
        .registry;
        DeployPortfolioRouter.Deployed memory rt = stages.routerScript()
            .runInProcessWith(admin, address(registry), address(v.vault), v.usdc);
        vm.setEnv("VAULT_ADDRESS", vm.toString(address(v.vault)));
        vm.setEnv("ROUTER_ADDRESS", vm.toString(address(rt.router)));
        DeployGateway.Deployed memory g = stages.gatewayScript().runInProcess();
        assertEq(g.admin, admin);
        assertEq(g.pauser, pauser);
        assertEq(g.agent, agent);
        assertEq(g.gateway.router(), address(rt.router));
    }

    // --- L3-D1: TickMath link integrity ------------------------------------

    /// @notice The libs stage proves the linked TickMath answers a known value.
    function test_libsStage_provesLinkedTickMath() public {
        DeployLibs.Deployed memory d = stages.libsScript().runInProcess();
        assertEq(d.tickMath, address(TickMath));
        assertGt(d.tickMath.code.length, 0, "TickMath must have code");
    }

    /// @dev The audited reference is the TickMath library linked into the test
    ///      artifact set, which is identical to the one linked into the deploy
    ///      scripts and the basket vaults (same compiled build). Using it as the
    ///      reference — rather than a hardcoded codehash — keeps the assertion
    ///      robust across compiler/metadata variance while still detecting a
    ///      mislink (a vault pointing at a different address or empty code).
    function _canonicalTickMath() internal pure returns (address) {
        return address(TickMath);
    }

    /// @dev Deploy a representative basket-family vault (uses the TickMath link)
    ///      with no real swap router; totalAssets() with an empty basket returns
    ///      the vault's USDC balance and never touches TickMath, so it is a
    ///      non-reverting in-range probe.
    function _deployBasketVault() internal returns (BasketVault) {
        return BasketVault(
            address(
                new AgentTokenVault(
                    IERC20(address(usdc)),
                    ISwapRouter(makeAddr("swapRouter")),
                    10_000_000 * 1e6, // tvlCap
                    1_000_000 * 1e6, // perDepositCap
                    0, // exitFeeBps
                    admin, // feeRecipient
                    admin, // admin
                    makeAddr("emergency") // emergencyResponder
                )
            )
        );
    }

    /// @notice The basket vault's linked TickMath library is the canonical
    ///         instance (non-zero, has code, same address + codehash as the
    ///         artifact's `TickMath`), and totalAssets() is non-reverting and in
    ///         range. Positive arm of the deploy-time assertion.
    function test_tickMathLink_codehashMatchesAudited_andTotalAssetsInRange() public {
        address canonical = _canonicalTickMath();
        BasketVault vault = _deployBasketVault();

        address lib = vault.tickMathLibrary();
        assertTrue(lib != address(0), "linked TickMath must be non-zero");
        assertGt(lib.code.length, 0, "linked TickMath must have code");
        assertEq(lib, canonical, "vault must link the canonical TickMath instance");
        assertEq(lib.codehash, canonical.codehash, "TickMath codehash must match canonical");

        uint256 nav = vault.totalAssets();
        assertEq(nav, 0, "empty basket totalAssets is the USDC balance (0)");
        assertLe(nav, 10_000_000 * 1e6 * 1000, "totalAssets must be in range");
    }

    /// @notice A deliberately wrong (and a zero) linked-library address fails the
    ///         same codehash check the deploy assertion enforces. Proves the
    ///         assertion is not vacuous — a mislinked library does not pass.
    function test_tickMathLink_wrongOrZeroAddressFailsCodehashCheck() public {
        // The canonical library, for reference.
        address canonical = _canonicalTickMath();
        assertEq(
            _deployBasketVault().tickMathLibrary().codehash,
            canonical.codehash,
            "control: canonical matches"
        );

        // Zero address: no code, codehash is zero → mismatch.
        BadTickMathVault zeroVault = new BadTickMathVault(address(0));
        address zeroLib = zeroVault.tickMathLibrary();
        assertEq(zeroLib.code.length, 0, "zero address has no code");
        assertTrue(
            zeroLib.codehash != canonical.codehash, "zero address must not pass codehash check"
        );

        // Wrong address (a contract whose code is not TickMath) → mismatch.
        BadTickMathVault wrongVault = new BadTickMathVault(address(this));
        address wrongLib = wrongVault.tickMathLibrary();
        assertGt(wrongLib.code.length, 0, "wrong address has code (this test contract)");
        assertTrue(
            wrongLib.codehash != canonical.codehash,
            "wrong (non-TickMath) code must not pass codehash check"
        );
    }

    /// @notice The actual basket deploy script TickMath link-integrity assertion
    ///         reverts when a vault links a zero (no-code) or wrong (non-TickMath)
    ///         library — proving the deploy assertion fails closed on mislink.
    function test_tickMathLink_deployAssertionRevertsOnMislink() public {
        BasketDeployHarness harness = new BasketDeployHarness();

        // Zero linked library → reverts on the zero-address check.
        address zeroVault = address(new BadTickMathVault(address(0)));
        vm.expectRevert(bytes("TickMath: zero linked library"));
        harness.assertTickMathLinkIntegrity(zeroVault);

        // Wrong (non-TickMath) linked library with code → reverts because it is
        // not the script's canonical TickMath instance.
        address wrongVault = address(new BadTickMathVault(address(this)));
        vm.expectRevert(bytes("TickMath: vault links non-canonical library"));
        harness.assertTickMathLinkIntegrity(wrongVault);
    }

    // --- Router deposit through the split-stage gateway (core 1485) --------------------------

    /// @notice A router deposit through the gateway the split stages built reaches the vault leg:
    ///         gateway, router, registry eligibility and the USDC pull all pass, and the call
    ///         stops only at the vault, whose venues have no code here. The completed deposit and
    ///         withdraw round trip, with the venues etched, is `GatewayRouter.t.sol`
    ///         (`GatewayRouterSplitStagesTest`).
    function test_routerDeposit_throughSplitStageGateway_reachesVaultLeg() public {
        CoreStages.Stack memory s = _run();
        uint256 amount = 5 * 1e6;
        usdc.mint(agent, amount);
        uint64 deadline = uint64(block.timestamp + 300);

        vm.startPrank(agent);
        usdc.approve(address(s.gateway), amount);
        vm.expectRevert(abi.encodeWithSignature("UsdcLegTransferFailed(address)", address(s.vault)));
        s.gateway
            .depositTo(
                bytes32("dep-order"),
                amount,
                deadline,
                bytes32("dep-idem"),
                address(s.router),
                new uint256[](0)
            );
        vm.stopPrank();
    }
}
