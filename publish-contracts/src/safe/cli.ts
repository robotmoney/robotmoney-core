#!/usr/bin/env bun
// Safe CLI: replaces the old shell Safe tool (propose, show, sign, execute) and the `safe` stage of the old stage script (create).
// No shell. Secrets never come from arguments: a signer is `ledger`, `trezor`, `keystore:PATH[:PASSFILE]` (hidden prompt when no file)
// or `env:signer` / `env:funder` (the credential engine's hand-off).
//
//   safe-cli create  --rpc URL --chain-id N --owners A,B,C --threshold T --signer SPEC [--salt-nonce N] [--deploy-sha SHA] [--yes] [--dry-run] [--out safe.json]
//   safe-cli propose --rpc URL --chain-id N --safe A --timelock A --action ACTION --out bundle.json [action flags]
//   safe-cli show    --rpc URL --chain-id N --bundle F
//   safe-cli sign    --rpc URL --chain-id N --bundle F --signer SPEC [--mode raw|eth_sign]
//   safe-cli import  --rpc URL --chain-id N --bundle F --signatures FILE_OR_HEX
//   safe-cli execute --rpc URL --chain-id N --bundle F --signer SPEC   (the gas payer)
// Actions: schedule|execute (--target --data [--value]), scheduleBatch|executeBatch (--targets --datas [--values]), cancel (--id),
//          updateDelay (--new-delay SECONDS --phase schedule|execute [--allow-unsafe-delay yes]); all take --salt, [--predecessor], [--delay].
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { SafeToolError } from "./errors.ts";
import { jsonLogger } from "./log.ts";
import { connectSafe, createSafe } from "./safe.ts";
import { signerFromSpec } from "./signers.ts";
import {
  cancelOnTimelock, executeOnTimelock, scheduleOnTimelock, updateTimelockDelay, verifyTimelockEffect, type TimelockCall,
} from "./timelock.ts";
import { describeBundle, executeTx, importSignatureBundle, proposeTx, readBundle, signTx, writeBundle } from "./tx.ts";
import { assertNoPlaintextKeys } from "./guard.ts";

export function parseFlags(argv: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--yes" || a === "--dry-run") { o[a.slice(2)] = "1"; continue; }
    if (!a.startsWith("--")) throw new SafeToolError("BAD_INPUT", `unexpected argument '${a}'`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new SafeToolError("BAD_INPUT", `flag ${a} needs a value`);
    o[a.slice(2)] = v; i++;
  }
  return o;
}

const need = (f: Record<string, string>, k: string): string => { const v = f[k]; if (!v) throw new SafeToolError("BAD_INPUT", `--${k} is required`); return v; };
const csv = (s: string | undefined): string[] => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

export function callsFromFlags(f: Record<string, string>): TimelockCall[] {
  const batch = f.action === "scheduleBatch" || f.action === "executeBatch";
  const targets = batch ? csv(f.targets) : [need(f, "target")];
  const datas = batch ? csv(f.datas) : [need(f, "data")];
  const values = batch ? csv(f.values) : [f.value ?? "0"];
  const vals = values.length ? values : targets.map(() => "0");
  if (targets.length !== datas.length || targets.length !== vals.length) throw new SafeToolError("BAD_INPUT", "--targets, --datas and --values must have the same length");
  return targets.map((t, i) => ({ target: t as Address, data: datas[i] as Hex, value: BigInt(vals[i]!) }));
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd) throw new SafeToolError("BAD_INPUT", "usage: safe-cli <create|propose|show|sign|import|execute> [flags] (see the header of cli.ts)");
  const f = parseFlags(rest);
  const rpcUrl = f.rpc ?? process.env.ETH_RPC_URL;
  if (!rpcUrl) throw new SafeToolError("BAD_INPUT", "set --rpc or ETH_RPC_URL");
  const chainId = Number(f["chain-id"] ?? process.env.CHAIN_ID ?? 8453);
  const extra = csv(f["allow-chain-ids"]).map(Number);
  assertNoPlaintextKeys(rpcUrl, process.env);
  const logger = jsonLogger();
  const chain = { rpcUrl, chainId, allowChainIds: extra };

  if (cmd === "create") {
    const deployer = await signerFromSpec(need(f, "signer"), f["hd-path"]);
    const res = await createSafe({
      ...chain, owners: csv(need(f, "owners")), threshold: Number(need(f, "threshold")), deployer, saltNonce: f["salt-nonce"], deploySha: f["deploy-sha"],
      expectDeployerNonce: f["expect-deployer-nonce"] !== undefined ? Number(f["expect-deployer-nonce"]) : undefined, dryRun: f["dry-run"] === "1", logger,
      forbiddenOwners: Object.fromEntries(["ADMIN_ADDRESS", "PAUSER_ADDRESS", "EMERGENCY_ADDRESS"].map((k) => [k, process.env[k]])),
      confirm: f.yes === "1" ? undefined : async (plan) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));
        process.stderr.write(`About to BROADCAST the Safe creation on chain ${plan.chainId} from ${plan.deployer}. Owners and threshold are permanent for the timelock.\n`);
        const a1 = await ask("Operator, type 'safe' to go: "); const a2 = await ask("Reviewer, type 'safe' to go: "); rl.close();
        return a1 === "safe" && a2 === "safe";
      },
    });
    if (res.manifest && f.out) writeFileSync(f.out, JSON.stringify(res.manifest, null, 2) + "\n");
    console.log(JSON.stringify(res.manifest ?? { plan: { ...res.plan, estimatedGas: res.plan.estimatedGas.toString() } }, null, 2));
    return 0;
  }

  const safeAddress = (f.safe ?? (f.bundle ? readBundle(f.bundle).safe : undefined)) as Address | undefined;
  if (!safeAddress) throw new SafeToolError("BAD_INPUT", "--safe ADDRESS (or --bundle FILE) is required");
  const handle = await connectSafe({ ...chain, safeAddress, logger });

  switch (cmd) {
    case "propose": {
      const timelock = need(f, "timelock") as Address;
      const common = { timelock, out: need(f, "out"), description: f.description };
      const salt = f.salt as Hex;
      const predecessor = f.predecessor as Hex | undefined;
      const delay = f.delay ? BigInt(f.delay) : undefined;
      switch (f.action) {
        case "schedule": case "scheduleBatch":
          await scheduleOnTimelock(handle, { ...common, calls: callsFromFlags(f), salt, predecessor, delay, form: f.action === "schedule" ? "single" : "batch" }); break;
        case "execute": case "executeBatch":
          await executeOnTimelock(handle, { ...common, calls: callsFromFlags(f), salt, predecessor, form: f.action === "execute" ? "single" : "batch" }); break;
        case "cancel": await cancelOnTimelock(handle, { ...common, id: need(f, "id") as Hex }); break;
        case "updateDelay":
          await updateTimelockDelay(handle, { ...common, newDelay: BigInt(need(f, "new-delay")), phase: (f.phase ?? "schedule") as "schedule" | "execute", salt, predecessor, delay, allowUnsafeDelay: Boolean(f["allow-unsafe-delay"]) }); break;
        default: throw new SafeToolError("BAD_INPUT", "--action must be one of schedule, execute, scheduleBatch, executeBatch, cancel, updateDelay");
      }
      console.error(`bundle written to ${common.out}. Next: each owner runs 'sign', then any funded account runs 'execute'.`);
      return 0;
    }
    case "show": {
      const b = readBundle(need(f, "bundle"));
      console.log([`Safe ${b.safe} chain ${b.chain_id} nonce ${b.nonce} threshold ${b.threshold} of ${b.owners.length}`, `action ${b.action}: ${b.description}`, `Safe transaction hash ${b.safe_tx_hash}`, ...describeBundle(b).map((l) => "    " + l), `signatures: ${b.signatures.length} of ${b.threshold}`, ...b.signatures.map((s) => "    " + s.owner)].join("\n"));
      return 0;
    }
    case "sign": {
      const b = readBundle(need(f, "bundle"));
      console.error("REVIEW before signing. This Safe transaction, if executed, calls:\n" + describeBundle(b).map((l) => "    " + l).join("\n"));
      const signer = await signerFromSpec(f.signer ?? "env:signer", f["hd-path"]);
      writeBundle(f.bundle!, await signTx(handle, b, signer, { mode: f.mode as "raw" | "eth_sign" | undefined }));
      return 0;
    }
    case "import": {
      const b = readBundle(need(f, "bundle"));
      writeBundle(f.bundle!, await importSignatureBundle(handle, b, need(f, "signatures")));
      return 0;
    }
    case "execute": {
      const b = readBundle(need(f, "bundle"));
      const sender = await signerFromSpec(f.signer ?? "env:funder", f["hd-path"]);
      const r = await executeTx(handle, b, sender, { dryRun: f["dry-run"] === "1" });
      if (!r.simulated) {
        if (b.timelock) await verifyTimelockEffect(handle, b);
        writeBundle(f.bundle!, r.bundle);
      }
      console.log(JSON.stringify({ tx_hash: r.txHash, block: r.block, safe_tx_hash: b.safe_tx_hash, simulated: r.simulated }));
      return 0;
    }
    default: throw new SafeToolError("BAD_INPUT", `unknown subcommand '${cmd}'`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    const code = e instanceof SafeToolError ? e.code : "UNEXPECTED";
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "safe.fatal", code, message: e instanceof Error ? e.message : String(e) }) + "\n");
    process.exit(1);
  });
}
export { main };
// proposeTx re-exported for callers that build non-timelock bundles from the CLI module
export { proposeTx };
