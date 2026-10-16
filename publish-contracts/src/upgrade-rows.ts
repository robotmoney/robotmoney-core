// Issue 1842: the operator rows of the governed upgrade lifecycle (upgradeability stages 2 and 4 follow-ups). Both run through the Safe and the timelock in runGovern
// (src/govern.ts); this module holds their pure parts: the freeze targets read from upgradeability.json, the calls, the storage-layout gate, the runtime code check and
// the manifest re-record. It reads files and the chain only through its arguments and sends nothing.
//
//   govern --row freeze-upgrades   ONE timelock batch: freezeUpgrades(implementation, implementation_code_hash) on every unfrozen core proxy, both values taken from the
//                                  latest deployments/<chain>/upgradeability.json (the record verify writes). Refused while an upgrade operation is pending on the timelock.
//   govern --row upgrade-proxy --proxy NAME --implementation ADDR [--upgrade-build DIR]
//                                  ONE timelock call: upgradeToAndCall(ADDR, "") on the named proxy. Refused before scheduling when the proxy is frozen, when the new
//                                  implementation's storage layout does not extend the deployed snapshot append-only, or when its runtime code is not the build artifact.
//                                  After the execute it rewrites the proxy's stage manifest implementation fields (and the gateway's runtime hash pins), so verify is green.
//
// Canonical: docs/technical/contract-upgradeability-plan.md, docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md, docs/operations/contract-release-runbooks.md 4.12.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { freezeCalldata, upgradeCalldata, type FreezeTarget } from "./upgrade-lifecycle.ts";
import { compareCode, linkedLibraries, loadArtifact } from "./verify/codehash.ts";
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
export const upgradeRecordKey = (proxy: string, implementation: string): string => `${UPGRADE_ROW}-${proxy}-${implementation.toLowerCase()}`;

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
export function buildUpgradeCall(name: string, proxy: Address, implementation: Address): LabelledProxyCall {
  return { label: `${name}.upgradeToAndCall(${implementation}, "")`, target: proxy, data: upgradeCalldata(implementation) };
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
export function layoutExtensionProblems(deployed: any, candidate: any): string[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const ext = (old: unknown[] = [], neu: unknown[] = []) => old.length <= neu.length && old.every((x, i) => same(x, neu[i]));
  const bad: string[] = [];
  if (!ext(deployed?.storage, candidate?.storage)) bad.push("storage: a variable moved, was retyped or removed");
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
  return layoutExtensionProblems(JSON.parse(readFileSync(join(coreDir, spec.layout), "utf8")), JSON.parse(readFileSync(join(buildDir, spec.layout), "utf8")));
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
