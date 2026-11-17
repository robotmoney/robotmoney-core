import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./fixtures.ts";
import { upgradeLibraries } from "../src/upgrade-libraries.ts";
import { linkCreationCode } from "../src/deploy-implementation.ts";
import type { Address, Hex } from "viem";

test("deploys a dependency graph in order, records it, and verifies before reusing on retry", async () => {
  const out = tmp(), code = new Map<string, Hex>(), recorded: any[] = [], creates: Hex[] = [];
  const refs = (n?: string) => n ? { "X.sol": { [n]: [{ start: 0, length: 20 }] } } : {};
  const artifact = (name: string, object: string, dep?: string) => {
    mkdirSync(join(out, `${name}.sol`), { recursive: true });
    writeFileSync(join(out, `${name}.sol`, `${name}.json`), JSON.stringify({ bytecode: { object, linkReferences: refs(dep) }, deployedBytecode: { object, linkReferences: refs(dep), immutableReferences: {} } }));
  };
  const placeholder = "00".repeat(20);
  artifact("Leaf", "0x6001"); artifact("Branch", `0x${placeholder}6002`, "Leaf"); artifact("Root", `0x${placeholder}6003`, "Branch");
  const stale = `0x${"99".repeat(20)}` as Address;
  code.set(stale, "0xdead");
  const args = { contract: "Root", out, build: "/build", candidates: { Leaf: stale }, recorded, link: linkCreationCode,
    getCode: async (a: Address) => code.get(a) ?? "0x" as Hex,
    create: async (c: Hex) => { creates.push(c); const address = `0x${String(creates.length).padStart(40, "0")}` as Address; code.set(address, c); return { address, status: true, txHash: `0x${"aa".repeat(32)}` as Hex }; },
    beforeCreate: async () => {}, record: async (e: any) => { recorded.push(e); },
  };
  const result = await upgradeLibraries(args);
  expect(recorded.map((e) => e.name)).toEqual(["Leaf", "Branch"]);
  expect(result.Branch).toBe(recorded[1].address);
  expect(creates).toHaveLength(2);
  expect(await upgradeLibraries(args)).toEqual(result);
  expect(creates).toHaveLength(2);
  code.set(recorded[0].address, "0xdead");
  await upgradeLibraries(args);
  expect(creates).toHaveLength(4);
});

test("refuses a missing dependency before creating anything", async () => {
  const out = tmp();
  mkdirSync(join(out, "Root.sol"), { recursive: true });
  const links = { "Missing.sol": { Missing: [{ start: 0, length: 20 }] } };
  writeFileSync(join(out, "Root.sol", "Root.json"), JSON.stringify({ bytecode: { object: `0x${"00".repeat(20)}`, linkReferences: links }, deployedBytecode: { object: `0x${"00".repeat(20)}`, linkReferences: links } }));
  let sent = false;
  await expect(upgradeLibraries({ contract: "Root", out, build: "/build", candidates: {}, recorded: [], link: linkCreationCode,
    getCode: async () => "0x", create: async () => { sent = true; return { status: false, address: null, txHash: `0x${"00".repeat(32)}` }; },
    beforeCreate: async () => {}, record: async () => {},
  })).rejects.toThrow("no build artifact for Missing");
  expect(sent).toBe(false);
});
