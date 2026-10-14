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
  /** QA plan v1 C3 (CS-6): what gates the router's weight setter, as the chain reads it. Absent when the run stopped before the router was read. */
  weightSetter?: WeightSetterGating;
}

/**
 * QA plan v1 C3 (CS-6, ADR-0002 "Why the 1522 bypass stays closed"): every weight change waits the timelock delay only while each `WEIGHT_SETTER_ROLE` holder is
 * timelock-gated. A rotation installs whatever contract the Safe chose, so a holder that forwards Safe calls would make weight changes undelayed. The stage 12
 * verifier records this for the current holder(s) and fails "router: every WEIGHT_SETTER_ROLE holder is timelock-gated" on anything but "timelock".
 */
export interface WeightSetterGating {
  /** "timelock": every holder is timelock-gated. "not-timelock": the role has no holder, or a holder is not timelock-gated. "unreadable": a read failed, the gating is unknown. */
  gating: "timelock" | "not-timelock" | "unreadable";
  /** Every `WEIGHT_SETTER_ROLE` holder, in the router's enumeration order. Empty when the role is unreadable. */
  holders: WeightSetterHolder[];
  /** The timelock the gate must be: the timelock stage manifest's address. */
  timelock: Address;
  /** The timelock's `getMinDelay()` in seconds: the delay every weight change waits while `gating` is "timelock". Null when unreadable. */
  delaySeconds: number | null;
}

export interface WeightSetterHolder {
  address: Address;
  /** The holder's runtime code equals the RouterGovernance build (masked): its only weight writes, `applyReceipt`, `setDefaultWeights` and `clearVotedWeights`, are `onlyRole(ADMIN_ROLE)`. */
  routerGovernanceCode: boolean;
  /** The holder's `ADMIN_ROLE` members: its gate. Null when the holder does not answer `getRoleMemberCount`/`getRoleMember` (it is no AccessControlEnumerable contract). */
  admins: Address[] | null;
  /** The holder runs the RouterGovernance build and the timelock is its only `ADMIN_ROLE` member, so nothing but a timelock operation moves weights through it. */
  timelockGated: boolean;
}

export type VaultKind = "usdc" | "basket" | "agent";

/** The Uniswap V4 facts of an expected asset (core 1676): the PoolManager, StateView, pool id and the full PoolKey, all from core's config. */
export interface ExpectedV4 {
  poolManager: Address;
  stateView: Address;
  poolId: Hex;
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
}

export interface ExpectedAsset {
  token: Address;
  /** The pool the vault registers. For a UniswapV4 asset this is the price recorder, not a pool: V4 has no pool address. */
  pool: Address;
  swapFee: number;
  adapter: Address;
  /** Venue enum index as stored on chain (0 = V3, 1 = V4). Optional per asset. */
  venue?: number;
  active?: boolean;
  /** UniswapV4 only: what the recorder and the V4 adapter must be bound to. */
  v4?: ExpectedV4;
}

/** Everything the frozen sheet says about one vault. All fields are required: nothing is skipped silently. */
export interface VaultSheet {
  tvlCap: bigint;
  perDepositCap: bigint;
  exitFeeBps: bigint;
  /** Baskets only (issue 1666): the ORA-4 guard the deployer set, in bps. Required for kind basket and agent: a missing value fails the label. */
  navDeviationBps?: bigint;
  /** Baskets only (issue 1666): floor for `liquidity()` (uint128 L, not USDC) of every asset pool. Required for kind basket and agent. */
  minPoolLiquidity?: bigint;
  feeRecipient: Address;
  /** True for vaults that ship paused (rmAGENT and the basket vaults until stage 13). */
  expectPaused: boolean;
  /** Basket and agent vaults: the exact asset set. rmAGENT is the single RM asset. Ignored for kind usdc. */
  assets: ExpectedAsset[];
  /** rmUSDC only: the frozen seed in 6-decimal units. */
  seed?: bigint;
  /** rmUSDC only: who receives the seed shares (the sheet SHARE_RECEIVER_ADDRESS). When set, the manifest must name the same address. */
  seedShareReceiver?: Address;
  /** Router eligibility the deployer left in place: rmUSDC from the router stage, a basket when the sheet lists it in ELIGIBLE_VAULTS. */
  routerEligible: boolean;
  /**
   * Issue 1705 C4, kind usdc: the lending adapters the vault stage registered, in registration order: the address from the vault manifest and the cap
   * from the deploy script. The vault's adapter registry, caps and both allowlists (address and code hash) must equal this set. A missing value fails the label.
   */
  adapters?: { address: Address; capBps: number }[];
  /** Issue 1705 C4, kind basket and agent: the swap bound the deploy leaves (config root maxSlippageBps, else the vault default). A missing value fails the label. */
  maxSlippageBps?: bigint;
  /** Build artifact contract name when it is not implied by the kind. */
  contract?: string;
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
  /** Issue 1727: the deployment kind of the run (the sheet's DEPLOYMENT_KIND). Absent means production, the strictest reading: the 172800 s floor on 8453. */
  deploymentKind?: "production" | "rehearsal";
  /** Keyed by vault key (rmUSDC, rmPROTO, rmAGENT, rmRWA). */
  vaults: Record<string, VaultSheet>;
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
   * Issue 1727, rehearsal only: the deployer nonce the run manifest recorded at the first deployer stage. The expected nonce is this plus the summed frozen counts
   * plus the prove-control transaction. Absent (production): 0, a fresh deployer.
   */
  deployerStartNonce?: number;
  /**
   * The Safe control proof the run manifest recorded (core 1618): the execTransaction hash and the Safe nonce it used. The verifier reads the
   * transaction back from the chain. Absent: the proof label fails (a deploy without the prove-control step is not accepted).
   */
  controlProof?: { txHash: Hex; nonce: number };
  /**
   * The last consensus receipt the run manifest records as applied through `govern --row apply-receipt` (issue 1696, issue 1698): the receipt id and the vector. It is an
   * editable file, so it never sets what the router is checked against (QA plan v1 C2, issue 1701). The verifier reads the weight setter's `ReceiptApplied` events and
   * the router's `VotedWeightsCleared` events since `fromBlock` instead: the last application, unless a clear came after it, is the active vector. No active vector:
   * `votedWeightsActive()` must read false and the EFFECTIVE weights must equal the sheet's launch vector. An active one: the receipt must read released,
   * `votedWeightsActive()` must read true and the EFFECTIVE weights must equal the event's vector. This record must name the receipt and the vector of the chain's last
   * `ReceiptApplied` event (absent exactly when there is none), or the applied-receipt label fails. The DEFAULT vector equals the sheet in every case.
   */
  appliedReceipt?: { receiptId: Hex; vaults: Address[]; bps: number[] };
  /**
   * Issue 1796: the single-vault redeploys the run has finished (deployed AND governed): per redeploy the vault, the vault it replaced (now retired) and the vault that replaced it (the
   * address the vault manifest names). The vault set check then expects registry.listVaults() to be the manifests plus the retired vaults, and the retired vaults get their own labels.
   */
  /**
   * `oldBuild` (QA plan v1 E1): the build the retired vault runs. "original" (the default): the first round's old vault, a contract of the original deployment, compared with
   * `priorArtifactsDir`. "redeploy": a later round's old vault, deployed by an earlier round at the redeploy sha, compared with `artifactsDir`.
   */
  redeploys?: { vault: string; oldVault: Address; newVault: Address; oldBuild?: "original" | "redeploy" }[];
  /**
   * Issue 1796, QA plan v1 E1: forge out/ of a checkout at the ORIGINAL deployment sha (--prior-out). With redeploys, `artifactsDir` is the build of the redeploy sha and only the
   * replacing vaults run it: every contract the original deployment created (core, libraries, adapters, the vaults not replaced, a first round's retired vault) runs the code of
   * this build, so its code hash is compared with this directory. Absent (every round ran at the original sha, one build): `artifactsDir` is used for every contract.
   */
  priorArtifactsDir?: string;
  /** Issue 1796: the deployer transactions the redeploys sent (the sum of their deploy counts). They are outside every frozen stage count and move the deployer nonce. */
  redeployDeployerTxs?: number;
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
  /** The log's position in its block. Orders two logs of one block (an application and a clear, QA plan v1 C2). Absent: block order only. */
  logIndex?: number;
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
