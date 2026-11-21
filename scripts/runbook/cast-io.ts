// scripts/runbook/cast-io.ts: the one way the runbook scripts (adapter-swap.ts, flow-params.ts, fund-state.ts) read the chain and run forge:
// through the cast and forge binaries the step names, so a script makes the same calls the inline bash it replaced made. The RPC is
// ETH_RPC_URL, as every fund-upgrade step sets it. Tests pass a fake Cast instead.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** Runs `cast <args>` and returns its trimmed stdout. Throws with cast's stderr on a non-zero exit. */
export type Cast = (args: string[]) => string;

export const realCast: Cast = (args) => {
  const r = spawnSync("cast", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`cast ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`);
  return r.stdout.trim();
};

/** The first token of a value as cast prints it ("1000000 [1e6]" is 1000000). */
export const firstToken = (s: string): string => s.trim().split(/\s+/)[0] ?? "";
export const lower = (s: string): string => s.trim().toLowerCase();
export const sameAddress = (a: string, b: string): boolean => lower(firstToken(a)) === lower(firstToken(b));

/** A state file as the runner reads it ({state:X}): trimmed. */
export const readState = (path: string): string => readFileSync(path, "utf8").trim();
/** A state file as `echo value > file` writes it. */
export const writeState = (path: string, value: string): void => writeFileSync(path, `${value}\n`);

export const ZERO_HASH = `0x${"0".repeat(64)}`;

/** PURE. The 32-byte words of an ABI-encoded return value, without 0x. */
export function words(raw: string): string[] {
  const hex = raw.trim().replace(/^0x/, "");
  if (hex.length % 64 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`not ABI words: ${raw.slice(0, 80)}`);
  return hex.match(/.{64}/g) ?? [];
}
export const wordDec = (w: string): string => BigInt(`0x${w}`).toString();

/** The named options after a subcommand: --name value pairs, and the argv after `--` (a list placeholder such as {cast}). */
export function options(argv: string[]): { opts: Record<string, string>; rest: string[] } {
  const opts: Record<string, string> = {};
  const dd = argv.indexOf("--");
  const head = dd < 0 ? argv : argv.slice(0, dd);
  for (let i = 0; i < head.length; i++) {
    const k = head[i]!;
    if (!k.startsWith("--") || head[i + 1] === undefined) throw new Error(`expected --name value, got ${k}`);
    opts[k.slice(2)] = head[++i]!;
  }
  return { opts, rest: dd < 0 ? [] : argv.slice(dd + 1) };
}
export function need(opts: Record<string, string>, ...names: string[]): string[] {
  const missing = names.filter((n) => !opts[n]);
  if (missing.length) throw new UsageError(`missing ${missing.map((n) => `--${n}`).join(" ")}`);
  return names.map((n) => opts[n]!);
}
export class UsageError extends Error {}
export class CheckFailed extends Error {}
export function check(ok: boolean, what: string): void {
  if (!ok) throw new CheckFailed(what);
}

/** Runs a script's main: exit 0 on success, 1 on a failed check or a failed call, 2 on a usage error. */
export async function runMain(usage: string, main: () => void | Promise<void>): Promise<never> {
  try {
    await main();
    process.exit(0);
  } catch (e) {
    if (e instanceof UsageError) { console.error(`${e.message}\n${usage}`); process.exit(2); }
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
