// Libs-stage adoption (issue 1721). The libs stage deploys the externally linked libraries (TickMath) through the Arachnid CREATE2 factory.
// When the library already sits at its address (the Base mainnet library is inside every Twin fork pinned at or after block 52401633, and on 8453
// itself after a resume) forge plans ZERO transactions: it exits 0, prints no SIMULATION COMPLETE and writes no dry-run file.
// That is not a failure when the chain already holds the very code this build would deploy. This module decides that, and refuses otherwise.
// The address is a pure function of the build (factory, salt 0, creation code), so it commits to the bytecode. The runtime code HASH is still
// compared, because an address with other code at it (or no code) must never be adopted.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getCreate2Address, isAddress, keccak256, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import type { TableCreate2Library, TableLibrary } from "./stage-table.ts";

/** The Arachnid deterministic deployment proxy forge uses for script libraries. The same address on every chain. */
export const CREATE2_FACTORY: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
export const CREATE2_SALT: Hex = `0x${"00".repeat(32)}`;

export interface AdoptedLibrary { name: string; artifact: string; address: Address; codeHash: Hex }
/** What the run manifest keeps for an adopted stage (StageRecord.adopted). */
export interface AdoptionRecord { libraries: AdoptedLibrary[]; factory: Address; deployerTxs: number }

const fail = (msg: string, details: Record<string, unknown> = {}): never => { throw new PublishError("LIBS_ADOPTION", `${msg} Nothing was sent.`, details); };

interface LibArtifact { creation: Hex; deployed: string }
function loadLibArtifact(outDir: string, name: string): LibArtifact {
  let path = join(outDir, `${name}.sol`, `${name}.json`);
  if (!existsSync(path)) {
    const hit = existsSync(outDir) ? readdirSync(outDir).find((d) => existsSync(join(outDir, d, `${name}.json`))) : undefined;
    if (!hit) return fail(`libs adoption: no build artifact for library ${name} under ${outDir}, so its expected code cannot be derived.`, { library: name });
    path = join(outDir, hit, `${name}.json`);
  }
  const j = JSON.parse(readFileSync(path, "utf8"));
  const creation = String(j.bytecode?.object ?? ""), deployed = String(j.deployedBytecode?.object ?? "");
  if (!/^0x[0-9a-fA-F]+$/.test(creation) || !/^0x[0-9a-fA-F]+$/.test(deployed)) return fail(`libs adoption: the build artifact of library ${name} has no creation or runtime bytecode.`, { library: name });
  return { creation: creation as Hex, deployed };
}

/** The runtime code a library has once deployed: its artifact with the library's own address (PUSH20 <address(this)>, bytes 1 to 20) filled in. */
export function expectedLibraryRuntime(deployedObject: string, address: Address): Hex {
  const hex = deployedObject.replace(/^0x/, "");
  if (!/^730{40}/.test(hex)) return fail("libs adoption: the runtime code of the artifact does not start with the library self-address push (0x73 and 20 zero bytes), so it is not a library this tool can check.", { address });
  return `0x73${address.slice(2).toLowerCase()}${hex.slice(42)}`.toLowerCase() as Hex;
}

/** The address forge deploys a library to: CREATE2 through the factory, salt 0, the artifact creation code. */
export const predictedLibraryAddress = (creation: Hex): Address => getCreate2Address({ from: CREATE2_FACTORY, salt: CREATE2_SALT, bytecodeHash: keccak256(creation) });

/**
 * Checks every library of the stage. `manifest` is the libs manifest the zero-transaction simulation wrote (forge writes it on every run).
 * `getCode` reads the runtime code at an address on the target chain. Returns the adopted libraries, or throws LIBS_ADOPTION naming the first problem.
 */
export async function verifyAdoptedLibraries(o: { libraries: TableLibrary[]; manifest: Record<string, unknown>; outDir: string; getCode: (a: Address) => Promise<string> }): Promise<AdoptedLibrary[]> {
  if (o.libraries.length === 0) return fail("libs adoption: the stage table lists no library, so there is nothing to adopt.");
  const out: AdoptedLibrary[] = [];
  for (const lib of o.libraries) {
    const raw = o.manifest[lib.manifestKey];
    if (typeof raw !== "string" || !isAddress(raw, { strict: false })) return fail(`libs adoption: the libs manifest has no address for ${lib.name} (${lib.manifestKey}).`, { library: lib.name });
    const address = raw as Address;
    const art = loadLibArtifact(o.outDir, lib.artifact);
    const predicted = predictedLibraryAddress(art.creation);
    if (predicted.toLowerCase() !== address.toLowerCase()) return fail(`libs adoption: ${lib.name} is at ${address} in the manifest, but the build deploys it to ${predicted} (CREATE2 factory ${CREATE2_FACTORY}, salt 0, creation code of the build). The address does not commit to this build.`, { library: lib.name, address, predicted });
    const code = (await o.getCode(address)).toLowerCase();
    if (code === "0x" || code === "") return fail(`libs adoption: the libs simulation planned zero transactions but ${lib.name} has NO code at ${address}. Something other than a deployed library made forge plan nothing.`, { library: lib.name, address });
    const want = keccak256(expectedLibraryRuntime(art.deployed, address));
    const got = keccak256(code as Hex);
    if (got !== want) return fail(`libs adoption: the runtime code at ${address} (hash ${got}) is not the build's ${lib.name} (expected hash ${want}).`, { library: lib.name, address, got, want });
    out.push({ name: lib.name, artifact: lib.artifact, address, codeHash: got });
  }
  return out;
}


// ---- libraries forge deploys by itself inside a stage (issue 1721, the proto stage) -------------------------------------------------------------------
// A stage that deploys a contract linking BasketAssetConfigGuard, TwapTickMath and BasketViews makes forge deploy those three through the same CREATE2 factory
// (salt 0) ahead of the stage's own transactions. When they already sit on chain forge simply leaves those transactions out (probed with forge and anvil:
// exit 0, SIMULATION COMPLETE, the dry-run file lists the stage's own transactions only). BasketViews links TwapTickMath, so its creation code, its address and
// its runtime code depend on TwapTickMath's address: the link placeholders are filled before anything is hashed.

interface LinkRef { start: number; length: number; lib: string }
interface RawArtifact { creation: string; deployed: string; creationLinks: LinkRef[]; deployedLinks: LinkRef[] }
export interface Create2Built { name: string; artifact: string; address: Address; creation: Hex; runtime: Hex; runtimeHash: Hex }

function readRawArtifact(outDir: string, name: string): RawArtifact | undefined {
  let path = join(outDir, `${name}.sol`, `${name}.json`);
  if (!existsSync(path)) {
    const hit = existsSync(outDir) ? readdirSync(outDir).find((d) => existsSync(join(outDir, d, `${name}.json`))) : undefined;
    if (!hit) return undefined;
    path = join(outDir, hit, `${name}.json`);
  }
  const j = JSON.parse(readFileSync(path, "utf8"));
  const links = (o: any): LinkRef[] => Object.values<any>(o?.linkReferences ?? {}).flatMap((file) => Object.entries<any>(file).flatMap(([lib, refs]) => (refs as { start: number; length: number }[]).map((r) => ({ start: r.start, length: r.length, lib }))));
  return { creation: String(j.bytecode?.object ?? ""), deployed: String(j.deployedBytecode?.object ?? ""), creationLinks: links(j.bytecode), deployedLinks: links(j.deployedBytecode) };
}

/** True when the build artifacts of every create2 library are there. A checkout with no build output cannot adopt anything. */
export const create2ArtifactsPresent = (libs: TableCreate2Library[], outDir: string): boolean => libs.every((l) => readRawArtifact(outDir, l.artifact) !== undefined);

const patch = (hex: string, at: number, address: Address): string => `${hex.slice(0, at * 2)}${address.slice(2).toLowerCase()}${hex.slice((at + 20) * 2)}`;

/**
 * The address, creation code and runtime code of every create2 library of the build. A link placeholder is filled with the address of the library it names (that
 * library must itself be one of `libs`: anything else, or a cycle, fails closed with LIBS_ADOPTION). The address is the CREATE2 address of the RESOLVED creation code.
 */
export function buildCreate2Libraries(libs: TableCreate2Library[], outDir: string): Map<string, Create2Built> {
  const done = new Map<string, Create2Built>();
  const byArtifact = new Map(libs.map((l) => [l.artifact, l]));
  const build = (artifact: string, stack: string[]): Create2Built => {
    const have = done.get(artifact);
    if (have) return have;
    if (stack.includes(artifact)) return fail(`libs adoption: ${[...stack, artifact].join(" -> ")} links in a cycle.`);
    const l = byArtifact.get(artifact);
    if (!l) return fail(`libs adoption: a library links ${artifact}, which the stage table does not list in create2Libraries, so its address cannot be resolved.`, { library: artifact });
    const raw = readRawArtifact(outDir, artifact);
    if (!raw || !/^0x[0-9a-zA-Z_$]+$/.test(raw.creation) || !/^0x[0-9a-zA-Z_$]+$/.test(raw.deployed)) return fail(`libs adoption: no usable build artifact for ${artifact} under ${outDir}.`, { library: artifact });
    let creation = raw.creation.slice(2), runtime = raw.deployed.slice(2);
    for (const r of raw.creationLinks) { if (r.length !== 20) return fail(`libs adoption: ${artifact} has a link reference of ${r.length} bytes.`); creation = patch(creation, r.start, build(r.lib, [...stack, artifact]).address); }
    for (const r of raw.deployedLinks) { if (r.length !== 20) return fail(`libs adoption: ${artifact} has a link reference of ${r.length} bytes.`); runtime = patch(runtime, r.start, build(r.lib, [...stack, artifact]).address); }
    if (/__\$/.test(creation) || /__\$/.test(runtime)) return fail(`libs adoption: ${artifact} still has an unresolved link placeholder.`, { library: artifact });
    const address = predictedLibraryAddress(`0x${creation}` as Hex);
    const filled = expectedLibraryRuntime(`0x${runtime}`, address);
    const built: Create2Built = { name: l.name, artifact, address, creation: `0x${creation}` as Hex, runtime: filled, runtimeHash: keccak256(filled) };
    done.set(artifact, built);
    return built;
  };
  for (const l of libs) build(l.artifact, []);
  return done;
}

/**
 * Checks the create2 libraries a stage found already deployed. Each must have code at its predicted address whose keccak256 equals the build's runtime code hash.
 * Anything else (no code, other code) is LIBS_ADOPTION: forge leaving a creation out is only explained by the genuine library.
 */
export async function verifyAdoptedCreate2(o: { adopted: Create2Built[]; getCode: (a: Address) => Promise<string> }): Promise<AdoptedLibrary[]> {
  const out: AdoptedLibrary[] = [];
  for (const b of o.adopted) {
    const code = (await o.getCode(b.address)).toLowerCase();
    if (code === "0x" || code === "") return fail(`libs adoption: the stage planned no creation of ${b.name} but there is NO code at ${b.address}.`, { library: b.name, address: b.address });
    const got = keccak256(code as Hex);
    if (got !== b.runtimeHash) return fail(`libs adoption: the runtime code at ${b.address} (hash ${got}) is not the build's ${b.name} (expected hash ${b.runtimeHash}).`, { library: b.name, address: b.address, got, want: b.runtimeHash });
    out.push({ name: b.name, artifact: b.artifact, address: b.address, codeHash: got });
  }
  return out;
}
