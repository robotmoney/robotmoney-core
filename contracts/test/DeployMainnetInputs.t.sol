// SPDX-License-Identifier: MIT
// Canonical: docs/operations/contract-release-runbooks.md §4.2 — Preflight
// Implements: the devops mainnet-runbook review (2026-09-30), findings R-01, B6 and the seed decision.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev Exposes the script's internal env readers and deploy step. Every test below uses a
///      prefix of its own, because env vars are process-wide and forge runs test contracts
///      in parallel (see the note in Deploy.t.sol on the ADMIN_ADDRESS race).
contract DeployInputsHarness is Deploy {
    function readParams(string memory prefix) external view returns (Params memory) {
        return _readEnvParamsFrom(prefix);
    }

    function seed(string memory prefix) external view returns (uint256) {
        return _seedAmount(prefix);
    }

    function envOrDefault(string memory key, uint256 fallbackValue)
        external
        view
        returns (uint256)
    {
        return _envOrDefault(key, fallbackValue);
    }

    function deployWith(Params memory p) external returns (Deployed memory) {
        return _doDeploy(p);
    }
}

/// @notice The vault economics, the seed and the chain check are explicit script inputs.
contract DeployMainnetInputsTest is Test {
    DeployInputsHarness internal h;
    address internal admin = makeAddr("inputs-admin");
    address internal treasury = makeAddr("inputs-treasury");

    function setUp() public {
        h = new DeployInputsHarness();
    }

    function _base(string memory prefix) internal {
        _baseExcept(prefix, "");
    }

    /// @dev Sets every input under `prefix` except `skip`. vm.setEnv cannot unset a variable,
    ///      so a missing input is modelled by a prefix under which it was never written.
    function _baseExcept(string memory prefix, string memory skip) internal {
        _set(prefix, skip, "ADMIN_ADDRESS", vm.toString(admin));
        _set(prefix, skip, "PAUSER_ADDRESS", vm.toString(makeAddr("inputs-pauser")));
        _set(prefix, skip, "AGENT_ADDRESS", vm.toString(makeAddr("inputs-agent")));
        _set(prefix, skip, "SHARE_RECEIVER_ADDRESS", vm.toString(makeAddr("inputs-recv")));
        _set(prefix, skip, "USDC_ADDRESS", vm.toString(address(new TestERC20())));
        // Every vault, fee and agent input the sheet carries. None has a default.
        _set(prefix, skip, "FEE_RECIPIENT_ADDRESS", vm.toString(admin));
        _set(prefix, skip, "VAULT_TVL_CAP", "10000000000000");
        _set(prefix, skip, "VAULT_PER_DEPOSIT_CAP", "1000000000000");
        _set(prefix, skip, "AGENT_VALID_UNTIL", "4102444800");
        _set(prefix, skip, "AGENT_MAX_PER_PAYMENT", "10000000000");
        _set(prefix, skip, "AGENT_MAX_PER_WINDOW", "100000000000");
        _set(prefix, skip, "AGENT_MAX_WITHDRAW_PER_PAYMENT", "10000000000");
        _set(prefix, skip, "AGENT_MAX_WITHDRAW_PER_WINDOW", "100000000000");
        _set(prefix, skip, "SEED_DEPOSIT_USDC", "1000000");
    }

    function _set(string memory prefix, string memory skip, string memory name, string memory value)
        internal
    {
        if (keccak256(bytes(skip)) == keccak256(bytes(name))) return;
        vm.setEnv(string.concat(prefix, name), value);
    }

    // --- nothing has a default ----------------------------------------------------------

    function test_exitFee_defaultsToZero_theOneOptionalInput() public {
        string memory p = "RM_INPUTS_DEFAULTS_";
        _base(p);
        Deploy.Params memory r = h.readParams(p);
        assertEq(r.exitFeeBps, 0, "default exit fee");
        assertEq(r.feeRecipient, admin, "fee recipient is the one the sheet named");
    }

    function test_missingInputs_revertOnEveryChain() public {
        string[9] memory names = [
            "AGENT_VALID_UNTIL",
            "AGENT_MAX_PER_PAYMENT",
            "AGENT_MAX_PER_WINDOW",
            "AGENT_MAX_WITHDRAW_PER_PAYMENT",
            "AGENT_MAX_WITHDRAW_PER_WINDOW",
            "FEE_RECIPIENT_ADDRESS",
            "VAULT_TVL_CAP",
            "VAULT_PER_DEPOSIT_CAP",
            "SEED_DEPOSIT_USDC"
        ];
        uint256[2] memory chains = [uint256(31337), uint256(918453)];
        for (uint256 c = 0; c < chains.length; c++) {
            vm.chainId(chains[c]);
            for (uint256 i = 0; i < names.length; i++) {
                // A prefix under which every input is set except names[i].
                string memory p =
                    string.concat("RM_INPUTS_REQ_", vm.toString(c), "_", vm.toString(i), "_");
                _baseExcept(p, names[i]);
                bytes memory expected = bytes(string.concat(p, names[i], " must be set"));
                vm.expectRevert(expected);
                if (keccak256(bytes(names[i])) == keccak256("SEED_DEPOSIT_USDC")) {
                    h.seed(p);
                } else {
                    h.readParams(p);
                }
            }
        }
    }

    function test_malformedInputs_revert() public {
        string[8] memory names = [
            "AGENT_VALID_UNTIL",
            "AGENT_MAX_PER_PAYMENT",
            "AGENT_MAX_PER_WINDOW",
            "AGENT_MAX_WITHDRAW_PER_PAYMENT",
            "AGENT_MAX_WITHDRAW_PER_WINDOW",
            "VAULT_TVL_CAP",
            "VAULT_PER_DEPOSIT_CAP",
            "SEED_DEPOSIT_USDC"
        ];
        for (uint256 i = 0; i < names.length; i++) {
            string memory p = string.concat("RM_INPUTS_BAD_", vm.toString(i), "_");
            _base(p);
            vm.setEnv(string.concat(p, names[i]), "twelve");
            vm.expectRevert(
                bytes(string.concat(p, names[i], " is malformed: expected an unsigned integer"))
            );
            if (keccak256(bytes(names[i])) == keccak256("SEED_DEPOSIT_USDC")) {
                h.seed(p);
            } else {
                h.readParams(p);
            }
        }
    }

    function test_malformedFeeRecipient_reverts() public {
        string memory p = "RM_INPUTS_BAD_FEE_";
        _base(p);
        vm.setEnv(string.concat(p, "FEE_RECIPIENT_ADDRESS"), "treasury");
        vm.expectRevert(
            bytes(string.concat(p, "FEE_RECIPIENT_ADDRESS is malformed: expected an address"))
        );
        h.readParams(p);
    }

    // --- _envOrDefault reverts on bad input ----------------------------------------------

    function test_envOrDefault_unsetUsesFallback() public view {
        assertEq(h.envOrDefault("RM_INPUTS_ENV_OR_DEFAULT_NEVER_SET", 7), 7);
    }

    function test_envOrDefault_setIsRead() public {
        vm.setEnv("RM_INPUTS_ENV_OR_DEFAULT_SET", "9");
        assertEq(h.envOrDefault("RM_INPUTS_ENV_OR_DEFAULT_SET", 7), 9);
    }

    function test_envOrDefault_malformedReverts() public {
        vm.setEnv("RM_INPUTS_ENV_OR_DEFAULT_BAD", "nine");
        vm.expectRevert(
            bytes("RM_INPUTS_ENV_OR_DEFAULT_BAD is malformed: expected an unsigned integer")
        );
        h.envOrDefault("RM_INPUTS_ENV_OR_DEFAULT_BAD", 7);
    }

    // --- explicit inputs win -------------------------------------------------------------

    function test_overrides_areRead() public {
        string memory p = "RM_INPUTS_OVERRIDE_";
        _base(p);
        vm.setEnv(string.concat(p, "FEE_RECIPIENT_ADDRESS"), vm.toString(treasury));
        vm.setEnv(string.concat(p, "VAULT_TVL_CAP"), "2000000000000");
        vm.setEnv(string.concat(p, "VAULT_PER_DEPOSIT_CAP"), "100000000000");
        vm.setEnv(string.concat(p, "VAULT_EXIT_FEE_BPS"), "25");
        vm.setEnv(string.concat(p, "SEED_DEPOSIT_USDC"), "1000000000");
        Deploy.Params memory r = h.readParams(p);
        assertEq(r.feeRecipient, treasury);
        assertEq(r.tvlCap, 2_000_000_000_000);
        assertEq(r.perDepositCap, 100_000_000_000);
        assertEq(r.exitFeeBps, 25);
        assertEq(h.seed(p), 1_000_000_000, "seed override");
    }

    /// @notice The inputs reach the vault constructor: the fee recipient is no longer the deployer.
    function test_inputs_reachTheVault() public {
        string memory p = "RM_INPUTS_VAULT_";
        _base(p);
        vm.setEnv(string.concat(p, "FEE_RECIPIENT_ADDRESS"), vm.toString(treasury));
        vm.setEnv(string.concat(p, "VAULT_TVL_CAP"), "7000000");
        vm.setEnv(string.concat(p, "VAULT_PER_DEPOSIT_CAP"), "3000000");
        vm.setEnv(string.concat(p, "VAULT_EXIT_FEE_BPS"), "10");
        Deploy.Params memory r = h.readParams(p);
        Deploy.Deployed memory d = h.deployWith(r);
        assertEq(d.vault.feeRecipient(), treasury, "vault fee recipient");
        assertTrue(d.vault.feeRecipient() != admin, "fee recipient must not be the deployer");
        assertEq(d.vault.tvlCap(), 7_000_000);
        assertEq(d.vault.perDepositCap(), 3_000_000);
        assertEq(d.vault.exitFeeBps(), 10);
    }

    // --- refusals ------------------------------------------------------------------------

    function test_zeroSeed_reverts() public {
        string memory p = "RM_INPUTS_ZERO_SEED_";
        vm.setEnv(string.concat(p, "SEED_DEPOSIT_USDC"), "0");
        vm.expectRevert(bytes("SEED_DEPOSIT_USDC=0"));
        h.seed(p);
    }

    function test_zeroFeeRecipient_reverts() public {
        string memory p = "RM_INPUTS_ZERO_FEE_";
        _base(p);
        vm.setEnv(string.concat(p, "FEE_RECIPIENT_ADDRESS"), vm.toString(address(0)));
        Deploy.Params memory r = h.readParams(p);
        vm.expectRevert(bytes("FEE_RECIPIENT_ADDRESS=0"));
        h.deployWith(r);
    }

    function test_zeroCaps_revert() public {
        string memory p = "RM_INPUTS_ZERO_CAP_";
        _base(p);
        vm.setEnv(string.concat(p, "VAULT_TVL_CAP"), "0");
        Deploy.Params memory r = h.readParams(p);
        vm.expectRevert(bytes("VAULT_TVL_CAP / VAULT_PER_DEPOSIT_CAP = 0"));
        h.deployWith(r);
    }

    function test_wrongExpectedChain_reverts() public {
        string memory p = "RM_INPUTS_CHAIN_";
        _base(p);
        vm.setEnv(string.concat(p, "EXPECTED_CHAIN_ID"), vm.toString(block.chainid + 1));
        vm.expectRevert(bytes("EXPECTED_CHAIN_ID does not match the RPC's chain id"));
        h.readParams(p);
    }

    function test_matchingExpectedChain_passes() public {
        string memory p = "RM_INPUTS_CHAIN_OK_";
        _base(p);
        vm.setEnv(string.concat(p, "EXPECTED_CHAIN_ID"), vm.toString(block.chainid));
        h.readParams(p); // does not revert
    }

    // --- chain id 8453: the guard is strict, USDC is the canonical one ---------------------

    string internal constant BASE_MSG = "EXPECTED_CHAIN_ID must be set to 8453 on Base mainnet";

    function test_base_unsetExpectedChain_reverts() public {
        vm.chainId(8453);
        string memory p = "RM_INPUTS_BASE_UNSET_";
        _base(p);
        vm.expectRevert(bytes(BASE_MSG));
        h.readParams(p);
    }

    function test_base_zeroOrWrongExpectedChain_reverts() public {
        vm.chainId(8453);
        string memory p = "RM_INPUTS_BASE_WRONG_";
        _base(p);
        vm.setEnv(string.concat(p, "EXPECTED_CHAIN_ID"), "0");
        vm.expectRevert(bytes(BASE_MSG));
        h.readParams(p);
        vm.setEnv(string.concat(p, "EXPECTED_CHAIN_ID"), "918453");
        vm.expectRevert(bytes(BASE_MSG));
        h.readParams(p);
    }

    function test_base_nonCanonicalUsdc_reverts() public {
        vm.chainId(8453);
        string memory p = "RM_INPUTS_BASE_USDC_";
        _base(p);
        vm.setEnv(string.concat(p, "EXPECTED_CHAIN_ID"), "8453");
        vm.expectRevert(bytes("USDC_ADDRESS is not the canonical Base USDC on Base mainnet"));
        h.readParams(p);
    }

    function test_base_canonicalUsdcAndExpectedChain_passes() public {
        vm.chainId(8453);
        string memory p = "RM_INPUTS_BASE_OK_";
        _base(p);
        vm.setEnv(string.concat(p, "EXPECTED_CHAIN_ID"), "8453");
        vm.setEnv(string.concat(p, "USDC_ADDRESS"), vm.toString(h.CANONICAL_BASE_USDC()));
        h.readParams(p);
    }

    function test_twin_unsetExpectedChain_passes() public {
        vm.chainId(918453);
        string memory p = "RM_INPUTS_TWIN_";
        _base(p);
        h.readParams(p);
    }
}
