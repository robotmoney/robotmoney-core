// SPDX-License-Identifier: MIT
// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops), core S4 (issue 1486)
//            docs/architecture.md §4.1 — Vault Family (basket vaults)
//
// One production path for the three basket vaults (rmPROTO, rmAGENT, rmRWA). The scripts differ
// only in the vault class, the config file and whether assets route through the
// `UniswapV3SwapAdapter`. There is no chain-id branch and no devnet-only input.
pragma solidity ^0.8.24;

import {ExpectedChainGuard} from "./ExpectedChainGuard.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {BasketVault} from "../vaults/BasketVault.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {UniswapV3SwapAdapter} from "../adapters/UniswapV3SwapAdapter.sol";
import {TickMath} from "../lib/TickMath.sol";
import {IUniswapV3Pool} from "../interfaces/IUniswapV3Pool.sol";

/// @dev Shared flow: validate sheet inputs, deploy the vault, check each configured pool,
///      add each configured asset, pause, register, write the manifest.
///
///      Roles. The broadcaster is `admin` and also holds EMERGENCY_ROLE on the new vault. The
///      deployer needs ADMIN_ROLE for `addAsset` and `setAdapterCodeHashAllowed`, and
///      EMERGENCY_ROLE for `pause()`. The timelock stage hands both roles over and revokes the
///      deployer (core 1487). This script never grants a role to anyone else.
abstract contract BasketVaultDeployBase is ExpectedChainGuard {
    using stdJson for string;

    /// @notice Sheet inputs for one deploy.
    struct Params {
        address admin;
        address swapRouter;
        address usdc;
        address registry;
        uint256 tvlCap;
        uint256 perDepositCap;
        uint256 exitFeeBps;
        address feeRecipient;
    }

    /// @notice One configured basket row, read from a config file.
    struct AssetCfg {
        string symbol;
        address token;
        address pool;
        uint24 poolFee;
    }

    /// @notice A parsed config file.
    struct Cfg {
        address swapRouter02;
        AssetCfg[] assets;
    }

    /// @notice Result returned to in-process callers (forge tests, stage driver).
    struct Deployed {
        address vault;
        address registry;
        address adapter;
        address[] tokens;
        bool registered;
        bool paused;
    }

    // ─── Per-vault hooks ──────────────────────────────────────────────────────

    /// @dev Construct the concrete vault. `emergencyResponder` is the deployer for this run.
    function _newVault(Params memory p, address emergencyResponder)
        internal
        virtual
        returns (BasketVault);

    /// @dev Name stored in the registry.
    function _registryName() internal pure virtual returns (string memory);

    /// @dev Manifest object key and log label.
    function _label() internal pure virtual returns (string memory);

    /// @dev True when assets route through a deployed `UniswapV3SwapAdapter`. False uses the
    ///      built-in SwapRouter02 path (adapter address 0).
    function _usesAdapter() internal pure virtual returns (bool);

    // ─── Env readers shared by the three scripts ─────────────────────────────

    /// @dev Reads the sheet inputs. Every value is required: no default for a cap or a recipient.
    function _readParams() internal view returns (Params memory p) {
        return _readParamsFrom("");
    }

    /// @dev `_readParams` with a name prefix. Production passes "". Tests pass a unique prefix
    ///      because env vars are process-wide and forge runs test contracts in parallel.
    function _readParamsFrom(string memory prefix) internal view returns (Params memory p) {
        p.admin = _envAddressRequired(string.concat(prefix, "ADMIN_ADDRESS"));
        p.swapRouter = _envAddressRequired(string.concat(prefix, "SWAP_ROUTER"));
        p.usdc = BASE_USDC;
        p.registry = _envAddressRequired(string.concat(prefix, "REGISTRY_ADDRESS"));
        p.tvlCap = _envUintRequired(string.concat(prefix, "TVL_CAP"));
        p.perDepositCap = _envUintRequired(string.concat(prefix, "PER_DEPOSIT_CAP"));
        p.exitFeeBps = _envUintRequired(string.concat(prefix, "EXIT_FEE_BPS"));
        p.feeRecipient = _envAddressRequired(string.concat(prefix, "FEE_RECIPIENT"));
    }

    /// @dev The broadcast entrypoint shared by the three scripts. The chain guard is the first
    ///      statement, then the sheet inputs, then the config file, then the deploy. `prefix` is
    ///      "" in production.
    function _runFrom(string memory prefix, string memory configFile, string memory arrayKey)
        internal
        returns (Deployed memory d)
    {
        _requireExpectedChain(prefix);
        Params memory p = _readParamsFrom(prefix);
        Cfg memory cfg = _parseCfg(vm.readFile(configFile), arrayKey);

        vm.startBroadcast();
        d = _deployAll(p, cfg);
        vm.stopBroadcast();

        _writeManifest(d, cfg);
    }

    // ─── Config parsing ───────────────────────────────────────────────────────

    /// @dev Parse a config file body. `arrayKey` is "assets" or "shortlist".
    function _parseCfg(string memory json, string memory arrayKey)
        internal
        view
        returns (Cfg memory cfg)
    {
        cfg.swapRouter02 = json.readAddress(".swapRouter02");
        string memory root = string.concat(".", arrayKey);
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(root, "[", vm.toString(n), "]"))) n++;
        string[] memory symbols = new string[](n);
        for (uint256 i = 0; i < n; i++) {
            symbols[i] = json.readString(string.concat(root, "[", vm.toString(i), "].symbol"));
        }
        cfg.assets = new AssetCfg[](symbols.length);
        for (uint256 i = 0; i < symbols.length; i++) {
            string memory base = string.concat(root, "[", vm.toString(i), "]");
            AssetCfg memory a = cfg.assets[i];
            a.symbol = symbols[i];
            a.token = json.readAddress(string.concat(base, ".token"));
            a.pool = json.readAddress(string.concat(base, ".pool"));
            a.poolFee = uint24(json.readUint(string.concat(base, ".poolFee")));
            require(
                keccak256(bytes(json.readString(string.concat(base, ".venue"))))
                    == keccak256("UniswapV3"),
                "unsupported venue: only UniswapV3"
            );
            require(a.token != address(0), "config token unset");
            require(a.pool != address(0), "config pool unset");
            require(a.poolFee != 0, "config poolFee unset");
        }
    }

    // ─── Core flow ────────────────────────────────────────────────────────────

    /// @dev Validates inputs, deploys, adds assets, pauses and registers. The caller owns the
    ///      broadcast (or prank) context: every call below is made as `p.admin`.
    function _deployAll(Params memory p, Cfg memory cfg) internal returns (Deployed memory d) {
        require(p.admin != address(0), "ADMIN_ADDRESS=0");
        require(p.swapRouter != address(0), "SWAP_ROUTER=0");
        require(p.usdc != address(0), "usdc=0");
        require(p.registry != address(0), "REGISTRY_ADDRESS=0");
        require(p.feeRecipient != address(0), "FEE_RECIPIENT=0");
        require(p.tvlCap != 0, "TVL_CAP missing from the sheet");
        require(p.perDepositCap != 0, "PER_DEPOSIT_CAP missing from the sheet");
        require(p.perDepositCap <= p.tvlCap, "PER_DEPOSIT_CAP exceeds TVL_CAP");
        require(cfg.swapRouter02 != address(0), "config swapRouter02 unset");
        require(p.swapRouter == cfg.swapRouter02, "SWAP_ROUTER is not SwapRouter02");

        BasketVault vault = _newVault(p, p.admin);
        d.vault = address(vault);
        d.registry = p.registry;
        d.tokens = new address[](cfg.assets.length);

        _addAssets(vault, p, cfg, d);

        // Deployed paused. The govern stage unpauses after the checks pass.
        vault.pause();
        d.paused = true;

        _registerIfAbsent(VaultRegistry(p.registry), address(vault), p.usdc);
        d.registered = true;

        // Finding L3-D1: the vault DELEGATECALLs a deploy-time-linked TickMath library on the NAV
        // path. Fail the deploy on a mislinked, zero or non-canonical library.
        _assertTickMathLinkIntegrity(address(vault), p.tvlCap);
    }

    /// @dev TickMath link integrity for one vault (finding L3-D1). The reference is the library
    ///      linked into this script: a correctly linked vault points at the same instance with
    ///      the same runtime codehash. Also probes `totalAssets()`: it must not revert and must
    ///      stay far below a sane ceiling (1000 times the TVL cap).
    function _assertTickMathLinkIntegrity(address vault, uint256 tvlCap) internal view {
        address canonicalLib = address(TickMath);
        require(canonicalLib != address(0), "TickMath: zero linked library");
        require(canonicalLib.code.length > 0, "TickMath: linked library has no code");
        address lib = BasketVault(vault).tickMathLibrary();
        require(lib != address(0), "TickMath: zero linked library");
        require(lib.code.length > 0, "TickMath: linked library has no code");
        require(lib == canonicalLib, "TickMath: vault links non-canonical library");
        require(lib.codehash == canonicalLib.codehash, "TickMath: codehash mismatch");
        require(
            BasketVault(vault).totalAssets() <= tvlCap * 1000, "TickMath: totalAssets out of range"
        );
    }

    function _addAssets(BasketVault vault, Params memory p, Cfg memory cfg, Deployed memory d)
        internal
    {
        if (cfg.assets.length == 0) return;
        address adapter = address(0);
        if (_usesAdapter()) {
            adapter = address(new UniswapV3SwapAdapter(p.swapRouter));
            vault.setAdapterCodeHashAllowed(adapter.codehash, true);
            d.adapter = adapter;
        }
        for (uint256 i = 0; i < cfg.assets.length; i++) {
            AssetCfg memory a = cfg.assets[i];
            _checkPool(a);
            vault.addAsset(a.token, a.pool, a.poolFee, adapter, BasketVault.Venue.V3);
            d.tokens[i] = a.token;
        }
    }

    /// @dev Config check on chain: pool code present and live fee equals config. Cardinality
    ///      and liquidity floors are enforced by `addAsset` itself.
    function _checkPool(AssetCfg memory a) internal view {
        require(a.pool.code.length != 0, string.concat(a.symbol, ": pool has no code"));
        require(
            IUniswapV3Pool(a.pool).fee() == a.poolFee,
            string.concat(a.symbol, ": pool fee does not equal config")
        );
    }

    function _registerIfAbsent(VaultRegistry registry, address vault, address asset) internal {
        address[] memory existing = registry.listVaults();
        for (uint256 i = 0; i < existing.length; i++) {
            if (existing[i] == vault) {
                console2.log(_label(), ": vault already registered, skipping");
                return;
            }
        }
        registry.registerVault(
            vault,
            VaultRegistry.VaultMetadata({name: _registryName(), asset: asset, registeredAt: 0})
        );
    }

    /// @dev Manifest: chain id, vault, registry, adapter, paused flag and the asset list.
    function _writeManifest(Deployed memory d, Cfg memory cfg) internal {
        _writeManifestTo(_manifestPath(), d, cfg);
    }

    /// @dev `DEPLOYMENT_OUT` is required. There is no default path.
    function _manifestPath() internal view returns (string memory) {
        return _envStringRequired("DEPLOYMENT_OUT");
    }

    function _writeManifestTo(string memory outPath, Deployed memory d, Cfg memory cfg) internal {
        string memory assetsJson = "[";
        for (uint256 i = 0; i < cfg.assets.length; i++) {
            string memory item = string.concat(
                '{"symbol":"',
                cfg.assets[i].symbol,
                '","token":"',
                vm.toString(cfg.assets[i].token),
                '","pool":"',
                vm.toString(cfg.assets[i].pool),
                '","pool_fee":',
                vm.toString(uint256(cfg.assets[i].poolFee)),
                "}"
            );
            assetsJson = string.concat(assetsJson, i == 0 ? "" : ",", item);
        }
        assetsJson = string.concat(assetsJson, "]");
        string memory json = string.concat(
            '{"chain_id":',
            vm.toString(block.chainid),
            ',"vault":"',
            vm.toString(d.vault),
            '","registry":"',
            vm.toString(d.registry),
            '","adapter":"',
            vm.toString(d.adapter),
            '","registered":',
            d.registered ? "true" : "false",
            ',"paused":',
            d.paused ? "true" : "false",
            ',"assets":',
            assetsJson,
            "}"
        );
        vm.writeFile(outPath, json);
        console2.log(string.concat("Wrote ", _label(), " manifest to"), outPath);
    }
}
