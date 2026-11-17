import { artifactJson, linkedLibraries } from "./verify/codehash.ts";
import { runtimeCodeProblems } from "./upgrade-rows.ts";
import type { Address, Hex } from "viem";

type Entry = { name: string; build: string; address: Address; deploy_tx: Hex; code_hash?: Hex };
/** Resolve a fund upgrade's library graph. Every reused or newly deployed library
 * is checked against the candidate build, including its recursive links. */
export async function upgradeLibraries(i: {
  contract: string; out: string; build: string; candidates: Record<string, Address>; recorded: Entry[];
  getCode: (a: Address) => Promise<Hex>; create: (code: Hex) => Promise<{ txHash: Hex; status: boolean; address: Address | null }>;
  link: (artifact: any, libraries: Record<string, Address>, contract: string) => { code?: Hex; problems: string[] };
  beforeCreate: (name: string) => Promise<void>; record: (entry: Entry) => Promise<void>;
}): Promise<Record<string, Address>> {
  const deps = (n: string) => [...new Set(linkedLibraries(i.out, n).map((l) => l.name))];
  const visiting = new Set<string>(), checked = new Set<string>();
  // Load and validate the entire graph before a CREATE is possible.
  const preflight = (n: string) => {
    if (visiting.has(n)) throw new Error(`cyclic library graph at ${n}`);
    if (checked.has(n)) return;
    visiting.add(n);
    const a = artifactJson(i.out, n);
    if (!a?.bytecode?.object) throw new Error(`no creation code for ${n}`);
    const dependencies = deps(n);
    const placeholders = Object.fromEntries(dependencies.map((d) => [d, "0x0000000000000000000000000000000000000001" as Address]));
    const linked = i.link(a, placeholders, n);
    if (!linked.code) throw new Error(`${n}: ${linked.problems.join("; ")}`);
    for (const d of dependencies) preflight(d);
    visiting.delete(n); checked.add(n);
  };
  preflight(i.contract);
  const resolved: Record<string, Address> = {};
  const resolve = async (name: string): Promise<Address> => {
    if (resolved[name]) return resolved[name]!;
    const prior = [...i.recorded].reverse().find((e) => e.name === name && e.build === i.build);
    for (const candidate of [prior?.address, i.candidates[name]]) {
      if (!candidate) continue;
      try { if ((await runtimeCodeProblems(i.getCode, candidate, i.out, name)).length === 0) return resolved[name] = candidate; } catch { /* a stale recorded address cannot be reused */ }
    }
    const libraries: Record<string, Address> = {};
    for (const d of deps(name)) libraries[d] = await resolve(d);
    const linked = i.link(artifactJson(i.out, name), libraries, name);
    if (!linked.code) throw new Error(`${name}: ${linked.problems.join("; ")}`);
    await i.beforeCreate(name);
    const sent = await i.create(linked.code);
    if (!sent.status || !sent.address) throw new Error(`${name} deployment ${sent.txHash} failed`);
    const bad = await runtimeCodeProblems(i.getCode, sent.address, i.out, name);
    if (bad.length) throw new Error(`${name} deployment ${sent.txHash} failed verification: ${bad.join("; ")}`);
    const entry = { name, build: i.build, address: sent.address, deploy_tx: sent.txHash };
    await i.record(entry);
    return resolved[name] = sent.address;
  };
  const direct: Record<string, Address> = {};
  for (const d of deps(i.contract)) direct[d] = await resolve(d);
  return direct;
}
