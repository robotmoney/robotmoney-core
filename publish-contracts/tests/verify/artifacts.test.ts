// The verifier's code-hash targets come from core's stage table: each vault against its own artifact, each library against its library
// artifact, each core contract against table.artifacts. Fixtures only (an in-memory chain, artifact files on disk).
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { getStageTable } from "../../src/stages.ts";
import { verifyDeployment } from "../../src/verify/index.ts";
import { coreContracts } from "../../src/verify/constants.ts";
import { loadManifests } from "../../src/verify/manifests.ts";
import { buildWorld, failed, VAULTS } from "./world.ts";

const table = getStageTable();
const art = (key: "USDC" | "PROTO" | "AGENT" | "RWA") => table.vaults.find((v) => v.key === key)!.artifact;
const codeLabel = (l: string) => `${l}: runtime code equals build artifact (masked)`;

describe("verify artifacts come from the core table", () => {
  test("rmRWA is checked against RwaBasketVault and rmAGENT against AgentTokenVault", async () => {
    expect(art("RWA")).toBe("RwaBasketVault");
    expect(art("AGENT")).toBe("AgentTokenVault");
    const w = buildWorld();
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([]);
    expect(r.checks.find((c) => c.label === codeLabel("vault[rmRWA]"))!.detail).toContain("RwaBasketVault");
    expect(r.checks.find((c) => c.label === codeLabel("vault[rmAGENT]"))!.detail).toContain("AgentTokenVault");
    expect(r.checks.find((c) => c.label === codeLabel("vault[rmPROTO]"))!.detail).toContain("ProtocolAssetVault");
    expect(r.checks.find((c) => c.label === codeLabel("vault[rmUSDC]"))!.detail).toContain("RobotMoneyVault");
  });

  test("rmRWA running ProtocolAssetVault code fails (it must be RwaBasketVault)", async () => {
    const w = buildWorld();
    w.chain.codes.set(VAULTS.rmRWA.address.toLowerCase(), w.chain.codes.get(VAULTS.rmPROTO.address.toLowerCase())!);
    expect(failed(await verifyDeployment(w.opts))).toEqual([codeLabel("vault[rmRWA]")]);
  });

  test("rmAGENT running basket code fails", async () => {
    const w = buildWorld();
    w.chain.codes.set(VAULTS.rmAGENT.address.toLowerCase(), w.chain.codes.get(VAULTS.rmPROTO.address.toLowerCase())!);
    expect(failed(await verifyDeployment(w.opts))).toEqual([codeLabel("vault[rmAGENT]")]);
  });

  test("a missing RwaBasketVault build artifact fails that vault only", async () => {
    const w = buildWorld();
    rmSync(join(w.artifactsDir, "RwaBasketVault.sol"), { recursive: true });
    expect(failed(await verifyDeployment(w.opts))).toEqual([codeLabel("vault[rmRWA]")]);
  });

  test("the library is checked against the table's library artifact (TickMath), not its manifest key", async () => {
    const w = buildWorld();
    const r = await verifyDeployment(w.opts);
    const lib = table.libraries[0]!;
    expect(r.checks.find((c) => c.label === codeLabel(`library[${lib.name}]`))!.detail).toContain(lib.artifact);
    rmSync(join(w.artifactsDir, `${lib.artifact}.sol`), { recursive: true });
    expect(failed(await verifyDeployment(w.opts))).toEqual([codeLabel(`library[${lib.name}]`)]);
  });

  test("every core contract is checked against the table's artifact name", async () => {
    const w = buildWorld();
    const r = await verifyDeployment(w.opts);
    for (const c of coreContracts(table)) expect(r.checks.find((x) => x.label === codeLabel(c.name))!.detail, c.name).toContain(c.artifact);
  });

  test("the manifest loader reads vaults and libraries by the table's files and keys", () => {
    const w = buildWorld();
    const m = loadManifests(w.manifestDir, table);
    expect(m.missing).toEqual([]);
    expect(m.vaults.map((v) => [v.key, v.artifact])).toEqual([["rmUSDC", art("USDC")], ["rmPROTO", art("PROTO")], ["rmAGENT", art("AGENT")], ["rmRWA", art("RWA")]]);
    expect(Object.keys(m.libraries)).toEqual(table.libraries.map((l) => l.name));
    expect(m.libraryArtifacts[table.libraries[0]!.name]).toBe(table.libraries[0]!.artifact);
  });
});
