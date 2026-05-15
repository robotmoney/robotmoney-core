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
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";

/// @title Deploy
/// @notice Foundry deploy script for the Robot Money gateway stack.
///         Deploys RobotMoneyVault + PassthroughAdapter as the primary vault,
///         wires a RobotMoneyGateway to the vault, grants AGENT_ROLE to a
///         distinct EOA via `authorizeAgent`, asserts role-separation, and
///         writes a deployment JSON.
///
///         MockVault is NOT deployed by this script; it is only used by
///         gateway deposit-routing unit tests directly. See issue #277.
///         The vault deploys with exitFeeBps=0 and a single PassthroughAdapter
///         (no external calls) suitable for the smoke-test devnet.
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
///        AGENT_VALID_UNTIL      — uint64, default = block.timestamp + 30 days
///        AGENT_MAX_PER_PAYMENT  — uint256, default = 10_000 * 1e6 (USDC, 6dp)
///        AGENT_MAX_PER_WINDOW   — uint256, default = 100_000 * 1e6
///        DEPLOYMENT_OUT         — output JSON path,
///                                 default = "deployments/<chain_id>.json"
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
    ///      `adapter` is the PassthroughAdapter wired into vault at deploy time.
    struct Deployed {
        address usdc;
        RobotMoneyVault vault;
        PassthroughAdapter adapter;
        RobotMoneyGateway gateway;
        address admin;
        address pauser;
        address agent;
        address shareReceiver;
        bytes32 gatewayRuntimeHash;
    }

    /// @notice Canonical Base mainnet USDC (FiatTokenProxy). The smoke-test
    ///         devnet seeds this address with real proxy storage + the
    ///         FiatTokenV2_2 implementation in genesis alloc.
    address public constant CANONICAL_BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// @notice Default per-payment cap if `AGENT_MAX_PER_PAYMENT` is unset.
    uint256 public constant DEFAULT_MAX_PER_PAYMENT = 10_000 * 1e6;
    /// @notice Default per-window cap if `AGENT_MAX_PER_WINDOW` is unset.
    uint256 public constant DEFAULT_MAX_PER_WINDOW = 100_000 * 1e6;
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
        // the addAdapter call is d.admin which holds ADMIN_ROLE.  No vm.prank
        // is required — and vm.prank is prohibited inside startBroadcast.
        d.vault.addAdapter(address(d.adapter), 10_000);
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
        vm.prank(d.admin);
        d.vault.addAdapter(address(d.adapter), 10_000);
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
        p.usdcAddress = usdc_;
        d = _doDeploy(p);
        // In-process (no broadcast): addAdapter requires ADMIN_ROLE which is
        // held by d.admin. Use vm.prank to call it as d.admin.
        vm.prank(d.admin);
        d.vault.addAdapter(address(d.adapter), 10_000);
    }

    struct Params {
        address admin;
        address pauser;
        address agent;
        address shareReceiver;
        uint64 validUntil;
        uint256 maxPerPayment;
        uint256 maxPerWindow;
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
        p.usdcAddress = vm.envAddress("USDC_ADDRESS");
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
        //    vault. Deployed with exitFeeBps=0 and a PassthroughAdapter that
        //    holds USDC with no external protocol calls — suitable for the
        //    smoke-test devnet. MockVault is retained in the codebase only for
        //    gateway deposit-routing unit tests.
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
        //    helpers (runInProcessWith / runInProcess) the caller wraps
        //    _wireAdapter with vm.prank(d.admin) — see those callers.
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
        // Deploy PassthroughAdapter.  Registration (addAdapter) is done by
        // the callers of _doDeploy — see run(), runInProcess(), and
        // runInProcessWith() — because the caller context differs between
        // broadcast and in-process test modes.
        d.adapter = new PassthroughAdapter(d.usdc, address(d.vault));
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
        IGateway.AgentPolicy memory policy = IGateway.AgentPolicy({
            active: true,
            validUntil: p.validUntil,
            maxPerPayment: p.maxPerPayment,
            maxPerWindow: p.maxPerWindow,
            shareReceiver: d.shareReceiver,
            allowedDestinations: noDestinations,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
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

        console2.log("RobotMoneyVault + PassthroughAdapter + RobotMoneyGateway deployed");
        console2.log("  usdc           :", d.usdc);
        console2.log("  vault          :", address(d.vault));
        console2.log("  adapter        :", address(d.adapter));
        console2.log("  gateway        :", address(d.gateway));
        console2.log("  admin          :", d.admin);
        console2.log("  pauser         :", d.pauser);
        console2.log("  agent          :", d.agent);
        console2.log("  shareReceiver  :", d.shareReceiver);
        console2.log("  agent USDC bal :", IERC20(d.usdc).balanceOf(d.agent));
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
        vm.serializeAddress(obj, "adapter", address(d.adapter));
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
