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
        vm.setEnv(string.concat(prefix, "ADMIN_ADDRESS"), vm.toString(admin));
        vm.setEnv(string.concat(prefix, "PAUSER_ADDRESS"), vm.toString(makeAddr("inputs-pauser")));
        vm.setEnv(string.concat(prefix, "AGENT_ADDRESS"), vm.toString(makeAddr("inputs-agent")));
        vm.setEnv(
            string.concat(prefix, "SHARE_RECEIVER_ADDRESS"), vm.toString(makeAddr("inputs-recv"))
        );
        vm.setEnv(string.concat(prefix, "USDC_ADDRESS"), vm.toString(address(new TestERC20())));
    }

    // --- defaults are the devnet values --------------------------------------------------

    function test_defaults_areDevnetValues() public {
        string memory p = "RM_INPUTS_DEFAULTS_";
        _base(p);
        Deploy.Params memory r = h.readParams(p);
        assertEq(r.feeRecipient, admin, "default fee recipient is the admin (devnet only)");
        assertEq(r.tvlCap, h.DEFAULT_TVL_CAP(), "default tvl cap");
        assertEq(r.perDepositCap, h.DEFAULT_PER_DEPOSIT_CAP(), "default per-deposit cap");
        assertEq(r.exitFeeBps, 0, "default exit fee");
        assertEq(h.seed(p), h.SEED_DEPOSIT_AMOUNT(), "default seed");
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
}
