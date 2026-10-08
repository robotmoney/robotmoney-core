// SPDX-License-Identifier: MIT
// Canonical: robotmoney/devops issue 53 / core issue 1499, core S4 (issue 1486)
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
import {UniswapV4SwapAdapter} from "../adapters/UniswapV4SwapAdapter.sol";
import {TickMath} from "../lib/TickMath.sol";
import {IUniswapV3Pool} from "../interfaces/IUniswapV3Pool.sol";
import {IPoolManagerV4} from "../interfaces/IPoolManagerV4.sol";
import {IUniswapV4PriceRecorder} from "../interfaces/IUniswapV4PriceRecorder.sol";

/// @dev Shared flow: validate sheet inputs, deploy the vault, check each configured pool,
///      add each configured asset, pause, register, write the manifest.
///
///      Roles. The broadcaster is `admin` and also holds EMERGENCY_ROLE on the new vault. The
///      deployer needs ADMIN_ROLE for `addAsset` and `setAdapterCodeHashAllowed`, and
///      EMERGENCY_ROLE for `pauseDeposits()`. The timelock stage hands both roles over and revokes the
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
        /// @dev ORA-4 deposit guard threshold in basis points, 1..MAX_NAV_DEVIATION_BPS. Never 0: 0 disables the guard (issue 1666).
        uint256 navDeviationGuardBps;
        /// @dev Floor for `IUniswapV3Pool.liquidity()` of every configured pool. That is the pool's in-range liquidity L, a raw uint128 of
        ///      sqrt(token0 * token1) units, NOT a USDC amount (issue 1666). Must be above 0. For a Uniswap V4 asset the same unit applies:
        ///      the V4 pool's liquidity L (`StateView.getLiquidity(poolId)`), read here through the recorder facade (issue 1676).
        uint256 minPoolLiquidity;
        /// @dev `RECORDER_ADDRESS`: the deployed `UniswapV4PriceRecorder`. Required (non zero) when the config lists a UniswapV4 asset, otherwise
        ///      ignored. Read from the environment with a zero default because V3-only vaults have no recorder (issue 1676).
        address recorder;
    }

    /// @notice Hard ceiling the vault setter enforces (BasketVault.MAX_NAV_DEVIATION_BPS, 20%). Mirrored here so a sheet typo fails
    ///         before any deploy transaction. A percent typed as bps (5 meaning 5 percent) is in range but sets a 5 bps guard, which
    ///         fails closed (deposits revert on small drift), never open. A value above 2000 or 0 is refused.
    uint256 internal constant MAX_NAV_DEVIATION_BPS = 2_000;

    /// @notice One configured basket row, read from a config file.
    struct AssetCfg {
        string symbol;
        address token;
        /// @dev The V3 pool address. Zero for a V4 asset: the vault registers the price recorder as the pool.
        address pool;
        uint24 poolFee;
        bool isV4;
        /// @dev V4 only: the PoolManager, the pool id and the full PoolKey from the config. `key` hashes to `poolId` (checked at parse).
        address poolManager;
        bytes32 poolId;
        IPoolManagerV4.PoolKey key;
    }

    /// @notice A parsed config file.
    struct Cfg {
        address swapRouter02;
        AssetCfg[] assets;
        /// @dev Optional root `maxSlippageBps`. Zero keeps the vault default. Applied through the vault setter before the handover.
        uint256 maxSlippageBps;
    }

    /// @notice Result returned to in-process callers (forge tests, stage driver).
    struct Deployed {
        address vault;
        address registry;
        address adapter;
        /// @dev The V4 swap adapter, zero when the config lists no V4 asset (issue 1676).
        address adapterV4;
        /// @dev The price recorder the V4 asset is registered with, zero when the config lists no V4 asset.
        address recorder;
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
        p.navDeviationGuardBps = _envUintRequired(string.concat(prefix, "NAV_DEVIATION_BPS"));
        p.minPoolLiquidity = _envUintRequired(string.concat(prefix, "MIN_POOL_LIQUIDITY"));
        p.recorder = vm.envOr(string.concat(prefix, "RECORDER_ADDRESS"), address(0));
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
        uint256[] memory eligibilityBps = _readEligibilityBps(prefix);
        Cfg memory cfg = _parseCfg(vm.readFile(configFile), arrayKey);

        vm.startBroadcast();
        d = _deployAll(p, cfg);
        // Deploy-time router configuration (issue 1520): eligibility and the default weights are set here, by the deployer, before the
        // timelock handover. The only mainnet operation after the handover is the basket unpause.
        _makeRouterEligible(VaultRegistry(p.registry), d.vault, eligibilityBps);
        vm.stopBroadcast();

        _writeManifest(d, cfg);
    }

    /// @dev `ROUTER_DEFAULT_BPS` is required: the word `none` leaves this basket ineligible, otherwise a comma list of bps for the
    ///      router default vector right after this basket flips eligible (rmUSDC, the already eligible baskets in registry order, this vault).
    function _readEligibilityBps(string memory prefix)
        internal
        view
        returns (uint256[] memory bps)
    {
        string memory key = string.concat(prefix, "ROUTER_DEFAULT_BPS");
        string memory raw = _envStringRequired(key);
        if (keccak256(bytes(raw)) == keccak256("none")) return new uint256[](0);
        try vm.envUint(key, ",") returns (uint256[] memory v) {
            return v;
        } catch {
            revert(
                string.concat(
                    key, " is malformed: expected none or a comma list of unsigned integers"
                )
            );
        }
    }

    /// @dev One atomic `registry.migrateEligibility`: flips `vault` eligible and re-sets the router default vector in the same call. The
    ///      vector is the current eligible set in registry order, then `vault`, with the given bps. The broadcaster holds ADMIN_ROLE on the
    ///      registry until the timelock stage. An empty `bps` leaves the vault ineligible.
    function _makeRouterEligible(VaultRegistry registry, address vault, uint256[] memory bps)
        internal
    {
        if (bps.length == 0) return;
        address[] memory listed = registry.listVaults();
        uint256 count;
        for (uint256 i = 0; i < listed.length; i++) {
            if (registry.isRouterEligible(listed[i])) count++;
        }
        require(
            bps.length == count + 1,
            "ROUTER_DEFAULT_BPS length differs from the eligible set plus this vault"
        );
        address[] memory vaults = new address[](count + 1);
        uint256 k;
        for (uint256 i = 0; i < listed.length; i++) {
            if (registry.isRouterEligible(listed[i])) vaults[k++] = listed[i];
        }
        vaults[k] = vault;
        registry.migrateEligibility(vault, true, vaults, bps);
        require(
            registry.isRouterEligible(vault),
            "vault is not router-eligible after migrateEligibility"
        );
    }

    // ─── Config parsing ───────────────────────────────────────────────────────

    /// @dev Hook: the venue an asset must use, or "" for either. The agent script pins RM to UniswapV4.
    function _requiredVenue(address) internal pure virtual returns (string memory) {
        return "";
    }

    /// @dev Parse a config file body. `arrayKey` is "assets" or "shortlist".
    function _parseCfg(string memory json, string memory arrayKey)
        internal
        view
        returns (Cfg memory cfg)
    {
        cfg.swapRouter02 = json.readAddress(".swapRouter02");
        if (vm.keyExistsJson(json, ".maxSlippageBps")) {
            cfg.maxSlippageBps = json.readUint(".maxSlippageBps");
        }
        string memory root = string.concat(".", arrayKey);
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(root, "[", vm.toString(n), "]"))) n++;
        string[] memory symbols = new string[](n);
        for (uint256 i = 0; i < n; i++) {
            symbols[i] = json.readString(string.concat(root, "[", vm.toString(i), "].symbol"));
        }
        cfg.assets = new AssetCfg[](symbols.length);
        for (uint256 i = 0; i < symbols.length; i++) {
            cfg.assets[i] =
                _parseAsset(json, string.concat(root, "[", vm.toString(i), "]"), symbols[i]);
        }
    }

    function _parseAsset(string memory json, string memory base, string memory symbol)
        private
        view
        returns (AssetCfg memory a)
    {
        a.symbol = symbol;
        a.token = json.readAddress(string.concat(base, ".token"));
        a.poolFee = uint24(json.readUint(string.concat(base, ".poolFee")));
        bytes32 venue = keccak256(bytes(json.readString(string.concat(base, ".venue"))));
        require(a.token != address(0), "config token unset");
        require(a.poolFee != 0, "config poolFee unset");
        string memory required = _requiredVenue(a.token);
        if (bytes(required).length != 0) {
            require(
                venue == keccak256(bytes(required)),
                string.concat(symbol, ": venue must be ", required)
            );
        }
        if (venue == keccak256("UniswapV3")) {
            a.pool = json.readAddress(string.concat(base, ".pool"));
            require(a.pool != address(0), "config pool unset");
        } else if (venue == keccak256("UniswapV4")) {
            _parseV4(json, base, a);
        } else {
            revert("unsupported venue: only UniswapV3 and UniswapV4");
        }
    }

    /// @dev The V4 entry carries the PoolManager, the pool id and the full PoolKey. The key must hash to the id, be hookless and sorted,
    ///      and its fee must equal `poolFee`. The pool tickSpacing is read from the key, never derived from the fee.
    function _parseV4(string memory json, string memory base, AssetCfg memory a) private view {
        a.isV4 = true;
        a.poolManager = json.readAddress(string.concat(base, ".poolManager"));
        a.poolId = json.readBytes32(string.concat(base, ".poolId"));
        string memory k = string.concat(base, ".poolKey");
        a.key = IPoolManagerV4.PoolKey({
            currency0: json.readAddress(string.concat(k, ".currency0")),
            currency1: json.readAddress(string.concat(k, ".currency1")),
            fee: uint24(json.readUint(string.concat(k, ".fee"))),
            tickSpacing: int24(json.readInt(string.concat(k, ".tickSpacing"))),
            hooks: json.readAddress(string.concat(k, ".hooks"))
        });
        require(a.poolManager != address(0), "config poolManager unset");
        require(a.key.hooks == address(0), "config poolKey hooks must be zero");
        require(a.key.currency0 < a.key.currency1, "config poolKey currencies are not sorted");
        require(
            a.key.currency0 == a.token || a.key.currency1 == a.token,
            "config poolKey does not hold the token"
        );
        require(a.key.fee == a.poolFee, "config poolKey fee does not equal poolFee");
        require(a.key.tickSpacing > 0, "config poolKey tickSpacing unset");
        require(keccak256(abi.encode(a.key)) == a.poolId, "config poolKey does not hash to poolId");
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
        require(p.feeRecipient != msg.sender, "FEE_RECIPIENT=deployer");
        require(p.feeRecipient != p.admin, "FEE_RECIPIENT=admin");
        require(p.tvlCap != 0, "TVL_CAP missing from the sheet");
        require(p.perDepositCap != 0, "PER_DEPOSIT_CAP missing from the sheet");
        require(p.perDepositCap <= p.tvlCap, "PER_DEPOSIT_CAP exceeds TVL_CAP");
        require(
            p.navDeviationGuardBps != 0 && p.navDeviationGuardBps <= MAX_NAV_DEVIATION_BPS,
            "NAV_DEVIATION_BPS must be 1..2000"
        );
        require(p.minPoolLiquidity != 0, "MIN_POOL_LIQUIDITY missing from the sheet");
        require(p.minPoolLiquidity <= type(uint128).max, "MIN_POOL_LIQUIDITY exceeds uint128");
        require(cfg.swapRouter02 != address(0), "config swapRouter02 unset");
        require(p.swapRouter == cfg.swapRouter02, "SWAP_ROUTER is not SwapRouter02");

        BasketVault vault = _newVault(p, p.admin);
        d.vault = address(vault);
        d.registry = p.registry;
        d.tokens = new address[](cfg.assets.length);

        _addAssets(vault, p, cfg, d);

        // Issue 1666: the ORA-4 deposit guard is nonzero before the timelock handover, on every chain. The vault default is 0, which
        // disables the check. The vault is always new here (no adopt path), so the setter always runs. Read back to fail on a no-op.
        vault.setNavDeviationGuardBps(p.navDeviationGuardBps);
        require(
            vault.navDeviationGuardBps() == p.navDeviationGuardBps,
            "navDeviationGuardBps readback differs from the sheet"
        );

        // Issue 1676: a config `maxSlippageBps` raises the swap bound before the handover. The V4 RM pool charges 2.91 percent, so the
        // vault default of 300 bps leaves 9 bps for price impact. The vault setter bounds it to 500. Read back to fail on a no-op.
        if (cfg.maxSlippageBps != 0) {
            vault.setMaxSlippageBps(cfg.maxSlippageBps);
            require(
                vault.maxSlippageBps() == cfg.maxSlippageBps,
                "maxSlippageBps readback differs from config"
            );
        }

        // Deployed paused. The govern stage unpauses after the checks pass.
        vault.pauseDeposits();
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
        address adapter = address(0);
        for (uint256 i = 0; i < cfg.assets.length; i++) {
            AssetCfg memory a = cfg.assets[i];
            if (a.isV4) {
                _addV4Asset(vault, p, a, d);
            } else {
                // The V3 adapter is deployed with the first V3 asset (a vault whose assets are all V4 deploys none).
                if (_usesAdapter() && adapter == address(0)) {
                    adapter = address(new UniswapV3SwapAdapter(p.swapRouter));
                    vault.setAdapterCodeHashAllowed(adapter.codehash, true);
                    d.adapter = adapter;
                }
                _checkPool(a, p.minPoolLiquidity);
                vault.addAsset(a.token, a.pool, a.poolFee, adapter, BasketVault.Venue.V3);
            }
            d.tokens[i] = a.token;
        }
    }

    /// @dev Uniswap V4 asset (issue 1676, owner decision 2026-10-08). The vault registers the price RECORDER as the asset's pool and the
    ///      `UniswapV4SwapAdapter` as its adapter, venue V4, swap fee = the pool fee. Checks, in order: the recorder is the one for this exact
    ///      PoolKey and PoolManager, the pool holds at least the sheet liquidity floor (read from the PoolManager with the config pool id,
    ///      independent of the recorder), then the adapter is deployed, its codehash allowed and the asset added. `addAsset` itself enforces
    ///      the recorder's ring (901 slots) and 1800 s of history. One V4 asset per run: one recorder.
    function _addV4Asset(BasketVault vault, Params memory p, AssetCfg memory a, Deployed memory d)
        internal
    {
        require(d.recorder == address(0), "only one UniswapV4 asset per run");
        require(p.recorder != address(0), "RECORDER_ADDRESS is required for a UniswapV4 asset");
        require(p.recorder.code.length != 0, "RECORDER_ADDRESS has no code");
        _checkRecorder(a, IUniswapV4PriceRecorder(p.recorder));
        _checkPoolV4(a, p.minPoolLiquidity);
        // Poke so the recorder is fresh for addAsset's observe([1800, 0]). Permissionless and a no-op in the same block.
        IUniswapV4PriceRecorder(p.recorder).record();

        address adapterV4 =
            address(new UniswapV4SwapAdapter(a.poolManager, a.key, p.recorder, p.usdc));
        vault.setAdapterCodeHashAllowed(adapterV4.codehash, true);
        vault.addAsset(a.token, p.recorder, a.poolFee, adapterV4, BasketVault.Venue.V4);
        d.adapterV4 = adapterV4;
        d.recorder = p.recorder;
    }

    /// @dev The recorder is bound to the config PoolKey: PoolManager, pool id (the hash of the key) and every key field.
    function _checkRecorder(AssetCfg memory a, IUniswapV4PriceRecorder rec) internal view {
        require(
            address(rec.POOL_MANAGER()) == a.poolManager,
            string.concat(a.symbol, ": recorder PoolManager differs from config")
        );
        require(
            rec.POOL_ID() == a.poolId,
            string.concat(a.symbol, ": recorder pool id differs from config")
        );
        require(
            rec.token0() == a.key.currency0 && rec.token1() == a.key.currency1
                && rec.fee() == a.key.fee && rec.tickSpacing() == a.key.tickSpacing
                && rec.hooks() == a.key.hooks,
            string.concat(a.symbol, ": recorder PoolKey differs from config")
        );
    }

    /// @dev V4 liquidity floor. The unit is the pool's in-range liquidity L (`Pool.State.liquidity`, a uint128 of
    ///      sqrt(token0 * token1) units), the same unit `StateView.getLiquidity(poolId)` returns and the same unit as the V3 floor.
    ///      Read with `extsload` at `keccak256(abi.encode(poolId, 6)) + 3` (PoolManager `_pools` slot 6, `liquidity` field offset 3).
    function _checkPoolV4(AssetCfg memory a, uint256 minPoolLiquidity) internal view {
        require(
            a.poolManager.code.length != 0, string.concat(a.symbol, ": PoolManager has no code")
        );
        bytes32 stateSlot = keccak256(abi.encode(a.poolId, uint256(6)));
        uint256 slot0 = uint256(IPoolManagerV4(a.poolManager).extsload(stateSlot));
        require(uint160(slot0) != 0, string.concat(a.symbol, ": V4 pool is not initialized"));
        uint128 liquidity = uint128(
            uint256(IPoolManagerV4(a.poolManager).extsload(bytes32(uint256(stateSlot) + 3)))
        );
        require(
            liquidity >= minPoolLiquidity,
            string.concat(a.symbol, ": pool liquidity is below MIN_POOL_LIQUIDITY")
        );
    }

    /// @dev Config check on chain: pool code present, live fee equals config and in-range liquidity
    ///      (`IUniswapV3Pool.liquidity()`, a uint128 L, not a USDC amount) is at least the sheet floor.
    ///      The cardinality floor and the vault's dust `MIN_POOL_LIQUIDITY` are enforced by `addAsset` itself.
    function _checkPool(AssetCfg memory a, uint256 minPoolLiquidity) internal view {
        require(a.pool.code.length != 0, string.concat(a.symbol, ": pool has no code"));
        require(
            IUniswapV3Pool(a.pool).fee() == a.poolFee,
            string.concat(a.symbol, ": pool fee does not equal config")
        );
        require(
            IUniswapV3Pool(a.pool).liquidity() >= minPoolLiquidity,
            string.concat(a.symbol, ": pool liquidity is below MIN_POOL_LIQUIDITY")
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
            AssetCfg memory a = cfg.assets[i];
            string memory item = string.concat(
                '{"symbol":"',
                a.symbol,
                '","token":"',
                vm.toString(a.token),
                '","pool":"',
                vm.toString(a.isV4 ? d.recorder : a.pool),
                '","pool_fee":',
                vm.toString(uint256(a.poolFee)),
                ',"venue":"',
                a.isV4 ? "UniswapV4" : "UniswapV3",
                '","pool_id":"',
                vm.toString(a.poolId),
                '"}'
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
            '","adapter_v4":"',
            vm.toString(d.adapterV4),
            '","recorder":"',
            vm.toString(d.recorder),
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
