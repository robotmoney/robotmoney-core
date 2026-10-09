#!/usr/bin/env bun
/**
 * Runs forge fork tests against the Twin chain (core 1498, 1239). Replaces the golden-fixture
 * runner: there is no saved state to boot. The fork tests read FORK_RPC_URL and skip with a named
 * reason when it is unset, so this runner always sets it and then refuses a run in which no test
 * executed (skips do not count). A run that skipped every test is a red run, never a green one.
 *
 * Usage: bun scripts/devnet/forge-fork-tests.ts [--rpc-url URL] -- <forge test args>
 *   URL defaults to TWIN_RPC_URL (exported by .github/actions/twin-fork), then http://127.0.0.1:8545.
 * Exit: 0 at least one fork test executed and none failed; 1 a test failed or none executed;
 *       2 the Twin chain is unreachable or the usage is wrong.
 */
import { rpc, redact } from "./twin-fork-lib.ts";

/** Count of tests that ran (status other than Skip) in `forge test --json` output. */
export function countExecuted(json: unknown): number {
  let n = 0;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.status === "string" && o.status !== "Skip") n++;
      Object.values(o).forEach(walk);
    }
  };
  walk(json);
  return n;
}

if (import.meta.main) {
  // bun may swallow the first `--`, so accept the forge args with or without it.
  let argv = process.argv.slice(2);
  let url = process.env.TWIN_RPC_URL || "http://127.0.0.1:8545";
  if (argv[0] === "--rpc-url") {
    url = argv[1];
    argv = argv.slice(2);
  }
  const forgeArgs = argv[0] === "--" ? argv.slice(1) : argv;
  if (forgeArgs.length === 0) {
    console.error("usage: forge-fork-tests.ts [--rpc-url URL] -- <forge test args>");
    process.exit(2);
  }
  try {
    const id = parseInt(await rpc(url, "eth_chainId", [], { retries: 2, baseDelayMs: 300 }), 16);
    if (id !== 918453) console.error(`warning: ${url} reports chain id ${id}, not the Twin chain 918453`);
  } catch (e: any) {
    console.error(`Twin chain unreachable at ${url}: ${redact(String(e?.message ?? e))}. Start it with bun scripts/devnet/twin-fork.ts start.`);
    process.exit(2);
  }
  const p = Bun.spawnSync(["forge", "test", "--json", ...forgeArgs], {
    env: { ...process.env, FORK_RPC_URL: url },
    stdout: "pipe",
    stderr: "inherit",
  });
  const out = p.stdout.toString();
  if (p.exitCode !== 0) {
    console.error(out);
    process.exit(1);
  }
  let count = 0;
  try {
    count = countExecuted(JSON.parse(out));
  } catch {
    console.error("forge test --json output did not parse");
    console.error(out);
    process.exit(1);
  }
  if (count === 0) {
    console.error("zero fork tests executed (skips do not count)");
    console.error(out);
    process.exit(1);
  }
  console.log(`executed ${count} fork tests`);
}
