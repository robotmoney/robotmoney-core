import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PublishError } from "../src/errors.ts";
import { REQUIRED_NAMES, VAULT_KEYS, callerInputs, diffSheets, eligibilityBps, eligibleInOrder, parseSheet, parseSheetText, vaultSheetNames } from "../src/sheet.ts";
import { STAGE13_UNPAUSE_VAULTS } from "../src/vault-rules.ts";
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

  test("the Twin stage sheet carries the 8453 launch router values: governance isomorphism section 1.1 lets only chain, keys, custody and delay differ (core 1708)", () => {
    const s = parseSheet(readFileSync(join(REPO, "deployments", "twin-918453", "stage-sheet.env"), "utf8"));
    expect(s.eligibleVaults).toEqual(["PROTO", "RWA"]);
    expect(s.weights).toEqual([{ key: "USDC", bps: 9500 }, { key: "PROTO", bps: 500 }, { key: "RWA", bps: 0 }]);
    expect(eligibilityBps(s, "RWA")).toEqual([9500, 500, 0]);
  });

  // Issue 1705 rule b (Q4 (a)): eligibility, the router vector and the unpause set are not among the differences governance isomorphism section 1.1
  // allows between a rehearsal and production (chain, keys, custody, delay). The stage table records no exception for them, so the two sheets agree,
  // and the unpause set is the table's stage 13 set.
  test("rule b twin sheet: the Twin sheet and the 8453 example sheet carry equal ELIGIBLE_VAULTS, ROUTER_WEIGHTS and GOVERN_UNPAUSE_VAULTS (issue 1705)", () => {
    const twin = parseSheet(readFileSync(join(REPO, "deployments", "twin-918453", "stage-sheet.env"), "utf8"));
    const base = parseSheet(readFileSync(join(REPO, "deployments", "base-8453-rehearsal", "stage-sheet.example.env"), "utf8"));
    expect([twin.chainId, base.chainId]).toEqual([918453, 8453]);
    expect(twin.eligibleVaults).toEqual(base.eligibleVaults);
    expect(twin.weights).toEqual(base.weights);
    expect(twin.govern.unpauseVaults).toEqual(base.govern.unpauseVaults);
    expect(twin.govern.unpauseVaults).toEqual([...STAGE13_UNPAUSE_VAULTS]);
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
    for (const n of ["REGISTRY_ADDRESS", "CONSENSUS_RECEIPT_ADDRESS", "DEPLOYMENT_OUT", "SAFE_ADDRESS", "VAULT_ADDRESSES"]) {
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

  test("the three vaults have per-vault names that resolve", () => {
    const s = parseSheet(exampleText());
    for (const k of VAULT_KEYS) {
      for (const n of vaultSheetNames(k)) expect(n).toMatch(new RegExp(`^VAULT_${k}_`));
      expect(s.vaults[k].tvlCap).toBeGreaterThan(0n);
    }
  });

  test("issue 1666: every basket carries a nonzero NAV deviation guard of at most 2000 bps and a pool liquidity floor above zero", () => {
    const ok = parseSheet(exampleText());
    for (const k of ["PROTO", "RWA"] as const) {
      expect(ok.vaults[k].navDeviationBps!).toBeGreaterThan(0n);
      expect(ok.vaults[k].navDeviationBps!).toBeLessThanOrEqual(2000n);
      expect(ok.vaults[k].minPoolLiquidity!).toBeGreaterThan(0n);
    }
    expect(ok.vaults.USDC.navDeviationBps).toBeUndefined();
    expect(ok.vaults.USDC.minPoolLiquidity).toBeUndefined();
    // missing
    expect(refused(sheetText({ VAULT_PROTO_NAV_DEVIATION_BPS: null })).message).toContain("VAULT_PROTO_NAV_DEVIATION_BPS");
    expect(refused(sheetText({ VAULT_PROTO_MIN_POOL_LIQUIDITY: null })).message).toContain("VAULT_PROTO_MIN_POOL_LIQUIDITY");
    // zero disables ORA-4
    expect(refused(sheetText({ VAULT_PROTO_NAV_DEVIATION_BPS: "0" })).message).toContain("VAULT_PROTO_NAV_DEVIATION_BPS must be above 0");
    // above the vault ceiling, and the edge
    expect(refused(sheetText({ VAULT_RWA_NAV_DEVIATION_BPS: "2001" })).message).toContain("VAULT_RWA_NAV_DEVIATION_BPS is above 2000");
    expect(parseSheet(sheetText({ VAULT_RWA_NAV_DEVIATION_BPS: "2000" })).vaults.RWA.navDeviationBps).toBe(2000n);
    expect(parseSheet(sheetText({ VAULT_RWA_NAV_DEVIATION_BPS: "1" })).vaults.RWA.navDeviationBps).toBe(1n);
    // a basis point value typed as a decimal or a percent sign is not an integer
    expect(refused(sheetText({ VAULT_RWA_NAV_DEVIATION_BPS: "5%" })).message).toContain("VAULT_RWA_NAV_DEVIATION_BPS");
    expect(refused(sheetText({ VAULT_RWA_NAV_DEVIATION_BPS: "1.5" })).message).toContain("VAULT_RWA_NAV_DEVIATION_BPS");
    // floor: zero and above uint128
    expect(refused(sheetText({ VAULT_PROTO_MIN_POOL_LIQUIDITY: "0" })).message).toContain("VAULT_PROTO_MIN_POOL_LIQUIDITY must be above 0");
    expect(refused(sheetText({ VAULT_PROTO_MIN_POOL_LIQUIDITY: (2n ** 128n).toString() })).message).toContain("exceeds uint128");
    expect(parseSheet(sheetText({ VAULT_PROTO_MIN_POOL_LIQUIDITY: (2n ** 128n - 1n).toString() })).vaults.PROTO.minPoolLiquidity).toBe(2n ** 128n - 1n);
  });

  test("issue 1666: rmUSDC has no NAV deviation guard and no pool: the USDC names and the unprefixed names are refused", () => {
    expect(refused(sheetText({}, ["VAULT_USDC_NAV_DEVIATION_BPS=100"])).message).toContain("VAULT_USDC_NAV_DEVIATION_BPS is refused");
    expect(refused(sheetText({}, ["VAULT_USDC_MIN_POOL_LIQUIDITY=1000"])).message).toContain("VAULT_USDC_MIN_POOL_LIQUIDITY is refused");
    expect(refused(sheetText({}, ["VAULT_NAV_DEVIATION_BPS=100"])).message).toContain("refused");
    expect(REQUIRED_NAMES).not.toContain("VAULT_USDC_NAV_DEVIATION_BPS");
    expect(REQUIRED_NAMES).toContain("VAULT_PROTO_NAV_DEVIATION_BPS");
    expect(REQUIRED_NAMES).toContain("VAULT_RWA_MIN_POOL_LIQUIDITY");
  });

  test("duplicate names, bad addresses, bad numbers and bad quoting are refused", () => {
    expect(() => parseSheetText("A=1\nA=2")).toThrow(PublishError);
    expect(refused(sheetText({ ADMIN_ADDRESS: "0x123" })).message).toContain("ADMIN_ADDRESS");
    expect(refused(sheetText({ SAFE_THRESHOLD: "ten" })).message).toContain("SAFE_THRESHOLD");
    expect(() => parseSheetText('A="unterminated')).toThrow(PublishError);
  });

  test("structure floors hold on every chain", () => {
    expect(refused(sheetText({ SAFE_THRESHOLD: "3" })).message).toContain("SAFE_THRESHOLD");
    expect(refused(sheetText({ SAFE_THRESHOLD: "1" })).message).toContain("SAFE_THRESHOLD");
    expect(refused(sheetText({ SAFE_OWNERS: "0x000000000000000000000000000000000000c001,0x000000000000000000000000000000000000c002" })).message).toContain("3 owners");
    expect(refused(sheetText({ SAFE_OWNERS: "0x000000000000000000000000000000000000a001,0x000000000000000000000000000000000000c002,0x000000000000000000000000000000000000c003" })).message).toContain("Safe owner");
    expect(refused(sheetText({ PAUSER_ADDRESS: "0x000000000000000000000000000000000000a001" })).message).toContain("same address");
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

describe("there is no voting: the deleted voting names are refused by name (issue 1698)", () => {
  test("VOTER_ADDRESSES, VOTER_POWER, QUORUM_THRESHOLD, VOTING_PERIOD and EXECUTION_DELAY are refused with the reason, and none is required", () => {
    for (const name of ["VOTER_ADDRESSES", "VOTER_POWER", "QUORUM_THRESHOLD", "VOTING_PERIOD", "EXECUTION_DELAY"]) {
      expect(refused(sheetText({}, [`${name}=2`])).message, name).toContain("there is no voting by anyone");
      expect(REQUIRED_NAMES).not.toContain(name);
    }
  });
});

describe("govern carries the four vault unpauses only; the rest is deploy-time configuration (issue 1520)", () => {
  const why = "govern (stage 13) carries the four vault unpauses only";
  test("a sheet that routes voting power, quorum, agents, caps, fee, fee recipient, eligibility or router weights through govern is refused", () => {
    for (const name of [
      "GOVERN_VOTER_POWER", "GOVERN_VOTING_POWER", "GOVERN_QUORUM_THRESHOLD", "GOVERN_QUORUM", "GOVERN_VOTING_PERIOD", "GOVERN_EXECUTION_DELAY", "GOVERN_AGENT_ADDRESSES", "GOVERN_AGENTS",
      "GOVERN_TVL_CAP", "GOVERN_PER_DEPOSIT_CAP", "GOVERN_CAPS", "GOVERN_EXIT_FEE_BPS", "GOVERN_FEE_RECIPIENT", "GOVERN_ELIGIBLE_VAULTS", "GOVERN_ROUTER_WEIGHTS", "GOVERN_MIGRATE_ELIGIBILITY",
    ]) expect(refused(sheetText({}, [`${name}=1`])).message, name).toContain(why);
    // the two names govern keeps still parse
    const ok = parseSheet(sheetText({ GOVERN_UNPAUSE_VAULTS: "PROTO", GOVERN_NEW_DELAY: "3600" }));
    expect(ok.govern.unpauseVaults).toEqual(["PROTO"]);
  });
  test("on 8453 a GOVERN_UNPAUSE_VAULTS that lacks USDC, PROTO or RWA is refused with a named error; Twin allows it", () => {
    const main = (list: string) => sheetText({ CHAIN_ID: "8453", EXPECTED_CHAIN_ID: "8453", TIMELOCK_MIN_DELAY: "172800", ELIGIBLE_VAULTS: "PROTO,RWA", ROUTER_WEIGHTS: "USDC:9500,PROTO:500,RWA:0", GOVERN_UNPAUSE_VAULTS: list });
    for (const list of ["PROTO,RWA", "USDC,RWA", "USDC,PROTO", "USDC", "none"]) {
      const e = refused(main(list));
      expect(e.message, list).toContain("no stage 13 step may be skipped");
      expect(e.message).toContain("GOVERN_UNPAUSE_VAULTS");
    }
    expect(parseSheet(main("USDC,PROTO,RWA")).govern.unpauseVaults).toEqual(["USDC", "PROTO", "RWA"]);
    expect(parseSheet(main("RWA,PROTO,USDC")).govern.unpauseVaults).toEqual(["RWA", "PROTO", "USDC"]);
    expect(parseSheet(sheetText({ GOVERN_UNPAUSE_VAULTS: "PROTO,RWA" })).govern.unpauseVaults).toEqual(["PROTO", "RWA"]);
  });
  test("on 8453 ROUTER_WEIGHTS must be the launch vector, with a named error; Twin keeps its own weights", () => {
    const main = (w: string) => sheetText({ CHAIN_ID: "8453", EXPECTED_CHAIN_ID: "8453", TIMELOCK_MIN_DELAY: "172800", ELIGIBLE_VAULTS: "PROTO,RWA", GOVERN_UNPAUSE_VAULTS: "USDC,PROTO,RWA", ROUTER_WEIGHTS: w });
    const ok = parseSheet(main("USDC:9500,PROTO:500,RWA:0"));
    expect(ok.weights.map((x) => x.bps)).toEqual([9500, 500, 0]);
    expect(parseSheet(main("RWA:0,PROTO:500,USDC:9500")).weights.length).toBe(3);
    for (const w of ["USDC:8500,PROTO:500,RWA:1000", "USDC:9000,PROTO:1000,RWA:0", "USDC:9500,PROTO:0,RWA:500"]) {
      const e = refused(main(w));
      expect(e.message, w).toContain("launch vector");
      expect(e.message).toContain("ROUTER_WEIGHTS");
    }
    // a vault left out of the vector is refused too (the vector must name all three)
    const short = refused(sheetText({ CHAIN_ID: "8453", EXPECTED_CHAIN_ID: "8453", TIMELOCK_MIN_DELAY: "172800", ELIGIBLE_VAULTS: "PROTO", GOVERN_UNPAUSE_VAULTS: "USDC,PROTO,RWA", ROUTER_WEIGHTS: "USDC:9500,PROTO:500" }));
    expect(short.message).toContain("launch vector");
    expect(parseSheet(sheetText({ ELIGIBLE_VAULTS: "PROTO,RWA", ROUTER_WEIGHTS: "USDC:6000,PROTO:2500,RWA:1500" })).weights.length).toBe(3);
  });
  test("the govern block holds the unpauses and the Twin-only delay and nothing else; eligibility and weights are deploy-time fields", () => {
    const s = parseSheet(exampleText());
    expect(Object.keys(s.govern).sort()).toEqual(["newDelay", "unpauseVaults"]);
    expect(s.eligibleVaults).toEqual(["PROTO", "RWA"]);
    expect(s.weights).toEqual([{ key: "USDC", bps: 9500 }, { key: "PROTO", bps: 500 }, { key: "RWA", bps: 0 }]);
    expect(s.values.GOVERN_ELIGIBLE_VAULTS).toBeUndefined();
  });
  test("ELIGIBLE_VAULTS is required, lists baskets only, and has no repeat", () => {
    expect(refused(sheetText({ ELIGIBLE_VAULTS: null })).message).toContain("ELIGIBLE_VAULTS");
    expect(refused(sheetText({ ELIGIBLE_VAULTS: "USDC,PROTO" })).message).toContain("baskets only");
    expect(refused(sheetText({ ELIGIBLE_VAULTS: "PROTO,PROTO" })).message).toContain("twice");
    expect(REQUIRED_NAMES).toContain("ELIGIBLE_VAULTS");
    expect(REQUIRED_NAMES).not.toContain("GOVERN_ELIGIBLE_VAULTS");
  });
  test("the launch weights (rmUSDC 9500, rmPROTO 500, rmRWA 0 bps) are a valid sheet", () => {
    const s = parseSheet(sheetText({ ELIGIBLE_VAULTS: "PROTO,RWA", ROUTER_WEIGHTS: "USDC:9500,PROTO:500,RWA:0" }));
    expect(s.weights.map((w) => w.bps)).toEqual([9500, 500, 0]);
  });
  test("eligibilityBps: the last eligible basket leaves exactly the sheet weights, earlier flips are scaled to 10000, an ineligible basket has none", () => {
    const s = parseSheet(exampleText());
    expect(eligibleInOrder(s)).toEqual(["PROTO", "RWA"]);
    expect(eligibilityBps(s, "PROTO")).toEqual([9500, 500]);
    expect(eligibilityBps(s, "RWA")).toEqual([9500, 500, 0]);
    const both = parseSheet(sheetText({ ELIGIBLE_VAULTS: "PROTO,RWA", ROUTER_WEIGHTS: "USDC:6000,PROTO:2500,RWA:1500" }));
    expect(eligibilityBps(both, "PROTO")).toEqual([7059, 2941]);
    expect(eligibilityBps(both, "RWA")).toEqual([6000, 2500, 1500]);
    const protoOnly = parseSheet(sheetText({ ELIGIBLE_VAULTS: "PROTO", ROUTER_WEIGHTS: "USDC:9500,PROTO:500" }));
    expect(eligibilityBps(protoOnly, "RWA")).toBeUndefined();
    const launch = parseSheet(sheetText({ ELIGIBLE_VAULTS: "PROTO,RWA", ROUTER_WEIGHTS: "USDC:9500,PROTO:500,RWA:0" }));
    expect(eligibilityBps(launch, "PROTO")).toEqual([9500, 500]);
    expect(eligibilityBps(launch, "RWA")).toEqual([9500, 500, 0]);
    for (const k of ["PROTO", "RWA"] as const) expect(eligibilityBps(launch, k)!.reduce((a, b) => a + b, 0)).toBe(10000);
    // all-zero weights before the last flip fall back to an equal split that still sums to 10000
    const zero = parseSheet(sheetText({ ELIGIBLE_VAULTS: "PROTO,RWA", ROUTER_WEIGHTS: "USDC:10000,PROTO:0,RWA:0" }));
    expect(eligibilityBps(zero, "PROTO")).toEqual([10000, 0]);
  });
});

// Issue 1705 Q4 (a), docs/technical/governance-isomorphism.md §1.1: the rehearsal may differ from production only in chain id, owner keys, key custody and the
// timelock delay. Router eligibility, the router vector and the unpause set are none of those, so the Twin sheet carries the 8453 values.
describe("rule b twin sheet", () => {
  const ROUTER_NAMES = ["ELIGIBLE_VAULTS", "ROUTER_WEIGHTS", "GOVERN_UNPAUSE_VAULTS"] as const;
  const values = (rel: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of readFileSync(join(REPO, rel), "utf8").split("\n")) {
      const m = /^([A-Z][A-Z0-9_]*)=(\S*)/.exec(line.trim());
      if (m) out[m[1]!] = m[2]!;
    }
    return out;
  };
  const twin = values("deployments/twin-918453/stage-sheet.env");
  const mainnet = values("deployments/base-8453-rehearsal/stage-sheet.example.env");
  const table = JSON.parse(readFileSync(join(REPO, "scripts", "deploy", "stage-table.json"), "utf8"));
  test("the two sheets are the Twin chain and chain 8453", () => {
    expect(twin.CHAIN_ID).toBe("918453");
    expect(mainnet.CHAIN_ID).toBe("8453");
  });
  for (const name of ROUTER_NAMES) {
    test(`${name} is equal on the Twin sheet and the 8453 example sheet`, () => {
      expect(twin[name]).toBeDefined();
      expect([name, twin[name]]).toEqual([name, mainnet[name]]);
    });
  }
  test("the table records no Twin exception for these names, and the unpause set is the table's stage 13 vaults", () => {
    expect(JSON.stringify(table)).not.toMatch(/twinSheetException/);
    const stage13 = (table.vaults as { key: string; unpauseInStage13: boolean }[]).filter((v) => v.unpauseInStage13).map((v) => v.key);
    expect(twin.GOVERN_UNPAUSE_VAULTS!.split(",")).toEqual(stage13);
  });
  test("the Twin sheet parses with the launch vector and the three unpauses", () => {
    const s = parseSheet(readFileSync(join(REPO, "deployments/twin-918453/stage-sheet.env"), "utf8"));
    expect(s.weights.map((w) => `${w.key}:${w.bps}`).join(",")).toBe("USDC:9500,PROTO:500,RWA:0");
    expect([...s.eligibleVaults]).toEqual(["PROTO", "RWA"]);
    expect([...s.govern.unpauseVaults]).toEqual(["USDC", "PROTO", "RWA"]);
  });
});

// Issue 1705 C9: every vault's registry name is a script constant, so the sheet carries no VAULT_NAME.
test("VAULT_NAME is refused with the reason: one registry-name source for all three vaults", () => {
  expect(() => parseSheet(sheetText({}, ['VAULT_NAME="Robot Money USDC"']))).toThrow(/VAULT_NAME is refused: .*one registry-name source/);
});

// Issue 1833: an old sheet (made before issue 1705) still carries VAULT_NAME. The follow-on verbs drop it with one warning naming the line; every deploy run refuses it.
describe("VAULT_NAME on an old sheet: follow-on verbs warn, deploy verbs refuse (issue 1833)", () => {
  const OLD = sheetText({}, ['VAULT_NAME="Robot Money USDC"']);
  const line = OLD.split("\n").findIndex((l) => l.startsWith("VAULT_NAME=")) + 1;
  for (const verb of ["govern", "verify", "record-receipt", "pause-all"]) {
    test(`${verb}: parses, with one warning naming the VAULT_NAME line`, () => {
      const warnings: { message: string; fields: Record<string, unknown> }[] = [];
      const s = parseSheet(OLD, { verb, warn: (message, fields) => warnings.push({ message, fields }) });
      expect(s.values.VAULT_NAME).toBeUndefined();
      expect(s.chainId).toBe(918453);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toContain(`sheet line ${line}: VAULT_NAME is ignored by ${verb}`);
      expect(warnings[0]!.fields).toMatchObject({ name: "VAULT_NAME", line, verb });
    });
  }
  for (const verb of [undefined, "publish", "redeploy-vault"]) {
    test(`deploy verb ${verb ?? "(none: a stage run)"}: refused with the issue 1705 reason, no warning`, () => {
      const warnings: string[] = [];
      expect(() => parseSheet(OLD, { verb, warn: (m) => warnings.push(m) })).toThrow(/VAULT_NAME is refused: .*\(issue 1705: one registry-name source for all three vaults\)/);
      expect(warnings).toEqual([]);
    });
  }
  test("a sheet without VAULT_NAME warns about nothing on a follow-on verb", () => {
    const warnings: string[] = [];
    parseSheet(sheetText(), { verb: "pause-all", warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });
});

// Issue 1809 (upgradeability stage 2): the release mode of every core proxy is a required sheet name with no default; an upgradeable production release on 8453 names
// its freeze deadline, a frozen one refuses one.
describe("UPGRADE_MODE and UPGRADE_FREEZE_DEADLINE (issue 1809)", () => {
  const MAIN = { CHAIN_ID: "8453", EXPECTED_CHAIN_ID: "8453", TIMELOCK_MIN_DELAY: "172800", GOVERN_NEW_DELAY: "172800" };
  /** A fixed wall clock: 2026-10-01T00:00:00Z. */
  const CLOCK = Date.UTC(2026, 9, 1);
  test("UPGRADE_MODE is required, has no default and takes only upgradeable or frozen", () => {
    expect(REQUIRED_NAMES).toContain("UPGRADE_MODE");
    expect(refused(sheetText({ UPGRADE_MODE: null })).message).toContain("missing required names: UPGRADE_MODE");
    expect(refused(sheetText({ UPGRADE_MODE: "frozen-later" })).message).toContain("UPGRADE_MODE must be upgradeable or frozen");
    expect(parseSheet(sheetText({ UPGRADE_MODE: "frozen" })).upgrade).toEqual({ mode: "frozen" });
    expect(parseSheet(sheetText({ UPGRADE_MODE: "upgradeable" })).upgrade).toEqual({ mode: "upgradeable" });
  });
  test("an upgradeable production release on 8453 needs the freeze deadline; a rehearsal, the Twin chain and a frozen release do not", () => {
    expect(refused(sheetText({ ...MAIN, UPGRADE_MODE: "upgradeable" })).message).toContain("UPGRADE_FREEZE_DEADLINE");
    expect(parseSheet(sheetText({ ...MAIN, UPGRADE_MODE: "upgradeable" }, ["UPGRADE_FREEZE_DEADLINE=2027-01-31T00:00:00Z"]), { now: () => CLOCK }).upgrade).toEqual({ mode: "upgradeable", freezeDeadline: "2027-01-31T00:00:00Z" });
    expect(parseSheet(sheetText({ ...MAIN, UPGRADE_MODE: "frozen" })).upgrade).toEqual({ mode: "frozen" });
    expect(parseSheet(sheetText({ UPGRADE_MODE: "upgradeable" })).upgrade.freezeDeadline).toBeUndefined();
  });
  test("a deadline with the frozen mode is a contradiction, and a deadline that is not an ISO 8601 UTC time is refused", () => {
    expect(refused(sheetText({ UPGRADE_MODE: "frozen" }, ["UPGRADE_FREEZE_DEADLINE=2027-01-31T00:00:00Z"])).message).toContain("nothing to freeze later");
    for (const bad of ["2027-01-31", "2027-02-30T00:00:00Z", "2027-01-31T00:00:00+01:00", "tomorrow"]) {
      expect(refused(sheetText({ UPGRADE_MODE: "upgradeable" }, [`UPGRADE_FREEZE_DEADLINE=${bad}`])).message, bad).toContain("ISO 8601 UTC");
    }
  });
  test("issue 1842: a deploy run refuses a deadline in the past or sooner than now + TIMELOCK_MIN_DELAY + 1 day, naming UPGRADE_FREEZE_DEADLINE; a later one parses", () => {
    const at = (deadline: string, over: Record<string, string> = MAIN, opts: { verb?: string } = {}) => {
      try { return parseSheet(sheetText({ ...over, UPGRADE_MODE: "upgradeable" }, [`UPGRADE_FREEZE_DEADLINE=${deadline}`]), { now: () => CLOCK, ...opts }).upgrade; }
      catch (e) { expect((e as PublishError).kind).toBe("SHEET"); return (e as PublishError).message; }
    };
    // the clock is 2026-10-01T00:00:00Z and the delay 172800 s: the earliest deadline is 2026-10-04T00:00:00Z
    expect(at("2026-09-30T00:00:00Z")).toEqual(expect.stringMatching(/^UPGRADE_FREEZE_DEADLINE 2026-09-30T00:00:00Z is in the past/));
    expect(at("2026-10-03T23:59:59Z")).toEqual(expect.stringMatching(/^UPGRADE_FREEZE_DEADLINE 2026-10-03T23:59:59Z is too near: .*TIMELOCK_MIN_DELAY \(172800 s\) \+ 1 day, 2026-10-04T00:00:00Z/));
    expect(at("2026-10-04T00:00:00Z")).toEqual({ mode: "upgradeable", freezeDeadline: "2026-10-04T00:00:00Z" });
    // the delay is the sheet's own: a Twin sheet with 60 s may name a deadline a day and a minute out
    expect(at("2026-10-02T00:01:00Z", { TIMELOCK_MIN_DELAY: "60" })).toEqual({ mode: "upgradeable", freezeDeadline: "2026-10-02T00:01:00Z" });
    expect(at("2026-10-02T00:00:59Z", { TIMELOCK_MIN_DELAY: "60" })).toEqual(expect.stringContaining("too near"));
    // a follow-on verb runs against a deployment that already exists: verify reports the deadline, the sheet does not block it
    for (const verb of ["verify", "govern", "pause-all", "record-receipt", "redeploy-vault"]) expect(at("2026-09-30T00:00:00Z", MAIN, { verb })).toEqual({ mode: "upgradeable", freezeDeadline: "2026-09-30T00:00:00Z" });
  });
  test("every committed sheet declares its mode: the Twin sheet, the 8453 rehearsal example and the production fixture are frozen", () => {
    for (const f of ["deployments/twin-918453/stage-sheet.env", "deployments/base-8453-rehearsal/stage-sheet.example.env"]) {
      expect(parseSheet(readFileSync(join(REPO, f), "utf8")).upgrade, f).toEqual({ mode: "frozen" });
    }
    expect(parseSheet(exampleText()).upgrade).toEqual({ mode: "frozen" });
  });
});

// Issue 1927: the follow-on verbs of the governed upgrade (runbook 4.15) read the live Deploy 3 sheet, which still describes the v0.5.0 rmAGENT. Its lines are the retired vault's record:
// checked like a basket's, then out of every router list. A deploy run refuses them, and so does a sheet that gives rmAGENT a default weight.
describe("the retired rmAGENT lines of a v0.5.0 sheet (issue 1927)", () => {
  const AGENT = ["VAULT_AGENT_TVL_CAP=1000000000", "VAULT_AGENT_PER_DEPOSIT_CAP=100000000", "VAULT_AGENT_EXIT_FEE_BPS=0", "VAULT_AGENT_NAV_DEVIATION_BPS=400", "VAULT_AGENT_MIN_POOL_LIQUIDITY=1000000000000000"];
  const v050 = (over: Record<string, string | null> = {}, extra = AGENT) => sheetText({ ELIGIBLE_VAULTS: "PROTO,AGENT,RWA", ROUTER_WEIGHTS: "USDC:9500,PROTO:500,AGENT:0,RWA:0", GOVERN_UNPAUSE_VAULTS: "USDC,PROTO,AGENT,RWA", ...over }, extra);
  test("govern, verify and deploy-implementation read them as the retired vault: rmAGENT leaves ELIGIBLE_VAULTS, GOVERN_UNPAUSE_VAULTS and its 0 bps ROUTER_WEIGHTS leg; values keep what the sheet said", () => {
    for (const verb of ["govern", "verify", "deploy-implementation"]) {
      const warns: string[] = [];
      const s = parseSheet(v050(), { verb, warn: (m) => warns.push(m) });
      expect(s.retiredVaults).toEqual(["AGENT"]);
      expect(Object.keys(s.vaults)).toEqual([...VAULT_KEYS]);
      expect(s.eligibleVaults).toEqual(["PROTO", "RWA"]);
      expect(s.govern.unpauseVaults).toEqual(["USDC", "PROTO", "RWA"]);
      expect(s.weights).toEqual([{ key: "USDC", bps: 9500 }, { key: "PROTO", bps: 500 }, { key: "RWA", bps: 0 }]);
      expect(s.values.VAULT_AGENT_MIN_POOL_LIQUIDITY).toBe("1000000000000000");
      expect(s.values.ROUTER_WEIGHTS).toBe("USDC:9500,PROTO:500,AGENT:0,RWA:0");
      expect(warns.length).toBe(1);
      expect(warns[0]).toContain("retired vault of the v0.5.0 deployment");
    }
  });
  test("a deploy run refuses them; a follow-on verb refuses a missing line, a broken floor and a default weight on rmAGENT", () => {
    expect(() => parseSheet(v050())).toThrow("VAULT_AGENT_TVL_CAP is not a sheet name");
    expect(() => parseSheet(v050({}, AGENT.slice(0, 4)), { verb: "govern" })).toThrow("is missing VAULT_AGENT_MIN_POOL_LIQUIDITY");
    expect(() => parseSheet(v050({}, [...AGENT.slice(0, 4), "VAULT_AGENT_MIN_POOL_LIQUIDITY=0"]), { verb: "govern" })).toThrow("break the basket floors");
    expect(() => parseSheet(v050({ ROUTER_WEIGHTS: "USDC:9000,PROTO:500,AGENT:500,RWA:0" }), { verb: "govern" })).toThrow("gives the retired rmAGENT 500 bps");
    // a sheet without the lines is this line's sheet, read as before
    expect(parseSheet(sheetText(), { verb: "govern" }).retiredVaults).toBeUndefined();
  });
});
