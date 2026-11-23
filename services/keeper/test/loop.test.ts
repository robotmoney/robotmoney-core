// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.5. A second instance on the same state dir exits 2;
// SIGTERM during the wait exits 0 within 2 s.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runLoop } from "../src/loop.ts";
import { acquireLock, emptyState, LockError, loadState, saveState } from "../src/state.ts";
import { tmp } from "./helpers/fixtures.ts";

const CHILD = resolve(import.meta.dir, "helpers/loop-child.ts");

describe("lock and state", () => {
  test("a second lock on the same state dir is a LockError with exit code 2; release frees it", () => {
    const d = tmp();
    const release = acquireLock(d);
    let err: unknown;
    try { acquireLock(d); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(LockError);
    expect((err as LockError).exitCode).toBe(2);
    release();
    expect(existsSync(join(d, "keeper.lock"))).toBe(false);
    acquireLock(d)();
  });

  test("a stale lock (dead pid) is taken over", () => {
    const d = tmp();
    acquireLock(d, 999_999_999); // no such process
    acquireLock(d)();
  });

  test("state round-trips and a missing file starts empty", () => {
    const d = tmp();
    expect(loadState(d)).toEqual(emptyState());
    const s = { ...emptyState(), lastTickAt: 5, alerts: { "low_gas:min": { since: 1, last: 2 } } };
    saveState(d, s);
    expect(loadState(d)).toEqual(s);
  });
});

describe("loop", () => {
  test("a signal during the wait ends the loop at once", async () => {
    const sig = new EventEmitter();
    let ticks = 0;
    const t0 = Date.now();
    const done = runLoop({ tick: async () => { ticks++; return { nextWaitSecs: 3600 }; }, signals: sig });
    await Bun.sleep(50);
    sig.emit("SIGTERM");
    await done;
    expect(ticks).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("a signal during a tick lets the tick finish, then stops without waiting", async () => {
    const sig = new EventEmitter();
    let finished = false;
    const done = runLoop({
      tick: async () => { sig.emit("SIGINT"); await Bun.sleep(100); finished = true; return { nextWaitSecs: 3600 }; },
      signals: sig,
    });
    await done;
    expect(finished).toBe(true);
  });

  test("process: a second instance exits 2; SIGTERM mid-wait exits 0 within 2 s", async () => {
    const d = tmp();
    const first = Bun.spawn(["bun", CHILD, d], { stdout: "pipe", stderr: "pipe" });
    const reader = first.stdout.getReader();
    const { value } = await reader.read(); // "waiting" once the lock is held and the first tick is done
    expect(new TextDecoder().decode(value)).toContain("waiting");

    const second = Bun.spawn(["bun", CHILD, d], { stdout: "ignore", stderr: "pipe" });
    expect(await second.exited).toBe(2);

    const t0 = Date.now();
    first.kill("SIGTERM");
    expect(await first.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(existsSync(join(d, "keeper.lock"))).toBe(false);
  });
});
