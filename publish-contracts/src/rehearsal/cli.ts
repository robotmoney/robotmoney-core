#!/usr/bin/env bun
/**
 * rehearsal helpers.
 *   keys  --dir D (--password-file F | prompts hidden) [--voters N] [--chain-id C]   makes keystores, prints the sheet fragment
 *   fund  --rpc R --chain-id C --sheet S [--eth-wei N] [--usdc A --usdc-units N]      needs CHAIN_FUNDER_KEYSTORE and CHAIN_FUNDER_PASSWORD from the caller's credential tool
 *   fund-gas  --rpc R --sheet S [--wei N]     Twin fork only (anvil_setBalance): sets the gas balance of the deployer, pauser, emergency key and Safe owners
 *   fund-usdc --rpc R --sheet S --usdc-units N  Twin fork only: sets the real FiatToken balance of the deployer through its balance storage slot
 *   fund-rm-pool --rpc R --core-dir D        Twin fork only: real in-range liquidity on the live Uniswap V4 RM/USDC pool through the real PositionManager (core 1676)
 *   warp  --rpc R --seconds N                  Twin fork only: moves chain time forward (evm_increaseTime + evm_mine)
 *   args  --rpc R [--sheet S --signer X --environment E --core-sha H]               prints the publish-contracts arguments
 *   run   --rpc R --dir D --password-file F --sheet S                                 publish, then sweep to the funder
 * Nothing secret is ever an argument or output.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { hidden } from "../keystore/prompt.ts";
import { realCast } from "./cast.ts";
import { rehearsalArgs, TWIN_CHAIN_ID } from "./args.ts";
import { assertPassword, defaultKeyNames, makeRehearsalKeys, sheetFragment } from "./keys.ts";
import { checkEnvCredentialRule, fund, stageFunderKeystore, type Recipient } from "./fund.ts";
import { runRehearsal } from "./run.ts";
import { TWIN_GAS_WEI, fundGas, fundRmPool, fundUsdc, httpRpc, isTwinFork, readRmPoolFacts, warpBy } from "./twin.ts";
import { USDC_ADDRESS } from "../usdc.ts";

export function flags(argv: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument '${a}'`);
    if (/^--(private-key|password|passphrase|mnemonic)$/.test(a)) throw new Error("secrets are never arguments");
    const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`);
    o[a.slice(2)] = v;
  }
  return o;
}
const need = (f: Record<string, string>, k: string): string => f[k] ?? (() => { throw new Error(`--${k} is required`); })();

const sheetValue = (sheet: string, n: string): string | undefined => new RegExp(`^\\s*(?:export\\s+)?${n}\\s*=\\s*"?([^\\s"#]*)"?\\s*(?:#.*)?$`, "m").exec(sheet)?.[1]?.trim();
/** The throwaway wallets of a sheet: the deployer, the pauser, the emergency key and every Safe owner. */
function sheetWallets(sheet: string): { name: string; address: string }[] {
  const out: { name: string; address: string }[] = [];
  const add = (name: string, a: string | undefined) => { if (!a) throw new Error(`the sheet has no ${name}`); out.push({ name, address: a }); };
  add("deployer", sheetValue(sheet, "ADMIN_ADDRESS")); add("pauser", sheetValue(sheet, "PAUSER_ADDRESS")); add("emergency", sheetValue(sheet, "EMERGENCY_ADDRESS"));
  (sheetValue(sheet, "SAFE_OWNERS") ?? "").split(",").map((x) => x.trim()).filter(Boolean).forEach((a, i) => add(`safeOwner${i}`, a));
  return out;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  const log = (s: string) => console.error(`[rehearsal] ${s}`);
  switch (cmd) {
    case "keys": {
      const dir = need(f, "dir");
      let pwFile = f["password-file"];
      if (!pwFile) {
        // hidden prompt: the passphrase goes to a 0600 file beside the keys directory, never to an argument
        const pw = await hidden("Rehearsal key passphrase (16+ chars): ");
        assertPassword(pw);
        pwFile = `${dir.replace(/\/$/, "")}.pw`;
        if (existsSync(pwFile)) throw new Error(`${pwFile} already exists`);
        writeFileSync(pwFile, pw, { mode: 0o600 }); chmodSync(pwFile, 0o600);
        log(`passphrase file written (mode 0600): ${pwFile}`);
      }
      const keys = makeRehearsalKeys({ dir, passwordFile: pwFile, voters: f.voters ? Number(f.voters) : undefined });
      process.stdout.write(sheetFragment(keys, f["chain-id"] ? Number(f["chain-id"]) : undefined));
      return 0;
    }
    case "fund": {
      const rpc = need(f, "rpc"), chainId = Number(need(f, "chain-id"));
      checkEnvCredentialRule(env, rpc);
      const funder = env.CHAIN_FUNDER_ADDRESS ?? need(f, "funder");
      const sheet = readFileSync(need(f, "sheet"), "utf8");
      const val = (n: string) => new RegExp(`^\\s*(?:export\\s+)?${n}\\s*=\\s*"?([^"\\n#]*?)"?\\s*$`, "m").exec(sheet)?.[1]?.trim();
      const eth = BigInt(f["eth-wei"] ?? "20000000000000000");
      const usdcUnits = f["usdc-units"] ? BigInt(f["usdc-units"]) : undefined;
      const rec: Recipient[] = [];
      const add = (name: string, a: string | undefined, u?: bigint) => { if (!a) throw new Error(`the sheet has no ${name}`); rec.push({ name, address: a, ethWei: eth, usdcUnits: u }); };
      add("deployer", val("ADMIN_ADDRESS"), usdcUnits); add("pauser", val("PAUSER_ADDRESS")); add("emergency", val("EMERGENCY_ADDRESS"));
      (val("SAFE_OWNERS") ?? "").split(",").map((s) => s.trim()).filter(Boolean).forEach((a, i) => add(`safeOwner${i}`, a));
      const staged = stageFunderKeystore(env);
      const onSig = () => { staged.done(); process.exit(130); };
      process.on("SIGINT", onSig); process.on("SIGTERM", onSig);
      try { const r = await fund({ rpc, chainId, funder, recipients: rec, usdc: f.usdc ?? USDC_ADDRESS, signArgs: staged.signArgs, cast: realCast, log }); log(`funded ${r.txs.length} transfers`); return 0; }
      finally { staged.done(); }
    }
    case "fund-gas": {
      const rpc = httpRpc(need(f, "rpc"));
      const wallets = sheetWallets(readFileSync(need(f, "sheet"), "utf8"));
      await fundGas(rpc, wallets.map((w) => w.address), BigInt(f.wei ?? TWIN_GAS_WEI));
      log(`gas set for ${wallets.length} wallets (${wallets.map((w) => w.name).join(", ")})`);
      return 0;
    }
    case "fund-usdc": {
      const rpc = httpRpc(need(f, "rpc"));
      const units = BigInt(need(f, "usdc-units"));
      const deployer = sheetWallets(readFileSync(need(f, "sheet"), "utf8"))[0]!;
      await fundUsdc(rpc, [deployer.address], units);
      log(`USDC set to ${units} units for the ${deployer.name}`);
      return 0;
    }
    case "fund-rm-pool": {
      // Twin fork only (core 1554, 1676): real in-range liquidity on the live Uniswap V4 RM/USDC pool, through the real PositionManager, so rmAGENT trades RM at depth.
      const r = await fundRmPool(httpRpc(need(f, "rpc")), readRmPoolFacts(need(f, "core-dir")));
      log(`RM V4 pool funded: liquidity ${r.liquidityBefore} -> ${r.liquidity}, tick ${r.tick}, position ticks [${r.ticks[0]}, ${r.ticks[1]}]`);
      return 0;
    }
    case "warp": {
      const t = await warpBy(httpRpc(need(f, "rpc")), BigInt(need(f, "seconds")));
      log(`chain time is now ${t}`);
      return 0;
    }
    case "args": {
      console.log(rehearsalArgs(Number(f.chain ?? f["chain-id"] ?? TWIN_CHAIN_ID), need(f, "rpc"), { sheet: f.sheet, signer: f.signer, environment: f.environment, deploySha: f["core-sha"] ?? f["deploy-sha"] }).join(" "));
      return 0;
    }
    case "run": {
      const dir = need(f, "dir");
      const names = defaultKeyNames(f.voters ? Number(f.voters) : undefined);
      const addresses: Record<string, string> = {};
      for (const n of names) addresses[n] = "0x" + (JSON.parse(readFileSync(join(dir, n), "utf8")).address as string);
      // On a Twin fork the keys were funded by anvil, so there is nothing real to return and no funder: no sweep.
      const twin = await isTwinFork(httpRpc(need(f, "rpc")));
      const funder = twin ? undefined : env.CHAIN_FUNDER_ADDRESS ?? need(f, "funder");
      const r = await runRehearsal({ rpc: need(f, "rpc"), sheetPath: need(f, "sheet"), keyDir: dir, passwordFile: need(f, "password-file"), names, addresses, funder, cast: realCast, environment: f.environment, deploySha: f["core-sha"] ?? f["deploy-sha"], usdc: f.usdc ?? USDC_ADDRESS, log,
        extraArgs: ["core-dir", "counts-dir", "evidence"].flatMap((k) => (f[k] === undefined ? [] : [`--${k}`, f[k]!])) });
      // the argv of the spawned publish CLI is recorded (no secret can be in it: run.ts refuses one) so CI can scan it
      if (f.evidence) { mkdirSync(f.evidence, { recursive: true }); writeFileSync(join(f.evidence, "spawn-args.txt"), ["bun", "src/cli.ts", ...r.argv].join("\n") + "\n"); }
      return r.exitCode;
    }
    default:
      console.error("usage: rehearsal <keys|fund|fund-gas|fund-usdc|fund-rm-pool|warp|args|run> ...");
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`rehearsal: ${e instanceof Error ? e.message : e}`); process.exit(2); });
}
