// SPDX-License-Identifier: MIT
// Canonical: docs/implementation-plan.md §3 — Phase 1 Contracts (deploy + role-separation invariant)
// (See also: docs/architecture.md §6 — Roles)
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {PassthroughAdapter} from "../adapters/PassthroughAdapter.sol";
import {AaveV3Adapter} from "../adapters/AaveV3Adapter.sol";
import {CompoundV3Adapter} from "../adapters/CompoundV3Adapter.sol";
import {MorphoAdapter} from "../adapters/MorphoAdapter.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";

/// @title Deploy
/// @notice Foundry deploy script for the Robot Money gateway stack.
///         Deploys RobotMoneyVault wired to real Aave V3, Compound V3, and
///         Morpho strategy adapters (Base mainnet protocol addresses), a
///         RobotMoneyGateway bound to the vault, grants AGENT_ROLE to a
///         distinct EOA via `authorizeAgent`, asserts role-separation, and
///         writes a deployment JSON.
///
///         MockVault is NOT deployed by this script; it is only used by
///         gateway deposit-routing unit tests directly. See issue #277.
///         PassthroughAdapter is NOT registered by this script; it is
///         retained in the codebase for unit tests only. See issue #363.
/// @dev Implements `docs/implementation-plan.md` §5 step 1–2 and
///      satisfies issue #10. Inputs are env-driven so the same script works
///      on Anvil, the docker devnet, and (with care) any throwaway L1.
///
///      Required env vars:
///        ADMIN_ADDRESS         — receives DEFAULT_ADMIN_ROLE + ADMIN_ROLE
///        PAUSER_ADDRESS        — receives PAUSER_ROLE (must differ from ADMIN)
///        AGENT_ADDRESS         — receives AGENT_ROLE  (must differ from both)
///        SHARE_RECEIVER_ADDRESS — recipient of minted rmUSDC shares
///        USDC_ADDRESS          — address of the USDC token to bind the
///                                gateway to. The smoke-test devnet seeds the
///                                canonical Base USDC into genesis alloc and
///                                exports this address (see issue #255 and
///                                `Fixture::fund_usdc` in the smoke-test
///                                crate). Forge unit tests deploy a
///                                `TestERC20` helper and pass its address
///                                via `runInProcessWithUsdc`.
///
///      Optional env vars (with safe defaults):
///        AGENT_VALID_UNTIL               — uint64, default = block.timestamp + 30 days
///        AGENT_MAX_PER_PAYMENT           — uint256, default = 10_000 * 1e6 (USDC, 6dp)
///        AGENT_MAX_PER_WINDOW            — uint256, default = 100_000 * 1e6
///        AGENT_MAX_WITHDRAW_PER_PAYMENT  — uint256, default = 10_000 * 1e6 (shares, 6dp)
///        AGENT_MAX_WITHDRAW_PER_WINDOW   — uint256, default = 100_000 * 1e6
///        DEPLOYMENT_OUT         — output JSON path,
///                                 default = "deployments/<chain_id>.json"
///        USE_PASSTHROUGH_ADAPTER — bool, default = false.
///                                 When true, deploys a single `PassthroughAdapter`
///                                 instead of the three real protocol adapters.
///                                 Required on the Geth+Lighthouse smoke-test devnet
///                                 because that chain boots from a genesis snapshot
///                                 containing only warm-storage slots — real Aave,
///                                 Compound, and Morpho contracts have bytecode but
///                                 no on-chain state, so any call that returns a
///                                 uint256 (e.g. `balanceOf`) would be ABI-decoded
///                                 from an empty return and revert.  Set automatically
///                                 by the smoke-test Rust harness.
contract Deploy is Script {
    using stdJson for string;

    /// @notice Result struct returned to in-process callers (e.g. forge tests).
    /// @dev `usdc` is the *address* of the externally-supplied USDC token
    ///      bound to the gateway. On the smoke-test devnet this is the
    ///      canonical Base USDC proxy seeded into genesis alloc; in forge
    ///      unit tests it is a `TestERC20` deployed by the caller.
    ///      `vault` is the deployed RobotMoneyVault (smoke-test devnet and
    ///      integration tests). For gateway unit tests that still need MockVault,
    ///      use the separate `MockVault` import directly.
    ///      `aaveAdapter`, `compoundAdapter`, and `morphoAdapter` are the
    ///      real protocol adapters registered with the vault at deploy time.
    ///      When `USE_PASSTHROUGH_ADAPTER=true` all three adapter fields point
    ///      to the same `PassthroughAdapter` instance (Geth devnet only — real
    ///      protocol contracts have no on-chain state there).
    struct Deployed {
        address usdc;
        RobotMoneyVault vault;
        AaveV3Adapter aaveAdapter;
        CompoundV3Adapter compoundAdapter;
        MorphoAdapter morphoAdapter;
        RobotMoneyGateway gateway;
        address admin;
        address pauser;
        address agent;
        address shareReceiver;
        bytes32 gatewayRuntimeHash;
        /// @dev True when deployed with `USE_PASSTHROUGH_ADAPTER=true`.
        ///      All three adapter fields share the same `PassthroughAdapter`
        ///      address; only one `addAdapter` call is needed.
        bool passthroughMode;
    }

    /// @notice Canonical Base mainnet USDC (FiatTokenProxy). The smoke-test
    ///         devnet seeds this address with real proxy storage + the
    ///         FiatTokenV2_2 implementation in genesis alloc.
    address public constant CANONICAL_BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // -- Real protocol contract addresses (Base mainnet) ----------------
    // Sourced from testing/fork-e2e-rust/src/addresses.rs and
    // contracts/test/VaultForkRegressions.t.sol.

    /// @notice Aave V3 Pool on Base mainnet.
    address public constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    /// @notice aBasUSDC — Aave V3 interest-bearing USDC receipt token on Base.
    address public constant AAVE_V3_A_TOKEN = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    /// @notice Morpho Gauntlet USDC Prime ERC-4626 vault on Base.
    address public constant MORPHO_GAUNTLET_USDC_PRIME = 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca;
    /// @notice Compound V3 (Comet) USDC market on Base.
    /// @dev Verified against `cast call <compound-adapter> "COMET()(address)"` on Base mainnet.
    ///      The previously used address 0xB125e6687D4313864e53df431d5425969c15eb28
    ///      (ending in 28) was a typo — the actual Comet ends in 2F.
    address public constant COMPOUND_V3_COMET = 0xb125E6687d4313864e53df431d5425969c15Eb2F;

    /// @notice Default per-payment cap if `AGENT_MAX_PER_PAYMENT` is unset.
    uint256 public constant DEFAULT_MAX_PER_PAYMENT = 10_000 * 1e6;
    /// @notice Default per-window cap if `AGENT_MAX_PER_WINDOW` is unset.
    uint256 public constant DEFAULT_MAX_PER_WINDOW = 100_000 * 1e6;
    /// @notice Default withdrawal per-payment cap if `AGENT_MAX_WITHDRAW_PER_PAYMENT` is unset.
    uint256 public constant DEFAULT_MAX_WITHDRAW_PER_PAYMENT = 10_000 * 1e6;
    /// @notice Default withdrawal per-window cap if `AGENT_MAX_WITHDRAW_PER_WINDOW` is unset.
    uint256 public constant DEFAULT_MAX_WITHDRAW_PER_WINDOW = 100_000 * 1e6;
    /// @notice Default policy lifetime (30 days).
    uint64 public constant DEFAULT_VALID_UNTIL_OFFSET = 30 days;

    /// @notice Forge broadcast entrypoint. Reads env vars, deploys all contracts, and writes a JSON file.
    /// @return d Struct containing all deployed contract addresses and key parameters.
    function run() external returns (Deployed memory d) {
        Params memory p = _readEnvParams();
        vm.startBroadcast();
        d = _doDeploy(p);
        // In broadcast mode the broadcaster IS d.admin (the smoke-test devnet
        // runs the deploy script with the admin private key), so msg.sender on
        // the addAdapter calls is d.admin which holds ADMIN_ROLE.  No vm.prank
        // is required — and vm.prank is prohibited inside startBroadcast.
        _approveAndRegisterAdapters(d);
        vm.stopBroadcast();

        _writeDeploymentJson(d);
    }

    /// @notice In-process variant for forge tests. Caller sets up `vm.prank`
    ///         or test-account context. No JSON is written.
    /// @return d Struct containing all deployed contract addresses and key parameters.
    function runInProcess() external returns (Deployed memory d) {
        Params memory p = _readEnvParams();
        d = _doDeploy(p);
        // In-process (no broadcast): addAdapter requires ADMIN_ROLE which is
        // held by d.admin. Use vm.prank to call it as d.admin.
        vm.startPrank(d.admin);
        _approveAndRegisterAdapters(d);
        vm.stopPrank();
    }

    /// @notice Direct-parameter variant for forge tests. Skips env-var
    ///         resolution so a noisy host environment (or another test's
    ///         residual `vm.setEnv`) cannot pollute the inputs. The caller
    ///         must supply a deployed USDC token (typically a `TestERC20`).
    /// @param admin_         Address to receive `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE`.
    /// @param pauser_        Address to receive `PAUSER_ROLE`.
    /// @param agent_         Address to receive `AGENT_ROLE`.
    /// @param shareReceiver_ Address that will receive minted vault shares.
    /// @param usdc_          Address of the USDC token to bind to the gateway.
    /// @return d Struct containing all deployed contract addresses and key parameters.
    function runInProcessWith(
        address admin_,
        address pauser_,
        address agent_,
        address shareReceiver_,
        address usdc_
    ) external returns (Deployed memory d) {
        Params memory p;
        p.admin = admin_;
        p.pauser = pauser_;
        p.agent = agent_;
        p.shareReceiver = shareReceiver_;
        p.validUntil = uint64(block.timestamp + DEFAULT_VALID_UNTIL_OFFSET);
        p.maxPerPayment = DEFAULT_MAX_PER_PAYMENT;
        p.maxPerWindow = DEFAULT_MAX_PER_WINDOW;
        p.maxWithdrawPerPayment = DEFAULT_MAX_WITHDRAW_PER_PAYMENT;
        p.maxWithdrawPerWindow = DEFAULT_MAX_WITHDRAW_PER_WINDOW;
        p.usdcAddress = usdc_;
        d = _doDeploy(p);
        // In-process (no broadcast): addAdapter requires ADMIN_ROLE which is
        // held by d.admin. Use vm.prank to call it as d.admin.
        vm.startPrank(d.admin);
        _approveAndRegisterAdapters(d);
        vm.stopPrank();
    }

    struct Params {
        address admin;
        address pauser;
        address agent;
        address shareReceiver;
        uint64 validUntil;
        uint256 maxPerPayment;
        uint256 maxPerWindow;
        uint256 maxWithdrawPerPayment;
        uint256 maxWithdrawPerWindow;
        /// @dev Address of the USDC token to bind the gateway to. Must be
        ///      non-zero and have code deployed. The smoke-test devnet sets
        ///      this to the canonical Base USDC ([`CANONICAL_BASE_USDC`]);
        ///      forge unit tests deploy a `TestERC20` helper.
        address usdcAddress;
    }

    function _readEnvParams() internal view returns (Params memory p) {
        p.admin = vm.envAddress("ADMIN_ADDRESS");
        p.pauser = vm.envAddress("PAUSER_ADDRESS");
        p.agent = vm.envAddress("AGENT_ADDRESS");
        p.shareReceiver = vm.envAddress("SHARE_RECEIVER_ADDRESS");
        p.validUntil = uint64(
            _envOrDefault("AGENT_VALID_UNTIL", block.timestamp + DEFAULT_VALID_UNTIL_OFFSET)
        );
        p.maxPerPayment = _envOrDefault("AGENT_MAX_PER_PAYMENT", DEFAULT_MAX_PER_PAYMENT);
        p.maxPerWindow = _envOrDefault("AGENT_MAX_PER_WINDOW", DEFAULT_MAX_PER_WINDOW);
        p.maxWithdrawPerPayment =
            _envOrDefault("AGENT_MAX_WITHDRAW_PER_PAYMENT", DEFAULT_MAX_WITHDRAW_PER_PAYMENT);
        p.maxWithdrawPerWindow =
            _envOrDefault("AGENT_MAX_WITHDRAW_PER_WINDOW", DEFAULT_MAX_WITHDRAW_PER_WINDOW);
        p.usdcAddress = vm.envAddress("USDC_ADDRESS");
    }

    function _approveAndRegisterAdapters(Deployed memory d) internal {
        if (d.passthroughMode) {
            _approveAdapter(d.vault, address(d.aaveAdapter));
            d.vault.addAdapter(address(d.aaveAdapter), 10_000);
        } else {
            _approveAdapter(d.vault, address(d.aaveAdapter));
            _approveAdapter(d.vault, address(d.compoundAdapter));
            _approveAdapter(d.vault, address(d.morphoAdapter));
            d.vault.addAdapter(address(d.aaveAdapter), 3_334);
            d.vault.addAdapter(address(d.compoundAdapter), 3_333);
            d.vault.addAdapter(address(d.morphoAdapter), 3_333);
        }
    }

    function _approveAdapter(RobotMoneyVault vault_, address adapter_) internal {
        vault_.setAdapterAllowed(adapter_, true);
        vault_.setAdapterCodeHashAllowed(adapter_.codehash, true);
    }

    function _doDeploy(Params memory p) internal returns (Deployed memory d) {
        d.admin = p.admin;
        d.pauser = p.pauser;
        d.agent = p.agent;
        d.shareReceiver = p.shareReceiver;

        require(d.admin != address(0), "ADMIN_ADDRESS=0");
        require(d.pauser != address(0), "PAUSER_ADDRESS=0");
        require(d.agent != address(0), "AGENT_ADDRESS=0");
        require(d.shareReceiver != address(0), "SHARE_RECEIVER_ADDRESS=0");

        // Distinctness of EOAs is a deploy-time precondition. The
        // role-separation invariant in AccessRoles enforces this on-chain
        // too, but failing fast here gives a better operator message.
        require(d.admin != d.pauser, "ADMIN==PAUSER");
        require(d.admin != d.agent, "ADMIN==AGENT");
        require(d.pauser != d.agent, "PAUSER==AGENT");

        // 1. Token + vault + adapter + gateway.
        //    USDC is always externally supplied: the smoke-test devnet seeds
        //    the canonical Base USDC proxy into genesis alloc (issue #255),
        //    and forge unit tests deploy a `TestERC20` helper and pass its
        //    address via `runInProcessWithUsdc`.
        //
        //    RobotMoneyVault (issue #277): replaces MockVault as the primary
        //    vault. Deployed with exitFeeBps=0 and real Aave V3, Compound V3,
        //    and Morpho strategy adapters using canonical Base mainnet protocol
        //    addresses (issue #363). MockVault is retained in the codebase only
        //    for gateway deposit-routing unit tests. PassthroughAdapter is
        //    retained for unit tests only and is NOT registered here.
        //
        //    Vault constructor parameters:
        //      tvlCap        = 10M USDC (generous for devnet, no real risk)
        //      perDepositCap = 1M USDC  (generous for devnet)
        //      exitFeeBps    = 0        (no exit fee in test environment)
        //      feeRecipient  = admin    (any non-zero address, fees are 0)
        //      vaultAdmin    = d.admin  (receives ADMIN_ROLE for vault management)
        //
        //    addAdapter requires ADMIN_ROLE.  In `run()` (broadcast) the
        //    broadcaster IS d.admin (smoke-test devnet deploys from the admin
        //    key), so the call succeeds without any cheatcode.  In the test
        //    helpers (runInProcessWith / runInProcess) the callers use
        //    vm.startPrank(d.admin)/vm.stopPrank() — see those callers.
        require(p.usdcAddress != address(0), "USDC_ADDRESS=0");
        require(p.usdcAddress.code.length > 0, "USDC_ADDRESS has no code");
        d.usdc = p.usdcAddress;
        uint256 tvlCap = 10_000_000 * 1e6; // 10M USDC
        uint256 perDepositCap = 1_000_000 * 1e6; // 1M USDC
        d.vault = new RobotMoneyVault(
            IERC20(d.usdc),
            tvlCap,
            perDepositCap,
            0, // exitFeeBps = 0
            d.admin, // feeRecipient (fees are 0, any non-zero addr)
            d.admin // vaultAdmin — receives ADMIN_ROLE
        );
        // Deploy adapters wired to the new vault.
        // Registration (addAdapter) is done by the callers of _doDeploy —
        // see run(), runInProcess(), and runInProcessWith() — because the
        // caller context differs between broadcast and in-process test modes.
        //
        // USE_PASSTHROUGH_ADAPTER=true → deploy one PassthroughAdapter and
        // alias all three typed fields to its address.  Required on the
        // Geth+Lighthouse smoke-test devnet: that chain boots from a genesis
        // snapshot restricted to warm-storage slots, so real protocol contracts
        // (Aave/Compound/Morpho) have bytecode but zero storage.  Any call
        // returning uint256 (e.g. `balanceOf`) decodes empty returndata and
        // reverts, which would abort every deposit.  The Rust harness sets
        // this env var automatically (see `run_forge_deploy_with_env` in
        // testing/smoke-test/src/lib.rs).
        d.passthroughMode = vm.envOr("USE_PASSTHROUGH_ADAPTER", false);
        if (d.passthroughMode) {
            PassthroughAdapter pt = new PassthroughAdapter(d.usdc, address(d.vault));
            d.aaveAdapter = AaveV3Adapter(address(pt));
            d.compoundAdapter = CompoundV3Adapter(address(pt));
            d.morphoAdapter = MorphoAdapter(address(pt));
        } else {
            // Protocol addresses are Base mainnet constants — production or
            // Anvil fork deployments where real protocol state is available.
            d.aaveAdapter =
                new AaveV3Adapter(AAVE_V3_POOL, d.usdc, AAVE_V3_A_TOKEN, address(d.vault));
            d.compoundAdapter = new CompoundV3Adapter(COMPOUND_V3_COMET, d.usdc, address(d.vault));
            d.morphoAdapter =
                new MorphoAdapter(MORPHO_GAUNTLET_USDC_PRIME, d.usdc, address(d.vault));
        }
        d.gateway = new RobotMoneyGateway(
            IERC20(d.usdc), IERC4626(address(d.vault)), d.admin, d.pauser, address(0)
        );

        // 2. Authorize agent under a sane initial policy. Authorization is
        //    permissionless (issue #269): the broadcaster becomes the agent's
        //    recorded owner via `msg.sender`. On the smoke-test devnet that
        //    is the deployer EOA; the deployer is the depositor proxy for
        //    happy-path smoke-tests and may later `setPolicy`/`revokeAgent`
        //    against this agent without holding any privileged role.
        address[] memory noDestinations = new address[](0);
        // When withdrawals are enabled (maxWithdrawPerPayment > 0) the contract
        // requires assetRecipient != address(0).  Use shareReceiver as the
        // USDC recipient for devnet/test deployments.
        address assetRecipient = p.maxWithdrawPerPayment > 0 ? d.shareReceiver : address(0);
        IGateway.AgentPolicy memory policy = IGateway.AgentPolicy({
            active: true,
            validUntil: p.validUntil,
            maxPerPayment: p.maxPerPayment,
            maxPerWindow: p.maxPerWindow,
            shareReceiver: d.shareReceiver,
            allowedDestinations: noDestinations,
            assetRecipient: assetRecipient,
            maxWithdrawPerPayment: p.maxWithdrawPerPayment,
            maxWithdrawPerWindow: p.maxWithdrawPerWindow,
            allowedSourceVaults: noDestinations
        });

        d.gateway.authorizeAgent(d.agent, policy);

        // 3. Sanity: post-grant, agent must satisfy role separation.
        //    authorizeAgent already calls _assertRoleSeparation, but we
        //    repeat the public hasRole checks here as a belt-and-braces
        //    deploy invariant (and to emit a clear console line on failure).
        require(d.gateway.hasRole(d.gateway.AGENT_ROLE(), d.agent), "agent missing AGENT_ROLE");
        require(!d.gateway.hasRole(d.gateway.ADMIN_ROLE(), d.agent), "agent has ADMIN_ROLE");
        require(!d.gateway.hasRole(d.gateway.PAUSER_ROLE(), d.agent), "agent has PAUSER_ROLE");
        require(d.gateway.hasRole(d.gateway.ADMIN_ROLE(), d.admin), "admin missing ADMIN_ROLE");
        require(d.gateway.hasRole(d.gateway.PAUSER_ROLE(), d.pauser), "pauser missing PAUSER_ROLE");

        // 4. Pin gateway runtime hash.
        //    Agent funding is the caller's responsibility — the smoke-test
        //    harness funds the agent via `Fixture::fund_usdc` (a real
        //    transfer from the genesis-allocated HARNESS_USDC_HOLDER), and
        //    forge unit tests mint via the `TestERC20` helper directly.
        d.gatewayRuntimeHash = keccak256(address(d.gateway).code);

        if (d.passthroughMode) {
            console2.log(
                "RobotMoneyVault + PassthroughAdapter (x3 alias) + RobotMoneyGateway deployed [USE_PASSTHROUGH_ADAPTER=true]"
            );
        } else {
            console2.log(
                "RobotMoneyVault + AaveV3Adapter + CompoundV3Adapter + MorphoAdapter + RobotMoneyGateway deployed"
            );
        }
        console2.log("  usdc             :", d.usdc);
        console2.log("  vault            :", address(d.vault));
        console2.log("  aave_adapter     :", address(d.aaveAdapter));
        console2.log("  compound_adapter :", address(d.compoundAdapter));
        console2.log("  morpho_adapter   :", address(d.morphoAdapter));
        console2.log("  gateway          :", address(d.gateway));
        console2.log("  admin            :", d.admin);
        console2.log("  pauser           :", d.pauser);
        console2.log("  agent            :", d.agent);
        console2.log("  shareReceiver    :", d.shareReceiver);
        console2.log("  agent USDC bal   :", IERC20(d.usdc).balanceOf(d.agent));
    }

    function _envOrDefault(string memory key, uint256 fallbackValue)
        internal
        view
        returns (uint256)
    {
        try vm.envUint(key) returns (uint256 v) {
            return v;
        } catch {
            return fallbackValue;
        }
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath;
        try vm.envString("DEPLOYMENT_OUT") returns (string memory s) {
            outPath = s;
        } catch {
            outPath = string.concat("deployments/", vm.toString(block.chainid), ".json");
        }

        string memory obj = "deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "usdc", d.usdc);
        vm.serializeAddress(obj, "vault", address(d.vault));
        vm.serializeAddress(obj, "aave_adapter", address(d.aaveAdapter));
        vm.serializeAddress(obj, "compound_adapter", address(d.compoundAdapter));
        vm.serializeAddress(obj, "morpho_adapter", address(d.morphoAdapter));
        vm.serializeAddress(obj, "gateway", address(d.gateway));
        vm.serializeAddress(obj, "admin", d.admin);
        vm.serializeAddress(obj, "pauser", d.pauser);
        vm.serializeAddress(obj, "agent", d.agent);
        vm.serializeAddress(obj, "share_receiver", d.shareReceiver);
        string memory json = vm.serializeBytes32(obj, "gateway_runtime_hash", d.gatewayRuntimeHash);

        vm.writeJson(json, outPath);
        console2.log("Wrote deployment JSON to", outPath);
    }
}
