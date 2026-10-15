// ADR-0014 §8 (the storage-layout identifier the deploy manifest records) and §5 (what a freeze does and does not make immutable), issue 1809.
// Pure: the repository's committed layout snapshots and a fake manifest reader.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { immutabilityOf, layoutIdFieldOf, STILL_MUTABLE_AFTER_FREEZE, type ProxyRecord } from "../src/proxies.ts";
import { layoutHashOf, proxyEvidence } from "../src/verify-stage.ts";
import { getStageTable } from "../src/stages.ts";
import { tableProxies } from "../src/stage-table.ts";

const CORE = join(import.meta.dir, "..", "..");
const rec = (name: string, frozen: boolean | null = false): ProxyRecord => ({
  name, proxy: "0x0000000000000000000000000000000000001001", implementation: "0x0000000000000000000000000000000000002001",
  implementation_code_hash: `0x${"aa".repeat(32)}`, proxy_code_hash: `0x${"bb".repeat(32)}`, authority: null, mode: "upgradeable", frozen,
  admin_slot_empty: true, beacon_slot_empty: true,
});

describe("storage-layout identifier (ADR-0014 §8)", () => {
  test("the manifest field sits next to the implementation field", () => {
    expect(tableProxies(getStageTable()).map(layoutIdFieldOf).sort()).toEqual(
      ["consensus_receipt_layout_id", "gateway_layout_id", "policy_layout_id", "registry_layout_id", "router_layout_id", "vault_layout_id", "vault_layout_id", "vault_layout_id", "vault_layout_id"].sort(),
    );
  });

  test("a deploy-recorded identifier wins over the checkout's, and the checkout's is kept next to it", () => {
    const checkout = layoutHashOf(CORE, "RobotMoneyGateway")!;
    expect(checkout).toMatch(/^0x[0-9a-f]{64}$/);
    const recorded = `0x${"11".repeat(32)}`;
    const [g] = proxyEvidence({ coreDir: CORE }, [rec("gateway")], (stage, field) => (stage === "gateway" && field === "gateway_layout_id" ? recorded : undefined));
    expect(g).toMatchObject({ layout_hash: recorded, layout_source: "deploy-manifest", checkout_layout_hash: checkout });
  });

  test("without a recorded identifier, or after an executed upgrade, the checkout's snapshot is the identifier", () => {
    const checkout = layoutHashOf(CORE, "VaultRegistry")!;
    const [r] = proxyEvidence({ coreDir: CORE }, [rec("registry")]);
    expect(r).toMatchObject({ layout_hash: checkout, layout_source: "checkout" });
    const [u] = proxyEvidence({ coreDir: CORE }, [rec("registry")], () => `0x${"11".repeat(32)}`, new Set(["registry"]));
    expect(u).toMatchObject({ layout_hash: checkout, layout_source: "checkout" });
  });

  // Security round 1: before, an upgraded proxy fell back to this checkout's snapshot, so no label ever compared the layout an upgrade installed.
  test("an upgraded proxy carries the layout its round recorded, held to the snapshot of the round's build checkout", () => {
    const recorded = layoutHashOf(CORE, "VaultRegistry")!;
    // the round's build dir is out/ of this repository's checkout: its snapshot is the same file, so the two agree
    const rounds = new Map([["registry", { layoutHash: recorded, buildDir: join(CORE, "out") }]]);
    const [u] = proxyEvidence({ coreDir: "/nowhere" }, [rec("registry")], () => `0x${"11".repeat(32)}`, new Set(["registry"]), rounds);
    expect(u).toMatchObject({ layout_hash: recorded, layout_source: "upgrade-round", checkout_layout_hash: recorded });
    // a recorded layout the build checkout does not hold: the two differ, so the verify label and evidence-check fail it
    const [m] = proxyEvidence({ coreDir: CORE }, [rec("registry")], undefined, new Set(["registry"]), new Map([["registry", { layoutHash: `0x${"33".repeat(32)}`, buildDir: join(CORE, "out") }]]));
    expect(m).toMatchObject({ layout_source: "upgrade-round", layout_hash: `0x${"33".repeat(32)}`, checkout_layout_hash: recorded });
    // a round that recorded no layout keeps the old reading
    const [o] = proxyEvidence({ coreDir: CORE }, [rec("registry")], undefined, new Set(["registry"]), new Map([["registry", { buildDir: join(CORE, "out") }]]));
    expect(o).toMatchObject({ layout_source: "checkout" });
  });
});

describe("immutability statement (ADR-0014 §5)", () => {
  const names = tableProxies(getStageTable()).map((p) => p.name);

  test("core logic is immutable only when every proxy reads frozen", () => {
    const some = immutabilityOf(names.map((n, i) => rec(n, i > 0)), names);
    expect(some.core_logic_immutable).toBe(false);
    expect(some.upgradeable).toEqual([names[0]!]);
    const all = immutabilityOf(names.map((n) => rec(n, true)), names);
    expect(all.core_logic_immutable).toBe(true);
    expect(all.upgradeable).toEqual([]);
    // A read that failed (null) is never frozen.
    expect(immutabilityOf(names.map((n) => rec(n, null)), names).core_logic_immutable).toBe(false);
  });

  test("the statement always lists the governed parameters and upstream dependencies a freeze leaves mutable", () => {
    const s = immutabilityOf(names.map((n) => rec(n, true)), names);
    expect(s.still_mutable).toBe(STILL_MUTABLE_AFTER_FREEZE);
    expect(s.still_mutable.governed_parameters.length).toBeGreaterThan(3);
    expect(s.still_mutable.upstream_dependencies.join(" ")).toContain("USDC");
  });
});
