import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputsFromFixturesDir, runParity } from "../parity.ts";

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "parity-"));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
  return d;
}

const stage = () => dir({ "labels.txt": "PASS a\nPASS b\nRESULT: VERIFIED\n", "sheet.env": "CHAIN_ID=918453\nUSDC_ADDRESS=0x1\nSAFE_OWNERS=0xa\n" });
const prod = (labels = "PASS a\nPASS b\n", sheet = "CHAIN_ID=8453\nUSDC_ADDRESS=0x1\nSAFE_OWNERS=0xb\n") =>
  dir({ "verifier-labels.txt": labels, "production-sheet.env": sheet });

test("parity holds when labels match and the sheets differ only in parameter and identity lines", () => {
  const s = stage();
  const r = runParity(inputsFromFixturesDir(prod(), join(s, "labels.txt"), join(s, "sheet.env")));
  expect(r.ok).toBe(true);
});

test("a missing production fixture fails and names the path", () => {
  const s = stage();
  const r = runParity(inputsFromFixturesDir(join(tmpdir(), "no-such-fixtures"), join(s, "labels.txt"), join(s, "sheet.env")));
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toContain("no-such-fixtures");
  expect(r.messages.join("\n")).toContain("parity input missing or empty");
});

test("an empty stage label file fails (it is not skipped)", () => {
  const s = dir({ "labels.txt": "", "sheet.env": "CHAIN_ID=1\n" });
  const r = runParity(inputsFromFixturesDir(prod(), join(s, "labels.txt"), join(s, "sheet.env")));
  expect(r.ok).toBe(false);
});

test("a label only on mainnet fails and is named", () => {
  const s = stage();
  const r = runParity(inputsFromFixturesDir(prod("PASS a\nPASS b\nPASS c\n"), join(s, "labels.txt"), join(s, "sheet.env")));
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toContain("only on mainnet: c");
});

test("a non-parameter sheet difference fails", () => {
  const s = stage();
  const r = runParity(inputsFromFixturesDir(prod(undefined, "CHAIN_ID=8453\nUSDC_ADDRESS=0x2\nSAFE_OWNERS=0xb\n"), join(s, "labels.txt"), join(s, "sheet.env")));
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toContain("USDC_ADDRESS");
});
