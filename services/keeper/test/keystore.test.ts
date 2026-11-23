// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.3 (Key).
import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { ConfigError } from "../src/config.ts";
import { decryptKeystore, readPassword, readPasswordFile } from "../src/keystore.ts";
import { FIXTURE_PASSWORD, fixtureKeystore, tmp } from "./helpers/fixtures.ts";

const addr = (pk: Uint8Array) => privateKeyToAccount(`0x${Buffer.from(pk).toString("hex")}`).address;

describe("keystore", () => {
  for (const kdf of ["scrypt", "pbkdf2"] as const) {
    test(`a fixture ${kdf} keystore decrypts to its key`, () => {
      const ks = fixtureKeystore(tmp(), kdf);
      const pk = decryptKeystore(readFileSync(ks.keystore, "utf8"), FIXTURE_PASSWORD);
      expect(addr(pk)).toBe(ks.address);
    });
  }

  test("a wrong password is refused, and the error does not echo it", () => {
    const ks = fixtureKeystore(tmp());
    let err: unknown;
    try { decryptKeystore(readFileSync(ks.keystore, "utf8"), "wrong-password-abc123"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ConfigError);
    expect(String((err as Error).message)).not.toContain("wrong-password-abc123");
  });

  test("a 0600 password file is read without its trailing newline", () => {
    const ks = fixtureKeystore(tmp());
    expect(readPasswordFile(ks.passwordFile)).toBe(FIXTURE_PASSWORD);
    chmodSync(ks.passwordFile, 0o400);
    expect(readPasswordFile(ks.passwordFile)).toBe(FIXTURE_PASSWORD);
  });

  test.each([[0o640, "group-readable"], [0o604, "world-readable"], [0o660, "group-writable"]])(
    "a %o (%s) password file is refused", (mode) => {
      const p = join(tmp(), "pw");
      writeFileSync(p, FIXTURE_PASSWORD);
      chmodSync(p, mode);
      expect(() => readPasswordFile(p)).toThrow(ConfigError);
      try { readPasswordFile(p); } catch (e) { expect((e as Error).message).not.toContain(FIXTURE_PASSWORD); }
    });

  test("KEEPER_PASSWORD is used when no file is set, and is cleared from the environment once read", async () => {
    const env: Record<string, string | undefined> = { KEEPER_PASSWORD: FIXTURE_PASSWORD };
    expect(await readPassword({ env, stdin: async () => "" })).toBe(FIXTURE_PASSWORD);
    expect("KEEPER_PASSWORD" in env).toBe(false);
  });

  test("stdin is used last; nothing anywhere is an error", async () => {
    expect(await readPassword({ env: {}, stdin: async () => FIXTURE_PASSWORD + "\n" })).toBe(FIXTURE_PASSWORD);
    expect(readPassword({ env: {}, stdin: async () => "" })).rejects.toBeInstanceOf(ConfigError);
  });
});
