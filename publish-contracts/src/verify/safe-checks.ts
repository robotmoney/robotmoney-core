// Safe 1.4.1 checks: topology equals the sheet, no module, no guard, canonical fallback handler,
// and three signature negative controls that need no key (eth_call only).
import { encodeFunctionData, keccak256, parseAbiItem, pad, concatHex, toHex } from "viem";
import type { Collector } from "./collector.ts";
import {
  SAFE_141_FALLBACK_HANDLER, SAFE_FALLBACK_SLOT, SAFE_GUARD_SLOT, SAFE_L2_141_SINGLETON, SAFE_PROBE_ADDRESS,
  SAFE_PROBE_ADDRESS_2, SAFE_SENTINEL, Z32,
} from "./constants.ts";
import { inspectProofTx } from "../control-proof.ts";
import type { Address, ChainReader, Hex, VerifyOptions, VerifySheet } from "./types.ts";

export const CHECK_SIGS = parseAbiItem("function checkSignatures(bytes32 dataHash, bytes data, bytes signatures)"); // Safe 1.4.1 (the executor form is 1.5.0: on 1.4.1 that selector does not exist and every call reverts with empty data)
const slotAddr = (v: Hex): string => (`0x${v.replace(/^0x/, "").padStart(64, "0").slice(24)}`).toLowerCase();

/** v=1 approved-hash signature whose owner field is `who`. Valid only when msg.sender == who. */
const approvedSig = (who: Address): Hex => concatHex([pad(who, { size: 32 }), Z32, toHex(1, { size: 1 })]);

export async function safeChecks(c: Collector, chain: ChainReader, safe: Address, sheet: VerifySheet, manifestSafeCodeHash: string | undefined, proof?: VerifyOptions["controlProof"]): Promise<void> {
  await c.run("safe: has code", async () => (await chain.getCode(safe)).length > 2);
  await c.runEq("safe: singleton is SafeL2 1.4.1", async () => slotAddr(await chain.getStorageAt(safe, Z32)), SAFE_L2_141_SINGLETON);
  await c.runEq("safe: version is 1.4.1", async () => await chain.read(safe, "function VERSION() view returns (string)"), "1.4.1");
  await c.run("safe: proxy code hash equals manifest", async () => {
    if (!manifestSafeCodeHash) return { ok: false, detail: "timelock.json has no code_hashes.safe" };
    const h = keccak256(await chain.getCode(safe));
    return { ok: h === manifestSafeCodeHash.toLowerCase(), detail: `on chain ${h}, manifest ${manifestSafeCodeHash}` };
  });

  let owners: string[] = [];
  let threshold = 0;
  await c.run("safe: owners equal sheet", async () => {
    owners = ((await chain.read(safe, "function getOwners() view returns (address[])")) as string[]).map((a) => a.toLowerCase());
    const want = sheet.safeOwners.map((a) => a.toLowerCase()).sort();
    const got = [...owners].sort();
    const ok = got.join() === want.join();
    return { ok, detail: ok ? `${got.length} owners` : `got ${got.join(",")} want ${want.join(",")}` };
  });
  await c.run("safe: threshold equals sheet", async () => {
    threshold = Number(await chain.read(safe, "function getThreshold() view returns (uint256)"));
    return { ok: threshold === sheet.safeThreshold, detail: `got ${threshold}, want ${sheet.safeThreshold}` };
  });
  await c.run("safe: threshold at least 2", async () => ({ ok: threshold >= 2, detail: `threshold ${threshold}` }));
  await c.run("safe: threshold below owner count", async () => ({ ok: owners.length > 0 && threshold < owners.length, detail: `threshold ${threshold} of ${owners.length}` }));
  await c.run("safe: owner count at least 3", async () => ({ ok: owners.length >= 3, detail: `${owners.length} owners` }));
  for (const [nm, a] of [["deployer", sheet.deployer], ["emergency", sheet.emergency], ["pauser", sheet.pauser]] as const) {
    await c.run(`safe: ${nm} is not an owner`, async () => ({ ok: !owners.includes(a.toLowerCase()), detail: `${a} role separation` }));
  }
  await c.run("safe: no module enabled", async () => {
    const r = (await chain.read(safe, "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)", [SAFE_SENTINEL, 10n])) as any;
    const arr: string[] = r.array ?? r[0] ?? [];
    return { ok: arr.length === 0, detail: arr.length ? `modules ${arr.join(",")}` : "none" };
  });
  await c.runEq("safe: no guard set", async () => slotAddr(await chain.getStorageAt(safe, SAFE_GUARD_SLOT)), "0x0000000000000000000000000000000000000000");
  await c.runEq("safe: fallback handler is canonical", async () => slotAddr(await chain.getStorageAt(safe, SAFE_FALLBACK_SLOT)), SAFE_141_FALLBACK_HANDLER);

  // The control proof (core 1618): the Safe executed one self-call signed by every owner. Read back from the chain, not from the run manifest.
  await c.run("safe: control proof transaction recorded", async () => ({ ok: !!proof, detail: proof ? proof.txHash : "the run manifest records no prove-control transaction" }));
  await c.run("safe: control proof transaction succeeded", async () => {
    if (!proof) return { ok: false, detail: "no proof recorded" };
    const st = await chain.receiptStatus(proof.txHash);
    return { ok: st === "success", detail: `${proof.txHash} ${st ?? "not found"}` };
  });
  await c.run("safe: control proof is a self-call signed by every owner", async () => {
    if (!proof) return { ok: false, detail: "no proof recorded" };
    const tx = await chain.getTransaction(proof.txHash);
    if (!tx) return { ok: false, detail: `${proof.txHash} not found on chain` };
    return inspectProofTx({ chainId: await chain.chainId(), safe, owners, nonce: proof.nonce, tx });
  });
  await c.run("safe: nonce at least 1", async () => {
    const n = Number(await chain.read(safe, "function nonce() view returns (uint256)"));
    return { ok: n >= 1, detail: `Safe nonce ${n}` };
  });

  const hash = keccak256(toHex("robotmoney verifier negative control"));
  const expectRevert = async (label: string, from: Address | undefined, sigs: Hex, gs: string) => {
    await c.run(label, async () => {
      const data = encodeFunctionData({ abi: [CHECK_SIGS], functionName: "checkSignatures", args: [hash, "0x", sigs] });
      const r = await chain.callRaw(safe, data, from);
      if (r.ok) return { ok: false, detail: `call succeeded, expected ${gs}` };
      const text = `${r.reason ?? ""}`;
      return { ok: text.includes(gs), detail: `reverted: ${text.slice(0, 120)}, expected ${gs}` };
    });
  };
  // One 65-byte blob is below any threshold of 2 or more: GS020.
  await expectRevert("safe: control below-threshold signatures revert GS020", undefined, pad("0x", { size: 65 }), "GS020");
  // A non-owner "signs" by being msg.sender: it clears GS025 and must be stopped at GS026.
  const many = (who: Address, n: number) => concatHex(Array.from({ length: Math.max(n, 2) }, () => approvedSig(who)));
  await expectRevert("safe: control non-owner signature reverts GS026", SAFE_PROBE_ADDRESS, many(SAFE_PROBE_ADDRESS, threshold), "GS026");
  await expectRevert(
    "safe: control non-owner pair reverts GS026",
    SAFE_PROBE_ADDRESS_2,
    concatHex([approvedSig(SAFE_PROBE_ADDRESS_2), approvedSig(SAFE_PROBE_ADDRESS)]),
    "GS026",
  );
}
