#!/usr/bin/env bun
/**
 * Canonical Safe v1.4.1 set check on the Twin chain (core 1447, 1498).
 *
 * Canonical: docs/technical/governance-isomorphism.md section 2.2 (the addresses) and
 * section 4.1 R2/R3 (the requirement this enforces).
 *
 * The Twin chain is a pinned lazy fork of real Base, so the Safe contracts are the real ones. The
 * governance ceremony creates its Safe through the canonical SafeProxyFactory on the SafeL2
 * singleton. This check reads each contract from the chain, hashes its code, and for both
 * singletons reads the lock their constructor writes (storage slot 4, the threshold, equals 1, so
 * setup() on the singleton reverts GS200). Presence is not enough: the code must be the canonical
 * code. It runs against any RPC (the Twin fork, a stage chain), reads only, and needs no secret.
 *
 * Usage: bun scripts/devnet/safe-set.ts [--rpc-url URL]   (default: TWIN_RPC_URL, then http://127.0.0.1:8545)
 * Exit: 0 every contract present with its pinned code and both singletons locked;
 *       2 the endpoint cannot be read; 14 one or more contracts absent, not canonical or unlocked.
 */
import { hexToBytes, keccak256, rpc } from "./twin-fork-lib.ts";

export interface SafeContract { address: string; name: string; codeHash: string; singleton: boolean }

/** Lowercased addresses, with the keccak256 of each contract's runtime code as Base reports it. */
export const SAFE_SET: SafeContract[] = [
  { address: "0x41675c099f32341bf84bfc5382af534df5c7461a", name: "Safe singleton (L1)", codeHash: "0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4", singleton: true },
  { address: "0x29fcb43b46531bca003ddc8fcb67ffe91900c762", name: "SafeL2 singleton", codeHash: "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff", singleton: true },
  { address: "0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67", name: "SafeProxyFactory", codeHash: "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317", singleton: false },
  { address: "0xfd0732dc9e303f09fcef3a7388ad10a83459ec99", name: "CompatibilityFallbackHandler", codeHash: "0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9", singleton: false },
  { address: "0x38869bf66a61cf6bdb996a6ae40d5853fd43b526", name: "MultiSend", codeHash: "0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77", singleton: false },
];

const SLOT_4 = "0x" + "0".repeat(63) + "4";

export interface ChainRead {
  code(address: string): Promise<string>;
  storageAt(address: string, slot: string): Promise<string>;
}

/** Every problem found, one string per contract. Empty means the set is canonical and locked. */
export async function safeSetProblems(chain: ChainRead, set: SafeContract[] = SAFE_SET): Promise<string[]> {
  const problems: string[] = [];
  for (const c of set) {
    const code = await chain.code(c.address);
    if (!code || code === "0x") {
      problems.push(`chain lacks code for ${c.name} ${c.address} (governance-isomorphism.md R2)`);
      continue;
    }
    const got = keccak256(hexToBytes(code.replace(/^0x/, "")));
    if (got !== c.codeHash) {
      problems.push(`code for ${c.name} ${c.address} hashes to ${got}, not the canonical v1.4.1 code hash ${c.codeHash}`);
      continue;
    }
    if (c.singleton) {
      const v = BigInt(await chain.storageAt(c.address, SLOT_4));
      if (v !== 1n) problems.push(`${c.name} ${c.address} is unlocked: storage slot 4 (threshold) is ${v}, not 1, so anyone can call setup() on it`);
    }
  }
  return problems;
}

export function rpcChain(url: string): ChainRead {
  return {
    code: (a) => rpc(url, "eth_getCode", [a, "latest"]),
    storageAt: (a, s) => rpc(url, "eth_getStorageAt", [a, s, "latest"]),
  };
}

if (import.meta.main) {
  const i = process.argv.indexOf("--rpc-url");
  const url = i >= 0 ? process.argv[i + 1] : process.env.TWIN_RPC_URL || "http://127.0.0.1:8545";
  let problems: string[];
  try {
    problems = await safeSetProblems(rpcChain(url));
  } catch (e: any) {
    console.error(`ERROR: cannot read the chain: ${e?.message ?? e}`);
    process.exit(2);
  }
  if (problems.length) {
    for (const p of problems) console.error(`ERROR: ${p}`);
    console.error(`ERROR: ${problems.length} of ${SAFE_SET.length} canonical Safe contracts absent, not canonical, or unlocked`);
    process.exit(14);
  }
  console.log(`[safe-set] OK: all ${SAFE_SET.length} canonical Safe contracts present with their pinned code; both singletons locked`);
}
