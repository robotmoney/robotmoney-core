import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PublishError } from "../src/errors.ts";
import { REQUIRED_NAMES, VAULT_KEYS, callerInputs, diffSheets, eligibilityBps, eligibleInOrder, parseSheet, parseSheetText, vaultSheetNames } from "../src/sheet.ts";
import { REPO, exampleText, sheetText } from "./fixtures.ts";

const refused = (text: string): PublishError => {
  try { parseSheet(text); } catch (e) { expect(e).toBeInstanceOf(PublishError); expect((e as PublishError).kind).toBe("SHEET"); return e as PublishError; }
  throw new Error("expected the sheet to be refused");
};

describe("whitelist parser", () => {
  test("the committed sheet example passes the real parser", () => {
    const s = parseSheet(exampleText());
    expect(s.chainId).toBe(918453);
    expect(s.safeOwners.length).toBe(3);
    expect(Object.keys(s.vaults).sort()).toEqual([...VAULT_KEYS].sort());
    expect(s.feeRecipient).toBe("@safe");
  });

  test("RECEIPT_ADMIN_ADDRESS must equal ADMIN_ADDRESS: the deployer revokes the receipt roles in the timelock stage", () => {
    const other = "0x000000000000000000000000000000000000a0ff";
    expect(refused(sheetText({ RECEIPT_ADMIN_ADDRESS: other })).message).toContain("RECEIPT_ADMIN_ADDRESS");
    const ok = parseSheet(exampleText());
    expect(ok.receiptAdmin.toLowerCase()).toBe(ok.admin.toLowerCase());
  });

  test("a sheet that carries an agent key is refused with a named error: the deploy authorizes no agent (core 1527)", () => {
    for (const name of ["AGENT_ADDRESS", "AGENT_VALID_UNTIL", "AGENT_MAX_PER_PAYMENT", "AGENT_MAX_PER_WINDOW", "AGENT_MAX_WITHDRAW_PER_PAYMENT", "AGENT_MAX_WITHDRAW_PER_WINDOW", "GOVERN_AGENT_ADDRESSES"]) {
      const e = refused(sheetText({}, [`${name}=1`]));
      expect(e.message, name).toContain(`${name} is refused`);
      expect((e.details as { name?: string }).name).toBe(name);
    }
    for (const name of ["AGENT_ADDRESS", "AGENT_VALID_UNTIL", "AGENT_MAX_PER_PAYMENT", "AGENT_MAX_PER_WINDOW", "AGENT_MAX_WITHDRAW_PER_PAYMENT", "AGENT_MAX_WITHDRAW_PER_WINDOW", "GOVERN_AGENT_ADDRESSES"]) {
      expect(REQUIRED_NAMES).not.toContain(name);
    }
    expect(refused(sheetText({}, ["AGENT_ADDRESS=0x000000000000000000000000000000000000a004"])).message).toContain("commitAuthorization");
  });

  test("the Twin stage sheet parses and carries no agent key", () => {
    const text = readFileSync(join(REPO, "deployments", "twin-918453", "stage-sheet.env"), "utf8");
    expect(text).not.toMatch(/AGENT_ADDRESS=|AGENT_VALID_UNTIL|AGENT_MAX_|GOVERN_AGENT_ADDRESSES/);
    expect(parseSheet(text).chainId).toBe(918453);
  });

  test("REHEARSAL=1 is refused", () => {
    expect(refused(sheetText({}, ["REHEARSAL=1"])).message).toContain("REHEARSAL");
    expect(refused(sheetText({}, ["export REHEARSAL=1"])).message).toContain("deleted");
  });

  test("ALLOW_SHORT_TIMELOCK_DELAY, SKIP_ROUTER_ADMIN_GRANT and CONFIG_PATH are refused", () => {
    for (const n of ["ALLOW_SHORT_TIMELOCK_DELAY=true", "SKIP_ROUTER_ADMIN_GRANT=true", "CONFIG_PATH=x", "MOCK_ALL=1"]) expect(refused(sheetText({}, [n])).message).toContain("deleted");
  });

  test("YES and CONFIRM in a sheet are refused", () => {
    expect(refused(sheetText({}, ["YES=1"])).message).toContain("caller environment");
    expect(refused(sheetText({}, ["export CONFIRM=environment"])).message).toContain("caller environment");
  });

  test("YES and CONFIRM come from the caller environment only", () => {
    expect(callerInputs({ YES: "1", CONFIRM: "environment" })).toEqual({ yes: true, confirm: "environment" });
    expect(callerInputs({})).toEqual({ yes: false, confirm: "typed" });
    expect(() => callerInputs({ CONFIRM: "always" })).toThrow(PublishError);
  });

  test("a sheet is parsed as data and never sourced", () => {
    const marker = "/tmp/pc-sheet-sourced-marker";
    rmSync(marker, { force: true });
    for (const bad of [`ADMIN_ADDRESS=$(touch ${marker})`, `X=\`touch ${marker}\``, `touch ${marker}`, `A=1; touch ${marker}`, `export A=\${HOME}`]) {
      expect(() => parseSheetText(bad)).toThrow(PublishError);
    }
    expect(existsSync(marker)).toBe(false);
  });

  test("an unknown name is refused (whitelist)", () => {
    expect(refused(sheetText({}, ["MY_NEW_NAME=1"])).message).toContain("not a sheet name");
  });

  test("secret-shaped names are refused", () => {
    for (const n of ["PRIVATE_KEY", "MNEMONIC", "ETH_PASSWORD", "KEYSTORE_PASSPHRASE", "DEPLOYER_PRIVATE_KEY"]) expect(refused(sheetText({}, [`${n}=x`])).message).toContain("secret");
  });

  test("values that stages produce are refused: nothing is typed or silently skipped", () => {
    for (const n of ["REGISTRY_ADDRESS", "IC_POLICY_ADDRESS", "CONSENSUS_RECEIPT_ADDRESS", "DEPLOYMENT_OUT", "SAFE_ADDRESS", "VAULT_ADDRESSES"]) {
      expect(refused(sheetText({}, [`${n}=0x000000000000000000000000000000000000dEaD`])).message).toContain("manifests");
    }
  });

  test("the unprefixed per-vault names are refused: names carry a vault key", () => {
    expect(refused(sheetText({}, ["VAULT_TVL_CAP=1"])).message).toContain("vault key");
  });

  test("every required name is required: removing one fails", () => {
    for (const n of REQUIRED_NAMES) {
      const e = refused(sheetText({ [n]: null }));
      expect(e.message).toContain(n);
    }
  });

  test("the four vaults have per-vault names that resolve", () => {
    const s = parseSheet(exampleText());
    for (const k of VAULT_KEYS) {
      for (const n of vaultSheetNames(k)) expect(n).toMatch(new RegExp(`^VAULT_${k}_`));
      expect(s.vaults[k].tvlCap).toBeGreaterThan(0n);
    }
  });

  test("duplicate names, bad addresses, bad numbers and bad quoting are refused", () => {
    expect(() => parseSheetText("A=1\nA=2")).toThrow(PublishError);
    expect(refused(sheetText({ ADMIN_ADDRESS: "0x123" })).message).toContain("ADMIN_ADDRESS");
    expect(refused(sheetText({ VOTER_POWER: "ten" })).message).toContain("VOTER_POWER");
    expect(() => parseSheetText('A="unterminated')).toThrow(PublishError);
  });

  test("structure floors hold on every chain", () => {
    expect(refused(sheetText({ SAFE_THRESHOLD: "3" })).message).toContain("SAFE_THRESHOLD");
    expect(refused(sheetText({ SAFE_THRESHOLD: "1" })).message).toContain("SAFE_THRESHOLD");
    expect(refused(sheetText({ SAFE_OWNERS: "0x000000000000000000000000000000000000c001,0x000000000000000000000000000000000000c002" })).message).toContain("3 owners");
    expect(refused(sheetText({ SAFE_OWNERS: "0x000000000000000000000000000000000000a001,0x000000000000000000000000000000000000c002,0x000000000000000000000000000000000000c003" })).message).toContain("Safe owner");
    expect(refused(sheetText({ PAUSER_ADDRESS: "0x000000000000000000000000000000000000a001" })).message).toContain("same address");
    expect(refused(sheetText({ QUORUM_THRESHOLD: "1" })).message).toContain("QUORUM");
    expect(refused(sheetText({ FEE_RECIPIENT_ADDRESS: "0x000000000000000000000000000000000000a001" })).message).toContain("deployer");
    expect(refused(sheetText({ SEED_DEPOSIT_USDC: "0" })).message).toContain("SEED");
    expect(refused(sheetText({ SAFE_VERSION: "1.3.0" })).message).toContain("1.4.1");
    expect(refused(sheetText({ EXPECTED_CHAIN_ID: "8453" })).message).toContain("EXPECTED_CHAIN_ID");
    expect(refused(sheetText({ ROUTER_WEIGHTS: "USDC:5000,PROTO:2500,RWA:1500" })).message).toContain("10000");
    expect(refused(sheetText({ ROUTER_WEIGHTS: "USDC:6000,PROTO:4000" })).message).toContain("exactly");
  });

  test("sheet diff lists only the names that differ", () => {
    const a = parseSheet(exampleText());
    const b = parseSheet(sheetText({ TIMELOCK_MIN_DELAY: "172800" }));
    expect(diffSheets(a, b).map((r) => r.name)).toEqual(["TIMELOCK_MIN_DELAY"]);
  });
});

describe("govern carries the basket unpauses only; the rest is deploy-time configuration (issue 1520)", () => {
  const why = "govern (stage 13) carries the basket unpauses only";
  test("a sheet that routes voting power, quorum, agents, caps, fee, fee recipient, eligibility or router weights through govern is refused", () => {
    for (const name of [
      "GOVERN_VOTER_POWER", "GOVERN_VOTING_POWER", "GOVERN_QUORUM_THRESHOLD", "GOVERN_QUORUM", "GOVERN_VOTING_PERIOD", "GOVERN_EXECUTION_DELAY", "GOVERN_AGENT_ADDRESSES", "GOVERN_AGENTS",
      "GOVERN_TVL_CAP", "GOVERN_PER_DEPOSIT_CAP", "GOVERN_CAPS", "GOVERN_EXIT_FEE_BPS", "GOVERN_FEE_RECIPIENT", "GOVERN_ELIGIBLE_VAULTS", "GOVERN_ROUTER_WEIGHTS", "GOVERN_MIGRATE_ELIGIBILITY",
    ]) expect(refused(sheetText({}, [`${name}=1`])).message, name).toContain(why);
    // the two names govern keeps still parse
    const ok = parseSheet(sheetText({ GOVERN_UNPAUSE_VAULTS: "PROTO", GOVERN_NEW_DELAY: "3600" }));
    expect(ok.govern.unpauseVaults).toEqual(["PROTO"]);
  });
  test("on 8453 a GOVERN_UNPAUSE_VAULTS that lacks PROTO, AGENT or RWA is refused with a named error; Twin allows it", () => {
    const main = (list: string) => sheetText({ CHAIN_ID: "8453", EXPECTED_CHAIN_ID: "8453", TIMELOCK_MIN_DELAY: "172800", ELIGIBLE_VAULTS: "PROTO,AGENT,RWA", ROUTER_WEIGHTS: "USDC:9500,PROTO:500,AGENT:0,RWA:0", GOVERN_UNPAUSE_VAULTS: list });
    for (const list of ["PROTO,RWA", "AGENT,RWA", "PROTO,AGENT", "PROTO", "none"]) {
      const e = refused(main(list));
      expect(e.message, list).toContain("no stage 13 step may be skipped");
      expect(e.message).toContain("GOVERN_UNPAUSE_VAULTS");
    }
    expect(parseSheet(main("PROTO,AGENT,RWA")).govern.unpauseVaults).toEqual(["PROTO", "AGENT", "RWA"]);
    expect(parseSheet(main("RWA,AGENT,PROTO")).govern.unpauseVaults).toEqual(["RWA", "AGENT", "PROTO"]);
    expect(parseSheet(sheetText({ GOVERN_UNPAUSE_VAULTS: "PROTO,RWA" })).govern.unpauseVaults).toEqual(["PROTO", "RWA"]);
  });
  test("on 8453 ROUTER_WEIGHTS must be the launch vector, with a named error; Twin keeps its own weights", () => {
    const main = (w: string) => sheetText({ CHAIN_ID: "8453", EXPECTED_CHAIN_ID: "8453", TIMELOCK_MIN_DELAY: "172800", ELIGIBLE_VAULTS: "PROTO,AGENT,RWA", GOVERN_UNPAUSE_VAULTS: "PROTO,AGENT,RWA", ROUTER_WEIGHTS: w });
    const ok = parseSheet(main("USDC:9500,PROTO:500,AGENT:0,RWA:0"));
    expect(ok.weights.map((x) => x.bps)).toEqual([9500, 500, 0, 0]);
    expect(parseSheet(main("RWA:0,AGENT:0,PROTO:500,USDC:9500")).weights.length).toBe(4);
    for (const w of ["USDC:8500,PROTO:500,AGENT:500,RWA:500", "USDC:9000,PROTO:1000,AGENT:0,RWA:0", "USDC:9500,PROTO:0,AGENT:500,RWA:0"]) {
      const e = refused(main(w));
      expect(e.message, w).toContain("launch vector");
      expect(e.message).toContain("ROUTER_WEIGHTS");
    }
    expect(parseSheet(sheetText({ ELIGIBLE_VAULTS: "PROTO,RWA", ROUTER_WEIGHTS: "USDC:6000,PROTO:2500,RWA:1500" })).weights.length).toBe(3);
  });
  test("the govern block holds the unpauses and the Twin-only delay and nothing else; eligibility and weights are deploy-time fields", () => {
    const s = parseSheet(exampleText());
    expect(Object.keys(s.govern).sort()).toEqual(["newDelay", "unpauseVaults"]);
    expect(s.eligibleVaults).toEqual(["PROTO", "RWA"]);
    expect(s.weights).toEqual([{ key: "USDC", bps: 6000 }, { key: "PROTO", bps: 2500 }, { key: "RWA", bps: 1500 }]);
    expect(s.values.GOVERN_ELIGIBLE_VAULTS).toBeUndefined();
  });
  test("ELIGIBLE_VAULTS is required, lists baskets only, and has no repeat", () => {
    expect(refused(sheetText({ ELIGIBLE_VAULTS: null })).message).toContain("ELIGIBLE_VAULTS");
    expect(refused(sheetText({ ELIGIBLE_VAULTS: "USDC,PROTO" })).message).toContain("baskets only");
    expect(refused(sheetText({ ELIGIBLE_VAULTS: "PROTO,PROTO" })).message).toContain("twice");
    expect(REQUIRED_NAMES).toContain("ELIGIBLE_VAULTS");
    expect(REQUIRED_NAMES).not.toContain("GOVERN_ELIGIBLE_VAULTS");
  });
  test("the launch weights (rmUSDC 9500, rmPROTO 500, rmAGENT 0, rmRWA 0 bps) are a valid sheet", () => {
    const s = parseSheet(sheetText({ ELIGIBLE_VAULTS: "PROTO,AGENT,RWA", ROUTER_WEIGHTS: "USDC:9500,PROTO:500,AGENT:0,RWA:0" }));
    expect(s.weights.map((w) => w.bps)).toEqual([9500, 500, 0, 0]);
  });
  test("eligibilityBps: the last eligible basket leaves exactly the sheet weights, earlier flips are scaled to 10000, an ineligible basket has none", () => {
    const s = parseSheet(exampleText());
    expect(eligibleInOrder(s)).toEqual(["PROTO", "RWA"]);
    expect(eligibilityBps(s, "PROTO")).toEqual([7059, 2941]);
    expect(eligibilityBps(s, "RWA")).toEqual([6000, 2500, 1500]);
    expect(eligibilityBps(s, "AGENT")).toBeUndefined();
    const launch = parseSheet(sheetText({ ELIGIBLE_VAULTS: "PROTO,AGENT,RWA", ROUTER_WEIGHTS: "USDC:9500,PROTO:500,AGENT:0,RWA:0" }));
    expect(eligibilityBps(launch, "PROTO")).toEqual([9500, 500]);
    expect(eligibilityBps(launch, "AGENT")).toEqual([9500, 500, 0]);
    expect(eligibilityBps(launch, "RWA")).toEqual([9500, 500, 0, 0]);
    for (const k of ["PROTO", "AGENT", "RWA"] as const) expect(eligibilityBps(launch, k)!.reduce((a, b) => a + b, 0)).toBe(10000);
    // all-zero weights before the last flip fall back to an equal split that still sums to 10000
    const zero = parseSheet(sheetText({ ELIGIBLE_VAULTS: "PROTO,RWA", ROUTER_WEIGHTS: "USDC:10000,PROTO:0,RWA:0" }));
    expect(eligibilityBps(zero, "PROTO")).toEqual([10000, 0]);
  });
});
