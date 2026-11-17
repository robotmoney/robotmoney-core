// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.3 (one step), §5.4 (who calls step()); scripts/ops/
//            onevault-keeper.sh and its self-test (core issue 2033).
// Experiment prototype only. Test-only: on a plain local anvil chain it deploys a Rebalancer proxy on the one-vault fund
// that OneVaultDeliveryAnvil deployed, binds its rebalance roles, and adds one lending asset (an AaveV3RateAdapter over a
// mock Aave pool). The fund admin is the deployer. The keeper (KeeperAccount) holds the Rebalancer's KEEPER_ROLE. The mock
// pool's `setPaused` makes the venue refuse supply, so the fund's deploy leg reverts. It is never part of a production deploy.
// Env: FUND_ADDRESS, TIMELOCK_ADDRESS (the stack's timelock), KEEPER_ADDRESS (KEEPER_ROLE holder), USDC_ADDRESS,
//      REBALANCER_ANVIL_OUT (a path under ./out/prototype, written as KEY=0x... lines).
// The file holds the mock pool and its aToken so the script takes one file. Run it as OneVaultKeeperAnvil.sol:OneVaultKeeperAnvil.
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {GovernedUUPS} from "../../../lib/GovernedUUPS.sol";
import {TestERC20} from "../../helpers/TestERC20.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {Rebalancer} from "../src/Rebalancer.sol";
import {AaveV3RateAdapter} from "../src/adapters/AaveV3RateAdapter.sol";
import {UniswapV3ExactOutSwapAdapter} from "../src/adapters/UniswapV3ExactOutSwapAdapter.sol";
import {AssetConfig, AssetKind, AssetStepParams, StepParams, Venue} from "../src/FundTypes.sol";
import {IRobotMoneyFundFull} from "../src/interfaces/IRobotMoneyFund.sol";

/// @notice Test-only aToken for the mock pool. Six decimals, like USDC. Only its pool mints and burns.
contract OneVaultMockAToken is ERC20 {
    address public immutable POOL;

    constructor(address pool) ERC20("Mock aUSDC", "maUSDC") {
        POOL = pool;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == POOL, "OneVaultMockAToken: not pool");
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == POOL, "OneVaultMockAToken: not pool");
        _burn(from, amount);
    }
}

/// @notice Test-only Aave pool: supply and withdraw move USDC one for one into an aToken. `setPaused` makes it refuse
///         supply and withdraw, and reports the reserve as paused, so the venue is closed the way a real pool would show it.
contract OneVaultMockAavePool {
    uint256 internal constant ACTIVE_BIT = 1 << 56;
    uint256 internal constant PAUSED_BIT = 1 << 60;

    address public immutable USDC;
    address public immutable OWNER;
    OneVaultMockAToken public immutable ATOKEN;
    bool public paused;

    constructor(address usdc, address owner) {
        USDC = usdc;
        OWNER = owner;
        ATOKEN = new OneVaultMockAToken(address(this));
    }

    function setPaused(bool p) external {
        require(msg.sender == OWNER, "OneVaultMockAavePool: not owner");
        paused = p;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(!paused, "OneVaultMockAavePool: paused");
        require(asset == USDC, "OneVaultMockAavePool: asset");
        require(
            IERC20(USDC).transferFrom(msg.sender, address(this), amount),
            "OneVaultMockAavePool: transfer"
        );
        ATOKEN.mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(!paused, "OneVaultMockAavePool: paused");
        require(asset == USDC, "OneVaultMockAavePool: asset");
        ATOKEN.burn(msg.sender, amount);
        require(IERC20(USDC).transfer(to, amount), "OneVaultMockAavePool: transfer");
        return amount;
    }

    function getConfiguration(address) external view returns (uint256 data) {
        data = ACTIVE_BIT;
        if (paused) data |= PAUSED_BIT;
    }

    /// @dev One ray: the rate stays flat, so the lending NAV moves only with deposits.
    function getReserveNormalizedIncome(address) external pure returns (uint256) {
        return 1e27;
    }
}

/// @notice Test-only basket token, six decimals like USDC. Anyone may mint it, so the test can put the fund's holding in place.
contract OneVaultMockBasketToken is ERC20 {
    constructor() ERC20("Mock Basket", "mBASK") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Test-only pool for a basket token against USDC. Price is one at tick 0 (equal decimals), the TWAP is flat, and the
///         observation history is deep enough for the admission guard. It answers the reads the fund and the guard make.
contract OneVaultMockV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public constant fee = 500;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function liquidity() external pure returns (uint128) {
        return 1e24;
    }

    function slot0() external pure returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (uint160(1) << 96, 0, 0, 1_000, 1_000, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        pure
        returns (
            int56[] memory tickCumulatives,
            uint160[] memory secondsPerLiquidityCumulativeX128s
        )
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        // Liquidity 2^64 in every slice: seconds per liquidity grow by dt / 2^64 per dt, in X128. The depth then
        // comes out large, so the basket step cap is the governed maxStepUsdc and not zero.
        for (uint256 i; i < secondsAgos.length; ++i) {
            secondsPerLiquidityCumulativeX128s[i] =
                uint160((uint256(1_000_000) - secondsAgos[i]) << 64);
        }
    }
}

/// @notice Test-only swap router with the two entry points the basket swap adapter calls: exact input (the fund's sale
///         and buy legs through the adapter's inherited `swap`) and exact output. It fills at one for one and pays USDC
///         from its own balance, which the deploy funds.
contract OneVaultMockSwapRouter {
    address public immutable OWNER;
    bool public paused;

    constructor() {
        OWNER = msg.sender;
    }

    /// @notice Closes the venue: every fill reverts, the way a paused router refuses a swap.
    function setPaused(bool p) external {
        require(msg.sender == OWNER, "OneVaultMockSwapRouter: not owner");
        paused = p;
    }

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata p)
        external
        payable
        returns (uint256 amountOut)
    {
        amountOut = p.amountIn;
        require(amountOut >= p.amountOutMinimum, "OneVaultMockSwapRouter: min out");
        _fill(p.tokenIn, p.tokenOut, p.recipient, p.amountIn, amountOut);
    }

    function exactOutputSingle(ExactOutputSingleParams calldata p)
        external
        payable
        returns (uint256 amountIn)
    {
        amountIn = p.amountOut;
        require(amountIn <= p.amountInMaximum, "OneVaultMockSwapRouter: max in");
        _fill(p.tokenIn, p.tokenOut, p.recipient, amountIn, p.amountOut);
    }

    function _fill(
        address tokenIn,
        address tokenOut,
        address recipient,
        uint256 amountIn,
        uint256 amountOut
    ) private {
        require(!paused, "OneVaultMockSwapRouter: paused");
        require(
            IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn),
            "OneVaultMockSwapRouter: in"
        );
        require(IERC20(tokenOut).transfer(recipient, amountOut), "OneVaultMockSwapRouter: out");
    }
}

/// @title OneVaultKeeperAnvil
/// @notice Local anvil Rebalancer and one lending asset for the one-vault keeper self-test. Parameters follow
///         PrototypeHarness._deployRebalancer and _addAssets.
contract OneVaultKeeperAnvil is Script {
    uint32 internal constant MAX_OVERRUN = 7 days;
    uint16 internal constant MAX_STEP_COST_BPS = 50;
    uint16 internal constant TOLERANCE_BPS = 50;
    uint128 internal constant MIN_STEP_USDC = 100e6;
    uint128 internal constant LENDING_MAX_STEP_USDC = 500_000e6;
    uint16 internal constant LENDING_CAP_BPS = 10_000;

    function run() external {
        address fund = vm.envAddress("FUND_ADDRESS");
        address timelock = vm.envAddress("TIMELOCK_ADDRESS");
        address keeper = vm.envAddress("KEEPER_ADDRESS");
        address usdc = vm.envAddress("USDC_ADDRESS");
        string memory outPath = vm.envString("REBALANCER_ANVIL_OUT");

        vm.startBroadcast();
        Rebalancer rebalancer = _deployRebalancer(fund, timelock, keeper);
        (address pool, address aToken, address lendingAdapter) = _addLending(fund, rebalancer, usdc);
        (address basketToken, address basketFeed, uint256 basketIndex, address basketRouter) =
            _addBasket(fund, rebalancer, usdc);
        vm.stopBroadcast();

        string memory body = string.concat(
            "REBALANCER=",
            vm.toString(address(rebalancer)),
            "\n",
            "LENDING_POOL=",
            vm.toString(pool),
            "\n",
            "A_TOKEN=",
            vm.toString(aToken),
            "\n",
            "LENDING_ADAPTER=",
            vm.toString(lendingAdapter),
            "\n",
            "BASKET_TOKEN=",
            vm.toString(basketToken),
            "\n",
            "BASKET_FEED=",
            vm.toString(basketFeed),
            "\n",
            "BASKET_INDEX=",
            vm.toString(basketIndex),
            "\n",
            "BASKET_ROUTER=",
            vm.toString(basketRouter),
            "\n"
        );
        vm.writeFile(outPath, body);
    }

    /// @dev Deploys the Rebalancer proxy and binds its rebalance roles. The deployer is the admin and the governance slot.
    function _deployRebalancer(address fund, address timelock, address keeper)
        internal
        returns (Rebalancer)
    {
        address deployer = msg.sender;
        uint32 interval = uint32(Math.max(30 minutes, IRobotMoneyFundFull(fund).maxTwapWindow()));
        StepParams memory sp = StepParams({
            stepInterval: interval,
            maxOverrun: MAX_OVERRUN,
            maxStepCostBps: MAX_STEP_COST_BPS,
            toleranceBps: TOLERANCE_BPS,
            minStepUsdc: MIN_STEP_USDC
        });
        address impl = address(new Rebalancer());
        Rebalancer rebalancer = Rebalancer(
            address(
                new ERC1967Proxy(
                    impl,
                    abi.encodeCall(
                        Rebalancer.initialize,
                        (fund, deployer, keeper, sp, timelock, GovernedUUPS.UpgradeMode.Upgradeable)
                    )
                )
            )
        );
        IRobotMoneyFundFull(fund).bindRebalanceRoles(deployer, address(rebalancer));
        return rebalancer;
    }

    /// @dev One lending asset over a mock Aave pool. Its plan target is the whole NAV in the test.
    function _addLending(address fund, Rebalancer rebalancer, address usdc)
        internal
        returns (address pool, address aToken, address adapter)
    {
        OneVaultMockAavePool mockPool = new OneVaultMockAavePool(usdc, msg.sender);
        AaveV3RateAdapter lending =
            new AaveV3RateAdapter(address(mockPool), usdc, address(mockPool.ATOKEN()), fund);
        IRobotMoneyFundFull(fund).setAdapterCodeHashAllowed(address(lending).codehash, true);
        uint256 index = IRobotMoneyFundFull(fund)
            .addAsset(
                AssetConfig({
                    kind: AssetKind.Lending,
                    active: true,
                    capBps: LENDING_CAP_BPS,
                    adapter: address(lending),
                    token: address(0),
                    pool: address(0),
                    poolFee: 0,
                    twapWindow: 0,
                    venue: Venue.V3,
                    feed: address(0),
                    maxFeedAge: 0
                })
            );
        rebalancer.setAssetStepParams(index, AssetStepParams(LENDING_MAX_STEP_USDC, 0));
        return (address(mockPool), address(mockPool.ATOKEN()), address(lending));
    }

    /// @dev One basket asset, with no holding and a zero target. The test puts a holding in place and then delists it.
    function _addBasket(address fund, Rebalancer rebalancer, address usdc)
        internal
        returns (address token, address feed, uint256 index, address router)
    {
        OneVaultMockBasketToken basket = new OneVaultMockBasketToken();
        OneVaultMockV3Pool basketPool = new OneVaultMockV3Pool(address(basket), usdc);
        MockAggregator basketFeed = new MockAggregator();
        basketFeed.setRound(8, 1e8, block.timestamp, block.timestamp);
        OneVaultMockSwapRouter swapRouter = new OneVaultMockSwapRouter();
        TestERC20(usdc).mint(address(swapRouter), 1_000_000e6);
        UniswapV3ExactOutSwapAdapter swap = new UniswapV3ExactOutSwapAdapter(address(swapRouter));
        IRobotMoneyFundFull(fund).setAdapterCodeHashAllowed(address(swap).codehash, true);
        index = IRobotMoneyFundFull(fund)
            .addAsset(
                AssetConfig({
                    kind: AssetKind.Basket,
                    active: true,
                    capBps: 0,
                    adapter: address(swap),
                    token: address(basket),
                    pool: address(basketPool),
                    poolFee: 500,
                    twapWindow: 1_800,
                    venue: Venue.V3,
                    feed: address(basketFeed),
                    maxFeedAge: 86_700
                })
            );
        rebalancer.setAssetStepParams(index, AssetStepParams(LENDING_MAX_STEP_USDC, 100));
        return (address(basket), address(basketFeed), index, address(swapRouter));
    }
}
