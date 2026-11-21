// scripts/runbook/fund-state.test.ts: the pre-state reads of v0.9.0-onevault-upgrade P0.94 and the counters P2.84 compares.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./fund-state.ts";
import type { Cast } from "./cast-io.ts";

const TL = "0x0000000000000000000000000000000000000071", SAFE = "0x00000000000000000000000000000000000000Sa";
const fake = (answers: Record<string, string>): Cast => (args) => {
  const k = args.join(" ");
  if (args[0] === "keccak") return `k(${args[1]})`;
  if (k in answers) return answers[k]!;
  throw new Error(`unexpected cast ${k}`);
};

test("proxies: each runs its manifest implementation, unfrozen, upgraded by the timelock", () => {
  const ok = { "implementation 0xP": "0xIMPL", "call 0xP upgradesFrozen()(bool)": "false", "call 0xP upgradeTimelock()(address)": TL.toUpperCase().replace("0X", "0x") };
  expect(() => main(fake(ok), "proxies", ["--timelock", TL, "--proxy", "0xP:0ximpl"])).not.toThrow();
  expect(() => main(fake(ok), "proxies", ["--timelock", TL, "--proxy", "0xP:0xother"])).toThrow("not the manifest's");
  expect(() => main(fake({ ...ok, "call 0xP upgradesFrozen()(bool)": "true" }), "proxies", ["--timelock", TL, "--proxy", "0xP:0ximpl"])).toThrow("frozen");
  expect(() => main(fake(ok), "proxies", ["--timelock", TL, "--proxy", "0xP"])).toThrow("PROXY:IMPL");
});

test("timelock: the delay, the Safe as proposer, canceller and only executor", () => {
  const role = (r: string, who: string, v: boolean) => ({ [`call ${TL} hasRole(bytes32,address)(bool) k(${r}) ${who}`]: String(v) });
  const ok = {
    [`call ${TL} getMinDelay()(uint256)`]: "900", [`call ${SAFE} getOwners()(address[])`]: "[0x1, 0x2]", [`call ${SAFE} getThreshold()(uint256)`]: "2",
    ...role("PROPOSER_ROLE", SAFE, true), ...role("CANCELLER_ROLE", SAFE, true), ...role("EXECUTOR_ROLE", SAFE, true), ...role("EXECUTOR_ROLE", "0x0000000000000000000000000000000000000000", false),
  };
  expect(() => main(fake(ok), "timelock", ["--timelock", TL, "--safe", SAFE, "--delay", "900"])).not.toThrow();
  expect(() => main(fake(ok), "timelock", ["--timelock", TL, "--safe", SAFE, "--delay", "86400"])).toThrow("delay is 900");
  expect(() => main(fake({ ...ok, ...role("EXECUTOR_ROLE", "0x0000000000000000000000000000000000000000", true) }), "timelock", ["--timelock", TL, "--safe", SAFE, "--delay", "900"])).toThrow("executor is open");
});

test("counters: written as supply-seedshares-plan-requests, then compared", () => {
  const ok = { "call 0xF totalSupply()(uint256)": "3995775955902177929119940 [3.995e24]", "call 0xF balanceOf(address)(uint256) 0xF": "1000000000000000000000000 [1e24]", "call 0xF currentPlanId()(uint256)": "1", "call 0xQ requestCount()(uint256)": "6", "call 0xF planStatus()(uint8)": "0" };
  const out = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "fund-state-")), "upg-fund-before");
  main(fake(ok), "counters", ["--fund", "0xF", "--queue", "0xQ", "--out", out]);
  expect(readFileSync(out, "utf8")).toBe("3995775955902177929119940-1000000000000000000000000-1-6\n");
  expect(() => main(fake(ok), "counters", ["--fund", "0xF", "--queue", "0xQ", "--same", "3995775955902177929119940-1000000000000000000000000-1-6"])).not.toThrow();
  expect(() => main(fake({ ...ok, "call 0xQ requestCount()(uint256)": "7" }), "counters", ["--fund", "0xF", "--queue", "0xQ", "--same", "3995775955902177929119940-1000000000000000000000000-1-6"])).toThrow("was");
  expect(() => main(fake(ok), "counters", ["--fund", "0xF", "--queue", "0xQ"])).toThrow("--out FILE or --same");
});

// ─── v0.9.0 (decision D4-19): the pool depth warning and the migration's sheet keys ───
import { MIGRATION_SHEET_DEFAULTS, missingSheetLines } from "./fund-state.ts";
const w = (n: bigint | number | string) => (typeof n === "string" ? n.replace(/^0x/, "").toLowerCase().padStart(64, "0") : BigInt(n).toString(16).padStart(64, "0"));
const hex = (...xs: (bigint | number | string)[]) => `0x${xs.map(w).join("")}`;

test("pool-depth: prints each active basket pool's depth and warns below the minimum, never failing", () => {
  const cfg = (kind: number, active: number, pool: string) => hex(kind, active, 0, 0, 0, pool, 0);
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => { warned.push(m); };
  try {
    main(fake({
      "call 0xQ flowParams()": hex(3600, 720, ...Array(16).fill(0)),
      "call 0xF assetCount()(uint256)": "3", "call 0xF assetConfig(uint256) 0": cfg(0, 1, "0x01"), "call 0xF assetConfig(uint256) 1": cfg(1, 1, "0x0000000000000000000000000000000000000501"), "call 0xF assetConfig(uint256) 2": cfg(1, 1, "0x0000000000000000000000000000000000000502"),
      "call 0xLIB poolUsdcDepth(address,address,uint32)(bool,uint256) 0x0000000000000000000000000000000000000501 0xU 720": "true\n5000000000000 [5e12]",
      "call 0xLIB poolUsdcDepth(address,address,uint32)(bool,uint256) 0x0000000000000000000000000000000000000502 0xU 720": "true\n1000000000000 [1e12]",
    }), "pool-depth", ["--fund", "0xF", "--queue", "0xQ", "--lib", "0xLIB", "--usdc", "0xU", "--min", "2000000000000"]);
  } finally { console.warn = warn; }
  expect(warned).toHaveLength(1);
  expect(warned[0]).toContain("asset 2 pool 0x0000000000000000000000000000000000000502: depth 1000000000000 (1000000 USDC)");
});

test("sheet-defaults adds only the migration keys the sheet lacks, once", () => {
  const sheet = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "fund-sheet-")), "sheet.env");
  writeFileSync(sheet, "CHAIN_ID=8453\nREBALANCER_MAX_OVERRUN=604800\nFLOW_CANCEL_BUFFER=600\n");
  expect(missingSheetLines(readFileSync(sheet, "utf8"))).not.toContain("FLOW_CANCEL_BUFFER=900");
  main(fake({}), "sheet-defaults", ["--sheet", sheet]);
  const after = readFileSync(sheet, "utf8");
  expect(after).toContain("FLOW_CANCEL_BUFFER=600\n");
  expect(after).toContain("FLOW_MATCH_BAND_BPS=10\n");
  expect(after.match(/^REBALANCER_MAX_OVERRUN=/gm)).toHaveLength(1);
  main(fake({}), "sheet-defaults", ["--sheet", sheet]);
  expect(readFileSync(sheet, "utf8")).toBe(after);
});

test("the sheet defaults are FundStorage.sol's constants", () => {
  const sol = readFileSync(join(import.meta.dir, "..", "..", "contracts", "lib", "FundStorage.sol"), "utf8");
  const d = Object.fromEntries(MIGRATION_SHEET_DEFAULTS);
  const val = (n: string) => { const m = /=\s*([0-9_]+)(e6)?;/.exec(sol.slice(sol.indexOf(n)))!; return (BigInt(m[1]!.replace(/_/g, "")) * (m[2] ? 1_000_000n : 1n)).toString(); };
  for (const [k, c] of [["FUND_MIN_POOL_DEPTH_USDC", "DEFAULT_MIN_POOL_DEPTH_USDC"], ["FUND_FEE_MARGIN_BPS", "DEFAULT_FEE_MARGIN_BPS"], ["FUND_DELIST_BAND_BPS", "DEFAULT_DELIST_BAND_BPS"], ["FUND_DELIST_BUDGET_BPS", "DEFAULT_DELIST_BUDGET_BPS"], ["FUND_MAX_BASKET_BPS", "DEFAULT_MAX_BASKET_BPS"]]) expect(d[k!], k).toBe(val(c!));
});
