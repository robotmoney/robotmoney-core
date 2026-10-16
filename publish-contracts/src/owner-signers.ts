// Safe owner signers for a rehearsal run that names none. On the Twin chain (918453) the rehearsal key helper (src/rehearsal/keys.ts) mints
// the Safe owners as encrypted keystores SAFE_OWNER_A, SAFE_OWNER_B and SAFE_OWNER_C beside the DEPLOYER keystore, all under one passphrase file.
// When the deployer signer is `keystore:DIR/DEPLOYER:PASSFILE`, the owner signers are the sibling keystores with the same passphrase file.
// This reads no new secret and adds no store: it names the same files the rehearsal already made. Mainnet never uses it: there the owners
// come from `--owner-signer` (encrypted keystores with a typed passphrase).
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseOwnerHardwareSpec } from "./safe/signers.ts";

export const REHEARSAL_OWNER_KEY_NAMES = ["SAFE_OWNER_A", "SAFE_OWNER_B", "SAFE_OWNER_C"] as const;

/** `keystore:PATH[:PASSFILE]` specs of the sibling owner keystores that exist. Empty when the signer is not a keystore spec. */
export function siblingOwnerSpecs(signerSpec: string | undefined): string[] {
  if (!signerSpec?.startsWith("keystore:")) return [];
  const [path, passFile] = signerSpec.slice("keystore:".length).split(":");
  if (!path || !passFile) return [];
  const dir = dirname(path);
  return REHEARSAL_OWNER_KEY_NAMES.map((n) => join(dir, n)).filter((p) => existsSync(p) && statSync(p).isFile()).map((p) => `keystore:${p}:${passFile}`);
}

/** The rehearsal's EMERGENCY keystore beside the DEPLOYER keystore, under the same passphrase file (pause-all after the handover). Undefined when it is not there. */
export function siblingEmergencySpec(signerSpec: string | undefined): string | undefined {
  if (!signerSpec?.startsWith("keystore:")) return undefined;
  const [path, passFile] = signerSpec.slice("keystore:".length).split(":");
  if (!path || !passFile) return undefined;
  const p = join(dirname(path), "EMERGENCY");
  return existsSync(p) && statSync(p).isFile() ? `keystore:${p}:${passFile}` : undefined;
}

/**
 * Security round 1 (review: RELIABILITY_PRECHECK_GAP): the Safe owner an `--owner-signer` spec claims, read before stage 1 with no passphrase and no device: a hardware
 * spec's `@0xOWNER`, a keystore file's unencrypted `address` field. Lower case. Undefined when it cannot be told yet (an unreadable keystore, env:signer): prove-control
 * still recovers every signer's address after the passphrase.
 */
export function claimedOwnerOf(spec: string, cwd: string = process.cwd()): string | undefined {
  const hw = parseOwnerHardwareSpec(spec);
  if (hw) return hw.owner.toLowerCase();
  if (!spec.startsWith("keystore:")) return undefined;
  const path = spec.slice("keystore:".length).split(":")[0];
  if (!path) return undefined;
  try {
    const a = String((JSON.parse(readFileSync(resolve(cwd, path), "utf8")) as { address?: unknown }).address ?? "").replace(/^0x/i, "");
    return /^[0-9a-fA-F]{40}$/.test(a) ? `0x${a.toLowerCase()}` : undefined;
  } catch { return undefined; }
}
