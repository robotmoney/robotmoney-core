// Upgradeability stage 2 (issue 1809): the proof that every proxied core contract is the build's ERC-1967 proxy, initialized once, governed by the deployed timelock
// alone, in the release mode the sheet declares, and the record of what was proven (`upgradeability.json`, the evidence `upgradeability` section).
// Canonical: docs/technical/contract-upgradeability-plan.md (Release modes and proof), docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md,
// docs/operations/contract-release-runbooks.md 4.12. Read-only: it sends nothing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { concatHex, decodeAbiParameters, keccak256, toFunctionSelector, toHex } from "viem";
import type { Collector } from "./collector.ts";
import { ERC1967_IMPLEMENTATION_SLOT, ERC1967_PROXY_ARTIFACT, compareCode, isProxyCode, linkedLibraries, loadArtifact, tryLoadArtifact } from "./codehash.ts";
import { coreContractRefs } from "../core-wiring.ts";
import { MAINNET_CHAIN_ID } from "../chains.ts";
import { vaultDisplayName, type UpgradeMode } from "../sheet.ts";
import { manifestBase, type StageTable } from "../stage-table.ts";
import { isAddress, lc, type ManifestVault } from "./manifests.ts";
import { padTopic, scanLogs } from "./logs.ts";
import type { Address, ChainReader, Hex, VerifySheet } from "./types.ts";

/** ERC-1967 admin slot: keccak256("eip1967.proxy.admin") - 1. A UUPS proxy has no admin. */
export const ERC1967_ADMIN_SLOT: Hex = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
/** ERC-1967 beacon slot: keccak256("eip1967.proxy.beacon") - 1. A per-instance proxy has no beacon. */
export const ERC1967_BEACON_SLOT: Hex = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
/** OpenZeppelin Initializable v5 storage (erc7201:openzeppelin.storage.Initializable): uint64 _initialized, then bool _initializing (contracts/lib/GovernedUUPS.sol). */
export const INITIALIZABLE_SLOT: Hex = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";

/**
 * What a freeze does NOT make immutable (docs/technical/contract-upgradeability-plan.md: "Freeze is per proxy, not a claim that all system behavior is immutable").
 * Each entry names the governed lever, the contract it lives on and who moves it. The record and the evidence carry the whole list.
 */
export const GOVERNED_PARAMETERS: readonly string[] = [
  "vault caps (tvlCap, perDepositCap), exitFeeBps and feeRecipient on every vault: ADMIN_ROLE, the Safe through the timelock",
  "rmUSDC strategy adapters, their caps and the adapter and code-hash allowlists: ADMIN_ROLE, the Safe through the timelock",
  "basket asset config, swap adapters, maxSlippageBps and navDeviationGuardBps: ADMIN_ROLE, the Safe through the timelock",
  "router weights: RouterGovernance.applyReceipt (a consensus receipt the Safe applies through the timelock)",
  "router eligibility, vault registration and retirement on the VaultRegistry: ADMIN_ROLE, the Safe through the timelock",
  "the router weight setter (WEIGHT_SETTER_ROLE): rotated by the Safe and executed by the timelock",
  "deposit pauses: the pauser key (gateway DEPOSIT_PAUSER_ROLE) and the emergency key (vault EMERGENCY_ROLE levers) with no timelock, unpauses through the timelock",
  "consensus receipt authority: the receipt submitter role (RECEIPT_SUBMITTER_ROLE) and the release role (RECEIPT_RELEASER_ROLE), both granted by the timelock (ADMIN_ROLE)",
  "the timelock delay and its proposers: TimelockController self-administration by the Safe (updateDelay, grantRole)",
  "depositor agent authorizations on the gateway: each depositor's own commitAuthorization and revealAuthorization",
];

/**
 * HISTORICAL entries of GOVERNED_PARAMETERS, keyed by the entry that replaced them. A record written before the replacement carries the old wording, which names a larger lever set,
 * so it still lists the lever. Issue 1988 removed the router's clear of its applied vector: records of a deployment with that function (Deploy 3) name it.
 */
export const GOVERNED_PARAMETER_HISTORY: Readonly<Record<string, readonly string[]>> = {
  "router weights: RouterGovernance.applyReceipt (a consensus receipt the Safe applies through the timelock)": [
    "router weights: RouterGovernance.applyReceipt (a consensus receipt the Safe applies through the timelock) and clearVotedWeights",
  ],
};

/**
 * Upstream code the core depends on and does not control: each keeps its own upgrade or admin authority after a freeze. The release dependency manifest
 * (deployments/8453/dependency-manifest.json, core 1497) records their addresses and code hashes on 8453.
 */
export const UPSTREAM_DEPENDENCIES: readonly string[] = [
  "USDC: Circle's FiatTokenProxy (upgradeable and pausable by Circle, blacklist included)",
  "Aave v3 Pool and aTokens, Compound v3 Comet and Moonwell markets behind the rmUSDC strategy adapters (each upgradeable by its own governance)",
  "basket assets and their tokens (config/protocol-assets.json, config/rwa-assets.json): each token keeps its issuer's admin",
  "Uniswap V3 SwapRouter02 and pools used by the swap adapters",
  "the strategy and swap adapters: direct deployments replaced only through the governed adapter allowlists",
  "Safe 1.4.1: the SafeL2 singleton and the fallback handler behind the Safe that proposes on the timelock",
];

/** One proxied core contract the table deploys: verifier name, stage and the table's proxy row. */
export interface ProxySpec { name: string; stage: string; field: string; implementationField: string; contract: string; layout: string }

/**
 * Issue 1842: the proxies whose manifest pins runtime code hashes for the signing clients (issue 1810: rmpc and the dapp refuse a gateway whose code differs). For each,
 * `<field>_runtime_hash` (the proxy's code) and `<implementationField>_runtime_hash` (the implementation's) are REQUIRED and must equal the chain: a missing pin fails.
 */
export const PINNED_PROXIES: readonly string[] = ["gateway"];

/** The full proxied core set from the stage table, in table order. A core name for a non-vault stage (CORE_CONTRACT_REFS), `vault[<name>]` for a vault stage. */
export function proxySpecs(table: StageTable): ProxySpec[] {
  // Issue 1927: a prior line's table (the live v0.5.0 deployment) names its receipt in the ic-policy stage, beside the InvestmentCommitteePolicy proxy, and the retired rmAGENT vault.
  const refs = coreContractRefs(table.stages.map((s) => s.name));
  return table.stages.flatMap((s) => (s.proxies ?? []).map((p) => {
    const core = refs.find((r) => r.stage === s.name && r.field === p.field);
    const name = s.vault ? `vault[${vaultDisplayName(s.vault)}]` : core?.name;
    if (!name) throw new Error(`the stage table proxy ${s.name}.${p.field} is neither a vault nor a core contract this verifier names`);
    return { name, stage: s.name, ...p };
  }));
}

/** The layout identifier: keccak256 of the committed snapshot followed by the OpenZeppelin pins (both reviewed files, gated by scripts/ci/check-core-storage-layout.sh). */
export function layoutId(coreDir: string, layout: string, pins: string): Hex {
  return keccak256(concatHex([toHex(readFileSync(join(coreDir, layout))), toHex(readFileSync(join(coreDir, pins)))]));
}

export interface ProxyRecord {
  stage: string;
  contract: string;
  proxy: Address;
  implementation: Address | null;
  proxy_code_hash: Hex | null;
  implementation_code_hash: Hex | null;
  layout: string;
  layout_id: Hex | null;
  upgrade_timelock: Address | null;
  upgrades_frozen: boolean | null;
  initialized_version: string | null;
  manifest_upgrade_mode: string | null;
  /** Issue 1842, upgradeable release only: the block and transaction of the timelock-executed freezeUpgrades that froze the proxy (null while it is upgradeable). */
  freeze_block: string | null;
  freeze_tx: Hex | null;
}

/** The record verify writes to deployments/<chain>/upgradeability.json and the evidence carries as `upgradeability`. */
export interface UpgradeabilityRecord {
  mode: UpgradeMode | null;
  freeze_deadline: string | null;
  timelock: { address: Address; min_delay: string | null };
  transactions_per_proxy: number | null;
  proxies: Record<string, ProxyRecord>;
  /** True only when the sheet says frozen, every proxy of the full set reads frozen and every check of the verify run passed. */
  core_immutable: boolean;
  /** Why the claim is not made (empty when core_immutable). */
  immutability_refused_because: string[];
  remaining_governed_parameters: string[];
  upstream_dependencies: string[];
}

/** The labels pushed per proxy (fixed text, no address, no number: the Twin and mainnet label sets compare equal). The proxy is the build's ERC1967Proxy. */
export const PROXY_LABELS = [
  "is the build's proxy with no admin and no beacon",
  "implementation slot equals the manifest",
  "implementation links the build's libraries",
  "upgradeTimelock() is the deployed timelock",
  "initialized once and not initializing",
  "upgradesFrozen() agrees with the release mode",
  "manifest upgrade_mode equals the release sheet",
  "storage layout identifier recorded",
] as const;
/** The per-contract code label of verify/index.ts: behind a proxy it compares the implementation with the build artifact. */
export const CODE_LABEL = "runtime code equals build artifact (masked)";
export const MODE_LABEL = "upgrades: the sheet declares the release mode";
export const DEADLINE_LABEL = "upgrades: the freeze deadline is not missed";
export const CLAIM_LABEL = "upgrades: core immutability is claimed only when the full core set verifies frozen on chain";

/** The log scan window of a verify run: the deployment's first block to the head (verify/index.ts). */
export interface ScanWindow { fromBlock: bigint; head: bigint; chunk: number; retryBaseMs: number }

const UPGRADES_FROZEN_TOPIC = keccak256(toHex("UpgradesFrozen(address,address,bytes32)"));
const CALL_EXECUTED_TOPIC = keccak256(toHex("CallExecuted(bytes32,uint256,address,uint256,bytes)"));
const CALL_SCHEDULED_TOPIC = keccak256(toHex("CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)"));
export const FREEZE_UPGRADES_SELECTOR: Hex = toFunctionSelector("freezeUpgrades(address,bytes32)");
const DAY = 86_400n;

/**
 * Issue 1842: an upgradeable release's proxy that reads frozen must have been frozen by governance: its UpgradesFrozen log sits in a transaction where the deployed
 * timelock executed freezeUpgrades on that proxy (CallExecuted, target the proxy). A proxy frozen in its initializer (the deploy transaction, no timelock call) fails.
 * A CallExecuted that targets the proxy can only come after the proxy exists, so it also proves the freeze followed the deployment.
 */
async function governedFreeze(chain: ChainReader, proxy: Address, timelock: Address, w: ScanWindow): Promise<{ ok: boolean; detail: string; block?: bigint; tx?: Hex }> {
  const base = { fromBlock: w.fromBlock, toBlock: w.head, chunk: w.chunk, retryBaseMs: w.retryBaseMs };
  const logs = await scanLogs(chain, { ...base, address: proxy, topics: [UPGRADES_FROZEN_TOPIC, padTopic(proxy)] });
  if (logs.length === 0) return { ok: false, detail: `upgradesFrozen() true but no UpgradesFrozen log of ${proxy} from block ${w.fromBlock}: frozen in its initializer, which an upgradeable release never does` };
  const first = logs[0]!;
  if (!first.transactionHash) return { ok: false, detail: `the UpgradesFrozen log at block ${first.blockNumber} has no transaction hash to match the timelock execution with` };
  const exec = (await scanLogs(chain, { ...base, fromBlock: first.blockNumber, toBlock: first.blockNumber, address: timelock, topics: [CALL_EXECUTED_TOPIC] }))
    .filter((l) => lc(l.transactionHash ?? "") === lc(first.transactionHash!))
    .some((l) => {
      const [target, , data] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], l.data);
      return lc(target) === lc(proxy) && lc(data).startsWith(FREEZE_UPGRADES_SELECTOR);
    });
  if (!exec) return { ok: false, detail: `the UpgradesFrozen log of ${proxy} (block ${first.blockNumber}, tx ${first.transactionHash}) is not from a freezeUpgrades the timelock ${timelock} executed: frozen in its initializer or by another path`, block: first.blockNumber, tx: first.transactionHash };
  return { ok: true, detail: `frozen by the timelock at block ${first.blockNumber}, tx ${first.transactionHash}`, block: first.blockNumber, tx: first.transactionHash };
}

/** Issue 1842: the proxies with a freezeUpgrades call in an operation still pending on the timelock (scheduled, not executed or cancelled). */
async function scheduledFreezes(chain: ChainReader, timelock: Address, w: ScanWindow): Promise<Set<string>> {
  const out = new Set<string>();
  const logs = await scanLogs(chain, { fromBlock: w.fromBlock, toBlock: w.head, chunk: w.chunk, retryBaseMs: w.retryBaseMs, address: timelock, topics: [CALL_SCHEDULED_TOPIC] });
  const pending = new Map<string, boolean>();
  for (const l of logs) {
    const [target, , data] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "uint256" }], l.data);
    if (!lc(data).startsWith(FREEZE_UPGRADES_SELECTOR)) continue;
    const id = l.topics[1]!;
    if (!pending.has(id)) pending.set(id, (await chain.read(timelock, "function isOperationPending(bytes32 id) view returns (bool)", [id])) as boolean);
    if (pending.get(id)) out.add(lc(target));
  }
  return out;
}

const word = async (chain: ChainReader, a: Address, slot: Hex): Promise<string> => (await chain.getStorageAt(a, slot)).replace(/^0x/, "").padStart(64, "0").toLowerCase();
const addrOf = (w: string): Address => `0x${w.slice(24)}` as Address;

/**
 * Pushes PROXY_LABELS for every proxy of the stage table, then MODE_LABEL and DEADLINE_LABEL. Returns the record without the claim (finishUpgradeability adds it once every
 * other check of the run has run). `data(spec)` is the manifest object the proxy was written into (a vault's after any redeploy).
 */
export async function upgradeabilityChecks(
  c: Collector, chain: ChainReader, table: StageTable,
  ctx: { sheet: VerifySheet; timelock: Address; artifactsDir: string; proxyBuildDirs?: Record<string, string>; coreDir?: string; data: (spec: ProxySpec) => any; now?: bigint; scan?: ScanWindow },
): Promise<UpgradeabilityRecord> {
  const u = table.upgradeAuthority;
  const mode = ctx.sheet.upgradeMode ?? null;
  const proxyArt = tryLoadArtifact(ctx.artifactsDir, ERC1967_PROXY_ARTIFACT);
  const rec: UpgradeabilityRecord = {
    mode, freeze_deadline: ctx.sheet.freezeDeadline ?? null, timelock: { address: ctx.timelock, min_delay: null }, transactions_per_proxy: u?.transactionsPerProxy ?? null,
    proxies: {}, core_immutable: false, immutability_refused_because: [], remaining_governed_parameters: [...GOVERNED_PARAMETERS], upstream_dependencies: [...UPSTREAM_DEPENDENCIES],
  };
  try { rec.timelock.min_delay = String(await chain.read(ctx.timelock, "function getMinDelay() view returns (uint256)")); } catch { /* the timelock labels report it */ }
  for (const s of proxySpecs(table)) {
    const p = s.name;
    const m = ctx.data(s) ?? {};
    const proxy = m[s.field] as Address;
    const r: ProxyRecord = {
      stage: s.stage, contract: s.contract, proxy, implementation: null, proxy_code_hash: null, implementation_code_hash: null, layout: s.layout, layout_id: null,
      upgrade_timelock: null, upgrades_frozen: null, initialized_version: null, manifest_upgrade_mode: typeof m.upgrade_mode === "string" ? m.upgrade_mode : null,
      freeze_block: null, freeze_tx: null,
    };
    rec.proxies[p] = r;
    let implCode: Hex = "0x";
    await c.run(`${p}: ${PROXY_LABELS[0]}`, async () => {
      if (!isAddress(proxy)) return { ok: false, detail: `the manifest has no ${s.field}` };
      const code = await chain.getCode(proxy);
      r.proxy_code_hash = code.length > 2 ? keccak256(code) : null;
      if (!proxyArt) return { ok: false, detail: `no ${ERC1967_PROXY_ARTIFACT} build artifact to compare with` };
      if (!isProxyCode(code, proxyArt)) return { ok: false, detail: code.length > 2 ? "the code at the address is not the build's ERC1967Proxy (a direct deployment or another proxy)" : "no code at the address" };
      const admin = await word(chain, proxy, ERC1967_ADMIN_SLOT), beacon = await word(chain, proxy, ERC1967_BEACON_SLOT);
      const problems: string[] = [];
      if (!/^0+$/.test(admin) || !/^0+$/.test(beacon)) problems.push(`admin slot 0x${admin}, beacon slot 0x${beacon}`);
      // the pinned proxy's manifest names its code hash, the pin the signing clients compare with the live proxy (fail-closed: a missing pin fails)
      if (PINNED_PROXIES.includes(p)) {
        const pin = m[`${s.field}_runtime_hash`];
        if (typeof pin !== "string") problems.push(`the manifest has no ${s.field}_runtime_hash`);
        else if (lc(pin) !== lc(r.proxy_code_hash ?? "")) problems.push(`proxy code hash ${r.proxy_code_hash}, manifest ${s.field}_runtime_hash ${pin}`);
      }
      return { ok: problems.length === 0, detail: problems.length ? problems.join("; ") : "ERC1967Proxy, admin and beacon slots empty" };
    });
    await c.run(`${p}: ${PROXY_LABELS[1]}`, async () => {
      if (!isAddress(proxy)) return { ok: false, detail: `the manifest has no ${s.field}` };
      const impl = addrOf(await word(chain, proxy, ERC1967_IMPLEMENTATION_SLOT));
      r.implementation = /^0x0{40}$/.test(impl) ? null : impl;
      implCode = r.implementation ? await chain.getCode(r.implementation) : "0x";
      r.implementation_code_hash = implCode.length > 2 ? keccak256(implCode) : null;
      const want = m[s.implementationField];
      const problems: string[] = [];
      if (!r.implementation) problems.push("the implementation slot is empty");
      else if (implCode.length <= 2) problems.push(`no code at the implementation ${r.implementation}`);
      if (!isAddress(want)) problems.push(`the manifest has no ${s.implementationField}`);
      else if (r.implementation && lc(want) !== lc(r.implementation)) problems.push(`slot ${r.implementation}, manifest ${s.implementationField} ${want}`);
      // the gateway manifest also pins the implementation's runtime hash, the pin the signing clients use (issue 1810). Issue 1842: fail-closed, a missing pin fails.
      const pinned = m[`${s.implementationField}_runtime_hash`];
      if (PINNED_PROXIES.includes(p) && typeof pinned !== "string") problems.push(`the manifest has no ${s.implementationField}_runtime_hash`);
      else if (typeof pinned === "string" && lc(pinned) !== lc(r.implementation_code_hash ?? "")) problems.push(`implementation code hash ${r.implementation_code_hash}, manifest ${s.implementationField}_runtime_hash ${pinned}`);
      return { ok: problems.length === 0, detail: problems.length ? problems.join("; ") : `implementation ${r.implementation}, code hash ${r.implementation_code_hash}` };
    });
    await c.run(`${p}: ${PROXY_LABELS[2]}`, async () => {
      if (implCode.length <= 2) return { ok: false, detail: "no implementation code to read the library links from" };
      const problems: string[] = [];
      let n = 0;
      const seen = new Set<string>();
      // the implementation's link offsets come from the build it was made from (issue 1859: a governed upgrade's own build); the libraries it links are the release's
      const visit = async (code: Hex, artifact: string, dir: string): Promise<void> => {
        for (const l of linkedLibraries(dir, artifact)) {
          const at = (`0x${code.replace(/^0x/, "").slice(l.start * 2, (l.start + 20) * 2)}`) as Address;
          const key = `${l.name}:${lc(at)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          n++;
          const libCode = await chain.getCode(at);
          const res = compareCode(libCode, loadArtifact(ctx.artifactsDir, l.name));
          if (!res.ok) { problems.push(`${l.name} at ${at}: ${res.detail}`); continue; }
          await visit(libCode, l.name, ctx.artifactsDir);
        }
      };
      await visit(implCode, s.contract, ctx.proxyBuildDirs?.[p] ?? ctx.artifactsDir);
      return { ok: problems.length === 0, detail: problems.length ? problems.join("; ") : `${n} linked librar${n === 1 ? "y" : "ies"} equal the build` };
    });
    await c.run(`${p}: ${PROXY_LABELS[3]}`, async () => {
      if (!isAddress(proxy)) return { ok: false, detail: `the manifest has no ${s.field}` };
      r.upgrade_timelock = (await chain.read(proxy, "function upgradeTimelock() view returns (address)")) as Address;
      const ok = lc(r.upgrade_timelock) === lc(ctx.timelock) && isAddress(m.upgrade_timelock) && lc(m.upgrade_timelock) === lc(ctx.timelock);
      return { ok, detail: `upgradeTimelock() ${r.upgrade_timelock}, manifest upgrade_timelock ${String(m.upgrade_timelock)}, deployed timelock ${ctx.timelock}` };
    });
    await c.run(`${p}: ${PROXY_LABELS[4]}`, async () => {
      if (!isAddress(proxy)) return { ok: false, detail: `the manifest has no ${s.field}` };
      // the low 8 bytes hold uint64 _initialized, the next byte bool _initializing (packed, right-aligned)
      const w = await word(chain, proxy, INITIALIZABLE_SLOT);
      const version = BigInt(`0x${w.slice(48)}`), initializing = BigInt(`0x${w.slice(46, 48)}`) !== 0n;
      r.initialized_version = version.toString();
      return { ok: version >= 1n && !initializing, detail: `initialized version ${version}${initializing ? ", initializing" : ""}` };
    });
    await c.run(`${p}: ${PROXY_LABELS[5]}`, async () => {
      if (!isAddress(proxy)) return { ok: false, detail: `the manifest has no ${s.field}` };
      r.upgrades_frozen = (await chain.read(proxy, "function upgradesFrozen() view returns (bool)")) as boolean;
      if (mode === null) return { ok: false, detail: `upgradesFrozen() ${r.upgrades_frozen}, the sheet declares no release mode` };
      // frozen: frozen in the initializer, so it must read true. upgradeable: either is right, a governed freeze is the allowed transition (the deadline label times it).
      // Issue 1842: in an upgradeable release a frozen proxy must have been frozen by a timelock-executed freezeUpgrades, never in its initializer.
      if (mode === "upgradeable" && r.upgrades_frozen === true) {
        if (!ctx.scan) return { ok: false, detail: "upgradesFrozen() true in an upgradeable release, and the chain head is unknown: the governed freeze cannot be proven" };
        const f = await governedFreeze(chain, proxy, ctx.timelock, ctx.scan);
        if (f.ok) { r.freeze_block = f.block!.toString(); r.freeze_tx = f.tx!; }
        return { ok: f.ok, detail: `upgradesFrozen() true, release mode upgradeable: ${f.detail}` };
      }
      const ok = mode === "upgradeable" || r.upgrades_frozen === true;
      return { ok, detail: `upgradesFrozen() ${r.upgrades_frozen}, release mode ${mode}` };
    });
    await c.run(`${p}: ${PROXY_LABELS[6]}`, async () => ({ ok: mode !== null && r.manifest_upgrade_mode === mode, detail: `manifest upgrade_mode ${String(r.manifest_upgrade_mode)}, sheet UPGRADE_MODE ${String(mode)}` }));
    await c.run(`${p}: ${PROXY_LABELS[7]}`, async () => {
      if (!ctx.coreDir) return { ok: false, detail: "no core checkout to read the layout snapshot from" };
      if (!u) return { ok: false, detail: "the stage table has no upgradeAuthority (layout pins)" };
      for (const f of [s.layout, u.layoutPins]) if (!existsSync(join(ctx.coreDir, f))) return { ok: false, detail: `${f} is not in the core checkout` };
      r.layout_id = layoutId(ctx.coreDir, s.layout, u.layoutPins);
      return { ok: true, detail: `${s.layout}: ${r.layout_id}` };
    });
  }
  await c.run(MODE_LABEL, async () => ({ ok: mode === "upgradeable" || mode === "frozen", detail: `UPGRADE_MODE ${String(mode)}` }));
  await c.run(DEADLINE_LABEL, async () => {
    const open = Object.entries(rec.proxies).filter(([, r]) => r.upgrades_frozen !== true).map(([n]) => n);
    if (mode !== "upgradeable") return { ok: true, detail: `release mode ${String(mode)}: no proving period` };
    const finalRelease = ctx.sheet.chainId === MAINNET_CHAIN_ID && (ctx.sheet.deploymentKind ?? "production") === "production";
    if (!rec.freeze_deadline) return { ok: !finalRelease, detail: finalRelease ? "an upgradeable production release on 8453 has no freeze deadline" : `no freeze deadline (not a production release on 8453), ${open.length} proxies upgradeable` };
    const now = ctx.now ?? (chain.blockTimestamp ? await chain.blockTimestamp() : undefined);
    if (now === undefined) return { ok: false, detail: "this chain reader cannot read the head block time" };
    const due = BigInt(Math.floor(Date.parse(rec.freeze_deadline) / 1000));
    const status = `deadline ${rec.freeze_deadline}, ${open.length} of ${Object.keys(rec.proxies).length} proxies still upgradeable`;
    if (open.length === 0) return { ok: true, detail: status };
    if (now <= due) {
      // Issue 1842: the alerts before the deadline (runbook 4.12). The freeze is one Safe round through the timelock, so it must be scheduled at least the delay before
      // the deadline: WARN from deadline - (delay + 7 days), ESCALATE from deadline - (delay + 1 day), while any proxy is unfrozen and has no freeze scheduled. Both pass
      // (the deployment is not wrong yet); only MISSED, after the deadline, fails the run (exit 13).
      const delay = BigInt(rec.timelock.min_delay ?? ctx.sheet.timelockDelay);
      const warnAt = due - delay - 7n * DAY, escalateAt = due - delay - DAY;
      if (now < warnAt) return { ok: true, detail: status };
      if (!ctx.scan) return { ok: false, detail: `${status}: inside the freeze alert window and the chain head is unknown, so the scheduled freezes cannot be read` };
      const scheduled = await scheduledFreezes(chain, ctx.timelock, ctx.scan);
      const unscheduled = open.filter((n) => !scheduled.has(lc(rec.proxies[n]!.proxy ?? "")));
      if (unscheduled.length === 0) return { ok: true, detail: `${status}, a freeze is scheduled on the timelock for each of them` };
      const level = now >= escalateAt ? "ESCALATE" : "WARN";
      const by = new Date(Number(due - delay) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      return { ok: true, detail: `${level}: the freeze deadline ${rec.freeze_deadline} is near and ${unscheduled.join(", ")} still read upgradesFrozen() false with no freeze scheduled. Schedule govern --row freeze-upgrades before ${by} (the deadline minus the ${delay} s timelock delay, runbook 4.12)` };
    }
    return { ok: false, detail: `MISSED: the freeze deadline ${rec.freeze_deadline} has passed and ${open.join(", ")} still read upgradesFrozen() false. The deployment stays reported as upgradeable until every proxy verifies frozen (runbook 4.12)` };
  });
  return rec;
}

/**
 * The claim, after every other check of the run. Core immutability is claimed only when the FULL proxied core set of the stage table reads frozen on chain with every proxy
 * label and its code label passing, and `core_immutable` additionally needs every check of the whole run to pass, so the record never says immutable for a deployment that
 * failed verification. The sheet's frozen mode REQUIRES the claim: the label fails when the chain refuses it. An upgradeable release requires nothing: its claim is made once
 * governance has frozen every proxy (the proving period is over), and until then the record says why not.
 */
export function finishUpgradeability(c: Collector, table: StageTable, rec: UpgradeabilityRecord): void {
  const specs = proxySpecs(table);
  const why: string[] = [];
  if (rec.mode === null) why.push("the sheet declares no release mode");
  const missing = specs.filter((s) => !rec.proxies[s.name]).map((s) => s.name);
  if (missing.length) why.push(`proxies not recorded: ${missing.join(", ")}`);
  const unfrozen = specs.filter((s) => rec.proxies[s.name]?.upgrades_frozen !== true).map((s) => s.name);
  if (unfrozen.length) why.push(`not frozen on chain${rec.mode === "upgradeable" ? " (upgradeable release, proving period open)" : ""}: ${unfrozen.join(", ")}`);
  // the upgradeability labels of each proxy and its code label: the implementation runs the reviewed build (verify/index.ts, "runtime code equals build artifact")
  const proofLabels = new Set(specs.flatMap((s) => [...PROXY_LABELS, CODE_LABEL].map((l) => `${s.name}: ${l}`)));
  const failedProxy = c.checks.filter((k) => !k.ok && proofLabels.has(k.label)).map((k) => k.label);
  if (failedProxy.length) why.push(`failed proxy checks: ${failedProxy.join(", ")}`);
  const proxyWhy = [...why];
  const others = c.checks.filter((k) => !k.ok && !failedProxy.includes(k.label)).map((k) => k.label);
  if (others.length) why.push(`other failed checks: ${others.join(", ")}`);
  rec.core_immutable = why.length === 0;
  rec.immutability_refused_because = why;
  const required = rec.mode === "frozen";
  const ok = !required || proxyWhy.length === 0;
  const remain = `${rec.remaining_governed_parameters.length} governed parameters and ${rec.upstream_dependencies.length} upstream dependencies remain (upgradeability.json)`;
  c.push(CLAIM_LABEL, ok, proxyWhy.length === 0
    ? `${specs.length} core proxies verified frozen on chain${rec.mode === "upgradeable" ? " (an upgradeable release, frozen by governance)" : ""}. Not everything is immutable: ${remain}`
    : required ? `the sheet's frozen mode claims core immutability and the chain refuses it: ${proxyWhy.join("; ")}` : `no claim: ${proxyWhy.join("; ")}. ${remain}`);
}

/** Only for the vault stages: the manifest object a vault proxy lives in (a redeploy replaces it), else the stage's own manifest file. */
export function manifestDataOf(table: StageTable, files: Record<string, any>, vaults: ManifestVault[]): (s: ProxySpec) => any {
  return (s) => {
    const st = table.stages.find((x) => x.name === s.stage)!;
    if (st.vault) return vaults.find((v) => v.key === vaultDisplayName(st.vault!))?.data ?? files[manifestBase(st.manifest)];
    return files[manifestBase(st.manifest)];
  };
}
