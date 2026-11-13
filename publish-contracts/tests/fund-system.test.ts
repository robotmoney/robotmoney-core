// Deploy 4: the fund system (the one-vault prototype as a rehearsal on 8453) in the deploy tool. Its stage rows, its handover and control proof, the env each stage gets from
// the single mapping module, its own sheet and every refusal of it, the table rule that its proxies come before its own timelock, and the CLI verbs it allows.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCli } from "../src/cli.ts";
import { requiredSheetNames, resolveEnv } from "../src/core-wiring.ts";
import { FUND_ONLY_NAMES, SHEET_SPEC, parseSheet } from "../src/sheet.ts";
import { buildStages, handoverStageOf, peekStageState, restoreStageState, useStageTable, STAGE_NAMES, DEPLOYER_STAGES, proofNoncesBefore } from "../src/stages.ts";
import { loadStageTable, parseStageTable, scopeTable } from "../src/stage-table.ts";
import { FUND_PROXY_NAMES, proxySpecs } from "../src/verify/upgradeability.ts";

const ROOT = join(import.meta.dir, "..", "..");
const table = loadStageTable(ROOT);
const SHEET = readFileSync(join(ROOT, "deployments", "base-8453-rehearsal", "deploy-4.env"), "utf8").replace(/^KEEPER_ADDRESS=$/m, "KEEPER_ADDRESS=0x1111111111111111111111111111111111111111");
const FUND = ["fund-libs", "fund-receipt", "fund", "rebalancer", "fund-governance", "queue", "fund-wiring", "fund-timelock"];
const withLine = (name: string, value: string | null): string => {
  const re = new RegExp(`^${name}=.*$`, "m");
  return value === null ? SHEET.replace(re, "") : re.test(SHEET) ? SHEET.replace(re, `${name}=${value}`) : `${SHEET}\n${name}=${value}\n`;
};
const fundSheet = (text = SHEET) => parseSheet(text, { system: "fund", now: () => Date.UTC(2026, 10, 12) });

describe("the fund system's stage rows (Deploy 4)", () => {
  test("safe, the fund stages in table order with prove-control right before fund-timelock, then verify; no govern row", () => {
    expect(buildStages(table, "fund").map((r) => r.name)).toEqual(["safe", "fund-libs", "fund-receipt", "fund", "rebalancer", "fund-governance", "queue", "fund-wiring", "prove-control", "fund-timelock", "verify"]);
    expect(handoverStageOf(table, "fund")).toBe("fund-timelock");
    expect(handoverStageOf(table, "vaults")).toBe("timelock");
    // the vaults system's rows are unchanged by the fund system
    expect(buildStages(table, "vaults").map((r) => r.name)).not.toContain("fund");
    expect(buildStages(table, "vaults").at(-1)!.name).toBe("govern");
  });
  test("useStageTable(fund): the deployer stages are the Safe and the fund stages, and the control proof counts only before the handover", () => {
    const saved = peekStageState();
    try {
      useStageTable(table, "fund");
      expect(STAGE_NAMES).not.toContain("vault");
      expect(DEPLOYER_STAGES.map((s) => s.name)).toEqual(["safe", ...FUND]);
      expect(proofNoncesBefore("fund-wiring")).toBe(0);
      expect(proofNoncesBefore("fund-timelock")).toBe(1);
    } finally { restoreStageState(saved); }
  });
  test("every env a fund stage reads has a source: a fund manifest field, the sheet, the chain or the stage's own path", () => {
    for (const r of buildStages(table, "fund").filter((x) => x.kind === "forge")) {
      for (const e of [...r.requiredEnv, ...r.optionalEnv]) expect([r.name, e, resolveEnv(e, null).from]).not.toEqual([r.name, e, "unmapped"]);
      for (const n of requiredSheetNames(r)) expect(SHEET_SPEC[n], `${r.name} needs ${n}`).toBeDefined();
    }
    expect(resolveEnv("FUND_RECEIPT_ADDRESS", null)).toEqual({ from: "manifest", stage: "fund-receipt", field: "consensus_receipt" });
    expect(resolveEnv("FUND_GOVERNANCE_ADDRESS", null)).toEqual({ from: "manifest", stage: "fund-governance", field: "governance" });
    expect(resolveEnv("QUEUE_ADDRESS", null)).toEqual({ from: "manifest", stage: "queue", field: "queue" });
  });
  test("the fund proxies have verifier names of their own, and the legacy and vaults scopes never see a fund stage", () => {
    expect(proxySpecs(scopeTable(table, "fund")).map((p) => p.name)).toEqual(["fund-receipt", "fund", "rebalancer", "fund-governance", "queue"]);
    expect(Object.keys(FUND_PROXY_NAMES).sort()).toEqual(["fund", "fund-governance", "fund-receipt", "queue", "rebalancer"]);
    for (const sys of ["legacy", "vaults"] as const) expect(scopeTable(table, sys).stages.map((s) => s.name).filter((n) => FUND.includes(n))).toEqual([]);
  });
  test("the table refuses a fund proxy stage after the fund system's own timelock, and an authority stage of another system", () => {
    const raw = JSON.parse(readFileSync(join(ROOT, "scripts", "deploy", "stage-table.json"), "utf8"));
    const moved = JSON.parse(JSON.stringify(raw));
    const i = moved.stages.findIndex((s: any) => s.name === "queue");
    const [q] = moved.stages.splice(i, 1);
    moved.stages.push(q);
    moved.systems.fund.stages = moved.stages.filter((s: any) => s.system === "fund").map((s: any) => s.name);
    expect(() => parseStageTable(moved)).toThrow("stage queue deploys a proxy after the fund-timelock stage");
    const foreign = JSON.parse(JSON.stringify(raw));
    foreign.systems.fund.upgradeAuthorityStage = "timelock";
    expect(() => parseStageTable(foreign)).toThrow("names upgradeAuthorityStage timelock, which is not one of its stages");
  });
});

describe("the fund sheet (Deploy 4)", () => {
  test("deploy-4.env with a keeper filled in parses as a rehearsal fund sheet; the committed file with the blank keeper does not", () => {
    const s = fundSheet();
    expect(s.system).toBe("fund");
    expect(s.kind).toBe("rehearsal");
    expect(s.timelockMinDelay).toBe(900n);
    expect(s.seedDeposit).toBe(1_000_000n);
    expect(s.fund!.tvlCap).toBeLessThanOrEqual(1_000_000_000n);
    expect(s.fund!.params.FLOW_MIN_REQUEST_USDC).toBe(1_000_000n);
    expect(s.fund!.params.FLOW_REF_BAND_BPS).toBe(90n);
    expect(() => fundSheet(SHEET.replace(/^KEEPER_ADDRESS=.*$/m, "KEEPER_ADDRESS="))).toThrow("missing required names: KEEPER_ADDRESS");
  });
  test("a vaults sheet refuses every fund name, and a fund sheet refuses vaults and gateway names", () => {
    for (const n of FUND_ONLY_NAMES) expect(() => parseSheet(`${n}=1\n`)).toThrow(`${n} is refused in a vaults sheet`);
    for (const n of ["VAULT_USDC_TVL_CAP", "ROUTER_WEIGHTS", "GATEWAY_ADMIN_ADDRESS", "SHARE_RECEIVER_ADDRESS"]) expect(() => fundSheet(withLine(n, "1"))).toThrow(`${n} is refused in a fund sheet`);
    expect(() => fundSheet(withLine("FUND_ADDRESS", "0x1111111111111111111111111111111111111112"))).toThrow("produced by a stage");
  });
  test("each fund rule refuses: keys, caps, seed, guards, bounds and the levers no stage sets", () => {
    const cases: [string, string, string][] = [
      ["KEEPER_ADDRESS", "0xf3F582464De7BD2cBf9d2ad40429e31D0F4724A3", "are the same address"],
      ["RECEIPT_ADMIN_ADDRESS", "0x2c76f2f8753880AA88910A97f97Ae9B15b465Dab", "must equal ADMIN_ADDRESS"],
      ["FUND_PER_DEPOSIT_CAP", "2000000000", "FUND_PER_DEPOSIT_CAP exceeds FUND_TVL_CAP"],
      ["FUND_TVL_CAP", "0", "FUND_TVL_CAP must be above 0"],
      ["SEED_DEPOSIT_USDC", "500000", "is below FUND_MIN_SEED_USDC"],
      ["FUND_MIN_SEED_USDC", "999999", "below the fund's own floor of 1 USDC"],
      ["FUND_MAX_SLIPPAGE_BPS", "5", "must be above the 5 bps pool fee"],
      ["FUND_NAV_DEVIATION_BPS", "2001", "must be above the 5 bps pool fee and at most 2000"],
      ["FUND_EXIT_FEE_BPS", "101", "above the fund's ceiling"],
      ["FLOW_MIN_HOLD", "3600", "FLOW_MIN_HOLD 3600 is outside the contract's bounds"],
      ["FLOW_REF_BAND_BPS", "2001", "FLOW_REF_BAND_BPS 2001 is outside"],
      ["FLOW_SETTLE_WINDOW", "21600", "FLOW_SETTLE_WINDOW must be shorter than FLOW_EPOCH_LENGTH"],
      ["FLOW_QUORUM", "13", "FLOW_QUORUM exceeds FLOW_SLICES"],
      ["REBALANCER_MIN_STEP_USDC", "600000000000", "REBALANCER_MIN_STEP_USDC exceeds a per-asset max step"],
      ["FLOW_BASKET_CALL_BPS", "6", "no stage sets it"],
      ["REBALANCER_STEP_DEPTH_BPS", "4", "no stage sets it"],
      ["TIMELOCK_MIN_DELAY", "600", "TIMELOCK_MIN_DELAY"],
      ["SAFE_THRESHOLD", "3", "SAFE_THRESHOLD 3 must be from 2 to 2"],
      ["FEE_RECIPIENT_ADDRESS", "0xf3F582464De7BD2cBf9d2ad40429e31D0F4724A3", "the fee recipient is never the deployer"],
    ];
    for (const [n, v, msg] of cases) expect(() => fundSheet(withLine(n, v)), `${n}=${v}`).toThrow(msg);
    expect(() => fundSheet(withLine("SAFE_SALT_NONCE", null))).toThrow("needs an explicit SAFE_SALT_NONCE");
  });
});

describe("the fund system's CLI verbs (Deploy 4)", () => {
  const base = ["--chain", "8453", "--rpc", "http://127.0.0.1:8545", "--sheet", "s.env", "--signer", "address:0x1111111111111111111111111111111111111111", "--core-sha", "a".repeat(40), "--system", "fund"];
  test("publish, verify and record-receipt parse; govern, pause-all, the vault verbs and a govern stage are refused", () => {
    expect(parseCli(["publish", ...base]).system).toBe("fund");
    expect(parseCli(["verify", ...base]).system).toBe("fund");
    const rec = ["--receipt-id", `0x${"11".repeat(32)}`, "--payload-digest", `0x${"22".repeat(32)}`, "--payload-uri", "https://x.invalid/r", "--payload", "p.json", "--submitter", "0x2222222222222222222222222222222222222222"];
    expect(parseCli(["record-receipt", ...base, ...rec])).toMatchObject({ verb: "record-receipt", system: "fund" });
    for (const v of ["govern", "pause-all", "redeploy-vault", "deploy-implementation"]) expect(() => parseCli([v, ...base])).toThrow("the fund system runs publish, verify and record-receipt only");
    expect(() => parseCli([...base, "--stage", "govern"])).toThrow("the fund system has no govern stage");
  });
});
