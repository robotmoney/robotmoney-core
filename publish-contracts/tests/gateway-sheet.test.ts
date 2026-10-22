// Issue 1892: the gateway system's sheet is small and explicit. The committed examples parse; the governance inputs have no default; every AGENT_ name, Safe input and treasury
// name is refused; a vaults sheet refuses the gateway names. The sheet never supplies the vaults timelock.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_ONLY_NAMES, GATEWAY_SHEET_NAMES, parseSheet } from "../src/sheet.ts";
import { PublishError } from "../src/errors.ts";
import { REPO, gatewaySheetText, sheetText } from "./fixtures.ts";

const parse = (text: string) => parseSheet(text, { system: "gateway" });
const refusal = (text: string): string => { try { parse(text); } catch (e) { return (e as PublishError).message; } return ""; };

describe("the gateway sheet (issue 1892)", () => {
  test("the committed Twin and rehearsal examples parse as gateway sheets", () => {
    for (const f of ["deployments/twin-918453/gateway-sheet.example.env", "deployments/base-8453-rehearsal/gateway-sheet.example.env"]) {
      const s = parse(readFileSync(join(REPO, f), "utf8"));
      expect(s.system, f).toBe("gateway");
      expect(s.gateway?.admin, f).toBeTruthy();
      expect(s.gateway?.upgradeTimelock, f).toBeTruthy();
    }
  });
  test("it carries the two governance inputs and the deploy roles, nothing of the treasury", () => {
    const s = parse(gatewaySheetText(918453));
    expect([s.gateway?.admin.toLowerCase(), s.gateway?.upgradeTimelock.toLowerCase()]).toEqual(["0x000000000000000000000000000000000000a0c1", "0x000000000000000000000000000000000000a0c2"]);
    expect(s.upgrade).toEqual({ mode: "frozen" });
    expect(s.safeOwners).toEqual([]);
    expect(Object.keys(s.vaults)).toEqual([]);
    expect([...GATEWAY_ONLY_NAMES]).toEqual(["GATEWAY_ADMIN_ADDRESS", "GATEWAY_UPGRADE_TIMELOCK"]);
    expect(GATEWAY_SHEET_NAMES).not.toContain("TIMELOCK_MIN_DELAY");
    expect(GATEWAY_SHEET_NAMES).not.toContain("SAFE_OWNERS");
  });
  test("the governance inputs have no default: missing, empty and zero are each refused", () => {
    for (const n of GATEWAY_ONLY_NAMES) {
      expect(refusal(gatewaySheetText(918453, { [n]: null })), `${n} missing`).toContain(`missing required names: ${n}`);
      expect(refusal(gatewaySheetText(918453, { [n]: "" })), `${n} empty`).toContain(n);
      expect(refusal(gatewaySheetText(918453, { [n]: "0x0000000000000000000000000000000000000000" })), `${n} zero`).toContain("zero address");
    }
  });
  test("UPGRADE_MODE has no default and the admin is neither the deployer nor the pauser", () => {
    expect(refusal(gatewaySheetText(918453, { UPGRADE_MODE: null }))).toContain("UPGRADE_MODE");
    expect(refusal(gatewaySheetText(918453, { UPGRADE_MODE: "whenever" }))).toContain("UPGRADE_MODE must be");
    expect(refusal(gatewaySheetText(918453, { GATEWAY_ADMIN_ADDRESS: "0x000000000000000000000000000000000000a001" }))).toContain("equals ADMIN_ADDRESS");
    expect(refusal(gatewaySheetText(918453, { GATEWAY_ADMIN_ADDRESS: "0x000000000000000000000000000000000000a002" }))).toContain("equals PAUSER_ADDRESS");
    expect(refusal(gatewaySheetText(918453, { PAUSER_ADDRESS: "0x000000000000000000000000000000000000a001" }))).toContain("same address");
  });
  test("every AGENT_ name, Safe input and treasury name is refused with its reason", () => {
    for (const n of ["AGENT_ADDRESSES", "AGENT_ADDRESS", "AGENT_VALID_UNTIL", "AGENT_MAX_PER_PAYMENT"]) expect(refusal(gatewaySheetText(918453, { [n]: "1" })), n).toContain(`${n} is refused`);
    for (const n of ["AGENT_ADDRESS", "AGENT_VALID_UNTIL", "AGENT_MAX_PER_PAYMENT"]) expect(refusal(gatewaySheetText(918453, { [n]: "1" })), n).toContain("the deploy authorizes no agent");
    for (const n of ["SAFE_OWNERS", "SAFE_THRESHOLD", "TIMELOCK_MIN_DELAY", "EMERGENCY_ADDRESS", "SEED_DEPOSIT_USDC", "VAULT_USDC_TVL_CAP", "GOVERN_UNPAUSE_VAULTS", "ELIGIBLE_VAULTS"]) {
      expect(refusal(gatewaySheetText(918453, { [n]: "1" })), n).toContain("is refused in a gateway sheet");
    }
    for (const n of ["GATEWAY_ADDRESS", "VAULT_ADDRESS", "SAFE_ADDRESS", "TIMELOCK_ADDRESS"]) expect(refusal(gatewaySheetText(918453, { [n]: "0x000000000000000000000000000000000000a0aa" })), n).toContain("produced by a stage");
    expect(refusal(gatewaySheetText(918453, { NOT_A_NAME: "1" }))).toContain("is not a sheet name");
  });
  test("a vaults sheet refuses both gateway names, so the vaults system has no gateway input", () => {
    for (const n of GATEWAY_ONLY_NAMES) expect(() => parseSheet(sheetText({}, [`${n}=0x000000000000000000000000000000000000a0c1`]))).toThrow(`${n} is refused in a vaults sheet`);
    expect(() => parseSheet(sheetText())).not.toThrow();
  });
  test("a chain id disagreement and a bad kind are refused", () => {
    expect(refusal(gatewaySheetText(918453, { EXPECTED_CHAIN_ID: "8453" }))).toContain("differs from CHAIN_ID");
    expect(refusal(gatewaySheetText(918453, { DEPLOYMENT_KIND: "staging" }))).toContain("DEPLOYMENT_KIND");
  });
});
