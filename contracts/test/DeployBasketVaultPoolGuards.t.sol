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

/// @dev A pool whose observation cardinality is 1 (below the floor of 2).
contract CardinalityOnePool is ConstPool {
    constructor(address a, address b, uint24 fee_) ConstPool(a, b, fee_) {}

    function slot0()
        external
        pure
        override
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        return (uint160(1 << 96), 0, 0, 1, 1, 0, true);
    }
}

/// @notice Core 1490 and 1492: the rmPROTO and rmRWA scripts refuse an asset whose pool has zero
///         liquidity, too little observation history or no code. These are the same three
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

    function _cardinalityOne() internal returns (string memory json) {
        address token = address(new TestERC20());
        json = _oneAssetJson(address(new CardinalityOnePool(token, address(usdc), 500)), token);
    }

    function test_proto_revertsOnZeroLiquidityPool() public {
        string memory json = _zeroLiquidity();
        vm.expectPartialRevert(BasketVault.InsufficientPoolLiquidity.selector);
        proto.runInProcess(_params(), json);
    }

    function test_proto_revertsOnCardinalityBelowTwo() public {
        string memory json = _cardinalityOne();
        vm.expectPartialRevert(BasketVault.InsufficientPoolCardinality.selector);
        proto.runInProcess(_params(), json);
    }

    function test_rwa_revertsOnZeroLiquidityPool() public {
        string memory json = _zeroLiquidity();
        vm.expectPartialRevert(BasketVault.InsufficientPoolLiquidity.selector);
        rwa.runInProcess(_params(), json);
    }

    function test_rwa_revertsOnCardinalityBelowTwo() public {
        string memory json = _cardinalityOne();
        vm.expectPartialRevert(BasketVault.InsufficientPoolCardinality.selector);
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
}
