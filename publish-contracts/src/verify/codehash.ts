// Code-hash check against build artifacts with immutables and library links masked.
// Ports the behavior asked for in the review (review finding mainnet-verify-code-hash): on-chain runtime code must equal the reviewed build.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "viem";
import type { Hex } from "./types.ts";

export interface Ref { start: number; length: number }
export interface Artifact { object: string; refs: Ref[] }

/** Load `<out>/<Name>.sol/<Name>.json` (forge layout). Falls back to any directory holding `<Name>.json`. */
export function artifactJson(outDir: string, name: string): any {
  let path = join(outDir, `${name}.sol`, `${name}.json`);
  if (!existsSync(path)) {
    const hit = existsSync(outDir) ? readdirSync(outDir).find((d) => existsSync(join(outDir, d, `${name}.json`))) : undefined;
    if (!hit) throw new Error(`no build artifact for ${name} under ${outDir}`);
    path = join(outDir, hit, `${name}.json`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Issue 1809: the libraries an artifact's runtime code links externally (DELEGATECALL targets), each with the byte offset of every 20-byte address slot. The code
 * comparison masks those slots, so the verifier reads the linked addresses from the chain and compares each library's own code with the build.
 */
export function linkedLibraries(outDir: string, name: string): { name: string; start: number }[] {
  const out: { name: string; start: number }[] = [];
  for (const file of Object.values<any>(artifactJson(outDir, name).deployedBytecode?.linkReferences ?? {})) {
    for (const [lib, list] of Object.entries<any>(file)) for (const r of list) out.push({ name: lib, start: r.start });
  }
  return out;
}

export function loadArtifact(outDir: string, name: string): Artifact {
  const j = artifactJson(outDir, name);
  const d = j.deployedBytecode;
  if (!d?.object) throw new Error(`artifact ${name} has no deployedBytecode`);
  const refs: Ref[] = [];
  for (const list of Object.values<any>(d.immutableReferences ?? {})) refs.push(...list);
  for (const file of Object.values<any>(d.linkReferences ?? {})) for (const list of Object.values<any>(file)) refs.push(...list);
  const object = String(d.object);
  // Issue 1808: the stages compile with different `--libraries` settings (libs and recorder without, every proxy stage and the timelock with
  // tick_math), and the setting changes the metadata hash of everything compiled, linked or not. The verifier's out/ holds one of the two, so
  // the CBOR trailer is masked for every artifact; the executable bytes are still compared exactly.
  refs.push(...implicitRefs(object, true));
  return { object, refs };
}

/**
 * Two byte ranges the compiler fills in that no reference list names.
 *  - A library's own address: its runtime code starts with PUSH20 <address(this)> (0x73 and 20 zero bytes in the artifact, the deployed address on chain).
 *  - The CBOR metadata trailer (when `linksLibraries`, and only when a CBOR map byte 0xa0-0xbf starts at the offset the last two bytes give): `forge script --libraries` compiles with the libraries in the settings, which
 *    changes the metadata hash (the last bytes) and nothing executable. `loadArtifact` masks it for every artifact (issue 1808).
 */
export function implicitRefs(object: string, linksLibraries: boolean): Ref[] {
  const hex = object.replace(/^0x/, "");
  const out: Ref[] = [];
  if (/^730{40}/.test(hex)) out.push({ start: 1, length: 20 });
  if (linksLibraries && hex.length > 4) {
    const cborLen = parseInt(hex.slice(-4), 16); // the last two bytes hold the CBOR length
    const total = hex.length / 2;
    // Issue 1842: mask only a real trailer, a CBOR map (major type 5, first byte 0xa0-0xbf) starting at the computed offset inside the code. Two arbitrary last bytes
    // that merely look like a plausible length would otherwise blank executable bytes.
    const start = total - 2 - cborLen;
    const first = cborLen > 0 && cborLen + 2 < total ? parseInt(hex.slice(start * 2, start * 2 + 2), 16) : NaN;
    if (first >= 0xa0 && first <= 0xbf) out.push({ start, length: cborLen });
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

/** ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1. */
export const ERC1967_IMPLEMENTATION_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/** The OpenZeppelin proxy every core contract runs behind since issue 1808. */
export const ERC1967_PROXY_ARTIFACT = "ERC1967Proxy";

/**
 * True when `code` is the build's ERC1967Proxy runtime. The CBOR metadata trailer is masked: the deploy stages compile with `--libraries`
 * (which changes every contract's metadata hash, the proxy's too) and the verifier's build may not, while the proxy's executable bytes are fixed.
 */
export function isProxyCode(code: Hex, proxyArt: Artifact | undefined): boolean {
  if (proxyArt === undefined) return false;
  return compareCode(code, { object: proxyArt.object, refs: [...proxyArt.refs, ...implicitRefs(proxyArt.object, true)] }).ok;
}

/** `loadArtifact`, or undefined when the build has no artifact of that name. */
export function tryLoadArtifact(outDir: string, name: string): Artifact | undefined {
  try { return loadArtifact(outDir, name); } catch { return undefined; }
}

/**
 * Issue 1808: the code check of a core contract that may run behind an ERC-1967 proxy. When the code at `address` is the build's ERC1967Proxy, the
 * implementation its ERC-1967 slot names must equal the artifact (the proxy's own code is compared too, exactly). Otherwise the code at the address
 * itself must equal the artifact (a direct deployment, as before). Which form a release must use, and its freeze state, is the release sheet's
 * business (upgradeability stage 2); this check proves the logic at the address is the reviewed build either way.
 */
export async function compareDeployedCode(
  chain: { getCode(a: Hex): Promise<Hex>; getStorageAt(a: Hex, slot: Hex): Promise<Hex> },
  address: Hex,
  art: Artifact,
  proxyArt: Artifact | undefined,
): Promise<CodeHashResult & { implementation?: Hex }> {
  const code = await chain.getCode(address);
  if (!isProxyCode(code, proxyArt)) return compareCode(code, art);
  const word = (await chain.getStorageAt(address, ERC1967_IMPLEMENTATION_SLOT)).replace(/^0x/, "").padStart(64, "0");
  const implementation = (`0x${word.slice(24)}`).toLowerCase() as Hex;
  const r = compareCode(await chain.getCode(implementation), art);
  return { ...r, implementation, detail: `ERC-1967 proxy, implementation ${implementation}: ${r.detail}` };
}

/** The code that runs at `address`: the implementation's when it is the build's ERC1967Proxy (issue 1808), else the code at the address. */
export async function logicCode(
  chain: { getCode(a: Hex): Promise<Hex>; getStorageAt(a: Hex, slot: Hex): Promise<Hex> },
  address: Hex,
  proxyArt: Artifact | undefined,
): Promise<Hex> {
  const code = await chain.getCode(address);
  if (!isProxyCode(code, proxyArt)) return code;
  const word = (await chain.getStorageAt(address, ERC1967_IMPLEMENTATION_SLOT)).replace(/^0x/, "").padStart(64, "0");
  return chain.getCode(`0x${word.slice(24)}` as Hex);
}
