// ADR-0014 §9 (issues 1809/1810): the masked code compare blanks every library link, so on its own it passes an implementation that links any library
// code at all. `compareLinkedLibraries` follows each link to the address forge wrote into the deployed code and compares that library's code with its
// build, recursively. Fixtures only: artifact files on disk and an in-memory code map.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareCodeAndLinks, compareLinkedLibraries, loadArtifact } from "../../src/verify/codehash.ts";
import type { Hex } from "../../src/verify/types.ts";

const LIB_ADDR = "0x00000000000000000000000000000000000011b1";
const OTHER_ADDR = "0x0000000000000000000000000000000000000bad";
// A library's runtime code starts with PUSH20 <address(this)>; the artifact holds 20 zero bytes there.
const LIB_ARTIFACT = `0x73${"00".repeat(20)}3014608060405260aa`;
const libOnChain = (at: string) => `0x73${at.slice(2)}3014608060405260aa` as Hex;
// The implementation links VaultAdapterOps at byte 3 (after 0x600073: PUSH1 00, PUSH20 placeholder).
const PLACEHOLDER = `__$${"ab".repeat(17)}$__`;
const IMPL_ARTIFACT = `0x600073${PLACEHOLDER}5050`;
const implOnChain = (lib: string) => `0x600073${lib.slice(2)}5050` as Hex;

function out(): string {
  const dir = mkdtempSync(join(tmpdir(), "linked-libs-"));
  const write = (name: string, object: string, linkReferences: object) => {
    mkdirSync(join(dir, `${name}.sol`), { recursive: true });
    writeFileSync(join(dir, `${name}.sol`, `${name}.json`), JSON.stringify({ deployedBytecode: { object, immutableReferences: {}, linkReferences } }));
  };
  write("VaultAdapterOps", LIB_ARTIFACT, {});
  write("RobotMoneyVault", IMPL_ARTIFACT, { "contracts/lib/VaultAdapterOps.sol": { VaultAdapterOps: [{ start: 3, length: 20 }] } });
  return dir;
}

describe("linked libraries are compared with their builds", () => {
  test("an implementation that links the reviewed library passes, and names it", async () => {
    const dir = out();
    const codes = new Map<string, Hex>([[LIB_ADDR, libOnChain(LIB_ADDR)]]);
    const r = await compareCodeAndLinks(async (a) => codes.get(a.toLowerCase()) ?? "0x", implOnChain(LIB_ADDR), loadArtifact(dir, "RobotMoneyVault"), dir);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain(`VaultAdapterOps@${LIB_ADDR}`);
  });

  test("the masked compare alone passes a link to other code; the link check refuses it", async () => {
    const dir = out();
    // OTHER_ADDR holds code that is not VaultAdapterOps.
    const codes = new Map<string, Hex>([[OTHER_ADDR, "0x73ffffffffffffffffffffffffffffffffffffffff6000" as Hex]]);
    const r = await compareCodeAndLinks(async (a) => codes.get(a.toLowerCase()) ?? "0x", implOnChain(OTHER_ADDR), loadArtifact(dir, "RobotMoneyVault"), dir);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(`library VaultAdapterOps at ${OTHER_ADDR}`);
  });

  test("a link to an address with no code is refused, never a pass", async () => {
    const dir = out();
    const r = await compareLinkedLibraries(async () => "0x", implOnChain(LIB_ADDR), loadArtifact(dir, "RobotMoneyVault"), dir);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("no code on chain");
  });

  test("a contract that links nothing passes the link check trivially", async () => {
    const dir = out();
    const r = await compareLinkedLibraries(async () => "0x", libOnChain(LIB_ADDR), loadArtifact(dir, "VaultAdapterOps"), dir);
    expect(r).toEqual({ ok: true, detail: "links no library" });
  });
});
