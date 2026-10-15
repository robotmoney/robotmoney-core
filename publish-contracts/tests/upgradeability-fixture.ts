// Issue 1809: an evidence `upgradeability` section for the evidence tests (the copy of the upgradeability.json verify writes), and the chain reads that back it.
import { keccak256, pad, type Hex } from "viem";
import { repoProxyNames, type ChainReader } from "../src/evidence-check.ts";
import { GOVERNED_PARAMETERS, UPSTREAM_DEPENDENCIES } from "../src/verify/upgradeability.ts";
import { ERC1967_IMPLEMENTATION_SLOT } from "../src/verify/codehash.ts";

const a = (n: number) => ("0x" + n.toString(16).padStart(40, "0")) as `0x${string}`;
export const PROXY_CODE = "0x6080604052" as Hex;
export const implCode = (i: number): Hex => `0x60806040${(0x10 + i).toString(16)}` as Hex;
export const proxyOf = (ev: any, name: string, i: number): `0x${string}` => (/^vault\[(\w+)\]$/.exec(name) ? ev.vaults[/^vault\[(\w+)\]$/.exec(name)![1]!].address : a(0x400 + i));
export const implOf = (i: number): `0x${string}` => a(0x600 + i);

/** Adds a frozen (default) or upgradeable record for the full proxied core set, consistent with the evidence's timelock and vaults. */
export function withUpgradeability<T extends Record<string, any>>(ev: T, mode: "frozen" | "upgradeable" = "frozen"): T {
  const names = repoProxyNames();
  const proxies = Object.fromEntries(names.map((n, i) => [n, {
    stage: "s", contract: "C", proxy: proxyOf(ev, n, i), implementation: implOf(i), proxy_code_hash: keccak256(PROXY_CODE), implementation_code_hash: keccak256(implCode(i)),
    layout: "contracts/test/fixtures/storage-layout/C.json", layout_id: keccak256(`0x${i.toString(16).padStart(2, "0")}`), upgrade_timelock: ev.timelock.address,
    upgrades_frozen: mode === "frozen", initialized_version: "1", manifest_upgrade_mode: mode,
  }]));
  (ev as any).upgradeability = {
    mode, freeze_deadline: mode === "upgradeable" ? "2027-01-31T00:00:00Z" : null, timelock: { address: ev.timelock.address, min_delay: String(ev.timelock.min_delay) }, transactions_per_proxy: 2, proxies,
    core_immutable: mode === "frozen", immutability_refused_because: mode === "frozen" ? [] : ["the release mode is upgradeable, not frozen"],
    remaining_governed_parameters: [...GOVERNED_PARAMETERS], upstream_dependencies: [...UPSTREAM_DEPENDENCIES],
  };
  return ev;
}

/** The chain reads that agree with the record: code, the implementation slot, upgradesFrozen() and upgradeTimelock(). Other reads go to `inner`. */
export function withUpgradeabilityReads(ev: any, inner: ChainReader, over: { frozen?: boolean; impl?: Record<string, `0x${string}`> } = {}): ChainReader {
  const u = ev.upgradeability;
  const byProxy = new Map<string, [string, any, number]>(Object.entries<any>(u?.proxies ?? {}).map(([n, r], i) => [r.proxy.toLowerCase(), [n, r, i]]));
  const byImpl = new Map<string, Hex>(Object.values<any>(u?.proxies ?? {}).map((r, i) => [r.implementation.toLowerCase(), implCode(i)]));
  return {
    ...inner,
    getCode: async ({ address }) => (byProxy.has(address.toLowerCase()) ? PROXY_CODE : byImpl.get(address.toLowerCase()) ?? (inner.getCode ? inner.getCode({ address }) : "0x")),
    getStorageAt: async ({ address, slot }) => {
      const hit = byProxy.get(address.toLowerCase());
      if (!hit || slot.toLowerCase() !== ERC1967_IMPLEMENTATION_SLOT) return pad("0x00", { size: 32 }) as Hex;
      return pad(over.impl?.[hit[0]] ?? hit[1].implementation, { size: 32 }) as Hex;
    },
    readContract: async (x) => {
      const hit = byProxy.get(x.address.toLowerCase());
      if (hit && x.functionName === "upgradesFrozen") return over.frozen ?? hit[1].upgrades_frozen;
      if (hit && x.functionName === "upgradeTimelock") return hit[1].upgrade_timelock;
      return inner.readContract(x);
    },
  };
}
