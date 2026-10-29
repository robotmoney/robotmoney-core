// Types shared by the verifier modules.
// Spec: the one-deployment-scheme plan, "Stage 12 verifier" (devops issue 53); issues devops 57 (S8) and 61.

import type { StageTable } from "../stage-table.ts";
import type { UpgradeabilityRecord } from "./upgradeability.ts";

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
  /** Issue 1809: what the upgradeability labels read (proxies, implementations, code hashes, layout ids, authority, delay, initialization, freeze state) and the immutability claim. */
  upgradeability?: UpgradeabilityRecord;
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
  /**
   * The holder's logic code (the implementation behind its ERC-1967 proxy, issue 1808) equals the RouterGovernance build (masked): its weight writes are
   * `applyReceipt` (`onlyRole(WEIGHT_SETTER_ROLE)`, issue 1698) and `setDefaultWeights` (`onlyRole(ADMIN_ROLE)`).
   */
  routerGovernanceCode: boolean;
  /** The holder's `ADMIN_ROLE` members. Null when the holder does not answer `getRoleMemberCount`/`getRoleMember` (it is no AccessControlEnumerable contract). */
  admins: Address[] | null;
  /** The holder's own `WEIGHT_SETTER_ROLE` members (the `applyReceipt` gate, issue 1698). Null when unreadable. */
  setters: Address[] | null;
  /** The holder runs the RouterGovernance build and the timelock is its only `ADMIN_ROLE` and its only `WEIGHT_SETTER_ROLE` member, so nothing but a timelock operation moves weights through it. */
  timelockGated: boolean;
}

export type VaultKind = "usdc" | "basket";

export interface ExpectedAsset {
  token: Address;
  /** The pool the vault registers. */
  pool: Address;
  swapFee: number;
  adapter: Address;
  /** Venue enum index as stored on chain (0 = V3). Optional per asset. */
  venue?: number;
  active?: boolean;
}

/** Everything the frozen sheet says about one vault. All fields are required: nothing is skipped silently. */
export interface VaultSheet {
  tvlCap: bigint;
  perDepositCap: bigint;
  exitFeeBps: bigint;
  /** Baskets only (issue 1666): the ORA-4 guard the deployer set, in bps. Required for kind basket: a missing value fails the label. */
  navDeviationBps?: bigint;
  /** Baskets only (issue 1666): floor for `liquidity()` (uint128 L, not USDC) of every asset pool. Required for kind basket. */
  minPoolLiquidity?: bigint;
  feeRecipient: Address;
  /** True for vaults that ship paused (the basket vaults until stage 13). */
  expectPaused: boolean;
  /** Basket vaults: the exact asset set. Ignored for kind usdc. */
  assets: ExpectedAsset[];
  /** rmUSDC only: the frozen seed in 6-decimal units. */
  seed?: bigint;
  /** rmUSDC only: who receives the seed shares (the sheet SHARE_RECEIVER_ADDRESS). When set, the manifest must name the same address. */
  seedShareReceiver?: Address;
  /** Router eligibility the deployer left in place: rmUSDC from the router stage, a basket when the sheet lists it in ELIGIBLE_VAULTS. */
  routerEligible: boolean;
  /** Build artifact contract name when it is not implied by the kind. */
  contract?: string;
  /** Baskets (issue 1705 C4): the maxSlippageBps the config sets, else the vault's constructor default. Required for kind basket. */
  maxSlippageBps?: bigint;
  /** rmUSDC (issue 1705 C4): the strategy adapters the vault stage registered, in order, with the bps cap the deploy script gives each. Required for kind usdc. */
  adapters?: { adapter: Address; capBps: number }[];
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
  /** Issue 1809: the sheet's UPGRADE_MODE. Absent fails "upgrades: the sheet declares the release mode" and every freeze-state label. */
  upgradeMode?: "upgradeable" | "frozen";
  /** Issue 1809: the sheet's UPGRADE_FREEZE_DEADLINE (ISO 8601 UTC), the proving-period deadline of an upgradeable release. */
  freezeDeadline?: string;
  /** Keyed by vault key (rmUSDC, rmPROTO, rmRWA). */
  vaults: Record<string, VaultSheet>;
  /** The router default weights the deployer left in place, in router order (rmUSDC, then the eligible baskets): vault key and bps. */
  defaultWeights: { vault: string; bps: number }[];
  /** Issue 1892, the gateway system only: the explicit governance inputs of the gateway sheet (GATEWAY_ADMIN_ADDRESS, GATEWAY_UPGRADE_TIMELOCK). */
  gateway?: { admin: Address; upgradeTimelock: Address };
}

export interface VerifyOptions {
  /** Issue 1892: the system to verify. Absent: `vaults` for a table that declares systems, else `legacy` (the combined deploy, deployments/8453/deploy-2: every check kept). */
  system?: "vaults" | "gateway" | "legacy";
  /** Read access to the chain. Use viemReader(rpcUrl) in production. */
  chain: ChainReader;
  manifestDir: string;
  /** The core stage table (scripts/deploy/stage-table.json at the DEPLOY_SHA): manifests, vault artifacts, libraries. */
  table: StageTable;
  sheet: VerifySheet;
  /** First block of the deployment (the first deploy receipt). The role scan starts here. */
  fromBlock: bigint;
  /**
   * Issue 1851: every deploy transaction the run manifest recorded (each stage's txHashes and each redeploy's deploy_tx_hashes). Every log scan proves from their receipts
   * that each contract it scans was created at or after `fromBlock`. Absent with a `fromBlock` above zero: every scan label fails, the scan start cannot be proven.
   */
  deployTxs?: Hex[];
  /**
   * Issue 1851, issue 1835: contracts the run adopted instead of creating (the run manifest's adopted stages, `adoption.libraries[].address`: the core timelock someone else
   * deployed at the predicted CREATE2 address). The creation proof finds their creation transaction from their earliest RoleGranted log from `fromBlock` on.
   */
  adoptedContracts?: Address[];
  /** The block of the timelock handover. The agent checks stop here, because depositors authorize their own agents after it. Unset: the chain head. */
  handoverBlock?: bigint;
  /** Blocks per eth_getLogs call. The public Base RPC caps at 2000. */
  logChunk?: number;
  /** Frozen per-stage transaction counts for this DEPLOY_SHA. The deployer nonce must equal their sum. */
  frozenCounts: Record<string, number>;
  /** Directory with forge `out/` artifacts for the code-hash comparison. */
  artifactsDir: string;
  /** Issue 1809: the core checkout at the DEPLOY_SHA, for the storage-layout snapshots the layout identifiers hash. Absent: the layout labels fail. */
  coreDir?: string;
  /** Issue 1809, test seam: the time (seconds) the freeze deadline is compared with. Absent: the head block's timestamp. */
  now?: bigint;
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
   * The last consensus receipt the Safe applied through `govern --row apply-receipt` (issue 1696), from the run manifest: the receipt id and the vector the
   * router took. Absent: no receipt was applied and the router default weights must equal the sheet. Present: the receipt must read released and the router
   * default weights must equal this vector (the sheet vector was superseded by the application).
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
  redeploys?: { vault: string; oldVault: Address; newVault: Address; replacementManifest?: string; routerVaultCap?: string; oldBuild?: "original" | "redeploy" }[];
  /**
   * Issue 1796, QA plan v1 E1: forge out/ of a checkout at the ORIGINAL deployment sha (--prior-out). With redeploys, `artifactsDir` is the build of the redeploy sha and only the
   * replacing vaults run it: every contract the original deployment created (core, libraries, adapters, the vaults not replaced, a first round's retired vault) runs the code of
   * this build, so its code hash is compared with this directory. Absent (every round ran at the original sha, one build): `artifactsDir` is used for every contract.
   */
  priorArtifactsDir?: string;
  /**
   * Issue 1859: forge out/ of the build each governed-upgraded proxy runs now, by verifier proxy name (`gateway`, `vault[rmUSDC]`, ...), from the `build` of the proxy's last
   * `proxy_upgrades` entry in the run manifest. That proxy's `runtime code equals build artifact (masked)` label and its library-link label read this directory; every other
   * contract reads `artifactsDir`. Absent or no entry: `artifactsDir`.
   */
  proxyBuildDirs?: Record<string, string>;
  /**
   * Issue 1912, ADR-0017: the vaults the Safe retired through `govern --row retire-vault` (the run manifest's `vault_retirements`). The registry still lists them, so the vault set check expects
   * the manifests plus these retired vaults, and each gets its own labels: Retired in the registry, out of the router's default and effective vectors, deposits halted, still holding code.
   */
  retirements?: { vault: Address }[];
  /** Issue 1796: the deployer transactions the redeploys sent (the sum of their deploy counts). They are outside every frozen stage count and move the deployer nonce. */
  redeployDeployerTxs?: number;
  /** Test seam only: the pinned FiatTokenProxy code hash. Production never sets it (src/usdc.ts holds the pin). */
  usdcCodeHash?: string;
  /** Issue 1892, the gateway system only: sha256 of each vaults-system manifest the gateway run consumed (hashConsumedManifests), recorded when the run began. The verifier fails when one changed. */
  consumedVaultsManifests?: Record<string, string>;
  /** Delay in ms between 429 retries (tests set 0). */
  retryBaseMs?: number;
}

/** Issue 1851: what the creation proof of the log scans reads from one deploy transaction's receipt. */
export interface DeployReceipt {
  blockNumber: bigint;
  status: "success" | "reverted";
  /** The contract a CREATE transaction made. Null for a call (the CREATE2 factory call of the timelock stage). */
  contractAddress: Address | null;
  to: Address | null;
  /** The emitter of every log of the transaction. */
  logs: { address: Address }[];
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
  /** The transaction that emitted the log (issue 1842: a freeze is matched with the timelock execution of the same transaction). */
  transactionHash?: Hex;
}

/** The only surface the verifier uses to touch a chain. It is read-only. */
export interface ChainReader {
  chainId(): Promise<number>;
  blockNumber(): Promise<bigint>;
  /** Timestamp of the head block, in seconds. Optional: only the config-check freshness read needs it. */
  blockTimestamp?(): Promise<bigint>;
  /** Runtime code at the head. Never a historical block: a pruned RPC cannot serve past state (issue 1851). */
  getCode(address: Address): Promise<Hex>;
  nonce(address: Address): Promise<number>;
  getStorageAt(address: Address, slot: Hex): Promise<Hex>;
  /** Decoded read. `signature` is a human-readable ABI fragment such as "function hasRole(bytes32,address) view returns (bool)". Throws on revert. */
  read(address: Address, signature: string, args?: unknown[]): Promise<unknown>;
  /** One transaction by hash (the Safe control proof). Null when the chain does not know it. */
  getTransaction(hash: Hex): Promise<{ to: Address | null; input: Hex; value: bigint } | null>;
  /** The receipt status of a mined transaction, or null when it is not mined. */
  receiptStatus(hash: Hex): Promise<"success" | "reverted" | null>;
  /** Issue 1851: a deploy transaction's receipt (eth_getTransactionReceipt, served by pruned nodes), or null when the chain does not know it. Throws when the RPC refuses. */
  deployReceipt(hash: Hex): Promise<DeployReceipt | null>;
  /** Raw eth_call that never throws on revert. */
  callRaw(to: Address, data: Hex, from?: Address): Promise<RawCallResult>;
  getLogs(params: { address?: Address; topics: (Hex | Hex[] | null)[]; fromBlock: bigint; toBlock: bigint }): Promise<LogEntry[]>;
}
