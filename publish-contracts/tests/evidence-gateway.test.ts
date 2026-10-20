// Issue 1892: the evidence of a gateway system run is checked on its own, a vaults evidence refuses the gateway system's stages, and an evidence of the wrong system is refused.
// The historical combined evidence (no `system`) keeps its reading (tests/evidence-check.test.ts).
import { describe, expect, test } from "bun:test";
import { checkEvidence, checkEvidenceOnChain, type ChainReader } from "../src/evidence-check.ts";
import { GATEWAY_EVIDENCE_STAGES, checkGatewayEvidence } from "../src/evidence-gateway.ts";

const a = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
const h = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;
const SHA = "a".repeat(40);
const FROZEN = { gateway: 3, "gateway-handover": 4, vault: 18, timelock: 25 };

function gatewayEvidence(): any {
  return {
    system: "gateway", deployment_kind: "production", chain_id: 8453, core_sha: SHA, deployer: a(0xde), deployer_start_nonce: 118, deployer_nonce_final: 118 + 7,
    stages: [
      { stage: "gateway", frozen_count: 3, receipt_count: 3, tx_hashes: [h(1), h(2), h(3)], receipts_status: [1, 1, 1] },
      { stage: "gateway-handover", frozen_count: 4, receipt_count: 4, tx_hashes: [h(4), h(5), h(6), h(7)], receipts_status: [1, 1, 1, 1] },
    ],
    gateway: { address: a(0x6a), implementation: a(0x6b), upgrade_timelock: a(0x71), upgrade_mode: "frozen", admin: a(0xad) },
    vaults_system: { router: a(0x40), vault: a(0x41), manifests_unchanged: true },
    agents_at_handover: 0, verifier: { exit_code: 0 },
  };
}
const problems = (e: any, opts = {}): string => checkGatewayEvidence(e, FROZEN, opts).join("\n");

describe("a gateway system evidence (issue 1892)", () => {
  test("a complete gateway evidence passes, and checkEvidence routes system gateway to it", () => {
    expect(checkGatewayEvidence(gatewayEvidence(), FROZEN)).toEqual([]);
    expect(checkEvidence(gatewayEvidence(), FROZEN)).toEqual([]);
    expect(GATEWAY_EVIDENCE_STAGES).toEqual(["gateway", "gateway-handover"]);
  });
  test("an evidence of the wrong system is refused: a vaults evidence presented as gateway, a gateway evidence carrying vaults keys or stages", () => {
    const vaults = { ...gatewayEvidence(), system: "vaults" };
    expect(checkEvidence(vaults, FROZEN).join("\n")).toContain("gateway stage");
    expect(problems({ ...gatewayEvidence(), system: undefined })).toContain('system is undefined, a gateway evidence says "gateway"');
    for (const key of ["safe", "timelock", "govern", "consensus_receipt", "registry", "vaults", "committee_registrations", "recorded_receipts"]) {
      expect(problems({ ...gatewayEvidence(), [key]: {} }), key).toContain(`'${key}' belongs to the vaults system's evidence`);
    }
    const vaultsStage = gatewayEvidence();
    vaultsStage.stages.push({ stage: "timelock", frozen_count: 25, receipt_count: 25, tx_hashes: [], receipts_status: [] });
    expect(problems(vaultsStage)).toContain("the gateway system runs [gateway, gateway-handover]");
    expect(checkEvidence({ system: "other" }, FROZEN)).toEqual(["system 'other' is not vaults or gateway"]);
  });
  test("a vaults evidence that names its system carries no gateway stage and no gateway section", () => {
    const v: any = { system: "vaults", stages: [{ stage: "gateway", frozen_count: 3, receipt_count: 3, tx_hashes: [], receipts_status: [] }], gateway: {} };
    const p = checkEvidence(v, FROZEN).join("\n");
    expect(p).toContain("stage gateway belongs to the gateway system");
    expect(p).toContain("'gateway' belongs to the gateway system's evidence");
  });
  test("provenance: the upgrade timelock and the admin must be named, nonzero and not the deployer; the governance is never the vaults default by omission", () => {
    for (const f of ["address", "implementation", "upgrade_timelock", "admin"]) {
      const e = gatewayEvidence(); delete e.gateway[f];
      expect(problems(e), f).toContain(`gateway.${f} is not an address`);
    }
    const zero = gatewayEvidence(); zero.gateway.upgrade_timelock = "0x" + "0".repeat(40);
    expect(problems(zero)).toContain("gateway.upgrade_timelock is the zero address");
    const dep = gatewayEvidence(); dep.gateway.admin = dep.deployer;
    expect(problems(dep)).toContain("gateway.admin is the deployer");
    const mode = gatewayEvidence(); mode.gateway.upgrade_mode = "";
    expect(problems(mode)).toContain("upgrade_mode");
    const vs = gatewayEvidence(); vs.vaults_system.manifests_unchanged = false;
    expect(problems(vs)).toContain("vaults_system.manifests_unchanged is not true");
    const addr = gatewayEvidence(); delete addr.vaults_system.router;
    expect(problems(addr)).toContain("vaults_system.router is not an address");
  });
  test("zero agents at handover and an exit-0 verifier are required", () => {
    expect(problems({ ...gatewayEvidence(), agents_at_handover: 1 })).toContain("agents_at_handover is 1");
    expect(problems({ ...gatewayEvidence(), agents_at_handover: undefined })).toContain("agents_at_handover is undefined");
    expect(problems({ ...gatewayEvidence(), verifier: { exit_code: 13 } })).toContain("the verifier did not exit 0");
  });
  test("counts: each stage equals its frozen count, a missing or failed receipt fails, and the final nonce is the recorded start plus the gateway counts", () => {
    const e = gatewayEvidence(); e.stages[1].receipt_count = 3;
    expect(problems(e)).toContain("stage gateway-handover: frozen_count 4 differs from receipt_count 3");
    const f = gatewayEvidence(); f.stages[0].receipts_status[1] = 0;
    expect(problems(f)).toContain("stage gateway: receipt 1 status is 0, not 1");
    const n = gatewayEvidence(); n.deployer_nonce_final = 118 + 6;
    expect(problems(n)).toContain("deployer_nonce_final 124 differs from the start nonce 118 plus the gateway frozen counts 7");
    const s = gatewayEvidence(); delete s.deployer_start_nonce;
    expect(problems(s)).toContain("deployer_start_nonce is missing");
    expect(checkGatewayEvidence(gatewayEvidence(), { gateway: 3 }).join("\n")).toContain("the frozen file has no count for it");
  });
  test("a production evidence presented as a rehearsal, and a placeholder sha, are refused", () => {
    expect(problems(gatewayEvidence(), { kind: "rehearsal" })).toContain("deployment_kind is production, the evidence is checked as rehearsal");
    expect(problems({ ...gatewayEvidence(), core_sha: "0".repeat(40) })).toContain("core_sha is missing or a placeholder");
  });
});

describe("a gateway system evidence on chain (issue 1892)", () => {
  const reader = (over: Partial<{ nonce: number; status: "success" | "reverted"; timelock: string; id: number }> = {}): ChainReader => ({
    getChainId: async () => over.id ?? 8453,
    getTransactionCount: async () => over.nonce ?? 125,
    getTransactionReceipt: async () => ({ status: over.status ?? "success", blockNumber: 1n, logs: [] }),
    getBlock: async () => ({ timestamp: 1n }),
    readContract: async () => over.timelock ?? a(0x71),
  } as unknown as ChainReader);
  test("the nonce, every receipt and the gateway's upgradeTimelock() read back from the chain", async () => {
    expect(await checkEvidenceOnChain(gatewayEvidence(), reader(), FROZEN)).toEqual([]);
    expect((await checkEvidenceOnChain(gatewayEvidence(), reader({ nonce: 130 }), FROZEN)).join("\n")).toContain("deployer nonce on chain is 130");
    expect((await checkEvidenceOnChain(gatewayEvidence(), reader({ status: "reverted" }), FROZEN)).join("\n")).toContain("receipt on chain is reverted");
    expect((await checkEvidenceOnChain(gatewayEvidence(), reader({ timelock: a(0xbad) }), FROZEN)).join("\n")).toContain("gateway upgradeTimelock() on chain is");
    expect((await checkEvidenceOnChain(gatewayEvidence(), reader({ id: 1 }), FROZEN)).join("\n")).toContain("the RPC reports chain 1");
  });
});
