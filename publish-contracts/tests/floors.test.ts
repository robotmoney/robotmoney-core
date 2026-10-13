// Floors: the plaintext refusal on a non-loopback RPC is a CLI behavior,
// and core's stage signer string passes where it should. (devops 65)
import { describe, expect, test } from "bun:test";
import { EXIT_CODES, PublishError } from "../src/errors.ts";
import { assertFloors, passphraseFileReason, plaintextKeyReason, plaintextSignerReason } from "../src/floors.ts";
import { callerInputs, parseSheet } from "../src/sheet.ts";
import { sheetText } from "./fixtures.ts";
import { world } from "./harness.ts";

const GOOD = { TIMELOCK_MIN_DELAY: "172800", GOVERN_NEW_DELAY: "172800" };
const sheetFor = (chain: number, extra: Record<string, string | null> = {}) => parseSheet(sheetText({ CHAIN_ID: String(chain), EXPECTED_CHAIN_ID: String(chain), ...extra }));
const input = (chain: number, o: Record<string, unknown> = {}) =>
  ({ rpcChainId: chain, rpc: "https://mainnet.base.org", sheet: sheetFor(chain, chain === 8453 ? GOOD : {}), caller: callerInputs({}), signerSpec: "keystore:/dev/shm/k/DEPLOYER", env: {}, environment: "mainnet", githubActions: false, ...o }) as Parameters<typeof assertFloors>[0];
const refusal = (f: () => void): string | undefined => { try { f(); } catch (e) { return (e as PublishError).kind + ": " + (e as Error).message; } return undefined; };

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
});
