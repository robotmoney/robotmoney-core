/**
 * One rehearsal, sheet to verify, through the one publish-contracts CLI: read the chain id from the RPC, refuse a sheet
 * whose CHAIN_ID differs, run the CLI with rehearsalArgs, and sweep leftovers to the funder on every exit path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Cast } from "./cast.ts";
import { argvSecretProblems, rehearsalArgs, TWIN_CHAIN_ID } from "./args.ts";
import { sweep, withCleanup, type SweepRow } from "./sweep.ts";

export class SheetChainMismatch extends Error {}

export async function chainIdFromRpc(cast: Cast, rpc: string): Promise<number> {
  const n = Number((await cast(["chain-id", "--rpc-url", rpc])).trim());
  if (!Number.isInteger(n) || n <= 0) throw new Error(`the RPC returned a bad chain id '${n}'`);
  return n;
}

/** Reads CHAIN_ID from `export NAME=value` or NAME=value sheet lines. Missing is refused. */
export function sheetChainId(sheetText: string): number {
  const m = /^\s*(?:export\s+)?CHAIN_ID\s*=\s*"?(\d+)"?\s*(?:#.*)?$/m.exec(sheetText);
  if (!m) throw new SheetChainMismatch("the sheet has no CHAIN_ID line");
  return Number(m[1]);
}

export function assertSheetMatchesRpc(sheetText: string, rpcChainId: number): void {
  const s = sheetChainId(sheetText);
  if (s !== rpcChainId) throw new SheetChainMismatch(`sheet CHAIN_ID ${s} differs from the RPC chain id ${rpcChainId}`);
}

export type Publish = (args: string[]) => Promise<number>;

/** Default: the sibling CLI, `bun src/cli.ts <args>`. No secret is ever an argument. */
export const spawnPublish: Publish = async (args) => {
  const cli = join(import.meta.dir, "..", "cli.ts");
  const p = Bun.spawn(["bun", cli, ...args], { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  return await p.exited;
};

export interface RunOptions {
  rpc: string;
  sheetPath: string;
  keyDir: string;
  passwordFile: string;
  names: string[];
  addresses: Record<string, string>;
  /** The address that receives the sweep. Omitted on a Twin fork (anvil funded the keys, nothing real to return): no sweep runs. */
  funder?: string;
  cast: Cast;
  publish?: Publish;
  environment?: string;
  deploySha?: string;
  usdc?: string;
  /** Extra publish-contracts arguments such as --core-dir, --counts-dir and --evidence (paths only, never a secret). */
  extraArgs?: string[];
  log?: (s: string) => void;
}
export interface RunResult { exitCode: number; swept: SweepRow[]; /** The exact argv handed to the publish CLI, recorded for the no-secret scan. */ argv: string[] }

export async function runRehearsal(o: RunOptions): Promise<RunResult> {
  const log = o.log ?? (() => {});
  const chainId = await chainIdFromRpc(o.cast, o.rpc);
  if (chainId !== TWIN_CHAIN_ID) throw new Error(`rehearsals run on the Twin chain ${TWIN_CHAIN_ID}; the RPC answers ${chainId}`);
  assertSheetMatchesRpc(readFileSync(o.sheetPath, "utf8"), chainId);
  const args = rehearsalArgs(chainId, o.rpc, {
    sheet: o.sheetPath, signer: `keystore:${join(o.keyDir, "DEPLOYER")}:${o.passwordFile}`, environment: o.environment, deploySha: o.deploySha,
  });
  args.push(...(o.extraArgs ?? []));
  // a secret in the argv is refused before anything is spawned (the password file path is allowed, its contents are not)
  const pw = readFileSync(o.passwordFile, "utf8").trim();
  const bad = argvSecretProblems(args, pw ? [pw] : []);
  if (bad.length) throw new Error(`refusing to spawn publish: ${bad.join("; ")}`);
  let swept: SweepRow[] = [];
  const exitCode = await withCleanup(
    async () => (o.publish ?? spawnPublish)(args),
    async () => { if (!o.funder) { log("no funder: the sweep is skipped (Twin fork)"); return; } swept = await sweep({ rpc: o.rpc, keyDir: o.keyDir, passwordFile: o.passwordFile, names: o.names, addresses: o.addresses, funder: o.funder, cast: o.cast, usdc: o.usdc, log }); },
    log,
  );
  return { exitCode, swept, argv: args };
}
