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
import {Rebalancer} from "../src/Rebalancer.sol";
import {AaveV3RateAdapter} from "../src/adapters/AaveV3RateAdapter.sol";
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
        require(IERC20(USDC).transferFrom(msg.sender, address(this), amount), "OneVaultMockAavePool: transfer");
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
        // The fund's rebalance roles bind once. The governance slot takes the deployer, which opens plans in the test.
        IRobotMoneyFundFull(fund).bindRebalanceRoles(deployer, address(rebalancer));

        OneVaultMockAavePool pool = new OneVaultMockAavePool(usdc, deployer);
        AaveV3RateAdapter adapter =
            new AaveV3RateAdapter(address(pool), usdc, address(pool.ATOKEN()), fund);
        IRobotMoneyFundFull(fund).setAdapterCodeHashAllowed(address(adapter).codehash, true);
        uint256 index = IRobotMoneyFundFull(fund).addAsset(
            AssetConfig({
                kind: AssetKind.Lending,
                active: true,
                capBps: LENDING_CAP_BPS,
                adapter: address(adapter),
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
        vm.stopBroadcast();

        string memory body = string.concat(
            "REBALANCER=",
            vm.toString(address(rebalancer)),
            "\n",
            "LENDING_POOL=",
            vm.toString(address(pool)),
            "\n",
            "A_TOKEN=",
            vm.toString(address(pool.ATOKEN())),
            "\n",
            "LENDING_ADAPTER=",
            vm.toString(address(adapter)),
            "\n"
        );
        vm.writeFile(outPath, body);
    }
}
