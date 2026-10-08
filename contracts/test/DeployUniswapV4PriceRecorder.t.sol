// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0005-basketvault-multi-dex-routing.md (2026-10-08 amendment: V4 venue and price recorder)
// Covers core issue 1676: stage `recorder`.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {DeployUniswapV4PriceRecorder} from "../script/DeployUniswapV4PriceRecorder.s.sol";
import {UniswapV4PriceRecorder} from "../adapters/UniswapV4PriceRecorder.sol";
import {IPoolManagerV4} from "../interfaces/IPoolManagerV4.sol";
import {MockV4PoolManager} from "./helpers/MockV4PoolManager.sol";

contract RecorderDeployHarness is DeployUniswapV4PriceRecorder {
    function writeManifest(Deployed memory d, string memory path) external {
        _writeManifestTo(d, path);
    }
}

contract DeployUniswapV4PriceRecorderTest is Test {
    using stdJson for string;

    address internal constant PM_ADDR = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address internal constant RM = 0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    bytes32 internal constant RM_POOL_ID =
        0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391;

    RecorderDeployHarness internal script;

    function setUp() public {
        vm.warp(1_700_000_000);
        script = new RecorderDeployHarness();
        vm.etch(PM_ADDR, address(new MockV4PoolManager()).code);
        MockV4PoolManager(PM_ADDR)
            .initializePool(IPoolManagerV4.PoolKey(RM, USDC, 29100, 582, address(0)), -100, 1e18);
    }

    function _shipped() internal view returns (string memory) {
        return vm.readFile("config/agent-token-shortlist.json");
    }

    function test_deploysTheRecorderForTheShippedKeyWithA901SlotRingTarget() public {
        DeployUniswapV4PriceRecorder.Deployed memory d = script.runInProcess(_shipped());
        UniswapV4PriceRecorder rec = UniswapV4PriceRecorder(d.recorder);
        assertEq(rec.POOL_ID(), RM_POOL_ID);
        assertEq(address(rec.POOL_MANAGER()), PM_ADDR);
        assertEq(rec.token0(), RM);
        assertEq(rec.token1(), USDC);
        assertEq(uint256(rec.fee()), 29100);
        assertEq(int256(rec.tickSpacing()), int256(582));
        (,,,, uint16 next) = rec.latest();
        assertEq(next, 901, "ring target is the 1800 s window floor");
        assertEq(d.cardinalityNext, 901);
        assertEq(d.poolId, RM_POOL_ID);
    }

    /// @notice The first record after the grow widens the live ring once a later block exists.
    function test_aLaterRecordWidensTheLiveRing() public {
        DeployUniswapV4PriceRecorder.Deployed memory d = script.runInProcess(_shipped());
        UniswapV4PriceRecorder rec = UniswapV4PriceRecorder(d.recorder);
        vm.warp(block.timestamp + 2);
        rec.record();
        (,,, uint16 card,) = rec.latest();
        assertEq(card, 901);
    }

    /// @notice One grow transaction costs about 22,000 gas per slot: a chunk must stay far under a block gas limit.
    function test_theGrowChunkKeepsEveryGrowTransactionFarUnderABlockGasLimit() public view {
        assertLe(uint256(script.GROW_CHUNK()) * 25_000, 10_000_000);
        assertGe(script.GROW_CHUNK(), 1);
    }

    /// @notice The first record runs under a fixed gas limit, not forge's same-block estimate (about 38,000 gas, too low for a real chain).
    function test_theFirstRecordIsCalledWithTheFixedGas() public {
        address predicted = vm.computeCreateAddress(address(script), vm.getNonce(address(script)));
        vm.expectCall(
            predicted,
            0,
            uint64(script.RECORD_GAS()),
            abi.encodeWithSelector(UniswapV4PriceRecorder.record.selector)
        );
        script.runInProcess(_shipped());
    }

    function test_noRoleIsLeftOnTheRecorder() public {
        DeployUniswapV4PriceRecorder.Deployed memory d = script.runInProcess(_shipped());
        (bool ok,) = d.recorder.call(abi.encodeWithSignature("owner()"));
        assertFalse(ok);
        (ok,) = d.recorder
            .call(abi.encodeWithSignature("hasRole(bytes32,address)", bytes32(0), address(script)));
        assertFalse(ok);
    }

    function test_revertsWhenThePoolKeyDoesNotHashToThePoolId() public {
        string memory bad = vm.replace(_shipped(), '"tickSpacing": 582', '"tickSpacing": 200');
        vm.expectRevert(bytes("config poolKey does not hash to poolId"));
        script.runInProcess(bad);
    }

    function test_revertsWhenTheConfigHasNoV4Asset() public {
        string memory v3 = string.concat(
            '{"swapRouter02":"0x2626664c2603336E57B271c5C0b26F421741e481","shortlist":[{"symbol":"X","token":"0x000000000000000000000000000000000000bEEF","venue":"UniswapV3","pool":"0x8Cd8c7015b6A8F8310c15CcC8aA3D200D9c74882","poolFee":500}]}'
        );
        vm.expectRevert(bytes("no UniswapV4 asset in the config: nothing to record"));
        script.runInProcess(v3);
    }

    function test_revertsOnTwoV4Assets() public {
        string memory entry =
            '{"symbol":"RM","token":"0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3","venue":"UniswapV4","poolManager":"0x498581fF718922c3f8e6A244956aF099B2652b2b","poolId":"0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391","poolKey":{"currency0":"0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3","currency1":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","fee":29100,"tickSpacing":582,"hooks":"0x0000000000000000000000000000000000000000"},"poolFee":29100}';
        string memory two = string.concat('{"shortlist":[', entry, ",", entry, "]}");
        vm.expectRevert(bytes("more than one UniswapV4 asset: one recorder per run"));
        script.runInProcess(two);
    }

    function test_revertsWhenThePoolIsNotInitialised() public {
        vm.store(PM_ADDR, keccak256(abi.encode(RM_POOL_ID, uint256(6))), bytes32(0));
        vm.expectRevert(UniswapV4PriceRecorder.PoolNotInitialized.selector);
        script.runInProcess(_shipped());
    }

    function test_manifestNamesTheRecorderAndThePool() public {
        DeployUniswapV4PriceRecorder.Deployed memory d = script.runInProcess(_shipped());
        string memory path =
            string.concat(vm.projectRoot(), "/deployments/test-recorder-manifest.json");
        script.writeManifest(d, path);
        string memory out = vm.readFile(path);
        vm.removeFile(path);
        assertEq(out.readAddress(".recorder"), d.recorder);
        assertEq(out.readAddress(".pool_manager"), PM_ADDR);
        assertEq(out.readBytes32(".pool_id"), RM_POOL_ID);
        assertEq(out.readUint(".ring_slots"), 901);
        assertEq(out.readUint(".chain_id"), block.chainid);
    }
}
