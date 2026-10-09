// Code-hash check against build artifacts with immutables and library links masked.
// Ports the behavior asked for in the review (review finding mainnet-verify-code-hash): on-chain runtime code must equal the reviewed build.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "viem";
import type { Hex } from "./types.ts";

export interface Ref { start: number; length: number }
export interface Artifact { object: string; refs: Ref[] }

/** Load `<out>/<Name>.sol/<Name>.json` (forge layout). Falls back to any directory holding `<Name>.json`. */
export function loadArtifact(outDir: string, name: string): Artifact {
  let path = join(outDir, `${name}.sol`, `${name}.json`);
  if (!existsSync(path)) {
    const hit = existsSync(outDir) ? readdirSync(outDir).find((d) => existsSync(join(outDir, d, `${name}.json`))) : undefined;
    if (!hit) throw new Error(`no build artifact for ${name} under ${outDir}`);
    path = join(outDir, hit, `${name}.json`);
  }
  const j = JSON.parse(readFileSync(path, "utf8"));
  const d = j.deployedBytecode;
  if (!d?.object) throw new Error(`artifact ${name} has no deployedBytecode`);
  const refs: Ref[] = [];
  for (const list of Object.values<any>(d.immutableReferences ?? {})) refs.push(...list);
  for (const file of Object.values<any>(d.linkReferences ?? {})) for (const list of Object.values<any>(file)) refs.push(...list);
  const object = String(d.object);
  refs.push(...implicitRefs(object, refs.length > 0 && Object.keys(d.linkReferences ?? {}).length > 0));
  return { object, refs };
}

/**
 * Two byte ranges the compiler fills in that no reference list names.
 *  - A library's own address: its runtime code starts with PUSH20 <address(this)> (0x73 and 20 zero bytes in the artifact, the deployed address on chain).
 *  - The CBOR metadata trailer of a contract that links libraries: `forge script --libraries` compiles with the libraries in the settings, which
 *    changes the metadata hash (the last bytes) and nothing executable. Contracts that link nothing keep their trailer in the comparison.
 */
export function implicitRefs(object: string, linksLibraries: boolean): Ref[] {
  const hex = object.replace(/^0x/, "");
  const out: Ref[] = [];
  if (/^730{40}/.test(hex)) out.push({ start: 1, length: 20 });
  if (linksLibraries && hex.length > 4) {
    const cborLen = parseInt(hex.slice(-4), 16); // the last two bytes hold the CBOR length
    const total = hex.length / 2;
    if (cborLen > 0 && cborLen + 2 < total) out.push({ start: total - 2 - cborLen, length: cborLen });
  }
  return out;
}

/** Zero every referenced byte range. Works on hex text so unlinked placeholders (__$..$__) in artifacts are masked too. */
export function maskHex(hexWith0x: string, refs: Ref[]): Hex {
  const chars = hexWith0x.replace(/^0x/, "").split("");
  for (const r of refs) for (let i = r.start * 2; i < (r.start + r.length) * 2 && i < chars.length; i++) chars[i] = "0";
  return (`0x${chars.join("").toLowerCase()}`) as Hex;
}

export interface CodeHashResult { ok: boolean; detail: string; maskedHash?: Hex }

export function compareCode(onchain: Hex, art: Artifact): CodeHashResult {
  if (onchain === "0x" || onchain.length <= 2) return { ok: false, detail: "no code on chain" };
  const a = maskHex(art.object, art.refs);
  const b = maskHex(onchain, art.refs);
  if (a.length !== b.length) return { ok: false, detail: `runtime length ${(b.length - 2) / 2} bytes, build ${(a.length - 2) / 2} bytes` };
  const ha = keccak256(a), hb = keccak256(b);
  return { ok: ha === hb, detail: ha === hb ? `masked hash ${ha}` : `masked hash on chain ${hb}, build ${ha}`, maskedHash: hb };
}
