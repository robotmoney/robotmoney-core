// The frozen sheet: a whitelist parser. The sheet is DATA. It is never sourced, never evaluated, never expanded.
//   - Only the names in SPEC are accepted. An unknown name is refused.
//   - YES and CONFIRM never come from the sheet. They come from the caller environment only (callerInputs).
//   - Every required name has no default. A missing name is an error, never a silent skip.
//   - Values that a stage produces (REGISTRY_ADDRESS, IC_POLICY_ADDRESS, DEPLOYMENT_OUT ...) are refused: they come from manifests.
// Plan: one-deployment-scheme principles 16, 18, 19, 20 (devops issue 53); issue devops 55 (S6).
import { USDC_ADDRESS } from "./usdc.ts";
import { STAGE13_UNPAUSE_VAULTS } from "./vault-rules.ts";
import { getAddress, isAddress } from "viem";
import { PublishError } from "./errors.ts";
import { BASKET_KEYS, VAULT_KEYS, type VaultKey } from "./vault-keys.ts";
import { MAINNET_CHAIN_ID, DEPLOYMENT_KINDS, REHEARSAL_DELAY_FLOOR, rehearsalDelayProblem, type DeploymentKind } from "./chains.ts";

export type Address = `0x${string}`;
export { VAULT_KEYS, BASKET_KEYS, type VaultKey } from "./vault-keys.ts";
/** Manifest and verifier name of each vault. */
export const VAULT_NAME: Record<VaultKey, string> = { USDC: "rmUSDC", PROTO: "rmPROTO", AGENT: "rmAGENT", RWA: "rmRWA" };

/** Per-vault sheet names. Always required, never defaulted. */
export const vaultSheetNames = (k: VaultKey): string[] => [`VAULT_${k}_TVL_CAP`, `VAULT_${k}_PER_DEPOSIT_CAP`, `VAULT_${k}_EXIT_FEE_BPS`];

/** Basket-only sheet names (issue 1666): the ORA-4 deposit guard in bps and the floor for every pool's in-range liquidity (`IUniswapV3Pool.liquidity()`, a uint128 L, not a USDC amount). */
export const basketSheetNames = (k: VaultKey): string[] => (BASKET_KEYS as readonly string[]).includes(k) ? [`VAULT_${k}_NAV_DEVIATION_BPS`, `VAULT_${k}_MIN_POOL_LIQUIDITY`] : [];
/** The vault's own ceiling: BasketVault.MAX_NAV_DEVIATION_BPS. The deploy script requires the same range 1..2000. */
export const MAX_NAV_DEVIATION_BPS = 2000n;
/** `IUniswapV3Pool.liquidity()` is a uint128. */
export const MAX_POOL_LIQUIDITY = (1n << 128n) - 1n;

type Kind = "address" | "address-or-safe" | "address-list" | "uint" | "string";
interface NameSpec { kind: Kind }

const GLOBAL_NAMES: Record<string, NameSpec> = {
  CHAIN_ID: { kind: "uint" },
  EXPECTED_CHAIN_ID: { kind: "uint" },
  // roles
  ADMIN_ADDRESS: { kind: "address" },
  PAUSER_ADDRESS: { kind: "address" },
  EMERGENCY_ADDRESS: { kind: "address" },
  SHARE_RECEIVER_ADDRESS: { kind: "address" },
  RECEIPT_ADMIN_ADDRESS: { kind: "address" },
  SAFE_OWNERS: { kind: "address-list" },
  SAFE_THRESHOLD: { kind: "uint" },
  SAFE_VERSION: { kind: "string" },
  SAFE_SALT_NONCE: { kind: "uint" },
  // economics
  USDC_ADDRESS: { kind: "address" },
  FEE_RECIPIENT_ADDRESS: { kind: "address-or-safe" },
  SEED_DEPOSIT_USDC: { kind: "uint" },
  /** The Uniswap V3 SwapRouter02 the basket vaults trade through (core env SWAP_ROUTER). */
  SWAP_ROUTER: { kind: "address" },
  TIMELOCK_MIN_DELAY: { kind: "uint" },
  /**
   * Issue 1809 (upgradeability stage 2): the release mode of every core proxy, `upgradeable` or `frozen`. Required, no default: no sheet can leave a final
   * deployment upgradeable by omission. `frozen` freezes upgrades inside each proxy's atomic initialization.
   */
  UPGRADE_MODE: { kind: "string" },
  /**
   * Issue 1809: the proving-period freeze deadline of an `upgradeable` release, an ISO 8601 UTC time (2027-01-31T00:00:00Z). Required for an upgradeable PRODUCTION
   * release on 8453, refused with `frozen`. It is an operational commitment of the Safe signers, never an on-chain freeze: verify fails once it has passed with a proxy
   * still upgradeable (docs/operations/contract-release-runbooks.md 4.12).
   */
  UPGRADE_FREEZE_DEADLINE: { kind: "string" },
  /** Issue 1727: `production` (the default when the line is absent) or `rehearsal` (a Base mainnet rehearsal with a 900 s timelock). Sheet only: never an environment variable, never a CLI flag. */
  DEPLOYMENT_KIND: { kind: "string" },
  // deploy-time router configuration, set by the deployer in the basket vault stages (before the timelock handover). Lists of vault keys, or the word none.
  ELIGIBLE_VAULTS: { kind: "string" },
  ROUTER_WEIGHTS: { kind: "string" },
  // govern stage (stage 13): the unpauses of the four vaults are the only mainnet operation after the handover. GOVERN_NEW_DELAY feeds the Twin-only update-delay demonstration.
  GOVERN_UNPAUSE_VAULTS: { kind: "string" },
  GOVERN_NEW_DELAY: { kind: "uint" },
};
const VAULT_NAMES: Record<string, NameSpec> = Object.fromEntries(VAULT_KEYS.flatMap((k) => [...vaultSheetNames(k), ...basketSheetNames(k)].map((n) => [n, { kind: "uint" as Kind }])));
export const SHEET_SPEC: Record<string, NameSpec> = { ...GLOBAL_NAMES, ...VAULT_NAMES };

/**
 * Names with no default and no skip. SAFE_VERSION, SAFE_SALT_NONCE, DEPLOYMENT_KIND (absent means production), USDC_ADDRESS (a constant: when present it must equal it) and
 * UPGRADE_FREEZE_DEADLINE (its presence is ruled by UPGRADE_MODE) are the only optional names.
 */
export const OPTIONAL_NAMES = new Set(["SAFE_VERSION", "SAFE_SALT_NONCE", "USDC_ADDRESS", "DEPLOYMENT_KIND", "UPGRADE_FREEZE_DEADLINE"]);
/** The release modes (issue 1809). The words are the deploy scripts' (UpgradeAuthority.parseUpgradeMode in core). */
export const UPGRADE_MODES = ["upgradeable", "frozen"] as const;
export type UpgradeMode = (typeof UPGRADE_MODES)[number];
export const REQUIRED_NAMES = Object.keys(SHEET_SPEC).filter((n) => !OPTIONAL_NAMES.has(n));

/** Refused by name with a reason. Anything else not in the whitelist is refused as unknown. */
const REFUSED: [RegExp, string][] = [
  [/^(YES|CONFIRM)$/, "YES and CONFIRM come from the caller environment only, never from a sheet"],
  [/^(REHEARSAL|ALLOW_SHORT_TIMELOCK_DELAY|SKIP_ROUTER_ADMIN_GRANT|BASKET_VAULT_AUDIT_COMPLETE|MOCK_ALL|CONFIG_PATH)$/, "this switch is deleted: one deployment scheme, floors are keyed to the chain id"],
  [/^(RPC|RPC_URL|ETH_RPC_URL|RPC_ENDPOINT)$/, "the RPC is a CLI argument, never a sheet value"],
  [/^(PRIVATE_KEY|ETH_PRIVATE_KEY|MNEMONIC|ETH_MNEMONIC|ETH_PASSWORD|CHAIN_SIGNER_KEYSTORE|CHAIN_SIGNER_PASSWORD|[A-Z_]*(PRIVATE_KEY|PASSWORD|PASSPHRASE|SECRET|MNEMONIC)[A-Z_]*)$/, "a secret never goes in a sheet: use the credential engine or an encrypted keystore with a typed passphrase"],
  [/^(SAFE_ADDRESS|REGISTRY_ADDRESS|ROUTER_ADDRESS|GATEWAY_ADDRESS|GOVERNANCE_ADDRESS|IC_POLICY_ADDRESS|CONSENSUS_RECEIPT_ADDRESS|VAULT_ADDRESS|VAULT_ADDRESSES|TIMELOCK_ADDRESS|AGENT_ADDRESSES|DEPLOYMENT_OUT|DEPLOY_SHA)$/, "this value is produced by a stage or given as an argument: it is read from manifests, never typed"],
  [/^(AGENT_ADDRESS|AGENT_VALID_UNTIL|AGENT_MAX_PER_PAYMENT|AGENT_MAX_PER_WINDOW|AGENT_MAX_WITHDRAW_PER_PAYMENT|AGENT_MAX_WITHDRAW_PER_WINDOW)$/, "the deploy authorizes no agent: an agent belongs to a depositor, who authorizes it through commitAuthorization and revealAuthorization (architecture 5.2 and 6.3)"],
  [/^GOVERN_(?!UNPAUSE_VAULTS$|NEW_DELAY$)[A-Z_]*$/, "govern (stage 13) carries the four vault unpauses only. Vault setters, eligibility and router default weights are deploy-time configuration the deployer sets before the timelock handover (ELIGIBLE_VAULTS, ROUTER_WEIGHTS, VAULT_<KEY>_*). Router weights change on demand through the apply-receipt row (--row apply-receipt), never through a GOVERN_ sheet name"],
  [/^(VOTER_ADDRESSES|VOTER_POWER|QUORUM_THRESHOLD|VOTING_PERIOD|EXECUTION_DELAY)$/, "there is no voting by anyone: RouterGovernance has no voter, voting power, quorum, voting period or execution delay (issue 1698). Router weights change only when the Safe applies a consensus receipt through the timelock (govern row apply-receipt). Delete the line"],
  [/^VAULT_NAME$/, "the registry name of every vault is a constant of its own vault stage script (rmUSDC included), never a sheet value (issue 1705: one registry-name source for all four vaults). Delete the line"],
  [/^(VAULT_TVL_CAP|VAULT_PER_DEPOSIT_CAP|VAULT_EXIT_FEE_BPS)$/, "there is no unprefixed vault cap name: each vault has its own, and the name carries the vault key (USDC, PROTO, AGENT or RWA), for example VAULT_PROTO_TVL_CAP"],
  [/^VAULT_(?:USDC_)?(?:NAV_DEVIATION_BPS|MIN_POOL_LIQUIDITY)$/, "the NAV deviation guard and the pool liquidity floor belong to the baskets only: name the basket (PROTO, AGENT or RWA), for example VAULT_AGENT_NAV_DEVIATION_BPS. rmUSDC has no navDeviationGuardBps and no pool"],
];

export interface SheetVault {
  tvlCap: bigint; perDepositCap: bigint; exitFeeBps: bigint;
  /** Baskets only: the ORA-4 guard in bps, 1..2000. */
  navDeviationBps?: bigint;
  /** Baskets only: the floor for the in-range liquidity (uint128 L) of every configured pool. Above 0. */
  minPoolLiquidity?: bigint;
}

export interface Sheet {
  /** Normalised raw values by name, exactly what the sheet said (addresses checksummed). */
  values: Record<string, string>;
  chainId: number;
  expectedChainId: number;
  /** The deployment kind (issue 1727): `production` unless the sheet says `DEPLOYMENT_KIND=rehearsal`. */
  kind: DeploymentKind;
  admin: Address;
  pauser: Address;
  emergency: Address;
  shareReceiver: Address;
  receiptAdmin: Address;
  safeOwners: Address[];
  safeThreshold: number;
  safeSalt?: string;
  usdc: Address;
  swapRouter: Address;
  /** The checksummed address, or "@safe" meaning the Safe the deployer created. */
  feeRecipient: Address | "@safe";
  seedDeposit: bigint;
  timelockMinDelay: bigint;
  /** Issue 1809: the release mode of every core proxy, and the freeze deadline of an upgradeable release (ISO 8601 UTC, normalised). */
  upgrade: { mode: UpgradeMode; freezeDeadline?: string };
  vaults: Record<VaultKey, SheetVault>;
  /** Baskets made router-eligible by the deployer in the basket vault stages (rmUSDC is eligible from the router stage). */
  eligibleVaults: VaultKey[];
  /** The router default weights the deployer leaves in place: rmUSDC and each eligible basket. */
  weights: { key: VaultKey; bps: number }[];
  govern: {
    /** The only mainnet govern rows: one timelock unpause per vault listed here. */
    unpauseVaults: VaultKey[];
    /** Twin-only update-delay demonstration target. */
    newDelay: bigint;
  };
}

const err = (message: string, details: Record<string, unknown> = {}) => new PublishError("SHEET", message, details);

/** Splits the text into name/value pairs. Pure text handling: nothing is expanded or executed. */
export function parseSheetText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((line, i) => {
    const at = `line ${i + 1}`;
    const t = line.trim();
    if (t === "" || t.startsWith("#")) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t);
    if (!m) throw err(`${at}: not a NAME=value line (a sheet is data: no commands, no sourcing)`, { line: i + 1 });
    const name = m[1]!;
    let v = m[2]!.trim();
    if (v.startsWith('"') || v.startsWith("'")) {
      const q = v[0]!;
      const end = v.indexOf(q, 1);
      if (end < 0) throw err(`${at}: unterminated quote for ${name}`, { line: i + 1 });
      const rest = v.slice(end + 1).trim();
      if (rest !== "" && !rest.startsWith("#")) throw err(`${at}: text after the closing quote for ${name}`, { line: i + 1 });
      v = v.slice(1, end);
    } else {
      v = v.replace(/\s+#.*$/, "").trim();
    }
    if (/[`$;&|<>\\]/.test(v)) throw err(`${at}: ${name} holds a shell metacharacter. A sheet is data and is never sourced.`, { line: i + 1, name });
    if (name in out) throw err(`${at}: ${name} is set twice`, { name });
    out[name] = v;
  });
  return out;
}

/**
 * Issue 1833: the verbs that run against a deployment that already exists. A sheet made before issue 1705 (the old rehearsal key fragment printed VAULT_NAME) must not
 * block them, above all the emergency pause-all: they drop the line with one warning. Every deploy stage still refuses it.
 */
export const LEGACY_VAULT_NAME_VERBS = ["pause-all", "govern", "verify", "record-receipt"] as const;
const LEGACY_VAULT_NAME = "VAULT_NAME";
export interface ParseSheetOpts {
  /** The CLI verb (or the single follow-on stage, verify or govern) the sheet is parsed for. Absent: a deploy run, which refuses VAULT_NAME. */
  verb?: string;
  /** Receives the one warning when a follow-on verb drops a VAULT_NAME line. */
  warn?: (message: string, fields: Record<string, unknown>) => void;
  /** Issue 1842, test seam: the wall clock (ms since the epoch) the freeze deadline is compared with. Absent: Date.now(). */
  now?: () => number;
}

/** A follow-on verb drops VAULT_NAME with one warning naming its line. A deploy run keeps it, so checkNames refuses it with the issue 1705 reason. */
function dropLegacyVaultName(text: string, raw: Record<string, string>, o: ParseSheetOpts): void {
  if (!(LEGACY_VAULT_NAME in raw) || !(LEGACY_VAULT_NAME_VERBS as readonly string[]).includes(o.verb ?? "")) return;
  const line = text.replace(/^\uFEFF/, "").split(/\r?\n/).findIndex((l) => /^(?:export\s+)?VAULT_NAME=/.test(l.trim())) + 1;
  delete raw[LEGACY_VAULT_NAME];
  o.warn?.(`sheet line ${line}: VAULT_NAME is ignored by ${o.verb}. Every registry name is a vault stage script constant (issue 1705): delete the line before the next deploy run, which refuses it`, { name: LEGACY_VAULT_NAME, line, verb: o.verb });
}

function checkNames(raw: Record<string, string>): void {
  for (const name of Object.keys(raw)) {
    for (const [re, why] of REFUSED) if (re.test(name)) throw err(`${name} is refused: ${why}`, { name });
    if (!(name in SHEET_SPEC)) throw err(`${name} is not a sheet name (the sheet is a whitelist)`, { name });
  }
  const missing = REQUIRED_NAMES.filter((n) => !(n in raw) || raw[n] === "");
  if (missing.length) throw err(`the sheet is missing required names: ${missing.join(", ")}. Nothing has a default.`, { missing });
}

const asUint = (name: string, v: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(v)) throw err(`${name} must be a non-negative decimal integer, got '${v}'`, { name });
  return BigInt(v);
};
const asSafeInt = (name: string, v: string): number => {
  const n = asUint(name, v);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw err(`${name} is too large`, { name });
  return Number(n);
};
export function asAddress(name: string, v: string): Address {
  if (!isAddress(v, { strict: true })) throw err(`${name} is not a valid address (checksummed or all lowercase): '${v}'`, { name });
  const a = getAddress(v);
  if (/^0x0{40}$/.test(a)) throw err(`${name} is the zero address`, { name });
  return a;
}
const asList = (name: string, v: string): Address[] => {
  const parts = v.split(",").map((s) => s.trim());
  if (parts.some((p) => p === "")) throw err(`${name} has an empty entry`, { name });
  return parts.map((p) => asAddress(name, p));
};
const lc = (a: string) => a.toLowerCase();
function assertDistinct(label: string, entries: [string, string][]): void {
  const seen = new Map<string, string>();
  for (const [n, a] of entries) {
    const prev = seen.get(lc(a));
    if (prev) throw err(`${label}: ${n} and ${prev} are the same address ${a}`, { a: n, b: prev });
    seen.set(lc(a), n);
  }
}

/** "none" or a comma list of vault keys without a repeat. */
function asVaultKeys(name: string, v: string, allowNone = true): VaultKey[] {
  if (v === "none") { if (!allowNone) throw err(`${name} cannot be none`, { name }); return []; }
  const keys = v.split(",").map((s) => s.trim());
  const seen = new Set<string>();
  for (const k of keys) {
    if (!(VAULT_KEYS as readonly string[]).includes(k)) throw err(`${name}: '${k}' is not a vault key (${VAULT_KEYS.join(", ")})`, { name });
    if (seen.has(k)) throw err(`${name}: ${k} is listed twice`, { name });
    seen.add(k);
  }
  return keys as VaultKey[];
}

/** Parse and validate a sheet. Structure floors that hold on every chain live here. Chain-keyed floors live in floors.ts. */
export function parseSheet(text: string, opts: ParseSheetOpts = {}): Sheet {
  const raw = parseSheetText(text);
  dropLegacyVaultName(text, raw, opts);
  checkNames(raw);
  const v = raw;

  const chainId = asSafeInt("CHAIN_ID", v.CHAIN_ID!);
  const expectedChainId = asSafeInt("EXPECTED_CHAIN_ID", v.EXPECTED_CHAIN_ID!);
  if (chainId <= 0) throw err("CHAIN_ID must be positive");
  if (expectedChainId !== chainId) throw err(`EXPECTED_CHAIN_ID ${expectedChainId} differs from CHAIN_ID ${chainId}`);

  const kindRaw = v.DEPLOYMENT_KIND ?? "production";
  if (!(DEPLOYMENT_KINDS as readonly string[]).includes(kindRaw)) throw err(`DEPLOYMENT_KIND must be ${DEPLOYMENT_KINDS.join(" or ")}, got '${kindRaw}'. Production is the default when the line is absent.`, { name: "DEPLOYMENT_KIND" });
  const kind = kindRaw as DeploymentKind;

  const admin = asAddress("ADMIN_ADDRESS", v.ADMIN_ADDRESS!);
  const pauser = asAddress("PAUSER_ADDRESS", v.PAUSER_ADDRESS!);
  const emergency = asAddress("EMERGENCY_ADDRESS", v.EMERGENCY_ADDRESS!);
  const shareReceiver = asAddress("SHARE_RECEIVER_ADDRESS", v.SHARE_RECEIVER_ADDRESS!);
  const receiptAdmin = asAddress("RECEIPT_ADMIN_ADDRESS", v.RECEIPT_ADMIN_ADDRESS!);
  const safeOwners = asList("SAFE_OWNERS", v.SAFE_OWNERS!);
  const safeThreshold = asSafeInt("SAFE_THRESHOLD", v.SAFE_THRESHOLD!);
  if (v.SAFE_VERSION !== undefined && v.SAFE_VERSION !== "1.4.1") throw err(`SAFE_VERSION must be 1.4.1 (the only supported version), got '${v.SAFE_VERSION}'`);

  // The receipt contract's admin roles go to RECEIPT_ADMIN_ADDRESS at the ic-policy stage and the timelock stage revokes them with the
  // deployer's transaction (core: "the deployer until DeployTimelock hands it over"). Any other address leaves the timelock stage reverting
  // with AccessControlUnauthorizedAccount (found in the first Twin rehearsal), after the vaults are already deployed.
  if (lc(receiptAdmin) !== lc(admin)) throw err(`RECEIPT_ADMIN_ADDRESS ${receiptAdmin} must equal ADMIN_ADDRESS ${admin}: the deployer holds the receipt roles until the timelock stage revokes them`);
  // roles and owners: pairwise distinct on every chain (plan, Parameters)
  assertDistinct("roles", [["ADMIN_ADDRESS", admin], ["PAUSER_ADDRESS", pauser], ["EMERGENCY_ADDRESS", emergency]]);
  assertDistinct("Safe owners", safeOwners.map((a, i) => [`SAFE_OWNERS[${i}]`, a]));
  const roleSet = new Map<string, string>([[lc(admin), "ADMIN_ADDRESS"], [lc(pauser), "PAUSER_ADDRESS"], [lc(emergency), "EMERGENCY_ADDRESS"]]);
  for (const o of safeOwners) { const r = roleSet.get(lc(o)); if (r) throw err(`Safe owner ${o} is also ${r}: signers are separate from the deployer and the operational keys`); }
  // Safe structure floor, every chain
  const n = safeOwners.length;
  if (n < 3) throw err(`a Safe needs at least 3 owners (got ${n}): threshold from 2 to N-1`);
  if (safeThreshold < 2 || safeThreshold > n - 1) throw err(`SAFE_THRESHOLD ${safeThreshold} must be from 2 to ${n - 1} for ${n} owners`);

  // Principle 12: USDC is a constant on every chain, never a free choice of the sheet. The example sheet has no USDC_ADDRESS line. A sheet
  // that still carries one must name the constant: any other value is refused.
  if (v.USDC_ADDRESS !== undefined && lc(asAddress("USDC_ADDRESS", v.USDC_ADDRESS)) !== lc(USDC_ADDRESS)) throw err(`USDC_ADDRESS must be ${USDC_ADDRESS} on every chain (the Base USDC), got ${v.USDC_ADDRESS}`);
  const usdc = USDC_ADDRESS as Address;
  const swapRouter = asAddress("SWAP_ROUTER", v.SWAP_ROUTER!);
  const feeRecipient: Address | "@safe" = v.FEE_RECIPIENT_ADDRESS === "@safe" ? "@safe" : asAddress("FEE_RECIPIENT_ADDRESS", v.FEE_RECIPIENT_ADDRESS!);
  if (feeRecipient !== "@safe" && lc(feeRecipient) === lc(admin)) throw err("FEE_RECIPIENT_ADDRESS equals ADMIN_ADDRESS (the deployer): the fee recipient is never the deployer. Use the treasury Safe, @safe or another treasury address");
  const seedDeposit = asUint("SEED_DEPOSIT_USDC", v.SEED_DEPOSIT_USDC!);
  if (seedDeposit === 0n) throw err("SEED_DEPOSIT_USDC must be above 0 (rmUSDC seed)");

  const timelockMinDelay = asUint("TIMELOCK_MIN_DELAY", v.TIMELOCK_MIN_DELAY!);
  if (timelockMinDelay < 1n) throw err("TIMELOCK_MIN_DELAY must be at least 1 second on every chain");
  if (kind === "rehearsal") {
    // issue 1727: the delay on chain must agree with the kind, so a rehearsal can never be mistaken for production (and the reverse)
    const why = rehearsalDelayProblem(timelockMinDelay);
    if (why) throw err(`TIMELOCK_MIN_DELAY ${why} (DEPLOYMENT_KIND=rehearsal)`, { name: "TIMELOCK_MIN_DELAY" });
    // a rehearsal reuses the first rehearsal's keys, so the same owners and threshold would predict the Safe that already exists: a new salt is always explicit
    if (v.SAFE_SALT_NONCE === undefined || v.SAFE_SALT_NONCE === "") throw err("DEPLOYMENT_KIND=rehearsal needs an explicit SAFE_SALT_NONCE: the same owners, threshold and salt predict a Safe that may already exist. Choose a salt no earlier run used.", { name: "SAFE_SALT_NONCE" });
  }

  // Issue 1842: a deploy run refuses a freeze deadline the Safe could not meet (a follow-on verb runs against a deployment whose deadline was checked when it deployed,
  // and verify reports the deadline itself, so verify, govern and pause-all keep working as the deadline approaches).
  const upgrade = parseUpgrade(v, chainId, kind, (LEGACY_VAULT_NAME_VERBS as readonly string[]).includes(opts.verb ?? "") || opts.verb === "redeploy-vault" ? undefined : { minDelay: timelockMinDelay, nowMs: (opts.now ?? Date.now)() });

  const vaults = {} as Record<VaultKey, SheetVault>;
  for (const k of VAULT_KEYS) {
    const [t, p, f] = vaultSheetNames(k) as [string, string, string];
    const tvlCap = asUint(t, v[t]!), perDepositCap = asUint(p, v[p]!), exitFeeBps = asUint(f, v[f]!);
    // caps floor, every chain: 0 is not "no cap" here, the first period runs on low explicit caps
    if (tvlCap === 0n) throw err(`${t} must be above 0: a zero TVL cap is refused`);
    if (perDepositCap > tvlCap) throw err(`${p} exceeds ${t}: the per-deposit cap is never above the TVL cap`);
    if (exitFeeBps > 10000n) throw err(`${f} is above 10000`);
    const vault: SheetVault = { tvlCap, perDepositCap, exitFeeBps };
    if (k !== "USDC") {
      const [g, l] = basketSheetNames(k) as [string, string];
      const nav = asUint(g, v[g]!), floor = asUint(l, v[l]!);
      // issue 1666: 0 disables ORA-4 (BasketViews.checkNavDeviation), above 2000 is refused by the vault setter. Refuse both before any transaction.
      if (nav === 0n) throw err(`${g} must be above 0: a zero NAV deviation guard disables the ORA-4 deposit check`, { name: g });
      if (nav > MAX_NAV_DEVIATION_BPS) throw err(`${g} is above ${MAX_NAV_DEVIATION_BPS} bps (20 percent): the value is in basis points`, { name: g });
      if (floor === 0n) throw err(`${l} must be above 0: a zero pool liquidity floor accepts an empty pool`, { name: l });
      if (floor > MAX_POOL_LIQUIDITY) throw err(`${l} exceeds uint128: it is a Uniswap V3 liquidity value, not a USDC amount`, { name: l });
      vault.navDeviationBps = nav; vault.minPoolLiquidity = floor;
    }
    vaults[k] = vault;
  }

  // deploy-time router configuration
  const eligibleVaults = asVaultKeys("ELIGIBLE_VAULTS", v.ELIGIBLE_VAULTS!);
  if (eligibleVaults.includes("USDC")) throw err("ELIGIBLE_VAULTS lists baskets only: rmUSDC is eligible from the router stage");
  // govern matrix inputs
  const unpauseVaults = asVaultKeys("GOVERN_UNPAUSE_VAULTS", v.GOVERN_UNPAUSE_VAULTS!);
  // issue 1520 (amended 2026-10-06, rmUSDC added 2026-10-09 by issue 1710): no stage 13 step may be skipped on a mainnet deploy. A vault left out would stay paused.
  if (chainId === MAINNET_CHAIN_ID) {
    // The stage 13 vaults are the stage table's vault rules (unpauseInStage13, issue 1705).
    const missing = STAGE13_UNPAUSE_VAULTS.filter((k) => !unpauseVaults.includes(k));
    if (missing.length > 0) throw err(`GOVERN_UNPAUSE_VAULTS must list ${STAGE13_UNPAUSE_VAULTS.join(", ")} on chain 8453: no stage 13 step may be skipped (missing ${missing.join(", ")})`, { name: "GOVERN_UNPAUSE_VAULTS" });
  }
  const weights = parseWeights(v.ROUTER_WEIGHTS!);
  const weightKeys = weights.map((w) => w.key).sort().join(",");
  const wantKeys = ["USDC", ...eligibleVaults].sort().join(",");
  if (weightKeys !== wantKeys) throw err(`ROUTER_WEIGHTS must name exactly rmUSDC and the eligible baskets (${wantKeys}), got ${weightKeys}`);
  // issue 1580 (owner amendment 2026-10-06 on the stage 13 issue): mainnet launches on exactly this vector. Twin sheets keep their own weights.
  if (chainId === MAINNET_CHAIN_ID) {
    const got = weights.map((w) => `${w.key}:${w.bps}`).sort().join(",");
    if (got !== LAUNCH_ROUTER_WEIGHTS_8453) throw err(`ROUTER_WEIGHTS must be the launch vector on chain 8453 (USDC:9500,PROTO:500,AGENT:0,RWA:0, every vault named), got ${v.ROUTER_WEIGHTS}`, { name: "ROUTER_WEIGHTS" });
  }
  const newDelay = asUint("GOVERN_NEW_DELAY", v.GOVERN_NEW_DELAY!);
  const newDelayMin = kind === "rehearsal" ? BigInt(REHEARSAL_DELAY_FLOOR) : 3600n;
  if (newDelay < newDelayMin || newDelay > 2592000n) throw err(`GOVERN_NEW_DELAY must be from ${newDelayMin} to 2592000 seconds (the Safe tool's updateDelay bounds${kind === "rehearsal" ? " in a rehearsal" : ""})`);
  if (kind === "rehearsal") {
    const why = rehearsalDelayProblem(newDelay);
    if (why) throw err(`GOVERN_NEW_DELAY ${why} (DEPLOYMENT_KIND=rehearsal)`, { name: "GOVERN_NEW_DELAY" });
  }

  const values: Record<string, string> = {};
  for (const [k, val] of Object.entries(raw)) values[k] = SHEET_SPEC[k]!.kind.startsWith("address") && val !== "@safe" && !val.includes(",") ? getAddress(val) : val;

  return {
    values, chainId, expectedChainId, kind, admin, pauser, emergency, shareReceiver, receiptAdmin, safeOwners, safeThreshold,
    safeSalt: v.SAFE_SALT_NONCE, usdc, swapRouter, feeRecipient, seedDeposit, timelockMinDelay, upgrade, vaults,
    eligibleVaults, weights, govern: { unpauseVaults, newDelay },
  };
}

const DEADLINE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
/**
 * Issue 1809. UPGRADE_MODE is required and is one of the two words. An upgradeable PRODUCTION release on 8453 is the proving period: it needs UPGRADE_FREEZE_DEADLINE, the
 * time by which the Safe signers have frozen every proxy. A frozen release has nothing to freeze later, so a deadline there is refused as a contradiction.
 */
export function parseUpgrade(v: Record<string, string | undefined>, chainId: number, kind: DeploymentKind, deadlineCheck?: { minDelay: bigint; nowMs: number }): Sheet["upgrade"] {
  const mode = v.UPGRADE_MODE ?? "";
  if (!(UPGRADE_MODES as readonly string[]).includes(mode)) throw err(`UPGRADE_MODE must be ${UPGRADE_MODES.join(" or ")}, got '${mode}'. There is no default: the release mode of every core proxy is declared (docs/technical/contract-upgradeability-plan.md, Release modes).`, { name: "UPGRADE_MODE" });
  const raw = v.UPGRADE_FREEZE_DEADLINE;
  if (raw === undefined || raw === "") {
    if (mode === "upgradeable" && chainId === MAINNET_CHAIN_ID && kind === "production") throw err("UPGRADE_MODE=upgradeable on a production release on chain 8453 is the proving period: UPGRADE_FREEZE_DEADLINE (ISO 8601 UTC, for example 2027-01-31T00:00:00Z) names when the Safe signers have frozen every proxy", { name: "UPGRADE_FREEZE_DEADLINE" });
    return { mode: mode as UpgradeMode };
  }
  if (mode === "frozen") throw err("UPGRADE_FREEZE_DEADLINE is set but UPGRADE_MODE is frozen: every proxy is frozen in its initializer, there is nothing to freeze later. Delete the line", { name: "UPGRADE_FREEZE_DEADLINE" });
  const m = DEADLINE.exec(raw);
  const t = m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : Number.NaN;
  if (!m || Number.isNaN(t) || new Date(t).toISOString().replace(".000Z", "Z") !== raw) throw err(`UPGRADE_FREEZE_DEADLINE must be an ISO 8601 UTC time such as 2027-01-31T00:00:00Z, got '${raw}'`, { name: "UPGRADE_FREEZE_DEADLINE" });
  if (deadlineCheck) {
    // Issue 1842: the freeze is one Safe round through the timelock, so it needs TIMELOCK_MIN_DELAY plus a day of signer time before the deadline. A deadline sooner
    // than that is refused now, before any stage broadcasts, instead of failing verify after the whole deployment ran.
    const earliest = deadlineCheck.nowMs + Number(deadlineCheck.minDelay) * 1000 + 86_400_000;
    if (t < earliest) throw err(`UPGRADE_FREEZE_DEADLINE ${raw} is ${t <= deadlineCheck.nowMs ? "in the past" : "too near"}: it must be no earlier than now + TIMELOCK_MIN_DELAY (${deadlineCheck.minDelay} s) + 1 day, ${new Date(earliest).toISOString().replace(/\.\d{3}Z$/, "Z")}, so the Safe can schedule and execute the freeze in time`, { name: "UPGRADE_FREEZE_DEADLINE" });
  }
  return { mode: mode as UpgradeMode, freezeDeadline: raw };
}

const LAUNCH_ROUTER_WEIGHTS_8453 = ["USDC:9500", "PROTO:500", "AGENT:0", "RWA:0"].sort().join(",");

/** "USDC:6000,PROTO:3000,RWA:1000": every key once, bps sum 10000. */
export function parseWeights(text: string): { key: VaultKey; bps: number }[] {
  const out = text.split(",").map((p) => {
    const m = /^\s*([A-Z]+):([0-9]+)\s*$/.exec(p);
    if (!m || !(VAULT_KEYS as readonly string[]).includes(m[1]!)) throw err(`ROUTER_WEIGHTS entry '${p}' is not KEY:bps with a vault key`);
    return { key: m[1] as VaultKey, bps: Number(m[2]) };
  });
  if (new Set(out.map((o) => o.key)).size !== out.length) throw err("ROUTER_WEIGHTS lists a vault twice");
  if (out.reduce((a, b) => a + b.bps, 0) !== 10000) throw err("ROUTER_WEIGHTS must sum to 10000 bps");
  return out;
}

/** YES and CONFIRM exist only in the caller environment. */
export interface CallerInputs { yes: boolean; confirm: "typed" | "environment" }
export function callerInputs(env: Record<string, string | undefined>): CallerInputs {
  const c = env.CONFIRM ?? "typed";
  if (c !== "typed" && c !== "environment") throw new PublishError("USAGE", `CONFIRM must be 'typed' or 'environment', got '${c}'`);
  return { yes: env.YES === "1", confirm: c };
}

export interface SheetDiffRow { name: string; a: string | undefined; b: string | undefined }
/** Names whose values differ between two sheets. Part of the isomorphism report. */
export function diffSheets(a: Sheet, b: Sheet): SheetDiffRow[] {
  const names = [...new Set([...Object.keys(a.values), ...Object.keys(b.values)])].sort();
  return names.filter((n) => a.values[n] !== b.values[n]).map((name) => ({ name, a: a.values[name], b: b.values[name] }));
}

/** The baskets the sheet makes eligible, in migration order. The default-weight vector grows in this order. */
export const eligibleInOrder = (sheet: Pick<Sheet, "eligibleVaults">): VaultKey[] => BASKET_KEYS.filter((k) => sheet.eligibleVaults.includes(k));

/**
 * The default-weight vector (bps) right after the eligibility flip of `basket`: rmUSDC, then the eligible baskets up to and including this one.
 * The flip of the last eligible basket is exactly the sheet's weights. Earlier flips are the sheet weights scaled to 10000 (equal if all zero).
 * `undefined` when the sheet does not make this basket eligible.
 */
export function eligibilityBps(sheet: Pick<Sheet, "eligibleVaults" | "weights">, basket: VaultKey): number[] | undefined {
  const eligible = eligibleInOrder(sheet);
  const step = eligible.indexOf(basket);
  if (step < 0) return undefined;
  const keys = (["USDC", ...eligible] as VaultKey[]).slice(0, step + 2);
  const w = new Map(sheet.weights.map((x) => [x.key, x.bps]));
  const final = keys.map((k) => w.get(k) ?? 0);
  if (step === eligible.length - 1) return final;
  const sum = final.reduce((x, y) => x + y, 0);
  const bps = sum === 0 ? keys.map((_, i) => Math.floor(10000 / keys.length) + (i === 0 ? 10000 % keys.length : 0)) : final.map((x) => Math.floor((x * 10000) / sum));
  bps[0] = bps[0]! + (10000 - bps.reduce((x, y) => x + y, 0));
  return bps;
}
