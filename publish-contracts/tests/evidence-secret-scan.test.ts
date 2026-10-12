import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanEvidenceFolder } from "../src/evidence-check.ts";
import { scanRehearsal } from "../src/ci/scan-rehearsal-secrets.ts";
import { configHashes, writeReport, type IsoReport } from "../src/isomorphism.ts";

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
  test("a folder holding an isomorphism report from isomorphism.ts scans clean", () => {
    const d = scratch();
    const coreDir = resolve(import.meta.dir, "..", "..");
    const hashes = configHashes(coreDir);
    expect(Object.keys(hashes).length).toBeGreaterThan(0);
    writeReport(join(d, "isomorphism-8453.json"), { chainId: 8453, configHashes: hashes, codehashes: { "vault[usdc]": "0x" + "cd".repeat(32) } } as unknown as IsoReport);
    expect(scanEvidenceFolder(d)).toEqual([]);
  });
  test("a bare 64-hex value on a config path line still fails", () => {
    const d = scratch();
    writeFileSync(join(d, "isomorphism-8453.json"), JSON.stringify({ configHashes: { "config/dex-pools.json": "6b".repeat(32) } }, null, 2) + "\n");
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

// Synthetic public shapes only (issue 1759): the ids below are made up, none is a real receipt, operation or key.
const RID = "0x" + "a1".repeat(32);
const OPID = "0x" + "b2".repeat(32);
const KEY = "0x" + "c3".repeat(32);
const PASS = "correct-horse-battery-staple";
const benign = (d: string) => {
  writeFileSync(join(d, "apply-receipt-rows.txt"), `row apply-receipt-${RID} done\n`);
  writeFileSync(join(d, "publish-run.json"), JSON.stringify({ [`apply-receipt-${RID}`]: { ok: true } }, null, 2) + "\n");
  writeFileSync(join(d, "govern.log"), [
    JSON.stringify({ ts: "t", level: "info", event: "govern.waiting", component: "safe", rows: [`apply-receipt-${RID}`], remaining_s: 5 }),
    JSON.stringify({ ts: "t", level: "info", event: "timelock.effect", component: "safe", id: OPID, action: "schedule", ok: true, detail: `operation ${OPID} is pending, ready at unix time 1` }),
    JSON.stringify({ ts: "t", level: "info", event: "govern.waiting", component: "safe", ids: [OPID, OPID], rows: [] }),
  ].join("\n") + "\n");
};
const realKeys = (d: string) => {
  writeFileSync(join(d, "env.txt"), `SIGNER=${KEY}\n`);
  writeFileSync(join(d, "bare.txt"), `${KEY}\n`);
  writeFileSync(join(d, "ks.json"), JSON.stringify({ address: "0x00", key: KEY.slice(2) }) + "\n");
  writeFileSync(join(d, "other-event.log"), JSON.stringify({ ts: "t", level: "info", event: "signer.loaded", id: KEY, detail: `operation ${KEY}` }) + "\n");
  writeFileSync(join(d, "wrong-field.log"), JSON.stringify({ ts: "t", level: "info", event: "timelock.effect", note: KEY }) + "\n");
  writeFileSync(join(d, "not-json.log"), `"event":"timelock.effect" "id":"${KEY}" x\n`);
};
const flaggedFiles = (hits: string[]) => hits.map((h) => h.split(":")[0]!.split("/").pop()).sort();
const REAL = ["bare.txt", "env.txt", "ks.json", "not-json.log", "other-event.log", "wrong-field.log"];
/** The claim the allowance must keep true: every real-key case is flagged. */
const assertRealKeysFlagged = (scan: (d: string) => string[]) => {
  const d = scratch(); realKeys(d);
  expect(flaggedFiles(scan(d))).toEqual(REAL);
};

describe("public bytes32 contexts in the rehearsal secret scan (issue 1759)", () => {
  test("receipt-id row names, a publish-run.json key and timelock operation ids scan clean", () => {
    const d = scratch(); benign(d);
    expect(scanEvidenceFolder(d)).toEqual([]);
    expect(scanRehearsal(d, [PASS])).toEqual([]);
  });
  test("a real key in env, keystore, bare, other-event, wrong-field and non-JSON contexts is still flagged", () => {
    assertRealKeysFlagged((d) => scanEvidenceFolder(d));
    assertRealKeysFlagged((d) => scanRehearsal(d, [PASS]));
  });
  test("a key beside a benign shape on the same line is still flagged", () => {
    const d = scratch();
    writeFileSync(join(d, "mix.txt"), `apply-receipt-${RID} ${KEY}\n`);
    expect(scanEvidenceFolder(d).join()).toContain("64-hex");
  });
  test("the passphrase literal is still flagged", () => {
    const d = scratch(); benign(d);
    writeFileSync(join(d, "oops.txt"), `unlocked with ${PASS}\n`);
    expect(scanRehearsal(d, [PASS]).join()).toContain("oops.txt: contains a secret value");
  });
  test("mutation: an allowance widened to any 64-hex value makes the real-key check fail", () => {
    const widened = (line: string) => line.replace(/0x[0-9a-fA-F]{64}/g, "0x");
    expect(() => assertRealKeysFlagged((d) => scanEvidenceFolder(d, widened))).toThrow();
    const matchAll = () => "";
    expect(() => assertRealKeysFlagged((d) => scanEvidenceFolder(d, matchAll))).toThrow();
  });
});
