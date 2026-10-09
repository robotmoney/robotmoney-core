// Core's own config-check (scripts/ci/config-check.ts in the core checkout at the DEPLOY_SHA), run read-only against live Base. It is the
// plan job's check and the gate right before every vault stage (runner.ts). There is no --skip: a missing script is a named error, a
// failing check stops the run. It sends nothing. It reads the run's RPC on both chains (the Twin chain is a pinned lazy fork of real
// Base state, so its pools and tokens are the live ones) and passes --chain with the run's chain id. The RPC travels in the child's
// environment (CONFIG_CHECK_RPC_URL, which core's check reads in place of --rpc), never as an argument. The report goes to the evidence directory so the core checkout stays clean.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PublishError } from "./errors.ts";

export const CORE_CONFIG_CHECK_SCRIPT = join("scripts", "ci", "config-check.ts");

export interface CoreConfigCheckInput {
  coreDir: string;
  /** Where core writes its JSON report (inside the evidence directory, never inside the core checkout). */
  outDir: string;
  chainId: number;
  rpc: string;
  baseEnv: Record<string, string | undefined>;
}
export interface CoreConfigCheckResult { code: number; output: string }
/** Test seam. The real one runs `bun scripts/ci/config-check.ts --chain ID --out-dir DIR` in the core checkout. */
export type CoreConfigCheck = (i: CoreConfigCheckInput) => Promise<CoreConfigCheckResult>;

/** The environment of core's check: PATH and HOME and the live Base RPC. No signing material, no other secret. */
export function coreCheckEnv(i: Pick<CoreConfigCheckInput, "rpc" | "baseEnv">): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME"]) if (i.baseEnv[k]) env[k] = i.baseEnv[k]!;
  env.CONFIG_CHECK_RPC_URL = i.rpc;
  return env;
}

export const spawnCoreConfigCheck: CoreConfigCheck = async (i) => {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(["bun", CORE_CONFIG_CHECK_SCRIPT, "--chain", String(i.chainId), "--out-dir", i.outDir], { cwd: i.coreDir, env: coreCheckEnv(i), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new PublishError("TOOL", `cannot start bun for core's config-check: ${(e as Error).message}`);
  }
  const [out, err, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
  return { code, output: `${out}${err}` };
};

/**
 * Run core's config-check. A missing script is INPUT_MISSING by name (the core checkout at this DEPLOY_SHA has no scripts/ci/config-check.ts).
 * A non-zero exit is VERIFY, with the FAIL lines of core's output. Returns the FAIL-free output lines on success.
 */
export async function runCoreConfigCheck(i: CoreConfigCheckInput, check: CoreConfigCheck = spawnCoreConfigCheck, stage = "plan"): Promise<string[]> {
  if (!existsSync(join(i.coreDir, CORE_CONFIG_CHECK_SCRIPT))) {
    throw new PublishError("INPUT_MISSING", `core's config-check ${CORE_CONFIG_CHECK_SCRIPT} is missing in the core checkout ${i.coreDir}: it runs before every vault stage and in the plan job, and it cannot be skipped`, { script: CORE_CONFIG_CHECK_SCRIPT });
  }
  const r = await check(i);
  const lines = r.output.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (r.code !== 0) {
    const fails = lines.filter((l) => l.startsWith("FAIL"));
    throw new PublishError("VERIFY", `core's config-check before ${stage} failed (exit ${r.code}): ${(fails.length ? fails : lines.slice(-3)).slice(0, 5).join(" | ")}`, { stage, exit: r.code, failed: fails.slice(0, 20) });
  }
  return lines;
}
