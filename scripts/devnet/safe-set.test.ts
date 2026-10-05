// Canonical: core issue 1447. Offline unit tests for safe-set.ts (stubbed chain, no network).
// Run: bun test scripts/devnet/safe-set.test.ts --timeout 60000
import { describe, expect, test } from "bun:test";
import { SAFE_SET, safeSetProblems, type ChainRead, type SafeContract } from "./safe-set.ts";
import { keccak256, hexToBytes } from "./twin-fork-lib.ts";

// A synthetic set: tiny fake "code" per contract, hashed here, so the test needs no real Base state.
const codeOf = (name: string) => "0x60" + Buffer.from(name).toString("hex");
const hashOf = (code: string) => keccak256(hexToBytes(code.replace(/^0x/, "")));
const SET: SafeContract[] = SAFE_SET.map((c) => ({ ...c, codeHash: hashOf(codeOf(c.name)) }));
const ONE = "0x" + "0".repeat(63) + "1";
const ZERO = "0x" + "0".repeat(64);

function chain(over: { code?: Record<string, string>; slot4?: Record<string, string> } = {}): ChainRead {
  return {
    code: async (a) => over.code?.[a] ?? codeOf(SET.find((c) => c.address === a)!.name),
    storageAt: async (a) => over.slot4?.[a] ?? ONE,
  };
}

describe("safeSetProblems", () => {
  test("pinned hashes cover five contracts, two singletons", () => {
    expect(SAFE_SET.length).toBe(5);
    expect(SAFE_SET.filter((c) => c.singleton).length).toBe(2);
    for (const c of SAFE_SET) expect(c.codeHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
  test("all canonical and locked: no problem", async () => {
    expect(await safeSetProblems(chain(), SET)).toEqual([]);
  });
  test("a code-less contract is named", async () => {
    const l2 = SET[1].address;
    const p = await safeSetProblems(chain({ code: { [l2]: "0x" } }), SET);
    expect(p.length).toBe(1);
    expect(p[0]).toContain("SafeL2 singleton");
  });
  test("the wrong contract at an address is refused (presence is not enough)", async () => {
    const l2 = SET[1].address;
    const p = await safeSetProblems(chain({ code: { [l2]: codeOf(SET[0].name) } }), SET);
    expect(p.length).toBe(1);
    expect(p[0]).toContain("not the canonical v1.4.1 code hash");
  });
  test("one changed byte of the factory code is refused", async () => {
    const f = SET[2].address;
    const p = await safeSetProblems(chain({ code: { [f]: codeOf(SET[2].name) + "00" } }), SET);
    expect(p.length).toBe(1);
    expect(p[0]).toContain("SafeProxyFactory");
  });
  test("an unlocked singleton is refused", async () => {
    const l2 = SET[1].address;
    const p = await safeSetProblems(chain({ slot4: { [l2]: ZERO } }), SET);
    expect(p.length).toBe(1);
    expect(p[0]).toContain("is unlocked");
    const l1 = SET[0].address;
    const p2 = await safeSetProblems(chain({ slot4: { [l1]: "0x" + "0".repeat(63) + "2" } }), SET);
    expect(p2[0]).toContain("Safe singleton (L1)");
  });
  test("a non-singleton is not checked for the lock", async () => {
    const f = SET[2].address;
    expect(await safeSetProblems(chain({ slot4: { [f]: ZERO } }), SET)).toEqual([]);
  });
});
