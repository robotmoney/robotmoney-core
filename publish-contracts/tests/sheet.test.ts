import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { PublishError } from "../src/errors.ts";
import { REQUIRED_NAMES, VAULT_KEYS, callerInputs, diffSheets, parseSheet, parseSheetText, vaultSheetNames } from "../src/sheet.ts";
import { exampleText, sheetText } from "./fixtures.ts";

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
