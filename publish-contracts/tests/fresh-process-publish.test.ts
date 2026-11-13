import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODES } from "../src/errors.ts";

// Deploy 4 on 8453 (2026-11-13): the first publish on Base mainnet failed with UNEXPECTED "undefined is not an object (evaluating
// 'DEPLOYER_STAGES[DEPLOYER_STAGES.length - 1].name')" before any signer existed: the pre-stage-1 owner check (qa-plan B1) read the stage list before main()
// loaded the stage table. In-process tests never saw it, because the test preload loads a table. These run the real CLI in a child process against a local
// JSON-RPC stub that answers eth_chainId with 8453 (0x2105) and nothing else: nothing can be signed or sent.
// The release forge check (TOOL) runs before the owner check: FORGE names a stub that reports the pinned version and refuses anything else, so the run
// never depends on the forge installed on the machine (the CI unit job has none).
let server: ReturnType<typeof Bun.serve>;
const scratch = mkdtempSync(join(tmpdir(), "fresh-process-publish-"));
const forge = join(scratch, "forge");
beforeAll(() => {
  writeFileSync(forge, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'forge Version: 1.8.5-v1.8.5\\nCommit SHA: stub\\n'; exit 0; fi\necho "stub forge: unsupported $*" >&2; exit 1\n`);
  chmodSync(forge, 0o755);
  server = Bun.serve({
    port: 0,
    async fetch(r) {
      const b = (await r.json()) as { id: number; method: string } | { id: number; method: string }[];
      const one = (q: { id: number; method: string }) =>
        q.method === "eth_chainId" ? { jsonrpc: "2.0", id: q.id, result: "0x2105" } : { jsonrpc: "2.0", id: q.id, error: { code: -32601, message: "not in this test" } };
      return Response.json(Array.isArray(b) ? b.map(one) : one(b));
    },
  });
});
afterAll(() => { server.stop(true); rmSync(scratch, { recursive: true, force: true }); });

const root = join(import.meta.dir, "..");
const publish = async (owners: number, system?: string) => {
  const args = ["bun", "src/cli.ts", "publish", ...(system ? ["--system", system] : []), "--chain", "8453", "--rpc", `http://127.0.0.1:${server.port}`,
    "--sheet", join(root, "..", "deployments/base-8453-rehearsal/deploy-4.env"), "--signer", "keystore:/nonexistent/DEPLOYER", "--environment", "local",
    "--core-sha", "97203dfa6d4cc8d261f32669c0acbf49af00f9d6", ...Array.from({ length: owners }, (_, i) => ["--owner-signer", `keystore:/nonexistent/OWNER_${i}`]).flat()];
  // async: the stub RPC is served by this process, so a blocking spawn would starve it
  const p = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, FORGE: forge } });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const out = o + e;
  const failed = out.split("\n").filter((l) => l.includes('"run.failed"')).map((l) => JSON.parse(l) as { kind: string; message: string }).pop();
  return { code: p.exitCode, failed };
};

test("a fresh CLI on 8453: two owner specs for a three-owner fund sheet is the CONTROL_NOT_PROVEN refusal, not a crash on the stage list", async () => {
  const r = await publish(2, "fund");
  expect(r.failed?.message ?? "").not.toContain("DEPLOYER_STAGES");
  expect(r.failed?.kind).toBe("CONTROL_NOT_PROVEN");
  expect(r.code).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
});

test("a fresh CLI on 8453: every owner given, the fund publish gets past the owner check (it stops later, at a check this stub cannot serve)", async () => {
  const r = await publish(3, "fund");
  expect(r.failed?.message ?? "").not.toContain("DEPLOYER_STAGES");
  expect(r.failed?.kind).not.toBe("UNEXPECTED");
  expect(r.failed?.kind).not.toBe("CONTROL_NOT_PROVEN");
});
