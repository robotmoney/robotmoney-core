// Canonical: docs/architecture.md §5.2 — agent consent comes first, then the owner commit, then the reveal
// Canonical: docs/technical/smart-contract-invariants.md ACL-9

/**
 * Pure helpers for the owner-consented registration sequence (issue 1890).
 *
 * The sequence for a distinct agent key is:
 *   1. the agent commits its consent hash from its own key (`commitAuthorization`);
 *   2. the dapp sees that consent on chain, then the owner wallet commits;
 *   3. the owner reveals one block later, within COMMIT_EXPIRY_BLOCKS of both commitments.
 * A registration where the signing wallet is the agent needs no separate consent.
 *
 * These functions hold no wallet or chain state. The hook `useConsentedRegistration`
 * feeds them reads and the tests feed them fixtures.
 */
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import type { AgentPolicy } from "./preview";

/** Mirrors `RobotMoneyGateway.COMMIT_EXPIRY_BLOCKS`. */
export const COMMIT_EXPIRY_BLOCKS = 256n;

/**
 * The gateway stores a commitment under `keccak256(abi.encode(commitHash, committer))`.
 * The agent's consent commitment is stored under its consent hash and the agent address.
 */
export function commitmentStorageKey(commitHash: Hex, committer: Address): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [commitHash, committer]),
  );
}

/**
 * - `self`: the signing wallet is the agent, so the reveal itself is the consent.
 * - `unknown`: the commitment or the head block has not been read yet.
 * - `missing`: the agent has not committed this consent (or it was consumed).
 * - `live`: the agent's commitment exists and the next block is within its limit.
 * - `expired`: the agent's commitment is older than COMMIT_EXPIRY_BLOCKS at the next block.
 */
export type ConsentStatus = "self" | "unknown" | "missing" | "live" | "expired";

/** `commitments(key)` as the gateway getter returns it: committer and the block it was made in. */
export type CommitmentRead = readonly [Address, bigint] | undefined;

export function consentStatus(input: {
  self: boolean;
  agent: Address;
  commitment: CommitmentRead;
  /** The head block plus one: the earliest block a transaction sent now can land in. */
  nextBlock: bigint | undefined;
}): ConsentStatus {
  if (input.self) return "self";
  if (input.commitment === undefined || input.nextBlock === undefined) return "unknown";
  const [committer, blockNumber] = input.commitment;
  if (committer.toLowerCase() !== input.agent.toLowerCase()) return "missing";
  if (input.nextBlock > blockNumber + COMMIT_EXPIRY_BLOCKS) return "expired";
  return "live";
}

/** Whether a commitment made in `commitBlock` can still be revealed at `nextBlock`. */
export function commitLive(commitBlock: bigint, nextBlock: bigint): boolean {
  return nextBlock <= commitBlock + COMMIT_EXPIRY_BLOCKS;
}

/**
 * What a registration is bound to. Any change to one of these after the inputs were frozen
 * invalidates the freeze: the consent hash, the owner commit and the reveal all commit to them.
 */
export interface RegistrationBinding {
  gateway: Address;
  chainId: number;
  owner: Address;
  agent: Address;
  policy: AgentPolicy;
}

export function bindingKey(b: RegistrationBinding): string {
  const p = b.policy;
  return [
    b.gateway.toLowerCase(),
    b.chainId,
    b.owner.toLowerCase(),
    b.agent.toLowerCase(),
    p.active,
    p.validUntil,
    p.maxPerPayment,
    p.maxPerWindow,
    p.shareReceiver.toLowerCase(),
    p.allowedDestinations.map((a) => a.toLowerCase()).join(","),
    p.assetRecipient.toLowerCase(),
    p.maxWithdrawPerPayment,
    p.maxWithdrawPerWindow,
    p.allowedSourceVaults.map((a) => a.toLowerCase()).join(","),
  ].join("|");
}
