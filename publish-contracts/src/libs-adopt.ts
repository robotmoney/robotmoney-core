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
import type { TableLibrary } from "./stage-table.ts";

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
