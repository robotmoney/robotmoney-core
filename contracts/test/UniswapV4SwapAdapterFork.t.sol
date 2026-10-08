// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0005-basketvault-multi-dex-routing.md (2026-10-08 amendment: V4 venue)
//            docs/adr/ADR-0001-mvp-agent-token-shortlist.md (2026-10-08: RM on the V4 RM/USDC 2.91% pool)
// Covers core issue 1676: the adapter and recorder against the REAL Base Uniswap V4 PoolManager and the live RM/USDC pool.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ForkSelect} from "./helpers/ForkSelect.sol";
import {IPoolManagerV4} from "../interfaces/IPoolManagerV4.sol";
import {UniswapV4PriceRecorder} from "../adapters/UniswapV4PriceRecorder.sol";
import {UniswapV4SwapAdapter} from "../adapters/UniswapV4SwapAdapter.sol";

interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) external view returns (uint128);
}

/// @notice Runs on the Twin chain (a pinned lazy anvil fork of real Base). With FORK_RPC_URL unset the test skips with a
///         named reason (ForkSelect). The shipped config names the live PoolKey, so a wrong field fails here.
contract UniswapV4SwapAdapterForkTest is Test {
    using stdJson for string;

    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    string internal cfg;
    IPoolManagerV4.PoolKey internal key;
    address internal poolManager;
    address internal stateView;
    bytes32 internal poolId;
    address internal rmToken;
    UniswapV4PriceRecorder internal rec;
    UniswapV4SwapAdapter internal adapter;
    address internal alice = makeAddr("alice");

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (!ForkSelect.selectOrSkip(rpc)) return;

        cfg = vm.readFile("config/agent-token-shortlist.json");
        string memory b = ".shortlist[0]";
        rmToken = cfg.readAddress(string.concat(b, ".token"));
        poolManager = cfg.readAddress(string.concat(b, ".poolManager"));
        stateView = cfg.readAddress(string.concat(b, ".stateView"));
        poolId = cfg.readBytes32(string.concat(b, ".poolId"));
        key = IPoolManagerV4.PoolKey({
            currency0: cfg.readAddress(string.concat(b, ".poolKey.currency0")),
            currency1: cfg.readAddress(string.concat(b, ".poolKey.currency1")),
            fee: uint24(cfg.readUint(string.concat(b, ".poolKey.fee"))),
            tickSpacing: int24(int256(cfg.readUint(string.concat(b, ".poolKey.tickSpacing")))),
            hooks: cfg.readAddress(string.concat(b, ".poolKey.hooks"))
        });
        rec = new UniswapV4PriceRecorder(
            poolManager, key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks
        );
        adapter = new UniswapV4SwapAdapter(poolManager, key, address(rec), USDC);
        deal(USDC, alice, 1_000e6);
    }

    function test_fork_configPoolKeyHashesToThePoolId() public view {
        assertEq(keccak256(abi.encode(key)), poolId, "config PoolKey hashes to the config pool id");
        assertEq(rec.POOL_ID(), poolId);
        assertEq(adapter.POOL_ID(), poolId);
    }

    /// @notice The recorder reads the same slot0 and liquidity StateView reports, through the PoolManager extsload.
    function test_fork_recorderReadsMatchStateView() public view {
        (uint160 sqrtP, int24 tick,,) = IStateView(stateView).getSlot0(poolId);
        (uint160 rSqrtP, int24 rTick,,) = rec.slot0();
        assertEq(rSqrtP, sqrtP);
        assertEq(int256(rTick), int256(tick));
        assertEq(
            rec.liquidity(),
            IStateView(stateView).getLiquidity(poolId),
            "liquidity slot offset is right"
        );
        assertGt(rec.liquidity(), 0, "the pool holds liquidity");
    }

    /// @notice USDC to RM and back through the real PoolManager. The recorder is poked by the swaps.
    function test_fork_swapUsdcToRmAndBackThroughTheRealPoolManager() public {
        rec.grow(10);
        vm.warp(block.timestamp + 20);
        uint256 usdcIn = 2e6;
        vm.startPrank(alice);
        IERC20(USDC).approve(address(adapter), usdcIn);
        uint256 rmOut = adapter.swap(USDC, rmToken, key.fee, usdcIn, 1, alice, block.timestamp);
        vm.stopPrank();
        assertGt(rmOut, 0, "bought RM");
        assertEq(IERC20(rmToken).balanceOf(alice), rmOut);
        assertEq(IERC20(USDC).balanceOf(address(adapter)), 0);
        assertEq(IERC20(rmToken).balanceOf(address(adapter)), 0);
        (, uint32 at,,,) = rec.latest();
        assertEq(at, uint32(block.timestamp), "the swap poked the recorder");

        vm.warp(block.timestamp + 20);
        uint256 usdcBefore = IERC20(USDC).balanceOf(alice);
        vm.startPrank(alice);
        IERC20(rmToken).approve(address(adapter), rmOut);
        uint256 usdcOut = adapter.swap(rmToken, USDC, key.fee, rmOut, 1, alice, block.timestamp);
        vm.stopPrank();
        assertGt(usdcOut, 0);
        assertEq(IERC20(USDC).balanceOf(alice) - usdcBefore, usdcOut);
        // a round trip pays the 2.91 percent fee twice, so it returns less than 95 percent
        assertLt(usdcOut, usdcIn * 95 / 100);
    }

    function test_fork_swapRefusesAFloorTheRealPoolCannotMeet() public {
        vm.startPrank(alice);
        IERC20(USDC).approve(address(adapter), 1e6);
        vm.expectPartialRevert(UniswapV4SwapAdapter.SlippageExceeded.selector);
        adapter.swap(USDC, rmToken, key.fee, 1e6, type(uint128).max, alice, block.timestamp);
        vm.stopPrank();
    }

    function test_fork_twapPriceFromTheRecorderTracksTheLiveTick() public {
        rec.grow(10);
        for (uint256 i = 0; i < 6; i++) {
            vm.warp(block.timestamp + 60);
            rec.record();
        }
        uint256 twap = adapter.twapPrice(address(rec), rmToken, USDC, 1e18, 300);
        (, int24 spotTick,,) = rec.slot0();
        // no swaps moved the pool inside the window, so the recorded mean equals spot
        uint256 viaSpot = adapter.twapPrice(address(rec), rmToken, USDC, 1e18, 60);
        assertEq(twap, viaSpot);
        assertGt(twap, 0);
        assertTrue(spotTick != 0);
    }
}
