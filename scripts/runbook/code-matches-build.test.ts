// scripts/runbook/code-matches-build.test.ts: the readback P1.83 runs on the adapter it deploys (ADR-0019).
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "code-matches-build.ts");

function out(code: string): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cmb-"));
  mkdirSync(join(dir, "A.sol"));
  writeFileSync(join(dir, "A.sol", "A.json"), JSON.stringify({ deployedBytecode: { object: code, linkReferences: {}, immutableReferences: {} } }));
  return dir;
}

function serve(code: string) {
  return Bun.serve({ port: 0, fetch: () => Response.json({ jsonrpc: "2.0", id: 1, result: code }) });
}

async function run(args: string[]) {
  const p = Bun.spawn(["bun", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: await p.exited, out: await new Response(p.stdout).text() };
}

const ADDR = "0x00000000000000000000000000000000000000aa";

test("the build's code at the address passes", async () => {
  const s = serve("0x6080604052");
  const r = await run(["--rpc", `http://127.0.0.1:${s.port}`, "--address", ADDR, "--out", out("0x6080604052"), "--contract", "A"]);
  s.stop();
  expect(r.code).toBe(0);
  expect(r.out).toContain("matches the build");
});

test("other code at the address fails", async () => {
  const s = serve("0x6080604053");
  const r = await run(["--rpc", `http://127.0.0.1:${s.port}`, "--address", ADDR, "--out", out("0x6080604052"), "--contract", "A"]);
  s.stop();
  expect(r.code).toBe(1);
  expect(r.out).toContain("DIFFERS");
});

test("a missing argument is a usage error", async () => {
  expect((await run(["--rpc", "http://127.0.0.1:1"])).code).toBe(2);
});
