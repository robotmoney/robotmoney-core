// Signature shapes the Safe accepts for an EOA owner, and local verification before any chain call.
//   raw      v = 27 or 28: ECDSA straight over the Safe transaction hash (the Safe's plain path). Keystore signers use this.
//   eth_sign v = 31 or 32: ECDSA over the "\x19Ethereum Signed Message:\n32" prefixed hash, v + 4. Hardware wallets (and Safe-app
//            "eth_sign" signatures) use this: the device shows a message, not typed data.
import { hashMessage, recoverAddress, type Address, type Hex } from "viem";
import { SafeToolError } from "./errors.ts";

export type SignMode = "raw" | "eth_sign";

export function splitSignature(sig: string): { r: Hex; s: Hex; v: number } {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new SafeToolError("SIGNATURE_INVALID", "a signature must be 65 bytes of hex (r, s, v)");
  return { r: `0x${sig.slice(2, 66)}` as Hex, s: `0x${sig.slice(66, 130)}` as Hex, v: parseInt(sig.slice(130, 132), 16) };
}

/** Turns a wallet's signature (v 0/1 or 27/28) into the Safe's form for `mode`. */
export function toSafeSignature(sig: string, mode: SignMode): Hex {
  const { v } = splitSignature(sig);
  let base: number;
  if (v === 0 || v === 1) base = v + 27;
  else if (v === 27 || v === 28) base = v;
  else throw new SafeToolError("SIGNATURE_INVALID", `unexpected recovery byte ${v} from the signer`);
  const out = mode === "eth_sign" ? base + 4 : base;
  return `0x${sig.slice(2, 130)}${out.toString(16).padStart(2, "0")}` as Hex;
}

export function modeOf(sig: string): SignMode {
  const { v } = splitSignature(sig);
  if (v === 27 || v === 28) return "raw";
  if (v === 31 || v === 32) return "eth_sign";
  throw new SafeToolError("SIGNATURE_INVALID", `recovery byte ${v}: this tool packs only EOA signatures with v 27/28 (raw) or 31/32 (eth_sign); v 0 and 1 are contract signatures and v 4 is a pre-approved hash`);
}

/** The address a Safe-form signature recovers to over `safeTxHash`. */
export async function recoverSafeSigner(safeTxHash: Hex, sig: Hex): Promise<Address> {
  const mode = modeOf(sig);
  const { v } = splitSignature(sig);
  if (mode === "raw") return recoverAddress({ hash: safeTxHash, signature: sig });
  const plain = `0x${sig.slice(2, 130)}${(v - 4).toString(16).padStart(2, "0")}` as Hex;
  return recoverAddress({ hash: hashMessage({ raw: safeTxHash }), signature: plain });
}

export async function verifySafeSignature(safeTxHash: Hex, owner: string, sig: Hex): Promise<boolean> {
  try { return (await recoverSafeSigner(safeTxHash, sig)).toLowerCase() === owner.toLowerCase(); } catch { return false; }
}
