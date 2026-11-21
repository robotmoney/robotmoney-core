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
///         is exactly how the retired RwaBasketVault predecessor (24834) and AgentTokenVault (25241) became
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

    // ─── Adapter set ───────────────────────────────────────────────────────
    //
    // Every adapter below is a direct on-chain deployment (lending adapters and
    // the swap venue seams), so each must independently fit EIP-170 or it is
    // undeployable on Base mainnet (issue #865). It runs in the required
    // `forge-unit-tests` job (suite-01-02-forge-tests.yml) with a non-zero
    // executed count.

    function test_AaveV3Adapter_underEip170() public {
        _assertUnderLimit("AaveV3Adapter.sol:AaveV3Adapter");
    }

    function test_CompoundV3Adapter_underEip170() public {
        _assertUnderLimit("CompoundV3Adapter.sol:CompoundV3Adapter");
    }

    function test_MorphoAdapter_underEip170() public {
        _assertUnderLimit("MorphoAdapter.sol:MorphoAdapter");
    }

    function test_UniswapV3SwapAdapter_underEip170() public {
        _assertUnderLimit("UniswapV3SwapAdapter.sol:UniswapV3SwapAdapter");
    }

    function test_AerodromeSwapAdapter_underEip170() public {
        _assertUnderLimit("AerodromeSwapAdapter.sol:AerodromeSwapAdapter");
    }

    // ─── ADR-0014: proxied implementations, the exclusion ledger, the linked libraries ──
    //
    // Every proxied implementation is a direct on-chain deployment (behind its ERC1967Proxy), and so
    // is each CREATE2-linked library, the exclusion ledger and the timelock, so each must fit EIP-170
    // on its own. The ledger is created by the vault, one per exclusion record (core 1820).

    function test_ConsensusRecommendationReceipt_underEip170() public {
        _assertUnderLimit("ConsensusRecommendationReceipt.sol:ConsensusRecommendationReceipt");
    }

    function test_ExclusionLedger_underEip170() public {
        _assertUnderLimit("ExclusionLedger.sol:ExclusionLedger");
    }

    function test_ProposerFloorTimelock_underEip170() public {
        _assertUnderLimit("ProposerFloorTimelock.sol:ProposerFloorTimelock");
    }

    function test_linkedLibraries_underEip170() public {
        _assertUnderLimit("BasketAssetConfigGuard.sol:BasketAssetConfigGuard");
    }
}
