#!/usr/bin/env bun
// Canonical: core issues 1498, 1496. Twin chain (id 918453) = pinned lazy fork of real Base state.
// Usage: bun scripts/devnet/twin-fork.ts <start|wait-ready|stop|status|fund-gas|fund-usdc|warp> [...]
// See scripts/devnet/README-twin-fork.md. Logs show the upstream host only, never a URL.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import {
  DEFAULT_UPSTREAM, TWIN_CHAIN_ID, buildAnvilArgv, fundGas, fundUsdc, redact, redactArgv, rpc,
  isStalePinText, repinIfStale, selectPin, spawnAnvilDetached, urlHost, usdcBalanceOf, waitReady, warp,
} from "./twin-fork-lib.ts";

const opts = {
  port: { type: "string", default: "8545" },
  "chain-id": { type: "string", default: String(TWIN_CHAIN_ID) },
  upstream: { type: "string" },
  "pin-block": { type: "string", default: "auto" },
  "cache-dir": { type: "string" },
  "pin-file": { type: "string" },
  "state-dir": { type: "string" },
  retries: { type: "string", default: "10" },
  "fork-retry-backoff": { type: "string", default: "1000" },
  "compute-units-per-second": { type: "string", default: "50" },
  timeout: { type: "string", default: "45000" },
  "ready-timeout": { type: "string", default: "120000" },
  "start-attempts": { type: "string", default: "4" },
  host: { type: "string", default: "127.0.0.1" },
  "block-time": { type: "string" },
  "rpc-url": { type: "string" },
  // Stale pin handling: default on in CI, off locally.
  "repin-on-stale": { type: "boolean" },
  "no-repin-on-stale": { type: "boolean" },
  "stop-timeout": { type: "string", default: "90000" },
} as const;

const { values: v, positionals } = parseArgs({ args: Bun.argv.slice(2), options: opts, allowPositionals: true });
const [cmd, ...rest] = positionals;
const port = Number(v.port);
// An explicit --rpc-url (or TWIN_RPC_URL) lets fund-gas, fund-usdc and warp reach a fork this tool did not start.
const localUrl = `http://127.0.0.1:${port}`;
const rpcUrl = v["rpc-url"] ?? process.env.TWIN_RPC_URL ?? `http://127.0.0.1:${port}`;
const stateDir = resolve(v["state-dir"] ?? join(process.env.TMPDIR ?? tmpdir(), `twin-fork-${port}`));
const pidFile = join(stateDir, "anvil.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secrets = process.env.BASE_UPSTREAM_RPC ? [process.env.BASE_UPSTREAM_RPC] : [];
const log = (m: string) => console.log(redact(m, secrets));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readState = (): { pid: number; pin: any } | null => (existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, "utf8")) : null);

async function start() {
  const upstream = v.upstream || process.env.BASE_UPSTREAM_RPC || DEFAULT_UPSTREAM;
  const prev = readState();
  if (prev && alive(prev.pid)) throw new Error(`already running (pid ${prev.pid}); run stop first`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const repinOn = v["no-repin-on-stale"] ? false : (v["repin-on-stale"] ?? Boolean(process.env.CI || process.env.GITHUB_ACTIONS));
  let pin = await selectPin(upstream, v["pin-block"] === "auto" ? "auto" : Number(v["pin-block"]), { secrets });
  if (v["pin-block"] !== "auto") {
    const r = await repinIfStale(upstream, pin, repinOn, { secrets, warn: (m) => console.warn(redact(m, secrets)) });
    pin = r.pin;
  }
  log(`pin block ${pin.block} hash ${pin.hash} ts ${pin.timestamp} upstream ${pin.upstreamHost}`);
  const argv = buildAnvilArgv({
    port, chainId: Number(v["chain-id"]), upstream, pinBlock: pin.block, host: v.host,
    retries: Number(v.retries), forkRetryBackoffMs: Number(v["fork-retry-backoff"]),
    computeUnitsPerSecond: Number(v["compute-units-per-second"]), timeoutMs: Number(v.timeout),
    blockTimeSec: v["block-time"] ? Number(v["block-time"]) : undefined,
  });
  log(`anvil ${redactArgv(argv).join(" ")}`);
  // Anvil keeps its fork RPC cache under $HOME/.foundry/cache/rpc, so a cache dir is a HOME override.
  const env: Record<string, string> = {};
  if (v["cache-dir"]) {
    const home = resolve(v["cache-dir"]);
    mkdirSync(home, { recursive: true });
    env.HOME = home;
    // anvil needs no other file in HOME, but cast/forge reuse of this HOME would, so keep it cache-only.
  }
  const attempts = Number(v["start-attempts"]);
  let lastErr = "";
  let repinned = false;
  for (let a = 1; a <= attempts; a++) {
    const pid = spawnAnvilDetached(argv, env, join(stateDir, "anvil.log"));
    writeFileSync(pidFile, JSON.stringify({ pid, pin, port }), { mode: 0o600 });
    try {
      await waitReady(localUrl, pin.block, Number(v["ready-timeout"]), Number(v["chain-id"]), Boolean(v["block-time"]));
      if (v["pin-file"]) {
        mkdirSync(dirname(resolve(v["pin-file"])), { recursive: true });
        writeFileSync(v["pin-file"], JSON.stringify(pin, null, 2) + "\n");
      }
      log(`ready at ${localUrl} (pid ${pid})`);
      return;
    } catch (e: any) {
      lastErr = String(e?.message ?? e);
      try { process.kill(pid); } catch {}
      log(`start attempt ${a}/${attempts} failed: ${lastErr}`);
      // anvil may die on a stale pin only after the probe passed: read its log for the same error.
      const logText = existsSync(join(stateDir, "anvil.log")) ? readFileSync(join(stateDir, "anvil.log"), "utf8").slice(-8000) : "";
      if (repinOn && !repinned && v["pin-block"] !== "auto" && isStalePinText(logText + lastErr)) {
        repinned = true;
        const fresh = await selectPin(upstream, "auto", { secrets });
        console.warn(`WARN: STALE PIN. anvil could not serve pinned block ${pin.block} (state pruned). RE-PINNING to ${fresh.block}. Jobs of this run that used the old pin ran on a different block.`);
        pin = fresh;
        argv.splice(0, argv.length, ...buildAnvilArgv({
          port, chainId: Number(v["chain-id"]), upstream, pinBlock: pin.block, host: v.host,
          retries: Number(v.retries), forkRetryBackoffMs: Number(v["fork-retry-backoff"]),
          computeUnitsPerSecond: Number(v["compute-units-per-second"]), timeoutMs: Number(v.timeout),
          blockTimeSec: v["block-time"] ? Number(v["block-time"]) : undefined,
        }));
      }
      await sleep(2000 * a);
    }
  }
  throw new Error(`anvil did not become ready: ${lastErr}`);
}

async function stop() {
  const st = readState();
  if (!st || !alive(st.pid)) { log("not running"); rmSync(pidFile, { force: true }); return; }
  // anvil writes its RPC cache only on a graceful exit, so wait for it (SIGKILL loses the cache).
  process.kill(st.pid, "SIGTERM");
  const deadline = Date.now() + Number(v["stop-timeout"]);
  while (alive(st.pid) && Date.now() < deadline) await sleep(250);
  if (alive(st.pid)) { log("WARN: anvil did not exit in time, killing it (its RPC cache is lost)"); process.kill(st.pid, "SIGKILL"); }
  rmSync(pidFile, { force: true });
  log(`stopped pid ${st.pid}`);
}

async function status() {
  const st = readState();
  if (!st || !alive(st.pid)) { log("status: stopped"); process.exitCode = 1; return; }
  const [id, n] = [await rpc(rpcUrl, "eth_chainId", [], { retries: 1 }), await rpc(rpcUrl, "eth_blockNumber", [], { retries: 1 })];
  log(`status: running pid ${st.pid} chain ${parseInt(id, 16)} head ${parseInt(n, 16)} pin ${st.pin.block} upstream ${st.pin.upstreamHost}`);
}

async function main() {
  switch (cmd) {
    case "start": return start();
    case "wait-ready": {
      const st = readState();
      const pin = v["pin-block"] !== "auto" ? Number(v["pin-block"]) : st?.pin.block;
      if (!pin) throw new Error("need --pin-block N (or a running tool state)");
      await waitReady(rpcUrl, pin, Number(v["ready-timeout"]), Number(v["chain-id"]), true);
      return log("ready");
    }
    case "stop": return stop();
    case "status": return status();
    case "fund-gas": {
      const [addr, eth] = rest;
      if (!addr || !eth) throw new Error("usage: fund-gas <address> <eth>");
      return log(`balance now ${await fundGas(rpcUrl, addr, eth)} wei`);
    }
    case "fund-usdc": {
      const [addr, units] = rest;
      if (!addr || !/^\d+$/.test(units ?? "")) throw new Error("usage: fund-usdc <address> <usdc base units, 6 decimals>");
      return log(`USDC balanceOf now ${await fundUsdc(rpcUrl, addr, BigInt(units))}`);
    }
    case "warp": {
      const [secs] = rest;
      if (!/^\d+$/.test(secs ?? "")) throw new Error("usage: warp <seconds>");
      return log(`head timestamp now ${(await warp(rpcUrl, Number(secs))).timestamp}`);
    }
    case "balance-usdc": return log(String(await usdcBalanceOf(rpcUrl, rest[0])));
    default:
      throw new Error("usage: twin-fork.ts <start|wait-ready|stop|status|fund-gas|fund-usdc|warp> [flags]");
  }
}
main().catch((e) => { console.error(redact(String(e?.message ?? e), secrets)); process.exit(1); });
