// Issue 1892: the historical combined deployment (deployments/8453/deploy-2, one run that deployed the gateway, the agents list and the handover together) stays readable.
// Its manifests are never rewritten; the combined (legacy) reading keeps the meaning of its agent fields, and a vaults or gateway reading does not consume them.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { verifyDeployment } from "../../src/verify/index.ts";
import { loadManifests } from "../../src/verify/manifests.ts";
import { requiredManifests } from "../../src/verify/constants.ts";
import { scopeTable } from "../../src/stage-table.ts";
import { getStageTable } from "../../src/stages.ts";
import { SIG_AGENT_AUTHORIZED, SIG_AGENT_OWNERSHIP, stageManifestFile } from "../../src/verify/constants.ts";
import { padTopic } from "../../src/verify/logs.ts";
import { keccak256, toHex } from "viem";
import { GATEWAY, OWNERS, buildWorld, failed } from "./world.ts";
import { REPO } from "../fixtures.ts";

const DEPLOY2 = join(REPO, "deployments", "8453", "deploy-2");
const legacy = scopeTable(getStageTable(), "legacy");

describe("deployments/8453/deploy-2, the combined deployment (issue 1892)", () => {
  test("every manifest the combined reading requires is committed there, and the vaults list names four vaults", () => {
    const m = loadManifests(DEPLOY2, legacy);
    expect(m.missing).toEqual([]);
    expect(m.vaults.length).toBe(4);
    expect(requiredManifests(legacy).sort()).toEqual(readdirSync(DEPLOY2).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort());
    // the gateway handover manifest belongs to the gateway system only: the combined deployment never had one
    expect(requiredManifests(legacy)).not.toContain("gateway-handover");
    expect(requiredManifests(scopeTable(getStageTable(), "vaults"))).not.toContain("gateway");
  });
  test("its timelock manifest keeps the legacy agent fields and their meaning: zero listed agents, none owned by the deployer, the timelock holding the gateway default admin", () => {
    const t = JSON.parse(readFileSync(join(DEPLOY2, "timelock.json"), "utf8"));
    expect(t.roles.gateway_agents_listed_count).toBe(0);
    expect(t.roles.deployer_owns_a_listed_gateway_agent).toBe(false);
    expect(t.roles.timelock_has_gateway_default_admin_role).toBe(true);
    expect(t.addresses.gateway).toBe(t.gateway);
  });
  test("the combined reading checks those fields and both agent events; the vaults reading consumes none of them", async () => {
    const roles = JSON.parse(readFileSync(join(DEPLOY2, "timelock.json"), "utf8")).roles;
    const w = buildWorld();
    const tlFile = join(w.manifestDir, stageManifestFile(w.opts.table, "timelock"));
    const tl = JSON.parse(readFileSync(tlFile, "utf8"));
    writeFileSync(tlFile, JSON.stringify({ ...tl, roles: { ...tl.roles, ...roles } }));
    expect(failed(await verifyDeployment(w.opts))).toEqual([]);
    // tampered historical manifest: a listed agent, or a deployer-owned one
    writeFileSync(tlFile, JSON.stringify({ ...tl, roles: { ...roles, gateway_agents_listed_count: 1 } }));
    expect(failed(await verifyDeployment(w.opts))).toEqual(["agents: manifest lists zero agents"]);
    writeFileSync(tlFile, JSON.stringify({ ...tl, roles: { ...roles, deployer_owns_a_listed_gateway_agent: true } }));
    expect(failed(await verifyDeployment(w.opts))).toEqual(["agents: manifest says deployer owns no listed agent"]);
    // and the transferred-ownership replay is still read, as history
    writeFileSync(tlFile, JSON.stringify({ ...tl, roles }));
    w.chain.logs.push({ address: GATEWAY, topics: [keccak256(toHex(SIG_AGENT_OWNERSHIP)), padTopic(OWNERS[0]!), padTopic(OWNERS[1]!)], data: "0x", blockNumber: 300n });
    expect(failed(await verifyDeployment(w.opts))).toEqual(["agents: no agent authorized at handover"]);
    // the vaults reading ignores the gateway's agent history and the manifest fields entirely
    writeFileSync(tlFile, JSON.stringify({ ...tl, roles: { ...roles, gateway_agents_listed_count: 1 } }));
    w.chain.logs.push({ address: GATEWAY, topics: [keccak256(toHex(SIG_AGENT_AUTHORIZED)), padTopic(OWNERS[0]!), padTopic(OWNERS[1]!)], data: "0x", blockNumber: 301n });
    const sum = Object.values(w.opts.frozenCounts).reduce((a, b) => a + b, 0) - 3;
    w.chain.noncesMap.set(w.opts.sheet.deployer.toLowerCase(), sum + 1);
    const vaults = await verifyDeployment({ ...w.opts, system: "vaults", frozenCounts: { ...w.opts.frozenCounts, "vault-proto": undefined as never, gateway: 3 } });
    expect(vaults.checks.some((c) => c.label.startsWith("agents:"))).toBe(false);
  });
  test("copying the historical manifests elsewhere changes none of them (they are read, never rewritten)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy2-"));
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(DEPLOY2).filter((x) => x.endsWith(".json"))) copyFileSync(join(DEPLOY2, f), join(dir, f));
    const m = loadManifests(dir, legacy);
    expect(m.missing).toEqual([]);
    expect(m.files.timelock.roles.gateway_agents_listed_count).toBe(0);
  });
});
