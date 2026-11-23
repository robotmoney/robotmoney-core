// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.4 (Alerts, Log).
// One JSON line on stderr per alert and a POST to the webhook when set. The same kind and cause alerts once, again
// every realertSecs while it holds, and once on recovery. Log lines are JSON on stderr too. No secret is ever passed in.

export type AlertKind =
  | "keeper_unconfigured" | "queue_paused" | "low_gas" | "gas_price_high" | "settle_reverted" | "step_reverted"
  | "delist_step_reverted" | "send_failed" | "tx_stuck" | "rpc_unreadable" | "epoch_overdue";

export interface ActiveAlert { since: number; last: number }

export interface AlertsOptions {
  realertSecs: number;
  webhook?: string;
  queue?: string;
  write?: (line: string) => void;
  now?: () => number;
  post?: (url: string, body: string) => Promise<unknown>;
  active?: Record<string, ActiveAlert>;
}

const defaultPost = (url: string, body: string) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000) });

export class Alerts {
  readonly active: Record<string, ActiveAlert>;
  /** Alerts emitted since the last takeCount(), recoveries excluded. */
  private count = 0;
  private readonly write: (line: string) => void;
  private readonly now: () => number;
  private readonly post: (url: string, body: string) => Promise<unknown>;

  constructor(private readonly o: AlertsOptions) {
    this.active = o.active ?? {};
    this.write = o.write ?? ((l) => process.stderr.write(l + "\n"));
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.post = o.post ?? defaultPost;
  }

  /** Raises `kind` for `cause`. Returns true when a line was emitted (not deduped). */
  raise(kind: AlertKind, cause: string, detail: Record<string, unknown> = {}): boolean {
    const key = `${kind}:${cause}`;
    const t = this.now();
    const a = this.active[key];
    if (a && t - a.last < this.o.realertSecs) return false;
    this.active[key] = { since: a?.since ?? t, last: t };
    this.count++;
    this.emit({ alert: kind, cause, queue: this.o.queue, ...detail, repeat: !!a, ts: t });
    return true;
  }

  /** Clears `kind` for `cause` and emits one recovery line when it was active. */
  resolve(kind: AlertKind, cause: string): void {
    const key = `${kind}:${cause}`;
    const a = this.active[key];
    if (!a) return;
    delete this.active[key];
    const t = this.now();
    this.emit({ alert: kind, cause, queue: this.o.queue, recovered: true, activeSecs: t - a.since, ts: t });
  }

  takeCount(): number {
    const c = this.count;
    this.count = 0;
    return c;
  }

  private emit(obj: Record<string, unknown>): void {
    const line = JSON.stringify(obj, bigintJson);
    this.write(line);
    if (this.o.webhook) {
      this.post(this.o.webhook, line).then(
        (r: any) => { if (r && r.ok === false) log("webhook_failed", { status: r.status }); },
        () => log("webhook_failed", {}),
      );
    }
  }
}

export const bigintJson = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

let logWriter: (line: string) => void = (l) => process.stderr.write(l + "\n");
export const setLogWriter = (w: (line: string) => void) => { logWriter = w; };

/** One JSON log line. */
export function log(event: string, fields: Record<string, unknown>): void {
  logWriter(JSON.stringify({ event, ...fields, ts: Math.floor(Date.now() / 1000) }, bigintJson));
}
