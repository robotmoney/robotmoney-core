// SPDX-License-Identifier: MIT
// Canonical: Plan tracking issue #109 §11 — four-vault catalog.
// Implements: issue #865
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// @title VaultCodeSizeGuard
/// @notice Asserts every deployable vault's runtime bytecode stays under the
///         EIP-170 24576-byte limit.
///
///         Why this exists: Foundry's test/script EVM raises the contract-size
///         limit, so an oversize vault passes every unit/invariant/fork test and
///         even the deploy *simulation*, yet reverts when actually broadcast to a
///         real EIP-170 chain (Base mainnet, or the Geth smoke-test devnet). That
///         is exactly how RwaVault (24834) and AgentTokenVault (25241) became
///         undeployable without any test catching it (issue #865). This guard
///         reads the compiled artifact size directly so the limit is enforced
///         regardless of the test EVM's relaxed limit.
contract VaultCodeSizeGuard is Test {
    /// @dev EIP-170 maximum contract runtime bytecode size, in bytes.
    uint256 internal constant EIP170_LIMIT = 24576;

    function _assertUnderLimit(string memory artifact) internal {
        uint256 size = vm.getDeployedCode(artifact).length;
        emit log_named_uint(string.concat(artifact, " runtime bytes"), size);
        assertLe(
            size,
            EIP170_LIMIT,
            string.concat(
                artifact, " exceeds the EIP-170 24576-byte limit; it cannot be deployed on-chain"
            )
        );
    }

    function test_RobotMoneyVault_underEip170() public {
        _assertUnderLimit("RobotMoneyVault.sol:RobotMoneyVault");
    }

    function test_ProtocolAssetVault_underEip170() public {
        _assertUnderLimit("ProtocolAssetVault.sol:ProtocolAssetVault");
    }

    function test_RwaVault_underEip170() public {
        _assertUnderLimit("RwaVault.sol:RwaVault");
    }

    function test_AgentTokenVault_underEip170() public {
        _assertUnderLimit("AgentTokenVault.sol:AgentTokenVault");
    }

    // ─── Unified Vault + adapter set (ADR-0010, issue #1127, M-A2) ─────────
    //
    // The unified `Vault` is the single non-abstract ERC-4626 allocator every
    // theme (rmUSDC/rmPROTO/rmAGENT/rmRWA) deploys composed with a set of
    // `IPositionAdapter`s (spec §5). Its natspec promises it "stays a thin
    // allocator well within the EIP-170 runtime-size limit" — that fit MUST be
    // proven per M-A2, not assumed. Every adapter below is a direct on-chain
    // deployment (lending retrofit, asset-position, and the swap/oracle venue
    // seams they compose), so each must independently fit EIP-170 or it is
    // undeployable on Base mainnet exactly like RwaVault/AgentTokenVault were
    // (issue #865). Stacking the phase features (#1120–#1123) onto the core
    // (#1119) pushed the deployed `Vault` bytecode over the limit with no gate
    // watching; this guard is that gate. It runs in the required `forge-unit-tests`
    // job (suite-01-02-forge-tests.yml) with a non-zero executed count.

    function test_UnifiedVault_underEip170() public {
        _assertUnderLimit("Vault.sol:Vault");
    }

    function test_AaveV3Adapter_underEip170() public {
        _assertUnderLimit("AaveV3Adapter.sol:AaveV3Adapter");
    }

    function test_CompoundV3Adapter_underEip170() public {
        _assertUnderLimit("CompoundV3Adapter.sol:CompoundV3Adapter");
    }

    function test_MorphoAdapter_underEip170() public {
        _assertUnderLimit("MorphoAdapter.sol:MorphoAdapter");
    }

    function test_UniswapV3AssetPositionAdapter_underEip170() public {
        _assertUnderLimit("UniswapV3AssetPositionAdapter.sol:UniswapV3AssetPositionAdapter");
    }

    function test_UniswapV4AssetPositionAdapter_underEip170() public {
        _assertUnderLimit("UniswapV4AssetPositionAdapter.sol:UniswapV4AssetPositionAdapter");
    }

    function test_AerodromeAssetPositionAdapter_underEip170() public {
        _assertUnderLimit("AerodromeAssetPositionAdapter.sol:AerodromeAssetPositionAdapter");
    }

    function test_DeSpxaAssetPositionAdapter_underEip170() public {
        _assertUnderLimit("DeSpxaAssetPositionAdapter.sol:DeSpxaAssetPositionAdapter");
    }

    function test_UniswapV3SwapAdapter_underEip170() public {
        _assertUnderLimit("UniswapV3SwapAdapter.sol:UniswapV3SwapAdapter");
    }

    function test_UniswapV4SwapAdapter_underEip170() public {
        _assertUnderLimit("UniswapV4SwapAdapter.sol:UniswapV4SwapAdapter");
    }

    function test_AerodromeSwapAdapter_underEip170() public {
        _assertUnderLimit("AerodromeSwapAdapter.sol:AerodromeSwapAdapter");
    }

    function test_ChronicleOracleAdapter_underEip170() public {
        _assertUnderLimit("ChronicleOracleAdapter.sol:ChronicleOracleAdapter");
    }
}
