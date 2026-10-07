import { keccak256, toBytes } from "viem";
import { CORE_CONTRACT_REFS, SAFE_MANIFEST } from "../core-wiring.ts";
import { manifestBase, manifestFile, type StageTable, type TableStage } from "../stage-table.ts";
import type { Address, Hex } from "./types.ts";

export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const Z32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
export const role = (name: string): Hex => keccak256(toBytes(name));
export const ADMIN_ROLE = role("ADMIN_ROLE");
// AGENT_ROLE and the SIG_AGENT_* signatures below are kept on purpose. Only the negative-invariant agent checks
// (AGENT_LABELS in index.ts) use them: the deploy authorizes no agent (core 1527, architecture 5.2 and 6.3).
export const AGENT_ROLE = role("AGENT_ROLE");
export const WEIGHT_SETTER_ROLE = role("WEIGHT_SETTER_ROLE");
export const WEIGHT_SETTER_ROTATOR_ROLE = role("WEIGHT_SETTER_ROTATOR_ROLE");
export const WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE = role("WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE");
export const EMERGENCY_ROLE = role("EMERGENCY_ROLE");
export const DEPOSIT_PAUSER_ROLE = role("DEPOSIT_PAUSER_ROLE");
export const PROPOSER_ROLE = role("PROPOSER_ROLE");
export const EXECUTOR_ROLE = role("EXECUTOR_ROLE");
export const CANCELLER_ROLE = role("CANCELLER_ROLE");

/** The timelock delay floor keyed to chain id. 172800 s (48 h) on Base mainnet, at least 1 s elsewhere. Principle 4 and 6. */
export { MAINNET_CHAIN_ID } from "../chains.ts";
export { delayFloor as minDelayFloor } from "../chains.ts";

// Safe 1.4.1 canonical addresses and storage slots.
export const SAFE_L2_141_SINGLETON: Address = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
export const SAFE_141_FALLBACK_HANDLER: Address = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
export const SAFE_GUARD_SLOT: Hex = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
export const SAFE_FALLBACK_SLOT: Hex = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";
export const SAFE_SENTINEL: Address = "0x0000000000000000000000000000000000000001";

// Scanned to prove NO such log exists since the deploy began (negative invariant), never to find an agent.
export const SIG_AGENT_AUTHORIZED = "AgentAuthorized(address,address,uint64,uint256,uint256,address)";
export const SIG_AGENT_OWNERSHIP = "AgentOwnershipTransferred(address,address,address)";
export const SIG_ROLE_GRANTED = "RoleGranted(bytes32,address,address)";

export interface CoreContract { name: string; file: string; field: string; artifact: string }

const stageRow = (table: StageTable, stage: string): TableStage => {
  const r = table.stages.find((s) => s.name === stage);
  if (!r) throw new Error(`the core stage table has no stage '${stage}'`);
  return r;
};

/** The manifest file (with .json) a stage writes, from the table. */
export const stageManifestFile = (table: StageTable, stage: string): string => manifestFile(stageRow(table, stage).manifest);
/** The manifest name (no .json) a stage writes, from the table. Keys `Manifests.files`. */
export const stageManifestName = (table: StageTable, stage: string): string => manifestBase(stageRow(table, stage).manifest);

/** Core contracts the verifier checks: manifest file and field from the table's stage, build artifact from the table's `artifacts`. */
export function coreContracts(table: StageTable): CoreContract[] {
  return CORE_CONTRACT_REFS.map((r) => {
    const artifact = table.artifacts[r.artifactKey];
    if (!artifact) throw new Error(`the core stage table has no artifacts.${r.artifactKey}`);
    return { name: r.name, file: stageManifestFile(table, r.stage), field: r.field, artifact };
  });
}

/** Manifest names (no .json) that must be present: every table stage's manifest and the Safe stage's safe.json. */
export function requiredManifests(table: StageTable): string[] {
  return [...table.stages.map((s) => manifestBase(s.manifest)), manifestBase(SAFE_MANIFEST)];
}

export const SAFE_PROBE_ADDRESS: Address = "0x00000000000000000000000000000000000a11ce";
export const SAFE_PROBE_ADDRESS_2: Address = "0x00000000000000000000000000000000000b0b00";
