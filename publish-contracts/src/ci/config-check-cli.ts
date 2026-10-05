#!/usr/bin/env bun
// bun src/ci/config-check-cli.ts --rpc URL --core-dir DIR [--chain N]
// Read-only. Exit 0 when every configured asset passes, 13 (verify) when any check fails, 20 when the config is missing.
import { parseArgs } from "node:util";
import { exitCodeOf } from "../errors.ts";
import { viemReader } from "../verify/reader.ts";
import { configCheck, loadConfiguredAssets } from "./config-check.ts";

export async function main(argv: string[]): Promise<number> {
  try {
    const { values: v } = parseArgs({ args: argv, strict: true, options: { rpc: { type: "string" }, "core-dir": { type: "string" }, chain: { type: "string" } } });
    if (!v.rpc || !v["core-dir"]) { console.error("usage: config-check-cli --rpc URL --core-dir DIR [--chain N]"); return 2; }
    const chain = viemReader(v.rpc);
    const id = await chain.chainId();
    if (v.chain && Number(v.chain) !== id) { console.error(JSON.stringify({ level: "error", msg: "config_check.chain_mismatch", rpc_chain_id: id, want: Number(v.chain) })); return 5; }
    const report = await configCheck(chain, loadConfiguredAssets(v["core-dir"]));
    for (const c of report.checks) console.error(JSON.stringify({ level: c.ok ? "info" : "error", msg: "config_check", label: c.label, ok: c.ok, detail: c.ok ? undefined : c.detail }));
    console.log(JSON.stringify({ chainId: id, ok: report.ok, checks: report.checks.length, failed: report.checks.filter((c) => !c.ok).length }));
    return report.ok ? 0 : 13;
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "config_check.failed", message: (e as Error).message }));
    return exitCodeOf(e);
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
