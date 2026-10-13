// Safe owner signers for a rehearsal run that names none. On the Twin chain (918453) the rehearsal key helper (src/rehearsal/keys.ts) mints
// the Safe owners as encrypted keystores SAFE_OWNER_A, SAFE_OWNER_B and SAFE_OWNER_C beside the DEPLOYER keystore, all under one passphrase file.
// When the deployer signer is `keystore:DIR/DEPLOYER:PASSFILE`, the owner signers are the sibling keystores with the same passphrase file.
// This reads no new secret and adds no store: it names the same files the rehearsal already made. Mainnet never uses it: there the owners
// come from `--owner-signer` (encrypted keystores with a typed passphrase).
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

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
