// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.3 (Key).
// Decrypts a Web3 Secret Storage v3 keystore (scrypt or pbkdf2, aes-128-ctr, keccak mac), the format cast and geth write.
// The password comes from a file of mode 0600 (no group or world bits), KEEPER_PASSWORD (cleared once read), or stdin.
// It is never read from an argument and never appears in an error message.
import { createDecipheriv, pbkdf2Sync, scryptSync } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import { ConfigError } from "./config.ts";

const hex = (s: string) => Buffer.from(s.replace(/^0x/, ""), "hex");

/** Returns the 32-byte private key. Throws ConfigError (no secret in the text) on a wrong password or a bad file. */
export function decryptKeystore(json: string, password: string): Uint8Array {
  let c: any;
  try {
    const parsed = JSON.parse(json);
    c = parsed.crypto ?? parsed.Crypto;
    if (!c) throw 0;
  } catch {
    throw new ConfigError("keystore: not a v3 JSON keystore");
  }
  if (c.cipher !== "aes-128-ctr") throw new ConfigError(`keystore: cipher ${c.cipher} not supported`);
  const p = c.kdfparams;
  let dk: Buffer;
  if (c.kdf === "scrypt") {
    dk = scryptSync(password, hex(p.salt), p.dklen, { N: p.n, r: p.r, p: p.p, maxmem: 1024 * 1024 * 1024 });
  } else if (c.kdf === "pbkdf2") {
    if (p.prf !== "hmac-sha256") throw new ConfigError(`keystore: pbkdf2 prf ${p.prf} not supported`);
    dk = pbkdf2Sync(password, hex(p.salt), p.c, p.dklen, "sha256");
  } else {
    throw new ConfigError(`keystore: kdf ${c.kdf} not supported`);
  }
  const ct = hex(c.ciphertext);
  if (bytesToHex(keccak_256(Buffer.concat([dk.subarray(16, 32), ct]))) !== String(c.mac).replace(/^0x/, "").toLowerCase()) {
    throw new ConfigError("keystore: wrong password (mac mismatch)");
  }
  const d = createDecipheriv("aes-128-ctr", dk.subarray(0, 16), hex(c.cipherparams.iv));
  const key = new Uint8Array(Buffer.concat([d.update(ct), d.final()]));
  dk.fill(0);
  if (key.length !== 32) throw new ConfigError("keystore: decrypted key is not 32 bytes");
  return key;
}

/** Reads a password file. Refuses a file any group or other user can read or write. One trailing newline is dropped. */
export function readPasswordFile(path: string): string {
  let mode: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new ConfigError(`password file ${path} is not a regular file`);
    mode = st.mode & 0o777;
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`password file ${path} cannot be read`);
  }
  if (mode & 0o077) throw new ConfigError(`password file ${path} has mode ${mode.toString(8)}; it must be 0600 or stricter`);
  return readFileSync(path, "utf8").replace(/\r?\n$/, "");
}

export interface PasswordSource {
  passwordFile?: string;
  env: Record<string, string | undefined>;
  stdin: () => Promise<string>;
}

/** The password from the file, else KEEPER_PASSWORD (deleted from env once read), else stdin. */
export async function readPassword(src: PasswordSource): Promise<string> {
  if (src.passwordFile) return readPasswordFile(src.passwordFile);
  const fromEnv = src.env.KEEPER_PASSWORD;
  delete src.env.KEEPER_PASSWORD;
  if (fromEnv) return fromEnv;
  const s = (await src.stdin()).replace(/\r?\n$/, "");
  if (!s) throw new ConfigError("no keystore password: set passwordFile, KEEPER_PASSWORD, or pipe it on stdin");
  return s;
}

/** Reads all of stdin; empty when stdin is a terminal (the service never prompts). */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return await Bun.stdin.text();
}
