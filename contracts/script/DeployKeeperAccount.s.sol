// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md E56 (the keeper account), E47 (the verifier reads it);
//            docs/technical/one-vault-rebalancer-proposal.md D36
// Deploy 4 (owner exception 2026-11-12): the one-vault prototype through the real deploy tool, as a rehearsal.
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {KeeperAccount} from "../KeeperAccount.sol";
import {FundSystemBase} from "./FundSystemBase.sol";

/// @title DeployKeeperAccount
/// @notice Deploys the keeper smart account (E56) at a CREATE2 address, before the sheet is final. The queue and the
///         rebalancer take the keeper at initialization, so the sheet's KEEPER_ADDRESS must already be this account.
///         The address is fixed by the salt, the owners and the bot keys. Run with `PREDICT_ONLY=true` to print it
///         without broadcasting. The deploy stages check that KEEPER_ADDRESS holds KEEPER_ROLE, and the wiring stage
///         records the account's type, owners and bot keys in its manifest. The verifier compares them with the sheet.
///
///         Required env vars: KEEPER_OWNERS, KEEPER_BOT_KEYS (comma lists; KEEPER_BOT_KEYS may be `none`), KEEPER_SALT
///         (a bytes32), DEPLOYMENT_OUT. Optional: KEEPER_ADDRESS (must equal the predicted address), PREDICT_ONLY.
contract DeployKeeperAccount is FundSystemBase {
    /// @notice Manifest file name the operator gives DEPLOYMENT_OUT.
    string public constant MANIFEST_FILE = "keeper-account.json";

    function run() external returns (address account) {
        _requireExpectedChain("");
        address[] memory owners = vm.envAddress("KEEPER_OWNERS", ",");
        address[] memory bots = _botKeys();
        bytes32 salt = vm.envBytes32("KEEPER_SALT");
        bytes memory initCode =
            abi.encodePacked(type(KeeperAccount).creationCode, abi.encode(owners, bots));
        address predicted = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_FACTORY);
        console2.log("keeper account address", predicted);
        if (vm.envOr("KEEPER_ADDRESS", address(0)) != address(0)) {
            require(
                vm.envAddress("KEEPER_ADDRESS") == predicted,
                "KEEPER_ADDRESS is not the keeper account these owners, bot keys and salt give"
            );
        }
        if (vm.envOr("PREDICT_ONLY", false)) return predicted;
        _envStringRequired("DEPLOYMENT_OUT");

        if (predicted.code.length == 0) {
            vm.startBroadcast();
            account = address(new KeeperAccount{salt: salt}(owners, bots));
            vm.stopBroadcast();
            require(account == predicted, "keeper account: CREATE2 address differs");
        } else {
            account = predicted;
        }
        KeeperAccount k = KeeperAccount(account);
        require(
            keccak256(abi.encode(k.owners())) == keccak256(abi.encode(owners)),
            "keeper account: owners"
        );
        require(
            keccak256(abi.encode(k.botKeys())) == keccak256(abi.encode(bots)),
            "keeper account: bot keys"
        );
        _writeDeploymentJson(account, owners, bots, salt);
    }

    function _botKeys() internal view returns (address[] memory) {
        string memory raw = vm.envString("KEEPER_BOT_KEYS");
        if (keccak256(bytes(raw)) == keccak256("none")) return new address[](0);
        return vm.envAddress("KEEPER_BOT_KEYS", ",");
    }

    function _writeDeploymentJson(
        address account,
        address[] memory owners,
        address[] memory bots,
        bytes32 salt
    ) internal {
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");
        string memory obj = "keeper_account";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeBytes32(obj, "salt", salt);
        vm.serializeAddress(obj, "owners", owners);
        vm.serializeAddress(obj, "bot_keys", bots);
        string memory json = vm.serializeAddress(obj, "keeper_account", account);
        vm.writeJson(json, outPath);
        console2.log("Wrote keeper-account JSON to", outPath);
    }
}
