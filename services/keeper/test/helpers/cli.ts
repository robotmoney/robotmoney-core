// Runs the keeper CLI as a child process, and a fake JSON-RPC endpoint for start-up paths that need one.
import { resolve } from "node:path";

export const CLI = resolve(import.meta.dir, "../../src/cli.ts");

export async function runCli(args: string[], env: Record<string, string>, stdin?: string, timeoutMs = 30_000) {
  const p = Bun.spawn(["bun", CLI, ...args], {
    env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? "/tmp", ...env },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(timer);
  return { code, out, err };
}

/** A JSON-RPC server answering eth_chainId with `chainId` and every other method with an error. */
export function fakeRpc(chainId: number) {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const body = await req.json() as any;
      const one = (m: any) => m.method === "eth_chainId"
        ? { jsonrpc: "2.0", id: m.id, result: `0x${chainId.toString(16)}` }
        : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } };
      return Response.json(Array.isArray(body) ? body.map(one) : one(body));
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
