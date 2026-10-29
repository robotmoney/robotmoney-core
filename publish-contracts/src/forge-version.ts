// Issue 1926: the one forge version every release build uses. The compiled bytes (and so every CREATE2 library address, every linked implementation and
// every frozen count reconstructed from a build) change with the forge version: 1.7.1 and 1.8.x build different bytes. The Twin action and every CI Foundry
// install pin this version (asserted by tests/forge-version.test.ts reading .github/workflows and .github/actions), and every release-build entry point reads
// `forge --version` first and refuses any other version: libs-build.ts buildLibraryArtifacts, deploy-implementation, freeze-counts, predeploy-libs and the
// stage runner.
import { PublishError } from "./errors.ts";

/** The pinned forge version, without the leading `v`. */
export const PINNED_FORGE_VERSION = "1.8.5";
/** The release tag foundry-toolchain and foundryup install (`version: v1.8.5`). */
export const PINNED_FORGE_TAG = `v${PINNED_FORGE_VERSION}`;

/**
 * The semantic version `forge --version` prints, or undefined. Forge 1.x prints `forge Version: 1.8.5-v1.8.5` (first line); older builds print
 * `forge 0.2.0 (abc123 2024-...)`. Only the leading MAJOR.MINOR.PATCH is kept: a nightly or a dirty build of the same number is still the same number.
 */
export function parseForgeVersion(stdout: string): string | undefined {
  const m = /forge(?:\s+Version:)?\s+v?(\d+\.\d+\.\d+)/i.exec(stdout);
  return m?.[1];
}

/** The refusal: names the version found, the pinned one and why the version matters. */
export function forgeVersionError(found: string | undefined, forge: string, raw = ""): PublishError {
  const got = found ?? `an unreadable version (${raw.trim().split("\n")[0] || "no output"})`;
  return new PublishError("TOOL", `${forge} is forge ${got}, but release builds use exactly forge ${PINNED_FORGE_VERSION}: another forge version compiles other bytes, so the CREATE2 library addresses, the linked implementations and the frozen counts would not be the release's. Install it with \`foundryup --install ${PINNED_FORGE_TAG}\` (or point FORGE at a forge ${PINNED_FORGE_VERSION} binary). Nothing was built or sent.`, { found: found ?? null, pinned: PINNED_FORGE_VERSION, forge });
}

/** Throws unless `stdout` (the output of `forge --version`) names the pinned version. Returns the version. */
export function checkForgeVersionOutput(stdout: string, forge = "forge"): string {
  const v = parseForgeVersion(stdout);
  if (v !== PINNED_FORGE_VERSION) throw forgeVersionError(v, forge, stdout);
  return v;
}

/** Synchronous form for the build helpers: spawns `<forge> --version` and refuses any version other than the pinned one. */
export function assertPinnedForge(forge = process.env.FORGE ?? "forge", env?: Record<string, string | undefined>): string {
  let r: ReturnType<typeof Bun.spawnSync>;
  try { r = Bun.spawnSync([forge, "--version"], { stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) }); } catch (e) { throw new PublishError("TOOL", `cannot start ${forge} --version: ${(e as Error).message}. Release builds use exactly forge ${PINNED_FORGE_VERSION}. Nothing was built or sent.`, { forge, pinned: PINNED_FORGE_VERSION }); }
  if (r.exitCode !== 0) throw new PublishError("TOOL", `${forge} --version exited ${r.exitCode}: ${r.stderr?.toString().trim()}. Release builds use exactly forge ${PINNED_FORGE_VERSION}. Nothing was built or sent.`, { forge, pinned: PINNED_FORGE_VERSION });
  return checkForgeVersionOutput(r.stdout?.toString() ?? "", forge);
}

/** Asynchronous form for the stage runner and deploy-implementation, which spawn every tool through an injected runner (tests stub it). */
export async function assertPinnedForgeWith(run: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>, forge = "forge"): Promise<string> {
  const r = await run(["--version"]);
  if (r.code !== 0) throw new PublishError("TOOL", `${forge} --version exited ${r.code}: ${r.stderr.trim()}. Release builds use exactly forge ${PINNED_FORGE_VERSION}. Nothing was built or sent.`, { forge, pinned: PINNED_FORGE_VERSION });
  return checkForgeVersionOutput(r.stdout, forge);
}
