// Security round 2 (review: SECURITY_LAYOUT_GATE_GAP, SECURITY_STORAGE_LAYOUT_DRIFT): the live-versus-build layout compare of upgrade-proxy (layout-compare.ts) holds
// every stored enum's members append-only, like scripts/ci/storage_layout_gate.py compare. A stored enum is its member's index, and a reorder or an insert keeps every
// type label and struct member list byte-identical, so before this rule no other rule saw it.
//
// Security round 3 (review: SECURITY_LAYOUT_GATE_GAP): a build snapshot must record every struct and enum its storage reaches. The struct and enum rules skipped what the
// build's snapshot left out, so a snapshot with AssetInfo and Venue deleted by hand passed a changed struct or a reordered enum on 8453.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asLayoutSnapshot, layoutAppendOnlyProblems, storedEnumsOf, storedStructsOf, type LayoutSnapshot } from "../src/layout-compare.ts";
import { upgradeLayoutRefusals } from "../src/upgrade-rows.ts";
import { REPO_ROOT } from "./repo-root.ts";

const E = "enum Probe.Mode";
/** A proxied contract whose storage holds the enum in a mapping and inside a struct. */
const snap = (members?: string[]): LayoutSnapshot => ({
  contract: "Probe",
  storage: [
    { contract: "Probe", label: "modeOf", slot: 0, offset: 0, bytes: 32, type: `mapping(address => ${E})` },
    { contract: "Probe", label: "info", slot: 1, offset: 0, bytes: 32, type: "mapping(address => struct Probe.Info)" },
  ],
  structs: { "struct Probe.Info": [{ label: "mode", slot: 0, offset: 0, type: E }, { label: "cap", slot: 1, offset: 0, type: "uint256" }] },
  ...(members ? { enums: { [E]: members } } : {}),
  linearization: ["contracts/Probe.sol:Probe", "contracts/lib/GovernedUpgrade.sol:GovernedUpgrade"],
});

describe("security round 2: a stored enum's existing members may only be appended", () => {
  test("a live enum [A, B, C] against a build [A, D, B, C] is refused, and so is a reorder or a removal", () => {
    expect(layoutAppendOnlyProblems(snap(["A", "B", "C"]), snap(["A", "D", "B", "C"])).join()).toContain(`storage enum "${E}" changed its existing members ["A","B","C"] -> ["A","D","B","C"]`);
    expect(layoutAppendOnlyProblems(snap(["A", "B", "C"]), snap(["A", "C", "B"]))).toHaveLength(1);
    expect(layoutAppendOnlyProblems(snap(["A", "B", "C"]), snap(["A", "B"]))).toHaveLength(1);
    expect(layoutAppendOnlyProblems(snap(["A", "B", "C"]), snap(["A", "B", "X"]))).toHaveLength(1); // a rename reinterprets C's stored value too
  });

  test("mutation: a live enum [A, B, C] against a build [A, B, C, D] passes, and an unchanged one passes", () => {
    expect(layoutAppendOnlyProblems(snap(["A", "B", "C"]), snap(["A", "B", "C", "D"]))).toEqual([]);
    expect(layoutAppendOnlyProblems(snap(["A", "B", "C"]), snap(["A", "B", "C"]), { requireEnums: true })).toEqual([]);
  });

  test("the stored enums are found in variables, mapping values and struct members", () => {
    expect([...storedEnumsOf(snap())]).toEqual([E]);
    const onlyStruct = { ...snap(), storage: [snap().storage[1]!] };
    expect([...storedEnumsOf(onlyStruct)]).toEqual([E]);
  });

  test("with requireEnums (8453) a snapshot that records no enum members while storage holds an enum is refused, live or build; without it, it passes", () => {
    expect(layoutAppendOnlyProblems(snap(), snap(["A", "B"]), { requireEnums: true }).join()).toContain("the live layout snapshot records no enum members");
    expect(layoutAppendOnlyProblems(snap(["A", "B"]), snap(), { requireEnums: true }).join()).toContain("the build's layout snapshot records no enum members");
    expect(layoutAppendOnlyProblems(snap(), snap(["B", "A"]))).toEqual([]);
    // a contract whose storage holds no enum needs no enums map
    const plain: LayoutSnapshot = { ...snap(), storage: [{ contract: "Probe", label: "cap", slot: 0, offset: 0, bytes: 32, type: "uint256" }], structs: {} };
    expect(layoutAppendOnlyProblems(plain, plain, { requireEnums: true })).toEqual([]);
  });

  test("a build snapshot that still stores the enum and records none of its members is refused on every chain", () => {
    const missing = { ...snap(["A", "B"]), enums: {} };
    expect(layoutAppendOnlyProblems(snap(["A", "B"]), missing).join()).toContain(`stores "${E}" and records none of its members`);
  });

  test("a malformed enums map is no snapshot", () => {
    expect(asLayoutSnapshot({ ...snap(), enums: [] })).toBe("the enums map is not a map");
    expect(asLayoutSnapshot({ ...snap(), enums: { [E]: [1, 2] } })).toContain("has no list of member names");
    expect(typeof asLayoutSnapshot(snap(["A"]))).toBe("object");
  });
});

describe("security round 3: a build snapshot must record every struct and enum its storage reaches", () => {
  const INFO = "struct BasketAssetConfigGuard.AssetInfo";
  const VENUE = "enum BasketAssetConfigGuard.Venue";
  const agent = (): LayoutSnapshot => JSON.parse(readFileSync(join(REPO_ROOT, "contracts", "test", "fixtures", "storage-layout", "AgentTokenVault.json"), "utf8"));
  /** The committed AgentTokenVault snapshot with `drop` deleted from its structs and enums maps, every storage row kept. */
  const without = (...drop: string[]): LayoutSnapshot => {
    const s = agent();
    return { ...s, structs: Object.fromEntries(Object.entries(s.structs).filter(([k]) => !drop.includes(k))), enums: Object.fromEntries(Object.entries(s.enums ?? {}).filter(([k]) => !drop.includes(k))) };
  };
  const refusals = (build: LayoutSnapshot, mainnet: boolean) => upgradeLayoutRefusals({ name: "agentVault", artifact: "AgentTokenVault", liveField: "agent_vault_layout_id", mainnet, liveId: `0x${"01".repeat(32)}`, live: agent(), buildId: `0x${"02".repeat(32)}`, build });

  test("the real AgentTokenVault snapshot stores assets as AssetInfo[] whose venue member is a Venue", () => {
    const s = agent();
    expect(s.storage.find((r) => r.label === "assets")?.type).toBe(`${INFO}[]`);
    expect(s.structs[INFO]?.find((m) => m.label === "venue")?.type).toBe(VENUE);
    expect(s.enums?.[VENUE]).toEqual(["V3", "V4", "Aerodrome"]);
    expect(storedStructsOf(s).has(INFO)).toBe(true);
  });

  test("a build snapshot that keeps `assets: struct BasketAssetConfigGuard.AssetInfo[]` but drops the AssetInfo struct and the Venue enum is refused on 8453", () => {
    const dropped = without(INFO, VENUE);
    expect(dropped.storage.find((r) => r.label === "assets")?.type).toBe(`${INFO}[]`);
    // the round-2 enum rule alone: storedEnumsOf cannot see Venue once AssetInfo is gone
    expect(storedEnumsOf(dropped).has(VENUE)).toBe(false);
    expect(layoutAppendOnlyProblems(agent(), dropped, { requireEnums: true }).join()).toContain(`the build's layout snapshot stores "${INFO}" and records none of its members`);
    const r = refusals(dropped, true);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain(`stores "${INFO}" and records none of its members`);
    // and on every other chain: the build's own snapshot is incomplete, whatever the chain
    expect(refusals(dropped, false).join()).toContain(`stores "${INFO}"`);
  });

  test("the deliberate variant: Venue reordered (written with --write), then deleted by hand while AssetInfo is kept, is refused naming Venue", () => {
    const reordered = { ...agent(), enums: { ...agent().enums, [VENUE]: ["V4", "V3", "Aerodrome"] } };
    expect(refusals(reordered, true).join()).toContain(`storage enum "${VENUE}" changed its existing members`);
    const r = refusals(without(VENUE), true);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain(`stores "${VENUE}" and records none of its members, so a reordered or inserted member could not be seen`);
  });

  test("mutation: the unmodified snapshot passes on 8453, and a recorded struct no variable reaches any more is no refusal of its own", () => {
    expect(refusals(agent(), true)).toEqual([]);
    expect(layoutAppendOnlyProblems(agent(), agent(), { requireEnums: true })).toEqual([]);
    const s = agent();
    const unreached = { ...s, structs: { ...s.structs, "struct Probe.Unused": [{ label: "x", slot: 0, offset: 0, type: "uint256" }] } };
    expect(layoutAppendOnlyProblems(s, unreached, { requireEnums: true })).toEqual([]);
  });
});
