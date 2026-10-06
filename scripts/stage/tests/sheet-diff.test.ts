import { expect, test } from "bun:test";
import { parseSheet, violations } from "../sheet-diff.ts";

const base = `
export CHAIN_ID=918453
export TIMELOCK_MIN_DELAY=60
export VOTING_PERIOD=60
export USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
export ADMIN_ADDRESS=0xaaa
`;
const prod = `
export CHAIN_ID=8453
export TIMELOCK_MIN_DELAY=172800
export VOTING_PERIOD=3600
export USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
export ADMIN_ADDRESS=0xbbb
export SAFE_OWNERS=0x1,0x2,0x3
`;

test("parameter and identity differences are allowed", () => {
  expect(violations(parseSheet(base), parseSheet(prod))).toEqual([]);
});

test("a changed non-parameter value fails", () => {
  const stage = base.replace("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "0x0000000000000000000000000000000000000001");
  expect(violations(parseSheet(stage), parseSheet(prod)).join("\n")).toContain("USDC_ADDRESS");
});

test("a key only in one sheet fails unless it is an identity key", () => {
  const stage = base + "export SOME_NEW_SWITCH=1\n";
  expect(violations(parseSheet(stage), parseSheet(prod)).join("\n")).toContain("SOME_NEW_SWITCH");
});

test("forbidden escape-hatch keys fail on either side", () => {
  const stage = base + "export ALLOW_SHORT_TIMELOCK_DELAY=true\nexport REHEARSAL=1\n";
  const v = violations(parseSheet(stage), parseSheet(prod)).join("\n");
  expect(v).toContain("ALLOW_SHORT_TIMELOCK_DELAY");
  expect(v).toContain("REHEARSAL");
});
