import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanEvidenceFolder } from "../src/evidence-check.ts";
import { scanRehearsal } from "../src/ci/scan-rehearsal-secrets.ts";
import { configHashes, writeReport, type IsoReport } from "../src/isomorphism.ts";
import { fileHashOf } from "../src/counts.ts";

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
  // issue 1689: a hash word on the line no longer exempts a 64-hex hit; only sha256:<hex> under configHashes and a whole 0x bytes32 JSON value pass
  test("key-like hex on a line that names tx, hash, salt, digest, sha or block is flagged", () => {
    const k = "5e".repeat(32);
    const lines = [`tx ${k}`, `"hash": "${k}"`, `tx_hash=0x${k} extra`, `salt ${k}`, `"payload_digest": "${k}",`, `sha ${k}`, `block 12 key 0x${k} done`, `"fileHash": "${k}"`];
    for (const line of lines) {
      const d = scratch();
      writeFileSync(join(d, "notes.txt"), line + "\n");
      expect(scanEvidenceFolder(d).join()).toContain("64-hex");
    }
  });
  test("a sha256:<hex> value under configHashes passes, the same value outside configHashes or without the prefix is flagged", () => {
    const h = "6b".repeat(32);
    const ok = scratch();
    writeFileSync(join(ok, "iso.json"), JSON.stringify({ chainId: 1, configHashes: { "config/a.json": `sha256:${h}`, "config/b.json": `sha256:${h}` }, after: 1 }, null, 2) + "\n");
    expect(scanEvidenceFolder(ok)).toEqual([]);
    const outside = scratch();
    writeFileSync(join(outside, "iso.json"), JSON.stringify({ configHashes: { "config/a.json": `sha256:${h}` }, other: { "config/a.json": `sha256:${h}` } }, null, 2) + "\n");
    expect(scanEvidenceFolder(outside)).toEqual([`${join(outside, "iso.json")}:6: 64-hex value (private key shape)`]);
    const bare = scratch();
    writeFileSync(join(bare, "iso.json"), JSON.stringify({ configHashes: { "config/a.json": `sha256:${h}`, key: h } }, null, 2) + "\n");
    expect(scanEvidenceFolder(bare)).toEqual([`${join(bare, "iso.json")}:4: 64-hex value (private key shape)`]);
    const oneLine = scratch();
    writeFileSync(join(oneLine, "iso.json"), JSON.stringify({ configHashes: { "config/a.json": `sha256:${h}` } }) + "\n");
    expect(scanEvidenceFolder(oneLine).join()).toContain("64-hex");
  });
  test("a pool_id value in a compact manifest is public, the same value under another key still is flagged", () => {
    const id = `0x${"f2".repeat(32)}`;
    const ok = scratch();
    writeFileSync(join(ok, "m.json"), `{"vault":"0x28C5ca4DF0107679bFcc9b0ad4c2f3F209b8f797","assets":[{"pool_id":"${id}"},{"pool_id":"0x${"00".repeat(32)}"}]}\n`);
    expect(scanEvidenceFolder(ok)).toEqual([]);
    const other = scratch();
    writeFileSync(join(other, "m.json"), `{"pool_id":"${id}","key":"${id}"}\n`);
    expect(scanEvidenceFolder(other).join()).toContain("64-hex");
  });
  test("a keystore, an assignment and a mnemonic are found", () => {
    const d = scratch(); mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "sub", "ks.json"), '{"crypto": {"ciphertext": "00"}}\n');
    writeFileSync(join(d, "env.txt"), "ETH_PASSWORD=hunter2hunter2\n");
    writeFileSync(join(d, "m.txt"), "abandon ability able about above absent absorb abstract absurd abuse access accident\n");
    const r = scanEvidenceFolder(d).join("\n");
    expect(r).toContain("keystore json"); expect(r).toContain("secret assignment"); expect(r).toContain("mnemonic");
  });
  // Security round 1: a prefixed secret name hid behind the leading \b (the `_` before PASSWORD is a word character), and `passphrase` was not a name at all.
  test("a prefixed password, passphrase or API key assignment is found, each on its own line", () => {
    const lines = [
      "CHAIN_SIGNER_PASSWORD=hunter2hunter2",
      "ETH_KEYSTORE_PASSWORD=hunter2hunter2",
      "ALCHEMY_API_KEY=abcdefghijk12345",
      '{"passphrase": "hunter2hunter2"}',
      "SAFE_OWNER_A_PASSWORD=hunter2hunter2",
      "DEPLOYER_PRIVATE_KEY=abcdefghijk12345",
      "export RELAYER_MNEMONIC=abcdefghijk12345",
      "WEBHOOK_SECRET=abcdefghijk12345",
    ];
    for (const line of lines) {
      const d = scratch();
      writeFileSync(join(d, "log.txt"), `${line}\n`);
      expect([line, scanEvidenceFolder(d).join()]).toEqual([line, expect.stringContaining("secret assignment")]);
    }
  });
  test("mutation: the redacted forms and names that only contain a secret word scan clean", () => {
    const d = scratch();
    writeFileSync(join(d, "log.txt"), ['{"passphrase": "[redacted]"}', "CHAIN_SIGNER_PASSWORD=[redacted]", '{"passphrase_source": "prompt"}', '{"secret_scan": "clean"}', "token_out=0x" + "ab".repeat(20)].join("\n") + "\n");
    expect(scanEvidenceFolder(d)).toEqual([]);
  });
  // Issue 1689 acceptance, kept through the merge: a whole-line JSON bytes32 is exempt from the 64-hex rule, so a key that names a secret must be caught by name.
  test("a pretty-printed privateKey, private_key or authToken line holding a bytes32 is flagged by name", () => {
    for (const line of [`  "privateKey": "0x${"ab".repeat(32)}",`, `  "private_key": "0x${"cd".repeat(32)}"`, `  "authToken": "0x${"ef".repeat(32)}",`]) {
      const d = scratch();
      writeFileSync(join(d, "evidence.json"), `{\n${line}\n}\n`);
      expect([line, scanEvidenceFolder(d).join()]).toEqual([line, expect.stringContaining("secret assignment")]);
    }
  });
  test("every committed evidence folder is clean", () => {
    const root = resolve(import.meta.dir, "..", "..");
    const counts = join(root, "deployments", "frozen-counts");
    // The one bare 64-hex a committed file may hold is a frozen counts file's measured.crossChecked.fileHash (counts.ts), and only when it is
    // provably public: the sha256 of the committed anchor file it names. Any other hit, or a fileHash that is not that digest, fails.
    const provenFileHash = (hit: string): boolean => {
      const [f, n] = hit.split(":");
      if (!f!.startsWith(counts + "/")) return false;
      const cc = JSON.parse(readFileSync(f!, "utf8"))?.measured?.crossChecked;
      const line = readFileSync(f!, "utf8").split("\n")[Number(n) - 1]!;
      return typeof cc?.fileHash === "string" && line.trim() === `"fileHash": "${cc.fileHash}"` && fileHashOf(readFileSync(join(counts, `${cc.sha}.json`))) === cc.fileHash;
    };
    for (const dir of [join(root, "evidence"), join(root, "deployments")]) if (existsSync(dir)) expect(scanEvidenceFolder(dir).filter((h) => !provenFileHash(h))).toEqual([]);
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
