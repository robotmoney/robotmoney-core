// Owner key liveness record (Deploy 4 hardening, owner 2026-11-13): every SAFE_OWNERS entry is proven by its signature in the prove-control transaction, and the
// tool fails when an owner lacks one, the record is missing, or the transaction is not the Safe's empty self-call. Real signatures and real calldata.
import { describe, expect, test } from "bun:test";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { ownerLiveness, runLiveness, type LivenessChain } from "../src/ci/owner-liveness.ts";
import { TWIN_CHAIN_ID } from "../src/chains.ts";
import { localSafeTxHash } from "../src/safe/index.ts";
import { PROVE_SIGNERS, keySigner } from "./harness.ts";

const SAFE = "0x00000000000000000000000000000000000050fe" as Address;
const CHAIN = 8453;
const TX = `0x${"ab".repeat(32)}` as Hex;
const ZERO = "0x0000000000000000000000000000000000000000";
const EXEC = parseAbi(["function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)"]);
const OWNERS = await Promise.all(PROVE_SIGNERS.map((s) => s.address()));

async function proofInput(signers = PROVE_SIGNERS, nonce = 0, to: Address = SAFE): Promise<Hex> {
  const hash = localSafeTxHash(CHAIN, SAFE, SAFE, "0x", nonce);
  const sigs = await Promise.all(signers.map(async (s) => ({ owner: (await s.address()).toLowerCase(), sig: await s.signSafeHash(hash, "raw") })));
  const packed = ("0x" + sigs.sort((a, b) => (a.owner < b.owner ? -1 : 1)).map((x) => x.sig.slice(2)).join("")) as Hex;
  return encodeFunctionData({ abi: EXEC, functionName: "execTransaction", args: [to, 0n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, packed] });
}
const record = (over: Record<string, unknown> = {}) => ({ status: "done", safe: SAFE, txHash: TX, nonce: 0, signers: OWNERS.map((o) => o.toLowerCase()), ...over });
const landed = async (input?: Hex) => ({ to: SAFE as string | null, input: input ?? (await proofInput()), status: "success" as const, block: 100 });

describe("owner liveness from the prove-control transaction", () => {
  test("every owner's signature recovers: ok, one signature per owner, with the transaction and the Safe hash", async () => {
    const r = await ownerLiveness({ chainId: CHAIN, owners: OWNERS, record: record(), tx: await landed() });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.txHash).toBe(TX);
    expect(r.safeTxHash).toBe(localSafeTxHash(CHAIN, SAFE, SAFE, "0x", 0));
    expect(r.owners.every((o) => /^0x[0-9a-f]{130}$/i.test(o.signature ?? ""))).toBe(true);
  });

  test("an owner with no signature in the transaction fails and is named", async () => {
    const r = await ownerLiveness({ chainId: CHAIN, owners: OWNERS, record: record(), tx: await landed(await proofInput(PROVE_SIGNERS.slice(0, 2))) });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain(`owner ${OWNERS[2]} has no signature`);
    expect(r.owners[2]!.signature).toBeNull();
  });

  test("a SAFE_OWNERS entry that never signed (a stranger listed as owner) fails", async () => {
    const stranger = await keySigner(`0x${"55".repeat(32)}`).address();
    const r = await ownerLiveness({ chainId: CHAIN, owners: [...OWNERS, stranger], record: record(), tx: await landed() });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain(stranger);
  });

  test("signatures over another Safe nonce prove nothing", async () => {
    const r = await ownerLiveness({ chainId: CHAIN, owners: OWNERS, record: record(), tx: await landed(await proofInput(PROVE_SIGNERS, 5)) });
    expect(r.ok).toBe(false);
  });

  test("no prove-control record, a missing transaction, a reverted one or one to another address fails", async () => {
    expect((await ownerLiveness({ chainId: CHAIN, owners: OWNERS, record: undefined, tx: await landed() })).problems.join("\n")).toContain("no finished prove-control record");
    expect((await ownerLiveness({ chainId: CHAIN, owners: OWNERS, record: record(), tx: null })).problems.join("\n")).toContain("is not on this chain");
    expect((await ownerLiveness({ chainId: CHAIN, owners: OWNERS, record: record(), tx: { ...(await landed()), status: "reverted" } })).ok).toBe(false);
    expect((await ownerLiveness({ chainId: CHAIN, owners: OWNERS, record: record(), tx: { ...(await landed()), to: "0x00000000000000000000000000000000000000aa" } })).ok).toBe(false);
    expect((await ownerLiveness({ chainId: CHAIN, owners: OWNERS, record: record(), tx: { ...(await landed()), input: "0x12345678" } })).ok).toBe(false);
  });
});

// Issue 2044: on the Twin (918453) a proof at or before the fork pin is not read back; the state it left is checked now instead. On 8453 the proof is read.
describe("owner liveness, Twin variant", () => {
  const TIMELOCK = "0x00000000000000000000000000000000000071e1";
  const chainOf = (chainId: number, o: { pin?: bigint; owners?: string[]; threshold?: number; roles?: boolean } = {}) => {
    const reads: string[] = [];
    const c: LivenessChain = {
      chainId: async () => chainId,
      forkPin: async () => o.pin,
      tx: async (h) => { reads.push(h); return await landed(); },
      safeOwners: async () => o.owners ?? OWNERS,
      safeThreshold: async () => o.threshold ?? 2,
      hasRole: async () => o.roles ?? true,
    };
    return { c, reads };
  };

  test("918453, proof before the pin: the transaction is not read, the state now passes, labelled the Twin variant", async () => {
    const { c, reads } = chainOf(TWIN_CHAIN_ID, { pin: 1000n });
    const r = await runLiveness({ chainId: CHAIN, owners: OWNERS, record: record({ block: 100 }), timelock: TIMELOCK }, c);
    expect(reads).toEqual([]);
    expect(r.ok).toBe(true);
    expect("variant" in r && r.label).toContain("Twin");
  });
  test("918453, proof before the pin: a lost role, wrong owners or a missing --timelock fail", async () => {
    expect((await runLiveness({ chainId: CHAIN, owners: OWNERS, record: record({ block: 100 }), timelock: TIMELOCK }, chainOf(TWIN_CHAIN_ID, { pin: 1000n, roles: false }).c)).problems.join("\n")).toContain("PROPOSER_ROLE");
    expect((await runLiveness({ chainId: CHAIN, owners: OWNERS, record: record({ block: 100 }), timelock: TIMELOCK }, chainOf(TWIN_CHAIN_ID, { pin: 1000n, owners: OWNERS.slice(1) }).c)).ok).toBe(false);
    expect((await runLiveness({ chainId: CHAIN, owners: OWNERS, record: record({ block: 100 }) }, chainOf(TWIN_CHAIN_ID, { pin: 1000n }).c)).problems.join("\n")).toContain("--timelock");
  });
  test("918453, proof after the pin: the transaction is read in full", async () => {
    const { c, reads } = chainOf(TWIN_CHAIN_ID, { pin: 50n });
    const r = await runLiveness({ chainId: CHAIN, owners: OWNERS, record: record({ block: 100 }), timelock: TIMELOCK }, c);
    expect(reads).toEqual([TX]);
    expect(r.ok).toBe(true);
    expect("variant" in r).toBe(false);
  });
  test("8453: the transaction is read whatever the block", async () => {
    const { c, reads } = chainOf(CHAIN, { pin: 1000n });
    const r = await runLiveness({ chainId: CHAIN, owners: OWNERS, record: record({ block: 100 }) }, c);
    expect(reads).toEqual([TX]);
    expect(r.ok).toBe(true);
  });
});
