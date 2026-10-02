#!/usr/bin/env bun
// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops), core S1 (issue 1483) and S5 (issue 1487).
//
// Twin chain proof for the timelock stage. Run after `core-stages.ts` has run the full stage table
// (Deploy, then DeployTimelock). Reads the merged manifest and asserts, with read-only `cast call`:
//   - the timelock holds PROPOSER and EXECUTOR for the Safe only, and the delay equals the input
//   - on each of the four vaults: ADMIN is the timelock, EMERGENCY is the emergency key, the
//     deployer holds neither, registry() equals the registry, and a second setRegistry reverts
//   - on the gateway: ADMIN and DEFAULT_ADMIN are the timelock, the deployer holds neither
//   - on the registry, router, governance, IC policy and receipt: ADMIN is the timelock, the
//     deployer holds none
//   - the registry lists all four vaults
// It sends no transaction and reads no key.
//
// Usage:
//   bun scripts/deploy/assert-timelock-roles.ts --rpc-url URL --manifest M.json --deployer 0x..
//        --safe 0x.. --emergency 0x.. --min-delay N --out PROOF.json
import { readFileSync, writeFileSync } from "node:fs";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Everything the checks read from the chain. A test passes a fake. */
export interface Reader {
  role(name: string): Promise<string>;
  hasRole(contract: string, role: string, account: string): Promise<boolean>;
  addressOf(contract: string, sig: string): Promise<string>;
  uintOf(contract: string, sig: string): Promise<bigint>;
  listVaults(registry: string): Promise<string[]>;
  /** True when a call from `from` to setRegistry(registry) on the vault reverts. */
  setRegistryReverts(vault: string, registry: string, from: string): Promise<boolean>;
  agentOwner(gateway: string, agent: string): Promise<string>;
}

export interface Inputs {
  manifest: Record<string, any>;
  deployer: string;
  safe: string;
  emergency: string;
  minDelay: bigint;
}

const norm = (a: string) => a.trim().toLowerCase();
const same = (a: string, b: string) => norm(a) === norm(b);

export const VAULT_KEYS: [string, string][] = [
  ["rmUSDC", "vault"],
  ["rmPROTO", "protocol_vault"],
  ["rmAGENT", "agent_vault"],
  ["rmRWA", "rwa_vault"],
];

export async function timelockRoleChecks(r: Reader, i: Inputs): Promise<Check[]> {
  const m = i.manifest;
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail = "") => out.push({ name, ok, detail });
  const need = (k: string) => {
    if (!m[k]) throw new Error(`manifest lacks "${k}"`);
    return String(m[k]);
  };
  const timelock = need("timelock_timelock");
  const registry = need("registry");
  const [ADMIN, EMERGENCY, DEFAULT_ADMIN, PROPOSER, EXECUTOR] = [
    await r.role("ADMIN_ROLE"),
    await r.role("EMERGENCY_ROLE"),
    "0x" + "0".repeat(64),
    await r.role("PROPOSER_ROLE"),
    await r.role("EXECUTOR_ROLE"),
  ];

  // Timelock: only the Safe proposes and executes. The deployer holds nothing on it.
  add("timelock: Safe holds PROPOSER", await r.hasRole(timelock, PROPOSER, i.safe));
  add("timelock: Safe holds EXECUTOR", await r.hasRole(timelock, EXECUTOR, i.safe));
  add("timelock: deployer holds no PROPOSER", !(await r.hasRole(timelock, PROPOSER, i.deployer)));
  add("timelock: deployer holds no EXECUTOR", !(await r.hasRole(timelock, EXECUTOR, i.deployer)));
  const delay = await r.uintOf(timelock, "getMinDelay()(uint256)");
  add("timelock: delay equals TIMELOCK_MIN_DELAY", delay === i.minDelay, `${delay} vs ${i.minDelay}`);

  // The four vaults.
  const vaults = VAULT_KEYS.map(([label, key]) => ({ label, addr: need(key) }));
  for (const v of vaults) {
    add(`${v.label}: ADMIN is the timelock`, await r.hasRole(v.addr, ADMIN, timelock));
    add(`${v.label}: deployer holds no ADMIN`, !(await r.hasRole(v.addr, ADMIN, i.deployer)));
    add(`${v.label}: EMERGENCY is the emergency key`, await r.hasRole(v.addr, EMERGENCY, i.emergency));
    add(`${v.label}: deployer holds no EMERGENCY`, !(await r.hasRole(v.addr, EMERGENCY, i.deployer)));
    const reg = await r.addressOf(v.addr, "registry()(address)");
    add(`${v.label}: registry() equals the registry`, same(reg, registry), reg);
    add(`${v.label}: a second setRegistry reverts`, await r.setRegistryReverts(v.addr, registry, i.deployer));
  }

  // The gateway.
  const gateway = need("gateway");
  for (const [label, role] of [["ADMIN", ADMIN], ["DEFAULT_ADMIN", DEFAULT_ADMIN]] as const) {
    add(`gateway: ${label} is the timelock`, await r.hasRole(gateway, role, timelock));
    add(`gateway: deployer holds no ${label}`, !(await r.hasRole(gateway, role, i.deployer)));
  }
  if (m.agent) {
    const owner = await r.agentOwner(gateway, String(m.agent));
    add("gateway: the deploy agent is owned by the timelock", same(owner, timelock), owner);
  }

  // The rest of the ADMIN-governed contracts.
  const others: [string, string][] = [
    ["registry", registry],
    ["router", need("router")],
    ["governance", need("governance")],
    ["IC policy", need("policy")],
    ["consensus receipt", need("consensus_receipt")],
  ];
  for (const [label, addr] of others) {
    add(`${label}: ADMIN is the timelock`, await r.hasRole(addr, ADMIN, timelock));
    add(`${label}: deployer holds no ADMIN`, !(await r.hasRole(addr, ADMIN, i.deployer)));
  }

  // The registry lists every vault.
  const listed = (await r.listVaults(registry)).map(norm);
  for (const v of vaults) add(`registry lists ${v.label}`, listed.includes(norm(v.addr)), v.addr);
  return out;
}

// ---- cast-backed reader ----------------------------------------------------------------

async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: code === 0 ? out.trim() : (err || out).trim() };
}

export function castReader(rpc: string): Reader {
  const call = async (to: string, sig: string, ...args: string[]) => {
    const r = await sh(["cast", "call", to, sig, ...args, "--rpc-url", rpc]);
    if (r.code !== 0) throw new Error(`cast call ${sig} on ${to} failed: ${r.out}`);
    return r.out.split(/\s/)[0];
  };
  const roles = new Map<string, string>();
  return {
    async role(name) {
      if (name === "PROPOSER_ROLE" || name === "EXECUTOR_ROLE" || name === "ADMIN_ROLE" || name === "EMERGENCY_ROLE") {
        if (!roles.has(name)) roles.set(name, (await sh(["cast", "keccak", name])).out);
        return roles.get(name)!;
      }
      throw new Error(`unknown role ${name}`);
    },
    async hasRole(c, role, a) {
      return (await call(c, "hasRole(bytes32,address)(bool)", role, a)) === "true";
    },
    addressOf: (c, sig) => call(c, sig),
    async uintOf(c, sig) {
      return BigInt(await call(c, sig));
    },
    async listVaults(registry) {
      const r = await sh(["cast", "call", registry, "listVaults()(address[])", "--rpc-url", rpc]);
      if (r.code !== 0) throw new Error(`listVaults failed: ${r.out}`);
      return r.out.match(/0x[0-9a-fA-F]{40}/g) ?? [];
    },
    async setRegistryReverts(vault, registry, from) {
      const r = await sh(["cast", "call", vault, "setRegistry(address)", registry, "--from", from, "--rpc-url", rpc]);
      return r.code !== 0;
    },
    async agentOwner(gateway, agent) {
      return call(gateway, "agentOwner(address)(address)", agent);
    },
  };
}

function parseArgs(argv: string[]) {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) throw new Error(`unknown argument ${argv[i]}`);
    a[argv[i].slice(2)] = argv[i + 1];
  }
  for (const k of ["rpc-url", "manifest", "deployer", "safe", "emergency", "min-delay", "out"]) {
    if (!a[k]) throw new Error(`--${k} is required`);
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(a["manifest"], "utf8"));
  const checks = await timelockRoleChecks(castReader(a["rpc-url"]), {
    manifest,
    deployer: a["deployer"],
    safe: a["safe"],
    emergency: a["emergency"],
    minDelay: BigInt(a["min-delay"]),
  });
  const ok = checks.every((c) => c.ok);
  writeFileSync(a["out"], JSON.stringify({ ok, checks }, null, 2) + "\n");
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  process.exit(ok ? 0 : 1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(String(e.message ?? e));
    process.exit(1);
  });
}
