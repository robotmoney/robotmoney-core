// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0005-basketvault-multi-dex-routing.md (2026-10-08 amendment: V4 venue and price recorder)
//            docs/adr/ADR-0001-mvp-agent-token-shortlist.md (2026-10-08: RM on the V4 RM/USDC 2.91% pool)
//            docs/operations/contract-release-runbooks.md (stage `recorder`)
pragma solidity ^0.8.24;

import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {ExpectedChainGuard} from "./ExpectedChainGuard.sol";
import {UniswapV4PriceRecorder} from "../adapters/UniswapV4PriceRecorder.sol";
import {IPoolManagerV4} from "../interfaces/IPoolManagerV4.sol";

/// @title DeployUniswapV4PriceRecorder
/// @notice Stage `recorder`: deploys the permissionless `UniswapV4PriceRecorder` for the Uniswap V4 pool named by the
///         rmAGENT config (`config/agent-token-shortlist.json`, the entry with venue UniswapV4), grows its observation
///         ring to the 901-slot floor (1800 s window / 2 s Base block + 1) and records the first snapshot.
///
///         It runs EARLY (right after `libs`) so the 30 minute price history accumulates while the other stages run.
///         The runner then waits until the recorder holds a full window of history before it lets the `agent` stage run
///         (`addAsset` reverts `InsufficientObservationHistory` otherwise).
///
///         No role is involved: the recorder has no owner, and every call here is one anyone could make. The deployer
///         holds nothing on it afterwards. The ring grows in chunks of `GROW_CHUNK` slots, one transaction each, so no
///         transaction nears a block gas limit (about 22,000 gas per slot).
///
///         Required env vars: DEPLOYMENT_OUT (manifest path). Optional: EXPECTED_CHAIN_ID (mandatory and 8453 on Base mainnet).
contract DeployUniswapV4PriceRecorder is ExpectedChainGuard {
    using stdJson for string;

    string public constant MANIFEST_FILE = "recorder.json";
    string public constant CONFIG_FILE = "config/agent-token-shortlist.json";
    /// @notice Ring floor for the 1800 s window: window / 2 s + 1 (BasketAssetConfigGuard.requireObservationHistory).
    uint16 public constant RING_SLOTS = 901;
    /// @notice Slots grown per transaction.
    uint16 public constant GROW_CHUNK = 250;
    /// @notice Fixed gas for the first `record()` transaction. forge estimates a call from a simulation that runs in the SAME block as the
    ///         constructor, where `record()` returns early (about 38,000 gas). On a real chain the call lands in a later block and writes a
    ///         snapshot (about 70,000 gas), so the estimate would run out of gas. A fixed limit avoids the mismatch.
    uint256 public constant RECORD_GAS = 300_000;

    struct Deployed {
        address recorder;
        address poolManager;
        bytes32 poolId;
        uint16 cardinalityNext;
    }

    /// @notice Forge broadcast entrypoint.
    function run() external returns (Deployed memory d) {
        _requireExpectedChain("");
        string memory json = vm.readFile(CONFIG_FILE);
        (address poolManager, IPoolManagerV4.PoolKey memory key, bytes32 poolId) =
            _readV4Entry(json);
        vm.startBroadcast();
        d = _deploy(poolManager, key, poolId);
        vm.stopBroadcast();
        _writeManifest(d);
    }

    /// @notice In-process variant for forge tests. No broadcast, no manifest.
    function runInProcess(string memory json) external returns (Deployed memory d) {
        (address poolManager, IPoolManagerV4.PoolKey memory key, bytes32 poolId) =
            _readV4Entry(json);
        d = _deploy(poolManager, key, poolId);
    }

    /// @dev The one UniswapV4 entry of the config. Fails closed on none or on a key that does not hash to its id.
    function _readV4Entry(string memory json)
        internal
        view
        returns (address poolManager, IPoolManagerV4.PoolKey memory key, bytes32 poolId)
    {
        uint256 found = type(uint256).max;
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".shortlist[", vm.toString(n), "]"))) {
            string memory venue =
                json.readString(string.concat(".shortlist[", vm.toString(n), "].venue"));
            if (keccak256(bytes(venue)) == keccak256("UniswapV4")) {
                require(
                    found == type(uint256).max,
                    "more than one UniswapV4 asset: one recorder per run"
                );
                found = n;
            }
            n++;
        }
        require(found != type(uint256).max, "no UniswapV4 asset in the config: nothing to record");
        string memory base = string.concat(".shortlist[", vm.toString(found), "]");
        poolManager = json.readAddress(string.concat(base, ".poolManager"));
        poolId = json.readBytes32(string.concat(base, ".poolId"));
        string memory k = string.concat(base, ".poolKey");
        key = IPoolManagerV4.PoolKey({
            currency0: json.readAddress(string.concat(k, ".currency0")),
            currency1: json.readAddress(string.concat(k, ".currency1")),
            fee: uint24(json.readUint(string.concat(k, ".fee"))),
            tickSpacing: int24(json.readInt(string.concat(k, ".tickSpacing"))),
            hooks: json.readAddress(string.concat(k, ".hooks"))
        });
        require(keccak256(abi.encode(key)) == poolId, "config poolKey does not hash to poolId");
    }

    function _deploy(address poolManager, IPoolManagerV4.PoolKey memory key, bytes32 poolId)
        internal
        returns (Deployed memory d)
    {
        UniswapV4PriceRecorder rec = new UniswapV4PriceRecorder(
            poolManager, key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks
        );
        require(rec.POOL_ID() == poolId, "recorder pool id differs from config");
        for (uint16 next = GROW_CHUNK;; next += GROW_CHUNK) {
            if (next > RING_SLOTS) next = RING_SLOTS;
            rec.grow(next);
            if (next == RING_SLOTS) break;
        }
        // The first record after the ring is raised widens the live ring to RING_SLOTS (V3 ring rule). It writes only in a later block than
        // the constructor's, which a real chain gives and a single simulated block does not: the return value is not asserted. The `agent`
        // stage pokes the recorder again before `addAsset`, so a record that landed in the constructor's block cannot leave the ring narrow.
        rec.record{gas: RECORD_GAS}();
        (,,,, uint16 cardinalityNext) = rec.latest();
        require(cardinalityNext == RING_SLOTS, "recorder ring target is not 901 slots");
        d = Deployed({
            recorder: address(rec),
            poolManager: poolManager,
            poolId: poolId,
            cardinalityNext: cardinalityNext
        });
        console2.log("recorder:", d.recorder);
    }

    function _writeManifest(Deployed memory d) internal {
        _writeManifestTo(d, _envStringRequired("DEPLOYMENT_OUT"));
    }

    function _writeManifestTo(Deployed memory d, string memory outPath) internal {
        string memory obj = "recorder_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "recorder", d.recorder);
        vm.serializeAddress(obj, "pool_manager", d.poolManager);
        vm.serializeBytes32(obj, "pool_id", d.poolId);
        string memory json = vm.serializeUint(obj, "ring_slots", d.cardinalityNext);
        vm.writeJson(json, outPath);
        console2.log("Wrote recorder deployment JSON to", outPath);
    }
}
