// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.5 (asset admission), §5.6 (parameters), §5.9.5 (flow
//            defaults); contracts/test/prototype/PrototypeHarness.sol (the wiring every fund stage reproduces).
// Deploy 4 (owner exception 2026-11-12): the one-vault prototype through the real deploy tool, as a rehearsal.
pragma solidity ^0.8.24;

import {stdJson} from "forge-std/StdJson.sol";

import {UpgradeAuthority} from "./UpgradeAuthority.sol";

/// @title FundSystemBase
/// @notice What every stage of the `fund` system shares (scripts/deploy/stage-table.json, system `fund`): the real Base
///         addresses the one-vault prototype is wired to, the env readers and the manifest helpers. The addresses are
///         exactly the harness's (`PrototypeHarness.sol`), so the stages deploy the system the prototype suites test.
///
///         The fund system is independent of the vaults system: its own Safe, receipt register, proxies and timelock
///         (the same `ProposerFloorTimelock` CREATE2 scheme, `UpgradeAuthority`, predicted from its own Safe). It reads
///         no vaults-system manifest.
abstract contract FundSystemBase is UpgradeAuthority {
    using stdJson for string;

    // ─── Real Base addresses (PrototypeHarness.sol; third-party-addresses.json for the venues) ─────────

    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    /// @dev Uniswap V3 USDC pools, fee 500 (the harness's WETH_POOL and CBBTC_POOL).
    address internal constant WETH_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    address internal constant CBBTC_POOL = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef;
    address internal constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant AAVE_A_USDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    address internal constant COMET = 0xb125E6687d4313864e53df431d5425969c15Eb2F;
    address internal constant MOONWELL = 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca;
    uint24 internal constant POOL_FEE = 500;

    /// @dev Chainlink on Base (the harness's feeds; each answered `description()` at the fixture pin).
    address internal constant FEED_ETH = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    address internal constant FEED_CBBTC = 0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D;
    address internal constant FEED_USDC = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B;
    address internal constant FEED_SEQUENCER = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433;
    /// @dev `maxFeedAge` = heartbeat + 5 minutes (§5.9.5): ETH / USD 20 min, cbBTC / USD and USDC / USD 24 h.
    uint32 internal constant ETH_FEED_MAX_AGE = 1_500;
    uint32 internal constant DAY_FEED_MAX_AGE = 86_700;
    /// @dev The basket assets' TWAP window (the harness's TWAP_WINDOW).
    uint32 internal constant TWAP_WINDOW = 1_800;

    // ─── Asset indices (stable for the fund's life, §4.1). Compound is last, as in the harness ─────────

    uint256 internal constant IDX_AAVE = 0;
    uint256 internal constant IDX_MOONWELL = 1;
    uint256 internal constant IDX_WETH = 2;
    uint256 internal constant IDX_CBBTC = 3;
    uint256 internal constant IDX_COMET = 4;
    uint256 internal constant N_ASSETS = 5;

    // ─── Env readers ────────────────────────────────────────────────────────────────────────────────

    /// @dev A required non-zero address.
    function _envNonZeroAddress(string memory key) internal view returns (address a) {
        a = _envAddressRequired(key);
        require(a != address(0), string.concat(key, "=0"));
    }

    /// @dev A required unsigned integer at most `max`.
    function _envUintMax(string memory key, uint256 max) internal view returns (uint256 v) {
        v = _envUintRequired(key);
        require(v <= max, string.concat(key, " is out of range"));
    }

    /// @dev A required address that holds code on this chain (an earlier stage's contract).
    function _envContract(string memory key) internal view returns (address a) {
        a = _envNonZeroAddress(key);
        require(a.code.length > 0, string.concat(key, " has no code on this chain"));
    }
}
