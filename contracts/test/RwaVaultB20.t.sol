// SPDX-License-Identifier: MIT
// Canonical: docs/technical/base-tokenized-stocks-research.md, core issue 1500
//            docs/prd.md §11.4 — RWA / Thematic Vault (rmRWA)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RwaBasketVault} from "../vaults/RwaBasketVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {BasketAssetConfigGuard} from "../lib/BasketAssetConfigGuard.sol";
import {AerodromeSwapAdapter} from "../adapters/AerodromeSwapAdapter.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev Slipstream pool double: every field is an immutable or a constant.
contract B20ConstPool {
    address public immutable token0;
    address public immutable token1;
    int24 public immutable tickSpacing;

    constructor(address a, address b, int24 spacing) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        tickSpacing = spacing;
    }

    function liquidity() external pure returns (uint128) {
        return 1e18;
    }

    function slot0() external pure returns (uint160, int24, uint16, uint16, uint16, bool) {
        return (uint160(1 << 96), 0, 0, 100, 100, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        pure
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiq = new uint160[](secondsAgos.length);
    }
}

/// @notice Unit coverage for adding Coinbase B20 tokens to rmRWA (core 1500). The four B20 token
///         accounts carry the single byte 0xef as code on Base. A token with no bytecode is
///         rejected. The 0xef marker is the one explicit allowance.
contract RwaVaultB20Test is Test {
    using stdJson for string;

    int24 internal constant TICK_SPACING = 10;

    TestERC20 internal usdc;
    RwaBasketVault internal vault;
    AerodromeSwapAdapter internal adapter;
    string internal cfg;
    address internal admin = makeAddr("admin");

    function setUp() public {
        usdc = new TestERC20();
        vault = new RwaBasketVault(
            IERC20(address(usdc)),
            ISwapRouter(makeAddr("router02")),
            100_000e6,
            10_000e6,
            0,
            makeAddr("feeRecipient"),
            admin,
            admin
        );
        adapter = new AerodromeSwapAdapter(makeAddr("slipstreamRouter"), makeAddr("factory"));
        vm.prank(admin);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        cfg = vm.readFile("config/rwa-b20-assets.json");
    }

    function _pool(address token) internal returns (address) {
        return address(new B20ConstPool(token, address(usdc), TICK_SPACING));
    }

    function _add(address token, address pool) internal {
        vm.prank(admin);
        vault.addAsset(
            token, pool, uint24(uint24(TICK_SPACING)), address(adapter), BasketVault.Venue.Aerodrome
        );
    }

    function test_config_listsFourB20TokensWithEightDecimals() public view {
        for (uint256 i = 0; i < 4; i++) {
            string memory k = string.concat(".assets[", vm.toString(i), "]");
            assertEq(cfg.readUint(string.concat(k, ".tokenDecimals")), 8);
            assertEq(cfg.readString(string.concat(k, ".venue")), "Aerodrome");
            assertEq(cfg.readUint(string.concat(k, ".poolFee")), 10);
            assertEq(uint160(cfg.readAddress(string.concat(k, ".token"))) >> 144, 0xb200);
        }
        assertEq(cfg.readString(".assets[0].symbol"), "METAc");
        assertEq(cfg.readString(".assets[1].symbol"), "NVDAc");
        assertEq(cfg.readString(".assets[2].symbol"), "GOOGLc");
        assertEq(cfg.readString(".assets[3].symbol"), "TSLAc");
    }

    function test_addAsset_rejectsTokenWithNoBytecode() public {
        address token = cfg.readAddress(".assets[0].token");
        assertEq(token.code.length, 0, "fixture: no code at the token address");
        address pool = _pool(token);
        vm.expectRevert(
            abi.encodeWithSelector(BasketAssetConfigGuard.TokenHasNoCode.selector, token)
        );
        _add(token, pool);
    }

    function test_addAsset_rejectsOtherOneByteCode() public {
        address token = cfg.readAddress(".assets[0].token");
        vm.etch(token, hex"fe");
        address pool = _pool(token);
        vm.expectRevert(
            abi.encodeWithSelector(BasketAssetConfigGuard.TokenHasNoCode.selector, token)
        );
        _add(token, pool);
    }

    function test_addAsset_acceptsTheFourB20Addresses() public {
        for (uint256 i = 0; i < 4; i++) {
            address token = cfg.readAddress(string.concat(".assets[", vm.toString(i), "].token"));
            vm.etch(token, hex"ef");
            _add(token, _pool(token));
        }
        assertEq(vault.assetCount(), 4);
    }

    function test_addAsset_acceptsOrdinaryContractToken() public {
        TestERC20 plain = new TestERC20();
        _add(address(plain), _pool(address(plain)));
        assertEq(vault.assetCount(), 1);
    }

    function test_cap_holdsLaunchAssetPlusFourB20() public {
        assertEq(vault.maxAssets(), 10);
        for (uint256 i = 0; i < 5; i++) {
            TestERC20 t = new TestERC20();
            _add(address(t), _pool(address(t)));
        }
        assertEq(vault.assetCount(), 5, "deSPXA plus four B20 fit under the asset cap");
    }
}
