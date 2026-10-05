import { expect, test } from "bun:test";
import { loadStageTable, stagesFromTable } from "../../deploy/core-stages.ts";
import { buildReport, labelRows, render } from "../twin-run-report.ts";

const table = loadStageTable();
const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");

/** A manifest per table stage, holding exactly the keys the runner says that stage writes. */
function fullManifests(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let n = 1;
  for (const st of stagesFromTable(table)) {
    const m: Record<string, unknown> = {};
    for (const k of st.writes) m[k] = A(n++);
    if (st.name === "gateway") m.gateway_router = out["router.json"].router;
    out[st.manifestFile] = m;
  }
  return out;
}
const runManifest = () => ({ stages: Object.fromEntries(table.stages.map((s, i) => [s.name, { count: i + 1 }])) });

test("a complete run reports every stage, the four vaults and the transaction total", () => {
  const r = buildReport({ table, manifests: fullManifests(), runManifest: runManifest(), labelsText: "PASS a: x\nPASS b\nRESULT: VERIFIED\n" });
  expect(r.problems).toEqual([]);
  expect(r.stages.length).toBe(table.stages.length);
  expect(r.vaults.map((v) => v.key)).toEqual(table.vaults.map((v) => v.key));
  expect(r.vaults.every((v) => v.address)).toBe(true);
  expect(r.totalTx).toBe(table.stages.reduce((n, _s, i) => n + i + 1, 0));
  expect(r.labels.length).toBe(2);
  const text = render(r);
  expect(text).toContain("Vault set");
  expect(text).toContain("does not prove the real timelock delay");
});

test("the merged manifest carries the namespaced basket keys the assertion scripts read", () => {
  const r = buildReport({ table, manifests: fullManifests(), runManifest: null, labelsText: null });
  for (const k of ["vault", "protocol_vault", "agent_vault", "rwa_vault", "registry", "router", "gateway"]) expect(r.merged[k]).toBeDefined();
});

test("a missing stage manifest is a problem and names the file", () => {
  const m = fullManifests();
  const rwa = table.stages.find((s) => s.name === "rwa")!.manifest.split("/").pop()!;
  delete m[rwa];
  const r = buildReport({ table, manifests: m, runManifest: null, labelsText: null });
  expect(r.problems.some((p) => p.includes(rwa))).toBe(true);
  expect(r.vaults.find((v) => v.key === "RWA")!.address).toBeNull();
});

test("a failing verifier label is a problem and an empty label file is a problem", () => {
  const bad = buildReport({ table, manifests: fullManifests(), runManifest: null, labelsText: "PASS a\nFAIL b: why\n" });
  expect(bad.problems).toContain("verifier label failed: b");
  const empty = buildReport({ table, manifests: fullManifests(), runManifest: null, labelsText: "\n" });
  expect(empty.problems).toContain("the verifier output holds no labels");
});

test("labelRows reads plain and json rows", () => {
  expect(labelRows('PASS x: y\n{"label":"z","ok":false}\nRESULT: nope')).toEqual([
    { label: "x", ok: true },
    { label: "z", ok: false },
  ]);
});

test("labelRows reads the devops format: [verify] then one bare label per line is a passing label; other sections are not labels", () => {
  expect(labelRows("[verify]\nchain: id equals sheet\nsafe: has code\n[canary]\nreads: x")).toEqual([
    { label: "chain: id equals sheet", ok: true },
    { label: "safe: has code", ok: true },
  ]);
});
