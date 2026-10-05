import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanEvidenceFolder } from "../src/evidence-check.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "evidence-scan-"));

describe("secret scan over the evidence folder", () => {
  test("a folder of hashes and addresses has no finding", () => {
    const d = scratch();
    writeFileSync(join(d, "evidence.json"), JSON.stringify({ tx_hashes: ["0x" + "ab".repeat(32)] }, null, 2));
    writeFileSync(join(d, "verify.out.txt"), "ok  safe owners 3\n");
    expect(scanEvidenceFolder(d)).toEqual([]);
  });
  test("a bare private key is found", () => {
    const d = scratch();
    writeFileSync(join(d, "notes.txt"), "key 0x" + "11".repeat(32) + "\n");
    expect(scanEvidenceFolder(d).join()).toContain("64-hex");
  });
  test("a keystore, an assignment and a mnemonic are found", () => {
    const d = scratch(); mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "sub", "ks.json"), '{"crypto": {"ciphertext": "00"}}\n');
    writeFileSync(join(d, "env.txt"), "ETH_PASSWORD=hunter2hunter2\n");
    writeFileSync(join(d, "m.txt"), "abandon ability able about above absent absorb abstract absurd abuse access accident\n");
    const r = scanEvidenceFolder(d).join("\n");
    expect(r).toContain("keystore json"); expect(r).toContain("secret assignment"); expect(r).toContain("mnemonic");
  });
  test("every committed evidence folder is clean", () => {
    const root = resolve(import.meta.dir, "..", "..");
    for (const dir of [join(root, "evidence"), join(root, "deployments")]) if (existsSync(dir)) expect(scanEvidenceFolder(dir)).toEqual([]);
    expect(readdirSync(root).length).toBeGreaterThan(0);
  });
});
