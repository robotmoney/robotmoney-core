// SPDX-License-Identifier: MIT
// Canonical: robotmoney/devops issue 53 / core issue 1499; core 1490 (rmPROTO), core 1492 (rmRWA).
pragma solidity ^0.8.24;

import {DeployProtocolAssetVault} from "../script/DeployProtocolAssetVault.s.sol";
import {DeployRwaBasketVault} from "../script/DeployRwaBasketVault.s.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {BasketDeployFixture, ConstPool, TestERC20} from "./helpers/BasketDeployFixture.sol";

/// @dev A pool that looks usable except it holds no liquidity (the wSOL shape at Base block 52082423).
contract ZeroLiquidityPool is ConstPool {
    constructor(address a, address b, uint24 fee_) ConstPool(a, b, fee_) {}

    function liquidity() external pure override returns (uint128) {
        return 0;
    }
}

/// @dev A pool that reports exactly `liq` of in-range liquidity.
contract FixedLiquidityPool is ConstPool {
    uint128 private immutable _liq;

    constructor(address a, address b, uint24 fee_, uint128 liq) ConstPool(a, b, fee_) {
        _liq = liq;
    }

    function liquidity() external view override returns (uint128) {
        return _liq;
    }
}

/// @dev A pool whose observation cardinality is 900, one below the 1800 s window floor of 901 (core 1665).
contract CardinalityBelowFloorPool is ConstPool {
    constructor(address a, address b, uint24 fee_) ConstPool(a, b, fee_) {}

    function slot0()
        external
        pure
        override
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        return (uint160(1 << 96), 0, 0, 900, 900, 0, true);
    }
}

/// @notice Core 1490 and 1492: the rmPROTO and rmRWA scripts refuse an asset whose pool has zero
///         liquidity (the sheet floor catches it before `addAsset`), too little observation history or no code. These are the same three
///         live-pool facts the config-check script rejects, so a pool shaped like wSOL
///         (empty pool) cannot reach a deployed vault through either script.
contract DeployBasketVaultPoolGuardsTest is BasketDeployFixture {
    DeployProtocolAssetVault internal proto;
    DeployRwaBasketVault internal rwa;

    function setUp() public {
        _fixtureSetUp();
        proto = new DeployProtocolAssetVault();
        rwa = new DeployRwaBasketVault();
    }

    function _oneAssetJson(address pool, address token) internal view returns (string memory) {
        address[] memory tokens = new address[](1);
        address[] memory pools = new address[](1);
        tokens[0] = token;
        pools[0] = pool;
        return _json("assets", tokens, pools, 500);
    }

    function _zeroLiquidity() internal returns (string memory json) {
        address token = address(new TestERC20());
        json = _oneAssetJson(address(new ZeroLiquidityPool(token, address(usdc), 500)), token);
    }

    address internal lowPool;

    function _cardinalityBelowFloor() internal returns (string memory json) {
        address token = address(new TestERC20());
        lowPool = address(new CardinalityBelowFloorPool(token, address(usdc), 500));
        json = _oneAssetJson(lowPool, token);
    }

    function test_proto_revertsOnZeroLiquidityPool() public {
        string memory json = _zeroLiquidity();
        vm.expectRevert(bytes("T0: pool liquidity is below MIN_POOL_LIQUIDITY"));
        proto.runInProcess(_params(), json);
    }

    function test_proto_revertsOnCardinalityBelowWindowFloor() public {
        string memory json = _cardinalityBelowFloor();
        vm.expectRevert(
            abi.encodeWithSelector(
                BasketVault.InsufficientPoolCardinality.selector, lowPool, uint16(901), uint16(900)
            )
        );
        proto.runInProcess(_params(), json);
    }

    function test_rwa_revertsOnZeroLiquidityPool() public {
        string memory json = _zeroLiquidity();
        vm.expectRevert(bytes("T0: pool liquidity is below MIN_POOL_LIQUIDITY"));
        rwa.runInProcess(_params(), json);
    }

    function test_rwa_revertsOnCardinalityBelowWindowFloor() public {
        string memory json = _cardinalityBelowFloor();
        vm.expectRevert(
            abi.encodeWithSelector(
                BasketVault.InsufficientPoolCardinality.selector, lowPool, uint16(901), uint16(900)
            )
        );
        rwa.runInProcess(_params(), json);
    }

    function test_rwa_revertsWhenPoolHasNoCode() public {
        string memory json = _oneAssetJson(makeAddr("emptyPool"), makeAddr("tokenX"));
        vm.expectRevert(bytes("T0: pool has no code"));
        rwa.runInProcess(_params(), json);
    }

    /// @notice Control: the same shape with liquidity and cardinality deploys, so the reverts
    ///         above are caused by the pool facts and not by the harness.
    function test_proto_controlUsablePoolDeploys() public {
        address token = address(new TestERC20());
        string memory json = _oneAssetJson(address(new ConstPool(token, address(usdc), 500)), token);
        BasketVaultDeployBase.Deployed memory d = proto.runInProcess(_params(), json);
        assertEq(d.tokens.length, 1);
        assertTrue(d.paused);
    }

    // ─── Issue 1666: the sheet floor on in-range liquidity ────────────────────

    uint128 internal constant FLOOR = 5e12;

    function _poolWithLiquidity(uint128 liq) internal returns (string memory json) {
        address token = address(new TestERC20());
        json = _oneAssetJson(address(new FixedLiquidityPool(token, address(usdc), 500, liq)), token);
    }

    function _paramsWithFloor() internal view returns (BasketVaultDeployBase.Params memory p) {
        p = _params();
        p.minPoolLiquidity = FLOOR;
    }

    function test_proto_revertsWhenPoolLiquidityIsBelowTheSheetFloor() public {
        string memory json = _poolWithLiquidity(FLOOR - 1);
        vm.expectRevert(bytes("T0: pool liquidity is below MIN_POOL_LIQUIDITY"));
        proto.runInProcess(_paramsWithFloor(), json);
    }

    function test_proto_succeedsWhenPoolLiquidityEqualsTheSheetFloor() public {
        string memory json = _poolWithLiquidity(FLOOR);
        BasketVaultDeployBase.Deployed memory d = proto.runInProcess(_paramsWithFloor(), json);
        assertEq(d.tokens.length, 1);
    }

    function test_rwa_revertsWhenPoolLiquidityIsBelowTheSheetFloor() public {
        string memory json = _poolWithLiquidity(FLOOR - 1);
        vm.expectRevert(bytes("T0: pool liquidity is below MIN_POOL_LIQUIDITY"));
        rwa.runInProcess(_paramsWithFloor(), json);
    }

    function test_rwa_succeedsWhenPoolLiquidityEqualsTheSheetFloor() public {
        string memory json = _poolWithLiquidity(FLOOR);
        BasketVaultDeployBase.Deployed memory d = rwa.runInProcess(_paramsWithFloor(), json);
        assertEq(d.tokens.length, 1);
    }
}
