// SPDX-License-Identifier: MIT
// Canonical: scripts/deploy/stage-table.json vaults[].deployPaused (issue 1705 Q1 (a), core 1710)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {ForkSelect} from "./helpers/ForkSelect.sol";
import {VaultTestParams} from "./helpers/VaultTestParams.sol";
import {DeployVault} from "../script/DeployVault.s.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {DeployProtocolAssetVault} from "../script/DeployProtocolAssetVault.s.sol";
import {DeployRwaBasketVault} from "../script/DeployRwaBasketVault.s.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";

interface IDepositsPaused {
    function depositsPaused() external view returns (bool);
}

/// @notice Issue 1705, ADR-0017: the three production vault deploy scripts run in process, and each vault's
///         `depositsPaused()` right after its stage equals the stage table's `deployPaused` for that
///         vault (scripts/deploy/stage-table.json, the one rule table). rmUSDC runs the seeded path
///         the broadcast run takes (the pause follows the seed), the baskets run their in-process
///         entry point. The table row is matched to the script by its `stage` name.
///
///         Runs on the Twin chain (a pinned lazy anvil fork of real Base state): the vault scripts
///         need the real USDC, lending venues and pools. CI runs it in forge-fork-vault-regressions
///         through scripts/devnet/forge-fork-tests.ts, which fails a run in which nothing executed.
///         With FORK_RPC_URL unset the test skips with a named reason.
contract ThreeVaultInitialStateForkTest is Test {
    using stdJson for string;

    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    string internal constant TABLE = "scripts/deploy/stage-table.json";

    address internal admin = makeAddr("admin");
    bool internal selected;

    function setUp() public {
        selected = ForkSelect.selectOrSkip(vm.envOr("FORK_RPC_URL", string("")));
    }

    function _basketParams(VaultRegistry registry)
        internal
        returns (BasketVaultDeployBase.Params memory)
    {
        return BasketVaultDeployBase.Params({
            admin: admin,
            swapRouter: 0x2626664c2603336E57B271c5C0b26F421741e481,
            usdc: USDC,
            registry: address(registry),
            tvlCap: 100_000 * 1e6,
            perDepositCap: 10_000 * 1e6,
            exitFeeBps: 0,
            feeRecipient: makeAddr("feeRecipient"),
            navDeviationGuardBps: 2000,
            minPoolLiquidity: 1e6,
            recorder: address(0)
        });
    }

    /// @dev Runs the vault stage named `stage` in process and returns the vault it deployed.
    function _deploy(string memory stage, VaultRegistry registry) internal returns (address) {
        bytes32 s = keccak256(bytes(stage));
        if (s == keccak256("vault")) {
            deal(USDC, admin, VaultTestParams.SEED_DEPOSIT_AMOUNT);
            return address(
                new DeployVault()
                .runInProcessWithSeed(
                    VaultTestParams.params(admin, USDC),
                    makeAddr("seedShareReceiver"),
                    VaultTestParams.SEED_DEPOSIT_AMOUNT
                )
                .vault
            );
        }
        if (s == keccak256("proto")) {
            return new DeployProtocolAssetVault()
            .runInProcess(_basketParams(registry), vm.readFile("config/protocol-assets.json"))
            .vault;
        }
        if (s == keccak256("rwa")) {
            return new DeployRwaBasketVault()
            .runInProcess(_basketParams(registry), vm.readFile("config/rwa-assets.json"))
            .vault;
        }
        revert(string.concat("no in-process deploy for vault stage ", stage));
    }

    function test_fork_eachVaultDeploysWithTheTablesDepositState() public {
        if (!selected) return;
        string memory table = vm.readFile(TABLE);
        VaultRegistry registry = CoreProxies.vaultRegistry(admin);
        uint256 n;
        while (vm.keyExistsJson(table, string.concat(".vaults[", vm.toString(n), "]"))) n++;
        assertEq(n, 3, "the table lists the three vaults");
        for (uint256 i = 0; i < n; i++) {
            string memory row = string.concat(".vaults[", vm.toString(i), "]");
            string memory key = table.readString(string.concat(row, ".key"));
            bool want = table.readBool(string.concat(row, ".deployPaused"));
            address vault = _deploy(table.readString(string.concat(row, ".stage")), registry);
            assertEq(
                IDepositsPaused(vault).depositsPaused(),
                want,
                string.concat(key, ": depositsPaused() differs from the table's deployPaused")
            );
        }
    }
}
