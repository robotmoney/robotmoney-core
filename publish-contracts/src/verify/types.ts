// Types shared by the verifier modules.
// Spec: the one-deployment-scheme plan, "Stage 12 verifier" (devops issue 53); issues devops 57 (S8) and 61.

import type { StageTable } from "../stage-table.ts";

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export interface Check {
  /** Stable label. Identical on the Twin chain and on mainnet. Never contains an address or a number. */
  label: string;
  ok: boolean;
  /** Free text with the observed and expected values. May contain addresses and numbers. */
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  checks: Check[];
}

export type VaultKind = "usdc" | "basket" | "agent";

export interface ExpectedAsset {
  token: Address;
  pool: Address;
  swapFee: number;
  adapter: Address;
  /** Venue enum index as stored on chain (0 = V3 for the shipped vaults). Optional per asset. */
  venue?: number;
  active?: boolean;
}

/** Everything the frozen sheet says about one vault. All fields are required: nothing is skipped silently. */
export interface VaultSheet {
  tvlCap: bigint;
  perDepositCap: bigint;
  exitFeeBps: bigint;
  feeRecipient: Address;
  /** True for vaults that ship paused (rmAGENT and the basket vaults until stage 13). */
  expectPaused: boolean;
  /** Basket and agent vaults: the exact asset set. rmAGENT is an empty list. Ignored for kind usdc. */
  assets: ExpectedAsset[];
  /** rmUSDC only: the frozen seed in 6-decimal units. */
  seed?: bigint;
  /** rmUSDC only: who receives the seed shares (the sheet SHARE_RECEIVER_ADDRESS). When set, the manifest must name the same address. */
  seedShareReceiver?: Address;
  /** Router eligibility the deployer left in place: rmUSDC from the router stage, a basket when the sheet lists it in ELIGIBLE_VAULTS. */
  routerEligible: boolean;
  /** Build artifact contract name when it is not implied by the kind. */
  contract?: string;
}

/** Deploy-time governance configuration the deployer sets before the timelock handover (issue 1520). */
export interface GovernanceSheet {
  voters: Address[];
  voterPower: bigint;
  quorum: bigint;
  votingPeriod: bigint;
  executionDelay: bigint;
}

export interface VerifySheet {
  chainId: number;
  deployer: Address;
  pauser: Address;
  emergency: Address;
  safeOwners: Address[];
  safeThreshold: number;
  /** Timelock delay in seconds the sheet asked for. */
  timelockDelay: number;
  /** Keyed by vault key (rmUSDC, rmPROTO, rmAGENT, rmRWA). */
  vaults: Record<string, VaultSheet>;
  governance: GovernanceSheet;
  /** The router default weights the deployer left in place, in router order (rmUSDC, then the eligible baskets): vault key and bps. */
  defaultWeights: { vault: string; bps: number }[];
}

export interface VerifyOptions {
  /** Read access to the chain. Use viemReader(rpcUrl) in production. */
  chain: ChainReader;
  manifestDir: string;
  /** The core stage table (scripts/deploy/stage-table.json at the DEPLOY_SHA): manifests, vault artifacts, libraries. */
  table: StageTable;
  sheet: VerifySheet;
  /** First block of the deployment (the first deploy receipt). The role scan starts here. */
  fromBlock: bigint;
  /** The block of the timelock handover. The agent checks stop here, because depositors authorize their own agents after it. Unset: the chain head. */
  handoverBlock?: bigint;
  /** Blocks per eth_getLogs call. The public Base RPC caps at 2000. */
  logChunk?: number;
  /** Frozen per-stage transaction counts for this DEPLOY_SHA. The deployer nonce must equal their sum. */
  frozenCounts: Record<string, number>;
  /** Directory with forge `out/` artifacts for the code-hash comparison. */
  artifactsDir: string;
  /**
   * The deployer nonce the runner recorded at the end of the last deployer stage. Set only when the govern stage has run: govern pays
   * gas for the Safe execTransaction calls from the deployer keystore, so the live nonce then exceeds the frozen sum by design.
   */
  deployerNonceAtDeployEnd?: number;
  /**
   * The Safe control proof the run manifest recorded (core 1618): the execTransaction hash and the Safe nonce it used. The verifier reads the
   * transaction back from the chain. Absent: the proof label fails (a deploy without the prove-control step is not accepted).
   */
  controlProof?: { txHash: Hex; nonce: number };
  /** Test seam only: the pinned FiatTokenProxy code hash. Production never sets it (src/usdc.ts holds the pin). */
  usdcCodeHash?: string;
  /** Delay in ms between 429 retries (tests set 0). */
  retryBaseMs?: number;
}

export interface RawCallResult {
  ok: boolean;
  /** Return data when ok, revert data when not. */
  data: Hex;
  /** Decoded Error(string) text when the call reverted with one. */
  reason?: string;
}

export interface LogEntry {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
}

/** The only surface the verifier uses to touch a chain. It is read-only. */
export interface ChainReader {
  chainId(): Promise<number>;
  blockNumber(): Promise<bigint>;
  /** Timestamp of the head block, in seconds. Optional: only the config-check freshness read needs it. */
  blockTimestamp?(): Promise<bigint>;
  getCode(address: Address): Promise<Hex>;
  nonce(address: Address): Promise<number>;
  getStorageAt(address: Address, slot: Hex): Promise<Hex>;
  /** Decoded read. `signature` is a human-readable ABI fragment such as "function hasRole(bytes32,address) view returns (bool)". Throws on revert. */
  read(address: Address, signature: string, args?: unknown[]): Promise<unknown>;
  /** One transaction by hash (the Safe control proof). Null when the chain does not know it. */
  getTransaction(hash: Hex): Promise<{ to: Address | null; input: Hex; value: bigint } | null>;
  /** The receipt status of a mined transaction, or null when it is not mined. */
  receiptStatus(hash: Hex): Promise<"success" | "reverted" | null>;
  /** Raw eth_call that never throws on revert. */
  callRaw(to: Address, data: Hex, from?: Address): Promise<RawCallResult>;
  getLogs(params: { address?: Address; topics: (Hex | Hex[] | null)[]; fromBlock: bigint; toBlock: bigint }): Promise<LogEntry[]>;
}
