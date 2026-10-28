// Tests of scripts/runbook/qa-assert.ts: the router-leg, split-change and share-delta assertions the rounds before and after the router rebalance make (issue 1984).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWeights, receiptVector, routerLegProblems, routerLegsOf } from "./qa-assert.ts";

const TOPIC = `0x${"ab".repeat(32)}`;
const USDC_VAULT = "0x1111111111111111111111111111111111111111";
const PROTO_VAULT = "0x2222222222222222222222222222222222222222";
const RWA_VAULT = "0x3333333333333333333333333333333333333333";
const DEPOSITOR = `0x${"0".repeat(24)}${"9".repeat(40)}`;
const word = (n: bigint): string => n.toString(16).padStart(64, "0");
const log = (vault: string, amount: bigint, shares: bigint, bps: bigint, topic = TOPIC) => ({ address: "0xrouter", topics: [topic, DEPOSITOR, `0x${"0".repeat(24)}${vault.slice(2)}`], data: `0x${word(amount)}${word(shares)}${word(bps)}` });
const receipt = (logs: unknown[], status = "0x1"): string => JSON.stringify({ status, transactionHash: `0x${"cd".repeat(32)}`, logs });
// `cast call ... "getEffectiveWeights()(address[],uint256[])"`: the address list, then the bps list; cast annotates a value of 10000 or more
const WEIGHTS_DEFAULT = `[${USDC_VAULT}, ${PROTO_VAULT}, ${RWA_VAULT}]\n[9500, 500, 0]\n`;
const WEIGHTS_RECEIPT = `[${USDC_VAULT}, ${PROTO_VAULT}, ${RWA_VAULT}]\n[8000, 1000, 1000]\n`;
const PRE = receipt([log(USDC_VAULT, 1_900_000n, 1_899_000n, 9500n), log(PROTO_VAULT, 100_000n, 99_000n, 500n), { address: "0xusdc", topics: [`0x${"ee".repeat(32)}`], data: "0x" }]);
// the Twin receipt (USDC 8000, PROTO 1000, RWA 1000) weights every vault: the post-rebalance router deposit has three legs
const POST = receipt([log(USDC_VAULT, 1_600_000n, 1_599_000n, 8000n), log(PROTO_VAULT, 200_000n, 198_000n, 1000n), log(RWA_VAULT, 200_000n, 197_000n, 1000n)]);

test("a weights answer parses into its vaults and bps, cast's exponent annotation dropped", () => {
  expect(parseWeights(WEIGHTS_DEFAULT)).toEqual({ vaults: [USDC_VAULT, PROTO_VAULT, RWA_VAULT], bps: [9500n, 500n, 0n] });
  expect(parseWeights(`[${USDC_VAULT}, ${PROTO_VAULT}]\n[10000 [1e4], 0]`).bps).toEqual([10000n, 0n]);
  expect(() => parseWeights(`[${USDC_VAULT}]\n[9500, 500]`)).toThrow("names 1 vaults and 2 weights");
  expect(() => parseWeights("[9500, 500]")).toThrow("two lines");
});

test("the router deposit legs follow the effective weights: one leg per non-zero weight, its vault and weight, shares minted", () => {
  const legs = routerLegsOf(PRE, TOPIC);
  expect(legs.map((l) => [l.vault, l.weightBps])).toEqual([[USDC_VAULT, 9500n], [PROTO_VAULT, 500n]]);
  expect(routerLegProblems(legs, parseWeights(WEIGHTS_DEFAULT))).toEqual([]);
  // the same deposit does not follow another vector
  expect(routerLegProblems(legs, parseWeights(WEIGHTS_RECEIPT)).join("\n")).toContain("are not the non-zero effective weights");
  // a missing leg, an extra leg into a zero-weight vault and a leg that minted nothing all fail
  expect(routerLegProblems(routerLegsOf(receipt([log(USDC_VAULT, 1n, 1n, 9500n)]), TOPIC), parseWeights(WEIGHTS_DEFAULT))).toHaveLength(1);
  expect(routerLegProblems(routerLegsOf(receipt([...JSON.parse(PRE).logs, log(RWA_VAULT, 1n, 1n, 0n)]), TOPIC), parseWeights(WEIGHTS_DEFAULT))).toHaveLength(1);
  expect(routerLegProblems(routerLegsOf(receipt([log(USDC_VAULT, 1_900_000n, 0n, 9500n), log(PROTO_VAULT, 100_000n, 99_000n, 500n)]), TOPIC), parseWeights(WEIGHTS_DEFAULT)).join("\n")).toContain("for 0 shares");
  expect(() => routerLegsOf(receipt([], "0x0"), TOPIC)).toThrow("status 0x0");
  expect(() => routerLegsOf(PRE, "RouterDeposit")).toThrow("not a 32-byte hash");
});

test("a receipt's vault vector drops agent_tokens and keeps the bucket order P5.04 compares", () => {
  const r = JSON.stringify({ weights: [{ bucket: "agent_tokens", weight_bps: 0 }, { bucket: "conservative_defi_yield", weight_bps: 8000 }, { bucket: "protocol_tokens", weight_bps: 1000 }, { bucket: "real_world_assets", weight_bps: 1000 }] });
  expect(receiptVector(r)).toEqual([8000n, 1000n, 1000n]);
  expect(() => receiptVector("{}")).toThrow("no weights");
});

/** Runs the CLI in a temp dir with these files; returns its exit code and output. */
function cli(args: (dir: string) => string[], files: Record<string, string>): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "qa-assert-"));
  try {
    for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, n), t);
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "qa-assert.ts"), ...args(dir)]);
    return { code: p.exitCode, out: `${p.stdout.toString()}${p.stderr.toString()}` };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("the CLI: router-legs, legs-differ and receipt-changes-split pass and fail on the files a run writes", () => {
  const files = { "pre.json": PRE, "post.json": POST, "default": WEIGHTS_DEFAULT, "receipt-w": WEIGHTS_RECEIPT,
    "receipt.json": JSON.stringify({ weights: [{ bucket: "agent_tokens", weight_bps: 0 }, { bucket: "conservative_defi_yield", weight_bps: 8000 }, { bucket: "protocol_tokens", weight_bps: 1000 }, { bucket: "real_world_assets", weight_bps: 1000 }] }),
    "same.json": JSON.stringify({ weights: [{ bucket: "agent_tokens", weight_bps: 0 }, { bucket: "conservative_defi_yield", weight_bps: 9500 }, { bucket: "protocol_tokens", weight_bps: 500 }, { bucket: "real_world_assets", weight_bps: 0 }] }) };
  expect(cli((d) => ["router-legs", join(d, "pre.json"), join(d, "default"), TOPIC], files).code).toBe(0);
  expect(cli((d) => ["router-legs", join(d, "post.json"), join(d, "receipt-w"), TOPIC], files).code).toBe(0);
  expect(cli((d) => ["router-legs", join(d, "post.json"), join(d, "default"), TOPIC], files).code).toBe(1);
  expect(cli((d) => ["legs-differ", join(d, "pre.json"), join(d, "post.json"), TOPIC], files).code).toBe(0);
  const same = cli((d) => ["legs-differ", join(d, "pre.json"), join(d, "pre.json"), TOPIC], files);
  expect(same.code).toBe(1);
  expect(same.out).toContain("did not change across the rebalance");
  expect(cli((d) => ["receipt-changes-split", join(d, "receipt.json"), join(d, "default")], files).code).toBe(0);
  const unchanged = cli((d) => ["receipt-changes-split", join(d, "same.json"), join(d, "default")], files);
  expect(unchanged.code).toBe(1);
  expect(unchanged.out).toContain("cannot show the split change");
  // a router vector of another length than the receipt's (a live vector that still names a retired vault) is another split
  expect(cli((d) => ["receipt-changes-split", join(d, "same.json"), join(d, "four")], { ...files, four: `[${USDC_VAULT}, ${PROTO_VAULT}, ${RWA_VAULT}, 0x4444444444444444444444444444444444444444]\n[9500, 500, 0, 0]\n` }).code).toBe(0);
});

test("the CLI: sub prints the share delta and refuses a balance that fell", () => {
  const ok = cli(() => ["sub", "1000000000000000000000 [1e21]", "999000000000000000000"], {});
  expect(ok.code).toBe(0);
  expect(ok.out.trim()).toBe("1000000000000000000");
  expect(cli(() => ["sub", "1", "2"], {}).code).toBe(1);
});
