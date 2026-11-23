// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.4. The same kind and cause alerts once, again every
// realertSecs while it holds, and once on recovery.
import { describe, expect, test } from "bun:test";
import { Alerts } from "../src/alerts.ts";

function setup() {
  let t = 1000;
  const lines: any[] = [];
  const posts: string[] = [];
  const a = new Alerts({
    realertSecs: 600, queue: "0xq", webhook: "http://hook", now: () => t,
    write: (l) => lines.push(JSON.parse(l)), post: async (_u, b) => { posts.push(b); return { ok: true }; },
  });
  return { a, lines, posts, advance: (s: number) => { t += s; } };
}

describe("alerts", () => {
  test("one line per kind and cause, deduped until realertSecs", () => {
    const { a, lines, advance } = setup();
    expect(a.raise("low_gas", "min", { balanceWei: 1n })).toBe(true);
    expect(a.raise("low_gas", "min")).toBe(false);
    advance(599);
    expect(a.raise("low_gas", "min")).toBe(false);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ alert: "low_gas", cause: "min", balanceWei: "1", repeat: false });
    advance(1);
    expect(a.raise("low_gas", "min")).toBe(true);
    expect(lines[1]).toMatchObject({ alert: "low_gas", repeat: true });
  });

  test("a different cause or kind is not deduped", () => {
    const { a, lines } = setup();
    a.raise("delist_step_reverted", "delist_step:1");
    a.raise("delist_step_reverted", "delist_step:2");
    a.raise("low_gas", "delist_step:1");
    expect(lines.length).toBe(3);
  });

  test("recovery emits exactly one line, and only for an active alert", () => {
    const { a, lines, advance } = setup();
    a.resolve("epoch_overdue", "queue");
    expect(lines.length).toBe(0);
    a.raise("epoch_overdue", "queue");
    advance(120);
    a.resolve("epoch_overdue", "queue");
    a.resolve("epoch_overdue", "queue");
    expect(lines.length).toBe(2);
    expect(lines[1]).toMatchObject({ alert: "epoch_overdue", recovered: true, activeSecs: 120 });
    a.raise("epoch_overdue", "queue");
    expect(lines.length).toBe(3); // after recovery it alerts at once again
  });

  test("every line goes to the webhook; takeCount counts alerts, not recoveries", async () => {
    const { a, posts } = setup();
    a.raise("tx_stuck", "settle");
    a.resolve("tx_stuck", "settle");
    await Bun.sleep(0);
    expect(posts.length).toBe(2);
    expect(a.takeCount()).toBe(1);
    expect(a.takeCount()).toBe(0);
  });
});
