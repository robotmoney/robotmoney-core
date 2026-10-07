/**
 * Helpers for the Safe -> Timelock e2e (core 1544).
 *
 * The harness mints three encrypted rehearsal keystores for the Safe owners
 * (SAFE_OWNER_A, SAFE_OWNER_B, SAFE_OWNER_C) under `key_dir`, all opened by the
 * passphrase file `password_file`. This module decrypts them in the Node test
 * process so a browser context can be given an owner wallet, and drives the
 * publish-contracts Safe tool (`publish-contracts/src/safe/cli.ts`) as a
 * subprocess for the hand-off steps. No key is ever written to disk or logged.
 */
import { spawnSync } from "node:child_process";
import { createDecipheriv, scryptSync, pbkdf2Sync } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DevnetEndpoints } from "./devnet";

export interface OwnerKey {
  name: "SAFE_OWNER_A" | "SAFE_OWNER_B" | "SAFE_OWNER_C";
  address: Address;
  privateKey: Hex;
  /** `keystore:PATH:PASSFILE`, the publish-contracts signer spec for this owner. */
  signerSpec: string;
}

interface KeystoreCrypto {
  kdf: string;
  kdfparams: {
    salt: string;
    dklen: number;
    n?: number;
    r?: number;
    p?: number;
    c?: number;
    prf?: string;
  };
  ciphertext: string;
  cipherparams: { iv: string };
  mac: string;
}

/** Decrypt an Ethereum V3 keystore (scrypt or pbkdf2, aes-128-ctr). Throws on a wrong passphrase. */
function decryptKeystore(json: string, password: string): Hex {
  const parsed = JSON.parse(json) as { crypto?: KeystoreCrypto; Crypto?: KeystoreCrypto };
  const c = parsed.crypto ?? parsed.Crypto;
  if (!c) throw new Error("keystore has no crypto section");
  const salt = Buffer.from(c.kdfparams.salt, "hex");
  let dk: Buffer;
  if (c.kdf === "scrypt") {
    dk = scryptSync(password, salt, c.kdfparams.dklen, {
      N: c.kdfparams.n,
      r: c.kdfparams.r,
      p: c.kdfparams.p,
      maxmem: 1024 * 1024 * 1024,
    });
  } else if (c.kdf === "pbkdf2") {
    dk = pbkdf2Sync(
      password,
      salt,
      c.kdfparams.c ?? 1,
      c.kdfparams.dklen,
      (c.kdfparams.prf ?? "hmac-sha256").replace("hmac-", ""),
    );
  } else {
    throw new Error(`unsupported keystore kdf ${c.kdf}`);
  }
  const ct = Buffer.from(c.ciphertext, "hex");
  const mac = keccak256(Buffer.concat([dk.subarray(16, 32), ct]) as unknown as Uint8Array).slice(2);
  if (mac !== c.mac.toLowerCase()) throw new Error("the passphrase does not open the keystore");
  const d = createDecipheriv(
    "aes-128-ctr",
    dk.subarray(0, 16),
    Buffer.from(c.cipherparams.iv, "hex"),
  );
  return `0x${Buffer.concat([d.update(ct), d.final()]).toString("hex")}` as Hex;
}

/** The three Safe owners' wallets, from the harness keystores. */
export function loadOwnerKeys(endpoints: DevnetEndpoints): OwnerKey[] {
  const password = fs.readFileSync(endpoints.password_file, "utf8").trim();
  return (["SAFE_OWNER_A", "SAFE_OWNER_B", "SAFE_OWNER_C"] as const).map((name) => {
    const file = path.join(endpoints.key_dir, name);
    const privateKey = decryptKeystore(fs.readFileSync(file, "utf8"), password);
    return {
      name,
      address: privateKeyToAccount(privateKey).address,
      privateKey,
      signerSpec: `keystore:${file}:${endpoints.password_file}`,
    };
  });
}

/** Repo root: the directory that holds publish-contracts/src/safe/cli.ts. */
function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(dir, "publish-contracts", "src", "safe", "cli.ts"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(
    "safeGovernance: publish-contracts/src/safe/cli.ts not found above the e2e helpers",
  );
}

/**
 * Run the publish-contracts Safe tool (`bun publish-contracts/src/safe/cli.ts <subcommand> ...`).
 * A non-zero exit throws with the tool's stderr, so a failed hand-off fails the spec loudly.
 */
export function runSafeCli(
  endpoints: DevnetEndpoints,
  subcommand: string,
  flags: string[],
): string {
  const root = repoRoot();
  const res = spawnSync(
    "bun",
    [
      path.join(root, "publish-contracts", "src", "safe", "cli.ts"),
      subcommand,
      "--rpc",
      endpoints.rpc_url,
      "--chain-id",
      String(endpoints.chain_id),
      ...flags,
    ],
    { cwd: root, encoding: "utf8", env: process.env, timeout: 240_000 },
  );
  if (res.status !== 0) {
    throw new Error(
      `safe-cli ${subcommand} exited ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
  return res.stdout;
}

/** Advance the Twin chain clock past a timelock delay (anvil), then mine a block. */
export async function warpChain(rpcUrl: string, seconds: number): Promise<void> {
  for (const [method, params] of [
    ["evm_increaseTime", [seconds]],
    ["evm_mine", []],
  ] as const) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = (await res.json()) as { error?: { message: string } };
    if (j.error) throw new Error(`${method} failed: ${j.error.message}`);
  }
}
