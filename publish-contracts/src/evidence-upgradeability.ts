// Issue 1809 (upgradeability stage 2): the evidence `upgradeability` section, the copy of the deployments/<chain>/upgradeability.json the verify stage writes.
// Offline: the record is complete for the full proxied core set of the stage table, agrees with itself and with the rest of the evidence, and makes the immutability
// claim only when it may. Online (--rpc, or a recorded chain fixture): every recorded proxy fact is read back from the chain and compared, so an edited record fails.
// Canonical: docs/technical/contract-upgradeability-plan.md (Release modes and proof), docs/operations/contract-release-runbooks.md 4.12.
import { keccak256, parseAbi, type Hex } from "viem";
import { ERC1967_IMPLEMENTATION_SLOT } from "./verify/codehash.ts";
import { GOVERNED_PARAMETERS, GOVERNED_PARAMETER_HISTORY, UPSTREAM_DEPENDENCIES } from "./verify/upgradeability.ts";
import { UPGRADE_MODES } from "./sheet.ts";
import type { DeploymentKind } from "./chains.ts";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
const DEADLINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const lc = (x: string) => x.toLowerCase();

/** The upgradeability record problems (no chain read). `proxies` is the full proxied core set by verifier name, from the stage table. */
export function upgradeabilityEvidenceProblems(ev: any, proxies: readonly string[], kind: DeploymentKind): string[] {
  const p: string[] = [];
  const bad = (m: string) => p.push(`upgradeability: ${m}`);
  const u = ev?.upgradeability;
  if (!u || typeof u !== "object") { bad("the section is missing: copy deployments/8453/upgradeability.json, which the verify stage wrote, into the evidence"); return p; }
  if (!(UPGRADE_MODES as readonly string[]).includes(u.mode)) bad(`mode '${String(u.mode)}' is not ${UPGRADE_MODES.join(" or ")}`);
  if (u.mode === "upgradeable" && kind === "production" && !(typeof u.freeze_deadline === "string" && DEADLINE.test(u.freeze_deadline))) bad("an upgradeable production release needs freeze_deadline (ISO 8601 UTC): the Safe signers' commitment to freeze every proxy");
  if (u.mode === "frozen" && u.freeze_deadline !== null && u.freeze_deadline !== undefined) bad("a frozen release has no freeze_deadline");
  if (!ADDR.test(u.timelock?.address ?? "") || lc(u.timelock.address) !== lc(ev?.timelock?.address ?? "")) bad(`timelock.address ${u.timelock?.address} is not the evidence timelock ${ev?.timelock?.address}`);
  if (String(u.timelock?.min_delay) !== String(ev?.timelock?.min_delay)) bad(`timelock.min_delay ${u.timelock?.min_delay} differs from the evidence timelock min_delay ${ev?.timelock?.min_delay}`);
  const got = Object.keys(u.proxies ?? {});
  const missing = proxies.filter((n) => !got.includes(n)), extra = got.filter((n) => !proxies.includes(n));
  if (missing.length || extra.length) bad(`the proxies are not the full core set of the stage table: missing [${missing.join(", ")}] unexpected [${extra.join(", ")}]`);
  for (const n of proxies) {
    const r = u.proxies?.[n];
    if (!r) continue;
    const w = (m: string) => bad(`${n}: ${m}`);
    for (const f of ["proxy", "implementation", "upgrade_timelock"]) if (!ADDR.test(r[f] ?? "")) w(`${f} is not an address`);
    for (const f of ["proxy_code_hash", "implementation_code_hash", "layout_id"]) if (!B32.test(r[f] ?? "")) w(`${f} is not a bytes32`);
    if (ADDR.test(r.upgrade_timelock ?? "") && lc(r.upgrade_timelock) !== lc(ev?.timelock?.address ?? "")) w(`upgrade_timelock ${r.upgrade_timelock} is not the timelock ${ev?.timelock?.address}`);
    if (!/^[1-9][0-9]*$/.test(String(r.initialized_version ?? ""))) w(`initialized_version ${r.initialized_version} is not initialized`);
    if (typeof r.upgrades_frozen !== "boolean") w("upgrades_frozen is not a boolean");
    if (u.mode === "frozen" && r.upgrades_frozen !== true) w("upgrades_frozen is not true in a frozen release");
    if (r.manifest_upgrade_mode !== u.mode) w(`manifest_upgrade_mode ${r.manifest_upgrade_mode} is not the release mode ${u.mode}`);
  }
  const vaults = ev?.vaults ?? {};
  for (const k of Object.keys(vaults)) { const r = u.proxies?.[`vault[${k}]`]; if (r && ADDR.test(vaults[k]?.address ?? "") && lc(r.proxy ?? "") !== lc(vaults[k].address)) bad(`vault[${k}]: proxy ${r.proxy} is not the evidence vault ${vaults[k].address}`); }
  for (const [list, want] of [["remaining_governed_parameters", GOVERNED_PARAMETERS], ["upstream_dependencies", UPSTREAM_DEPENDENCIES]] as const) {
    const l: unknown[] = Array.isArray(u[list]) ? u[list] : [];
    // a record written before an entry was reworded lists the entry's HISTORICAL wording instead (issue 1988)
    const dropped = want.filter((x) => !l.includes(x) && !(GOVERNED_PARAMETER_HISTORY[x] ?? []).some((h) => l.includes(h)));
    if (dropped.length) bad(`${list} drops ${dropped.length} of the entries the verifier lists: a freeze never makes them immutable`);
  }
  // The claim. core_immutable true needs every proxy of the full set frozen (in the frozen mode, or an upgradeable release frozen by governance), nothing refused, and a
  // verifier that exited 0.
  const why: unknown[] = Array.isArray(u.immutability_refused_because) ? u.immutability_refused_because : [];
  if (u.core_immutable === true) {
    const open = proxies.filter((n) => u.proxies?.[n]?.upgrades_frozen !== true);
    if (open.length) bad(`core_immutable is claimed but ${open.join(", ")} are not recorded frozen`);
    if (missing.length) bad("core_immutable is claimed without the full core set");
    if (why.length) bad("core_immutable is claimed and immutability_refused_because is not empty");
    if (ev?.verifier?.exit_code !== 0) bad("core_immutable is claimed but the verifier did not exit 0");
  } else if (u.core_immutable === false) {
    if (why.length === 0) bad("core_immutable is false and immutability_refused_because does not say why");
  } else bad("core_immutable is not a boolean");
  return p;
}

/** The slice of the chain reader the online check uses (viem PublicClient names). */
export interface UpgradeabilityChain {
  getCode?(a: { address: `0x${string}` }): Promise<Hex | undefined>;
  getStorageAt?(a: { address: `0x${string}`; slot: Hex }): Promise<Hex | undefined>;
  readContract(a: { address: `0x${string}`; abi: any; functionName: string }): Promise<unknown>;
}
const GOVERNED_ABI = parseAbi(["function upgradesFrozen() view returns (bool)", "function upgradeTimelock() view returns (address)"]);

/** Every recorded proxy fact read back from the chain: the implementation slot, both code hashes, upgradesFrozen() and upgradeTimelock(). */
export async function upgradeabilityOnChainProblems(ev: any, chain: UpgradeabilityChain): Promise<string[]> {
  const p: string[] = [];
  const u = ev?.upgradeability;
  if (!u?.proxies) return p; // the offline check names the missing section
  if (!chain.getCode || !chain.getStorageAt) return ["upgradeability: this chain reader cannot read code and storage, so the proxy record cannot be checked against the chain"];
  for (const [n, r] of Object.entries<any>(u.proxies)) {
    const w = (m: string) => p.push(`upgradeability: ${n}: ${m}`);
    if (!ADDR.test(r?.proxy ?? "")) continue;
    try {
      const slot = ((await chain.getStorageAt({ address: r.proxy, slot: ERC1967_IMPLEMENTATION_SLOT })) ?? "0x").replace(/^0x/, "").padStart(64, "0");
      const impl = `0x${slot.slice(24)}`;
      if (lc(impl) !== lc(r.implementation ?? "")) w(`the implementation slot reads ${impl} on chain, the record says ${r.implementation}`);
      const pc = (await chain.getCode({ address: r.proxy })) ?? "0x";
      if (pc.length <= 2 || lc(keccak256(pc)) !== lc(r.proxy_code_hash ?? "")) w(`the proxy code hash on chain is ${pc.length > 2 ? keccak256(pc) : "empty"}, the record says ${r.proxy_code_hash}`);
      const ic = (await chain.getCode({ address: impl as `0x${string}` })) ?? "0x";
      if (ic.length <= 2 || lc(keccak256(ic)) !== lc(r.implementation_code_hash ?? "")) w(`the implementation code hash on chain is ${ic.length > 2 ? keccak256(ic) : "empty"}, the record says ${r.implementation_code_hash}`);
      const frozen = await chain.readContract({ address: r.proxy, abi: GOVERNED_ABI, functionName: "upgradesFrozen" });
      if (frozen !== r.upgrades_frozen) w(`upgradesFrozen() reads ${String(frozen)} on chain, the record says ${String(r.upgrades_frozen)}`);
      const tl = await chain.readContract({ address: r.proxy, abi: GOVERNED_ABI, functionName: "upgradeTimelock" });
      if (lc(String(tl)) !== lc(r.upgrade_timelock ?? "")) w(`upgradeTimelock() reads ${String(tl)} on chain, the record says ${r.upgrade_timelock}`);
    } catch (e) { w(`not readable on chain (${(e as Error).message})`); }
  }
  return p;
}
