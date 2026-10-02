// SPDX-License-Identifier: MIT
// Canonical: docs/operations/contract-release-runbooks.md §4.2 — Preflight
// Implements: the devops mainnet-runbook review (2026-09-30), findings R-01, B6 and the seed decision;
//             core S1 (one deployment scheme): required inputs, strict chain guard.
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

    function deployWith(Params memory p) external returns (Deployed memory) {
        return _doDeploy(p);
    }

    function envOrDefault(string memory key, uint256 fallbackValue) external view returns (uint256) {
        return _envOrDefault(key, fallbackValue);
    }

    function requireChain(string memory prefix) external view {
        _requireExpectedChain(prefix);
    }
}

/// @notice The vault economics, the agent policy, the seed and the chain check are explicit
///         script inputs. Nothing falls back to a devnet default.
contract DeployMainnetInputsTest is Test {
    DeployInputsHarness internal h;
    address internal admin = makeAddr("inputs-admin");
    address internal treasury = makeAddr("inputs-treasury");

    function setUp() public {
        h = new DeployInputsHarness();
    }

    function _set(string memory prefix, string memory key, string memory value) internal {
        vm.setEnv(string.concat(prefix, key), value);
    }

    /// @dev Sets every required input under `prefix`.
    function _base(string memory prefix) internal {
        _set(prefix, "ADMIN_ADDRESS", vm.toString(admin));
        _set(prefix, "PAUSER_ADDRESS", vm.toString(makeAddr("inputs-pauser")));
        _set(prefix, "AGENT_ADDRESS", vm.toString(makeAddr("inputs-agent")));
        _set(prefix, "SHARE_RECEIVER_ADDRESS", vm.toString(makeAddr("inputs-recv")));
        _set(prefix, "FEE_RECIPIENT_ADDRESS", vm.toString(treasury));
        _set(prefix, "AGENT_VALID_UNTIL", vm.toString(block.timestamp + 30 days));
        _set(prefix, "AGENT_MAX_PER_PAYMENT", "10000000000");
        _set(prefix, "AGENT_MAX_PER_WINDOW", "100000000000");
        _set(prefix, "AGENT_MAX_WITHDRAW_PER_PAYMENT", "10000000000");
        _set(prefix, "AGENT_MAX_WITHDRAW_PER_WINDOW", "100000000000");
        _set(prefix, "VAULT_TVL_CAP", "2000000000000");
        _set(prefix, "VAULT_PER_DEPOSIT_CAP", "100000000000");
    }

    // --- explicit inputs are read ----------------------------------------------------------

    function test_inputs_areRead() public {
        string memory p = "RM_INPUTS_READ_";
        _base(p);
        _set(p, "VAULT_EXIT_FEE_BPS", "25");
        _set(p, "SEED_DEPOSIT_USDC", "1000000000");
        Deploy.Params memory r = h.readParams(p);
        assertEq(r.feeRecipient, treasury);
        assertEq(r.tvlCap, 2_000_000_000_000);
        assertEq(r.perDepositCap, 100_000_000_000);
        assertEq(r.maxPerPayment, 10_000_000_000);
        assertEq(r.exitFeeBps, 25);
        assertEq(r.usdcAddress, h.CANONICAL_BASE_USDC(), "USDC is the constant on every chain");
        assertEq(h.seed(p), 1_000_000_000, "seed override");
    }

    /// @notice The only optional values keep a default when unset.
    function test_optionalValues_defaultWhenUnset() public {
        string memory p = "RM_INPUTS_OPTIONAL_";
        _base(p);
        Deploy.Params memory r = h.readParams(p);
        assertEq(r.exitFeeBps, 0, "default exit fee");
        assertEq(h.seed(p), h.SEED_DEPOSIT_AMOUNT(), "default seed");
    }

    /// @notice The inputs reach the vault constructor: the fee recipient is no longer the deployer.
    function test_inputs_reachTheVault() public {
        string memory p = "RM_INPUTS_VAULT_";
        _base(p);
        _set(p, "VAULT_TVL_CAP", "7000000");
        _set(p, "VAULT_PER_DEPOSIT_CAP", "3000000");
        _set(p, "VAULT_EXIT_FEE_BPS", "10");
        Deploy.Params memory r = h.readParams(p);
        // The canonical USDC has no code on a bare test chain: bind a test token there.
        vm.etch(h.CANONICAL_BASE_USDC(), address(new TestERC20()).code);
        Deploy.Deployed memory d = h.deployWith(r);
        assertEq(d.vault.feeRecipient(), treasury, "vault fee recipient");
        assertTrue(d.vault.feeRecipient() != admin, "fee recipient must not be the deployer");
        assertEq(d.vault.tvlCap(), 7_000_000);
        assertEq(d.vault.perDepositCap(), 3_000_000);
        assertEq(d.vault.exitFeeBps(), 10);
    }

    // --- missing required inputs revert (on every chain) -------------------------------------

    function _assertMissing(string memory p, string memory key) internal {
        _base(p);
        // A name no test sets: point the reader at a prefix whose `key` is absent.
        string memory q = string.concat(p, "MISSING_");
        _copyAllExcept(p, q, key);
        vm.expectRevert(bytes(string.concat(q, key, " must be set")));
        h.readParams(q);
    }

    function _copyAllExcept(string memory from, string memory to, string memory skip) internal {
        string[12] memory keys = [
            "ADMIN_ADDRESS",
            "PAUSER_ADDRESS",
            "AGENT_ADDRESS",
            "SHARE_RECEIVER_ADDRESS",
            "FEE_RECIPIENT_ADDRESS",
            "AGENT_VALID_UNTIL",
            "AGENT_MAX_PER_PAYMENT",
            "AGENT_MAX_PER_WINDOW",
            "AGENT_MAX_WITHDRAW_PER_PAYMENT",
            "AGENT_MAX_WITHDRAW_PER_WINDOW",
            "VAULT_TVL_CAP",
            "VAULT_PER_DEPOSIT_CAP"
        ];
        for (uint256 i = 0; i < keys.length; i++) {
            if (keccak256(bytes(keys[i])) == keccak256(bytes(skip))) continue;
            vm.setEnv(string.concat(to, keys[i]), vm.envString(string.concat(from, keys[i])));
        }
    }

    function test_missingFeeRecipient_reverts() public {
        _assertMissing("RM_INPUTS_M_FEE_", "FEE_RECIPIENT_ADDRESS");
    }

    function test_missingTvlCap_reverts() public {
        _assertMissing("RM_INPUTS_M_TVL_", "VAULT_TVL_CAP");
    }

    function test_missingPerDepositCap_reverts() public {
        _assertMissing("RM_INPUTS_M_PDC_", "VAULT_PER_DEPOSIT_CAP");
    }

    function test_missingAgentMaxPerPayment_reverts() public {
        _assertMissing("RM_INPUTS_M_AMP_", "AGENT_MAX_PER_PAYMENT");
    }

    function test_missingAgentMaxPerWindow_reverts() public {
        _assertMissing("RM_INPUTS_M_AMW_", "AGENT_MAX_PER_WINDOW");
    }

    function test_missingAgentWithdrawCaps_revert() public {
        _assertMissing("RM_INPUTS_M_AWP_", "AGENT_MAX_WITHDRAW_PER_PAYMENT");
        _assertMissing("RM_INPUTS_M_AWW_", "AGENT_MAX_WITHDRAW_PER_WINDOW");
    }

    function test_missingAgentValidUntil_reverts() public {
        _assertMissing("RM_INPUTS_M_AVU_", "AGENT_VALID_UNTIL");
    }

    // --- malformed values revert -------------------------------------------------------------

    function test_malformedCap_reverts() public {
        string memory p = "RM_INPUTS_BAD_CAP_";
        _base(p);
        _set(p, "VAULT_TVL_CAP", "ten-million");
        vm.expectRevert(
            bytes("RM_INPUTS_BAD_CAP_VAULT_TVL_CAP is malformed: expected an unsigned integer")
        );
        h.readParams(p);
    }

    function test_malformedFeeRecipient_reverts() public {
        string memory p = "RM_INPUTS_BAD_FEE_";
        _base(p);
        _set(p, "FEE_RECIPIENT_ADDRESS", "treasury");
        vm.expectRevert(
            bytes("RM_INPUTS_BAD_FEE_FEE_RECIPIENT_ADDRESS is malformed: expected an address")
        );
        h.readParams(p);
    }

    function test_malformedAgentCap_reverts() public {
        string memory p = "RM_INPUTS_BAD_AGENT_";
        _base(p);
        _set(p, "AGENT_MAX_PER_WINDOW", "-5");
        vm.expectRevert(
            bytes("RM_INPUTS_BAD_AGENT_AGENT_MAX_PER_WINDOW is malformed: expected an unsigned integer")
        );
        h.readParams(p);
    }

    /// @notice `_envOrDefault` reverts on a malformed value instead of using the default.
    function test_envOrDefault_revertsOnBadInput() public {
        _set("RM_INPUTS_EOD_", "EXIT", "abc");
        vm.expectRevert(bytes("RM_INPUTS_EOD_EXIT is malformed: expected an unsigned integer"));
        h.envOrDefault("RM_INPUTS_EOD_EXIT", 7);
    }

    function test_envOrDefault_usesDefaultOnlyWhenUnset() public view {
        assertEq(h.envOrDefault("RM_INPUTS_EOD_NEVER_SET", 7), 7);
    }

    function test_malformedExitFee_reverts() public {
        string memory p = "RM_INPUTS_BAD_EXIT_";
        _base(p);
        _set(p, "VAULT_EXIT_FEE_BPS", "five");
        vm.expectRevert(
            bytes("RM_INPUTS_BAD_EXIT_VAULT_EXIT_FEE_BPS is malformed: expected an unsigned integer")
        );
        h.readParams(p);
    }

    // --- refusals ------------------------------------------------------------------------

    function test_zeroSeed_reverts() public {
        string memory p = "RM_INPUTS_ZERO_SEED_";
        _set(p, "SEED_DEPOSIT_USDC", "0");
        vm.expectRevert(bytes("SEED_DEPOSIT_USDC=0"));
        h.seed(p);
    }

    function test_zeroFeeRecipient_reverts() public {
        string memory p = "RM_INPUTS_ZERO_FEE_";
        _base(p);
        _set(p, "FEE_RECIPIENT_ADDRESS", vm.toString(address(0)));
        Deploy.Params memory r = h.readParams(p);
        vm.etch(h.CANONICAL_BASE_USDC(), address(new TestERC20()).code);
        vm.expectRevert(bytes("FEE_RECIPIENT_ADDRESS=0"));
        h.deployWith(r);
    }

    function test_zeroCaps_revert() public {
        string memory p = "RM_INPUTS_ZERO_CAP_";
        _base(p);
        _set(p, "VAULT_TVL_CAP", "0");
        Deploy.Params memory r = h.readParams(p);
        vm.etch(h.CANONICAL_BASE_USDC(), address(new TestERC20()).code);
        vm.expectRevert(bytes("VAULT_TVL_CAP / VAULT_PER_DEPOSIT_CAP = 0"));
        h.deployWith(r);
    }

    // --- strict chain guard ----------------------------------------------------------------

    function test_wrongExpectedChain_reverts() public {
        string memory p = "RM_INPUTS_CHAIN_";
        _base(p);
        _set(p, "EXPECTED_CHAIN_ID", vm.toString(block.chainid + 1));
        vm.expectRevert(bytes("EXPECTED_CHAIN_ID does not match the RPC's chain id"));
        h.readParams(p);
    }

    function test_matchingExpectedChain_passes() public {
        string memory p = "RM_INPUTS_CHAIN_OK_";
        _base(p);
        _set(p, "EXPECTED_CHAIN_ID", vm.toString(block.chainid));
        h.readParams(p); // does not revert
    }

    /// @notice On chain id 8453 an unset EXPECTED_CHAIN_ID reverts.
    function test_baseMainnet_unsetExpectedChain_reverts() public {
        vm.chainId(8453);
        vm.expectRevert(bytes("EXPECTED_CHAIN_ID must be set to 8453 on Base mainnet"));
        h.requireChain("RM_INPUTS_BASE_UNSET_");
    }

    function test_baseMainnet_otherExpectedChain_reverts() public {
        vm.chainId(8453);
        _set("RM_INPUTS_BASE_OTHER_", "EXPECTED_CHAIN_ID", "31337");
        vm.expectRevert(bytes("EXPECTED_CHAIN_ID must be set to 8453 on Base mainnet"));
        h.requireChain("RM_INPUTS_BASE_OTHER_");
    }

    function test_baseMainnet_matchingExpectedChain_passes() public {
        vm.chainId(8453);
        _set("RM_INPUTS_BASE_OK_", "EXPECTED_CHAIN_ID", "8453");
        h.requireChain("RM_INPUTS_BASE_OK_");
    }

    /// @notice Off 8453 an unset EXPECTED_CHAIN_ID is allowed (Twin chain, anvil).
    function test_twinChain_unsetExpectedChain_passes() public {
        vm.chainId(918453);
        h.requireChain("RM_INPUTS_TWIN_UNSET_");
    }
}
