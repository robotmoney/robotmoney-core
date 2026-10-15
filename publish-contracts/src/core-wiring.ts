// THE one mapping module between the core stage table and this tool's inputs. Everything else (stage names, scripts, env names,
// artifacts, manifest files, libraries) comes from core's stage table. What the table does not carry lives here and nowhere else:
//   - which sheet name feeds which env name a core script reads (a few differ: TVL_CAP is VAULT_<KEY>_TVL_CAP in the sheet),
//   - which earlier stage manifest key feeds which env name (REGISTRY_ADDRESS is the registry manifest's `registry`),
//   - which manifest field holds a deployed address the verifier reads.
// The core-parity test (tests/core-parity.test.ts) proves every name here exists in core, so a rename in core fails CI.
import { SHEET_SPEC, VAULT_KEYS, type VaultKey } from "./sheet.ts";
import type { StageRow } from "./stages.ts";

/** The stage whose manifest holds the library addresses (`libraries[].manifestKey`). */
export const LIBS_STAGE = "libs";
/**
 * The stage that deploys the permissionless Uniswap V4 price recorder (core 1676). It runs right after libs, so the 1800 s price history
 * accumulates while the other stages run. The runner waits for a full window of history before the agent stage.
 */
export const RECORDER_STAGE = "recorder";
/** The manifest field of a vault that holds its Uniswap V4 swap adapter (core 1676), and the field of the recorder it is bound to. */
export const VAULT_ADAPTER_V4_FIELD = "adapter_v4";
export const VAULT_RECORDER_FIELD = "recorder";
/** The build artifacts of the V4 contracts. They are in core's stage table `artifacts` as `recorder` and `v4Adapter` and checked against it. */
export const RECORDER_ARTIFACT_KEY = "recorder";
export const V4_ADAPTER_ARTIFACT_KEY = "v4Adapter";
/**
 * ADR-0014 §4 (issue 1809): the stage that deploys the timelock every proxy names as its upgrade authority, before the first proxy. Its manifest's `timelock`
 * feeds UPGRADE_AUTHORITY of every proxy stage and TIMELOCK_ADDRESS of the handover stage, so the role handover and the upgrade authority are one timelock.
 */
export const AUTHORITY_STAGE = "authority";
/** The stage whose script hands every role to the timelock (the last deployer stage). */
export const HANDOVER_STAGE = "timelock";
/** Written by this tool's Safe stage, not by a core script. */
export const SAFE_STAGE = "safe";
export const SAFE_MANIFEST = "safe.json";

export type EnvSource =
  | { from: "chain" }
  /** A fixed value the deploy sets itself (stage 11 AGENT_ADDRESSES is the word none: the deploy authorizes no agent). */
  | { from: "literal"; value: string }
  /** The stage's own manifest path (DEPLOYMENT_OUT): set by the runner from the table's manifest, never typed. */
  | { from: "out" }
  | { from: "sheet"; name: string }
  | { from: "manifest"; stage: string; field: string }
  /** One field of every vault stage manifest, in table `vaults` order, comma-joined. */
  | { from: "vaults"; field: string }
  /** Derived from the sheet by this tool (the bps vector of a basket's eligibility flip). */
  | { from: "computed" }
  | { from: "unmapped" };

/** Env name -> earlier stage manifest field. */
export const MANIFEST_ENV: Record<string, { stage: string; field: string }> = {
  VAULT_ADDRESS: { stage: "vault", field: "vault" },
  REGISTRY_ADDRESS: { stage: "registry", field: "registry" },
  ROUTER_ADDRESS: { stage: "router", field: "router" },
  GATEWAY_ADDRESS: { stage: "gateway", field: "gateway" },
  GOVERNANCE_ADDRESS: { stage: "governance", field: "governance" },
  IC_POLICY_ADDRESS: { stage: "ic-policy", field: "policy" },
  CONSENSUS_RECEIPT_ADDRESS: { stage: "ic-policy", field: "consensus_receipt" },
  SAFE_ADDRESS: { stage: SAFE_STAGE, field: "safe" },
  /** The single-vault redeploy (issue 1796) hands the new vault to the live timelock. */
  TIMELOCK_ADDRESS: { stage: "timelock", field: "timelock" },
  /** The agent stage registers this permissionless price recorder as RM's pool (core 1676). */
  RECORDER_ADDRESS: { stage: RECORDER_STAGE, field: "recorder" },
  /** ADR-0014 §4 (issue 1809): every proxy stage names the authority stage's timelock as the upgrade authority of the proxies it deploys. */
  UPGRADE_AUTHORITY: { stage: AUTHORITY_STAGE, field: "timelock" },
  /** ADR-0014 §9: the rmUSDC initializer creates its ExclusionLedger through the factory the libs stage deployed (CREATE2, one per chain). */
  EXCLUSION_LEDGER_FACTORY: { stage: LIBS_STAGE, field: "exclusion_ledger_factory" },
};
/**
 * Per-stage exceptions to MANIFEST_ENV (issue 1809). The handover stage reads TIMELOCK_ADDRESS as the timelock the authority stage deployed: it reuses that
 * timelock (DeployTimelock refuses unless every proxy names it) and cannot read its own manifest. Every other reader (the single-vault redeploy) keeps the
 * handover manifest's `timelock`, the same address once the handover ran.
 */
export const STAGE_MANIFEST_ENV: Record<string, Record<string, { stage: string; field: string }>> = {
  [HANDOVER_STAGE]: { TIMELOCK_ADDRESS: { stage: AUTHORITY_STAGE, field: "timelock" } },
};
export const VAULT_LIST_ENV = "VAULT_ADDRESSES";
/**
 * Basket vault stages: the router default weights (bps, comma list) the deployer sets in the same stage that makes the basket router-eligible
 * (registry.migrateEligibility), or the word none when the sheet leaves this basket ineligible. Computed from ELIGIBLE_VAULTS and ROUTER_WEIGHTS.
 */
export const ELIGIBILITY_BPS_ENV = "ROUTER_DEFAULT_BPS";
export const VAULT_ADDRESS_FIELD = "vault";

/** Env names core uses for the per-vault caps -> the suffix of the sheet name VAULT_<KEY>_<suffix>. */
export const VAULT_CAP_ENV: Record<string, string> = {
  TVL_CAP: "TVL_CAP", PER_DEPOSIT_CAP: "PER_DEPOSIT_CAP", EXIT_FEE_BPS: "EXIT_FEE_BPS",
  // basket stages only (issue 1666): the table lists them for proto, agent and rwa, never for vault (rmUSDC)
  NAV_DEVIATION_BPS: "NAV_DEVIATION_BPS", MIN_POOL_LIQUIDITY: "MIN_POOL_LIQUIDITY",
};
/** Env names core reads that carry a different name in the sheet. */
export const SHEET_RENAMES: Record<string, string> = {
  SEED_SHARE_RECEIVER: "SHARE_RECEIVER_ADDRESS",
  FEE_RECIPIENT: "FEE_RECIPIENT_ADDRESS",
};

/** Where the value of env name `env` comes from for a stage of vault `vault` (null for a non-vault stage). `stage` (the stage name) selects a STAGE_MANIFEST_ENV exception. */
export function resolveEnv(env: string, vault: VaultKey | null, stage?: string): EnvSource {
  if (env === "EXPECTED_CHAIN_ID") return { from: "chain" };
  if (env === "DEPLOYMENT_OUT") return { from: "out" };
  if (env === "AGENT_ADDRESSES") return { from: "literal", value: "none" };
  const m = (stage !== undefined ? STAGE_MANIFEST_ENV[stage]?.[env] : undefined) ?? MANIFEST_ENV[env];
  if (m) return { from: "manifest", ...m };
  if (env === ELIGIBILITY_BPS_ENV) return { from: "computed" };
  if (env === VAULT_LIST_ENV) return { from: "vaults", field: VAULT_ADDRESS_FIELD };
  const cap = VAULT_CAP_ENV[env];
  if (cap && vault) return { from: "sheet", name: `VAULT_${vault}_${cap}` };
  const name = SHEET_RENAMES[env] ?? env;
  if (name in SHEET_SPEC) return { from: "sheet", name };
  return { from: "unmapped" };
}

/** The sheet names a stage's required env needs (for tests and the plan). */
export function requiredSheetNames(row: Pick<StageRow, "requiredEnv" | "vault"> & { name?: string }): string[] {
  const out: string[] = [];
  for (const e of row.requiredEnv) {
    const s = resolveEnv(e, row.vault ?? null, row.name);
    if (s.from === "sheet") out.push(s.name);
  }
  return out;
}

/**
 * Issue 1705 C4: the lending adapters a vault stage registers, in registration order (rmUSDC: DeployVault.s.sol `_approveAndRegisterAdapters`). `stage` is the
 * vault stage that writes them. Each adapter names the manifest field that holds it (deployed per run), the script constant that holds its cap and that cap in
 * bps. The verifier compares the vault's adapter registry, caps and code-hash allowlist with this; the core-parity check reads the constants and the field
 * names from the script, so a change there fails CI.
 */
export interface LendingAdapterWiring { field: string; capConstant: string; capBps: number }
export const LENDING_ADAPTERS: Partial<Record<VaultKey, { stage: string; adapters: readonly LendingAdapterWiring[] }>> = {
  USDC: {
    stage: "vault",
    adapters: [
      { field: "aave_adapter", capConstant: "AAVE_BPS", capBps: 3334 },
      { field: "compound_adapter", capConstant: "COMPOUND_BPS", capBps: 3333 },
      { field: "moonwell_flagship_adapter", capConstant: "THIRD_VENUE_BPS", capBps: 3333 },
    ],
  },
};

/** The verifier's core contracts: manifest field and the key into the table's `artifacts`. Names and files come from the table. */
export const CORE_CONTRACT_REFS: { name: string; stage: string; field: string; artifactKey: string }[] = [
  { name: "gateway", stage: "gateway", field: "gateway", artifactKey: "gateway" },
  { name: "registry", stage: "registry", field: "registry", artifactKey: "registry" },
  { name: "router", stage: "router", field: "router", artifactKey: "router" },
  { name: "governance", stage: "governance", field: "governance", artifactKey: "governance" },
  { name: "icpolicy", stage: "ic-policy", field: "policy", artifactKey: "icPolicy" },
  { name: "receipt", stage: "ic-policy", field: "consensus_receipt", artifactKey: "receipt" },
  { name: "timelock", stage: "timelock", field: "timelock", artifactKey: "timelock" },
  // core 1676: the price recorder is a core contract of the deploy. It has no role, so the role matrix skips it.
  { name: "recorder", stage: RECORDER_STAGE, field: "recorder", artifactKey: RECORDER_ARTIFACT_KEY },
];

/** Manifest fields the tool reads, by stage. The parity test checks the scripts write them. */
export const MANIFEST_FIELDS_READ: { stage: string; field: string }[] = [
  ...Object.values(MANIFEST_ENV).filter((x) => x.stage !== SAFE_STAGE),
  ...CORE_CONTRACT_REFS.map(({ stage, field }) => ({ stage, field })),
  // the verifier reads these from the timelock manifest, and chain_id from every stage manifest
  ...["safe", "emergency", "code_hashes", "roles", "gateway_agents_listed_count", "deployer_owns_a_listed_gateway_agent"].map((field) => ({ stage: "timelock", field })),
  { stage: "libs", field: "chain_id" },
  // core 1676: the verifier reads the V4 adapter and the recorder a vault stage wrote, and the recorder stage's own manifest
  { stage: "agent", field: VAULT_ADAPTER_V4_FIELD },
  { stage: "agent", field: VAULT_RECORDER_FIELD },
  // issue 1705 C4: the verifier reads the rmUSDC lending adapters the vault stage wrote
  ...Object.values(LENDING_ADAPTERS).flatMap((w) => w!.adapters.map((a) => ({ stage: w!.stage, field: a.field }))),
  // issue 1809: the handover stage reads the authority stage's timelock (the per-stage exception)
  ...Object.values(STAGE_MANIFEST_ENV).flatMap((m) => Object.values(m)),
];
// The proxies' own manifest fields (proxy, implementation, upgrade_authority, upgrade_mode) come from the stage table's `proxies`: core parity checks them
// there (src/ci/core-parity.ts, proxyProblems), so a renamed field fails CI.

/**
 * Core's launch asset config, one file per basket or agent vault, identical on every chain. `list` is the key that holds the assets.
 * Each asset carries symbol, token, pool, poolFee and venue. No adapter address is in static config: the adapter is deployed per run
 * and read from the vault manifest's `adapter` field.
 */
export const ASSET_CONFIG_FILES: Partial<Record<VaultKey, { file: string; list: string }>> = {
  PROTO: { file: "config/protocol-assets.json", list: "assets" },
  RWA: { file: "config/rwa-assets.json", list: "assets" },
  AGENT: { file: "config/agent-token-shortlist.json", list: "shortlist" },
};
/** The manifest field of a basket or agent vault that holds its Uniswap V3 swap adapter. */
export const VAULT_ADAPTER_FIELD = "adapter";

/**
 * Issue 1705 C4: each basket's swap bound when its config sets no root `maxSlippageBps` (zero keeps the vault default, BasketVaultDeployBase): the vault
 * constructor's `_DEFAULT_SLIPPAGE_BPS`. The core-parity check reads the constant from each vault source.
 */
export const BASKET_DEFAULT_SLIPPAGE_BPS: Partial<Record<VaultKey, bigint>> = { PROTO: 100n, AGENT: 300n, RWA: 100n };
/** Core's `venue` names to the on-chain Venue enum index (`BasketVault.Venue`: V3 = 0, V4 = 1, Aerodrome = 2). */
export const VENUE_INDEX: Record<string, number> = { UniswapV3: 0, UniswapV4: 1 };
export const VENUE_V3 = 0;
export const VENUE_V4 = 1;
/** The manifest field that holds the adapter of an asset on this venue. */
export const adapterFieldFor = (venue: number): string => (venue === VENUE_V4 ? VAULT_ADAPTER_V4_FIELD : VAULT_ADAPTER_FIELD);


/** The verifier's vault kind per table vault key. */
export const VAULT_KIND: Record<VaultKey, "usdc" | "basket" | "agent"> = { USDC: "usdc", PROTO: "basket", AGENT: "agent", RWA: "basket" };
export const isVaultKey = (k: string): k is VaultKey => (VAULT_KEYS as readonly string[]).includes(k);
