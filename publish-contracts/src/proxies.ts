// The governed proxies of a deployment (ADR-0014, issue 1809): what the deploy tooling reads from a proxy and what it must find there.
// One module for the three readers: the runner's gate right after a proxy stage (refuses the run before the next stage), the stage 12 verifier
// (one label per property, verify/index.ts) and the upgrade and freeze govern rows (upgrade-rows.ts). It reads only; it sends nothing.
//   - The ERC-1967 implementation slot names the implementation the stage manifest (or the last executed upgrade) names.
//   - The ERC-1967 admin and beacon slots are empty: no ProxyAdmin, no beacon (ADR-0014 §3). A non-zero admin slot is refused, never explained away.
//   - upgradeAuthority() is the authority stage's timelock, the manifest's upgrade_mode is the sheet's UPGRADE_MODE, and upgradesFrozen() is true exactly when
//     the mode is frozen-at-deploy or an executed freeze row froze the proxy. An undeclared mode (missing, `unset`, anything else) is refused.
//   - The proxy is initialized (OZ Initializable version 1 or more, not initializing) and the implementation's own initializers are locked
//     (_disableInitializers: version type(uint64).max).
import { keccak256, type Address, type Hex } from "viem";
import { PROXY_MANIFEST_FIELDS, tableProxies, type StageTable, type TableProxy } from "./stage-table.ts";
import { UPGRADE_MODES, type UpgradeMode } from "./sheet.ts";
import type { ChainReader } from "./verify/types.ts";

/** bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1) */
export const ERC1967_IMPLEMENTATION_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/** bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1): stays zero on every Robot Money proxy (no ProxyAdmin). */
export const ERC1967_ADMIN_SLOT: Hex = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
/** bytes32(uint256(keccak256("eip1967.proxy.beacon")) - 1): stays zero on every Robot Money proxy (no beacon). */
export const ERC1967_BEACON_SLOT: Hex = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
/** OZ 5 Initializable, ERC-7201 namespace `openzeppelin.storage.Initializable`: uint64 _initialized (low 8 bytes), bool _initializing (next byte). */
export const INITIALIZABLE_SLOT: Hex = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";
/** GovernedUpgrade, ERC-7201 namespace `robotmoney.storage.GovernedUpgrade` (ADR-0014 §3): address authority (low 20 bytes), bool frozen (next byte). */
export const GOVERNED_UPGRADE_SLOT: Hex = "0x5f8c19f69998101f56563e0013e2ccd167eee33eac647374045191b3bd187600";
/** `_disableInitializers()` sets the version to type(uint64).max. */
export const INITIALIZERS_LOCKED = (1n << 64n) - 1n;
export const ZERO_WORD: Hex = `0x${"00".repeat(32)}`;

export const UPGRADE_AUTHORITY_SIG = "function upgradeAuthority() view returns (address)";
export const UPGRADES_FROZEN_SIG = "function upgradesFrozen() view returns (bool)";
export const PROXIABLE_UUID_SIG = "function proxiableUUID() view returns (bytes32)";

const lc = (s: string): string => s.toLowerCase();
/** The address in the low 20 bytes of a storage word. */
export const wordAddress = (w: Hex): Address => (`0x${w.replace(/^0x/, "").padStart(64, "0").slice(24)}`) as Address;
const wordBig = (w: Hex): bigint => BigInt(w === "0x" ? 0 : w);
/** OZ Initializable: the version and the initializing flag a storage word holds. */
export function initializableOf(w: Hex): { version: bigint; initializing: boolean } {
  const v = wordBig(w);
  return { version: v & INITIALIZERS_LOCKED, initializing: ((v >> 64n) & 0xffn) !== 0n };
}
const isZeroWord = (w: Hex): boolean => wordBig(w) === 0n;

/** What the chain says about one proxy. `null`: the call reverted or the read failed (a proxy without GovernedUpgrade reads null). */
export interface ProxyState {
  proxy: Address;
  proxyCode: Hex;
  /** The ERC-1967 implementation slot, as an address. */
  implementation: Address;
  implementationCode: Hex;
  adminSlot: Hex;
  beaconSlot: Hex;
  authority: Address | null;
  frozen: boolean | null;
  /** The proxy's Initializable version and flag. */
  initialized: { version: bigint; initializing: boolean };
  /** The implementation's own Initializable version: INITIALIZERS_LOCKED after `_disableInitializers()`. */
  implementationInitialized: { version: bigint; initializing: boolean };
}

/** The reads one proxy needs, through the verifier's read-only chain surface. */
export async function readProxyState(chain: Pick<ChainReader, "getCode" | "getStorageAt" | "read">, proxy: Address): Promise<ProxyState> {
  const [proxyCode, implWord, adminSlot, beaconSlot, initWord] = await Promise.all([
    chain.getCode(proxy), chain.getStorageAt(proxy, ERC1967_IMPLEMENTATION_SLOT), chain.getStorageAt(proxy, ERC1967_ADMIN_SLOT),
    chain.getStorageAt(proxy, ERC1967_BEACON_SLOT), chain.getStorageAt(proxy, INITIALIZABLE_SLOT),
  ]);
  const implementation = wordAddress(implWord);
  const [implementationCode, implInitWord] = await Promise.all([chain.getCode(implementation), chain.getStorageAt(implementation, INITIALIZABLE_SLOT)]);
  const opt = async <T>(f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch { return null; } };
  const authority = await opt(async () => (await chain.read(proxy, UPGRADE_AUTHORITY_SIG)) as Address);
  const frozen = await opt(async () => (await chain.read(proxy, UPGRADES_FROZEN_SIG)) as boolean);
  return { proxy, proxyCode, implementation, implementationCode, adminSlot, beaconSlot, authority, frozen, initialized: initializableOf(initWord), implementationInitialized: initializableOf(implInitWord) };
}

/** The runtime code hash `freezeUpgrades` binds to: keccak256 of the live implementation's code (EXTCODEHASH). */
export const codeHashOf = (code: Hex): Hex => keccak256(code);

/** One proxy as the deploy manifests name it. */
export interface ManifestProxy {
  name: string;
  /** The stage that deployed it and the build artifact of its implementation. */
  stage: string;
  artifact: string;
  proxy: Address | undefined;
  implementation: Address | undefined;
  /** `upgrade_authority` and `upgrade_mode` of the proxy's stage manifest, exactly as written. */
  manifestAuthority: string | undefined;
  manifestMode: string | undefined;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const asAddr = (v: unknown): Address | undefined => (typeof v === "string" && ADDR.test(v) ? (v as Address) : undefined);

/** The table's proxies with what the stage manifests say about each. `files`: the parsed stage manifests keyed by file base name (verify/manifests.ts). */
export function manifestProxies(table: StageTable, files: Record<string, any>, manifestOf: (stage: string) => string): ManifestProxy[] {
  return tableProxies(table).map((p: TableProxy) => {
    const m = files[manifestOf(p.stage)] ?? {};
    return {
      name: p.name, stage: p.stage, artifact: p.artifact, proxy: asAddr(m[p.field]), implementation: asAddr(m[p.implementationField]),
      manifestAuthority: typeof m[PROXY_MANIFEST_FIELDS.authority] === "string" ? m[PROXY_MANIFEST_FIELDS.authority] : undefined,
      manifestMode: typeof m[PROXY_MANIFEST_FIELDS.mode] === "string" ? m[PROXY_MANIFEST_FIELDS.mode] : undefined,
    };
  });
}

/** What a proxy must read. `implementation`: the manifest's, or the target of the last executed upgrade row. `frozen`: the mode, or an executed freeze row. */
export interface ProxyWant {
  name: string;
  implementation: Address;
  /** The authority stage's timelock. */
  authority: Address;
  /** The sheet's UPGRADE_MODE. Undefined: the sheet states none, which is refused. */
  mode: UpgradeMode | undefined;
  /** True when an executed freeze row froze this proxy after its deploy. */
  frozenByRow: boolean;
}

export const isUpgradeMode = (v: unknown): v is UpgradeMode => typeof v === "string" && (UPGRADE_MODES as readonly string[]).includes(v);
/** upgradesFrozen() must read this: frozen at deploy, or frozen later by the freeze row. */
export const expectFrozen = (w: Pick<ProxyWant, "mode" | "frozenByRow">): boolean => w.mode === "frozen-at-deploy" || w.frozenByRow;

/** Each property of one proxy, as a named problem or undefined. The verifier labels these one by one; the runner gate refuses on any. */
export interface ProxyChecks {
  implementationSlot: string | undefined;
  adminSlot: string | undefined;
  beaconSlot: string | undefined;
  initialized: string | undefined;
  authority: string | undefined;
  mode: string | undefined;
  frozen: string | undefined;
}

export function proxyChecks(s: ProxyState, w: ProxyWant, m: Pick<ManifestProxy, "manifestMode" | "manifestAuthority">): ProxyChecks {
  const modeProblems: string[] = [];
  if (!isUpgradeMode(w.mode)) modeProblems.push(`the sheet states no UPGRADE_MODE (${UPGRADE_MODES.join(" or ")}): an undeclared mode is refused`);
  if (!isUpgradeMode(m.manifestMode)) modeProblems.push(`the stage manifest's ${PROXY_MANIFEST_FIELDS.mode} is ${JSON.stringify(m.manifestMode ?? null)}, not a declared mode (${UPGRADE_MODES.join(" or ")})`);
  else if (isUpgradeMode(w.mode) && m.manifestMode !== w.mode) modeProblems.push(`the stage manifest's ${PROXY_MANIFEST_FIELDS.mode} is ${m.manifestMode}, the sheet states ${w.mode}`);
  if (m.manifestAuthority !== undefined && lc(m.manifestAuthority) !== lc(w.authority)) modeProblems.push(`the stage manifest's ${PROXY_MANIFEST_FIELDS.authority} is ${m.manifestAuthority}, the authority stage deployed ${w.authority}`);
  if (m.manifestAuthority === undefined) modeProblems.push(`the stage manifest has no ${PROXY_MANIFEST_FIELDS.authority}`);
  const init: string[] = [];
  if (s.initialized.version === 0n || s.initialized.initializing) init.push(`the proxy's Initializable reads version ${s.initialized.version}${s.initialized.initializing ? ", initializing" : ""}: it is not initialized`);
  if (s.implementationInitialized.version !== INITIALIZERS_LOCKED) init.push(`the implementation ${s.implementation} reads Initializable version ${s.implementationInitialized.version}, not ${INITIALIZERS_LOCKED} (_disableInitializers): anyone could initialize it`);
  const wantFrozen = expectFrozen(w);
  return {
    implementationSlot: lc(s.implementation) === lc(w.implementation) ? undefined : `the ERC-1967 implementation slot of ${s.proxy} reads ${s.implementation}, want ${w.implementation}`,
    adminSlot: isZeroWord(s.adminSlot) ? undefined : `the ERC-1967 admin slot of ${s.proxy} is not empty (it names ${wordAddress(s.adminSlot)}): a Robot Money proxy has no admin (ADR-0014 §3), refused`,
    beaconSlot: isZeroWord(s.beaconSlot) ? undefined : `the ERC-1967 beacon slot of ${s.proxy} is not empty (it names ${wordAddress(s.beaconSlot)}): a Robot Money proxy has no beacon (ADR-0014 §3), refused`,
    initialized: init.length ? init.join("; ") : undefined,
    authority: s.authority !== null && lc(s.authority) === lc(w.authority) ? undefined : `upgradeAuthority() of ${s.proxy} reads ${s.authority ?? "nothing (the call reverted: no GovernedUpgrade)"}, want the authority stage's timelock ${w.authority}`,
    mode: modeProblems.length ? modeProblems.join("; ") : undefined,
    frozen: s.frozen === wantFrozen ? undefined : `upgradesFrozen() of ${s.proxy} reads ${s.frozen ?? "nothing (the call reverted)"}, want ${wantFrozen} (UPGRADE_MODE ${w.mode ?? "undeclared"}${w.frozenByRow ? ", frozen by an executed freeze-proxy row" : ""})`,
  };
}

/** Every problem of one proxy, in a fixed order. Empty: the proxy is what the deploy declared. */
export const proxyProblems = (c: ProxyChecks): string[] => [c.implementationSlot, c.adminSlot, c.beaconSlot, c.initialized, c.authority, c.mode, c.frozen].filter((x): x is string => x !== undefined);

/**
 * The evidence record of one proxy (the verify stage record and the runner's stage record). Addresses, flags and hashes only: no secret. Every 32-byte value sits under a
 * hash-named key, so the evidence secret scan (evidence-check.ts scanEvidenceFolder) reads it as public; the ERC-1967 admin and beacon slots are recorded as the address
 * each names and whether the whole word is zero, never as a raw word.
 */
export interface ProxyRecord {
  name: string;
  proxy: Address;
  implementation: Address;
  /** keccak256 of the implementation's runtime code (the hash freezeUpgrades binds to). */
  implementation_code_hash: Hex;
  /** keccak256 of the proxy's runtime code (one value for every proxy: the ERC1967Proxy build). */
  proxy_code_hash: Hex;
  authority: Address | null;
  mode: string | null;
  frozen: boolean | null;
  /** The ERC-1967 admin and beacon slots: empty on every Robot Money proxy (ADR-0014 §3). */
  admin_slot_empty: boolean;
  beacon_slot_empty: boolean;
  /**
   * ADR-0014 §8: the storage-layout identifier, 0x + sha256 of the normalized layout snapshot of the implementation's contract
   * (contracts/test/fixtures/storage-layout/<Artifact>.json). The deploy manifest's `<field>_layout_id` when the stage recorded one and no executed upgrade
   * replaced that implementation since (`layout_source: "deploy-manifest"`), else the checkout's snapshot (`"checkout"`).
   */
  layout_hash?: Hex;
  /** Where `layout_hash` came from. */
  layout_source?: "deploy-manifest" | "checkout";
  /** 0x + sha256 of the checkout's snapshot, the layout the build this verify compared with has. */
  checkout_layout_hash?: Hex;
}

/** ADR-0014 §8 (issue 1809): the stage-manifest field of a proxy's storage-layout identifier, next to its implementation field. */
export const layoutIdFieldOf = (p: Pick<TableProxy, "implementationField">): string => p.implementationField.replace(/_implementation$/, "_layout_id");

/**
 * ADR-0014 §5: what stays mutable after every proxy is frozen. A release may call its core logic immutable only when all of its proxies read frozen, and even then
 * these stay mutable by their own authorities. The verify record lists them next to the freeze state (`immutability`), and evidence-check refuses an
 * `immutability_claim` the proxies do not support.
 */
export const STILL_MUTABLE_AFTER_FREEZE = {
  governed_parameters: [
    "vault fees and caps: exitFeeBps, feeRecipient, tvlCap, perDepositCap (ADMIN_ROLE: the timelock)",
    "rmUSDC adapters: adapter and code-hash allowlists, addAdapter/removeAdapter, adapter caps, rebalance bounds (ADMIN_ROLE), emergency drains (EMERGENCY_ROLE)",
    "basket assets and pricing: addAsset/removeAsset, maxSlippageBps, TWAP windows, navDeviationGuardBps, emergency unwind guards (ADMIN_ROLE), emergencyUnwind (EMERGENCY_ROLE)",
    "deposit pauses: vault pauseDeposits/shutdownVault (EMERGENCY_ROLE), gateway pauseDeposits (DEPOSIT_PAUSER_ROLE); unpause and restore (ADMIN_ROLE). Withdrawals never pause.",
    "router weights and caps: setWeights through RouterGovernance.applyReceipt (WEIGHT_SETTER_ROLE), default weights, router and vault caps, clearVotedWeights (ADMIN_ROLE)",
    "registry: vault status, router eligibility, retire (ADMIN_ROLE)",
    "gateway: agent policies (each agent's owner), IC policy and receipt pointers (ADMIN_ROLE)",
    "committee: IC roster (ADMIN_ROLE), receipt release (ADMIN_ROLE)",
    "roles themselves: every role above is granted and revoked by its admin role (the timelock); the timelock's proposer set rotates through its own delay",
  ],
  upstream_dependencies: [
    "USDC (Circle FiatTokenProxy, upgradeable and pausable by Circle)",
    "Aave V3 pool, Compound V3 Comet and Morpho / Moonwell MetaMorpho vaults behind the rmUSDC adapters",
    "Uniswap V3 SwapRouter02 and pools, Uniswap V4 PoolManager and pools, Aerodrome router and pools behind the basket venues",
    "the Safe (SafeL2 1.4.1 singleton and its owner set) and the ProposerFloorTimelock that govern every parameter above",
  ],
} as const;

/** The immutability statement of a deployment from its proxy records: core logic is immutable only when every proxy reads frozen. */
export function immutabilityOf(records: readonly Pick<ProxyRecord, "name" | "frozen">[], names: readonly string[]): {
  core_logic_immutable: boolean;
  frozen: string[];
  upgradeable: string[];
  still_mutable: typeof STILL_MUTABLE_AFTER_FREEZE;
} {
  const frozen = names.filter((n) => records.find((r) => r.name === n)?.frozen === true);
  const upgradeable = names.filter((n) => !frozen.includes(n));
  return { core_logic_immutable: names.length > 0 && upgradeable.length === 0, frozen, upgradeable, still_mutable: STILL_MUTABLE_AFTER_FREEZE };
}

export const proxyRecordOf = (name: string, s: ProxyState, mode: string | undefined): ProxyRecord => ({
  name, proxy: s.proxy, implementation: s.implementation, implementation_code_hash: codeHashOf(s.implementationCode), proxy_code_hash: codeHashOf(s.proxyCode),
  authority: s.authority, mode: mode ?? null, frozen: s.frozen, admin_slot_empty: isZeroWord(s.adminSlot), beacon_slot_empty: isZeroWord(s.beaconSlot),
});
