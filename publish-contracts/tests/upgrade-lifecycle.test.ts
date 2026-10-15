// Issue 1811: the evidence check of the Twin upgrade rehearsal (src/upgrade-lifecycle.ts, evidence-check --upgrade-lifecycle). The fixtures are a REAL Twin run of
// src/ci/twin-upgrade-lifecycle.ts (upgrade-lifecycle.twin.json) and what that chain answered to the online check (upgrade-lifecycle.twin.chain.json, replayed here
// with no RPC). Every tampering below must be caught. The CI job core-stages-twin-upgrade-lifecycle runs the same check against a live Twin chain.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import { repoProxyNames } from "../src/evidence-check.ts";
import { UPGRADES_ARE_FROZEN_SELECTOR, upgradeLifecycleOnChainProblems, upgradeLifecycleProblems, type LifecycleChain } from "../src/upgrade-lifecycle.ts";

const FIX = join(import.meta.dir, "fixtures");
const record = (): any => JSON.parse(readFileSync(join(FIX, "upgrade-lifecycle.twin.json"), "utf8"));
const recorded = JSON.parse(readFileSync(join(FIX, "upgrade-lifecycle.twin.chain.json"), "utf8"));
const proxies = repoProxyNames();

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
