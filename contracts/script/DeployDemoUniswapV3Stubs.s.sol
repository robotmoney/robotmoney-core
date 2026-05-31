// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md#112-protocol-asset-vault (issue #531)
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {UniswapV3PoolSlot0Stub} from "../UniswapV3PoolSlot0Stub.sol";

/// @title DeployDemoUniswapV3Stubs
/// @notice Demo-only deploy script that creates four `UniswapV3PoolSlot0Stub`
///         instances on the smoke-test devnet, one per landing-page price-strip
///         pair:
///           - ETH/USD   (sqrtPriceX96 ≈ $2 500, token0=WETH-18, token1=USDC-6)
///           - wETH/USDC (same sqrtPriceX96, separate address for dex-pools.json
///                        completeness)
///           - cbBTC/USDC (sqrtPriceX96 ≈ $60 000, token0=cbBTC-8, token1=USDC-6)
///           - wSOL/USDC  (sqrtPriceX96 ≈ $150,    token0=wSOL-9,  token1=USDC-6)
///
///         Uses the Arachnid deterministic-deployment-proxy (address
///         0x4e59b44847b379578588920cA78FbF26c0B4956C, pre-installed in the
///         devnet genesis via `genesis_alloc.rs`) with fixed salts so the
///         deployed addresses are **deterministic** and pre-committed in
///         `config/dex-pools.json::devnet.pools` and
///         `testing/ethereum-testnet/config/expected-prices.json`.
///
///         Required env vars: none (all seeds are hardcoded).
///         Optional env vars:
///           DEPLOYMENT_OUT — output JSON path
///                            (default: "deployments/demo-uniswap-v3-stubs-<chain_id>.json")
///
///         NEVER use on a real chain.  Demo/devnet only.
contract DeployDemoUniswapV3Stubs is Script {
    using stdJson for string;

    /// @notice Arachnid deterministic-deployment-proxy.
    ///         Pre-installed at genesis by genesis_alloc::ARACHNID_FACTORY_ADDR.
    address internal constant ARACHNID_FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // ─── Seed sqrtPriceX96 values (Q64.96 fixed-point) ──────────────────────
    //
    // Formula: sqrtPriceX96 = sqrt(price * 10^quoteDecimals / 10^baseDecimals) * 2^96
    //
    // ETH/USD — price ≈ $2 500, token0=WETH(18), token1=USDC(6):
    //   raw = 2500 * 1e6 / 1e18 = 2.5e-12
    //   sqrtPriceX96 = floor(sqrt(2.5e-12) * 2^96)
    uint160 internal constant SQRT_PRICE_ETH_USD = 3_961_408_125_713_217_069_514_752;

    // cbBTC/USDC — price ≈ $60 000, token0=cbBTC(8), token1=USDC(6):
    //   raw = 60000 * 1e6 / 1e8 = 600
    //   sqrtPriceX96 = floor(sqrt(600) * 2^96)
    uint160 internal constant SQRT_PRICE_CBBTC_USDC = 1_940_685_714_182_491_821_455_964_110_848;

    // wSOL/USDC — price ≈ $150, token0=wSOL(9), token1=USDC(6):
    //   raw = 150 * 1e6 / 1e9 = 0.15
    //   sqrtPriceX96 = floor(sqrt(0.15) * 2^96)
    uint160 internal constant SQRT_PRICE_WSOL_USDC = 30_684_935_396_836_053_642_039_525_376;

    // ─── Fixed CREATE2 salts ─────────────────────────────────────────────────
    //
    // Salt is passed to the Arachnid factory as the first 32 bytes of calldata,
    // followed by the initcode. Using fixed salts ensures the deployed addresses
    // are pre-computable and stable across devnet resets.
    bytes32 internal constant SALT_ETH_USD =
        0x0000000000000000000000000000000000000000000000000000000000000001;
    bytes32 internal constant SALT_WETH_USDC =
        0x0000000000000000000000000000000000000000000000000000000000000002;
    bytes32 internal constant SALT_CBBTC_USDC =
        0x0000000000000000000000000000000000000000000000000000000000000003;
    bytes32 internal constant SALT_WSOL_USDC =
        0x0000000000000000000000000000000000000000000000000000000000000004;

    /// @notice Result struct returned to in-process callers and written to JSON.
    struct Deployed {
        address ethUsd;
        address wethUsdc;
        address cbbtcUsdc;
        address wsolUsdc;
    }

    /// @notice Forge broadcast entrypoint.
    function run() external returns (Deployed memory d) {
        vm.startBroadcast();
        d = _doDeploy();
        vm.stopBroadcast();

        _writeDeploymentJson(d);
        _logResult(d);
    }

    /// @dev Deploy all four stubs via the Arachnid CREATE2 factory.
    function _doDeploy() internal returns (Deployed memory d) {
        d.ethUsd = _deployViaFactory(SALT_ETH_USD, SQRT_PRICE_ETH_USD);
        d.wethUsdc = _deployViaFactory(SALT_WETH_USDC, SQRT_PRICE_ETH_USD);
        d.cbbtcUsdc = _deployViaFactory(SALT_CBBTC_USDC, SQRT_PRICE_CBBTC_USDC);
        d.wsolUsdc = _deployViaFactory(SALT_WSOL_USDC, SQRT_PRICE_WSOL_USDC);
    }

    /// @dev Deploy `UniswapV3PoolSlot0Stub(sqrtPriceX96)` via the Arachnid
    ///      factory at `ARACHNID_FACTORY` with the given `salt`.
    ///      Calldata layout: `salt (32 bytes) ++ initcode`.
    ///      Returns the deterministic CREATE2 address.
    function _deployViaFactory(bytes32 salt, uint160 sqrtPriceX96)
        internal
        returns (address deployed)
    {
        bytes memory initcode = abi.encodePacked(
            type(UniswapV3PoolSlot0Stub).creationCode, abi.encode(sqrtPriceX96)
        );
        bytes memory payload = abi.encodePacked(salt, initcode);
        (bool ok,) = ARACHNID_FACTORY.call(payload);
        require(ok, "Arachnid factory call failed");

        // Compute the expected address to return it.
        deployed = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), ARACHNID_FACTORY, salt, keccak256(initcode))
                    )
                )
            )
        );
    }

    function _logResult(Deployed memory d) internal pure {
        console2.log("DeployDemoUniswapV3Stubs complete");
        console2.log("  eth-usd    :", d.ethUsd);
        console2.log("  weth-usdc  :", d.wethUsdc);
        console2.log("  cbbtc-usdc :", d.cbbtcUsdc);
        console2.log("  wsol-usdc  :", d.wsolUsdc);
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath;
        try vm.envString("DEPLOYMENT_OUT") returns (string memory s) {
            outPath = s;
        } catch {
            outPath = string.concat(
                "deployments/demo-uniswap-v3-stubs-", vm.toString(block.chainid), ".json"
            );
        }

        string memory obj = "demo_uniswap_v3_stubs";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "eth_usd", d.ethUsd);
        vm.serializeAddress(obj, "weth_usdc", d.wethUsdc);
        vm.serializeAddress(obj, "cbbtc_usdc", d.cbbtcUsdc);
        string memory json = vm.serializeAddress(obj, "wsol_usdc", d.wsolUsdc);

        vm.writeJson(json, outPath);
        console2.log("Wrote stubs deployment JSON to", outPath);
    }
}
