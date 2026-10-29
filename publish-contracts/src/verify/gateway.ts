// The gateway system's verifier (issue 1892). It reads the chain and the gateway system's manifests and checks every postcondition of the gateway run on its own:
// the gateway proxy and its implementation, the explicit upgrade timelock, the role handover to the explicitly configured admin, and the chain-backed negative invariants
// (the gateway logged no AgentAuthorized and granted no AGENT_ROLE up to the handover block, so the run left zero agents). It needs no Safe, no vaults-system timelock and
// no vaults verifier. The gateway binds no vault and no router (core 1895). It reads the vaults system's libs manifest only (the library it links), and that manifest must be unchanged.
// AgentOwnershipTransferred is not scanned: the event is gone from the target gateway (historical combined manifests keep their own reading in verify/index.ts).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import { Collector } from "./collector.ts";
import { ERC1967_PROXY_ARTIFACT, compareDeployedCode, loadArtifact, tryLoadArtifact } from "./codehash.ts";
import { AGENT_ROLE, DEPOSIT_PAUSER_ROLE, ADMIN_ROLE, SIG_AGENT_AUTHORIZED, SIG_ROLE_GRANTED, Z32, ZERO } from "./constants.ts";
import { scanLogs, topicToAddress, withSharedLogScan } from "./logs.ts";
import { isAddress, lc } from "./manifests.ts";
import { manifestBase, scopeTable } from "../stage-table.ts";
import { USDC_ADDRESS, checkUsdcCode } from "../usdc.ts";
import type { Address, ChainReader, Hex, VerifyOptions, VerifyReport } from "./types.ts";

const HAS_ROLE = "function hasRole(bytes32 role, address account) view returns (bool)";
const hasRole = async (ch: ChainReader, at: Address, r: Hex, who: Address): Promise<boolean> => (await ch.read(at, HAS_ROLE, [r, who])) as boolean;

/** The vaults system manifests the gateway run consumes (and must leave unchanged): the libraries it links. */
export const CONSUMED_VAULTS_MANIFESTS = ["libs"] as const;

/** sha256 of each consumed vaults manifest file in `dir`, by name (no .json). A missing file is left out. */
export function hashConsumedManifests(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of CONSUMED_VAULTS_MANIFESTS) {
    const p = join(dir, `${n}.json`);
    if (existsSync(p)) out[n] = createHash("sha256").update(readFileSync(p)).digest("hex");
  }
  return out;
}

export const GATEWAY_AGENT_LABELS = [
  "agents: no AgentAuthorized log on the gateway up to the handover block",
  "agents: no AGENT_ROLE grant on the gateway up to the handover block",
] as const;

const padAddr = (a: string): Hex => (`0x${"0".repeat(24)}${a.toLowerCase().replace(/^0x/, "")}`) as Hex;

export async function verifyGatewaySystem(opts: VerifyOptions): Promise<VerifyReport> {
  const c = new Collector();
  const { chain, sheet } = opts;
  const table = scopeTable(opts.table, "gateway");
  const gw = sheet.gateway;
  await c.runEq("chain: id equals sheet", () => chain.chainId(), sheet.chainId);
  if (!gw) { c.fail("sheet: names the gateway admin and the gateway upgrade timelock", "the gateway sheet carries no GATEWAY_ADMIN_ADDRESS and GATEWAY_UPGRADE_TIMELOCK"); return c.report(); }
  c.pass("sheet: names the gateway admin and the gateway upgrade timelock");
  c.push("sheet: the gateway upgrade timelock is not the zero address", lc(gw.upgradeTimelock) !== lc(ZERO), gw.upgradeTimelock);

  // ---- manifests: the gateway system's own and the vaults system's consumed ones
  const files: Record<string, any> = {};
  const own = table.stages.map((s) => manifestBase(s.manifest));
  for (const f of [...own, ...CONSUMED_VAULTS_MANIFESTS]) {
    const p = join(opts.manifestDir, `${f}.json`);
    let ok = existsSync(p);
    if (ok) { try { files[f] = JSON.parse(readFileSync(p, "utf8")); } catch { ok = false; } }
    c.push(`manifest: ${f}.json present`, ok, ok ? "ok" : `${p} is missing or unparseable`);
  }
  if (Object.keys(files).length !== own.length + CONSUMED_VAULTS_MANIFESTS.length) return c.report();
  for (const f of own) c.eq(`manifest: ${f}.json chain_id equals sheet`, files[f].chain_id, sheet.chainId);
  if (opts.consumedVaultsManifests) {
    const now = hashConsumedManifests(opts.manifestDir);
    const changed = Object.entries(opts.consumedVaultsManifests).filter(([n, h]) => now[n] !== h).map(([n]) => `${n}.json`);
    c.push("vaults system: the manifests this run consumed are unchanged since it began", changed.length === 0, changed.length ? `changed: ${changed.join(", ")}` : `${Object.keys(opts.consumedVaultsManifests).length} manifests unchanged`);
  } else c.fail("vaults system: the manifests this run consumed are unchanged since it began", "the run recorded no hash of the vaults manifests it consumed");

  const gm = files["gateway"], hm = files["gateway-handover"];
  const gateway = gm.gateway as Address;
  c.push("gateway: manifest address is valid", isAddress(gateway), String(gateway));
  if (!isAddress(gateway)) return c.report();
  const D = sheet.deployer;

  // ---- code present and equal to the build (the proxy is the ERC-1967 proxy, the logic is the gateway build)
  await c.run("gateway: has code", async () => (await chain.getCode(gateway)).length > 2);
  await c.run("usdc: code hash equals pinned FiatTokenProxy", async () => checkUsdcCode(await chain.getCode(USDC_ADDRESS), opts.usdcCodeHash));
  await c.run("gateway: runtime code equals build artifact (masked)", async () => {
    const r = await compareDeployedCode(chain, gateway, loadArtifact(opts.artifactsDir, table.artifacts["gateway"]!), tryLoadArtifact(opts.artifactsDir, ERC1967_PROXY_ARTIFACT));
    return { ok: r.ok, detail: r.detail };
  });
  await c.run("gateway: manifest runtime hash pins equal the chain", async () => {
    const proxyHash = keccak256(await chain.getCode(gateway));
    const implHash = keccak256(await chain.getCode(String(gm.gateway_implementation) as Address));
    const ok = lc(String(gm.gateway_runtime_hash)) === lc(proxyHash) && lc(String(gm.gateway_implementation_runtime_hash)) === lc(implHash);
    return { ok, detail: ok ? "proxy and implementation runtime hashes equal" : `proxy ${proxyHash} implementation ${implHash} differ from the manifest pins` };
  });

  // ---- bound to nothing of the vaults system (core 1895): no router, no vault
  await c.runEq("gateway: not paused", () => chain.read(gateway, "function depositsPaused() view returns (bool)"), false);

  // ---- the explicit upgrade authority: never the vaults timelock by omission
  await c.runEq("gateway: upgradeTimelock() equals the sheet's GATEWAY_UPGRADE_TIMELOCK", async () => lc((await chain.read(gateway, "function upgradeTimelock() view returns (address)")) as string), lc(gw.upgradeTimelock));
  c.eq("gateway: manifest upgrade_timelock equals the sheet's GATEWAY_UPGRADE_TIMELOCK", gm.upgrade_timelock, gw.upgradeTimelock);
  c.eq("gateway: manifest upgrade_mode equals the sheet", gm.upgrade_mode, sheet.upgradeMode ?? "");
  await c.run("gateway: the upgrade timelock has code", async () => (await chain.getCode(gw.upgradeTimelock)).length > 2);

  // ---- role handover to the explicitly configured admin
  c.eq("handover: manifest gateway_admin equals the sheet's GATEWAY_ADMIN_ADDRESS", hm.gateway_admin, gw.admin);
  await c.runEq("gateway: ADMIN_ROLE held by the gateway admin", () => hasRole(chain, gateway, ADMIN_ROLE, gw.admin), true);
  await c.runEq("gateway: DEFAULT_ADMIN held by the gateway admin", () => hasRole(chain, gateway, Z32, gw.admin), true);
  await c.runEq("gateway: ADMIN_ROLE not held by deployer", () => hasRole(chain, gateway, ADMIN_ROLE, D), false);
  await c.runEq("gateway: DEFAULT_ADMIN not held by deployer", () => hasRole(chain, gateway, Z32, D), false);
  await c.runEq("gateway: ADMIN_ROLE not held by pauser", () => hasRole(chain, gateway, ADMIN_ROLE, sheet.pauser), false);
  await c.runEq("gateway: DEPOSIT_PAUSER_ROLE held by pauser", () => hasRole(chain, gateway, DEPOSIT_PAUSER_ROLE, sheet.pauser), true);
  await c.runEq("gateway: DEPOSIT_PAUSER_ROLE not held by deployer", () => hasRole(chain, gateway, DEPOSIT_PAUSER_ROLE, D), false);
  await c.runEq("gateway: DEPOSIT_PAUSER_ROLE not held by the gateway admin", () => hasRole(chain, gateway, DEPOSIT_PAUSER_ROLE, gw.admin), false);

  // ---- chain-backed negative invariants: the run authorized no agent
  const head = await chain.blockNumber().catch(() => undefined);
  const chunk = opts.logChunk ?? 2000, retryBaseMs = opts.retryBaseMs ?? 500;
  if (head === undefined) {
    for (const l of GATEWAY_AGENT_LABELS) c.fail(l, "block number unreadable");
    c.fail("deployer: holds no role on the gateway (log scan)", "block number unreadable");
  } else {
    const to = opts.handoverBlock !== undefined && opts.handoverBlock < head ? opts.handoverBlock : head;
    // Issue 1977: the three gateway scans read one shared pass over [fromBlock, head] and filter it in memory.
    const lchain = opts.sharedLogScan === false ? chain : withSharedLogScan(chain, {
      addresses: [gateway], topic0s: [SIG_AGENT_AUTHORIZED, SIG_ROLE_GRANTED].map((s) => keccak256(toHex(s))), fromBlock: opts.fromBlock, toBlock: head, chunk, retryBaseMs,
    });
    const scan = { address: gateway, fromBlock: opts.fromBlock, toBlock: to, chunk, retryBaseMs };
    await c.run(GATEWAY_AGENT_LABELS[0], async () => {
      const logs = await scanLogs(lchain, { ...scan, topics: [keccak256(toHex(SIG_AGENT_AUTHORIZED))] });
      return { ok: logs.length === 0, detail: logs.length ? `${logs.length} AgentAuthorized logs from block ${opts.fromBlock}` : `no AgentAuthorized log from block ${opts.fromBlock} to ${to}` };
    });
    await c.run(GATEWAY_AGENT_LABELS[1], async () => {
      const logs = await scanLogs(lchain, { ...scan, topics: [keccak256(toHex(SIG_ROLE_GRANTED)), AGENT_ROLE] });
      return { ok: logs.length === 0, detail: logs.length ? `${logs.length} AGENT_ROLE grants, to ${[...new Set(logs.map((l) => topicToAddress(l.topics[2]!)))].join(", ")}` : `no AGENT_ROLE grant from block ${opts.fromBlock} to ${to}` };
    });
    await c.run("deployer: holds no role on the gateway (log scan)", async () => {
      const logs = await scanLogs(lchain, { address: gateway, topics: [keccak256(toHex(SIG_ROLE_GRANTED)), null, padAddr(D)], fromBlock: opts.fromBlock, toBlock: head, chunk, retryBaseMs });
      const roles = [...new Set(logs.map((l) => l.topics[1]!))];
      const held: string[] = [];
      for (const r of roles) if (await hasRole(chain, gateway, r as Hex, D)) held.push(r);
      return { ok: held.length === 0, detail: held.length ? `the deployer still holds ${held.join(", ")}` : `${logs.length} grants to the deployer scanned, none held` };
    });
  }

  // ---- the deployer nonce equals the start nonce plus the gateway stages' frozen counts
  await c.run("deployer: nonce equals start plus the sum of the gateway frozen counts", async () => {
    const start = opts.deployerStartNonce ?? Number.NaN;
    const sum = table.stages.reduce((a, s) => a + (opts.frozenCounts[s.name] ?? 0), 0);
    const got = await chain.nonce(D);
    const frozen = table.stages.every((s) => s.name in opts.frozenCounts);
    return { ok: frozen && got === start + sum, detail: `nonce ${got}, start ${start} plus frozen sum ${sum}` };
  });
  return c.report();
}
