// Canonical: docs/architecture.md §6 — depositor-owned agent authorization (commit/reveal)

/**
 * Commit/reveal helpers for `RobotMoneyGateway.commitAuthorization` +
 * `revealAuthorization`, the permissionless path a depositor uses to
 * authorize its own agent (no ADMIN_ROLE). The hash matches the on-chain
 * computation `keccak256(abi.encode(agent, msg.sender, salt))`.
 *
 * `commitAuthorizationCall` and `revealAuthorizationCall` build the exact
 * `{ functionName, args }` the wallet signs. `buildPreview` encodes the same
 * objects, so the preview and the signing prompt cannot name different
 * functions or arguments (QA plan U4, finding DR-4).
 */
import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from "viem";
import type { AgentPolicy } from "./preview";

export function computeCommitHash(agent: Address, caller: Address, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "bytes32" }],
      [agent, caller, salt],
    ),
  );
}

/** A fresh random 32-byte salt from the browser CSPRNG. */
export function generateSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ("0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
}

/** The inputs of a commit: the gateway hashes `msg.sender` in, so the committer is part of it. */
export interface CommitInputs {
  agent: Address;
  committer: Address;
  salt: Hex;
}

/** The inputs of a reveal. The policy is not part of the commitment; it is chosen here. */
export interface RevealInputs {
  agent: Address;
  salt: Hex;
  policy: AgentPolicy;
}

/** The `commitAuthorization(commitHash)` call the wallet signs for `c`. */
export function commitAuthorizationCall(c: CommitInputs) {
  return {
    functionName: "commitAuthorization",
    args: [computeCommitHash(getAddress(c.agent), getAddress(c.committer), c.salt)],
  } as const;
}

/** The `revealAuthorization(agent, salt, policy)` call the wallet signs for `r`. */
export function revealAuthorizationCall(r: RevealInputs) {
  return {
    functionName: "revealAuthorization",
    args: [getAddress(r.agent), r.salt, policyTuple(r.policy)],
  } as const;
}

/** The ABI tuple for a policy, with the same address normalisation `authorizeAgent` uses. */
export function policyTuple(p: AgentPolicy): AgentPolicy {
  return {
    active: p.active,
    validUntil: p.validUntil,
    maxPerPayment: p.maxPerPayment,
    maxPerWindow: p.maxPerWindow,
    shareReceiver: getAddress(p.shareReceiver),
    allowedDestinations: p.allowedDestinations,
    assetRecipient: p.assetRecipient,
    maxWithdrawPerPayment: p.maxWithdrawPerPayment,
    maxWithdrawPerWindow: p.maxWithdrawPerWindow,
    allowedSourceVaults: p.allowedSourceVaults,
  };
}
