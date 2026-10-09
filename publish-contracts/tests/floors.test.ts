// Floors: the persona-owner floor is on by default on 8453, the plaintext refusal on a non-loopback RPC is a CLI behavior,
// and core's stage signer string passes where it should. (devops 65)
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES, PublishError } from "../src/errors.ts";
import { assertFloors, assertOwnerSignerSpec, passphraseFileReason, plaintextKeyReason, plaintextSignerReason } from "../src/floors.ts";
import { loadCorrelatedOwners } from "../src/correlated-owners.ts";
import { callerInputs, parseSheet } from "../src/sheet.ts";
import { sheetText, tmp } from "./fixtures.ts";
import { world } from "./harness.ts";

const GOOD = { TIMELOCK_MIN_DELAY: "172800", GOVERN_NEW_DELAY: "172800" };
const sheetFor = (chain: number, extra: Record<string, string | null> = {}) => parseSheet(sheetText({ CHAIN_ID: String(chain), EXPECTED_CHAIN_ID: String(chain), ...extra }));
const input = (chain: number, o: Record<string, unknown> = {}) =>
  ({ rpcChainId: chain, rpc: "https://mainnet.base.org", sheet: sheetFor(chain, chain === 8453 ? GOOD : {}), caller: callerInputs({}), signerSpec: "keystore:/dev/shm/k/DEPLOYER", env: {}, environment: "mainnet", githubActions: false, correlatedOwners: [], ...o }) as Parameters<typeof assertFloors>[0];
const refusal = (f: () => void): string | undefined => { try { f(); } catch (e) { return (e as PublishError).kind + ": " + (e as Error).message; } return undefined; };

describe("correlated-owners floor on 8453 is on by default", () => {
  test("an unloaded correlated-owners list is refused on 8453, not skipped", () => {
    expect(refusal(() => assertFloors(input(8453, { correlatedOwners: undefined })))).toContain("correlated-owners floor could not run");
  });
  test("an unloaded list is fine off 8453", () => {
    expect(refusal(() => assertFloors(input(918453, { rpc: "https://twin.example", correlatedOwners: undefined })))).toBeUndefined();
  });
  test("two correlated SAFE_OWNERS are refused on 8453, one is allowed", () => {
    const owners = sheetFor(8453, GOOD).safeOwners;
    expect(refusal(() => assertFloors(input(8453, { correlatedOwners: [owners[0]!, owners[1]!] })))).toContain("correlated owners");
    expect(refusal(() => assertFloors(input(8453, { correlatedOwners: [owners[0]!] })))).toBeUndefined();
  });
});

describe("loadCorrelatedOwners reads the file, which is required", () => {
  const A = "0x" + "ab".repeat(20), B = "0x" + "cd".repeat(20);
  test("the --correlated-owners-file argument is read and parsed", () => {
    const f = join(tmp(), "c.txt");
    writeFileSync(f, `ownerA ${A}\nownerB ${B}\n`);
    expect(loadCorrelatedOwners({ file: f, env: {} })).toEqual([A, B]);
  });
  test("CORRELATED_OWNERS_FILE is read when no argument is given, and the argument wins", () => {
    const f = join(tmp(), "e.txt"), g = join(tmp(), "g.txt");
    writeFileSync(f, `x ${A}\n`); writeFileSync(g, `y ${B}\n`);
    expect(loadCorrelatedOwners({ env: { CORRELATED_OWNERS_FILE: f } })).toEqual([A]);
    expect(loadCorrelatedOwners({ file: g, env: { CORRELATED_OWNERS_FILE: f } })).toEqual([B]);
  });
  test("no file named is refused, a missing file is refused", () => {
    expect(() => loadCorrelatedOwners({ env: {} })).toThrow("--correlated-owners-file");
    expect(() => loadCorrelatedOwners({ file: "/nope/p", env: {} })).toThrow("does not exist");
  });
});

describe("plaintext refusal on a non-loopback RPC (any chain)", () => {
  const forms = ["--private-key 0x01", "plaintext:KEY", "0x" + "11".repeat(32)];
  test("every plaintext form is refused on a non-loopback RPC, on 8453 and on Twin", () => {
    for (const chain of [8453, 918453]) for (const signerSpec of forms) {
      const r = refusal(() => assertFloors(input(chain, { rpc: "https://rpc.example", signerSpec })));
      expect(r).toContain("FLOOR");
      expect(r).toContain("non-loopback RPC");
    }
    expect(refusal(() => assertFloors(input(918453, { rpc: "https://rpc.example", env: { PRIVATE_KEY: "x" } })))).toContain("PRIVATE_KEY");
  });
  test("a loopback RPC allows them off 8453", () => {
    for (const rpc of ["http://127.0.0.1:8545", "http://localhost:8545", "http://[::1]:8545"]) expect(refusal(() => assertFloors(input(918453, { rpc, signerSpec: "plaintext:KEY" })))).toBeUndefined();
  });
  test("8453 refuses plaintext even on a loopback RPC", () => {
    expect(refusal(() => assertFloors(input(8453, { rpc: "http://127.0.0.1:8545", signerSpec: "plaintext:KEY" })))).toContain("plaintext");
  });
  test("a hostname that merely contains localhost is not loopback", () => {
    expect(refusal(() => assertFloors(input(918453, { rpc: "http://localhost.evil.example:8545", signerSpec: "plaintext:KEY" })))).toContain("non-loopback");
  });
  test("core's stage signer keystore:<path>:<passfile> passes on Twin (non-loopback) and is refused on 8453", () => {
    const spec = "keystore:/dev/shm/k/DEPLOYER:/dev/shm/k/pw";
    expect(plaintextKeyReason(spec)).toBeUndefined();
    expect(passphraseFileReason(spec)).toContain("passphrase");
    expect(plaintextSignerReason(spec)).toContain("passphrase");
    expect(refusal(() => assertFloors(input(918453, { rpc: "https://twin.example", signerSpec: spec })))).toBeUndefined();
    expect(refusal(() => assertFloors(input(8453, { signerSpec: spec })))).toContain("plaintext signing is refused on chain 8453");
  });
});

describe("plaintext refusal through the CLI (main)", () => {
  const quiet = async (f: () => Promise<number>) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
  test("a plaintext signer on a non-loopback RPC exits with the FLOOR code and a named error, before any signer or forge call", async () => {
    const w = world({ chainId: 918453 });
    let signerMade = false;
    const code = await quiet(() => w.run([], { signer: "plaintext:KEY", makeSigner: () => { signerMade = true; throw new Error("no signer"); } }));
    expect(code).toBe(EXIT_CODES.FLOOR);
    expect(signerMade).toBe(false);
    expect(w.state().calls.filter((c: { tool: string }) => c.tool === "forge").length).toBe(0);
    expect(w.logs().some((l) => String(l.message).includes("non-loopback RPC"))).toBe(true);
  });
  test("--private-key as the signer is refused (non-zero) and PRIVATE_KEY in the environment is refused by the floor", async () => {
    expect(await quiet(() => world({ chainId: 918453 }).run([], { signer: "--private-key 0x01" }))).not.toBe(0);
    expect(await quiet(() => world({ chainId: 918453 }).run([], { env: { PRIVATE_KEY: "x" } }))).toBe(EXIT_CODES.FLOOR);
  });
  test("an encrypted keystore with a passphrase file on a non-loopback Twin RPC is not refused by the floors", async () => {
    const w = world({ chainId: 918453 });
    const code = await quiet(() => w.run(["--stage", "plan"], { signer: "keystore:/dev/shm/k/DEPLOYER:/dev/shm/k/pw" }));
    expect(code).toBe(0);
  });
  test("on 8453 the correlated owners come from the seam and two correlated owners exit with the FLOOR code", async () => {
    const w = world({ chainId: 8453 });
    const owners = parseSheet(readFileSync(w.sheetPath, "utf8")).safeOwners;
    const code = await quiet(() => w.run(["--stage", "plan", "--environment", "base-mainnet"], { correlatedOwners: async () => [owners[0]!, owners[1]!] }));
    expect(code).toBe(EXIT_CODES.FLOOR);
    expect(existsSync(w.sheetPath)).toBe(true);
  });
  test("on 8453 with no correlated-owners file the run exits with the FLOOR code", async () => {
    const w = world({ chainId: 8453 });
    delete process.env.CORRELATED_OWNERS_FILE;
    const code = await quiet(() => w.run(["--stage", "plan", "--environment", "base-mainnet"], { correlatedOwners: undefined }));
    expect(code).toBe(EXIT_CODES.FLOOR);
  });
  test("on 8453 the --correlated-owners-file is read: two listed SAFE_OWNERS are refused, one is not a floor refusal", async () => {
    const w = world({ chainId: 8453 });
    const owners = parseSheet(readFileSync(w.sheetPath, "utf8")).safeOwners;
    const two = join(tmp(), "two.txt"), one = join(tmp(), "one.txt");
    writeFileSync(two, `${owners[0]}\n${owners[1]}\n`); writeFileSync(one, `${owners[0]}\n`);
    expect(await quiet(() => w.run(["--stage", "plan", "--environment", "base-mainnet", "--correlated-owners-file", two], { correlatedOwners: undefined }))).toBe(EXIT_CODES.FLOOR);
    expect(await quiet(() => w.run(["--stage", "plan", "--environment", "base-mainnet", "--correlated-owners-file", one], { correlatedOwners: undefined }))).not.toBe(EXIT_CODES.FLOOR);
  });
});

describe("Safe owner signers must be hardware on 8453 (core 1668)", () => {
  const owner = (spec: string, chain = 8453, rpc = "https://mainnet.base.org") => refusal(() => assertOwnerSignerSpec(spec, { rpcChainId: chain, rpc, env: {} }));
  test("a software keystore, with or without a passphrase file, and env:signer are refused with OWNER_SIGNER_NOT_HARDWARE", () => {
    for (const spec of ["keystore:/k/OWNER", "keystore:/k/OWNER:/k/pw", "env:signer"]) {
      expect(() => assertOwnerSignerSpec(spec, { rpcChainId: 8453, rpc: "https://mainnet.base.org", env: {} })).toThrow(expect.objectContaining({ kind: "OWNER_SIGNER_NOT_HARDWARE" }));
    }
  });
  test("ledger and trezor are accepted on 8453", () => {
    expect(owner("ledger")).toBeUndefined();
    expect(owner("trezor")).toBeUndefined();
  });
  test("a plaintext owner spec is refused on both chains", () => {
    expect(owner("plaintext:KEY", 918453, "https://twin.example")).toContain("plaintext");
    expect(owner("plaintext:KEY")).toContain("OWNER_SIGNER_NOT_HARDWARE");
  });
  test("software owners stay allowed on the Twin chain", () => {
    for (const spec of ["keystore:/k/OWNER", "keystore:/k/OWNER:/k/pw", "env:signer", "ledger"]) expect(owner(spec, 918453, "https://twin.example")).toBeUndefined();
  });
  test("through main(): a keystore owner on 8453 exits OWNER_SIGNER_NOT_HARDWARE before a signer is built", async () => {
    let signerMade = false;
    const l = console.log; console.log = () => {};
    try {
      const code = await world({ chainId: 8453 }).run(["govern", "--environment", "base-mainnet", "--owner-signer", "keystore:/k/OWNER"], { makeSigner: () => { signerMade = true; throw new Error("no signer"); } });
      expect(code).toBe(EXIT_CODES.OWNER_SIGNER_NOT_HARDWARE);
    } finally { console.log = l; }
    expect(signerMade).toBe(false);
  });
});
