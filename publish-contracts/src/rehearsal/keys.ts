/**
 * Ephemeral key helper (S7). Wraps src/keystore/keygen.ts: throwaway ENCRYPTED Foundry keystores in a 0700 directory
 * under one password. The password comes from a 0600 file or a hidden prompt, never from an argument or the environment.
 * Prints a sheet fragment of addresses and numbers only. No private key or password is ever returned or printed.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { keygen } from "../keystore/keygen.ts";

export const MIN_PASSWORD_CHARS = 16;
export const DEFAULT_VOTERS = 2;
export const SAFE_OWNER_COUNT = 3;
export const SAFE_THRESHOLD = 2;
export const KEY_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Key names for one rehearsal: deployer, pauser, emergency, agent, voters and three Safe owners. */
export function defaultKeyNames(voters = DEFAULT_VOTERS): string[] {
  const names = ["DEPLOYER", "PAUSER", "EMERGENCY", "AGENT"];
  for (let i = 1; i <= voters; i++) names.push(`VOTER${i}`);
  names.push("SAFE_OWNER_A", "SAFE_OWNER_B", "SAFE_OWNER_C");
  return names;
}

/** Reads the password from a file that only its owner can read. Refuses a short one. */
export function readPasswordFile(path: string): string {
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`${path} is not a file`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${path} must be mode 0600 (it is ${(st.mode & 0o777).toString(8)})`);
  const pw = readFileSync(path, "utf8").replace(/\r?\n$/, "");
  assertPassword(pw);
  return pw;
}

export function assertPassword(pw: string): void {
  if (pw.length < MIN_PASSWORD_CHARS) throw new Error(`the passphrase must hold at least ${MIN_PASSWORD_CHARS} characters`);
}

export interface MakeKeysOptions {
  dir: string;
  passwordFile: string;
  names?: string[];
  voters?: number;
}
export interface RehearsalKeys { dir: string; addresses: Record<string, string>; names: string[] }

/** Validates everything before it writes anything, so a refusal leaves no half-made key set. */
export function makeRehearsalKeys(o: MakeKeysOptions): RehearsalKeys {
  const names = o.names ?? defaultKeyNames(o.voters);
  if (!names.length) throw new Error("give at least one key name");
  const seen = new Set<string>();
  for (const n of names) {
    if (!KEY_NAME_RE.test(n)) throw new Error(`bad key name '${n}'`);
    if (seen.has(n)) throw new Error(`duplicate key name '${n}'`);
    seen.add(n);
    if (existsSync(join(o.dir, n))) throw new Error(`${join(o.dir, n)} already exists`);
  }
  readPasswordFile(o.passwordFile); // fails on a loose mode or a short passphrase before any key exists
  if (existsSync(o.dir)) {
    if (lstatSync(o.dir).isSymbolicLink()) throw new Error(`${o.dir} is a symlink`);
  } else mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  chmodSync(o.dir, 0o700);
  const addresses = keygen(o.dir, o.passwordFile, names);
  return { dir: o.dir, addresses, names };
}

/**
 * Sheet fragment: addresses and numbers only. Names follow the frozen sheet role vocabulary; the operator pastes it
 * into the rehearsal sheet. Safe owner order is the order of the keystores.
 */
/** The registered name of the rmUSDC vault in the registry (a label, not a secret). */
export const REHEARSAL_VAULT_NAME = "Robot Money USDC";

export function sheetFragment(k: RehearsalKeys, chainId?: number): string {
  const a = k.addresses;
  const get = (n: string) => { const v = a[n]; if (!v) throw new Error(`no key named ${n}`); return v; };
  const voters = k.names.filter((n) => /^VOTER\d+$/.test(n)).map(get);
  const owners = ["SAFE_OWNER_A", "SAFE_OWNER_B", "SAFE_OWNER_C"].map(get);
  const lines = [
    ...(chainId === undefined ? [] : [`CHAIN_ID=${chainId}`]),
    `ADMIN_ADDRESS=${get("DEPLOYER")}`,
    `RECEIPT_ADMIN_ADDRESS=${get("DEPLOYER")}`, // the sheet requires it to equal ADMIN_ADDRESS (the deployer revokes the receipt roles in the timelock stage)
    `PAUSER_ADDRESS=${get("PAUSER")}`,
    `EMERGENCY_ADDRESS=${get("EMERGENCY")}`,
    `AGENT_ADDRESS=${get("AGENT")}`,
    `VOTER_ADDRESSES=${voters.join(",")}`,
    `SAFE_OWNERS=${owners.join(",")}`,
    `SAFE_THRESHOLD=${SAFE_THRESHOLD}`,
    `VAULT_NAME=${REHEARSAL_VAULT_NAME}`,
  ];
  return lines.join("\n") + "\n";
}
