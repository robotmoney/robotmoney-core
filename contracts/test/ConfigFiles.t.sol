// SPDX-License-Identifier: MIT
// Canonical: robotmoney/devops issue 53 / core issue 1499, core S2 (issue 1484).
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Reads the launch config files and pins the facts S2 fixed. Offline: no RPC.
contract ConfigFilesTest is Test {
    using stdJson for string;

    address internal constant DESPXA_POOL = 0xD08f1fb797BfaCdeD23323178672557034c64CfA;
    address internal constant SWAP_ROUTER02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;

    function test_Config_rwaAssetsIsDespxaOnlyOnFee500() public view {
        string memory j = vm.readFile("config/rwa-assets.json");
        assertEq(j.readString(".assets[0].symbol"), "deSPXA");
        assertFalse(vm.keyExistsJson(j, ".assets[1]"), "deSPXA only");
        assertEq(j.readString(".assets[0].venue"), "UniswapV3");
        assertEq(j.readUint(".assets[0].poolFee"), 500);
        assertEq(j.readAddress(".assets[0].pool"), DESPXA_POOL);
        assertEq(j.readAddress(".swapRouter02"), SWAP_ROUTER02);
        assertEq(j.readAddress(".uniswapV3Factory"), V3_FACTORY);
    }

    function test_Config_protocolAssetsIsWethAndCbbtc() public view {
        string memory j = vm.readFile("config/protocol-assets.json");
        assertEq(j.readString(".assets[0].symbol"), "wETH");
        assertEq(j.readString(".assets[1].symbol"), "cbBTC");
        assertFalse(vm.keyExistsJson(j, ".assets[2]"), "wETH and cbBTC only");
        assertEq(j.readUint(".assets[0].poolFee"), 500);
        assertEq(j.readUint(".assets[1].poolFee"), 500);
        assertEq(j.readAddress(".swapRouter02"), SWAP_ROUTER02);
        assertEq(j.readAddress(".uniswapV3Factory"), V3_FACTORY);
    }

    /// @notice Owner decision 2026-10-08 (core 1676): RM is on the Uniswap V4 RM/USDC 2.91% pool with a hookless PoolKey.
    function test_Config_agentShortlistIsRmOnlyOnTheV4Pool() public view {
        string memory j = vm.readFile("config/agent-token-shortlist.json");
        assertEq(j.readString(".shortlist[0].symbol"), "RM");
        assertFalse(vm.keyExistsJson(j, ".shortlist[1]"), "RM only");
        assertEq(j.readAddress(".shortlist[0].token"), 0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3);
        assertEq(j.readString(".shortlist[0].venue"), "UniswapV4", "RM is on UniswapV4");
        assertEq(j.readUint(".shortlist[0].poolFee"), 29100);
        assertEq(j.readUint(".shortlist[0].poolKey.fee"), 29100);
        assertEq(j.readInt(".shortlist[0].poolKey.tickSpacing"), 582);
        assertEq(j.readAddress(".shortlist[0].poolKey.hooks"), address(0), "hookless pool");
        assertEq(
            j.readAddress(".shortlist[0].poolKey.currency0"),
            0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3
        );
        assertEq(
            j.readAddress(".shortlist[0].poolKey.currency1"),
            0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
        );
        assertEq(
            j.readAddress(".shortlist[0].poolManager"), 0x498581fF718922c3f8e6A244956aF099B2652b2b
        );
        assertEq(
            j.readBytes32(".shortlist[0].poolId"),
            0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391
        );
        assertFalse(vm.keyExistsJson(j, ".shortlist[0].pool"), "no V3 pool address for RM");
        assertEq(j.readUint(".maxSlippageBps"), 500);
    }

    /// @notice The shipped PoolKey hashes to the configured pool id (a spoofed key cannot share the id).
    function test_Config_agentPoolKeyHashesToThePoolId() public view {
        string memory j = vm.readFile("config/agent-token-shortlist.json");
        bytes32 id = keccak256(
            abi.encode(
                j.readAddress(".shortlist[0].poolKey.currency0"),
                j.readAddress(".shortlist[0].poolKey.currency1"),
                uint24(j.readUint(".shortlist[0].poolKey.fee")),
                int24(j.readInt(".shortlist[0].poolKey.tickSpacing")),
                j.readAddress(".shortlist[0].poolKey.hooks")
            )
        );
        assertEq(id, j.readBytes32(".shortlist[0].poolId"));
    }

    function test_Config_agentShortlistCarriesSwapRouter02() public view {
        string memory j = vm.readFile("config/agent-token-shortlist.json");
        assertEq(j.readAddress(".swapRouter02"), SWAP_ROUTER02);
        assertEq(j.readAddress(".uniswapV3Factory"), V3_FACTORY);
    }
}
