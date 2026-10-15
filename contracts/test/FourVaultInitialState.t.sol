// SPDX-License-Identifier: MIT
// Canonical: scripts/deploy/stage-table.json `vaults[].deployPaused` (issue 1705, QA plan v1 E9 a; core 1710: all four vaults deploy paused)
pragma solidity ^0.8.24;

import {stdJson} from "forge-std/StdJson.sol";

import {DeployVault} from "../script/DeployVault.s.sol";
import {DeployProtocolAssetVault} from "../script/DeployProtocolAssetVault.s.sol";
import {DeployAgentTokenVault} from "../script/DeployAgentTokenVault.s.sol";
import {DeployRwaBasketVault} from "../script/DeployRwaBasketVault.s.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {UniswapV4PriceRecorder} from "../adapters/UniswapV4PriceRecorder.sol";
import {IPoolManagerV4} from "../interfaces/IPoolManagerV4.sol";
import {BasketDeployFixture} from "./helpers/BasketDeployFixture.sol";
import {MockV4PoolManager} from "./helpers/MockV4PoolManager.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {VaultTestParams} from "./helpers/VaultTestParams.sol";
import {VenueEtcher} from "./helpers/VenueMocks.sol";

/// @notice Issue 1705: one table, `scripts/deploy/stage-table.json` `vaults[]`, holds the per-vault rules, and the deploy
///         scripts follow it. For each vault row this runs the stage script the row's stage names, in process and as the
///         deployer, and asserts that `depositsPaused()` afterwards equals the row's `deployPaused`. A script that stops
///         pausing, or a table row edited to say a vault deploys open, fails here.
/// @dev No fork. rmUSDC runs `runInProcessWithSeed` (the seed step is where the vault stage pauses) against the venue doubles
///      etched at the production venue addresses. The baskets run their real config files: rmPROTO and rmRWA against
///      `ConstPool` doubles etched at the configured pools, rmAGENT against the V4 world `DeployAgentTokenVault.t.sol` builds
///      (a PoolManager double, RM and USDC code at their real addresses, a warmed recorder). USDC is a `TestERC20` etched at
///      the Base USDC address, because the shipped RM pool key pairs RM with it.
contract FourVaultInitialStateTest is BasketDeployFixture {
    using stdJson for string;

    string internal constant TABLE = "scripts/deploy/stage-table.json";

    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant RM_TOKEN = 0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3;
    address internal constant PM_ADDR = 0x498581fF718922c3f8e6A244956aF099B2652b2b;

    address internal seedShareReceiver = makeAddr("seedShareReceiver");

    function setUp() public {
        _fixtureSetUp();
        vm.etch(BASE_USDC, address(new TestERC20()).code);
        usdc = TestERC20(BASE_USDC);
    }

    /// @notice Every vault row of the table: its stage script, run in process, leaves deposits paused exactly when
    ///         `deployPaused` says so (all four today).
    function test_eachVaultStageLeavesDepositsPausedAsTheStageTableSays() public {
        string memory table = vm.readFile(TABLE);
        uint256 n;
        while (vm.keyExistsJson(table, string.concat(".vaults[", vm.toString(n), "]"))) n++;
        assertEq(n, 4, "the stage table lists the four vaults");

        for (uint256 i = 0; i < n; i++) {
            string memory row = string.concat(".vaults[", vm.toString(i), "]");
            string memory key = table.readString(string.concat(row, ".key"));
            string memory script =
                _scriptOfStage(table, table.readString(string.concat(row, ".stage")));
            bool deployPaused = table.readBool(string.concat(row, ".deployPaused"));

            address vault = _runVaultStage(key, script);
            assertEq(
                _depositsPaused(vault),
                deployPaused,
                string.concat(
                    "vault ",
                    key,
                    ": depositsPaused() after its stage differs from the table's deployPaused"
                )
            );
        }
    }

    // ─── The table ───────────────────────────────────────────────────────────

    /// @dev The `script` of the stage named `stage` (`contracts/script/<File>.s.sol:<Contract>`).
    function _scriptOfStage(string memory table, string memory stage)
        internal
        view
        returns (string memory)
    {
        for (
            uint256 j = 0;
            vm.keyExistsJson(table, string.concat(".stages[", vm.toString(j), "]"));
            j++
        ) {
            string memory s = string.concat(".stages[", vm.toString(j), "]");
            if (_eq(table.readString(string.concat(s, ".name")), stage)) {
                return table.readString(string.concat(s, ".script"));
            }
        }
        revert(string.concat("the stage table has no stage ", stage));
    }

    /// @dev Runs the stage script of vault `key`. The script the table names must be the one run here, so a table that
    ///      moves a vault to another script fails until this test runs that script too.
    function _runVaultStage(string memory key, string memory script) internal returns (address) {
        if (_eq(key, "USDC")) {
            assertEq(
                script, "contracts/script/DeployVault.s.sol:DeployVault", "rmUSDC stage script"
            );
            return _runUsdc();
        }
        if (_eq(key, "PROTO")) {
            assertEq(
                script,
                "contracts/script/DeployProtocolAssetVault.s.sol:DeployProtocolAssetVault",
                "rmPROTO stage script"
            );
            return _runProto();
        }
        if (_eq(key, "AGENT")) {
            assertEq(
                script,
                "contracts/script/DeployAgentTokenVault.s.sol:DeployAgentTokenVault",
                "rmAGENT stage script"
            );
            return _runAgent();
        }
        if (_eq(key, "RWA")) {
            assertEq(
                script,
                "contracts/script/DeployRwaBasketVault.s.sol:DeployRwaBasketVault",
                "rmRWA stage script"
            );
            return _runRwa();
        }
        revert(string.concat("no in-process run for vault ", key));
    }

    // ─── The four vault stages ───────────────────────────────────────────────

    /// @dev rmUSDC: the vault stage with its seed (the deployer pays 1 USDC, the receiver gets the shares, then the stage pauses).
    function _runUsdc() internal returns (address) {
        VenueEtcher.etchAll(address(usdc));
        usdc.mint(deployer, VaultTestParams.SEED_DEPOSIT_AMOUNT);
        DeployVault.Deployed memory d = new DeployVault()
            .runInProcessWithSeed(
                VaultTestParams.params(deployer, address(usdc)),
                seedShareReceiver,
                VaultTestParams.SEED_DEPOSIT_AMOUNT
            );
        assertGt(d.vault.totalSupply(), 0, "rmUSDC: the seed landed");
        return address(d.vault);
    }

    /// @dev rmPROTO on the committed `config/protocol-assets.json`.
    function _runProto() internal returns (address) {
        string memory json = _etchConfigPools("config/protocol-assets.json", "assets");
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        return new DeployProtocolAssetVault().runInProcess(p, json).vault;
    }

    /// @dev rmRWA on the committed `config/rwa-assets.json`.
    function _runRwa() internal returns (address) {
        string memory json = _etchConfigPools("config/rwa-assets.json", "assets");
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        return new DeployRwaBasketVault().runInProcess(p, json).vault;
    }

    /// @dev rmAGENT on the committed `config/agent-token-shortlist.json` (RM on the V4 pool), priced by a warmed recorder.
    function _runAgent() internal returns (address) {
        vm.warp(1_700_000_000);
        vm.etch(PM_ADDR, address(new MockV4PoolManager()).code);
        vm.etch(RM_TOKEN, address(new TestERC20()).code);
        IPoolManagerV4.PoolKey memory k =
            IPoolManagerV4.PoolKey(RM_TOKEN, BASE_USDC, 29100, 582, address(0));
        MockV4PoolManager(PM_ADDR).initializePool(k, -100, 1e18);
        UniswapV4PriceRecorder recorder =
            new UniswapV4PriceRecorder(PM_ADDR, RM_TOKEN, BASE_USDC, 29100, 582, address(0));
        recorder.grow(901);
        for (uint256 i = 0; i < 32; i++) {
            vm.warp(block.timestamp + 60);
            recorder.record();
        }

        string memory json = vm.readFile("config/agent-token-shortlist.json");
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        p.recorder = address(recorder);
        return new DeployAgentTokenVault().runInProcess(p, json).vault;
    }

    /// @dev `depositsPaused()` of either vault family (RobotMoneyVault and BasketVault both expose it).
    function _depositsPaused(address vault) internal view returns (bool) {
        (bool ok, bytes memory out) = vault.staticcall(abi.encodeWithSignature("depositsPaused()"));
        require(ok && out.length == 32, "depositsPaused() unreadable");
        return abi.decode(out, (bool));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
