// Test-only keystores. Keys are random per run and the password is a fixture string: no real key material is committed.
import { createCipheriv, pbkdf2Sync, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import { privateKeyToAccount } from "viem/accounts";

/** Random per test process, so no password literal is committed (gitleaks generic-api-key). */
export const FIXTURE_PASSWORD = `fixture-${randomBytes(12).toString("hex")}`;

export function encryptFixture(pk: Uint8Array, password: string, kdf: "scrypt" | "pbkdf2"): string {
  const salt = randomBytes(32), iv = randomBytes(16);
  const dk = kdf === "scrypt"
    ? scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 })
    : pbkdf2Sync(password, salt, 1024, 32, "sha256");
  const c = createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
  const ct = Buffer.concat([c.update(pk), c.final()]);
  const kdfparams = kdf === "scrypt"
    ? { dklen: 32, n: 1024, r: 8, p: 1, salt: salt.toString("hex") }
    : { dklen: 32, c: 1024, prf: "hmac-sha256", salt: salt.toString("hex") };
  return JSON.stringify({
    address: privateKeyToAccount(`0x${Buffer.from(pk).toString("hex")}`).address.slice(2).toLowerCase(),
    crypto: { cipher: "aes-128-ctr", cipherparams: { iv: iv.toString("hex") }, ciphertext: ct.toString("hex"), kdf, kdfparams, mac: bytesToHex(keccak_256(Buffer.concat([dk.subarray(16, 32), ct]))) },
    id: randomUUID(), version: 3,
  });
}

export const tmp = (prefix = "keeper-test-") => mkdtempSync(join(tmpdir(), prefix));

/** A fresh random key written as a keystore plus a 0600 password file. */
export function fixtureKeystore(dir: string, kdf: "scrypt" | "pbkdf2" = "scrypt") {
  const pk = new Uint8Array(randomBytes(32));
  const keystore = join(dir, `ks-${kdf}.json`);
  writeFileSync(keystore, encryptFixture(pk, FIXTURE_PASSWORD, kdf), { mode: 0o600 });
  const passwordFile = join(dir, "pw");
  writeFileSync(passwordFile, FIXTURE_PASSWORD + "\n", { mode: 0o600 });
  return { pk, keystore, passwordFile, address: privateKeyToAccount(`0x${Buffer.from(pk).toString("hex")}`).address };
}
