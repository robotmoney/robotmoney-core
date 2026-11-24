#!/usr/bin/env bun
// scripts/runbook/adapter-swap.ts: the fund's move to the governed swap adapter proxy (ADR-0019), for releases/v0.9.0-onevault-upgrade.yaml.
//   deploy   (P1.83) forge create the UniswapV3ExactOutSwapAdapterUpgradeable implementation from BUILD, linked to GovernedUpgrade and TwapTickMath,
//            then an ERC1967Proxy over it initialized with the fund timelock. A recorded address in STATE that has code is reused. Both runtimes
//            are compared with the build (code-matches-build.ts), the proxy is read back, every active basket pool must read fixed-fee, and the
//            two runtime code hashes are written for the batch.
//              --rpc URL --build DIR --state-dir DIR --router A --governed-upgrade A --twap-tick-math A --timelock A --fund A -- {cast}
//   plan     (P2.85) the one timelock batch: setAdapterCodeHashAllowed(impl hash), setAdapterCodeHashAllowed(proxy hash),
//            setAdapterProxyCodeHash(proxy hash), then setAssetAdapter(i, proxy) for each active basket asset on the legacy adapter. Writes
//            target-, data-, values- and salt-upg-adapter. Its predecessor (the queue upgrade, upg-queue-op) is written by migration-data.ts.
//              --state-dir DIR --run-dir DIR --fund A --legacy A --proxy A --impl-hash H --proxy-hash H
//   pending  (P2.85, after the Safe schedules it) writes the batch's operation id and requires it pending.
//   check    (P3.72, after the Safe executes it) the batch reads done, both hashes are allowed, no basket asset uses the legacy adapter,
//            at least one uses the proxy; prints NAV.
//              pending|check: --timelock A --targets CSV --values CSV --datas CSV --predecessor H --salt H [--out FILE]
//                       check also: --fund A --proxy A --legacy A --impl-hash H --proxy-hash H
// The 0.10.0 move of the adapter proxy to a new implementation (releases/v0.10.0-onevault-upgrade.yaml P2.93, decision D10-1), one timelock batch the Safe schedules
// after the receipt upgrade and executes after the delay:
//   upgrade deploy  forge create the new implementation from BUILD (linked as above, the proxy's own ROUTER as constructor argument). A recorded implementation
//                   (upg-adapter-new-impl) whose code matches the build is reused. Requires the proxy unfrozen, named for the fund timelock and on another
//                   implementation, and simulates upgradeToAndCall(impl, DATA) from the timelock. Writes upg-adapter-new-impl-hash.
//              --rpc URL --build DIR --state-dir DIR --proxy A --timelock A --governed-upgrade A --twap-tick-math A [--data HEX] -- {cast}
//   upgrade plan    the batch: fund.setAdapterCodeHashAllowed(new impl hash, true), then proxy.upgradeToAndCall(new impl, DATA). Writes target-, data-,
//                   values- and salt-upg-adapter and its operation id (upg-adapter-op) with the given predecessor (the receipt upgrade's operation).
//              --state-dir DIR --run-dir DIR --timelock A --fund A --proxy A --impl A --impl-hash H --predecessor H [--data HEX]
//   DATA is the proxy's migration (v0.10.0: migrateV0100(), 0x42829c5e), default 0x.
//   pending         as above, with the upg-adapter files.
//   upgrade check   (after the Safe executes it) the batch reads done, the proxy's ERC-1967 slot and implementation() name the new implementation, its
//                   code hash is allowed, every basket asset on the proxy vets (its pool reads fixed-fee through the proxy) and NAV reads.
//              --timelock A --targets CSV --values CSV --datas CSV --predecessor H --salt H --fund A --proxy A --impl A --impl-hash H [--done FILE]
//                   On a pass it writes the batch id to FILE (the done-adapter-upgrade marker the runbook's adapter steps skip on).
// Reads the chain through cast with ETH_RPC_URL (cast-io.ts). Exit 0 pass, 1 a failed check or call, 2 a usage error.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { UsageError, check, firstToken, lower, need, options, readState, realCast, runMain, sameAddress, writeState, type Cast } from "./cast-io.ts";
import { codeAt } from "./code-matches-build.ts";
import { compareCode, loadArtifact } from "../../publish-contracts/src/verify/codehash.ts";

export const ADAPTER_SOURCE = "contracts/adapters/UniswapV3ExactOutSwapAdapterUpgradeable.sol:UniswapV3ExactOutSwapAdapterUpgradeable";
export const PROXY_SOURCE = "lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy";
export const GOVERNED_UPGRADE_LIB = "contracts/lib/GovernedUUPS.sol:GovernedUpgrade";
export const TWAP_TICK_MATH_LIB = "contracts/lib/TwapTickMath.sol:TwapTickMath";

export interface BasketAsset { index: number; adapter: string; pool: string }

/**
 * PURE. One fund.assetConfig(i) return as raw words: a basket asset (word 0, kind, is 1) that is active (word 1 is 1), its adapter (word 3) and
 * pool (word 5). Anything else is null. The same reads as the bash it replaced: ${r:65:1}, ${r:129:1}, ${r:218:40}, ${r:346:40}.
 */
export function parseAssetConfig(index: number, raw: string): BasketAsset | null {
  const r = raw.trim();
  if (r.length < 386) throw new Error(`assetConfig(${index}) is too short: ${r.slice(0, 80)}`);
  if (r[65] !== "1" || r[129] !== "1") return null;
  return { index, adapter: `0x${r.slice(218, 258)}`, pool: `0x${r.slice(346, 386)}` };
}

export function basket(cast: Cast, fund: string): BasketAsset[] {
  const n = Number(firstToken(cast(["call", fund, "assetCount()(uint256)"])));
  const out: BasketAsset[] = [];
  for (let i = 0; i < n; i++) {
    const a = parseAssetConfig(i, cast(["call", fund, "assetConfig(uint256)", String(i)]));
    if (a) out.push(a);
  }
  return out;
}

/** PURE. The deployed address in forge create --json output: forge prints "Compiling..." lines first and the JSON may span lines. The last deployedTo wins. */
export function forgeCreateAddress(stdout: string): string {
  const lines = stdout.split("\n");
  const start = lines.findIndex((l) => l.startsWith("{"));
  if (start < 0) throw new Error("forge create printed no JSON");
  const found = [...lines.slice(start).join("\n").matchAll(/"deployedTo"\s*:\s*"(0x[0-9a-fA-F]{40})"/g)];
  if (!found.length) throw new Error("forge create JSON has no deployedTo");
  return found[found.length - 1]![1]!;
}

/** PURE. forge create's argv: --json before --constructor-args (which is variadic), every linked library passed. */
export function forgeCreateArgs(o: { rpc: string; signer: string[]; libraries: string[]; contract: string; ctorArgs: string[] }): string[] {
  return ["create", "--broadcast", "--rpc-url", o.rpc, ...o.signer, ...o.libraries.flatMap((l) => ["--libraries", l]), o.contract, "--json", "--constructor-args", ...o.ctorArgs];
}

/** Runs forge create in the build checkout; its output is shown on stderr as tee /dev/stderr did. */
export type Forge = (args: string[], cwd: string) => string;
export const realForge: Forge = (args, cwd) => {
  const r = spawnSync("forge", args, { cwd, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
  process.stderr.write(r.stdout ?? "");
  if (r.status !== 0) throw new Error(`forge create exited ${r.status}`);
  return r.stdout;
};

/** A recorded deployment that has code, else a new one written to the state file. */
export function deployOnce(cast: Cast, file: string, what: string, deploy: () => string): string {
  let addr = "";
  try { addr = readState(file); } catch { /* not recorded yet */ }
  if (addr && cast(["code", addr]) !== "0x") { console.log(`reuse ${what} ${addr}`); return addr; }
  addr = forgeCreateAddress(deploy());
  writeState(file, addr);
  console.log(`${what} ${addr}`);
  return addr;
}

export interface DeployInput { rpc: string; build: string; stateDir: string; router: string; governedUpgrade: string; twapTickMath: string; timelock: string; fund: string; signer: string[] }
export type CodeCheck = (address: string, contract: string) => Promise<{ ok: boolean; detail: string }>;

export async function deploy(cast: Cast, forge: Forge, codeCheck: CodeCheck, d: DeployInput): Promise<void> {
  const libraries = [`${GOVERNED_UPGRADE_LIB}:${d.governedUpgrade}`, `${TWAP_TICK_MATH_LIB}:${d.twapTickMath}`];
  const impl = deployOnce(cast, join(d.stateDir, "upg-adapter-impl"), "implementation", () =>
    forge(forgeCreateArgs({ rpc: d.rpc, signer: d.signer, libraries, contract: ADAPTER_SOURCE, ctorArgs: [d.router] }), d.build));
  const proxy = deployOnce(cast, join(d.stateDir, "upg-adapter-proxy"), "proxy", () => {
    const init = cast(["calldata", "initialize(address)", d.timelock]);
    return forge(forgeCreateArgs({ rpc: d.rpc, signer: d.signer, libraries: [], contract: PROXY_SOURCE, ctorArgs: [impl, init] }), d.build);
  });
  for (const [addr, name] of [[impl, "UniswapV3ExactOutSwapAdapterUpgradeable"], [proxy, "ERC1967Proxy"]] as const) {
    const r = await codeCheck(addr, name);
    console.log(`${name} at ${addr}: ${r.ok ? "matches the build" : "DIFFERS"} (${r.detail})`);
    check(r.ok, `${name} at ${addr} is not the build's code`);
  }
  check(sameAddress(cast(["call", proxy, "implementation()(address)"]), impl), "the proxy does not report the implementation");
  check(sameAddress(cast(["call", proxy, "upgradeTimelock()(address)"]), d.timelock), "the proxy does not name the fund timelock");
  check(cast(["call", proxy, "upgradesFrozen()(bool)"]) === "false", "the proxy is frozen");
  check(sameAddress(cast(["call", proxy, "ROUTER()(address)"]), d.router), "the proxy does not use the sheet's router");
  cast(["call", "--from", d.timelock, proxy, "upgradeToAndCall(address,bytes)", impl, "0x"]);
  const implHash = cast(["keccak", cast(["code", impl])]);
  const proxyHash = cast(["keccak", cast(["code", proxy])]);
  writeState(join(d.stateDir, "upg-adapter-impl-hash"), implHash);
  writeState(join(d.stateDir, "upg-adapter-proxy-hash"), proxyHash);
  console.log(`adapter proxy ${proxy} implementation ${impl} hashes ${proxyHash} ${implHash}`);
  const assets = basket(cast, d.fund);
  for (const a of assets) {
    check(cast(["call", proxy, "isFixedFeePool(address)(bool)", a.pool]) === "true", `asset ${a.index} pool ${a.pool} not fixed-fee`);
    console.log(`asset ${a.index} pool ${a.pool} fixed-fee`);
  }
  check(assets.length > 0, "the fund has no active basket asset");
}

export interface Batch { targets: string[]; datas: string[]; values: string[]; moved: BasketAsset[] }

/** The batch of P2.85, in order. Each calldata comes from cast calldata, as before. */
export function adapterBatch(cast: Cast, b: { fund: string; proxy: string; legacy: string; implHash: string; proxyHash: string; assets: BasketAsset[] }): Batch {
  const targets = [b.fund, b.fund, b.fund];
  const datas = [
    cast(["calldata", "setAdapterCodeHashAllowed(bytes32,bool)", b.implHash, "true"]),
    cast(["calldata", "setAdapterCodeHashAllowed(bytes32,bool)", b.proxyHash, "true"]),
    cast(["calldata", "setAdapterProxyCodeHash(bytes32,bool)", b.proxyHash, "true"]),
  ];
  const values = ["0", "0", "0"];
  const moved = b.assets.filter((a) => lower(a.adapter) === lower(b.legacy));
  for (const a of moved) {
    targets.push(b.fund);
    datas.push(cast(["calldata", "setAssetAdapter(uint256,address)", String(a.index), b.proxy]));
    values.push("0");
  }
  return { targets, datas, values, moved };
}

export function plan(cast: Cast, o: Record<string, string>): void {
  const [stateDir, runDir, fund, legacy, proxy, implHash, proxyHash] = need(o, "state-dir", "run-dir", "fund", "legacy", "proxy", "impl-hash", "proxy-hash");
  const b = adapterBatch(cast, { fund: fund!, proxy: proxy!, legacy: legacy!, implHash: implHash!, proxyHash: proxyHash!, assets: basket(cast, fund!) });
  for (const a of b.moved) console.log(`asset ${a.index}: ${a.adapter} -> ${proxy}`);
  check(b.moved.length > 0, "no basket asset uses the legacy adapter");
  writeState(join(stateDir!, "target-upg-adapter"), b.targets.join(","));
  writeState(join(stateDir!, "data-upg-adapter"), b.datas.join(","));
  writeState(join(stateDir!, "values-upg-adapter"), b.values.join(","));
  writeState(join(stateDir!, "salt-upg-adapter"), cast(["keccak", `robotmoney.deploy4-upgrade.adapter.${runDir}`]));
}

/** The batch's operation id on the timelock. */
export function batchOp(cast: Cast, o: Record<string, string>): string {
  const [timelock, targets, values, datas, predecessor, salt] = need(o, "timelock", "targets", "values", "datas", "predecessor", "salt");
  return cast(["call", timelock!, "hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32)(bytes32)", `[${targets}]`, `[${values}]`, `[${datas}]`, predecessor!, salt!]);
}

export function pending(cast: Cast, o: Record<string, string>): void {
  const [out, timelock] = need(o, "out", "timelock");
  const id = batchOp(cast, o);
  writeState(out!, id);
  check(cast(["call", timelock!, "isOperationPending(bytes32)(bool)", id]) === "true", `adapter batch ${id} is not pending`);
  console.log(`adapter batch ${id} pending`);
}

export function checkExecuted(cast: Cast, o: Record<string, string>): void {
  const [timelock, fund, proxy, legacy, implHash, proxyHash] = need(o, "timelock", "fund", "proxy", "legacy", "impl-hash", "proxy-hash");
  const id = batchOp(cast, o);
  check(cast(["call", timelock!, "isOperationDone(bytes32)(bool)", id]) === "true", `adapter batch ${id} is not done`);
  check(cast(["call", fund!, "adapterCodeHashAllowed(bytes32)(bool)", implHash!]) === "true", "the implementation hash is not allowed");
  check(cast(["call", fund!, "adapterCodeHashAllowed(bytes32)(bool)", proxyHash!]) === "true", "the proxy hash is not allowed");
  let m = 0;
  for (const a of basket(cast, fund!)) {
    check(lower(a.adapter) !== lower(legacy!), `asset ${a.index} still uses the legacy adapter`);
    if (lower(a.adapter) === lower(proxy!)) { m++; console.log(`asset ${a.index} uses ${lower(a.adapter)}`); }
  }
  check(m > 0, "no basket asset uses the adapter proxy");
  console.log(`NAV ${cast(["call", fund!, "totalAssets()(uint256)"])}`);
}

/** ERC-1967 implementation slot. */
export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export interface UpgradeDeployInput { rpc: string; build: string; stateDir: string; proxy: string; timelock: string; governedUpgrade: string; twapTickMath: string; signer: string[]; data?: string }

/** upgrade deploy: the new implementation, reused when recorded and matching the build, checked against the proxy, its upgrade simulated from the timelock. */
export async function upgradeDeploy(cast: Cast, forge: Forge, codeCheck: CodeCheck, d: UpgradeDeployInput): Promise<string> {
  check(cast(["call", d.proxy, "upgradesFrozen()(bool)"]) === "false", "the adapter proxy is frozen");
  check(sameAddress(cast(["call", d.proxy, "upgradeTimelock()(address)"]), d.timelock), "the adapter proxy does not name the fund timelock");
  const router = firstToken(cast(["call", d.proxy, "ROUTER()(address)"]));
  const libraries = [`${GOVERNED_UPGRADE_LIB}:${d.governedUpgrade}`, `${TWAP_TICK_MATH_LIB}:${d.twapTickMath}`];
  const impl = deployOnce(cast, join(d.stateDir, "upg-adapter-new-impl"), "implementation", () =>
    forge(forgeCreateArgs({ rpc: d.rpc, signer: d.signer, libraries, contract: ADAPTER_SOURCE, ctorArgs: [router] }), d.build));
  const r = await codeCheck(impl, "UniswapV3ExactOutSwapAdapterUpgradeable");
  console.log(`UniswapV3ExactOutSwapAdapterUpgradeable at ${impl}: ${r.ok ? "matches the build" : "DIFFERS"} (${r.detail})`);
  check(r.ok, `UniswapV3ExactOutSwapAdapterUpgradeable at ${impl} is not the build's code`);
  check(!sameAddress(cast(["call", d.proxy, "implementation()(address)"]), impl), "the adapter proxy already runs this implementation");
  check(sameAddress(cast(["call", impl, "ROUTER()(address)"]), router), "the new implementation does not use the proxy's router");
  cast(["call", "--from", d.timelock, d.proxy, "upgradeToAndCall(address,bytes)", impl, d.data ?? "0x"]);
  const implHash = cast(["keccak", cast(["code", impl])]);
  writeState(join(d.stateDir, "upg-adapter-new-impl-hash"), implHash);
  console.log(`adapter implementation ${impl} hash ${implHash}; upgradeToAndCall simulates from the timelock`);
  return impl;
}

/** PURE over cast calldata. The upgrade batch: allow the new implementation's hash on the fund, then move the proxy to it with `data` (default 0x). */
export function upgradeBatch(cast: Cast, b: { fund: string; proxy: string; impl: string; implHash: string; data?: string }): Omit<Batch, "moved"> {
  return {
    targets: [b.fund, b.proxy],
    datas: [cast(["calldata", "setAdapterCodeHashAllowed(bytes32,bool)", b.implHash, "true"]), cast(["calldata", "upgradeToAndCall(address,bytes)", b.impl, b.data ?? "0x"])],
    values: ["0", "0"],
  };
}

export function upgradePlan(cast: Cast, o: Record<string, string>): void {
  const [stateDir, runDir, timelock, fund, proxy, impl, implHash, predecessor] = need(o, "state-dir", "run-dir", "timelock", "fund", "proxy", "impl", "impl-hash", "predecessor");
  const b = upgradeBatch(cast, { fund: fund!, proxy: proxy!, impl: impl!, implHash: implHash!, data: o.data || "0x" });
  const salt = cast(["keccak", `robotmoney.deploy4-upgrade.adapter-v0100.${runDir}`]);
  writeState(join(stateDir!, "target-upg-adapter"), b.targets.join(","));
  writeState(join(stateDir!, "data-upg-adapter"), b.datas.join(","));
  writeState(join(stateDir!, "values-upg-adapter"), b.values.join(","));
  writeState(join(stateDir!, "salt-upg-adapter"), salt);
  const id = batchOp(cast, { timelock: timelock!, targets: b.targets.join(","), values: b.values.join(","), datas: b.datas.join(","), predecessor: predecessor!, salt });
  writeState(join(stateDir!, "upg-adapter-op"), id);
  console.log(`adapter upgrade batch ${id}: allow ${implHash}, then ${proxy} -> ${impl}; predecessor ${predecessor}`);
}

/** live: the recorded adapter proxy is live. Its ERC-1967 slot holds the recorded implementation, and at least one basket asset swaps through it. It only reads. */
export function liveCheck(cast: Cast, o: Record<string, string>): void {
  const [fund, proxy, impl] = need(o, "fund", "proxy", "impl");
  const slot = cast(["storage", proxy!, IMPLEMENTATION_SLOT]);
  check(lower(`0x${slot.replace(/^0x/, "").slice(-40)}`) === lower(impl!), `the adapter proxy's ERC-1967 slot reads ${slot}, not ${impl}`);
  let m = 0;
  for (const a of basket(cast, fund!)) if (lower(a.adapter) === lower(proxy!)) { m++; console.log(`asset ${a.index} uses ${lower(proxy!)}`); }
  check(m > 0, "no basket asset uses the adapter proxy");
}

export function upgradeCheck(cast: Cast, o: Record<string, string>): void {
  const [timelock, fund, proxy, impl, implHash] = need(o, "timelock", "fund", "proxy", "impl", "impl-hash");
  const id = batchOp(cast, o);
  check(cast(["call", timelock!, "isOperationDone(bytes32)(bool)", id]) === "true", `adapter upgrade batch ${id} is not done`);
  const slot = cast(["storage", proxy!, IMPLEMENTATION_SLOT]);
  check(lower(`0x${slot.replace(/^0x/, "").slice(-40)}`) === lower(impl!), `the adapter proxy's ERC-1967 slot reads ${slot}, not ${impl}`);
  check(sameAddress(cast(["call", proxy!, "implementation()(address)"]), impl!), "the adapter proxy does not report the new implementation");
  check(lower(cast(["keccak", cast(["code", impl!])])) === lower(implHash!), "the new implementation's code hash is not the planned one");
  check(cast(["call", fund!, "adapterCodeHashAllowed(bytes32)(bool)", implHash!]) === "true", "the new implementation hash is not allowed");
  let m = 0;
  for (const a of basket(cast, fund!)) {
    if (lower(a.adapter) !== lower(proxy!)) continue;
    check(cast(["call", proxy!, "isFixedFeePool(address)(bool)", a.pool]) === "true", `asset ${a.index} pool ${a.pool} no longer vets through the upgraded adapter`);
    m++;
    console.log(`asset ${a.index} pool ${a.pool} vets through ${lower(proxy!)}`);
  }
  check(m > 0, "no basket asset uses the adapter proxy");
  console.log(`NAV ${cast(["call", fund!, "totalAssets()(uint256)"])}`);
  if (o.done) writeState(o.done, id);
}

const USAGE = "usage: adapter-swap.ts deploy|plan|pending|check|live|upgrade deploy|upgrade plan|upgrade check --name value ... [-- {cast}] (see the header)";

if (import.meta.main) {
  await runMain(USAGE, async () => {
    const args = process.argv.slice(2);
    const verb = args[0] === "upgrade" ? `upgrade ${args[1] ?? ""}` : args[0];
    const argv = args.slice(args[0] === "upgrade" ? 2 : 1);
    let parsed;
    try { parsed = options(argv); } catch (e) { throw new UsageError((e as Error).message); }
    const { opts, rest } = parsed;
    if (verb === "deploy") {
      const [rpc, build, stateDir, router, governedUpgrade, twapTickMath, timelock, fund] = need(opts, "rpc", "build", "state-dir", "router", "governed-upgrade", "twap-tick-math", "timelock", "fund");
      const codeCheck: CodeCheck = async (addr, name) => compareCode(await codeAt(rpc!, addr), loadArtifact(join(build!, "out"), name));
      await deploy(realCast, realForge, codeCheck, { rpc: rpc!, build: build!, stateDir: stateDir!, router: router!, governedUpgrade: governedUpgrade!, twapTickMath: twapTickMath!, timelock: timelock!, fund: fund!, signer: rest });
    } else if (verb === "plan") plan(realCast, opts);
    else if (verb === "pending") pending(realCast, opts);
    else if (verb === "check") checkExecuted(realCast, opts);
    else if (verb === "live") liveCheck(realCast, opts);
    else if (verb === "upgrade deploy") {
      const [rpc, build, stateDir, proxy, timelock, governedUpgrade, twapTickMath] = need(opts, "rpc", "build", "state-dir", "proxy", "timelock", "governed-upgrade", "twap-tick-math");
      const codeCheck: CodeCheck = async (addr, name) => compareCode(await codeAt(rpc!, addr), loadArtifact(join(build!, "out"), name));
      await upgradeDeploy(realCast, realForge, codeCheck, { rpc: rpc!, build: build!, stateDir: stateDir!, proxy: proxy!, timelock: timelock!, governedUpgrade: governedUpgrade!, twapTickMath: twapTickMath!, signer: rest, data: opts.data || "0x" });
    } else if (verb === "upgrade plan") upgradePlan(realCast, opts);
    else if (verb === "upgrade check") upgradeCheck(realCast, opts);
    else throw new UsageError(`unknown subcommand ${verb ?? "(none)"}`);
  });
}
