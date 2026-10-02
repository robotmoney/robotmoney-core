// SPDX-License-Identifier: MIT
// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops), core S4 (issue 1486)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {BasketVaultDeployBase} from "../../script/BasketVaultDeployBase.sol";
import {VaultRegistry} from "../../VaultRegistry.sol";
import {TestERC20} from "./TestERC20.sol";

/// @dev Uniswap V3 pool double whose every field is an immutable or a constant, so its runtime code
///      can be etched at a real pool address with no storage. 1:1 TWAP, deep cardinality and
///      liquidity, `fee()` as constructed.
contract ConstPool {
    address public immutable token0;
    address public immutable token1;
    uint24 private immutable _fee;

    constructor(address a, address b, uint24 fee_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        _fee = fee_;
    }

    function fee() external view returns (uint24) {
        return _fee;
    }

    function liquidity() external pure returns (uint128) {
        return 1e18;
    }

    function slot0()
        external
        pure
        virtual
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        return (uint160(1 << 96), 0, 0, 100, 100, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        pure
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiq = new uint160[](secondsAgos.length);
    }

    function observations(uint256) external view returns (uint32, int56, uint160, bool) {
        return (uint32(block.timestamp), 0, 0, true);
    }
}

/// @dev Shared setup for the three basket vault script tests. The scripts run in process under a
///      prank of `deployer`. Pools are `ConstPool` instances: a unit test has no live Uniswap.
///      A config-file test etches the mock code at each configured pool address, so the script
///      reads the real `config/*.json` and the assertions compare chain state to that file.
abstract contract BasketDeployFixture is Test {
    using stdJson for string;

    TestERC20 internal usdc;
    VaultRegistry internal registry;
    address internal deployer = makeAddr("deployer");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal router02 = makeAddr("swapRouter02");

    uint256 internal constant TVL_CAP = 50_000 * 1e6;
    uint256 internal constant PER_DEPOSIT_CAP = 5_000 * 1e6;

    function _fixtureSetUp() internal {
        usdc = new TestERC20();
        registry = new VaultRegistry(deployer);
    }

    function _params() internal view returns (BasketVaultDeployBase.Params memory p) {
        p = BasketVaultDeployBase.Params({
            admin: deployer,
            swapRouter: router02,
            usdc: address(usdc),
            registry: address(registry),
            tvlCap: TVL_CAP,
            perDepositCap: PER_DEPOSIT_CAP,
            exitFeeBps: 0,
            feeRecipient: feeRecipient
        });
    }

    /// @dev Config body with `swapRouter02` and one row per `tokens[i]`/`pools[i]`.
    function _json(string memory key, address[] memory tokens, address[] memory pools, uint24 fee)
        internal
        view
        returns (string memory out)
    {
        string memory rows = "";
        for (uint256 i = 0; i < tokens.length; i++) {
            rows = string.concat(
                rows,
                i == 0 ? "" : ",",
                '{"symbol":"T',
                vm.toString(i),
                '","token":"',
                vm.toString(tokens[i]),
                '","tokenDecimals":18,"venue":"UniswapV3","pool":"',
                vm.toString(pools[i]),
                '","poolFee":',
                vm.toString(uint256(fee)),
                "}"
            );
        }
        out = string.concat(
            '{"swapRouter02":"', vm.toString(router02), '","', key, '":[', rows, "]}"
        );
    }

    /// @dev A fresh token and a usable mock pool for it at fee 500.
    function _tokenAndPool(string memory label) internal returns (address token, address pool) {
        token = address(new TestERC20());
        pool = address(new ConstPool(token, address(usdc), 500));
        vm.label(token, label);
    }

    /// @dev Etch a usable mock pool (paired with this test's USDC) at every pool address named by
    ///      `file[arrayKey]`, so the script can run against the real config file.
    function _etchConfigPools(string memory file, string memory arrayKey)
        internal
        returns (string memory json)
    {
        json = vm.readFile(file);
        string memory root = string.concat(".", arrayKey);
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(root, "[", vm.toString(n), "]"))) n++;
        address[] memory tokens = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            tokens[i] = json.readAddress(string.concat(root, "[", vm.toString(i), "].token"));
        }
        for (uint256 i = 0; i < n; i++) {
            address pool = json.readAddress(string.concat(root, "[", vm.toString(i), "].pool"));
            uint24 fee =
                uint24(json.readUint(string.concat(root, "[", vm.toString(i), "].poolFee")));
            vm.etch(pool, address(new ConstPool(tokens[i], address(usdc), fee)).code);
            if (tokens[i].code.length == 0) vm.etch(tokens[i], address(new TestERC20()).code);
        }
    }

    function _configRouter(string memory json) internal pure returns (address) {
        return json.readAddress(".swapRouter02");
    }
}
