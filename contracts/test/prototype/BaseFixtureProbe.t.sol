// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseFixture} from "./BaseFixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256);
}

interface IV3Pool {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory);
    function slot0()
        external
        view
        returns (uint160, int24 tick, uint16, uint16, uint16, uint8, bool);
}

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 code) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface IProbeAggregator {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface IComet {
    function supply(address asset, uint256 amount) external;
    function withdraw(address asset, uint256 amount) external;
    function balanceOf(address) external view returns (uint256);
}

/// @notice One-vault experiment: proves the replay fixture serves every venue the fund touches.
///         Each test runs on real Base state from the committed fixture, with no RPC.
contract BaseFixtureProbeTest is BaseFixture {
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address internal constant DESPXA = 0x9c5C365e764829876243d0b289733B9D2b729685;
    address internal constant WETH_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    address internal constant CBBTC_POOL = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef;
    address internal constant DESPXA_POOL = 0xD08f1fb797BfaCdeD23323178672557034c64CfA;
    address internal constant ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant COMET = 0xb125E6687d4313864e53df431d5425969c15Eb2F;
    address internal constant MOONWELL = 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca;
    uint24 internal constant FEE = 500;
    uint32 internal constant TWAP_WINDOW = 1800;

    // Chainlink on Base (scaffold plan §4: each answered `description()` at the pin).
    address internal constant FEED_ETH = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    address internal constant FEED_BTC = 0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F;
    address internal constant FEED_CBBTC = 0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D;
    address internal constant FEED_USDC = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B;
    address internal constant FEED_SEQUENCER = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433;

    /// @dev Real FiatToken balance slot (mapping at slot 9, balance in the low 255 bits), the same
    ///      write scripts/devnet/twin-fork.ts fund-usdc makes.
    function _fundUsdc(address to, uint256 amount) internal {
        bytes32 slot = keccak256(abi.encode(to, uint256(9)));
        vm.store(USDC, slot, bytes32(amount));
        assertEq(IERC20(USDC).balanceOf(to), amount, "fund usdc");
    }

    function _swap(address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256) {
        IERC20(tokenIn).approve(ROUTER, amountIn);
        return ISwapRouter02(ROUTER)
            .exactInputSingle(
                ISwapRouter02.ExactInputSingleParams(
                    tokenIn, tokenOut, FEE, address(this), amountIn, 0, 0
                )
            );
    }

    function _twapTick(address pool) internal view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        (int56[] memory cum,) = IV3Pool(pool).observe(ago);
        return int24((cum[1] - cum[0]) / int56(uint56(TWAP_WINDOW)));
    }

    function _roundTrip(address token, address pool, uint256 usdcIn) internal {
        _fundUsdc(address(this), usdcIn);
        int24 twap = _twapTick(pool);
        (, int24 spot,,,,,) = IV3Pool(pool).slot0();
        // A healthy pool's spot sits near its TWAP. 200 ticks is about 2%.
        assertLt(_abs(int256(spot) - int256(twap)), 200, "spot near twap");

        uint256 got = _swap(USDC, token, usdcIn);
        assertGt(got, 0, "bought");
        uint256 back = _swap(token, USDC, got);
        // Two pool fees (0.05% each) plus impact. 1% is a generous bound for these sizes.
        assertGt(back, usdcIn * 99 / 100, "round trip loss under 1%");
        assertLt(back, usdcIn, "round trip cannot profit");
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return uint256(x < 0 ? -x : x);
    }

    function test_weth_roundTrip_10k() public fixtureCovered {
        _roundTrip(WETH, WETH_POOL, 10_000e6);
    }

    function test_cbbtc_roundTrip_10k() public fixtureCovered {
        _roundTrip(CBBTC, CBBTC_POOL, 10_000e6);
    }

    function test_despxa_roundTrip_1k() public fixtureCovered {
        _roundTrip(DESPXA, DESPXA_POOL, 1_000e6);
    }

    function test_aave_supplyWithdraw() public fixtureCovered {
        _fundUsdc(address(this), 10_000e6);
        IERC20(USDC).approve(AAVE_POOL, 10_000e6);
        IAavePool(AAVE_POOL).supply(USDC, 10_000e6, address(this), 0);
        uint256 out = IAavePool(AAVE_POOL).withdraw(USDC, type(uint256).max, address(this));
        // Aave rounds the scaled balance on supply (rayDiv) and on read (rayMul): a few wei either way.
        assertGe(out, 10_000e6 - 2, "aave returns principal");
    }

    function test_comet_supplyWithdraw() public fixtureCovered {
        _fundUsdc(address(this), 10_000e6);
        IERC20(USDC).approve(COMET, 10_000e6);
        IComet(COMET).supply(USDC, 10_000e6);
        uint256 bal = IComet(COMET).balanceOf(address(this));
        assertGe(bal, 10_000e6 - 1, "comet credits principal");
        IComet(COMET).withdraw(USDC, bal);
        assertGe(IERC20(USDC).balanceOf(address(this)), 10_000e6 - 1, "comet returns principal");
    }

    /// @dev Step 3d (E16, scaffold plan §7.5 item 7): each real Chainlink feed the step 3d design reads, at the pin,
    ///      with no mock: its description and decimals, a complete positive round for the price feeds, and a status
    ///      of 0 or 1 for the sequencer uptime feed. Every round is not later than the pin. The replay fixture holds
    ///      none of these accounts until `verify` re-records (they are read only here and on the recorder's fork),
    ///      so the test skips with that reason while a feed has no code; it never mocks one.
    function test_feeds_realChainlinkAtThePin() public fixtureCovered {
        address[4] memory feeds = [FEED_ETH, FEED_BTC, FEED_CBBTC, FEED_USDC];
        string[4] memory names = ["ETH / USD", "BTC / USD", "cbBTC / USD", "USDC / USD"];
        for (uint256 i; i < feeds.length; ++i) {
            if (feeds[i].code.length == 0) {
                vm.skip(true, "the replay fixture lacks the Chainlink feed accounts until verify re-records");
            }
            IProbeAggregator f = IProbeAggregator(feeds[i]);
            assertEq(f.description(), names[i], "feed description");
            assertEq(f.decimals(), 8, "price feed decimals");
            (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = f.latestRoundData();
            assertGt(answer, 0, "positive price");
            assertGe(answeredInRound, roundId, "complete round");
            assertGt(updatedAt, 0, "round time");
            assertLe(updatedAt, block.timestamp, "round not after the pin");
        }
        if (FEED_SEQUENCER.code.length == 0) {
            vm.skip(true, "the replay fixture lacks the sequencer uptime feed until verify re-records");
        }
        IProbeAggregator seq = IProbeAggregator(FEED_SEQUENCER);
        assertGt(bytes(seq.description()).length, 0, "sequencer feed description");
        assertEq(seq.decimals(), 0, "sequencer feed decimals");
        (, int256 status, uint256 startedAt,,) = seq.latestRoundData();
        assertTrue(status == 0 || status == 1, "sequencer status is 0 (up) or 1 (down)");
        assertLe(startedAt, block.timestamp, "status began before the pin");
    }

    function test_moonwell_depositRedeem() public fixtureCovered {
        _fundUsdc(address(this), 10_000e6);
        IERC20(USDC).approve(MOONWELL, 10_000e6);
        uint256 shares = IERC4626(MOONWELL).deposit(10_000e6, address(this));
        uint256 out = IERC4626(MOONWELL).redeem(shares, address(this), address(this));
        assertGe(out, 10_000e6 - 2, "moonwell returns principal");
    }
}
