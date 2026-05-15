// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §2.3 — Governance Boundary
// Implements: docs/implementation-plan.md "Router-weight governance" phase
// Implements: issue #365 (RM token drip in faucet tab)
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {RmToken} from "../RmToken.sol";

/// @title DeployRmToken
/// @notice Foundry deploy script for the RmToken ERC-20 contract.
///         Deploys RmToken, minting the entire initial supply to the harness
///         EOA (or a configured initial holder), and writes a deployment JSON
///         readable by the smoke-test fixture.
///
///         Required env vars:
///           INITIAL_HOLDER      — address that receives the entire initial supply
///
///         Optional env vars:
///           RM_TOKEN_NAME       — token name (default: "Robot Money Token")
///           RM_TOKEN_SYMBOL     — token symbol (default: "RM")
///           RM_TOKEN_SUPPLY     — initial supply in base units (default: 1_000_000 * 10^18)
///           DEPLOYMENT_OUT      — path for the output JSON
///                                 (default: "deployments/rm-token-<chain_id>.json")
contract DeployRmToken is Script {
    using stdJson for string;

    /// @notice Default initial supply: 1 000 000 RM (18 decimals).
    uint256 public constant DEFAULT_INITIAL_SUPPLY = 1_000_000 * 1e18;

    /// @notice Result struct returned to in-process callers.
    struct Deployed {
        RmToken token;
        address initialHolder;
        uint256 initialSupply;
    }

    /// @notice Forge broadcast entrypoint. Reads env vars, deploys RmToken,
    ///         and writes a deployment JSON.
    /// @return d Struct containing the deployed token and key parameters.
    function run() external returns (Deployed memory d) {
        address initialHolder = vm.envAddress("INITIAL_HOLDER");
        string memory tokenName = vm.envOr("RM_TOKEN_NAME", string("Robot Money Token"));
        string memory tokenSymbol = vm.envOr("RM_TOKEN_SYMBOL", string("RM"));
        uint256 initialSupply = vm.envOr("RM_TOKEN_SUPPLY", DEFAULT_INITIAL_SUPPLY);

        vm.startBroadcast();
        d = _deploy(tokenName, tokenSymbol, initialHolder, initialSupply);
        vm.stopBroadcast();

        _writeDeploymentJson(d);
    }

    /// @notice In-process variant for forge tests. No broadcast, no JSON written.
    function runInProcessWith(
        string memory name_,
        string memory symbol_,
        address initialHolder_,
        uint256 initialSupply_
    ) external returns (Deployed memory d) {
        require(initialHolder_ != address(0), "INITIAL_HOLDER=0");
        vm.startPrank(initialHolder_);
        d = _deploy(name_, symbol_, initialHolder_, initialSupply_);
        vm.stopPrank();
        _logResult(d);
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _deploy(
        string memory name_,
        string memory symbol_,
        address initialHolder_,
        uint256 initialSupply_
    ) internal returns (Deployed memory d) {
        d.initialHolder = initialHolder_;
        d.initialSupply = initialSupply_;
        d.token = new RmToken(name_, symbol_, initialHolder_, initialSupply_);
    }

    function _logResult(Deployed memory d) internal pure {
        console2.log("RmToken deployed");
        console2.log("  token         :", address(d.token));
        console2.log("  initialHolder :", d.initialHolder);
        console2.log("  initialSupply :", d.initialSupply);
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath;
        try vm.envString("DEPLOYMENT_OUT") returns (string memory s) {
            outPath = s;
        } catch {
            outPath = string.concat("deployments/rm-token-", vm.toString(block.chainid), ".json");
        }

        string memory obj = "rm_token_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "rm_token", address(d.token));
        vm.serializeAddress(obj, "initial_holder", d.initialHolder);
        string memory json = vm.serializeUint(obj, "initial_supply", d.initialSupply);

        vm.writeJson(json, outPath);
        console2.log("Wrote RmToken deployment JSON to", outPath);
    }
}
