// Code-hash check against build artifacts with immutables and library links masked.
// Ports the behavior asked for in the review (review finding mainnet-verify-code-hash): on-chain runtime code must equal the reviewed build.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "viem";
import type { Hex } from "./types.ts";

export interface Ref { start: number; length: number }
/** One library the artifact links, with every byte range forge fills with its address. */
export interface Link { name: string; refs: Ref[] }
export interface Artifact { object: string; refs: Ref[]; links?: Link[] }

/** The file of `name` in a forge out/: `<out>/<Name>.sol/<Name>.json`, else the first directory holding `<Name>.json`. Throws when there is none. */
export function artifactPathOf(outDir: string, name: string): string {
  const path = join(outDir, `${name}.sol`, `${name}.json`);
  if (existsSync(path)) return path;
  const hit = existsSync(outDir) ? readdirSync(outDir).find((d) => existsSync(join(outDir, d, `${name}.json`))) : undefined;
  if (!hit) throw new Error(`no build artifact for ${name} under ${outDir}`);
  return join(outDir, hit, `${name}.json`);
}

/** Load `<out>/<Name>.sol/<Name>.json` (forge layout). Falls back to any directory holding `<Name>.json`. */
export function loadArtifact(outDir: string, name: string): Artifact {
  const j = JSON.parse(readFileSync(artifactPathOf(outDir, name), "utf8"));
  const d = j.deployedBytecode;
  if (!d?.object) throw new Error(`artifact ${name} has no deployedBytecode`);
  const refs: Ref[] = [];
  for (const list of Object.values<any>(d.immutableReferences ?? {})) refs.push(...list);
  const links: Link[] = [];
  for (const file of Object.values<any>(d.linkReferences ?? {})) {
    for (const [libName, list] of Object.entries<any>(file)) { refs.push(...list); links.push({ name: libName, refs: [...list] }); }
  }
  const object = String(d.object);
  refs.push(...implicitRefs(object, refs.length > 0 && Object.keys(d.linkReferences ?? {}).length > 0));
  return { object, refs, links };
}

/** The address forge linked at `ref` in on-chain runtime code. */
export function linkedAddressAt(onchain: Hex, ref: Ref): Hex {
  const hex = onchain.replace(/^0x/, "");
  return (`0x${hex.slice(ref.start * 2, (ref.start + ref.length) * 2).toLowerCase()}`) as Hex;
}

/**
 * Issue 1809/1810 (ADR-0014 §9): `compareCode` masks every link reference, so on its own it would pass an implementation that links any library code at all.
 * This follows each link: every byte range of one library must hold the same address, the code at that address must equal the library's build artifact (masked),
 * and the same holds for every library that library links, recursively. A missing library artifact or an unreadable address is a failure, never a pass.
 */
export async function compareLinkedLibraries(
  getCode: (address: Hex) => Promise<Hex>,
  onchain: Hex,
  art: Artifact,
  dir: string,
  seen: Set<string> = new Set(),
): Promise<CodeHashResult> {
  const checked: string[] = [];
  for (const link of art.links ?? []) {
    const addrs = [...new Set(link.refs.map((r) => linkedAddressAt(onchain, r)))];
    if (addrs.length !== 1 || !/^0x[0-9a-f]{40}$/.test(addrs[0]!)) return { ok: false, detail: `library ${link.name}: the linked address is not one address (${addrs.join(", ")})` };
    const at = addrs[0]!;
    if (seen.has(`${link.name}@${at}`)) continue;
    seen.add(`${link.name}@${at}`);
    let libArt: Artifact;
    try { libArt = loadArtifact(dir, link.name); } catch (e) { return { ok: false, detail: `library ${link.name} at ${at}: no build to compare with: ${(e as Error).message}` }; }
    const libCode = await getCode(at);
    // A library a stage deploys by forge's CREATE2 deployment is compiled with that stage's `--libraries` settings, which change only its CBOR metadata
    // trailer (nothing executable). Mask the trailer for every linked library, as for a contract that links libraries.
    const r = compareCode(libCode, { ...libArt, refs: [...libArt.refs, ...implicitRefs(libArt.object, true)] });
    if (!r.ok) return { ok: false, detail: `library ${link.name} at ${at}: ${r.detail}` };
    const nested = await compareLinkedLibraries(getCode, libCode, libArt, dir, seen);
    if (!nested.ok) return nested;
    checked.push(`${link.name}@${at}`);
  }
  return { ok: true, detail: checked.length ? `linked libraries equal their builds: ${checked.join(", ")}` : "links no library" };
}

/** `compareCode`, then `compareLinkedLibraries`: the code and every library it links are the reviewed build. */
export async function compareCodeAndLinks(
  getCode: (address: Hex) => Promise<Hex>,
  onchain: Hex,
  art: Artifact,
  dir: string,
): Promise<CodeHashResult> {
  const r = compareCode(onchain, art);
  if (!r.ok) return r;
  const l = await compareLinkedLibraries(getCode, onchain, art, dir);
  return l.ok ? { ...r, detail: `${r.detail}; ${l.detail}` } : { ok: false, detail: l.detail, maskedHash: r.maskedHash };
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
