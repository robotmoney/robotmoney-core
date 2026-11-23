// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.6. Config parsing: JSON and TOML load, env overrides
// apply, invalid fields and a chainId mismatch exit 2.
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildConfig, checkChainId, checkManifest, ConfigError, envName, loadConfig } from "../src/config.ts";
import { runCli, fakeRpc } from "./helpers/cli.ts";
import { fixtureKeystore, tmp } from "./helpers/fixtures.ts";

const Q = "0x1111111111111111111111111111111111111111";
const R = "0x2222222222222222222222222222222222222222";
const K = "0x3333333333333333333333333333333333333333";
const base = { rpcUrl: "http://127.0.0.1:8545", chainId: 8453, queue: Q, rebalancer: R, keystore: "/k.json", stateDir: "/s" };
const dir = tmp();

describe("config", () => {
  test("a JSON file loads, with the defaults of §8.1.6", () => {
    const p = join(dir, "k.json");
    writeFileSync(p, JSON.stringify({ ...base, maxRequests: 50, maxUsdc: "1000000000" }));
    const c = loadConfig(p, {});
    expect(c.chainId).toBe(8453);
    expect(c.queue).toBe(Q);
    expect(c.keeperAccount).toBeUndefined();
    expect(c.maxRequests).toBe(50n);
    expect(c.maxUsdc).toBe(1_000_000_000n);
    expect(c.intervalSecs).toBe(300);
    expect(c.fastPollSecs).toBe(30);
    expect(c.gasMultiplier).toBe(1.5);
    expect(c.overdueSecs).toBe(900);
    expect(c.runwaySettles).toBe(10);
    expect(c.rpcFallbackUrls).toEqual([]);
  });

  test("a TOML file loads", () => {
    const p = join(dir, "k.toml");
    writeFileSync(p, `rpcUrl = "http://127.0.0.1:8545"\nrpcFallbackUrls = ["https://a.example", "https://b.example"]\nchainId = 8453\n` +
      `queue = "${Q}"\nrebalancer = "${R}"\nkeeperAccount = "${K}"\nkeystore = "/k.json"\nstateDir = "/s"\nintervalSecs = 60\n`);
    const c = loadConfig(p, {});
    expect(c.keeperAccount).toBe(K);
    expect(c.intervalSecs).toBe(60);
    expect(c.rpcFallbackUrls).toEqual(["https://a.example", "https://b.example"]);
  });

  test("environment overrides apply per field", () => {
    expect(envName("rpcUrl")).toBe("KEEPER_RPC_URL");
    const c = buildConfig(base, {
      KEEPER_RPC_URL: "https://override.example", KEEPER_INTERVAL_SECS: "42", KEEPER_KEEPER_ACCOUNT: K,
      KEEPER_RPC_FALLBACK_URLS: "https://x.example, https://y.example", KEEPER_MIN_GAS_WEI: "123456789012345678901",
    });
    expect(c.rpcUrl).toBe("https://override.example");
    expect(c.intervalSecs).toBe(42);
    expect(c.keeperAccount).toBe(K);
    expect(c.rpcFallbackUrls).toEqual(["https://x.example", "https://y.example"]);
    expect(c.minGasWei).toBe(123456789012345678901n);
  });

  test.each([
    ["a missing required field", { ...base, queue: undefined }],
    ["a malformed address", { ...base, queue: "not-an-address" }],
    ["a non-URL rpcUrl", { ...base, rpcUrl: "localhost:8545" }],
    ["a fractional interval", { ...base, intervalSecs: 1.5 }],
    ["a zero chainId", { ...base, chainId: 0 }],
    ["a gas multiplier below 1", { ...base, gasMultiplier: 0.5 }],
    ["a negative maxUsdc", { ...base, maxUsdc: "-1" }],
    ["an unknown field", { ...base, rpc: "x" }],
  ])("%s is a ConfigError with exit code 2", (_n, file) => {
    let err: unknown;
    try { buildConfig(file as Record<string, unknown>, {}); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).exitCode).toBe(2);
  });

  test("an unparsable file is a ConfigError", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ not json");
    expect(() => loadConfig(p, {})).toThrow(ConfigError);
  });

  test("a chainId mismatch and a manifest without the addresses are ConfigErrors", () => {
    const c = buildConfig(base, {});
    expect(() => checkChainId(c, 1)).toThrow(ConfigError);
    expect(() => checkChainId(c, 8453)).not.toThrow();
    expect(() => checkManifest(c, JSON.stringify({ queue: Q, rebalancer: R }))).not.toThrow();
    expect(() => checkManifest(c, JSON.stringify({ queue: Q }))).toThrow(ConfigError);
  });
});

describe("cli exit 2", () => {
  const rpc = fakeRpc(1);
  afterAll(() => rpc.stop());

  test("an invalid field exits 2 with keeper_unconfigured and reads nothing", async () => {
    const r = await runCli([], { KEEPER_RPC_URL: "nope", KEEPER_CHAIN_ID: "8453", KEEPER_QUEUE: Q, KEEPER_REBALANCER: R, KEEPER_KEYSTORE: "/x", KEEPER_STATE_DIR: tmp() });
    expect(r.code).toBe(2);
    expect(r.err).toContain('"alert":"keeper_unconfigured"');
  });

  test("a chainId mismatch with the RPC exits 2", async () => {
    const d = tmp();
    const ks = fixtureKeystore(d);
    const r = await runCli([], {
      KEEPER_RPC_URL: rpc.url, KEEPER_CHAIN_ID: "8453", KEEPER_QUEUE: Q, KEEPER_REBALANCER: R, KEEPER_KEYSTORE: ks.keystore,
      KEEPER_PASSWORD_FILE: ks.passwordFile, KEEPER_STATE_DIR: join(d, "state"), KEEPER_HEALTH_PORT: "0",
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("chainId mismatch");
  });
});
