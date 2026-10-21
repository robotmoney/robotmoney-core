// Issue 1750: the consensus receipt submitter is a multisig (a SafeL2 1.4.1 proxy). Issue 1888: on every chain and in every mode, and it MAY be the governing Safe.
// Covers the canonical-Safe check (every refusal has a mutation that passes). record-receipt in Safe mode is in record-receipt.test.ts. The real Safe runs on the Twin chain
// (testing/smoke-test/tests/twin_publish.rs), never here.
import { describe, expect, test } from "bun:test";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { SAFE_141 } from "../src/safe/constants.ts";
import { assertSubmitterSafe, forbiddenSubmitters, inspectSubmitterSafe, type SubmitterChain } from "../src/submitter-safe.ts";
import { A, addr } from "./govern-world.ts";
import { OWNERS, STANDIN, SUBSAFE, ZERO32, canonical, chainFor, word, type SafeFacts } from "./submitter-world.ts";

const realProxyCode = async (): Promise<Hex> => STANDIN;

describe("submitter-safe: the canonical SafeL2 1.4.1 check", () => {
  const forbidden = forbiddenSubmitters({ timelock: A.timelock, admin: addr(0xad), pauser: addr(0xb0), emergency: addr(0xe0) });
  test("every forbidden address is refused with no chain read: the timelock, admin (= the deployer), the pauser, the emergency key", async () => {
    let reads = 0;
    const chain: SubmitterChain = { getCode: async () => { reads++; return undefined; }, getStorageAt: async () => { reads++; return undefined; }, read: async () => { reads++; throw new Error("x"); } };
    for (const who of [A.timelock, addr(0xad), addr(0xb0), addr(0xe0)]) {
      await expect(inspectSubmitterSafe(chain, who, forbidden)).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("Nothing sent") });
    }
    expect(reads).toBe(0);
  });
  test("issue 1888: the governing Safe may be the submitter Safe, and its owners may be shared", async () => {
    const f = canonical(); f.code = STANDIN;
    expect(forbidden.has(A.safe.toLowerCase())).toBe(false);
    expect(await inspectSubmitterSafe(chainFor(f), A.safe, forbidden)).toMatchObject({ address: getAddress(A.safe), threshold: 2, owners: OWNERS.map((o) => getAddress(o)) });
  });
  test("an address with no code is a key: inspect reports null, assert refuses", async () => {
    const f = canonical(); f.code = undefined;
    expect(await inspectSubmitterSafe(chainFor(f), SUBSAFE, forbidden)).toBeNull();
    await expect(assertSubmitterSafe(chainFor(f), SUBSAFE, forbidden)).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("single key") });
  });
  test("a contract that is not the canonical proxy is refused and EVERY difference is named", async () => {
    const f = canonical(); f.code = "0x6080" as Hex; f.slot0 = word(addr(0xbad)); f.version = "1.3.0"; f.threshold = 1n; f.modules = [addr(0x30d)]; f.guard = word(addr(0x9a)); f.fallback = word(addr(0xfb)); f.owners = [OWNERS[0]!, addr(0xb0)];
    const e = await inspectSubmitterSafe(chainFor(f), SUBSAFE, forbidden).catch((x) => x);
    expect(e).toMatchObject({ kind: "USAGE" });
    for (const w of ["code hash", "singleton", "VERSION()", "threshold is 1", "modules are enabled", "guard", "fallback handler", "role separation", "its owner 2 of 2", getAddress(addr(0xb0))]) expect(e.message).toContain(w);
  });
  test("each single difference alone is refused (mutations of a passing Safe)", async () => {
    const real = await realProxyCode();
    const base = (): SafeFacts => ({ ...canonical(), code: real });
    expect((await inspectSubmitterSafe(chainFor(base()), SUBSAFE, forbidden))!).toMatchObject({ address: getAddress(SUBSAFE), threshold: 2, code_hash: keccak256(STANDIN) });
    const muts: [string, (f: SafeFacts) => void, string][] = [
      ["wrong code", (f) => { f.code = `${real}00` as Hex; }, "code hash"],
      ["wrong singleton", (f) => { f.slot0 = word(SAFE_141.fallbackHandler); }, "singleton"],
      ["L1 singleton", (f) => { f.slot0 = word(addr(0x41)); }, "singleton"],
      ["wrong version", (f) => { f.version = "1.5.0"; }, "VERSION()"],
      ["threshold 1", (f) => { f.threshold = 1n; }, "threshold is 1"],
      ["threshold above owners", (f) => { f.threshold = 4n; }, "above its 3 owners"],
      ["a module", (f) => { f.modules = [addr(0x30d)]; }, "modules are enabled"],
      ["a guard", (f) => { f.guard = word(addr(0x9a)); }, "guard"],
      ["a custom fallback handler", (f) => { f.fallback = word(addr(0xfb)); }, "fallback handler"],
      ["no fallback handler", (f) => { f.fallback = ZERO32; }, "fallback handler"],
      ["the pauser as owner", (f) => { f.owners = [OWNERS[0]!, OWNERS[1]!, addr(0xb0)]; }, "role separation"],
      ["the timelock as owner", (f) => { f.owners = [OWNERS[0]!, OWNERS[1]!, A.timelock]; }, "role separation"],
    ];
    for (const [name, mutate, want] of muts) {
      const f = base(); mutate(f);
      await expect(inspectSubmitterSafe(chainFor(f), SUBSAFE, forbidden), name).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining(want) });
    }
  });
});

