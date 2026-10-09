/**
 * Funding helper (replaces the old shell funding script). The funder keystore is delivered by the caller's credential tool in env, e.g.
 *   <credential tool> exec -- bun publish-contracts/src/rehearsal/cli.ts fund ...
 * as CHAIN_FUNDER_KEYSTORE and CHAIN_FUNDER_PASSWORD in this process's environment. They are written to a 0700 memory-backed
 * directory, handed to cast as --keystore/--password-file, and shredded on every exit path.
 * Refusals: wrong chain id, duplicate recipients, the funder as a recipient, a contract recipient, a funder balance below
 * the total plus the gas reserve, plaintext signing material against a non-loopback RPC.
 */
import { USDC_ADDRESS } from "../usdc.ts";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Cast, isLoopback, PLAINTEXT_ENV } from "./cast.ts";

export class RefusedError extends Error {}
const refuse = (m: string): never => { throw new RefusedError(m); };

export interface Recipient { name: string; address: string; ethWei: bigint; usdcUnits?: bigint }
export interface FundOptions {
  rpc: string;
  chainId: number;
  funder: string;          // address of the funder (from the persona)
  recipients: Recipient[];
  usdc?: string;           // token address when any recipient has usdcUnits
  gasReserveWei?: bigint;  // override of the funder's own gas reserve
  maxEthWeiPerRecipient?: bigint;
  signArgs: string[];      // ["--keystore", path, "--password-file", path]
  cast: Cast;
  log?: (s: string) => void;
}
export interface FundPlanRow { name: string; address: string; sendWei: bigint; sendUsdc: bigint }
export interface FundResult { plan: FundPlanRow[]; txs: { label: string; tx: string }[]; nothingToSend: boolean }

export const DEFAULT_MAX_ETH_WEI = 50_000_000_000_000_000n;
const ZERO = "0x0000000000000000000000000000000000000000";
const num = (s: string): bigint => BigInt(s.trim().split(/\s+/)[0]!);

export function checkEnvCredentialRule(env: NodeJS.ProcessEnv, rpc: string): void {
  if (isLoopback(rpc)) return;
  for (const v of PLAINTEXT_ENV) if (env[v]) refuse(`refusing plaintext signing material (${v} is set) against a non-loopback RPC`);
}

export async function planFunding(o: FundOptions): Promise<{ plan: FundPlanRow[]; needWei: bigint; needUsdc: bigint; reserve: bigint }> {
  const { cast } = o;
  const got = Number((await cast(["chain-id", "--rpc-url", o.rpc])).trim());
  if (got !== o.chainId) refuse(`RPC answers chain id ${got}, want ${o.chainId} (nothing was sent)`);
  if (!o.recipients.length) refuse("the recipient list is empty");
  const seen = new Set<string>();
  const funder = o.funder.toLowerCase();
  for (const r of o.recipients) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(r.address)) refuse(`${r.name} '${r.address}' is not an address`);
    const a = r.address.toLowerCase();
    if (a === ZERO) refuse(`${r.name} is the zero address`);
    if (a === funder) refuse(`${r.name} is the funder itself`);
    if (seen.has(a)) refuse(`the recipient list has a duplicate address (${r.name})`);
    seen.add(a);
    if (r.ethWei <= 0n) refuse(`${r.name} target must be a positive wei amount`);
    if (r.ethWei > (o.maxEthWeiPerRecipient ?? DEFAULT_MAX_ETH_WEI)) refuse(`${r.name} ${r.ethWei} wei is above the per-recipient maximum: a misread amount?`);
    if ((r.usdcUnits ?? 0n) > 0n && !o.usdc) refuse("a recipient needs USDC but no token address was given");
    if ((r.usdcUnits ?? 0n) > 0n && o.usdc!.toLowerCase() !== USDC_ADDRESS.toLowerCase()) refuse(`the USDC token must be ${USDC_ADDRESS} on every chain, got ${o.usdc}`);
    const code = await cast(["code", r.address, "--rpc-url", o.rpc]);
    if (code.trim() !== "0x") refuse(`${r.name} ${r.address} is a contract, not a wallet`);
  }
  const plan: FundPlanRow[] = [];
  let sumWei = 0n, sumUsdc = 0n, ntx = 0n;
  for (const r of o.recipients) {
    const have = num(await cast(["balance", r.address, "--rpc-url", o.rpc]));
    const haveU = (r.usdcUnits ?? 0n) > 0n ? num(await cast(["call", o.usdc!, "balanceOf(address)(uint256)", r.address, "--rpc-url", o.rpc])) : 0n;
    const sendWei = r.ethWei > have ? r.ethWei - have : 0n;
    const sendUsdc = (r.usdcUnits ?? 0n) > haveU ? (r.usdcUnits ?? 0n) - haveU : 0n;
    sumWei += sendWei; sumUsdc += sendUsdc;
    if (sendWei > 0n) ntx++;
    if (sendUsdc > 0n) ntx++;
    plan.push({ name: r.name, address: r.address, sendWei, sendUsdc });
  }
  const gp = num(await cast(["gas-price", "--rpc-url", o.rpc]));
  const reserve = o.gasReserveWei ?? gp * 100_000n * ntx * 3n + 100_000_000_000_000n;
  const fEth = num(await cast(["balance", o.funder, "--rpc-url", o.rpc]));
  const fUsdc = sumUsdc > 0n ? num(await cast(["call", o.usdc!, "balanceOf(address)(uint256)", o.funder, "--rpc-url", o.rpc])) : 0n;
  const needWei = sumWei + reserve;
  if (ntx > 0n && (fEth < needWei || fUsdc < sumUsdc)) {
    refuse(`the funder is short: holds ${fEth} wei and ${fUsdc} USDC units, needs ${needWei} wei (incl. gas reserve ${reserve}) and ${sumUsdc} USDC units. Nothing was sent.`);
  }
  return { plan, needWei, needUsdc: sumUsdc, reserve };
}

export async function fund(o: FundOptions): Promise<FundResult> {
  const log = o.log ?? (() => {});
  const { plan } = await planFunding(o);
  const txs: { label: string; tx: string }[] = [];
  if (plan.every((p) => p.sendWei === 0n && p.sendUsdc === 0n)) { log("every recipient is at or above its target: nothing to send"); return { plan, txs, nothingToSend: true }; }
  const send = async (label: string, args: string[]) => {
    const out = JSON.parse(await o.cast(["send", ...args, ...o.signArgs, "--rpc-url", o.rpc, "--json"]));
    if (out.status !== "0x1" && out.status !== 1 && out.status !== "1") refuse(`${label} reverted: ${out.transactionHash}`);
    txs.push({ label, tx: out.transactionHash }); log(`${label}: ${out.transactionHash}`);
  };
  for (const p of plan) {
    if (p.sendWei > 0n) await send(`${p.name} ETH`, [p.address, "--value", p.sendWei.toString()]);
    if (p.sendUsdc > 0n) await send(`${p.name} USDC`, [o.usdc!, "transfer(address,uint256)", p.address, p.sendUsdc.toString()]);
  }
  // verify from the chain
  for (const r of o.recipients) {
    const eh = num(await o.cast(["balance", r.address, "--rpc-url", o.rpc]));
    if (eh < r.ethWei) refuse(`${r.name} holds ${eh} wei after sending, target ${r.ethWei}`);
  }
  return { plan, txs, nothingToSend: false };
}

/**
 * Writes the funder keystore pair from the environment into a fresh 0700 memory-backed directory. The caller runs `done()`
 * on every exit path (try/finally plus signal handlers) to shred it.
 */
export function stageFunderKeystore(env: NodeJS.ProcessEnv, base = env.XDG_RUNTIME_DIR || "/dev/shm"): { signArgs: string[]; done: () => void; dir: string } {
  const ks = env.CHAIN_FUNDER_KEYSTORE, pw = env.CHAIN_FUNDER_PASSWORD;
  if (!ks || !pw) refuse("CHAIN_FUNDER_KEYSTORE and CHAIN_FUNDER_PASSWORD are required: the caller's credential tool must set them");
  if (!existsSync(base) || !statSync(base).isDirectory()) refuse(`no memory-backed directory (${base}) for the temporary keystore`);
  try { JSON.parse(ks!).crypto ?? refuse("x"); } catch { refuse("CHAIN_FUNDER_KEYSTORE is not a keystore JSON (no crypto section)"); }
  const dir = mkdtempSync(join(base, "rehearsal-fund."));
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "funder.json"), ks!, { mode: 0o600 });
  writeFileSync(join(dir, "pw"), pw!, { mode: 0o600 });
  const done = () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, signArgs: ["--keystore", join(dir, "funder.json"), "--password-file", join(dir, "pw")], done };
}
