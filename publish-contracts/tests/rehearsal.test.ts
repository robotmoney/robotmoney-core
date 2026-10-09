import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { decryptKeystore } from "../src/keystore/keystore.ts";
import { bytesToHex } from "@noble/hashes/utils";
import { defaultKeyNames, makeRehearsalKeys, sheetFragment } from "../src/rehearsal/keys.ts";
import { argvSecretProblems, differingFlags, publishArgs, rehearsalArgs, TWIN_CHAIN_ID } from "../src/rehearsal/args.ts";
import { checkEnvCredentialRule, fund, planFunding, RefusedError, stageFunderKeystore } from "../src/rehearsal/fund.ts";
import { sweep, withCleanup } from "../src/rehearsal/sweep.ts";
import { assertSheetMatchesRpc, runRehearsal, SheetChainMismatch } from "../src/rehearsal/run.ts";
import { assertLabels, REQUIRED_SAFE_LABELS } from "../src/ci/assert-verify-labels.ts";
import { scanRehearsal } from "../src/ci/scan-rehearsal-secrets.ts";
import type { Cast } from "../src/rehearsal/cast.ts";

const PW = "throwaway-passphrase-0123";
function setup(pw = PW) {
  const d = mkdtempSync(join(tmpdir(), "rehearsal-test-"));
  const pwf = join(d, "pw"); writeFileSync(pwf, pw, { mode: 0o600 });
  return { d, pwf, dir: join(d, "keys") };
}
const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");

describe("keys", () => {
  test("modes, names, and sheet addresses equal the keystore addresses", () => {
    const { dir, pwf } = setup();
    const k = makeRehearsalKeys({ dir, passwordFile: pwf });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir).sort()).toEqual([...defaultKeyNames()].sort());
    for (const n of k.names) {
      expect(statSync(join(dir, n)).mode & 0o777).toBe(0o600);
      const j = readFileSync(join(dir, n), "utf8");
      expect("0x" + JSON.parse(j).address).toBe(k.addresses[n]!.toLowerCase());
      expect(decryptKeystore(j, PW).length).toBe(32);
    }
    const sheet = sheetFragment(k, TWIN_CHAIN_ID);
    expect(sheet).toContain("SAFE_THRESHOLD=2");
    expect(sheet).toContain(`SAFE_OWNERS=${["SAFE_OWNER_A", "SAFE_OWNER_B", "SAFE_OWNER_C"].map((n) => k.addresses[n]).join(",")}`);
    expect(sheet).toContain(`ADMIN_ADDRESS=${k.addresses.DEPLOYER}`);
    expect(sheet).toContain(`RECEIPT_ADMIN_ADDRESS=${k.addresses.DEPLOYER}`);
    // the deploy authorizes no agent (core 1527): no AGENT key is minted and the fragment has no AGENT line
    expect(k.names).not.toContain("AGENT");
    expect(sheet).not.toMatch(/AGENT/);
  }, 120_000);
  test("refuses existing name, bad name, short passphrase, loose password file; writes nothing", () => {
    const s = setup();
    makeRehearsalKeys({ dir: s.dir, passwordFile: s.pwf, names: ["A"] });
    expect(() => makeRehearsalKeys({ dir: s.dir, passwordFile: s.pwf, names: ["B", "A"] })).toThrow(/already exists/);
    expect(readdirSync(s.dir)).toEqual(["A"]);
    expect(() => makeRehearsalKeys({ dir: s.dir, passwordFile: s.pwf, names: ["bad/name"] })).toThrow(/bad key name/);
    const short = setup("short");
    expect(() => makeRehearsalKeys({ dir: short.dir, passwordFile: short.pwf, names: ["A"] })).toThrow(/16 characters/);
    const loose = setup(); writeFileSync(loose.pwf, PW, { mode: 0o644 }); Bun.spawnSync(["chmod", "644", loose.pwf]);
    expect(() => makeRehearsalKeys({ dir: loose.dir, passwordFile: loose.pwf, names: ["A"] })).toThrow(/0600/);
  });
  test("the CLI prints no key bytes and no passphrase, and none is a process argument", () => {
    const { dir, pwf } = setup();
    const r = spawnSync("bun", [join(import.meta.dir, "../src/rehearsal/cli.ts"), "keys", "--dir", dir, "--password-file", pwf, "--chain-id", "918453"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const all = r.stdout + r.stderr;
    expect(all).not.toContain(PW);
    for (const n of defaultKeyNames()) {
      const pk = bytesToHex(decryptKeystore(readFileSync(join(dir, n), "utf8"), PW));
      expect(all.toLowerCase()).not.toContain(pk);
    }
    expect(all).toMatch(/CHAIN_ID=918453/);
    // the passphrase has no argument route
    const bad = spawnSync("bun", [join(import.meta.dir, "../src/rehearsal/cli.ts"), "keys", "--dir", dir + "2", "--password", PW], { encoding: "utf8" });
    expect(bad.status).not.toBe(0);
  }, 120_000);
});

describe("args", () => {
  test("rehearsal and production differ only in values, never in shape", () => {
    const rh = rehearsalArgs(918453, "https://twin.example", { deploySha: "a".repeat(40) });
    const pr = publishArgs({ chainId: 8453, rpc: "https://mainnet.base.org", sheet: "deployments/base-mainnet/frozen-sheet.env", signer: "ledger", environment: "base-mainnet", deploySha: "a".repeat(40) });
    expect(differingFlags(rh, pr)).toEqual(["--chain", "--rpc", "--sheet", "--signer", "--environment"]);
  });
  test("only the Twin chain, and no key in the signer", () => {
    expect(() => rehearsalArgs(8453, "https://x")).toThrow(/Twin/);
    expect(() => publishArgs({ chainId: 1, rpc: "https://x", sheet: "s", signer: "0x" + "11".repeat(32), environment: "e", deploySha: "" })).toThrow();
  });
});

function fakeChain(o: { chain?: number; balances?: Record<string, bigint>; code?: Record<string, string> } = {}) {
  const calls: string[][] = [];
  const bal = { ...(o.balances ?? {}) };
  const cast: Cast = async (args) => {
    calls.push(args);
    switch (args[0]) {
      case "chain-id": return String(o.chain ?? 918453);
      case "code": return o.code?.[args[1]!.toLowerCase()] ?? "0x";
      case "balance": return String(bal[args[1]!.toLowerCase()] ?? 0n);
      case "gas-price": return "1000000000";
      case "send": { const to = args[1]!.toLowerCase(); const i = args.indexOf("--value"); if (i > 0) bal[to] = (bal[to] ?? 0n) + BigInt(args[i + 1]!); return JSON.stringify({ status: "0x1", transactionHash: "0xabc" }); }
      default: return "0";
    }
  };
  return { cast, calls };
}
const base = (cast: Cast, extra = {}) => ({ rpc: "http://127.0.0.1:8545", chainId: 918453, funder: A(1), recipients: [{ name: "deployer", address: A(2), ethWei: 10n ** 16n }, { name: "pauser", address: A(3), ethWei: 10n ** 16n }], signArgs: ["--keystore", "k", "--password-file", "p"], cast, ...extra });

describe("fund", () => {
  test("happy path sends and verifies", async () => {
    const c = fakeChain({ balances: { [A(1)]: 10n ** 18n } });
    const r = await fund(base(c.cast));
    expect(r.txs.length).toBe(2);
  });
  test("refusals", async () => {
    const f = { balances: { [A(1)]: 10n ** 18n } };
    await expect(planFunding(base(fakeChain({ ...f, chain: 1 }).cast))).rejects.toThrow(/chain id/);
    await expect(planFunding(base(fakeChain(f).cast, { recipients: [{ name: "a", address: A(2), ethWei: 1n }, { name: "b", address: A(2), ethWei: 1n }] }))).rejects.toThrow(/duplicate/);
    await expect(planFunding(base(fakeChain(f).cast, { recipients: [{ name: "a", address: A(1), ethWei: 1n }] }))).rejects.toThrow(/funder itself/);
    await expect(planFunding(base(fakeChain({ ...f, code: { [A(2)]: "0x6001" } }).cast))).rejects.toThrow(/contract/);
    await expect(planFunding(base(fakeChain({ balances: { [A(1)]: 10n ** 16n } }).cast))).rejects.toThrow(/short/);
    expect(() => checkEnvCredentialRule({ PRIVATE_KEY: "x" }, "https://mainnet.base.org")).toThrow(RefusedError);
    expect(() => checkEnvCredentialRule({ PRIVATE_KEY: "x" }, "http://127.0.0.1:8545")).not.toThrow();
  });
  test("funder keystore is staged 0700/0600 and shredded", () => {
    const base = mkdtempSync(join(tmpdir(), "fund-ks-"));
    const s = stageFunderKeystore({ CHAIN_FUNDER_KEYSTORE: JSON.stringify({ crypto: {} }), CHAIN_FUNDER_PASSWORD: "p" }, base);
    expect(statSync(s.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(s.dir, "pw")).mode & 0o777).toBe(0o600);
    s.done();
    expect(readdirSync(base)).toEqual([]);
  });
});

describe("sweep and run", () => {
  test("sweep sends leftovers to the funder and survives a per-key failure", async () => {
    const sent: string[][] = [];
    const cast: Cast = async (a) => {
      if (a[0] === "gas-price") return "1000000000";
      if (a[0] === "balance") { if (a[1] === A(9)) throw new Error("boom"); return String(10n ** 17n); }
      if (a[0] === "send") sent.push(a);
      return "{}";
    };
    const rows = await sweep({ rpc: "r", keyDir: "/k", passwordFile: "/p", names: ["X", "Y"], addresses: { X: A(9), Y: A(8) }, funder: A(1), cast });
    expect(rows[0]!.error).toBe("boom");
    expect(rows[1]!.sentWei > 0n).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0]![1]).toBe(A(1));
  });
  test("cleanup runs when the body throws", async () => {
    let ran = 0;
    await expect(withCleanup(async () => { throw new Error("x"); }, async () => { ran++; })).rejects.toThrow("x");
    expect(ran).toBe(1);
  });
  test("a sheet CHAIN_ID that differs from the RPC is refused, and the run still sweeps", async () => {
    expect(() => assertSheetMatchesRpc("export CHAIN_ID=8453\n", 918453)).toThrow(SheetChainMismatch);
    expect(() => assertSheetMatchesRpc("FOO=1\n", 918453)).toThrow(SheetChainMismatch);
    expect(() => assertSheetMatchesRpc("CHAIN_ID=918453\n", 918453)).not.toThrow();
    const s = setup(); const sheet = join(s.d, "sheet.env"); writeFileSync(sheet, "CHAIN_ID=8453\n");
    const c = fakeChain();
    await expect(runRehearsal({ rpc: "http://x", sheetPath: sheet, keyDir: s.dir, passwordFile: s.pwf, names: [], addresses: {}, funder: A(1), cast: c.cast })).rejects.toThrow(/differs/);
  });
  test("run passes the argument set to publish, then sweeps even when publish fails", async () => {
    const s = setup(); const sheet = join(s.d, "sheet.env"); writeFileSync(sheet, "CHAIN_ID=918453\n");
    const c = fakeChain({ balances: { [A(5)]: 10n ** 18n } });
    let got: string[] = [];
    const r = await runRehearsal({ rpc: "http://x", sheetPath: sheet, keyDir: s.dir, passwordFile: s.pwf, names: ["DEPLOYER"], addresses: { DEPLOYER: A(5) }, funder: A(1), cast: c.cast, publish: async (a) => { got = a; return 3; } });
    expect(r.exitCode).toBe(3);
    expect(got).toContain("918453");
    expect(got.join(" ")).not.toContain(PW);
    expect(c.calls.some((x) => x[0] === "send")).toBe(true);
  });
});

describe("rehearse job asserts the verifier label set", () => {
  const frag = "SAFE_OWNERS=0xA,0xB,0xC\nSAFE_THRESHOLD=2\n";
  const line = (label: string, ok: boolean) => JSON.stringify({ event: "verify.check", label, ok });
  const good = [...REQUIRED_SAFE_LABELS, "vault: x"].map((l) => line(l, true)).join("\n");
  test("all ok passes; a failed, missing or absent label fails", () => {
    expect(assertLabels(good, frag)).toEqual([]);
    expect(assertLabels(good + "\n" + line("safe: owners equal sheet", false), frag).join()).toMatch(/label not ok: safe: owners equal sheet/);
    expect(assertLabels(line("vault: x", true), frag).join()).toMatch(/label missing: safe: threshold equals sheet/);
    expect(assertLabels("", frag).join()).toMatch(/did not run/);
    expect(assertLabels(good, "SAFE_OWNERS=0xA\nSAFE_THRESHOLD=2\n").join()).toMatch(/fewer than 3/);
    expect(assertLabels(good, "SAFE_OWNERS=0xA,0xB,0xC\nSAFE_THRESHOLD=3\n").join()).toMatch(/SAFE_THRESHOLD/);
  });
});

describe("no-secret scan of the rehearsal run", () => {
  test("argv: key, password flag, passphrase value and keystore body are all found", () => {
    expect(argvSecretProblems(["--chain", "918453", "--signer", "keystore:/dev/shm/k/DEPLOYER:/dev/shm/pw"], ["hunter2hunter2"])).toEqual([]);
    expect(argvSecretProblems(["--password", "x"]).join()).toMatch(/secret flag/);
    expect(argvSecretProblems(["--signer", "0x" + "11".repeat(32)]).join()).toMatch(/64-hex/);
    expect(argvSecretProblems(["--signer", "keystore:hunter2hunter2"], ["hunter2hunter2"]).join()).toMatch(/secret value/);
    expect(argvSecretProblems(['{"crypto":{}}']).join()).toMatch(/keystore body/);
  });
  test("the recorded spawn argv of a run carries no password or key, and is refused if it would", async () => {
    const s = setup(); const sheet = join(s.d, "sheet.env"); writeFileSync(sheet, "CHAIN_ID=918453\n");
    const c = fakeChain();
    const r = await runRehearsal({ rpc: "http://x", sheetPath: sheet, keyDir: s.dir, passwordFile: s.pwf, names: [], addresses: {}, funder: A(1), cast: c.cast, publish: async () => 0, deploySha: "a".repeat(40) });
    expect(argvSecretProblems(r.argv, [PW])).toEqual([]);
    expect(r.argv).toContain("--core-sha");
    expect(r.argv.join(" ")).not.toContain(PW);
    // a signer path that smuggles the passphrase is refused before anything is spawned
    const leaky = setup(); writeFileSync(leaky.pwf, "pw-in-the-path-0123", { mode: 0o600 });
    const leakyDir = join(leaky.d, "pw-in-the-path-0123");
    await expect(runRehearsal({ rpc: "http://x", sheetPath: sheet, keyDir: leakyDir, passwordFile: leaky.pwf, names: [], addresses: {}, funder: A(1), cast: c.cast, publish: async () => 0 })).rejects.toThrow(/refusing to spawn/);
  });
  test("the sheet fragment file, the keys-fragment output and spawn-args are scanned", () => {
    const { dir, pwf } = setup();
    const k = makeRehearsalKeys({ dir, passwordFile: pwf });
    const ev = mkdtempSync(join(tmpdir(), "rehearsal-ev-"));
    writeFileSync(join(ev, "keys-fragment.env"), sheetFragment(k, TWIN_CHAIN_ID));
    writeFileSync(join(ev, "spawn-args.txt"), ["bun", "src/cli.ts", ...rehearsalArgs(918453, "https://twin.example", { deploySha: "a".repeat(40) })].join("\n") + "\n");
    expect(scanRehearsal(ev, [PW])).toEqual([]);
    // a key in the fragment, a passphrase anywhere, and a secret flag in the spawn args are each found
    writeFileSync(join(ev, "keys-fragment.env"), "ADMIN_ADDRESS=0x" + "22".repeat(32) + "\n");
    expect(scanRehearsal(ev, [PW]).join()).toContain("keys-fragment.env");
    writeFileSync(join(ev, "keys-fragment.env"), `NOTE=${PW}\n`);
    expect(scanRehearsal(ev, [PW]).join()).toContain("secret value");
    writeFileSync(join(ev, "keys-fragment.env"), "CHAIN_ID=918453\n");
    writeFileSync(join(ev, "spawn-args.txt"), "bun\n--password\nx\n");
    expect(scanRehearsal(ev, [PW]).join()).toContain("secret flag");
  }, 120_000);
  test("the real keys fragment and a CLI run's argv hold no key bytes", () => {
    const { dir, pwf } = setup();
    const r = spawnSync("bun", [join(import.meta.dir, "../src/rehearsal/cli.ts"), "keys", "--dir", dir, "--password-file", pwf, "--chain-id", "918453"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const ev = mkdtempSync(join(tmpdir(), "rehearsal-ev-"));
    writeFileSync(join(ev, "keys-fragment.env"), r.stdout);
    expect(scanRehearsal(ev, [PW])).toEqual([]);
  }, 120_000);
});
