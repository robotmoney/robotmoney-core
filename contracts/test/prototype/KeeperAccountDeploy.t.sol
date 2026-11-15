// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md E56 (the deploy tool records the keeper account), E47;
//            docs/technical/one-vault-rebalancer-proposal.md D36
// Experiment prototype only (contracts/test/prototype/). Not a production test.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KeeperAccount} from "./src/KeeperAccount.sol";
import {DeployKeeperAccount} from "../../script/DeployKeeperAccount.s.sol";

/// @title KeeperAccountDeployTest
/// @notice The keeper-account deploy script: the address is predictable before the sheet is final, a wrong
///         KEEPER_ADDRESS is refused, and the manifest records the owners and bot keys. No fork state is read.
contract KeeperAccountDeployTest is Test {
    /// @dev A constant, so the fixture recorder can key the read below.
    string internal constant OUT = "deployments/keeper-account-deploy-test.json";
    address internal ownerA = makeAddr("ownerA");
    address internal ownerB = makeAddr("ownerB");
    address internal bot1 = makeAddr("bot1");

    function _env(string memory out) internal {
        vm.setEnv("EXPECTED_CHAIN_ID", vm.toString(block.chainid));
        vm.setEnv("KEEPER_OWNERS", string.concat(vm.toString(ownerA), ",", vm.toString(ownerB)));
        vm.setEnv("KEEPER_BOT_KEYS", vm.toString(bot1));
        vm.setEnv("KEEPER_SALT", vm.toString(bytes32(uint256(0xbeef))));
        vm.setEnv("DEPLOYMENT_OUT", out);
        vm.setEnv("PREDICT_ONLY", "false");
        vm.setEnv("KEEPER_ADDRESS", "0x0000000000000000000000000000000000000000");
    }

    function test_E56_theScriptDeploysAtThePredictedAddressRecordsItAndRefusesAnotherKeeper()
        public
    {
        string memory out = OUT;
        _env(out);
        DeployKeeperAccount s = new DeployKeeperAccount();

        vm.setEnv("PREDICT_ONLY", "true");
        address predicted = s.run();
        assertEq(predicted.code.length, 0, "predicting deploys nothing");

        vm.setEnv("PREDICT_ONLY", "false");
        vm.setEnv("KEEPER_ADDRESS", vm.toString(predicted));
        address account = s.run();
        assertEq(account, predicted, "deployed at the predicted address");
        assertGt(account.code.length, 0, "the account has code");
        address[] memory o = KeeperAccount(account).owners();
        assertEq(o.length, 2, "two owners");
        assertEq(KeeperAccount(account).botKeys()[0], bot1, "the bot key");

        string memory json = vm.readFile(OUT);
        assertEq(vm.parseJsonAddress(json, ".keeper_account"), account, "manifest: account");
        assertEq(vm.parseJsonAddressArray(json, ".owners").length, 2, "manifest: owners");
        assertEq(vm.parseJsonAddressArray(json, ".bot_keys")[0], bot1, "manifest: bot keys");

        // A rerun finds the account and changes nothing.
        assertEq(s.run(), account, "a rerun is idempotent");
        vm.removeFile(out);

        // A KEEPER_ADDRESS that is not this account is refused. (One test: the process env is shared by all tests.)
        vm.setEnv("KEEPER_ADDRESS", vm.toString(makeAddr("someEoa")));
        vm.expectRevert(
            bytes("KEEPER_ADDRESS is not the keeper account these owners, bot keys and salt give")
        );
        s.run();
    }
}
