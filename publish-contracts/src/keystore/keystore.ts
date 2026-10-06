// Foundry-compatible encrypted keystore (Web3 Secret Storage v3: scrypt + aes-128-ctr + keccak mac), written here so a
// generated key's password never appears on any command line. The private key exists in this process's memory only.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

const N = 262144, R = 8, P = 1, DKLEN = 32;

export function checksumAddress(raw20: Uint8Array): string {
  const lower = bytesToHex(raw20);
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return out;
}

export function addressOf(privateKey: Uint8Array): string {
  const pub = secp256k1.getPublicKey(privateKey, false).slice(1); // drop the 0x04 prefix
  return checksumAddress(keccak_256(pub).slice(12));
}

export interface GeneratedKey { address: string; keystoreJson: string }

/** Encrypts `privateKey` under `password`. */
export function encryptKeystore(privateKey: Uint8Array, password: string): GeneratedKey {
  const salt = randomBytes(32), iv = randomBytes(16);
  const dk = scryptSync(password, salt, DKLEN, { N, r: R, p: P, maxmem: 512 * 1024 * 1024 });
  const cipher = createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()]);
  const mac = keccak_256(Buffer.concat([dk.subarray(16, 32), ciphertext]));
  const address = addressOf(privateKey);
  const json = {
    address: address.slice(2).toLowerCase(),
    crypto: {
      cipher: "aes-128-ctr", cipherparams: { iv: iv.toString("hex") }, ciphertext: ciphertext.toString("hex"),
      kdf: "scrypt", kdfparams: { dklen: DKLEN, n: N, p: P, r: R, salt: salt.toString("hex") }, mac: bytesToHex(mac),
    },
    id: randomUUID(), version: 3,
  };
  return { address, keystoreJson: JSON.stringify(json) };
}

/** Decrypts a keystore (used by tests and `list --verify`). Throws on a wrong password. */
export function decryptKeystore(keystoreJson: string, password: string): Uint8Array {
  const c = (JSON.parse(keystoreJson) as { crypto: any }).crypto;
  const dk = scryptSync(password, hexToBytes(c.kdfparams.salt), c.kdfparams.dklen, { N: c.kdfparams.n, r: c.kdfparams.r, p: c.kdfparams.p, maxmem: 512 * 1024 * 1024 });
  const ct = Buffer.from(c.ciphertext, "hex");
  if (bytesToHex(keccak_256(Buffer.concat([dk.subarray(16, 32), ct]))) !== c.mac) throw new Error("wrong keystore password");
  const d = createDecipheriv("aes-128-ctr", dk.subarray(0, 16), Buffer.from(c.cipherparams.iv, "hex"));
  return new Uint8Array(Buffer.concat([d.update(ct), d.final()]));
}

/** A fresh random key and a fresh random password, returned as an encrypted keystore. */
export function generateKey(): GeneratedKey & { password: string } {
  const password = randomBytes(32).toString("base64url");
  const privateKey = secp256k1.utils.randomPrivateKey();
  try { return { ...encryptKeystore(privateKey, password), password }; } finally { privateKey.fill(0); }
}
