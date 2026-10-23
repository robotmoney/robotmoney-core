// Issue 1809: the evidence `upgradeability` section (the copy of the upgradeability.json the verify stage writes). Offline it must cover the full proxied core set of
// the stage table and agree with itself and the evidence; the immutability claim needs the frozen mode, every proxy frozen and a clean verifier. Online every recorded proxy
// fact is read back from the chain (and from a recorded chain fixture, offline). Each refusal has its mutation: the unchanged record passes.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chainReaderFromFixture, checkEvidence, recordingChainReader, repoProxyNames, type ChainReader } from "../src/evidence-check.ts";
import { upgradeabilityEvidenceProblems, upgradeabilityOnChainProblems } from "../src/evidence-upgradeability.ts";
import { implOf, withUpgradeability, withUpgradeabilityReads } from "./upgradeability-fixture.ts";

const a = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const base = (): any => ({ timelock: { address: a(9), min_delay: 172800 }, vaults: { rmUSDC: { address: a(5) }, rmPROTO: { address: a(6) }, rmAGENT: { address: a(7) }, rmRWA: { address: a(8) } }, verifier: { exit_code: 0 } });
const NAMES = repoProxyNames();
const off = (e: any, kind: "production" | "rehearsal" = "production") => upgradeabilityEvidenceProblems(e, NAMES, kind).join("\n");
const none: ChainReader = { getChainId: async () => 8453, getTransactionCount: async () => 0, getTransactionReceipt: async () => { throw new Error("none"); }, getBlock: async () => { throw new Error("none"); }, readContract: async () => { throw new Error("no read"); } };

describe("the evidence upgradeability record, offline (issue 1809)", () => {
  test("the full core set is the stage table's eight proxies, and a frozen record and an upgradeable record each pass", () => {
    expect(NAMES).toHaveLength(8);
    expect(off(withUpgradeability(base()))).toBe("");
    expect(off(withUpgradeability(base(), "upgradeable"))).toBe("");
  });
  test("a missing section is refused, and checkEvidence runs the check", () => {
    expect(off(base())).toContain("the section is missing");
    const tpl = JSON.parse(readFileSync(join(import.meta.dir, "..", "evidence.example.json"), "utf8"));
    expect(Object.keys(tpl.upgradeability)).toEqual(expect.arrayContaining(["mode", "freeze_deadline", "timelock", "proxies", "core_immutable", "immutability_refused_because", "remaining_governed_parameters", "upstream_dependencies"]));
    expect(checkEvidence(tpl).join("\n")).toContain("upgradeability:");
  });
  test("a record without the full core set, or with a proxy the table does not list, is refused", () => {
    const e = withUpgradeability(base()); delete e.upgradeability.proxies.router;
    expect(off(e)).toContain("missing [router]");
    const x = withUpgradeability(base()); x.upgradeability.proxies["vault[rmX]"] = { ...x.upgradeability.proxies.router };
    expect(off(x)).toContain("unexpected [vault[rmX]]");
  });
  test("each proxy fact must be well formed and agree with the evidence: authority, initialization, frozen state, manifest mode, the vault address", () => {
    const cases: [(r: any, e: any) => void, string][] = [
      [(r) => { r.implementation = "0x"; }, "implementation is not an address"],
      [(r) => { r.layout_id = null; }, "layout_id is not a bytes32"],
      [(r) => { r.implementation_code_hash = "0x12"; }, "implementation_code_hash is not a bytes32"],
      [(r) => { r.upgrade_timelock = a(99); }, `upgrade_timelock ${a(99)} is not the timelock`],
      [(r) => { r.initialized_version = "0"; }, "initialized_version 0 is not initialized"],
      [(r) => { r.upgrades_frozen = false; }, "upgrades_frozen is not true in a frozen release"],
      [(r) => { r.manifest_upgrade_mode = "upgradeable"; }, "manifest_upgrade_mode upgradeable is not the release mode frozen"],
    ];
    for (const [f, msg] of cases) { const e = withUpgradeability(base()); f(e.upgradeability.proxies.gateway, e); expect(off(e), msg).toContain(`gateway: ${msg}`); }
    const v = withUpgradeability(base()); v.vaults.rmPROTO.address = a(66);
    expect(off(v)).toContain("vault[rmPROTO]: proxy");
    const t = withUpgradeability(base()); t.upgradeability.timelock.min_delay = "60";
    expect(off(t)).toContain("timelock.min_delay 60 differs");
  });
  test("the mode: an unknown mode is refused; an upgradeable production release needs its freeze deadline (a rehearsal does not); a frozen one has none", () => {
    const m = withUpgradeability(base()); m.upgradeability.mode = "mutable";
    expect(off(m)).toContain("mode 'mutable'");
    const u = withUpgradeability(base(), "upgradeable"); u.upgradeability.freeze_deadline = null;
    expect(off(u)).toContain("needs freeze_deadline");
    expect(off(u, "rehearsal")).toBe("");
    const f = withUpgradeability(base()); f.upgradeability.freeze_deadline = "2027-01-31T00:00:00Z";
    expect(off(f)).toContain("a frozen release has no freeze_deadline");
  });
  test("the immutability claim is refused unless frozen, complete, unrefused and verified; a non-claim must say why", () => {
    // an upgradeable release frozen by governance (the proving period is over) may claim; one with an open proxy may not
    const done = withUpgradeability(base(), "upgradeable"); done.upgradeability.core_immutable = true; done.upgradeability.immutability_refused_because = [];
    for (const r of Object.values<any>(done.upgradeability.proxies)) r.upgrades_frozen = true;
    expect(off(done)).toBe("");
    const up = withUpgradeability(base(), "upgradeable"); up.upgradeability.core_immutable = true; up.upgradeability.immutability_refused_because = [];
    expect(off(up)).toContain("core_immutable is claimed but");
    const open = withUpgradeability(base(), "upgradeable"); open.upgradeability.mode = "frozen"; open.upgradeability.freeze_deadline = null; open.upgradeability.core_immutable = true; open.upgradeability.immutability_refused_because = [];
    for (const r of Object.values<any>(open.upgradeability.proxies)) r.manifest_upgrade_mode = "frozen";
    expect(off(open)).toContain("are not recorded frozen");
    const why = withUpgradeability(base()); why.upgradeability.immutability_refused_because = ["x"];
    expect(off(why)).toContain("immutability_refused_because is not empty");
    const ver = withUpgradeability(base()); ver.verifier.exit_code = 1;
    expect(off(ver)).toContain("the verifier did not exit 0");
    const silent = withUpgradeability(base(), "upgradeable"); silent.upgradeability.immutability_refused_because = [];
    expect(off(silent)).toContain("does not say why");
  });
  test("the governed parameters and upstream dependencies cannot be dropped from the record", () => {
    const e = withUpgradeability(base()); e.upgradeability.remaining_governed_parameters.pop();
    expect(off(e)).toContain("remaining_governed_parameters drops 1");
    const d = withUpgradeability(base()); d.upgradeability.upstream_dependencies = [];
    expect(off(d)).toContain("upstream_dependencies drops");
  });
});

describe("the evidence upgradeability record, read back from the chain (issue 1809)", () => {
  test("a record that agrees with the chain passes; a reader without code or storage access is refused", async () => {
    const e = withUpgradeability(base());
    expect(await upgradeabilityOnChainProblems(e, withUpgradeabilityReads(e, none))).toEqual([]);
    expect((await upgradeabilityOnChainProblems(e, none)).join()).toContain("cannot read code and storage");
  });
  test("a wrong implementation, a wrong code hash, an unfrozen proxy or another authority on chain is refused", async () => {
    const e = withUpgradeability(base());
    expect((await upgradeabilityOnChainProblems(e, withUpgradeabilityReads(e, none, { impl: { router: implOf(7) } }))).join()).toContain("router: the implementation slot reads");
    const h = withUpgradeability(base()); h.upgradeability.proxies.gateway.implementation_code_hash = `0x${"ab".repeat(32)}`;
    expect((await upgradeabilityOnChainProblems(h, withUpgradeabilityReads(h, none))).join()).toContain("gateway: the implementation code hash on chain");
    expect((await upgradeabilityOnChainProblems(e, withUpgradeabilityReads(e, none, { frozen: false }))).join()).toContain("upgradesFrozen() reads false on chain, the record says true");
    const t = withUpgradeability(base());
    const r = withUpgradeabilityReads(structuredClone(t), none); // the chain keeps the deployed authority
    t.upgradeability.proxies.registry.upgrade_timelock = a(98);
    expect((await upgradeabilityOnChainProblems(t, r)).join()).toContain("registry: upgradeTimelock() reads");
  });
  test("a recorded chain fixture keeps the slots, codes and reads, so the offline replay reaches the same answer", async () => {
    const e = withUpgradeability(base());
    const { reader, fixture } = recordingChainReader(withUpgradeabilityReads(e, none));
    expect(await upgradeabilityOnChainProblems(e, reader)).toEqual([]);
    const replay = chainReaderFromFixture(JSON.parse(JSON.stringify(fixture)));
    expect(await upgradeabilityOnChainProblems(e, replay)).toEqual([]);
    const forged = withUpgradeability(base()); forged.upgradeability.proxies.router.upgrades_frozen = false;
    expect((await upgradeabilityOnChainProblems(forged, replay)).join()).toContain("router: upgradesFrozen() reads true on chain, the record says false");
  });
});
