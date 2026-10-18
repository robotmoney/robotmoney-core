// A run at a TOOLING sha (Deploy 3, 2026-10-18): a later commit that changes only the tools continues the run manifest the deployment was written at.
// A rehearsal fixes the tools as it finds problems and then goes on with the same contracts, so the run may name a descendant of the manifest's sha
// when every deployed input is byte-identical between the two. Anything else is held to the manifest's own sha (runStages refuses it, RESUME).
import { PublishError } from "./errors.ts";
import type { ProcessRunner, RunManifest } from "./runner.ts";

/** Everything the deployed bytecode, the stage scripts and their inputs come from: the contracts and scripts, the libraries, the asset configs, the build settings and the stage table. */
export const DEPLOY_INPUTS = ["contracts", "lib", "config", "foundry.toml", "foundry.lock", "remappings.txt", "scripts/deploy"] as const;

/** The two read-only git reads this check spawns, besides `status --porcelain` (runner.ts spawnTool). */
export const isReadOnlyGitAncestry = (args: string[]): boolean =>
  args.length === 6 && args[0] === "-C" && args[2] === "merge-base" && args[3] === "--is-ancestor" && /^[0-9a-f]{40}$/.test(args[4]!) && /^[0-9a-f]{40}$/.test(args[5]!);
export const isReadOnlyGitInputsDiff = (args: string[]): boolean =>
  args.length === 7 + DEPLOY_INPUTS.length && args[0] === "-C" && args[2] === "diff" && args[3] === "--name-only" && /^[0-9a-f]{40}$/.test(args[4]!) && /^[0-9a-f]{40}$/.test(args[5]!)
  && args[6] === "--" && DEPLOY_INPUTS.every((p, i) => args[7 + i] === p);

export interface ToolingShaRun { originalSha: string; toolingSha: string }

/**
 * undefined: no run manifest, the manifest's own sha, a vault redeploy round in the manifest (its own sha model, redeploy-vault.ts), or a sha that is not a
 * descendant (runStages then refuses it as before). A pair: the run continues the manifest at the original sha. Refused with USAGE before any signer exists
 * when the descendant changed a deployed input, naming the changed paths.
 */
export async function toolingShaRun(manifest: Pick<RunManifest, "coreSha" | "vault_redeploys"> | undefined, i: { coreSha: string; coreDir: string; run: ProcessRunner; env: Record<string, string> }): Promise<ToolingShaRun | undefined> {
  if (!manifest || manifest.coreSha === i.coreSha || (Array.isArray(manifest.vault_redeploys) && manifest.vault_redeploys.length > 0)) return undefined;
  const original = manifest.coreSha;
  const anc = await i.run("git", ["-C", i.coreDir, "merge-base", "--is-ancestor", original, i.coreSha], { env: i.env });
  if (anc.code !== 0) return undefined;
  const diff = await i.run("git", ["-C", i.coreDir, "diff", "--name-only", original, i.coreSha, "--", ...DEPLOY_INPUTS], { env: i.env });
  if (diff.code !== 0) throw new PublishError("USAGE", `cannot compare the deployed inputs of ${original} and ${i.coreSha}: git diff exited ${diff.code}. No signer was built, nothing was sent.`);
  const changed = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (changed.length > 0) throw new PublishError("USAGE", `the run manifest was written at ${original}, and ${i.coreSha} changed ${changed.length} deployed input(s) since (${changed.slice(0, 5).join(", ")}): a deployment continues only at a commit whose ${DEPLOY_INPUTS.join(", ")} are byte-identical. No signer was built, nothing was sent.`, { original, changed: changed.slice(0, 20) });
  return { originalSha: original, toolingSha: i.coreSha };
}
