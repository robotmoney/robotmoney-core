// SPDX-License-Identifier: MIT
// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops), core S2 (issue 1484).
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
        string[] memory symbols = j.readStringArray(".assets[*].symbol");
        assertEq(symbols.length, 1);
        assertEq(symbols[0], "deSPXA");
        assertEq(j.readString(".assets[0].venue"), "UniswapV3");
        assertEq(j.readUint(".assets[0].poolFee"), 500);
        assertEq(j.readAddress(".assets[0].pool"), DESPXA_POOL);
        assertEq(j.readAddress(".swapRouter02"), SWAP_ROUTER02);
        assertEq(j.readAddress(".uniswapV3Factory"), V3_FACTORY);
    }

    function test_Config_protocolAssetsIsWethAndCbbtc() public view {
        string memory j = vm.readFile("config/protocol-assets.json");
        string[] memory symbols = j.readStringArray(".assets[*].symbol");
        assertEq(symbols.length, 2);
        assertEq(symbols[0], "wETH");
        assertEq(symbols[1], "cbBTC");
        assertEq(j.readUint(".assets[0].poolFee"), 500);
        assertEq(j.readUint(".assets[1].poolFee"), 500);
        assertEq(j.readAddress(".swapRouter02"), SWAP_ROUTER02);
        assertEq(j.readAddress(".uniswapV3Factory"), V3_FACTORY);
    }

    function test_Config_agentShortlistIsEmpty() public view {
        string memory j = vm.readFile("config/agent-token-shortlist.json");
        bytes memory raw = j.parseRaw(".shortlist");
        // An empty JSON array ABI-decodes to a zero-length dynamic array.
        assertEq(abi.decode(raw, (address[])).length, 0);
    }
}
