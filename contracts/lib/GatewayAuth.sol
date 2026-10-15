// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §9 (EIP-170 size budget, item 2)
// (See also: contracts/gateway/RobotMoneyGateway.sol — the caller; issue #1791 / review CS-1, CS-2
//  (agent consent); docs/architecture.md §5 — commit/reveal authorization)
pragma solidity ^0.8.24;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";

/// @title GatewayAuth
/// @notice The commit/reveal and agent-consent checks of `RobotMoneyGateway.revealAuthorization`.
///         A CREATE2-linked library: `public` functions run as the gateway through `DELEGATECALL`,
///         so `address(this)` is the gateway proxy, `msg.sender` is the revealer, the storage
///         references are the gateway's own, and `CommitRevealed` is emitted from the gateway.
/// @dev Why it exists (ADR-0014 §9): it keeps the gateway under EIP-170 with the 1,024-byte margin
///      the ADR requires. The gateway keeps the EIP-712 domain (its name constant and
///      `implementationVersion()`, ADR-0014 §10) and passes the separator in, so an implementation
///      that changes what a consent means bumps the version in the gateway itself. Errors mirror the
///      gateway's (same selectors).
library GatewayAuth {
    /// @notice EIP-712 type of the agent's consent to a binding (issue #1791). Signed by the agent;
    ///         `owner` is the revealer, `nonce` is `agentConsentNonce(agent)`. The gateway's public
    ///         `AGENT_CONSENT_TYPEHASH` reads this constant.
    bytes32 internal constant AGENT_CONSENT_TYPEHASH =
        keccak256("AgentConsent(address agent,address owner,address shareReceiver,uint256 nonce)");

    /// @dev secp256k1 order / 2. A signature with `s` above it is the malleable twin of a low-s one
    ///      and is refused (EIP-2).
    uint256 private constant _SECP256K1_HALF_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// @notice A pending authorization commitment.
    /// @param committer   Account that submitted the commitment.
    /// @param blockNumber Block in which it was submitted.
    struct Commitment {
        address committer;
        uint64 blockNumber;
    }

    error CommitmentNotFound();
    error CommitmentOwnerMismatch();
    error CommitmentTooRecent();
    error CommitmentExpired();
    error InvalidAgentConsent();

    /// @notice Storage key of `committer`'s commitment to `commitHash`. Caller scoping prevents
    ///         another account from overwriting a commitment observed in the mempool or on chain.
    function commitmentKey(bytes32 commitHash, address committer) internal pure returns (bytes32) {
        return keccak256(abi.encode(commitHash, committer));
    }

    /// @notice Steps 1–5 of `revealAuthorization`: the revealer's commitment to
    ///         `keccak256(abi.encode(agent, msg.sender, salt))` exists, is the revealer's own, is at
    ///         least one block old and at most `expiryBlocks` old. Deletes it (CEI) and emits
    ///         `CommitRevealed`.
    function consumeCommitment(
        mapping(bytes32 => Commitment) storage commitments,
        address agent,
        bytes32 salt,
        uint256 expiryBlocks
    ) public {
        bytes32 commitHash = keccak256(abi.encode(agent, msg.sender, salt));
        bytes32 storageKey = commitmentKey(commitHash, msg.sender);
        Commitment memory c = commitments[storageKey];

        // 1. Commitment must exist.
        if (c.committer == address(0)) revert CommitmentNotFound();

        // 2. Revealer must be the original committer. Defense-in-depth only: the hash binds
        //    `msg.sender`, so another caller finds no commitment and reverts at step 1.
        // coverage:unreachable
        if (c.committer != msg.sender) revert CommitmentOwnerMismatch();

        // 3. Must wait at least one block (front-running protection).
        if (block.number <= uint256(c.blockNumber)) revert CommitmentTooRecent();

        // 4. Commitment must not be expired.
        if (block.number > uint256(c.blockNumber) + expiryBlocks) revert CommitmentExpired();

        // 5. Clear the commitment before the authorization logic (CEI).
        delete commitments[storageKey];

        emit IGateway.CommitRevealed(msg.sender, commitHash, agent);
    }

    /// @notice Require `consent` to be `agent`'s EIP-712 `AgentConsent` signature for this revealer
    ///         (`msg.sender`) and `shareReceiver` at the agent's current nonce, then advance the
    ///         nonce so the signature authorizes once (issue #1791). Layout `r ‖ s ‖ v` (65 bytes).
    ///         A high-s signature is refused (EIP-2), so a consent has one valid encoding. `agent` is
    ///         non-zero here, so a failed recovery (zero signer) never matches. A contract agent (no
    ///         ECDSA key) consents by revealing for itself instead. Hand-rolled rather than OZ
    ///         `ECDSA.tryRecover` and `EIP712` to add no storage.
    /// @param domainSeparator The gateway's EIP-712 domain separator (name, version, chain, proxy).
    function requireAgentConsent(
        mapping(address => uint256) storage consentNonce,
        bytes32 domainSeparator,
        address agent,
        address shareReceiver,
        bytes calldata consent
    ) public {
        if (consent.length != 65) revert InvalidAgentConsent();
        uint256 nonce = consentNonce[agent];
        bytes32 structHash =
            keccak256(abi.encode(AGENT_CONSENT_TYPEHASH, agent, msg.sender, shareReceiver, nonce));
        bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
        bytes32 r;
        bytes32 s;
        uint8 v;
        // The length is exactly 65, so the three loads stay inside `consent`.
        assembly ("memory-safe") {
            r := calldataload(consent.offset)
            s := calldataload(add(consent.offset, 0x20))
            v := byte(0, calldataload(add(consent.offset, 0x40)))
        }
        if (uint256(s) > _SECP256K1_HALF_ORDER || ecrecover(digest, v, r, s) != agent) {
            revert InvalidAgentConsent();
        }
        consentNonce[agent] = nonce + 1;
    }
}
