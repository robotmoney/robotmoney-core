// Issue 1842: the operator rows of the governed upgrade lifecycle (upgradeability stages 2 and 4 follow-ups). Both run through the Safe and the timelock in runGovern
// (src/govern.ts); this module holds their pure parts: the freeze targets read from upgradeability.json, the calls, the storage-layout gate, the runtime code check and
// the manifest re-record. It reads files and the chain only through its arguments and sends nothing.
//
//   govern --row freeze-upgrades   ONE timelock batch: freezeUpgrades(implementation, implementation_code_hash) on every unfrozen core proxy, both values taken from the
//                                  latest deployments/<chain>/upgradeability.json (the record verify writes). Refused while an upgrade operation is pending on the timelock.
//   govern --row upgrade-proxy --proxy NAME --implementation ADDR [--upgrade-build DIR]
//                                  ONE timelock call: upgradeToAndCall(ADDR, "") on the named proxy. Refused before scheduling when the proxy is frozen, when the new
//                                  implementation's storage layout does not extend the deployed snapshot append-only, or when its runtime code is not the build artifact.
//                                  With --migration NAME (issue 1910) the data is a typed migration the tool builds (UPGRADE_MIGRATIONS), never free hex.
//                                  After the execute it rewrites the proxy's stage manifest implementation fields (and the gateway's runtime hash pins), so verify is green.
//
// Canonical: docs/technical/contract-upgradeability-plan.md, docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md, docs/operations/contract-release-runbooks.md 4.12.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseAbi, toFunctionSelector, type Abi, type Address, type Hex } from "viem";
import { freezeCalldata, upgradeCalldata, type FreezeTarget } from "./upgrade-lifecycle.ts";
import { artifactJson, compareCode, linkedLibraries, loadArtifact } from "./verify/codehash.ts";
import { PINNED_PROXIES, layoutId, type ProxySpec } from "./verify/upgradeability.ts";

export const FREEZE_ROW = "freeze-upgrades";
export const UPGRADE_ROW = "upgrade-proxy";
export const GOVERNED_PROXY_ABI = parseAbi([
  "function upgradesFrozen() view returns (bool)",
  "function upgradeToAndCall(address newImplementation, bytes data)",
  "function freezeUpgrades(address expectedImplementation, bytes32 expectedCodeHash)",
]);
export const UPGRADE_TO_AND_CALL_SELECTOR: Hex = toFunctionSelector("upgradeToAndCall(address,bytes)");

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
const lc = (x: unknown): string => String(x ?? "").toLowerCase();

export interface LabelledProxyCall { label: string; target: Address; data: Hex }

/** The run-manifest key of one upgrade: the proxy and the implementation it moves to. A rerun of the same pair reprints its record. */
export const upgradeRecordKey = (proxy: string, implementation: string, migration?: string): string => `${UPGRADE_ROW}-${proxy}-${implementation.toLowerCase()}${migration ? `-${migration}` : ""}`;

/**
 * Issue 1910: a typed migration of one proxy, run in the SAME upgradeToAndCall as the implementation swap. The tool builds the data from the ABI of the build it upgrades to and
 * from an address it reads out of the deployment's own manifest. There is no free hex path: an operator names the migration, never the bytes.
 */
export interface UpgradeMigration {
  /** The verifier name of the only proxy this migration belongs to. */
  proxy: string;
  /** The implementation contract whose build ABI declares the function. */
  contract: string;
  functionName: string;
  /** The stage manifest and the field in it that hold the single address argument. */
  argument: { name: string; manifest: string; field: string };
  why: string;
}
export const UPGRADE_MIGRATIONS: Readonly<Record<string, UpgradeMigration>> = {
  // The v0.5.0 receipt proxy has no submitter roles. migrateToSubmitterRoles (reinitializer(2), timelock only) wires the role admins, grants RouterGovernance the release role
  // and drops its ADMIN_ROLE. Proven at the Solidity level by contracts/test/ConsensusReceiptMigration.t.sol.
  "receipt-submitter-roles": {
    proxy: "receipt", contract: "ConsensusRecommendationReceipt", functionName: "migrateToSubmitterRoles",
    argument: { name: "releaser", manifest: "governance", field: "governance" },
    why: "moves the v0.5.0 receipt proxy to the submitter roles: RECEIPT_RELEASER_ROLE on RouterGovernance only, ADMIN_ROLE on the timelock",
  },
};

/** The decoded form of a typed migration, as the preview prints it and the manifest records it. */
export interface MigrationRecord { name: string; function: string; selector: Hex; argument: string; releaser: Address; data: Hex; data_hash: Hex }

/** Names the row accepts, for the usage message. */
export const migrationNames = (): string => Object.keys(UPGRADE_MIGRATIONS).join(", ");

/** Refusals that need no file: an unknown name, or a migration on a proxy that has none. An empty list passes. */
export function migrationNameProblems(name: string, proxyName: string): string[] {
  const m = Object.prototype.hasOwnProperty.call(UPGRADE_MIGRATIONS, name) ? UPGRADE_MIGRATIONS[name] : undefined;
  if (!m) return [`--migration ${JSON.stringify(name)} is not a known migration (known: ${migrationNames()})`];
  if (m.proxy !== proxyName) return [`migration ${name} belongs to the ${m.proxy} proxy, not ${proxyName}: ${proxyName} has no such migration`];
  return [];
}

/**
 * The typed migration's data: the function is resolved from the build ABI (`outDir`, the --upgrade-build checkout's out/) and its one address argument is `argument`. A build
 * whose ABI lacks the function (or declares it with another shape) throws, as does a zero or malformed address. Nothing here takes hex from the operator.
 */
export function buildMigration(name: string, proxyName: string, outDir: string, argument: string | undefined): MigrationRecord {
  const bad = migrationNameProblems(name, proxyName);
  if (bad.length) throw new Error(bad.join("; "));
  const m = UPGRADE_MIGRATIONS[name]!;
  if (!argument || !ADDR.test(argument) || /^0x0{40}$/i.test(argument)) throw new Error(`migration ${name}: ${m.argument.name} (${m.argument.manifest}.json ${m.argument.field}) is ${argument === undefined ? "missing" : `not a non-zero address: ${argument}`}`);
  const abi = artifactJson(outDir, m.contract).abi as Abi | undefined;
  const fn = (abi ?? []).filter((x: any) => x.type === "function" && x.name === m.functionName);
  const f: any = fn[0];
  if (fn.length !== 1 || f.inputs?.length !== 1 || f.inputs[0].type !== "address" || (f.outputs?.length ?? 0) !== 0 || f.stateMutability !== "nonpayable") {
    throw new Error(`migration ${name}: the ${m.contract} build ABI under ${outDir} does not declare exactly ${m.functionName}(address) nonpayable with no result`);
  }
  const releaser = getAddress(argument) as Address;
  const data = encodeFunctionData({ abi: abi!, functionName: m.functionName, args: [releaser] });
  if (data !== pinnedMigrationData(name, releaser)) throw new Error(`migration ${name}: the ${m.contract} build ABI encodes ${m.functionName} differently from the reviewed signature ${m.functionName}(address)`);
  return { name, function: m.functionName, selector: data.slice(0, 10) as Hex, argument: m.argument.name, releaser, data, data_hash: keccak256(data) };
}

/**
 * The pinned encoding of a migration, from its reviewed one-line signature and not from any build: what evidence-check expects the chain to hold. buildMigration also requires the
 * build ABI to produce exactly these bytes, so a build whose function drifted (another selector) is refused before anything is scheduled.
 */
export function pinnedMigrationData(name: string, releaser: string): Hex {
  const m = UPGRADE_MIGRATIONS[name];
  if (!m) throw new Error(`unknown migration ${name}`);
  return encodeFunctionData({ abi: parseAbi([`function ${m.functionName}(address ${m.argument.name})`] as readonly string[]) as Abi, functionName: m.functionName, args: [getAddress(releaser)] });
}

/** The data field of upgradeToAndCall for the scheduled call: the typed migration, or empty. */
export const migrationData = (m: MigrationRecord | undefined): Hex => m?.data ?? "0x";

/**
 * The `data` argument of a scheduled upgradeToAndCall call, decoded. `undefined` when the calldata is not an upgradeToAndCall. evidence-check compares the CallScheduled data
 * from the chain with the typed migration of the recorded entry through it.
 */
export function decodeUpgradeCall(calldata: Hex): { implementation: Address; data: Hex } | undefined {
  try {
    const d = decodeFunctionData({ abi: GOVERNED_PROXY_ABI, data: calldata });
    if (d.functionName !== "upgradeToAndCall") return undefined;
    const [implementation, data] = d.args as [Address, Hex];
    return { implementation, data };
  } catch { return undefined; }
}

/**
 * Issue 1892: the proxies a freeze names. The gateway system's proxy is frozen by its own release (its own upgrade timelock), so it joins this freeze only when the record lists
 * it, a record of the combined deployment. Every other proxy of the table is required.
 */
export function freezeSpecsFor(specs: readonly ProxySpec[], systemOfStage: (stage: string) => string | undefined, record: any): ProxySpec[] {
  return specs.filter((s) => systemOfStage(s.stage) !== "gateway" || record?.proxies?.[s.name] !== undefined);
}

/** Every core proxy's freeze target from the verifier's record, or the problems that make the record unusable (a proxy missing, an address or hash malformed). */
export function freezeTargets(record: any, specs: readonly ProxySpec[]): { targets: Record<string, FreezeTarget>; problems: string[] } {
  const targets: Record<string, FreezeTarget> = {};
  const problems: string[] = [];
  for (const s of specs) {
    const r = record?.proxies?.[s.name];
    if (!r) { problems.push(`${s.name}: not in upgradeability.json`); continue; }
    if (!ADDR.test(String(r.proxy))) problems.push(`${s.name}: proxy ${String(r.proxy)} is not an address`);
    if (!ADDR.test(String(r.implementation))) problems.push(`${s.name}: implementation ${String(r.implementation)} is not an address`);
    if (!B32.test(String(r.implementation_code_hash))) problems.push(`${s.name}: implementation_code_hash ${String(r.implementation_code_hash)} is not a bytes32`);
    targets[s.name] = { proxy: r.proxy, implementation: r.implementation, implementation_code_hash: r.implementation_code_hash };
  }
  return { targets, problems };
}

/** One freezeUpgrades call per target, in the given (stage table) order. */
export function buildFreezeCalls(targets: Record<string, FreezeTarget>): LabelledProxyCall[] {
  return Object.entries(targets).map(([n, t]) => ({ label: `${n}.freezeUpgrades(${t.implementation}, ${t.implementation_code_hash})`, target: t.proxy as Address, data: freezeCalldata(t.implementation, t.implementation_code_hash) }));
}

/** The one call of an upgrade round. */
export function buildUpgradeCall(name: string, proxy: Address, implementation: Address, migration?: MigrationRecord): LabelledProxyCall {
  // a resumed plan comes from the run manifest on disk: its migration data must still be the reviewed encoding, never edited bytes
  if (migration && migration.data.toLowerCase() !== pinnedMigrationData(migration.name, migration.releaser).toLowerCase()) throw new Error(`the recorded migration ${migration.name} carries data that is not ${migration.function}(${migration.releaser})`);
  return { label: migration ? `${name}.upgradeToAndCall(${implementation}, ${migration.function}(${migration.releaser}))` : `${name}.upgradeToAndCall(${implementation}, "")`, target: proxy, data: upgradeCalldata(implementation, migrationData(migration)) };
}

/** The pending upgrade operations among the timelock's scheduled calls: an upgradeToAndCall on one of `proxies` whose operation is still pending. */
export function pendingUpgrades(scheduled: readonly { id: Hex; target: Address; data: Hex }[], proxies: readonly string[], pending: (id: Hex) => boolean): { id: Hex; target: Address }[] {
  const set = new Set(proxies.map(lc));
  return scheduled.filter((c) => set.has(lc(c.target)) && lc(c.data).startsWith(UPGRADE_TO_AND_CALL_SELECTOR) && pending(c.id)).map((c) => ({ id: c.id, target: c.target }));
}

/**
 * The storage-layout gate of one upgrade (the TypeScript form of scripts/ci/check-core-storage-layout.sh `extends`): the new snapshot must keep every storage row,
 * every member of every stored struct and every ERC-7201 namespace member of the deployed snapshot at the same position with the same type, and drop no linked library.
 * New rows and members may only follow the old ones. An empty list passes.
 */
export function layoutExtensionProblems(deployed: any, candidate: any, renames: readonly LayoutRename[] = [], contract = ""): string[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const ext = (old: unknown[] = [], neu: unknown[] = []) => old.length <= neu.length && old.every((x, i) => same(x, neu[i]));
  const bad: string[] = [];
  // Issue 1927: a reviewed label-only rename (scripts/ci/storage-layout-renames.json, slot, offset and type pinned) is applied to the deployed rows first, as the shell gate does
  const storage = ((deployed?.storage ?? []) as any[]).map((r) => {
    const m = renames.find((x) => x.contract === contract && x.from === r?.label && x.slot === r?.slot && x.offset === r?.offset && x.type === r?.type);
    return m ? { ...r, label: m.to } : r;
  });
  if (!ext(storage, candidate?.storage)) bad.push("storage: a variable moved, was retyped or removed");
  for (const [k, v] of Object.entries<unknown[]>(deployed?.structs ?? {})) if (!ext(v, candidate?.structs?.[k])) bad.push(`struct ${k}: a member moved, was retyped or removed`);
  for (const [k, v] of Object.entries<unknown[]>(deployed?.namespaces ?? {})) if (!ext(v, candidate?.namespaces?.[k])) bad.push(`namespace ${k}: a member moved, was retyped or removed`);
  for (const l of (deployed?.libraries ?? []) as string[]) if (!((candidate?.libraries ?? []) as string[]).includes(l)) bad.push(`library ${l} is no longer linked`);
  return bad;
}

/**
 * The layout gate against the deployed snapshot. The deployed snapshot is the one in the core checkout at the DEPLOY_SHA (`coreDir`), and it must be the snapshot verify
 * recorded for the proxy (its layout identifier equals `recordedLayoutId`). The candidate is the snapshot of the build the new implementation comes from (`buildDir`).
 */
export function layoutGateProblems(spec: ProxySpec, coreDir: string, buildDir: string, pins: string, recordedLayoutId: string | null | undefined): string[] {
  for (const [dir, f] of [[coreDir, spec.layout], [coreDir, pins], [buildDir, spec.layout]] as const) if (!existsSync(join(dir, f))) return [`${join(dir, f)} does not exist`];
  const deployedId = layoutId(coreDir, spec.layout, pins);
  if (!recordedLayoutId || lc(recordedLayoutId) !== lc(deployedId)) return [`the deployed snapshot ${spec.layout} (layout id ${deployedId}) is not the one verify recorded (${String(recordedLayoutId)}): run verify on the DEPLOY_SHA checkout first`];
  return layoutExtensionProblems(JSON.parse(readFileSync(join(coreDir, spec.layout), "utf8")), JSON.parse(readFileSync(join(buildDir, spec.layout), "utf8")), layoutRenames(buildDir), spec.contract);
}

/** Issue 1927: one reviewed label-only rename of a proxy storage row (scripts/ci/storage-layout-renames.json): the slot, offset and type are pinned, only the name changes. */
export interface LayoutRename { contract: string; from: string; to: string; slot: string; offset: number; type: string }
export const LAYOUT_RENAMES_REL = join("scripts", "ci", "storage-layout-renames.json");
/**
 * The reviewed renames the candidate build declares (its own scripts/ci/storage-layout-renames.json, the file check-core-storage-layout.sh applies). A build without the file
 * declares none. A file that is not a list of fully pinned renames throws, so a malformed review never passes a renamed row.
 */
export function layoutRenames(buildDir: string): LayoutRename[] {
  const p = join(buildDir, LAYOUT_RENAMES_REL);
  if (!existsSync(p)) return [];
  const list = JSON.parse(readFileSync(p, "utf8"))?.renames;
  if (!Array.isArray(list) || !list.every((r: any) => typeof r?.contract === "string" && typeof r.from === "string" && typeof r.to === "string" && typeof r.slot === "string" && Number.isInteger(r.offset) && typeof r.type === "string")) {
    throw new Error(`${p}: renames must be a list of {contract, from, to, slot, offset, type}`);
  }
  return list as LayoutRename[];
}

/**
 * The runtime code gate: the new implementation's code equals the build artifact (immutables and library links masked, codehash.ts), and every library it links is the
 * build's (each library's own code compared too). `getCode` reads the chain.
 */
export async function runtimeCodeProblems(getCode: (a: Address) => Promise<Hex>, implementation: Address, outDir: string, contract: string): Promise<string[]> {
  const code = await getCode(implementation);
  if (!code || code === "0x") return [`no code at ${implementation}`];
  const res = compareCode(code, loadArtifact(outDir, contract));
  if (!res.ok) return [`${contract} at ${implementation}: ${res.detail}`];
  const bad: string[] = [];
  const seen = new Set<string>();
  const visit = async (c: Hex, artifact: string): Promise<void> => {
    for (const l of linkedLibraries(outDir, artifact)) {
      const at = (`0x${c.replace(/^0x/, "").slice(l.start * 2, (l.start + 20) * 2)}`) as Address;
      if (seen.has(`${l.name}:${lc(at)}`)) continue;
      seen.add(`${l.name}:${lc(at)}`);
      const libCode = await getCode(at);
      const r = compareCode(libCode, loadArtifact(outDir, l.name));
      if (!r.ok) { bad.push(`linked ${l.name} at ${at}: ${r.detail}`); continue; }
      await visit(libCode, l.name);
    }
  };
  await visit(code, contract);
  return bad;
}

/**
 * After an executed upgrade: the proxy's stage manifest names the new implementation, and for a pinned proxy (the gateway, issue 1810) the implementation and proxy runtime
 * hash pins equal the chain. Verify then reads the implementation slot, the pins and the code against the manifest and passes. Returns the fields written.
 */
export function rerecordProxyManifest(path: string, spec: ProxySpec, implementation: Address, implementationCodeHash: Hex, proxyCodeHash: Hex): Record<string, string> {
  const m = JSON.parse(readFileSync(path, "utf8"));
  if (!ADDR.test(String(m[spec.field]))) throw new Error(`${path} has no ${spec.field}`);
  const fields: Record<string, string> = { [spec.implementationField]: implementation };
  const pinned = PINNED_PROXIES.includes(spec.name);
  if (pinned || `${spec.implementationField}_runtime_hash` in m) fields[`${spec.implementationField}_runtime_hash`] = implementationCodeHash;
  if (pinned || `${spec.field}_runtime_hash` in m) fields[`${spec.field}_runtime_hash`] = proxyCodeHash;
  Object.assign(m, fields);
  writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
  return fields;
}

/** keccak256 of code, or null for no code. */
export const codeHashOf = (code: Hex | undefined): Hex | null => (code && code !== "0x" ? keccak256(code) : null);
