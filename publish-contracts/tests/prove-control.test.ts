// The Safe control proof (core 1618, plan decision 21): before stage 11 the real Safe executes one self-call signed by EVERY owner.
// What is real here: the owner keys sign, the hashes are the Safe tool's own, every signature is recovered, and the verifier decodes the proof
// calldata and recovers the signers. What is a fake: the chain (the runner tests stub forge and cast). The proof against a real Safe contract
// on a real fork is the Twin rehearsal (suite 28, and the suite 14 twin_publish test).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { assertControlProven, inspectProofTx, PROOF_STAGE } from "../src/control-proof.ts";
import { EXIT_CODES } from "../src/errors.ts";
import { assertEveryOwnerSigned } from "../src/prove-control.ts";
import { localSafeTxHash, signTx, type SafeTxBundle } from "../src/safe/index.ts";
import { ADMIN, PROVE_OWNERS, PROVE_SIGNERS, fakeProveApi, keySigner, world } from "./harness.ts";
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

  test("the DEPLOYER submits the proof and pays the gas: owner A sends nothing, and every owner still signed (core 1712)", async () => {
    const w = world({ writeSafeManifest: true, startNonce: 7 });
    expect(await w.run(["--stage", PROOF_STAGE])).toBe(0);
    expect(w.proofSenders).toEqual([ADMIN]);
    expect(w.state().nonces[ADMIN]).toBe(8); // one transaction, from the deployer
    for (const owner of PROVE_OWNERS) expect(w.state().nonces[owner.toLowerCase()] ?? 0).toBe(0); // no owner sent or paid anything
    expect(w.safeCalls.filter((c) => c === "signTx")).toHaveLength(PROVE_OWNERS.length); // all three owners signed
    expect(w.safeCalls).toContain("executeTx:3:all"); // with all three signatures in the calldata
    expect(manifest(w).stages[PROOF_STAGE].sentBy).toBe(ADMIN);
  });

  test("the sender is the deployer signer the run was given, not whichever owner signer comes first", async () => {
    const w = world({ writeSafeManifest: true });
    let sentBy: string | undefined;
    const api = fakeProveApi(w);
    const spy = { ...api, executeTx: async (...a: Parameters<typeof api.executeTx>) => { sentBy = (await a[2].address()).toLowerCase(); return api.executeTx(...a); } };
    expect(await w.run(["--stage", PROOF_STAGE], { prove: { api: spy, ownerSigners: [...PROVE_SIGNERS].reverse() } })).toBe(0);
    expect(sentBy).toBe(ADMIN);
    expect(PROVE_OWNERS.map((o) => o.toLowerCase())).not.toContain(sentBy!);
  });

  test("a full deploy run: the final nonce check passes at the stage counts plus the deployer's one proof transaction (core 1712)", async () => {
    const w = world({ startNonce: 0 });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    const ok = w.logs().find((l) => l.event === "run.nonce_ok"); // the run's own end-of-deploy check ran and passed
    expect(ok).toBeDefined();
    expect(w.proofSenders).toEqual([ADMIN]);
    expect(ok.nonce).toBe(ok.summed_frozen_counts + 1);
    expect(w.state().nonces[ADMIN]).toBe(ok.nonce);
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
  test("a repeated signature on top of every owner: not ok", async () => {
    const r = await inspect(tx(proofInput(8453, [...OWNER_KEYS, OWNER_KEYS[0]!])));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("repeated");
  });
  test("a signature from someone who is not an owner: not ok", async () => {
    const r = await inspect(tx(proofInput(8453)), 0, OWNERS.slice(0, 2));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("non-owners");
  });
});


// ---- adoption of a proof that landed before the run died (issue 1670) -------------------------------------------------------------------
// The chain is the injected ProveChain (events and transaction); the signatures and calldata are real: the owners sign for real, the proof
// calldata is a real execTransaction encoding, and the adoption recovers every signer from it.
const SAFE_ADDR = "0x00000000000000000000000000000000000050fe" as Address;
const CHAIN = 918453;
const LANDED_TX = `0x${"ab".repeat(32)}` as Hex;
const ZERO = "0x0000000000000000000000000000000000000000";
const EXEC = parseAbi(["function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)"]);
const STRANGER = keySigner(`0x${"44".repeat(32)}`);

/** execTransaction calldata signed over `hash` by the given signers, packed ascending by signer address (repeats kept). */
async function execCalldata(o: { signers?: typeof PROVE_SIGNERS; hash?: Hex; to?: Address; value?: bigint; data?: Hex; operation?: number; gasPrice?: bigint } = {}): Promise<Hex> {
  const hash = o.hash ?? localSafeTxHash(CHAIN, SAFE_ADDR, SAFE_ADDR, "0x", 0);
  const sigs = await Promise.all((o.signers ?? PROVE_SIGNERS).map(async (s) => ({ owner: (await s.address()).toLowerCase(), sig: await s.signSafeHash(hash, "raw") })));
  const packed = ("0x" + sigs.sort((a, b) => (a.owner < b.owner ? -1 : 1)).map((x) => x.sig.slice(2)).join("")) as Hex;
  return encodeFunctionData({ abi: EXEC, functionName: "execTransaction", args: [o.to ?? SAFE_ADDR, o.value ?? 0n, o.data ?? "0x", o.operation ?? 0, 0n, 0n, o.gasPrice ?? 0n, ZERO, ZERO, packed] });
}

/** A Safe at nonce 1 whose only execution is on chain. Override any part to build a hostile one. */
async function landed(w: ReturnType<typeof world>, o: { input?: Hex; safeTxHash?: Hex; success?: boolean; value?: bigint; to?: string | null; status?: "success" | "reverted"; nonce?: number; extra?: number; from?: Address } = {}): Promise<void> {
  w.safeNonce = o.nonce ?? 1;
  const ev = { txHash: LANDED_TX, safeTxHash: o.safeTxHash ?? localSafeTxHash(CHAIN, SAFE_ADDR, SAFE_ADDR, "0x", 0), success: o.success ?? true, block: 9, logIndex: 0 };
  w.landed.executions = [ev, ...Array.from({ length: o.extra ?? 0 }, (_, i) => ({ ...ev, txHash: `0x${"cd".repeat(31)}0${i}` as Hex, block: 10 + i }))];
  w.landed.txs[LANDED_TX] = { from: o.from ?? ADMIN, to: o.to === undefined ? SAFE_ADDR : o.to, input: o.input ?? (await execCalldata()), value: o.value ?? 0n, status: o.status ?? "success", block: 9 };
}
const sends = (w: ReturnType<typeof world>) => w.safeCalls.filter((c) => c === "proposeTx" || c === "signTx" || c === "checkSignaturesOnChain" || c.startsWith("executeTx"));
const resumeProof = (w: ReturnType<typeof world>) => w.run(["--stage", PROOF_STAGE, "--resume"]);

describe("prove-control adopts a proof that landed before the run died", () => {
  test("a Safe at nonce 1 with the valid nonce-0 self-call signed by every owner: recorded done and adopted with the on-chain hash, and nothing is proposed, signed or sent", async () => {
    const w = world({ writeSafeManifest: true });
    await landed(w);
    expect(await resumeProof(w)).toBe(0);
    expect(sends(w)).toEqual([]);
    expect(forgeBroadcasts(w)).toEqual([]);
    expect(w.safeNonce).toBe(1);
    expect(w.landed.reads[0]).toBe("executions:7"); // from the safe stage block
    const rec = manifest(w).stages[PROOF_STAGE];
    expect(rec).toMatchObject({ status: "done", adopted: true, safe: SAFE_ADDR, txHash: LANDED_TX, nonce: 0, block: 9 });
    expect(rec.signers).toEqual(PROVE_OWNERS.map((a) => a.toLowerCase()).sort());
    expect(rec.safeTxHash).toBe(localSafeTxHash(CHAIN, SAFE_ADDR, SAFE_ADDR, "0x", 0));
  });

  test("the adoption does not look at who sent the transaction: the deployer, an owner or any other account is recorded as sentBy, never refused", async () => {
    for (const from of [ADMIN, PROVE_OWNERS[0]!, "0x00000000000000000000000000000000000000bb"] as Address[]) {
      const w = world({ writeSafeManifest: true });
      await landed(w, { from });
      expect(await resumeProof(w)).toBe(0);
      expect(sends(w)).toEqual([]);
      expect(manifest(w).stages[PROOF_STAGE]).toMatchObject({ status: "done", adopted: true, sentBy: from });
    }
  });

  test("a crash between the execution and the manifest write, then --resume: the proof is adopted, the stage 11 gate accepts it, the timelock stage runs, and the proof is sent once", async () => {
    const w = world({ startNonce: 0 });
    const api = fakeProveApi(w);
    const crashing = { ...api, executeTx: async (...a: Parameters<typeof api.executeTx>) => {
      await api.executeTx(...a); // the transaction lands (nonce 1) ...
      await landed(w);
      throw new Error("the process died before the run manifest was written"); // ... and the run dies
    } };
    expect(await w.run(["--stage", "deploy"], { prove: { api: crashing, ownerSigners: PROVE_SIGNERS } })).not.toBe(0);
    expect(manifest(w).stages[PROOF_STAGE]).toBeUndefined();
    expect(w.safeNonce).toBe(1);
    expect(forgeBroadcasts(w).some((c: any) => String(c.args[1]).includes("DeployTimelock"))).toBe(false);
    const before = sends(w).length;
    expect(await w.run(["--stage", "deploy", "--resume"])).toBe(0);
    expect(sends(w)).toHaveLength(before); // nothing was proposed, signed or sent again
    expect(executed(w)).toHaveLength(1);
    expect(manifest(w).stages[PROOF_STAGE]).toMatchObject({ status: "done", adopted: true, txHash: LANDED_TX });
    expect(w.logs().some((l) => l.event === "stage.control_proof_ok")).toBe(true);
    expect(forgeBroadcasts(w).some((c: any) => String(c.args[1]).includes("DeployTimelock"))).toBe(true);
  });

  test("a rerun without --resume does not adopt: refused, and the message names --resume", async () => {
    const w = world({ writeSafeManifest: true });
    await landed(w);
    expect(await w.run(["--stage", PROOF_STAGE])).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(lastError(w).message).toContain("--resume");
    expect(w.landed.reads).toEqual([]);
    expect(existsSync(manifestPath(w)) ? manifest(w).stages[PROOF_STAGE] : undefined).toBeUndefined();
  });

  const refused = async (w: ReturnType<typeof world>, reason: RegExp) => {
    expect(await resumeProof(w)).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(lastError(w).message).toMatch(reason);
    expect(sends(w)).toEqual([]);
    expect(forgeBroadcasts(w)).toEqual([]);
    expect(existsSync(manifestPath(w)) ? manifest(w).stages[PROOF_STAGE] : undefined).toBeUndefined();
  };
  const hostile: [string, (w: ReturnType<typeof world>) => Promise<void>, RegExp][] = [
    ["a stranger signed in place of an owner (wrong signer set)", async (w) => landed(w, { input: await execCalldata({ signers: [PROVE_SIGNERS[0]!, PROVE_SIGNERS[1]!, STRANGER] }) }), /no valid signature over the proof hash from/],
    ["an owner signature is missing", async (w) => landed(w, { input: await execCalldata({ signers: PROVE_SIGNERS.slice(0, 2) }) }), /no valid signature over the proof hash from/],
    ["a repeated signer fills the missing owner's slot", async (w) => landed(w, { input: await execCalldata({ signers: [PROVE_SIGNERS[0]!, PROVE_SIGNERS[1]!, PROVE_SIGNERS[1]!] }) }), /no valid signature|repeated/],
    ["a repeated signer on top of every owner", async (w) => landed(w, { input: await execCalldata({ signers: [...PROVE_SIGNERS, PROVE_SIGNERS[0]!] }) }), /repeated/],
    ["a stranger signed on top of every owner", async (w) => landed(w, { input: await execCalldata({ signers: [...PROVE_SIGNERS, STRANGER] }) }), /non-owners/],
    ["the signatures are over another Safe's hash (replay of another Safe's transaction)", async (w) => landed(w, { input: await execCalldata({ hash: localSafeTxHash(CHAIN, "0x00000000000000000000000000000000000000aa", "0x00000000000000000000000000000000000000aa", "0x", 0) }) }), /no valid signature over the proof hash from/],
    ["the signatures are over another chain's hash", async (w) => landed(w, { input: await execCalldata({ hash: localSafeTxHash(8453, SAFE_ADDR, SAFE_ADDR, "0x", 0) }) }), /no valid signature over the proof hash from/],
    ["the signatures are over nonce 1", async (w) => landed(w, { input: await execCalldata({ hash: localSafeTxHash(CHAIN, SAFE_ADDR, SAFE_ADDR, "0x", 1) }) }), /no valid signature over the proof hash from/],
    ["the transaction goes to another target", async (w) => landed(w, { to: "0x00000000000000000000000000000000000000aa" }), /not the Safe/],
    ["the Safe called another address (not a self-call)", async (w) => landed(w, { safeTxHash: localSafeTxHash(CHAIN, SAFE_ADDR, "0x00000000000000000000000000000000000000aa", "0x", 0), input: await execCalldata({ to: "0x00000000000000000000000000000000000000aa" }) }), /not the self-call/],
    ["the Safe call carries value", async (w) => landed(w, { input: await execCalldata({ value: 1n }) }), /not a plain call/],
    ["the outer transaction carries value", async (w) => landed(w, { value: 1n }), /carries value/],
    ["the Safe call carries data", async (w) => landed(w, { safeTxHash: localSafeTxHash(CHAIN, SAFE_ADDR, SAFE_ADDR, "0xdeadbeef", 0), input: await execCalldata({ data: "0xdeadbeef" }) }), /not the self-call/],
    ["the Safe call carries data and its event hash is forged to the self-call hash", async (w) => landed(w, { input: await execCalldata({ data: "0xdeadbeef" }) }), /not a plain call/],
    ["a delegatecall (or module) operation with the self-call hash forged", async (w) => landed(w, { input: await execCalldata({ operation: 1 }) }), /not a plain call/],
    ["the Safe call pays a gas price", async (w) => landed(w, { input: await execCalldata({ gasPrice: 1n }) }), /not a plain call/],
    ["the Safe emitted ExecutionFailure", async (w) => landed(w, { success: false }), /ExecutionFailure/],
    ["the transaction reverted", async (w) => landed(w, { status: "reverted" }), /did not succeed/],
    ["the transaction cannot be read", async (w) => { await landed(w); w.landed.txs = {}; }, /cannot be read/],
    ["the Safe nonce is 1 but no execution event exists", async (w) => { w.safeNonce = 1; }, /no execution event/],
    ["the Safe nonce is 2 with no record", async (w) => landed(w, { nonce: 2, extra: 1 }), /nonce is 2/],
    ["the Safe nonce is 1 but two execution events exist (two candidates)", async (w) => landed(w, { extra: 1 }), /expected exactly one/],
    ["the Safe nonce is 3", async (w) => landed(w, { nonce: 3 }), /nonce is 3/],
  ];
  for (const [name, setup, reason] of hostile) {
    test(`refused with CONTROL_NOT_PROVEN and nothing sent: ${name}`, async () => {
      const w = world({ writeSafeManifest: true });
      await setup(w);
      await refused(w, reason);
    });
  }

  test("--resume with nothing on chain does not skip the proof: stage 11 still refuses", async () => {
    const w = world({ writeSafeManifest: true, startNonce: 0 });
    w.safeNonce = 1;
    expect(await w.run(["--stage", "timelock", "--resume"])).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(lastError(w).message).toContain("no finished Safe control proof");
    expect(forgeBroadcasts(w)).toEqual([]);
  });

  test("--resume at nonce 0 (nothing landed) takes the proof normally, once", async () => {
    const w = world({ writeSafeManifest: true });
    expect(await resumeProof(w)).toBe(0);
    expect(executed(w)).toHaveLength(1);
    expect(manifest(w).stages[PROOF_STAGE].adopted).toBeUndefined();
  });

  test("an adopted proof with the safe stage block unknown is refused (no guess of block 0)", async () => {
    const w = world({ writeSafeManifest: true });
    writeFileSync(join(w.coreDir, "deployments", String(CHAIN), "safe.json"), JSON.stringify({ safe: SAFE_ADDR }));
    await landed(w);
    await refused(w, /no safe stage block/);
  });
});

describe("the real chain reader walks the log range in windows and reads only", () => {
  test("realProveChain.executions: windows of LOG_WINDOW, ExecutionSuccess and ExecutionFailure of the Safe address only, oldest first", async () => {
    const { LOG_WINDOW, realProveChain } = await import("../src/prove-control.ts");
    const calls: any[] = [];
    const handle: any = { address: SAFE_ADDR, client: {
      getBlockNumber: async () => 5000n,
      getLogs: async (a: any) => { calls.push(a); return a.fromBlock === 2000n ? [{ transactionHash: LANDED_TX, blockNumber: 2100n, logIndex: 3, eventName: "ExecutionSuccess", args: { txHash: `0x${"11".repeat(32)}` } }] : []; },
    } };
    const out = await realProveChain.executions(handle, 0);
    expect(calls.map((c) => [c.fromBlock, c.toBlock])).toEqual([[0n, 1999n], [2000n, 3999n], [4000n, 5000n]]);
    expect(LOG_WINDOW).toBe(2000n);
    expect(calls.every((c) => c.address === SAFE_ADDR && c.events.length === 2)).toBe(true);
    expect(out).toEqual([{ txHash: LANDED_TX, safeTxHash: `0x${"11".repeat(32)}`, success: true, block: 2100, logIndex: 3 }]);
  });
  test("a log read that fails is refused, not treated as an empty range", async () => {
    const { realProveChain } = await import("../src/prove-control.ts");
    const handle: any = { address: SAFE_ADDR, client: { getBlockNumber: async () => 10n, getLogs: async () => { throw new Error("range too large"); } } };
    await expect(realProveChain.executions(handle, 0)).rejects.toThrow(/range too large/);
  });
});
