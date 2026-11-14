// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4 (one vault), §4.5 (asset admission), §5.9.5 (minSeedUsdc),
//            E14 (seed once at zero supply), E15 (asset admission refuses an unhealthy feed); PrototypeHarness.sol
//            (_deployFund, _deployAdapters, _addAssets, _seed).
// Deploy 4 (owner exception 2026-11-12): the one-vault prototype through the real deploy tool, as a rehearsal.
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RobotMoneyFund} from "../test/prototype/src/RobotMoneyFund.sol";
import {AaveV3RateAdapter} from "../test/prototype/src/adapters/AaveV3RateAdapter.sol";
import {CompoundV3RateAdapter} from "../test/prototype/src/adapters/CompoundV3RateAdapter.sol";
import {MorphoRateAdapter} from "../test/prototype/src/adapters/MorphoRateAdapter.sol";
import {
    UniswapV3ExactOutSwapAdapter
} from "../test/prototype/src/adapters/UniswapV3ExactOutSwapAdapter.sol";
import {
    AssetConfig,
    AssetKind,
    FundInitParams,
    Venue,
    Roles
} from "../test/prototype/src/FundTypes.sol";
import {FundSystemBase} from "./FundSystemBase.sol";

/// @title DeployFund
/// @notice The `fund` stage (Deploy 4): `RobotMoneyFund` behind its ERC-1967 proxy, initialized atomically with the
///         predicted fund-system timelock as its only upgrade authority (`UpgradeAuthority`); its four adapter copies
///         (Aave V3, Compound V3, Moonwell through the Morpho adapter, the Uniswap V3 exact-output swap adapter); the
///         adapter code hash allowlist; the §4.5 asset list with the real Base feeds and pools; the seed floor; and the
///         seed (E14), paid by the deployer and minted to the fund itself.
///
///         The deployer holds ADMIN_ROLE until the fund-timelock stage hands it to the timelock. EMERGENCY_ROLE goes to
///         EMERGENCY_ADDRESS at initialization, never to the deployer (ACL-1).
///
///         Required env vars (no defaults):
///           ADMIN_ADDRESS          — the deployer; ADMIN_ROLE until the handover
///           EMERGENCY_ADDRESS      — the emergency key (EMERGENCY_ROLE), never the deployer
///           FEE_RECIPIENT          — the exit fee recipient
///           SWAP_ROUTER            — the Uniswap V3 SwapRouter02 of the swap adapter
///           FUND_TVL_CAP, FUND_PER_DEPOSIT_CAP, FUND_EXIT_FEE_BPS, FUND_MAX_SLIPPAGE_BPS, FUND_NAV_DEVIATION_BPS
///           FUND_LENDING_CAP_BPS   — each lending venue's cap of NAV (the ADP ramp control)
///           FUND_MIN_SEED_USDC     — the seed floor set before the seed (§5.9.5 minSeedUsdc)
///           SEED_DEPOSIT_USDC      — the seed, at least FUND_MIN_SEED_USDC
///           SAFE_ADDRESS, TIMELOCK_MIN_DELAY, UPGRADE_MODE — the upgrade authority and release mode
///           DEPLOYMENT_OUT         — the output JSON path
contract DeployFund is FundSystemBase {
    /// @notice Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "fund.json";
    string public constant FUND_NAME = "Robot Money Fund";
    string public constant FUND_SYMBOL = "rmFUND";

    struct Inputs {
        address admin;
        address emergency;
        address feeRecipient;
        address swapRouter;
        uint256 tvlCap;
        uint256 perDepositCap;
        uint256 exitFeeBps;
        uint256 maxSlippageBps;
        uint256 navDeviationBps;
        uint16 lendingCapBps;
        uint256 minSeedUsdc;
        uint256 seedUsdc;
    }

    struct Deployed {
        address fund;
        address fundImplementation;
        address ledger;
        address aaveAdapter;
        address cometAdapter;
        address moonwellAdapter;
        address swapAdapter;
        uint256 seedShares;
        uint256 assetCount;
        UpgradeConfig upgrade;
    }

    /// @notice Forge broadcast entrypoint.
    function run() external returns (Deployed memory d) {
        _requireExpectedChain("");
        Inputs memory i = _readInputs();
        UpgradeConfig memory u = _readUpgradeConfig("");
        _envStringRequired("DEPLOYMENT_OUT");
        require(i.emergency != msg.sender, "EMERGENCY_ADDRESS == deployer EOA");

        vm.startBroadcast();
        d = _deploy(i, u);
        vm.stopBroadcast();

        _check(d, i);
        _writeDeploymentJson(d, i);
    }

    function _readInputs() internal view returns (Inputs memory i) {
        i.admin = _envNonZeroAddress("ADMIN_ADDRESS");
        i.emergency = _envNonZeroAddress("EMERGENCY_ADDRESS");
        i.feeRecipient = _envNonZeroAddress("FEE_RECIPIENT");
        i.swapRouter = _envContract("SWAP_ROUTER");
        i.tvlCap = _envUintRequired("FUND_TVL_CAP");
        i.perDepositCap = _envUintRequired("FUND_PER_DEPOSIT_CAP");
        require(i.tvlCap > 0, "FUND_TVL_CAP=0");
        require(i.perDepositCap <= i.tvlCap, "FUND_PER_DEPOSIT_CAP exceeds FUND_TVL_CAP");
        i.exitFeeBps = _envUintRequired("FUND_EXIT_FEE_BPS");
        i.maxSlippageBps = _envUintRequired("FUND_MAX_SLIPPAGE_BPS");
        i.navDeviationBps = _envUintRequired("FUND_NAV_DEVIATION_BPS");
        // §5.6: a slippage or deviation bound at or below the pool fee would make every step fail.
        require(
            i.maxSlippageBps > POOL_FEE / 100, "FUND_MAX_SLIPPAGE_BPS is at or below the pool fee"
        );
        require(
            i.navDeviationBps > POOL_FEE / 100, "FUND_NAV_DEVIATION_BPS is at or below the pool fee"
        );
        i.lendingCapBps = uint16(_envUintMax("FUND_LENDING_CAP_BPS", 10_000));
        require(i.lendingCapBps > 0, "FUND_LENDING_CAP_BPS=0");
        i.minSeedUsdc = _envUintRequired("FUND_MIN_SEED_USDC");
        i.seedUsdc = _envUintRequired("SEED_DEPOSIT_USDC");
        require(i.seedUsdc >= i.minSeedUsdc, "SEED_DEPOSIT_USDC is below FUND_MIN_SEED_USDC");
        require(i.seedUsdc <= i.tvlCap, "SEED_DEPOSIT_USDC exceeds FUND_TVL_CAP");
    }

    function _deploy(Inputs memory i, UpgradeConfig memory u) internal returns (Deployed memory d) {
        d.upgrade = u;
        FundInitParams memory p = FundInitParams({
            usdc: BASE_USDC,
            name: FUND_NAME,
            symbol: FUND_SYMBOL,
            tvlCap: i.tvlCap,
            perDepositCap: i.perDepositCap,
            exitFeeBps: i.exitFeeBps,
            feeRecipient: i.feeRecipient,
            maxSlippageBps: i.maxSlippageBps,
            navDeviationGuardBps: i.navDeviationBps,
            admin: i.admin,
            emergency: i.emergency
        });
        d.fundImplementation = address(new RobotMoneyFund());
        d.fund = _deployProxy(
            d.fundImplementation, abi.encodeCall(RobotMoneyFund.initialize, (p, u.timelock, u.mode))
        );
        RobotMoneyFund f = RobotMoneyFund(d.fund);
        d.ledger = f.exclusionLedger();

        // The adapters name the fund, so they follow it (the harness order: aave, comet, moonwell, swap).
        d.aaveAdapter = address(new AaveV3RateAdapter(AAVE_POOL, BASE_USDC, AAVE_A_USDC, d.fund));
        d.cometAdapter = address(new CompoundV3RateAdapter(COMET, BASE_USDC, d.fund));
        d.moonwellAdapter = address(new MorphoRateAdapter(MOONWELL, BASE_USDC, d.fund));
        d.swapAdapter = address(new UniswapV3ExactOutSwapAdapter(i.swapRouter));

        f.setAdapterCodeHashAllowed(d.aaveAdapter.codehash, true);
        f.setAdapterCodeHashAllowed(d.moonwellAdapter.codehash, true);
        f.setAdapterCodeHashAllowed(d.swapAdapter.codehash, true);
        f.setAdapterCodeHashAllowed(d.cometAdapter.codehash, true);

        // §4.5: three lending venues and two basket tokens; addAsset refuses an unhealthy feed (E15).
        require(f.addAsset(_lending(d.aaveAdapter, i.lendingCapBps)) == IDX_AAVE, "aave index");
        require(
            f.addAsset(_lending(d.moonwellAdapter, i.lendingCapBps)) == IDX_MOONWELL,
            "moonwell index"
        );
        require(
            f.addAsset(_basket(d.swapAdapter, WETH, WETH_POOL, FEED_ETH, ETH_FEED_MAX_AGE))
                == IDX_WETH,
            "weth index"
        );
        require(
            f.addAsset(_basket(d.swapAdapter, CBBTC, CBBTC_POOL, FEED_CBBTC, DAY_FEED_MAX_AGE))
                == IDX_CBBTC,
            "cbbtc index"
        );
        require(f.addAsset(_lending(d.cometAdapter, i.lendingCapBps)) == IDX_COMET, "comet index");

        // E14: the floor first, then the one seed at zero supply, minted to the fund itself.
        f.setMinSeedUsdc(i.minSeedUsdc);
        IERC20(BASE_USDC).approve(d.fund, i.seedUsdc);
        d.seedShares = f.seed(i.seedUsdc);
        d.assetCount = f.assetCount();
    }

    function _lending(address adapter, uint16 capBps) internal pure returns (AssetConfig memory) {
        return AssetConfig({
            kind: AssetKind.Lending,
            active: true,
            capBps: capBps,
            adapter: adapter,
            token: address(0),
            pool: address(0),
            poolFee: 0,
            twapWindow: 0,
            venue: Venue.V3,
            feed: address(0),
            maxFeedAge: 0
        });
    }

    function _basket(address adapter, address token, address pool, address feed, uint32 maxAge)
        internal
        pure
        returns (AssetConfig memory)
    {
        return AssetConfig({
            kind: AssetKind.Basket,
            active: true,
            capBps: 0,
            adapter: adapter,
            token: token,
            pool: pool,
            poolFee: POOL_FEE,
            twapWindow: TWAP_WINDOW,
            venue: Venue.V3,
            feed: feed,
            maxFeedAge: maxAge
        });
    }

    /// @dev Read back what the stage set: a stage that left any of it otherwise is not one a later stage builds on.
    function _check(Deployed memory d, Inputs memory i) internal view {
        RobotMoneyFund f = RobotMoneyFund(d.fund);
        require(d.assetCount == N_ASSETS, "fund: asset count");
        require(f.minSeedUsdc() == i.minSeedUsdc, "fund: minSeedUsdc");
        require(
            f.balanceOf(d.fund) == d.seedShares && f.totalSupply() == d.seedShares,
            "fund: seed shares"
        );
        require(f.balanceOf(i.admin) == 0, "fund: the deployer holds shares");
        require(
            f.hasRole(Roles.EMERGENCY_ROLE, i.emergency), "fund: emergency key lacks EMERGENCY_ROLE"
        );
        require(!f.hasRole(Roles.EMERGENCY_ROLE, i.admin), "fund: deployer holds EMERGENCY_ROLE");
        require(f.upgradeTimelock() == d.upgrade.timelock, "fund: upgradeTimelock");
        require(_implementationOf(d.fund) == d.fundImplementation, "fund: implementation slot");
        require(d.ledger != address(0) && d.ledger.code.length > 0, "fund: exclusion ledger");
    }

    function _writeDeploymentJson(Deployed memory d, Inputs memory i) internal {
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");
        string memory obj = "fund_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "fund", d.fund);
        vm.serializeAddress(obj, "fund_implementation", d.fundImplementation);
        vm.serializeAddress(obj, "exclusion_ledger", d.ledger);
        vm.serializeAddress(obj, "aave_adapter", d.aaveAdapter);
        vm.serializeAddress(obj, "compound_adapter", d.cometAdapter);
        vm.serializeAddress(obj, "moonwell_adapter", d.moonwellAdapter);
        vm.serializeAddress(obj, "swap_adapter", d.swapAdapter);
        vm.serializeAddress(obj, "emergency", i.emergency);
        vm.serializeAddress(obj, "fee_recipient", i.feeRecipient);
        vm.serializeUint(obj, "asset_count", d.assetCount);
        vm.serializeUint(obj, "seed_usdc", i.seedUsdc);
        vm.serializeUint(obj, "seed_shares", d.seedShares);
        vm.serializeUint(obj, "min_seed_usdc", i.minSeedUsdc);
        vm.serializeUint(obj, "tvl_cap", i.tvlCap);
        vm.serializeUint(obj, "per_deposit_cap", i.perDepositCap);
        vm.serializeAddress(obj, "upgrade_timelock", d.upgrade.timelock);
        string memory json =
            vm.serializeString(obj, "upgrade_mode", upgradeModeName(d.upgrade.mode));
        vm.writeJson(json, outPath);
        console2.log("Wrote fund deployment JSON to", outPath);
    }
}
