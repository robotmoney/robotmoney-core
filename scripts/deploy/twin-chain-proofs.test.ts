// Canonical: robotmoney/devops issue 53 / core issue 1499. Core 1483, 1485, 1486, 1487, 1493, 1503.
// Chain-dependent acceptance criteria. Each test needs a running Twin chain (918453) that already
// went through the core stage table, so each is skipped unless the environment names it. No test
// here sends a transaction (the proof scripts are read-only, or are given --read-only).
//
// To run them later, after `publish contracts` ran on the Twin chain:
//   TWIN_RPC_URL=<twin rpc> TWIN_MANIFEST=<merged manifest.json> TWIN_DEPLOYER=0x.. TWIN_SAFE=0x.. \
//   TWIN_EMERGENCY=0x.. TWIN_MIN_DELAY=<seconds> bun test scripts/deploy/twin-chain-proofs.test.ts --timeout 60000
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = process.env;
const haveChain = Boolean(env.TWIN_RPC_URL && env.TWIN_MANIFEST);
const haveRoles = Boolean(haveChain && env.TWIN_DEPLOYER && env.TWIN_SAFE && env.TWIN_EMERGENCY && env.TWIN_MIN_DELAY);

const chainWhy = "needs a Twin chain run: set TWIN_RPC_URL and TWIN_MANIFEST (see the header for the command)";
const rolesWhy = "needs a Twin chain run plus TWIN_DEPLOYER, TWIN_SAFE, TWIN_EMERGENCY, TWIN_MIN_DELAY";

async function proof(script: string, args: string[]): Promise<{ code: number; out: string; proof: any }> {
  const outFile = join(mkdtempSync(join(tmpdir(), "twin-proof-")), "proof.json");
  const p = Bun.spawn(["bun", script, ...args, "--out", outFile], { stdout: "pipe", stderr: "pipe" });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  let parsed: any = null;
  try {
    parsed = JSON.parse(readFileSync(outFile, "utf8"));
  } catch {
    // the script failed before it wrote a proof
  }
  return { code, out: o + e, proof: parsed };
}

describe("Twin chain proofs (918453)", () => {
  test.skipIf(!haveChain)(
    `core 1485/1493: gateway.router() is the deployed router and registry.router() equals it. ${chainWhy}`,
    async () => {
      const r = await proof("scripts/deploy/assert-core-router.ts", [
        "--rpc-url", env.TWIN_RPC_URL!, "--manifest", env.TWIN_MANIFEST!, "--read-only",
      ]);
      expect(r.code).toBe(0);
      expect(r.proof.mode).toBe("read-only");
    },
  );

  test.skipIf(!haveChain)(
    `core 1486: registry.listVaults() holds all four vaults, basket vaults paused, config equals chain. ${chainWhy}`,
    async () => {
      const r = await proof("scripts/deploy/assert-basket-vaults.ts", [
        "--rpc-url", env.TWIN_RPC_URL!, "--manifest", env.TWIN_MANIFEST!,
      ]);
      expect(r.code).toBe(0);
    },
  );

  test.skipIf(!haveRoles)(
    `core 1483/1487: deployer holds no role on any vault, ADMIN is the timelock, a second setRegistry reverts. ${rolesWhy}`,
    async () => {
      const r = await proof("scripts/deploy/assert-timelock-roles.ts", [
        "--rpc-url", env.TWIN_RPC_URL!, "--manifest", env.TWIN_MANIFEST!, "--deployer", env.TWIN_DEPLOYER!,
        "--safe", env.TWIN_SAFE!, "--emergency", env.TWIN_EMERGENCY!, "--min-delay", env.TWIN_MIN_DELAY!,
      ]);
      expect(r.code).toBe(0);
    },
  );

  test.skipIf(!haveChain)(
    `core 1503: the manifest shows deployer_share_balance_after 0 and a non-zero receiver. ${chainWhy}`,
    () => {
      const m = JSON.parse(readFileSync(env.TWIN_MANIFEST!, "utf8"));
      expect(m.deployer_share_balance_after).toBe(0);
      expect(m.seed_share_receiver).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(m.seed_share_receiver.toLowerCase()).not.toBe("0x" + "0".repeat(40));
      expect(m.seed_share_receiver.toLowerCase()).not.toBe(String(env.TWIN_DEPLOYER ?? "").toLowerCase());
    },
  );
});
