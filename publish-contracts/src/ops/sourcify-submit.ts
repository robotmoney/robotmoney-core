// Submits every contract a run deployed to Sourcify (no API key). Run from the core
// checkout at the core DEPLOY_SHA. The gate is the verifier (src/verify/sources.ts), not this command.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MAINNET_CHAIN_ID } from "../chains.ts";

export interface Deployed { name: string; address: string }
export type ForgeRunner = (args: string[], cwd: string) => Promise<{ code: number; tail: string }>;

export function createdContracts(broadcastDir: string, chainId: number): Deployed[] {
  const seen = new Set<string>(); const out: Deployed[] = [];
  for (const d of readdirSync(broadcastDir).sort()) {
    const f = join(broadcastDir, d, String(chainId), "run-latest.json");
    if (!existsSync(f)) continue;
    for (const t of JSON.parse(readFileSync(f, "utf8")).transactions ?? []) {
      if (t.transactionType !== "CREATE" || !t.contractName || !t.contractAddress) continue;
      const k = String(t.contractAddress).toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push({ name: t.contractName, address: t.contractAddress }); }
    }
  }
  return out;
}

export const realForge: ForgeRunner = async (args, cwd) => {
  const p = Bun.spawn(["forge", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, tail: `${o}${e}`.trim().split("\n").slice(-2).join(" ") };
};

export async function submitToSourcify(o: { coreDir: string; broadcastDir?: string; chainId?: number; forge?: ForgeRunner }): Promise<{ submitted: number; failed: string[] }> {
  const chainId = o.chainId ?? MAINNET_CHAIN_ID;
  const list = createdContracts(o.broadcastDir ?? join(o.coreDir, "broadcast"), chainId);
  if (list.length === 0) throw new Error("no CREATE transactions found in the broadcast directory");
  const forge = o.forge ?? realForge;
  const failed: string[] = [];
  for (const c of list) {
    const r = await forge(["verify-contract", c.address, c.name, "--chain", String(chainId), "--verifier", "sourcify"], o.coreDir);
    if (r.code !== 0) failed.push(`${c.name} ${c.address}: ${r.tail}`);
  }
  return { submitted: list.length, failed };
}
