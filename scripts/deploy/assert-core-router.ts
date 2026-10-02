#!/usr/bin/env bun
// Canonical: the one-deployment-scheme plan, core S3 (issue 1485), core 1493.
//
// Twin chain proof for the router-first split. Reads the manifest the core stages wrote and asserts,
// on chain:
//   1. gateway.router() is not zero and equals the manifest router.
//   2. registry.router() equals the router.
//   3. A router deposit through the gateway succeeds (the agent holds the shares' receiver as share
//      receiver, the policy the gateway stage wrote).
//   4. A router withdraw through the gateway succeeds and the USDC returns.
// It then writes the per-stage transaction counts from the manifest, and the results, to --out.
// Exit 0 only when every assertion holds.
//
// No key is read here. The agent and the share receiver sign through flags the caller passes
// (`--agent-arg`, `--receiver-arg`), for example `--agent-arg --account --agent-arg rehearsal-agent`.
// The caller funds the agent with USDC (an allowed environment step); this script never mints.
//
// Usage:
//   bun scripts/deploy/assert-core-router.ts --rpc-url URL --manifest M.json --out PROOF.json
//        [--amount 5000000] [--agent-arg A]... [--receiver-arg A]... [--read-only]
//
// --read-only runs checks 1 and 2 only (two `cast call`s, no signer). The Twin chain publish job uses it:
// the share receiver there is a keyless address, so the signed round trip (checks 3 and 4) runs where
// both signers exist. The mode is explicit and the output records `"mode": "read-only"`.
import { readFileSync, writeFileSync } from "node:fs";

const ZERO = "0x0000000000000000000000000000000000000000";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed (${code}): ${err || out}`);
  return out.trim();
}

const norm = (a: string) => a.trim().toLowerCase();

/** Pure rule for the first two checks, so a test can drive it without a chain. */
export function routerChecks(m: Record<string, string>, gatewayRouter: string, registryRouter: string): Check[] {
  return [
    {
      name: "gateway.router() is not zero",
      ok: norm(gatewayRouter) !== ZERO,
      detail: gatewayRouter,
    },
    {
      name: "gateway.router() equals the deployed router",
      ok: norm(gatewayRouter) === norm(m.router),
      detail: `${gatewayRouter} vs ${m.router}`,
    },
    {
      name: "registry.router() equals the deployed router",
      ok: norm(registryRouter) === norm(m.router),
      detail: `${registryRouter} vs ${m.router}`,
    },
  ];
}

function parseArgs(argv: string[]) {
  const a = { rpc: "", manifest: "", out: "", readOnly: false, amount: 5_000_000n, agentArgs: [] as string[], receiverArgs: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--rpc-url") a.rpc = argv[++i];
    else if (k === "--manifest") a.manifest = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--read-only") a.readOnly = true;
    else if (k === "--amount") a.amount = BigInt(argv[++i]);
    else if (k === "--agent-arg") a.agentArgs.push(argv[++i]);
    else if (k === "--receiver-arg") a.receiverArgs.push(argv[++i]);
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.rpc || !a.manifest || !a.out) throw new Error("--rpc-url, --manifest and --out are required");
  for (const f of [...a.agentArgs, ...a.receiverArgs]) {
    if (/^--(private-key|password)(=|$)/.test(f)) throw new Error(`${f} is refused: no secret in an argument`);
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const m = JSON.parse(readFileSync(a.manifest, "utf8")) as Record<string, any>;
  const required = a.readOnly
    ? ["gateway", "router", "registry"]
    : ["gateway", "router", "registry", "vault", "usdc", "agent", "share_receiver"];
  for (const k of required) {
    if (!m[k]) throw new Error(`manifest lacks "${k}"`);
  }
  const call = (to: string, sig: string, ...args: string[]) =>
    sh(["cast", "call", to, sig, ...args, "--rpc-url", a.rpc]);
  const send = async (signer: string[], to: string, sig: string, ...args: string[]) => {
    const out = await sh(["cast", "send", to, sig, ...args, "--rpc-url", a.rpc, "--json", ...signer]);
    const r = JSON.parse(out);
    if (r.status !== "0x1" && r.status !== 1 && r.status !== "1") throw new Error(`${sig} reverted: ${out}`);
    return r;
  };

  const checks: Check[] = [];
  const gatewayRouter = (await call(m.gateway, "router()(address)")).split(/\s/)[0];
  const registryRouter = (await call(m.registry, "router()(address)")).split(/\s/)[0];
  checks.push(...routerChecks(m, gatewayRouter, registryRouter));
  if (a.readOnly) {
    const ok = checks.every((c) => c.ok);
    writeFileSync(a.out, JSON.stringify({ ok, mode: "read-only", checks }, null, 2) + "\n");
    for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
    process.exit(ok ? 0 : 1);
  }

  // Router deposit through the gateway.
  const usdcOf = async (who: string) => BigInt((await call(m.usdc, "balanceOf(address)(uint256)", who)).split(/\s/)[0]);
  const sharesOf = async (who: string) => BigInt((await call(m.vault, "balanceOf(address)(uint256)", who)).split(/\s/)[0]);
  const agentUsdc = await usdcOf(m.agent);
  if (agentUsdc < a.amount) throw new Error(`agent holds ${agentUsdc} USDC units, needs ${a.amount}: fund it first`);
  const deadline = String(Math.floor(Date.now() / 1000) + 300);
  const tag = String(Date.now());
  const idem = (s: string) => "0x" + Buffer.from(`core-s3-${s}-${tag}`).toString("hex").padEnd(64, "0").slice(0, 64);

  await send(a.agentArgs, m.usdc, "approve(address,uint256)", m.gateway, a.amount.toString());
  const sharesBefore = await sharesOf(m.share_receiver);
  await send(
    a.agentArgs,
    m.gateway,
    "depositTo(bytes32,uint256,uint64,bytes32,address,uint256[])",
    idem("dep-order"),
    a.amount.toString(),
    deadline,
    idem("dep-idem"),
    m.router,
    "[]",
  );
  const minted = (await sharesOf(m.share_receiver)) - sharesBefore;
  checks.push({ name: "router deposit succeeded", ok: minted > 0n, detail: `${minted} rmUSDC share units minted` });

  // Router withdraw through the gateway: the receiver lets the gateway pull its shares.
  await send(a.receiverArgs, m.vault, "approve(address,uint256)", m.gateway, minted.toString());
  const recipient = m.share_receiver; // the stage policy sets assetRecipient to the share receiver
  const usdcBefore = await usdcOf(recipient);
  await send(
    a.agentArgs,
    m.gateway,
    "withdrawFromRouter(bytes32,address[],uint256[],uint256[],uint64,bytes32)",
    idem("wd-order"),
    `[${m.vault}]`,
    `[${minted}]`,
    "[0]",
    deadline,
    idem("wd-idem"),
  );
  const returned = (await usdcOf(recipient)) - usdcBefore;
  // One bps of venue rounding is allowed, the same tolerance as the seed deposit check.
  checks.push({
    name: "router withdraw succeeded",
    ok: returned >= (a.amount * 9_999n) / 10_000n,
    detail: `${returned} USDC units returned for ${a.amount} deposited`,
  });

  const stages = Array.isArray(m.stages) ? m.stages : [];
  checks.push({ name: "per-stage transaction counts recorded", ok: stages.length > 0, detail: JSON.stringify(stages.map((s: any) => [s.stage, s.tx_count])) });

  const ok = checks.every((c) => c.ok);
  writeFileSync(a.out, JSON.stringify({ ok, checks, stages }, null, 2) + "\n");
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
  process.exit(ok ? 0 : 1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(String(e.message ?? e));
    process.exit(1);
  });
}
