// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.4 (Health endpoint, Metrics).
import { afterEach, describe, expect, test } from "bun:test";
import { Metrics, startHealthServer, type HealthServer } from "../src/health.ts";

let srv: HealthServer | undefined;
afterEach(() => srv?.stop());

describe("health and metrics", () => {
  test("/healthz is 200 within 2 × intervalSecs of the last tick and 503 otherwise", async () => {
    const m = new Metrics();
    let now = 10_000;
    srv = startHealthServer(m, 300, 0, () => now);
    const get = () => fetch(`http://127.0.0.1:${srv!.port}/healthz`);
    expect((await get()).status).toBe(503); // no tick yet
    m.lastTickAt = 10_000;
    m.balanceWei = 5n;
    const ok = await get();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, lastTickAt: 10_000, balanceWei: "5" });
    now = 10_600;
    expect((await get()).status).toBe(200);
    now = 10_601;
    expect((await get()).status).toBe(503);
    now = 10_000;
    m.unconfigured = true;
    expect((await get()).status).toBe(503);
  });

  test("/metrics exposes ticks, sends, reverts, gas, fees, balance and seconds since the last settle", async () => {
    const m = new Metrics();
    m.ticks = 3;
    m.balanceWei = 123n;
    m.sent("settle", 2_000_000n, 9_000n, 9_900);
    m.reverted("settle", 2_299_380n, 1_000n);
    m.skip("settle:1");
    srv = startHealthServer(m, 300, 0, () => 10_000);
    const r = await fetch(`http://127.0.0.1:${srv.port}/metrics`);
    const t = await r.text();
    expect(r.status).toBe(200);
    expect(t).toContain("keeper_ticks_total 3");
    expect(t).toContain('keeper_sends_total{duty="settle"} 1');
    expect(t).toContain('keeper_reverts_total{duty="settle"} 1');
    expect(t).toContain('keeper_gas_used_total{duty="settle"} 4299380');
    expect(t).toContain('keeper_fees_wei_total{duty="settle"} 10000');
    expect(t).toContain("keeper_balance_wei 123");
    expect(t).toContain("keeper_seconds_since_last_settle 100");
    expect(t).toContain('keeper_skips_total{code="settle:1"} 1');
  });

  test("the server listens on localhost only", async () => {
    srv = startHealthServer(new Metrics(), 300, 0);
    expect((await fetch(`http://127.0.0.1:${srv.port}/nope`)).status).toBe(404);
  });
});
