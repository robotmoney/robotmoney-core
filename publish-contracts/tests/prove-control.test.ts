// The Safe control proof (core 1618, plan decision 21): before stage 11 the real Safe executes one self-call signed by EVERY owner.
// What is real here: the owner keys sign, the hashes are the Safe tool's own, every signature is recovered, and the verifier decodes the proof
// calldata and recovers the signers. What is a fake: the chain (the runner tests stub forge and cast). The proof against a real Safe contract
// on a real fork is the Twin rehearsal (suite 28, and the suite 14 twin_publish test).
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Hex } from "viem";
import { assertControlProven, inspectProofTx, PROOF_STAGE } from "../src/control-proof.ts";
import { EXIT_CODES } from "../src/errors.ts";
import { assertEveryOwnerSigned } from "../src/prove-control.ts";
import { signTx, type SafeTxBundle } from "../src/safe/index.ts";
import { PROVE_OWNERS, PROVE_SIGNERS, fakeProveApi, keySigner, world } from "./harness.ts";
import { OWNERS, OWNER_KEYS, SAFE, buildWorld, failed, proofInput } from "./verify/world.ts";
import { verifyDeployment } from "../src/verify/index.ts";

const manifestPath = (w: ReturnType<typeof world>) => join(w.evidence, "publish-run.json");
const manifest = (w: ReturnType<typeof world>) => JSON.parse(readFileSync(manifestPath(w), "utf8"));
const lastError = (w: ReturnType<typeof world>) => w.logs().filter((l) => l.event === "run.failed").pop();
const executed = (w: ReturnType<typeof world>) => w.safeCalls.filter((c) => c.startsWith("executeTx"));
const forgeBroadcasts = (w: ReturnType<typeof world>) => w.state().calls.filter((c: any) => c.tool === "forge" && c.args.includes("--broadcast"));

/** A proposed proof bundle that the given owners signed for real. */
async function signedBundle(signers: typeof PROVE_SIGNERS): Promise<SafeTxBundle> {
  const w = world({ writeSafeManifest: true });
  const api = fakeProveApi(w);
  const handle = await api.connectSafe({ rpcUrl: "http://x", chainId: 918453, safeAddress: "0x00000000000000000000000000000000000050fe", logger: { log() {} } } as never);
  let b = await api.proposeTx(handle, { to: handle.address, data: "0x", action: PROOF_STAGE });
  for (const s of signers) b = await signTx(handle, b, s, { skipChainChecks: true });
  return b;
}

describe("prove-control refuses before it executes", () => {
  test("one owner signer missing: refused with CONTROL_NOT_PROVEN, nothing proposed, signed or executed", async () => {
    const w = world({ writeSafeManifest: true });
    const code = await w.run(["--stage", PROOF_STAGE], { prove: { api: fakeProveApi(w), ownerSigners: PROVE_SIGNERS.slice(0, 2) } });
    expect(code).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(code).toBe(24);
    expect(lastError(w).message).toContain(PROVE_OWNERS[2]!);
    expect(executed(w)).toEqual([]);
    expect(w.safeCalls).not.toContain("checkSignaturesOnChain");
    expect(w.safeNonce).toBe(0);
  });

  test("a signer that is not an owner does not stand in for the missing owner", async () => {
    const w = world({ writeSafeManifest: true });
    const stranger = keySigner(`0x${"11".repeat(32)}`);
    const code = await w.run(["--stage", PROOF_STAGE], { prove: { api: fakeProveApi(w), ownerSigners: [PROVE_SIGNERS[0]!, PROVE_SIGNERS[1]!, stranger] } });
    expect(code).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(executed(w)).toEqual([]);
  });

  test("no owner signers at all (a mainnet run with no --owner-signer): refused", async () => {
    const w = world({ writeSafeManifest: true });
    expect(await w.run(["--stage", PROOF_STAGE], { prove: { api: fakeProveApi(w), ownerSigners: [] } })).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(executed(w)).toEqual([]);
  });

  test("a Safe whose nonce is not 0 is refused: the proof is taken on a new Safe", async () => {
    const w = world({ writeSafeManifest: true });
    w.safeNonce = 3;
    expect(await w.run(["--stage", PROOF_STAGE])).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(lastError(w).message).toContain("nonce is 3");
    expect(executed(w)).toEqual([]);
  });

  test("a signature that does not recover to its owner is refused before the Safe is asked and before execution", async () => {
    const good = await signedBundle(PROVE_SIGNERS);
    // owner 2's slot holds a signature made by a key that is not owner 2's
    const wrongSig = await keySigner(`0x${"22".repeat(32)}`).signSafeHash(good.safe_tx_hash, "raw");
    const bundle: SafeTxBundle = { ...good, signatures: good.signatures.map((s) => (s.owner.toLowerCase() === PROVE_OWNERS[2]!.toLowerCase() ? { ...s, signature: wrongSig } : s)) };
    await expect(assertEveryOwnerSigned(PROVE_OWNERS, bundle)).rejects.toMatchObject({ kind: "CONTROL_NOT_PROVEN" });
  });

  test("a bundle with one owner signature missing is refused; with all three signatures it passes", async () => {
    const two = await signedBundle(PROVE_SIGNERS.slice(0, 2));
    await expect(assertEveryOwnerSigned(PROVE_OWNERS, two)).rejects.toMatchObject({ kind: "CONTROL_NOT_PROVEN" });
    await expect(assertEveryOwnerSigned(PROVE_OWNERS, await signedBundle(PROVE_SIGNERS))).resolves.toBeUndefined();
  });

  test("a signature from a non-owner on the bundle is refused", async () => {
    const three = await signedBundle(PROVE_SIGNERS);
    const stranger = keySigner(`0x${"33".repeat(32)}`);
    const sig = await stranger.signSafeHash(three.safe_tx_hash, "raw");
    await expect(assertEveryOwnerSigned(PROVE_OWNERS, { ...three, signatures: [...three.signatures, { owner: await stranger.address(), signature: sig }] })).rejects.toMatchObject({ kind: "CONTROL_NOT_PROVEN" });
  });
});

describe("prove-control records the proof", () => {
  test("every owner signs, the Safe checks all signatures before execution, every signature is sent, and the manifest keeps the hash and the signers", async () => {
    const w = world({ writeSafeManifest: true });
    expect(await w.run(["--stage", PROOF_STAGE])).toBe(0);
    const calls = w.safeCalls.filter((c) => c === "checkSignaturesOnChain" || c.startsWith("executeTx"));
    expect(calls).toEqual(["checkSignaturesOnChain", "executeTx:3:all"]);
    const rec = manifest(w).stages[PROOF_STAGE];
    expect(rec).toMatchObject({ status: "done", safe: "0x00000000000000000000000000000000000050fe", nonce: 0, txHash: `0x${"ee".repeat(32)}` });
    expect(rec.signers).toEqual(PROVE_OWNERS.map((a) => a.toLowerCase()).sort());
    expect(rec.safeTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(w.safeNonce).toBe(1);
  });

  test("the proof sends nothing from the deployer: its nonce is the frozen-count record", async () => {
    const w = world({ writeSafeManifest: true, startNonce: 7 });
    expect(await w.run(["--stage", PROOF_STAGE])).toBe(0);
    expect(w.state().nonces["0x000000000000000000000000000000000000a001"]).toBe(7);
  });

  test("a finished proof is not taken twice on --resume", async () => {
    const w = world({ writeSafeManifest: true });
    expect(await w.run(["--stage", PROOF_STAGE])).toBe(0);
    expect(await w.run(["--stage", PROOF_STAGE, "--resume"])).toBe(0);
    expect(executed(w)).toHaveLength(1);
  });
});

describe("stage 11 refuses without the recorded proof", () => {
  async function proven() {
    const w = world({ writeSafeManifest: true, startNonce: 0 });
    expect(await w.run(["--stage", PROOF_STAGE])).toBe(0);
    return w;
  }
  const edit = (w: ReturnType<typeof world>, f: (stages: Record<string, any>) => void) => {
    const m = manifest(w);
    f(m.stages);
    writeFileSync(manifestPath(w), JSON.stringify(m));
  };

  test("no proof record in the run manifest: refused with the named error, nothing broadcast", async () => {
    const w = world({ writeSafeManifest: true, startNonce: 0 });
    w.safeNonce = 1; // a Safe nonce of 1 or more is not enough without the record
    const code = await w.run(["--stage", "timelock"]);
    expect(code).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(lastError(w).message).toContain("no finished Safe control proof");
    expect(forgeBroadcasts(w)).toEqual([]);
  });

  test("a record with the Safe nonce at 0: refused", async () => {
    const w = await proven();
    w.safeNonce = 0;
    expect(await w.run(["--stage", "timelock", "--resume"])).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(lastError(w).message).toContain("nonce is 0");
    expect(forgeBroadcasts(w)).toEqual([]);
  });

  test("a record that lacks one owner's signature: refused", async () => {
    const w = await proven();
    edit(w, (s) => { s[PROOF_STAGE].signers = s[PROOF_STAGE].signers.slice(0, 2); });
    expect(await w.run(["--stage", "timelock", "--resume"])).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(lastError(w).message).toContain("lacks a signature");
    expect(forgeBroadcasts(w)).toEqual([]);
  });

  test("a record taken on another Safe: refused", async () => {
    const w = await proven();
    edit(w, (s) => { s[PROOF_STAGE].safe = "0x00000000000000000000000000000000000000aa"; });
    expect(await w.run(["--stage", "timelock", "--resume"])).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(lastError(w).message).toContain("not the Safe");
    expect(forgeBroadcasts(w)).toEqual([]);
  });

  test("a record that never finished (no transaction hash): refused", async () => {
    const w = await proven();
    edit(w, (s) => { delete s[PROOF_STAGE].txHash; });
    expect(await w.run(["--stage", "timelock", "--resume"])).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
  });

  test("assertControlProven accepts a finished record on the same Safe signed by every owner at nonce 1", () => {
    const rec: any = { status: "done", safe: "0xAbC0000000000000000000000000000000000001", txHash: "0x1", signers: ["0xa", "0xb"] };
    expect(assertControlProven(rec, { safe: "0xabc0000000000000000000000000000000000001", owners: ["0xA", "0xB"], nonce: 1 })).toBe(rec);
    expect(() => assertControlProven(rec, { safe: rec.safe, owners: ["0xA", "0xB"], nonce: 0 })).toThrow(/nonce is 0/);
    expect(() => assertControlProven(rec, { safe: rec.safe, owners: ["0xA", "0xB", "0xC"], nonce: 1 })).toThrow(/lacks a signature from 0xC/);
  });
});

describe("the verifier reads the proof transaction back", () => {
  test("the healthy world passes all four proof labels with real signatures", async () => {
    const w = buildWorld(8453);
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([]);
    const labels = r.checks.map((c) => c.label);
    for (const l of ["safe: control proof transaction recorded", "safe: control proof transaction succeeded", "safe: control proof is a self-call signed by every owner", "safe: nonce at least 1"]) expect(labels).toContain(l);
  });

  const tx = (input: Hex, over: Partial<{ to: string | null; value: bigint }> = {}) => ({ to: SAFE as string | null, input, value: 0n, ...over });
  const inspect = (t: ReturnType<typeof tx>, nonce = 0, owners: readonly string[] = OWNERS) => inspectProofTx({ chainId: 8453, safe: SAFE, owners, nonce, tx: t });

  test("signed by every owner: ok", async () => {
    expect((await inspect(tx(proofInput(8453)))).ok).toBe(true);
  });
  test("one owner missing from the calldata: not ok", async () => {
    const r = await inspect(tx(proofInput(8453, OWNER_KEYS.slice(0, 2))));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(OWNERS[2]!);
  });
  test("signed over another chain, another Safe nonce or another call: not ok", async () => {
    expect((await inspect(tx(proofInput(918453)))).ok).toBe(false);
    expect((await inspect(tx(proofInput(8453, OWNER_KEYS, 5)))).ok).toBe(false);
  });
  test("a call to another address, with value, or that is not execTransaction: not ok", async () => {
    expect((await inspect(tx(proofInput(8453), { to: "0x00000000000000000000000000000000000000aa" }))).ok).toBe(false);
    expect((await inspect(tx(proofInput(8453), { value: 1n }))).ok).toBe(false);
    expect((await inspect(tx("0x12345678"))).ok).toBe(false);
  });
  test("a signature from someone who is not an owner: not ok", async () => {
    const r = await inspect(tx(proofInput(8453)), 0, OWNERS.slice(0, 2));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("non-owners");
  });
});
