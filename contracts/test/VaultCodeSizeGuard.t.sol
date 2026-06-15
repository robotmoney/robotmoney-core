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
            string.concat(artifact, " exceeds the EIP-170 24576-byte limit; it cannot be deployed on-chain")
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
}
