// Throwaway Foundry keystores (Web3 Secret Storage v3), many keys under one password read from a FILE (never an argument).
// For rehearsals on chain 918453 only. The keys live in the directory the caller gives and are shredded by the caller.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1";
import { encryptKeystore } from "./keystore.ts";

export function keygen(dir: string, passwordFile: string, names: string[]): Record<string, string> {
  const password = readFileSync(passwordFile, "utf8").replace(/\r?\n$/, ""); // one trailing newline is not part of the passphrase (cast strips it too)
  if (password.length < 16) throw new Error("the password file must hold at least 16 characters");
  if (!names.length) throw new Error("give at least one key name");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out: Record<string, string> = {};
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`bad key name '${name}'`);
    const path = join(dir, name);
    if (existsSync(path)) throw new Error(`${path} already exists`);
    const pk = secp256k1.utils.randomPrivateKey();
    try {
      const k = encryptKeystore(pk, password);
      writeFileSync(path, k.keystoreJson, { mode: 0o600 });
      chmodSync(path, 0o600);
      out[name] = k.address;
    } finally { pk.fill(0); }
  }
  return out;
}
