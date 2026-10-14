// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §5.2 — agent consent on authorize (issue #1791)
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

/// @dev The one gateway read the helper needs: the agent's current consent nonce.
interface IAgentConsentNonce {
    function agentConsentNonce(address agent) external view returns (uint256);
}

/// @title AgentConsent
/// @notice Test helper for the agent consent that `revealAuthorization` takes
///         from a caller without `ADMIN_ROLE` that names an agent other than
///         itself (issue #1791). The EIP-712 digest is rebuilt here from the
///         spec, not read from the gateway, so a test that passes proves the
///         contract hashes the same typed data a wallet would sign.
library AgentConsent {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 internal constant TYPEHASH =
        keccak256("AgentConsent(address agent,address owner,address shareReceiver,uint256 nonce)");
    bytes32 internal constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    /// @notice EIP-712 digest of `AgentConsent(agent, owner, shareReceiver, nonce)`
    ///         in the domain (`RobotMoneyGateway`, `1`, `chainId`, `gateway`).
    function digest(
        address gateway,
        uint256 chainId,
        address agent,
        address owner,
        address shareReceiver,
        uint256 nonce
    ) internal pure returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("RobotMoneyGateway")),
                keccak256(bytes("1")),
                chainId,
                gateway
            )
        );
        bytes32 structHash = keccak256(abi.encode(TYPEHASH, agent, owner, shareReceiver, nonce));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    /// @notice `r ‖ s ‖ v` signature by `agentKey` over an explicit digest.
    function signDigest(uint256 agentKey, bytes32 d) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(agentKey, d);
        return abi.encodePacked(r, s, v);
    }

    /// @notice The agent's consent for `owner` (the revealer) and `shareReceiver`
    ///         at the gateway's current nonce for that agent, on this chain.
    function sign(uint256 agentKey, address gateway, address owner, address shareReceiver)
        internal
        view
        returns (bytes memory)
    {
        address agent = VM.addr(agentKey);
        uint256 nonce = IAgentConsentNonce(gateway).agentConsentNonce(agent);
        return
            signDigest(agentKey, digest(gateway, block.chainid, agent, owner, shareReceiver, nonce));
    }

    /// @notice Private key behind forge-std `makeAddr(name)`, which derives the
    ///         address from `uint256(keccak256(abi.encodePacked(name)))`.
    function keyOf(string memory name) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(name)));
    }
}
