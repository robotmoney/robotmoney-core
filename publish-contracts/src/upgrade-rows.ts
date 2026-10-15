// The govern rows `upgrade-proxy` and `freeze-proxy` (issue 1809, ADR-0014 §4-§5): the only two ways this tool changes what a governed proxy runs, both ONE timelock
// operation scheduled by the Safe, executed after the real delay, never part of stage 13. The deployer, an EOA and every role are refused by the contract itself
// (GovernedUpgrade: the authority is the timelock, set once); this module keeps the tool from scheduling an operation the contract would revert one delay later, and
// binds every operation to a build whose commit is named. A build is "reviewed" only through build-provenance.ts: DIR must sit in a git checkout (its HEAD is the
// round's `build_sha`), and on 8453 that checkout must be clean at a release-tagged sha of the sheet's kind with green CI (security round 1). Before, DIR was taken as given.
//   upgrade-proxy  `--admin-arg proxy=<name> implementation=0x.. [call=0x..] [build=DIR]`: proxy.upgradeToAndCall(implementation, call) on one proxy. Refused before
//                  anything is sent when the proxy is frozen, its authority is not the timelock, an ERC-1967 admin or beacon slot is set, the target has no code, is
//                  not a UUPS implementation (proxiableUUID), has unlocked initializers, or its runtime code (immutables and links masked) differs from the build
//                  artifact of the proxy's contract in DIR (default: the checkout's out/), or when the build's storage-layout snapshot moves a live variable or
//                  changes a stored enum's existing members (upgradeLayoutRefusals, layout-compare.ts; on 8453 also when either layout cannot be read, or records
//                  no enum members while storage holds an enum). An implementation the proxy already names is
//                  recorded as skipped. Rounds are numbered (the salt carries the round): a target already executed or skipped earlier gets a NEW round once the
//                  proxy runs another implementation (an upgrade back to it, a rollback after a skipped no-op).
//   freeze-proxy   `--admin-arg proxy=<name>|all [build=DIR]`: proxy.freezeUpgrades(liveImplementation, liveCodeHash) on one proxy, or on every proxy not yet frozen
//                  as one batch. The arguments are read from the chain when the round is planned, so the operation names the implementation the reviewers saw, and
//                  GovernedUpgrade reverts it (FreezeTargetMismatch) if an upgrade executes first. Refused when the live implementation's code differs from the
//                  build (the reviewed implementation), the authority is not the timelock, an admin or beacon slot is set, or an upgrade-proxy round of the same
//                  proxy is scheduled and not executed (cancel it through the Safe first: ADR-0014 §5). A proxy already frozen is recorded as skipped.
// Neither row pauses or touches a withdrawal path (ADR-0014 §6): the operation writes the implementation slot or the frozen bit, nothing else.
// This module is pure: it reads no chain and sends nothing. govern.ts reads the chain and sends the call.
import { encodeFunctionData, getAddress, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import { ERC1967_IMPLEMENTATION_SLOT, INITIALIZERS_LOCKED, codeHashOf, wordAddress, type ProxyState } from "./proxies.ts";
import type { CodeHashResult } from "./verify/codehash.ts";
import { asLayoutSnapshot, layoutAppendOnlyProblems } from "./layout-compare.ts";

export const UPGRADE_ROW = "upgrade-proxy";
export const FREEZE_ROW = "freeze-proxy";
/** The `--admin-arg` keys of each row. */
export const UPGRADE_KEYS = ["proxy", "implementation", "call", "build"] as const;
export const FREEZE_KEYS = ["proxy", "build"] as const;
export type UpgradeArgs = Partial<Record<(typeof UPGRADE_KEYS)[number], string>>;
export type FreezeArgs = Partial<Record<(typeof FREEZE_KEYS)[number], string>>;

/** The GovernedUpgrade surface the rows call (ADR-0014 §3). */
export const PROXY_GOVERN_ABI = parseAbi([
  "function upgradeToAndCall(address newImplementation, bytes data) payable",
  "function freezeUpgrades(address expectedImplementation, bytes32 expectedCodeHash)",
]);

/** One upgrade-proxy run: the proxy (stage table name), the new implementation, the reinitializer calldata (0x: none) and the build to compare with. */
export interface UpgradeWant { proxy: string; implementation: Address; call: Hex; build?: string }
/** One freeze-proxy run: one proxy, or `all` (every proxy not yet frozen, one batch), and the build to compare with. */
export interface FreezeWant { proxy: string; build?: string }

const usage = (row: string, m: string): never => { throw new PublishError("USAGE", `--row ${row}: ${m}`, { row }); };
const proxyName = (row: string, v: string | undefined, names: readonly string[], all: boolean): string => {
  if (names.length === 0) return usage(row, "the core stage table lists no proxies: this deployment has nothing to upgrade or freeze (a core sha before ADR-0014)");
  if (v === undefined) return usage(row, `needs --admin-arg proxy=${[...names, ...(all ? ["all"] : [])].join("|")}`);
  if (all && v === "all") return v;
  if (!names.includes(v)) return usage(row, `--admin-arg proxy must be one of ${[...names, ...(all ? ["all"] : [])].join(", ")}, got '${v}'`);
  return v;
};

/** The upgrade row's arguments, checked. Every problem is USAGE and nothing is read or sent. `names`: the stage table's proxy names. */
export function parseUpgradeArgs(args: UpgradeArgs | undefined, names: readonly string[]): UpgradeWant {
  const a = args ?? {};
  const proxy = proxyName(UPGRADE_ROW, a.proxy, names, false);
  const impl = a.implementation;
  if (impl === undefined || !/^0x[0-9a-fA-F]{40}$/.test(impl)) return usage(UPGRADE_ROW, `needs --admin-arg implementation=0x<address> (the deployed new implementation), got ${JSON.stringify(impl ?? null)}`);
  if (/^0x0{40}$/.test(impl)) return usage(UPGRADE_ROW, "implementation is the zero address");
  const call = a.call ?? "0x";
  if (!/^0x([0-9a-fA-F]{2})*$/.test(call)) return usage(UPGRADE_ROW, `--admin-arg call must be 0x-prefixed calldata (a reinitializer call, or 0x for none), got '${call}'`);
  if (a.build !== undefined && a.build === "") return usage(UPGRADE_ROW, "--admin-arg build needs a directory (the forge out/ of the checkout the implementation was built from)");
  return { proxy, implementation: getAddress(impl), call: call.toLowerCase() as Hex, ...(a.build ? { build: a.build } : {}) };
}

/** The freeze row's arguments, checked. Every problem is USAGE and nothing is read or sent. */
export function parseFreezeArgs(args: FreezeArgs | undefined, names: readonly string[]): FreezeWant {
  const a = args ?? {};
  const proxy = proxyName(FREEZE_ROW, a.proxy, names, true);
  if (a.build !== undefined && a.build === "") return usage(FREEZE_ROW, "--admin-arg build needs a directory (the forge out/ of the checkout the live implementation was built from)");
  return { proxy, ...(a.build ? { build: a.build } : {}) };
}

/** The `--admin-arg` flags that name this exact run (the resume command spells them out: they carry no secret). */
export const upgradeArgsText = (w: UpgradeWant): string =>
  [`proxy=${w.proxy}`, `implementation=${w.implementation}`, ...(w.call !== "0x" ? [`call=${w.call}`] : []), ...(w.build ? [`build=${w.build}`] : [])].map((kv) => `--admin-arg ${kv}`).join(" ");
export const freezeArgsText = (w: FreezeWant): string => [`proxy=${w.proxy}`, ...(w.build ? [`build=${w.build}`] : [])].map((kv) => `--admin-arg ${kv}`).join(" ");

/** The one call of an upgrade: upgradeToAndCall(implementation, call) on the proxy. */
export function buildUpgradeCall(name: string, proxy: Address, w: UpgradeWant): { label: string; target: Address; data: Hex } {
  return {
    label: `${name}.upgradeToAndCall(${w.implementation}, ${w.call === "0x" ? "no reinitializer" : `${w.call.slice(0, 10)}..`})`,
    target: proxy, data: encodeFunctionData({ abi: PROXY_GOVERN_ABI, functionName: "upgradeToAndCall", args: [w.implementation, w.call] }),
  };
}

/** The call of one freeze: freezeUpgrades(implementation, codeHash) on the proxy, the arguments read from the chain when the round was planned. */
export function buildFreezeCall(name: string, proxy: Address, implementation: Address, codeHash: Hex): { label: string; target: Address; data: Hex } {
  return { label: `${name}.freezeUpgrades(${implementation}, codehash ${codeHash})`, target: proxy, data: encodeFunctionData({ abi: PROXY_GOVERN_ABI, functionName: "freezeUpgrades", args: [implementation, codeHash] }) };
}

/**
 * The run-manifest key and salt input of one upgrade: the proxy and a hash of the target and the reinitializer. The same target is one record; another is another. The
 * salt also carries the record's round (govern.ts labelOf): a completed record whose target the proxy no longer runs opens round n+1, a new operation (security round 1).
 */
export const upgradeRecordKey = (w: UpgradeWant): string => `${UPGRADE_ROW}-${w.proxy}-${keccak256(toBytes(`${w.implementation.toLowerCase()}:${w.call}`)).slice(2, 10)}`;
/** The run-manifest key of one freeze: the proxy (or `all`) and a hash of the calls, so a freeze planned on another implementation is another record. */
export const freezeRecordKey = (proxy: string, calls: readonly { data: Hex }[]): string => `${FREEZE_ROW}-${proxy}-${keccak256(toBytes(calls.map((c) => c.data).join(""))).slice(2, 10)}`;

/** What the upgrade target reads on chain. */
export interface ImplementationRead { address: Address; code: Hex; initializerVersion: bigint; proxiableUUID: Hex | null }

const lc = (s: string): string => s.toLowerCase();
const nonZero = (w: Hex): boolean => w !== "0x" && BigInt(w) !== 0n;

/** Problems every governed operation on a proxy shares: the timelock must be its authority and nobody else may administer it. */
function authorityProblems(name: string, live: ProxyState, timelock: Address): string[] {
  const out: string[] = [];
  if (live.authority === null || lc(live.authority) !== lc(timelock)) out.push(`${name}.upgradeAuthority() reads ${live.authority ?? "nothing"}, not the timelock ${timelock}: the execute would revert UpgradeNotAuthorized`);
  if (nonZero(live.adminSlot)) out.push(`${name}'s ERC-1967 admin slot is not empty (it names ${wordAddress(live.adminSlot)}): a Robot Money proxy has no admin (ADR-0014 §3), refused`);
  if (nonZero(live.beaconSlot)) out.push(`${name}'s ERC-1967 beacon slot is not empty (it names ${wordAddress(live.beaconSlot)}): a Robot Money proxy has no beacon (ADR-0014 §3), refused`);
  return out;
}

/**
 * Why an upgrade must not be scheduled (empty: it may). `build`: the target's runtime code against the build artifact of the proxy's contract (verify/codehash.ts).
 * An upgrade to the implementation the proxy already names is not a refusal: the caller records it as skipped.
 */
export function upgradeRefusals(o: { name: string; live: ProxyState; target: ImplementationRead; build: CodeHashResult; timelock: Address }): string[] {
  const out = authorityProblems(o.name, o.live, o.timelock);
  if (o.live.frozen !== false) out.push(`${o.name} ${o.live.frozen ? "is frozen: upgradeToAndCall would revert UpgradesAreFrozen after the delay. A frozen proxy never upgrades again (ADR-0014 §5)" : "does not answer upgradesFrozen(): it is no governed proxy"}`);
  if (o.target.code === "0x" || o.target.code.length <= 2) out.push(`the target ${o.target.address} has no code: deploy the new implementation first`);
  else {
    if (o.target.proxiableUUID === null || lc(o.target.proxiableUUID) !== lc(ERC1967_IMPLEMENTATION_SLOT)) out.push(`the target ${o.target.address} answers proxiableUUID() with ${o.target.proxiableUUID === null ? "a revert" : "another value"}, not the ERC-1967 implementation slot: it is no UUPS implementation and upgradeToAndCall would revert`);
    if (o.target.initializerVersion !== INITIALIZERS_LOCKED) out.push(`the target ${o.target.address} reads Initializable version ${o.target.initializerVersion}, not ${INITIALIZERS_LOCKED}: its initializers are not locked (_disableInitializers)`);
    if (!o.build.ok) out.push(`the target ${o.target.address} is not the reviewed build: ${o.build.detail}`);
  }
  return out;
}

/**
 * Security round 1 (ADR-0014 §8): the layout half of an upgrade's refusals. `liveId` is the storage-layout identifier of the implementation the proxy runs now (the last
 * executed upgrade's `build_layout_hash`, else the deploy manifest's `<field>_layout_id`), `live` the snapshot that hashes to it (from the deployment checkout or the last
 * upgrade's build checkout); `buildId`/`build` are the build checkout's. Equal identifiers pass: since security round 3 the CI layout gate fails a commit whose snapshot
 * is not exactly its code's layout (storage_layout_gate.py snapshot_drift), and on 8453 both checkouts are green release shas, so an equal identifier is an equal layout
 * (before, an append that skipped `--write` kept the old identifier). Different ones are compared under the append-only storage rules
 * (layout-compare.ts, the enum rule included since security round 2) on every chain. On 8453 an identifier or a snapshot that cannot be read is a refusal too, and so
 * is a snapshot with no `enums` map while storage holds an enum; elsewhere it is not (a Twin build may have no checkout).
 */
export function upgradeLayoutRefusals(o: { name: string; artifact: string; liveField: string; mainnet: boolean; liveId?: string; live?: unknown; buildId?: string; build?: unknown }): string[] {
  const snapshotPath = `contracts/test/fixtures/storage-layout/${o.artifact}.json`;
  if (o.buildId === undefined) return o.mainnet ? [`the build checkout holds no storage-layout snapshot ${snapshotPath}: the new implementation's layout cannot be compared with the live one (ADR-0014 §8)`] : [];
  if (o.liveId === undefined) return o.mainnet ? [`no storage-layout identifier is recorded for ${o.name}'s live implementation (the deploy manifest's ${o.liveField}, or the build_layout_hash of the upgrade round that installed it): the live layout cannot be compared with the build's`] : [];
  if (lc(o.liveId) === lc(o.buildId)) return [];
  if (o.live === undefined) return o.mainnet ? [`the live layout ${o.liveId} of ${o.name} has no snapshot to compare with: neither the deployment checkout nor the last upgrade's build checkout holds a ${snapshotPath} that hashes to it`] : [];
  const live = asLayoutSnapshot(o.live), build = asLayoutSnapshot(o.build);
  if (typeof live === "string") return [`the live layout snapshot of ${o.name} is malformed (${live})`];
  if (typeof build === "string") return [`the build's layout snapshot ${snapshotPath} is malformed (${build})`];
  // security round 2: on 8453 a snapshot that records no enum members while storage holds an enum is unreadable (layout-compare.ts)
  return layoutAppendOnlyProblems(live, build, { requireEnums: o.mainnet }).map((x) => `the build's storage layout breaks the live one (${o.liveId} -> ${o.buildId}): ${x}`);
}

/** Why a freeze of one proxy must not be scheduled (empty: it may). `build`: the LIVE implementation's code against the build. `pendingUpgrade`: an upgrade round of this proxy that is scheduled and not executed. */
export function freezeRefusals(o: { name: string; live: ProxyState; build: CodeHashResult; timelock: Address; pendingUpgrade?: string }): string[] {
  const out = authorityProblems(o.name, o.live, o.timelock);
  if (o.live.frozen === null) out.push(`${o.name} does not answer upgradesFrozen(): it is no governed proxy`);
  if (o.live.implementationCode === "0x" || o.live.implementationCode.length <= 2) out.push(`${o.name}'s implementation ${o.live.implementation} has no code`);
  else if (!o.build.ok) out.push(`${o.name}'s live implementation ${o.live.implementation} is not the reviewed build, and a freeze would fix it forever: ${o.build.detail}`);
  if (o.pendingUpgrade) out.push(`the upgrade-proxy round ${o.pendingUpgrade} of ${o.name} is scheduled and not executed: cancel it through the Safe on the timelock first (ADR-0014 §5), then freeze`);
  return out;
}

/** The freeze arguments of a live proxy: its implementation and that implementation's runtime code hash (EXTCODEHASH). */
export const freezeTargetOf = (live: ProxyState): { implementation: Address; codeHash: Hex } => ({ implementation: live.implementation, codeHash: codeHashOf(live.implementationCode) });

/** Read-back after an executed upgrade: the slot names the target, the authority is unchanged and the proxy is not frozen. Empty: a pass. */
export function upgradeReadBackProblems(name: string, after: ProxyState, w: UpgradeWant, timelock: Address): string[] {
  const out: string[] = [];
  if (lc(after.implementation) !== lc(w.implementation)) out.push(`${name}'s implementation slot reads ${after.implementation}, want ${w.implementation}`);
  if (after.authority === null || lc(after.authority) !== lc(timelock)) out.push(`${name}.upgradeAuthority() reads ${after.authority ?? "nothing"} after the upgrade, want ${timelock}`);
  if (after.frozen !== false) out.push(`${name}.upgradesFrozen() reads ${after.frozen} after the upgrade, want false`);
  if (nonZero(after.adminSlot)) out.push(`${name}'s ERC-1967 admin slot is not empty after the upgrade (it names ${wordAddress(after.adminSlot)}), want empty`);
  return out;
}

/** Read-back after an executed freeze: each proxy reads frozen on the implementation the freeze named. Empty: a pass. */
export function freezeReadBackProblems(targets: readonly { name: string; implementation: Address }[], after: readonly ProxyState[]): string[] {
  return targets.flatMap((t, i) => {
    const a = after[i]!;
    const out: string[] = [];
    if (a.frozen !== true) out.push(`${t.name}.upgradesFrozen() reads ${a.frozen}, want true`);
    if (lc(a.implementation) !== lc(t.implementation)) out.push(`${t.name}'s implementation slot reads ${a.implementation}, the freeze named ${t.implementation}`);
    return out;
  });
}
