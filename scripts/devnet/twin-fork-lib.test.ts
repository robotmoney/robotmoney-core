// Canonical: core issues 1498, 1496. Unit tests for twin-fork-lib.ts (no anvil, no network).
// Smoke test at the bottom starts anvil against the public endpoint: TWIN_FORK_SMOKE=1.
// Run: bun test scripts/devnet/twin-fork-lib.test.ts --timeout 60000
import { describe, expect, test } from "bun:test";
import {
  buildAnvilArgv, ethToWei, keccak256, redact, redactArgv, rpc, selectPin, urlHost,
  usdcBalanceSlot, usdcBalanceWord, resolveUpstream, DEFAULT_UPSTREAM, warp, hexToBytes, isStalePinText, pinStateServed, repinIfStale,
} from "./twin-fork-lib.ts";

/** Stub JSON-RPC fetcher. */
function stub(handlers: Record<string, (p: any[]) => any>, calls: string[] = []) {
  return (async (_u: any, init: any) => {
    const { method, params } = JSON.parse(init.body);
    calls.push(method);
    const h = handlers[method];
    if (!h) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: `no ${method}` } }));
    const r = h(params);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: r }));
  }) as unknown as typeof fetch;
}

describe("keccak256 and USDC slot", () => {
  test("known vectors", () => {
    expect(keccak256(new Uint8Array())).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccak256(new TextEncoder().encode("abc"))).toBe("0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    // multi-block input (> 136 bytes)
    expect(keccak256(new Uint8Array(200)).length).toBe(66);
  });
  test("mapping slot of address 0x..01 at slot 9 matches keccak(pad(addr)++pad(9))", () => {
    const addr = "0x0000000000000000000000000000000000000001";
    const expected = keccak256(hexToBytes("00".repeat(31) + "01" + "00".repeat(31) + "09"));
    expect(usdcBalanceSlot(addr)).toBe(expected);
  });
  test("slot is case-insensitive and rejects bad input", () => {
    const a = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    expect(usdcBalanceSlot(a)).toBe(usdcBalanceSlot(a.toLowerCase()));
    expect(() => usdcBalanceSlot("0x12")).toThrow();
  });
  test("balance word is 32 bytes, blacklist bit clear, range checked", () => {
    expect(usdcBalanceWord(1_000_000n)).toBe("0x" + "0".repeat(58) + "0f4240");
    expect(() => usdcBalanceWord(-1n)).toThrow();
    expect(() => usdcBalanceWord(1n << 255n)).toThrow();
  });
});

describe("argv", () => {
  const o = { port: 8545, chainId: 918453, upstream: "https://mainnet.base.org", pinBlock: 123, retries: 10, forkRetryBackoffMs: 1000, computeUnitsPerSecond: 50 };
  test("builds lazy-fork argv", () => {
    const a = buildAnvilArgv(o);
    expect(a.slice(0, 6)).toEqual(["--fork-url", "https://mainnet.base.org", "--fork-block-number", "123", "--chain-id", "918453"]);
    expect(a).toContain("--retries");
    expect(a[a.indexOf("--fork-retry-backoff") + 1]).toBe("1000");
    expect(a[a.indexOf("--compute-units-per-second") + 1]).toBe("50");
    expect(a).not.toContain("--state");
    expect(a).not.toContain("--load-state");
  });
  test("rejects a bad pin or port", () => {
    expect(buildAnvilArgv(o)).not.toContain("--block-time");
    const t = buildAnvilArgv({ ...o, blockTimeSec: 1 });
    expect(t[t.indexOf("--block-time") + 1]).toBe("1");
    expect(() => buildAnvilArgv({ ...o, pinBlock: 0 })).toThrow();
    expect(() => buildAnvilArgv({ ...o, port: 70000 })).toThrow();
  });
  test("redactArgv hides the URL", () => {
    const a = redactArgv(buildAnvilArgv({ ...o, upstream: "https://x.example/v2/SECRETKEY" }));
    expect(a.join(" ")).not.toContain("SECRETKEY");
    expect(a).toContain("<x.example>");
  });
});

describe("pin selection", () => {
  const head = (n: number) => ({
    eth_blockNumber: () => "0x" + n.toString(16),
    eth_getBlockByNumber: (p: any[]) => ({ hash: "0xabc", timestamp: "0x64", number: p[0] }),
  });
  test("auto = head minus 2", async () => {
    const pin = await selectPin("https://u.example/KEY123", "auto", { fetcher: stub(head(1000)) });
    expect(pin).toEqual({ block: 998, hash: "0xabc", timestamp: 100, upstreamHost: "u.example" });
    expect(JSON.stringify(pin)).not.toContain("KEY123");
  });
  test("explicit pin is used as is", async () => {
    const calls: string[] = [];
    const pin = await selectPin("https://u.example", 77, { fetcher: stub(head(1000), calls) });
    expect(pin.block).toBe(77);
    expect(calls).not.toContain("eth_blockNumber");
  });
  test("retries on 429 then succeeds", async () => {
    let n = 0;
    const f = stub({ eth_blockNumber: () => (++n < 3 ? new Response("slow", { status: 429 }) : "0x10") });
    expect(await rpc("https://u.example", "eth_blockNumber", [], { fetcher: f, baseDelayMs: 1 })).toBe("0x10");
    expect(n).toBe(3);
  });
  test("gives up with a redacted error", async () => {
    const f = (async () => { throw new Error("connect https://u.example/KEY123 refused"); }) as unknown as typeof fetch;
    const e = await rpc("https://u.example/KEY123", "eth_blockNumber", [], { fetcher: f, retries: 1, baseDelayMs: 1 }).catch((x) => x);
    expect(String(e.message)).not.toContain("KEY123");
  });
});

describe("stale pin", () => {
  const stale = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "missing trie node abc (path ) state is not available" } }));
  const handlers = (served: (block: string) => boolean) => ({
    eth_getBalance: (p: any[]) => (served(p[1]) ? "0x0" : stale()),
    eth_blockNumber: () => "0x3e8",
    eth_getBlockByNumber: (p: any[]) => ({ hash: "0xdef", timestamp: "0x64", number: p[0] }),
  });
  const old = { block: 500, hash: "0xabc", timestamp: 1, upstreamHost: "u.example" };
  test("recognises stale-state text", () => {
    expect(isStalePinText("missing trie node 0x12")).toBe(true);
    expect(isStalePinText("rate limited")).toBe(false);
  });
  test("a served pin is kept", async () => {
    const r = await repinIfStale("https://u.example/KEY", old, true, { fetcher: stub(handlers(() => true)) });
    expect(r).toEqual({ pin: old, repinned: false });
  });
  test("a stale pin is re-pinned to head minus 2 with a loud WARN and no URL", async () => {
    const warns: string[] = [];
    const r = await repinIfStale("https://u.example/KEY123", old, true, {
      fetcher: stub(handlers((b) => b !== "0x1f4")), warn: (m) => warns.push(m),
    });
    expect(r.repinned).toBe(true);
    expect(r.pin.block).toBe(998);
    expect(warns[0]).toMatch(/^WARN: STALE PIN/);
    expect(warns[0]).toContain("500");
    expect(warns[0]).toContain("998");
    expect(warns.join("")).not.toContain("KEY123");
  });
  test("with repin off a stale pin is an error", async () => {
    await expect(repinIfStale("https://u.example", old, false, { fetcher: stub(handlers(() => false)) })).rejects.toThrow(/no longer serves/);
  });
  test("other RPC errors are not treated as stale", async () => {
    const f = stub({ eth_getBalance: () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "boom" } })) });
    await expect(pinStateServed("https://u.example", 5, { fetcher: f })).rejects.toThrow(/boom/);
  });
});

describe("warp", () => {
  test("refuses on chain id 8453 and never advances time", async () => {
    const calls: string[] = [];
    const f = stub({ eth_chainId: () => "0x2105", evm_increaseTime: () => 0, evm_mine: () => "0x0" }, calls);
    await expect(warp("http://127.0.0.1:8545", 86400, { fetcher: f })).rejects.toThrow(/8453/);
    expect(calls).not.toContain("evm_increaseTime");
  });
  test("warps on the twin chain", async () => {
    const calls: string[] = [];
    const f = stub({
      eth_chainId: () => "0xe0e35", evm_increaseTime: () => 1, evm_mine: () => "0x0",
      eth_getBlockByNumber: () => ({ timestamp: "0x3e8" }),
    }, calls);
    expect((await warp("http://127.0.0.1:8545", 259200, { fetcher: f })).timestamp).toBe(1000);
    expect(calls).toEqual(["eth_chainId", "evm_increaseTime", "evm_mine", "eth_getBlockByNumber"]);
  });
  test("rejects non-positive seconds", async () => {
    await expect(warp("http://x", 0)).rejects.toThrow();
  });
});

describe("redaction and units", () => {
  test("urlHost and redact keep host only", () => {
    expect(urlHost("https://eth.example.io/v2/abc?key=1")).toBe("eth.example.io");
    expect(redact("failed https://eth.example.io/v2/abc?key=1 now")).toBe("failed <eth.example.io> now");
    expect(redact("token SECRETVALUE here", ["SECRETVALUE"])).toBe("token <redacted> here");
  });
  test("ethToWei", () => {
    expect(ethToWei("1")).toBe(10n ** 18n);
    expect(ethToWei("0.5")).toBe(5n * 10n ** 17n);
    expect(() => ethToWei("1e3")).toThrow();
  });
});

describe("twin-fork.ts start --repin-on-stale (stub upstream, fake anvil)", () => {
  test("warns, re-pins to head minus 2 and hands anvil the new block", async () => {
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync((await import("node:os")).tmpdir() + "/twin-repin-");
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const { method, params } = await req.json() as any;
        const ok = (result: any) => Response.json({ jsonrpc: "2.0", id: 1, result });
        if (method === "eth_getBalance") return Response.json({ jsonrpc: "2.0", id: 1, error: { message: params[1] === "0x1f4" ? "missing trie node" : "x" } });
        if (method === "eth_blockNumber") return ok("0x3e8");
        return ok({ hash: "0xdef", timestamp: "0x64" });
      },
    });
    try {
      fs.mkdirSync(dir + "/bin");
      fs.writeFileSync(dir + "/bin/anvil", `#!/bin/sh\necho "$@" > ${dir}/argv\nexit 1\n`, { mode: 0o755 });
      const run = async (...extra: string[]) => { const pr = Bun.spawn(["bun", import.meta.dir + "/twin-fork.ts", "start", "--upstream", `http://127.0.0.1:${server.port}/KEY123`,
        "--pin-block", "500", "--state-dir", dir + "/s", "--ready-timeout", "1500", "--start-attempts", "1", "--port", "18599", ...extra],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, CI: "", GITHUB_ACTIONS: "" } });
        const [o, e] = await Promise.all([new Response(pr.stdout).text(), new Response(pr.stderr).text()]);
        return { exitCode: await pr.exited, out: o + e }; };
      const off = await run();
      expect(off.exitCode).toBe(1);
      expect(off.out).toMatch(/no longer serves/);
      const on = await run("--repin-on-stale");
      const out = on.out;
      expect(out).toMatch(/WARN: STALE PIN.*500.*998/);
      expect(out).not.toContain("KEY123");
      expect(fs.readFileSync(dir + "/argv", "utf8")).toContain("--fork-block-number 998");
    } finally {
      server.stop(true);
    }
  }, 60000);
});

describe.skipIf(process.env.TWIN_FORK_SMOKE !== "1")("smoke (needs anvil and the public Base endpoint; TWIN_FORK_SMOKE=1)", () => {
  test("start, fund USDC, warp, stop", async () => {
    const dir = (await import("node:fs")).mkdtempSync((await import("node:os")).tmpdir() + "/twin-smoke-");
    const tool = import.meta.dir + "/twin-fork.ts";
    const port = "18545";
    const common = ["--port", port, "--state-dir", dir + "/s", "--cache-dir", dir + "/cache", "--pin-file", dir + "/pin.json"];
    const run = (...a: string[]) => Bun.spawnSync(["bun", tool, ...a, ...common], { stderr: "pipe", stdout: "pipe" });
    try {
      expect(run("start").exitCode).toBe(0);
      const url = `http://127.0.0.1:${port}`;
      const pin = JSON.parse(await Bun.file(dir + "/pin.json").text());
      expect(parseInt(await rpc(url, "eth_chainId"), 16)).toBe(918453);
      expect(parseInt(await rpc(url, "eth_blockNumber"), 16)).toBe(pin.block);
      const who = "0x00000000000000000000000000000000000d00d1";
      expect(run("fund-usdc", who, "5000000").exitCode).toBe(0);
      expect(run("warp", "259200").exitCode).toBe(0);
    } finally {
      run("stop");
    }
  }, 240000);
});

describe("resolveUpstream", () => {
  test("empty, whitespace and unset all give the public default", () => {
    expect(resolveUpstream(undefined, "")).toBe(DEFAULT_UPSTREAM);
    expect(resolveUpstream("", "   ")).toBe(DEFAULT_UPSTREAM);
    expect(resolveUpstream(undefined, undefined)).toBe(DEFAULT_UPSTREAM);
    expect(resolveUpstream(null, "\n\t")).toBe(DEFAULT_UPSTREAM);
  });
  test("a set value is used (explicit first, then env) and trimmed", () => {
    expect(resolveUpstream(undefined, " https://up.example/key123 ")).toBe("https://up.example/key123");
    expect(resolveUpstream("https://a.example/x", "https://b.example/y")).toBe("https://a.example/x");
  });
  test("a set value is never logged, only its host", () => {
    const secret = "https://rpc.example/very-secret-key";
    expect(redact(`failed at ${secret}`, [secret])).not.toContain("very-secret-key");
    expect(urlHost(secret)).toBe("rpc.example");
  });
});
