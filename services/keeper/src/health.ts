// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.4 (Health endpoint, Metrics).
// GET /healthz: 200 while the last tick finished within 2 × intervalSecs and no start-up check failed, else 503.
// GET /metrics: Prometheus text. Both listen on 127.0.0.1 only.
import { bigintJson } from "./alerts.ts";

export class Metrics {
  ticks = 0;
  skips: Record<string, number> = {};
  sends: Record<string, number> = {};
  reverts: Record<string, number> = {};
  gasUsed: Record<string, bigint> = {};
  feesWei: Record<string, bigint> = {};
  balanceWei = 0n;
  nonce: number | undefined;
  lastTickAt = 0;
  lastSettleAt = 0;
  lastSend: Record<string, unknown> | undefined;
  unconfigured = false;

  skip(code: string) { this.skips[code] = (this.skips[code] ?? 0) + 1; }
  sent(duty: string, gasUsed: bigint, feeWei: bigint, at: number) {
    this.sends[duty] = (this.sends[duty] ?? 0) + 1;
    this.gasUsed[duty] = (this.gasUsed[duty] ?? 0n) + gasUsed;
    this.feesWei[duty] = (this.feesWei[duty] ?? 0n) + feeWei;
    if (duty === "settle") this.lastSettleAt = at;
  }
  reverted(duty: string, gasUsed: bigint, feeWei: bigint) {
    this.reverts[duty] = (this.reverts[duty] ?? 0) + 1;
    this.gasUsed[duty] = (this.gasUsed[duty] ?? 0n) + gasUsed;
    this.feesWei[duty] = (this.feesWei[duty] ?? 0n) + feeWei;
  }

  healthy(now: number, intervalSecs: number): boolean {
    return !this.unconfigured && this.lastTickAt > 0 && now - this.lastTickAt <= 2 * intervalSecs;
  }

  render(now: number): string {
    const out: string[] = [];
    const metric = (name: string, type: string, help: string, rows: [string, number | bigint][]) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, v] of rows) out.push(`${name}${labels} ${v}`);
    };
    const by = (label: string, m: Record<string, number | bigint>) =>
      Object.entries(m).map(([k, v]) => [`{${label}="${k}"}`, v] as [string, number | bigint]);
    metric("keeper_ticks_total", "counter", "Ticks finished.", [["", this.ticks]]);
    metric("keeper_skips_total", "counter", "Duties skipped, by check code.", by("code", this.skips));
    metric("keeper_sends_total", "counter", "Transactions mined with status 1, by duty.", by("duty", this.sends));
    metric("keeper_reverts_total", "counter", "Transactions mined with status 0, by duty.", by("duty", this.reverts));
    metric("keeper_gas_used_total", "counter", "Gas used by mined keeper transactions, by duty.", by("duty", this.gasUsed));
    metric("keeper_fees_wei_total", "counter", "Fees paid (L2 + L1) in wei, by duty.", by("duty", this.feesWei));
    metric("keeper_balance_wei", "gauge", "Gas balance of the keeper key.", [["", this.balanceWei]]);
    metric("keeper_last_tick_timestamp_seconds", "gauge", "Unix time of the last finished tick.", [["", this.lastTickAt]]);
    metric("keeper_seconds_since_last_settle", "gauge", "Seconds since the last mined settle (-1: none since start).",
      [["", this.lastSettleAt ? now - this.lastSettleAt : -1]]);
    metric("keeper_unconfigured", "gauge", "1 when a start-up check failed.", [["", this.unconfigured ? 1 : 0]]);
    return out.join("\n") + "\n";
  }
}

export interface HealthServer { port: number; stop(): void }

export function startHealthServer(m: Metrics, intervalSecs: number, port: number, now = () => Math.floor(Date.now() / 1000)): HealthServer {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const t = now();
      if (path === "/healthz") {
        const ok = m.healthy(t, intervalSecs);
        const body = JSON.stringify({ ok, lastTickAt: m.lastTickAt, balanceWei: m.balanceWei, nonce: m.nonce, lastSend: m.lastSend, unconfigured: m.unconfigured }, bigintJson);
        return new Response(body, { status: ok ? 200 : 503, headers: { "content-type": "application/json" } });
      }
      if (path === "/metrics") return new Response(m.render(t), { headers: { "content-type": "text/plain; version=0.0.4" } });
      return new Response("not found\n", { status: 404 });
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}
