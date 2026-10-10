// Source scan (issue 1729): every write goes through useGuardedWriteContract.
// A module that imports wagmi's raw write hooks, or sends a transaction through
// a viem wallet client, bypasses the wrong-chain guard. Runs in the node project.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
// The guard hook itself, and the faucet (refused on every mainnet-class chain by
// chainClassifier, issue 261) are the only allowed users of raw write APIs.
const ALLOWED = new Set(["lib/useGuardedWriteContract.ts", "lib/faucetClient.ts"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe("single guarded write path", () => {
  const files = walk(SRC).map((p) => [relative(SRC, p), readFileSync(p, "utf8")] as const);

  it("scans the source tree", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no module outside the guard imports a raw wagmi write hook", () => {
    const offenders = files
      .filter(([f]) => !ALLOWED.has(f))
      .filter(([, s]) =>
        /import\s*\{[^}]*\b(useWriteContract|useSendTransaction)\b[^}]*\}\s*from\s*"wagmi"/.test(s),
      )
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it("no module outside the guard uses another way to send a transaction", () => {
    const offenders = files
      .filter(([f]) => !ALLOWED.has(f))
      .filter(([, s]) =>
        /\b(createWalletClient|useWalletClient|useSendTransaction)\b|from\s*"wagmi\/actions"/.test(
          s,
        ),
      )
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it("every component that writes uses the guarded hook", () => {
    const writers = files.filter(([, s]) => /useGuardedWriteContract\(\)/.test(s)).map(([f]) => f);
    expect(writers.length).toBeGreaterThanOrEqual(11);
  });
});
