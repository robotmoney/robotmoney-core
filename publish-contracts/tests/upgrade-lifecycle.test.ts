// Issue 1811: the evidence check of the Twin upgrade rehearsal (src/upgrade-lifecycle.ts, evidence-check --upgrade-lifecycle). The fixtures are a REAL Twin run of
// src/ci/twin-upgrade-lifecycle.ts (upgrade-lifecycle.twin.json) and what that chain answered to the online check (upgrade-lifecycle.twin.chain.json, replayed here
// with no RPC). Every tampering below must be caught. The CI job core-stages-twin-upgrade-lifecycle runs the same check against a live Twin chain.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { keccak256, pad, type Hex } from "viem";
import { repoProxyNames } from "../src/evidence-check.ts";
import { EXIT_CODES } from "../src/errors.ts";
import { getStageTable } from "../src/stages.ts";
import { manifestBase } from "../src/stage-table.ts";
import { UPGRADES_ARE_FROZEN_SELECTOR, upgradeLifecycleOnChainProblems, upgradeLifecycleProblems, type LifecycleChain } from "../src/upgrade-lifecycle.ts";
import { freezeSpecsFor, rerecordProxyManifest } from "../src/upgrade-rows.ts";
import { stageManifestFile } from "../src/verify/constants.ts";
import { verifyDeployment } from "../src/verify/index.ts";
import { CODE_LABEL, DEADLINE_LABEL, proxySpecs } from "../src/verify/upgradeability.ts";
import { proxyBuildDirsOf } from "../src/verify-stage.ts";
import { MANIFEST_ADAPTER, SHA, tmp } from "./fixtures.ts";
import { ADMIN, world as cliWorld } from "./harness.ts";
import { addr, buildWorld, failed, GATEWAY, IMPL_SLOT, IMPLS, type World } from "./verify/world.ts";

const FIX = join(import.meta.dir, "fixtures");
const record = (): any => JSON.parse(readFileSync(join(FIX, "upgrade-lifecycle.twin.json"), "utf8"));
const recorded = JSON.parse(readFileSync(join(FIX, "upgrade-lifecycle.twin.chain.json"), "utf8"));
// The recorded Twin run is a nine-proxy deployment of the v0.5.0 line (rmAGENT was a stage). Its record is history, so it is read with the proxy set it was made with. The live Twin job
// (twin-upgrade-lifecycle.ts) records the current eight-proxy shape.
const proxies = ["vault[rmUSDC]", "registry", "router", "gateway", "receipt", "governance", "vault[rmPROTO]", "vault[rmAGENT]", "vault[rmRWA]"];

/** Replays the recorded chain. `over` replaces single answers. A question the run never asked throws, so a check that reads something new fails loudly here. */
function replay(over: Partial<{ callRevert: (k: string) => Hex | undefined; read: (k: string) => unknown }> = {}): LifecycleChain {
  const miss = (what: string): never => { throw new Error(`not recorded: ${what}`); };
  return {
    async getTransactionReceipt({ hash }) {
      const r = recorded.receipts[hash] ?? miss(`receipt ${hash}`);
      return { ...r, blockNumber: BigInt(r.blockNumber) };
    },
    async getBlock({ blockNumber }) { return { timestamp: BigInt(recorded.blocks[blockNumber.toString()] ?? miss(`block ${blockNumber}`)) }; },
    async getCode({ address }) { return recorded.code[address.toLowerCase()] ?? miss(`code ${address}`); },
    async getStorageAt({ address, slot }) { return recorded.storage[`${address.toLowerCase()}:${slot}`] ?? miss(`storage ${address} ${slot}`); },
    async readContract(a) {
      const k = `${a.address.toLowerCase()}:${a.functionName}:${(a.args ?? []).join(",")}`;
      if (over.read) { const v = over.read(k); if (v !== undefined) return v; }
      return k in recorded.reads ? recorded.reads[k] : miss(`read ${k}`);
    },
    async callRevert(a) {
      const k = `${a.from.toLowerCase()}:${a.to.toLowerCase()}:${a.data}`;
      if (over.callRevert) return over.callRevert(k);
      return k in recorded.calls ? (recorded.calls[k] ?? undefined) : miss(`call ${k}`);
    },
  };
}

describe("upgrade lifecycle record, offline (issue 1811)", () => {
  test("the real Twin record tells one story", () => {
    expect(upgradeLifecycleProblems(record(), proxies)).toEqual([]);
    expect(Object.keys(record().freeze.targets).sort()).toEqual([...proxies].sort());
  });
  const caught = (edit: (r: any) => void, needle: string) => {
    const r = record();
    edit(r);
    const p = upgradeLifecycleProblems(r, proxies);
    expect(p.some((x) => x.includes(needle)), `${needle} in ${JSON.stringify(p)}`).toBe(true);
  };
  test("a deployment recorded frozen, or frozen in the initializer, is not an upgradeable deployment", () => {
    caught((r) => { r.deploy.upgradeability.mode = "frozen"; }, "deploy: mode is frozen");
    caught((r) => { r.deploy.upgradeability.proxies.router.upgrades_frozen = true; }, "router are not recorded upgradeable");
  });
  test("an upgrade that changed nothing, or changed another proxy, is refused", () => {
    caught((r) => { r.upgrade.to_implementation = r.upgrade.from_implementation; }, "nothing was upgraded");
    caught((r) => { r.upgrade.upgradeability.proxies.registry.implementation = r.upgrade.to_implementation; }, "registry changed implementation");
    caught((r) => { r.upgrade.from_implementation = r.upgrade.to_implementation; }, "is not the deployed implementation");
  });
  test("a freeze not bound to the reviewed record, or missing a proxy, is refused", () => {
    caught((r) => { r.freeze.targets.gateway.implementation = r.upgrade.from_implementation; }, "freeze: gateway target is not the reviewed record");
    caught((r) => { delete r.freeze.targets["vault[rmRWA]"]; }, "missing [vault[rmRWA]]");
  });
  test("a refused upgrade with another revert, no Safe tool refusal, or a shared operation is refused", () => {
    caught((r) => { r.rejected_upgrade.revert_error = "NotUpgradeTimelock"; }, "want UpgradesAreFrozen");
    caught((r) => { r.rejected_upgrade.safe_tool_refusal = ""; }, "safe_tool_refusal is empty");
    caught((r) => { r.rejected_upgrade.operation_id = r.freeze.operation_id; }, "three different timelock operations");
  });
  test("a final record without the claim, with a proxy left open, or a failed verifier is refused", () => {
    caught((r) => { r.final.upgradeability.core_immutable = false; r.final.upgradeability.immutability_refused_because = ["x"]; }, "final: core_immutable is not true");
    caught((r) => { r.final.upgradeability.proxies.governance.upgrades_frozen = false; }, "governance are not recorded frozen");
    caught((r) => { r.final.verifier_exit_code = 13; }, "verifier exit code is 13");
    caught((r) => { r.final.upgradeability.proxies.gateway.implementation = r.upgrade.from_implementation; }, "the refused upgrade must leave");
  });
});

describe("upgrade lifecycle record, read back from the recorded Twin chain (issue 1811)", () => {
  test("the real run passes", async () => {
    expect(await upgradeLifecycleOnChainProblems(record(), replay())).toEqual([]);
  });
  test("a queued upgrade that would execute now, or reverts with another error, fails", async () => {
    expect((await upgradeLifecycleOnChainProblems(record(), replay({ callRevert: () => undefined }))).join("\n")).toContain("SUCCEEDS now");
    const other = await upgradeLifecycleOnChainProblems(record(), replay({ callRevert: () => "0x12345678" as Hex }));
    expect(other.join("\n")).toContain(`not UpgradesAreFrozen (${UPGRADES_ARE_FROZEN_SELECTOR})`);
  });
  test("a refused operation that was executed or cancelled fails", async () => {
    const id = record().rejected_upgrade.operation_id;
    const p = await upgradeLifecycleOnChainProblems(record(), replay({ read: (k) => (k.endsWith(`isOperationDone:${id}`) ? true : undefined) }));
    expect(p.join("\n")).toContain("want a ready operation that never executed");
  });
  test("a record whose transactions are swapped fails the event checks", async () => {
    const r = record();
    [r.upgrade.execute_tx, r.freeze.execute_tx] = [r.freeze.execute_tx, r.upgrade.execute_tx];
    const p = (await upgradeLifecycleOnChainProblems(r, replay())).join("\n");
    expect(p).toContain("upgrade: the execute tx has no CallExecuted");
    expect(p).toContain("freeze: the execute tx has no CallExecuted");
  });
  test("a freeze target or an upgrade target the chain does not hold fails", async () => {
    const r = record();
    r.upgrade.to_code_hash = `0x${"ab".repeat(32)}`;
    expect((await upgradeLifecycleOnChainProblems(r, replay())).join("\n")).toContain("upgrade: the code hash at");
  });
});

// Issue 1859 (item 5): verify compares a governed-upgraded proxy with the build its upgrade named (the `build` of its proxy_upgrades entry), not the deploy build.
describe("verify after an upgrade to another build (issue 1859)", () => {
  test("the runtime-code label passes against the upgrade's own build directory and fails against the original one", async () => {
    const v = buildWorld(918453);
    const GW = proxySpecs(getStageTable()).find((x) => x.name === "gateway")!;
    // the second build: the deploy build with the gateway implementation's last code byte changed (outside the immutable and library-link ranges)
    const build2 = join(tmp("pc-upgrade-build-"), "out");
    cpSync(v.opts.artifactsDir, build2, { recursive: true });
    const artPath = join(build2, `${GW.contract}.sol`, `${GW.contract}.json`);
    const art = JSON.parse(readFileSync(artPath, "utf8"));
    const old = v.chain.codes.get(IMPLS.gateway!.toLowerCase())!;
    const tail = old.endsWith("fe") ? "fd" : "fe";
    art.deployedBytecode.object = `${String(art.deployedBytecode.object).slice(0, -2)}${tail}`;
    writeFileSync(artPath, JSON.stringify(art));
    const code = `${old.slice(0, -2)}${tail}` as Hex;
    // the governed upgrade to the new implementation, and the re-record govern --row upgrade-proxy makes
    const to = addr(0x9400);
    v.chain.codes.set(to.toLowerCase(), code);
    v.chain.storage.set(`${GATEWAY.toLowerCase()}|${IMPL_SLOT}`, pad(to, { size: 32 }));
    rerecordProxyManifest(join(v.manifestDir, stageManifestFile(getStageTable(), "gateway")), GW, to, keccak256(code), keccak256(v.chain.codes.get(GATEWAY.toLowerCase())!));
    const label = `gateway: ${CODE_LABEL}`;
    // the run manifest names the build; verify-stage turns it into the per-proxy directory
    const dirs = proxyBuildDirsOf({ proxy_upgrades: [{ proxy_name: "gateway", build: dirname(build2) }] }, v.opts.artifactsDir);
    expect(dirs).toEqual({ proxyBuildDirs: { gateway: build2 } });
    const own = await verifyDeployment({ ...v.opts, ...dirs });
    expect(failed(own)).toEqual([]);
    expect(own.checks.find((c) => c.label === label)?.detail).toContain(build2);
    const original = await verifyDeployment(v.opts);
    expect(original.checks.find((c) => c.label === label)?.ok).toBe(false);
    // every other contract still reads the deploy build: only the gateway's code label moved
    expect(original.checks.filter((c) => !c.ok && c.label.endsWith(CODE_LABEL)).map((c) => c.label)).toEqual([label]);
    // an upgrade back onto the deploy build drops the proxy's directory again
    expect(proxyBuildDirsOf({ proxy_upgrades: [{ proxy_name: "gateway", build: dirname(build2) }, { proxy_name: "gateway", build: dirname(v.opts.artifactsDir) }] }, v.opts.artifactsDir)).toEqual({});
  });
});

// Issue 1859 (item 6): the missed freeze deadline fails verify with exit 13 (VERIFY). The CLI's main() return value is the process exit code (cli.ts: process.exit(await main(...))).
describe("verify on a missed-deadline fixture exits 13 (issue 1859)", () => {
  /** An upgradeable 8453 release whose freeze deadline passed with every proxy still upgradeable (the verifier world). */
  function missed(): World {
    const w = buildWorld(8453);
    const due = "2027-01-31T00:00:00Z";
    w.sheet.upgradeMode = "upgradeable";
    w.sheet.freezeDeadline = due;
    w.opts.now = BigInt(Date.parse(due) / 1000) + 1n;
    for (const st of getStageTable().stages.filter((x) => x.proxies)) {
      const p = join(w.manifestDir, stageManifestFile(getStageTable(), st.name));
      writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), upgrade_mode: "upgradeable" }));
    }
    for (const n of repoProxyNames()) {
      const spec = proxySpecs(getStageTable()).find((x) => x.name === n)!;
      const m = JSON.parse(readFileSync(join(w.manifestDir, stageManifestFile(getStageTable(), spec.stage)), "utf8"));
      w.chain.set(m[spec.field], "upgradesFrozen", false);
    }
    return w;
  }
  test("a freeze names the gateway system's proxy only when the record lists it (issue 1892)", () => {
    const table = getStageTable();
    const specs = proxySpecs(table);
    const sys = (stage: string) => table.stages.find((x) => x.name === stage)?.system;
    expect(specs.map((s) => s.name)).toContain("gateway");
    const vaultsRecord = { proxies: Object.fromEntries(specs.filter((s) => s.name !== "gateway").map((s) => [s.name, {}])) };
    expect(freezeSpecsFor(specs, sys, vaultsRecord).map((s) => s.name)).toEqual(specs.map((s) => s.name).filter((n) => n !== "gateway"));
    const combinedRecord = { proxies: Object.fromEntries(specs.map((s) => [s.name, {}])) };
    expect(freezeSpecsFor(specs, sys, combinedRecord).map((s) => s.name)).toEqual(specs.map((s) => s.name));
  });

  test("the publish CLI's verify verb exits 13 and names the missed deadline", async () => {
    const v = missed();
    const cli = cliWorld({ chainId: 8453, writeSafeManifest: true, writeFrozen: true });
    const m = join(cli.coreDir, "deployments", "8453");
    getStageTable().vaults.forEach((x, i) => writeFileSync(join(m, `${manifestBase(x.manifest)}.json`), JSON.stringify({ chain_id: 8453, vault: addr(0xc1 + i), adapter: MANIFEST_ADAPTER, ...(x.key === "USDC" ? { aave_adapter: addr(0xe1), compound_adapter: addr(0xe2), moonwell_flagship_adapter: addr(0xe3) } : {}) })));
    mkdirSync(cli.evidence, { recursive: true });
    writeFileSync(join(cli.evidence, "publish-run.json"), JSON.stringify({ version: 1, chainId: 8453, coreSha: SHA, deployer: ADMIN, environment: "local", startedAt: "t", firstBlock: 7, stages: { safe: { status: "done", startedAt: "t" }, "prove-control": { status: "done", startedAt: "t" }, timelock: { status: "done", startedAt: "t" } } }));
    let report: Awaited<ReturnType<typeof verifyDeployment>> | undefined;
    const verify = {
      // the real verifier over the missed-deadline world (the in-memory chain stands in for the RPC)
      verifyDeployment: (async () => (report = await verifyDeployment(v.opts))) as never,
      verifySources: (async () => ({ ok: true, checks: [] })) as never, depositsPaused: async () => true,
    };
    const code = await cli.run(["verify"], { pauseAll: (async () => ({ allPaused: true, vaults: [] })) as never, verify });
    expect(failed(report!)).toEqual([DEADLINE_LABEL]);
    expect(report!.checks.find((c) => c.label === DEADLINE_LABEL)!.detail).toMatch(/^MISSED: /);
    expect(code).toBe(EXIT_CODES.VERIFY);
    expect(code).toBe(13);
  });
});
