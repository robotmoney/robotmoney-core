import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublishError } from "../src/errors.ts";
import { makeSigner } from "../src/signer.ts";
import { tmp } from "./fixtures.ts";

const KS = JSON.stringify({ address: "00000000000000000000000000000000000a11ce", crypto: { cipher: "aes-128-ctr" }, version: 3 });

describe("signer specs", () => {
  test("keystore:PATH gives forge flags with the keystore address as sender and no passphrase value", async () => {
    const dir = tmp();
    const p = join(dir, "DEPLOYER");
    writeFileSync(p, KS);
    const s = makeSigner(`keystore:${p}`);
    expect(await s.forgeArgs()).toEqual(["--keystore", p, "--sender", "0x00000000000000000000000000000000000A11cE"]);
  });
  test("a missing keystore, a bad spec and a key-shaped spec are refused", () => {
    expect(() => makeSigner("keystore:/nope/x")).toThrow(PublishError);
    expect(() => makeSigner("0x" + "11".repeat(32))).toThrow(PublishError);
    expect(() => makeSigner("plaintext:KEY")).toThrow("unknown signer spec");
  });
  test("ledger and trezor pass --ledger or --trezor with a sender read through cast", async () => {
    const runner = async (args: string[]) => ({ code: 0, stdout: "0x00000000000000000000000000000000000a11ce", stderr: "" , args });
    const s = makeSigner("ledger", { runner: runner as never });
    expect((await s.forgeArgs()).slice(0, 2)).toEqual(["--ledger", "--sender"]);
  });
  test("env:signer writes the engine's encrypted keystore to a 0700 memory directory, 0600 files, shredded on cleanup, and clears the env", async () => {
    const env: Record<string, string | undefined> = { CHAIN_SIGNER_KEYSTORE: KS, CHAIN_SIGNER_PASSWORD: "engine-given-pass" };
    const s = makeSigner("env:signer", { env });
    expect(env.CHAIN_SIGNER_KEYSTORE).toBeUndefined();
    expect(env.CHAIN_SIGNER_PASSWORD).toBeUndefined();
    const args = await s.forgeArgs();
    const ks = args[args.indexOf("--keystore") + 1]!;
    const pw = args[args.indexOf("--password-file") + 1]!;
    expect(statSync(ks).mode & 0o777).toBe(0o600);
    expect(statSync(pw).mode & 0o777).toBe(0o600);
    expect(statSync(join(ks, "..")).mode & 0o777).toBe(0o700);
    expect(readFileSync(ks, "utf8")).toBe(KS);
    expect(args.join(" ")).not.toContain("engine-given-pass");
    s.cleanup();
    expect(existsSync(ks)).toBe(false);
    expect(existsSync(pw)).toBe(false);
  });
  test("env:signer without the engine fails with a pointer to the credential engine", () => {
    expect(() => makeSigner("env:signer", { env: {} })).toThrow("CHAIN_SIGNER_KEYSTORE");
  });
});

describe("signer specs: core's stage string and clear errors", () => {
  const msg = (f: () => unknown): string => { try { f(); } catch (e) { return `${(e as PublishError).kind}: ${(e as Error).message}`; } return ""; };
  test("keystore:<path>:<passfile> (core's exact stage signer) gives --keystore, --password-file and --sender, never a password value", async () => {
    const dir = tmp();
    const p = join(dir, "DEPLOYER"), pw = join(dir, "pw");
    writeFileSync(p, KS);
    writeFileSync(pw, "do-not-echo-me");
    const s = makeSigner(`keystore:${p}:${pw}`);
    expect(s.kind).toBe("keystore");
    const args = await s.forgeArgs();
    expect(args).toEqual(["--keystore", p, "--password-file", pw, "--sender", "0x00000000000000000000000000000000000A11cE"]);
    expect(args.join(" ")).not.toContain("do-not-echo-me");
  });
  test("a missing passphrase file, an empty one and extra fields are refused with a named error", () => {
    const dir = tmp();
    const p = join(dir, "DEPLOYER");
    writeFileSync(p, KS);
    expect(msg(() => makeSigner(`keystore:${p}:/nope/pw`))).toContain("passphrase file not found");
    expect(msg(() => makeSigner(`keystore:${p}:`))).toContain("no passphrase file");
    expect(msg(() => makeSigner(`keystore:${p}:/a:/b`))).toContain("too many fields");
    expect(msg(() => makeSigner("keystore:"))).toContain("no keystore path");
    expect(msg(() => makeSigner(`keystore:${dir}`))).toContain("not a file");
  });
  test("a bad keystore body is refused", () => {
    const p = join(tmp(), "K");
    writeFileSync(p, "not json");
    expect(msg(() => makeSigner(`keystore:${p}`))).toContain("not JSON");
  });
  test("env:other, an empty spec and a raw key are refused and never echoed", () => {
    expect(msg(() => makeSigner("env:other"))).toContain("only one is env:signer");
    expect(msg(() => makeSigner(""))).toContain("no signer given");
    const key = "0x" + "11".repeat(32);
    const m = msg(() => makeSigner(key));
    expect(m).toContain("SIGNER");
    expect(m).not.toContain("1111");
  });
  test("ledger and trezor give their flags", async () => {
    const runner = async (args: string[]) => ({ code: 0, stdout: "0x00000000000000000000000000000000000a11ce", stderr: "", args });
    expect((await makeSigner("trezor", { runner: runner as never }).forgeArgs()).slice(0, 2)).toEqual(["--trezor", "--sender"]);
  });
});
