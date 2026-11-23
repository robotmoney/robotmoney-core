// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.5 (One instance, State).
// A lock file holds the pid: a second live instance on the same state dir exits 2. A stale lock (dead pid) is taken
// over. The state file is small JSON, written atomically, and rebuilt from the chain when missing.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ActiveAlert } from "./alerts.ts";
import { bigintJson } from "./alerts.ts";

export class LockError extends Error {
  readonly exitCode = 2;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Takes the lock and returns its release function. */
export function acquireLock(stateDir: string, pid = process.pid): () => void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, "keeper.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, "utf8").trim() === String(pid)) unlinkSync(path);
        } catch { /* already gone */ }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(held) && held > 0 && alive(held)) {
        throw new LockError(`another keeper (pid ${held}) holds ${path}`);
      }
      unlinkSync(path); // stale: the holder is gone
    }
  }
  throw new LockError(`cannot take ${path}`);
}

export interface PendingSend { duty: string; hash: string; nonce: number; sentAt: number }

export interface KeeperState {
  lastTickAt: number;
  lastSettleAt: number;
  pending: PendingSend[];
  alerts: Record<string, ActiveAlert>;
}

export const emptyState = (): KeeperState => ({ lastTickAt: 0, lastSettleAt: 0, pending: [], alerts: {} });

export function loadState(stateDir: string): KeeperState {
  const path = join(stateDir, "state.json");
  if (!existsSync(path)) return emptyState();
  try {
    return { ...emptyState(), ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return emptyState(); // a corrupt file is rebuilt, like a missing one
  }
}

export function saveState(stateDir: string, s: KeeperState): void {
  const path = join(stateDir, "state.json");
  writeFileSync(path + ".tmp", JSON.stringify(s, bigintJson), { mode: 0o600 });
  renameSync(path + ".tmp", path);
}
