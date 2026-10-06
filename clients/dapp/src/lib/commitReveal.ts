// Canonical: docs/architecture.md §6 — depositor-owned agent authorization (commit/reveal)

/**
 * Commit/reveal helpers for `RobotMoneyGateway.commitAuthorization` +
 * `revealAuthorization`, the permissionless path a depositor uses to
 * authorize its own agent (no ADMIN_ROLE). The hash matches the on-chain
 * computation `keccak256(abi.encode(agent, msg.sender, salt))`.
 */
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

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
