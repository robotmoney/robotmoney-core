// The Safe control proof (core 1618, plan decision 21): before stage 11 the real Safe executes one self-call signed by EVERY owner.
// What is real here: the owner keys sign, the hashes are the Safe tool's own, every signature is recovered, and the verifier decodes the proof
// calldata and recovers the signers. What is a fake: the chain (the runner tests stub forge and cast). The proof against a real Safe contract
// on a real fork is the Twin rehearsal (suite 28, and the suite 14 twin_publish test).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, encodeAbiParameters, encodeEventTopics, encodeFunctionData, http, keccak256, parseAbi, parseAbiItem, toHex, type Address, type Hex } from "viem";
import { assertControlProven, inspectProofTx, PROOF_STAGE } from "../src/control-proof.ts";
import { EXIT_CODES } from "../src/errors.ts";
import { LOG_READ_TRIES, LOG_RETRY_DELAY_MS, LOG_WINDOW, MAX_LOG_WINDOWS, assertEveryOwnerSigned, realProveChain, type ProveApi } from "../src/prove-control.ts";
import { parseCli } from "../src/cli.ts";
import { SHA } from "./fixtures.ts";
import { READ_RETRY_TRIES, localSafeTxHash, ownerHardwareSigner, signTx, type SafeHandle, type SafeTxBundle } from "../src/safe/index.ts";
import { ADMIN, PROVE_OWNERS, PROVE_SIGNERS, fakeProveApi, fakeSafeApi, keySigner, typedPrompt, world } from "./harness.ts";
import { privateKeyToAccount } from "viem/accounts";
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

// ---- QA plan v1 E6 (issue 1723): the Safe nonce read through a load-balanced RPC ---------------------------------------------------------
// The fake Safe handle answers the nonce from a node behind the proof block for the first `stale` reads (0), then the chain's own nonce.
function staleHandle<T extends object>(api: T, w: ReturnType<typeof world>, stale: number): { n: { reads: number }; api: T } {
  const n = { reads: 0 };
  const inner = (api as unknown as { connectSafe: (...a: unknown[]) => Promise<SafeHandle> }).connectSafe;
  const connectSafe = async (...a: unknown[]) => { const h = await inner(...a); return { ...h, nonce: async () => (++n.reads <= stale ? 0 : w.safeNonce) } as unknown as SafeHandle; };
  return { n, api: { ...api, connectSafe } as T };
}

describe("QA plan v1 E6: the prove-control entry and the stage 11 gate read the Safe nonce again while a stale node answers 0", () => {
  test("a stale nonce 0 right after the proof landed does not re-run the proof: --resume reads again, sees 1 and adopts the landed proof, nothing proposed, signed or sent", async () => {
    const w = world({ writeSafeManifest: true });
    await landed(w);
    const s = staleHandle(fakeProveApi(w), w, 2);
    let slept = 0;
    expect(await w.run(["--stage", PROOF_STAGE, "--resume"], { prove: { api: s.api, ownerSigners: PROVE_SIGNERS }, readRetry: { sleep: async () => { slept++; } } })).toBe(0);
    expect([s.n.reads, slept]).toEqual([3, 2]); // the nonce converged to 1 on the third read
    expect(sends(w)).toEqual([]);
    expect(manifest(w).stages[PROOF_STAGE]).toMatchObject({ status: "done", adopted: true, txHash: LANDED_TX, nonce: 0 });
  });

  test("without --resume the same stale 0 does not re-run the proof either: refused, the message names --resume, nothing sent", async () => {
    const w = world({ writeSafeManifest: true });
    await landed(w);
    const s = staleHandle(fakeProveApi(w), w, 2);
    expect(await w.run(["--stage", PROOF_STAGE], { prove: { api: s.api, ownerSigners: PROVE_SIGNERS } })).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(lastError(w).message).toContain("--resume");
    expect(sends(w)).toEqual([]);
  });

  test("a Safe that reads 0 on every read of the bound is a new Safe: the proof is taken once, after READ_RETRY_TRIES reads", async () => {
    const w = world({ writeSafeManifest: true });
    const s = staleHandle(fakeProveApi(w), w, 0);
    let slept = 0;
    expect(await w.run(["--stage", PROOF_STAGE], { prove: { api: s.api, ownerSigners: PROVE_SIGNERS }, readRetry: { sleep: async () => { slept++; } } })).toBe(0);
    expect(s.n.reads).toBe(READ_RETRY_TRIES + 1); // the bound at the entry, then proposeTx reads the nonce it signs over
    expect(slept).toBe(READ_RETRY_TRIES - 1);
    expect(executed(w)).toHaveLength(1);
    expect(manifest(w).stages[PROOF_STAGE]).toMatchObject({ status: "done", nonce: 0 });
  });

  test("the stage 11 gate right after the proof: a stale 0 is read again until it moves, and the gate passes", async () => {
    const w = world({ writeSafeManifest: true, startNonce: 0 });
    expect(await w.run(["--stage", PROOF_STAGE])).toBe(0);
    const s = staleHandle(fakeSafeApi(w), w, 2);
    expect(await w.run(["--stage", "timelock", "--resume"], { safeApi: s.api })).not.toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(s.n.reads).toBe(3);
    expect(w.logs().some((l) => l.event === "stage.control_proof_ok")).toBe(true);
  });

  test("the stage 11 gate: a Safe still at 0 after the whole bound is refused as before (no false success)", async () => {
    const w = world({ writeSafeManifest: true, startNonce: 0 });
    expect(await w.run(["--stage", PROOF_STAGE])).toBe(0);
    w.safeNonce = 0;
    const s = staleHandle(fakeSafeApi(w), w, 0);
    expect(await w.run(["--stage", "timelock", "--resume"], { safeApi: s.api })).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(lastError(w).message).toContain("nonce is 0");
    expect(s.n.reads).toBe(READ_RETRY_TRIES);
    expect(forgeBroadcasts(w)).toEqual([]);
  });

  test("the stage 11 gate with no proof on record does not wait: one nonce read, refused", async () => {
    const w = world({ writeSafeManifest: true, startNonce: 0 });
    const s = staleHandle(fakeSafeApi(w), w, 0);
    expect(await w.run(["--stage", "timelock"], { safeApi: s.api })).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(lastError(w).message).toContain("no finished Safe control proof");
    expect(s.n.reads).toBe(1);
  });
});

describe("hardware owner signers in prove-control (a simulated cast, no device)", () => {
  const KEYS = [toHex(0xb1, { size: 32 }), toHex(0xb2, { size: 32 }), toHex(0xb3, { size: 32 })] as const;
  const accts = KEYS.map((k) => privateKeyToAccount(k));
  const path = (i: number) => `m/44'/60'/${i}'/0/0`;
  /** attached[i] is the account the device at path i reports. The event log records every prompt and every cast call in order. */
  function rig(attached: () => number[]) {
    const events: string[] = [];
    const runner = async (args: string[]) => {
      const i = Number(/m\/44'\/60'\/(\d)'/.exec(args[args.indexOf("--mnemonic-derivation-path") + 1]!)![1]);
      const a = accts[attached()[i]!]!;
      events.push(`cast:${args[1]}:${i}`);
      if (args[1] === "address") return { code: 0, stdout: a.address, stderr: "" };
      return { code: 0, stdout: await a.signMessage({ message: { raw: args[args.length - 1] as Hex } }), stderr: "" };
    };
    const prompt = async (r: { owner: string; phase: string }) => { events.push(`prompt:${r.phase}:${accts.findIndex((a) => a.address === r.owner)}`); };
    const signers = (claimed: number[]) => claimed.map((c, i) => ownerHardwareSigner(`ledger:${path(i)}@${accts[c]!.address}`, { runner, prompt }));
    return { events, signers, runner };
  }
  /**
   * The same rig behind main(): the CLI builds the signers itself from `--owner-signer ledger:PATH@0xOWNER` with deps.castRunner, and its
   * device prompt is a string question through deps.prompt (the stage confirmation still goes to the typed prompt). `safe:connect` marks
   * the moment prove-control first touches the Safe.
   */
  function cliRig(w: ReturnType<typeof world>, attached: () => number[]) {
    const r = rig(attached);
    const typed = typedPrompt();
    const prompt = async (q: string): Promise<string> => {
      const m = /for Safe owner (0x[0-9a-fA-F]{40}) \([^)]*\) to (read its address|sign|send)/.exec(q);
      if (!m) return typed(q);
      r.events.push(`prompt:${m[2] === "read its address" ? "address" : m[2]}:${accts.findIndex((a) => a.address === m[1])}`);
      return "";
    };
    const api = fakeProveApi(w);
    const spy = { ...api, connectSafe: async (...a: Parameters<typeof api.connectSafe>) => { r.events.push("safe:connect"); return api.connectSafe(...a); } };
    const args = (claimed: number[]) => claimed.flatMap((c, i) => ["--owner-signer", `ledger:${path(i)}@${accts[c]!.address}`]);
    const deps = { prove: { api: spy }, castRunner: r.runner, prompt };
    return { events: r.events, args, deps };
  }

  test("a prompt before each address read and before each signature, in owner order, and the proof lands", async () => {
    const w = world({ writeSafeManifest: true });
    const r = rig(() => [0, 1, 2]);
    expect(await w.run(["--stage", PROOF_STAGE], { prove: { api: fakeProveApi(w), ownerSigners: r.signers([0, 1, 2]) } })).toBe(0);
    const prompts = r.events.filter((e) => e.startsWith("prompt:"));
    expect(prompts).toEqual(["prompt:address:0", "prompt:address:1", "prompt:address:2", "prompt:sign:0", "prompt:sign:1", "prompt:sign:2"]);
    // each prompt is immediately followed by its own device read or signature
    expect(r.events.slice(0, 4)).toEqual(["prompt:address:0", "cast:address:0", "prompt:address:1", "cast:address:1"]);
    expect(r.events.indexOf("prompt:sign:0")).toBe(r.events.indexOf("cast:sign:0") - 2);
  });

  test("a device that reports another address than its named owner is refused and nothing is proposed", async () => {
    const w = world({ writeSafeManifest: true });
    const r = rig(() => [0, 2, 2]);
    expect(await w.run(["--stage", PROOF_STAGE], { prove: { api: fakeProveApi(w), ownerSigners: r.signers([0, 1, 2]) } })).not.toBe(0);
    expect(lastError(w).message).toContain("HARDWARE_ADDRESS_MISMATCH");
    expect(w.safeCalls).not.toContain("proposeTx");
    expect(executed(w)).toEqual([]);
  });

  test("two specs that resolve to the same address are refused before any proposal", async () => {
    const w = world({ writeSafeManifest: true });
    const r = rig(() => [0, 0, 2]);
    expect(await w.run(["--stage", PROOF_STAGE], { prove: { api: fakeProveApi(w), ownerSigners: r.signers([0, 0, 2]) } })).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(lastError(w).message).toContain("same address");
    expect(w.safeCalls).not.toContain("proposeTx");
  });

  // Through main() (QD-8, the hunk the 1693 merge dropped): the CLI builds the owner signers one at a time, in the order given.
  test("main() builds the --owner-signer devices in order, one at a time, every one read before the Safe is connected, and the proof lands", async () => {
    const w = world({ writeSafeManifest: true });
    const r = cliRig(w, () => [0, 1, 2]);
    expect(await w.run(["--stage", PROOF_STAGE, ...r.args([0, 1, 2])], r.deps)).toBe(0);
    // construction: prompt, read, next device; all three devices before prove-control touches the Safe
    expect(r.events.slice(0, 7)).toEqual(["prompt:address:0", "cast:address:0", "prompt:address:1", "cast:address:1", "prompt:address:2", "cast:address:2", "safe:connect"]);
    // the address read at construction is cached: no second address prompt, then one sign prompt per owner in owner order
    expect(r.events.filter((e) => e.startsWith("prompt:"))).toEqual(["prompt:address:0", "prompt:address:1", "prompt:address:2", "prompt:sign:0", "prompt:sign:1", "prompt:sign:2"]);
    expect(r.events.indexOf("prompt:sign:0")).toBe(r.events.indexOf("cast:sign:0") - 2);
    expect(w.safeCalls).toContain("executeTx:3:all");
    expect(w.safeNonce).toBe(1);
  });

  test("main(): a wrong device stops while the signers are built: the next device is never asked for and the Safe is never connected", async () => {
    const w = world({ writeSafeManifest: true });
    const r = cliRig(w, () => [0, 2, 2]);
    expect(await w.run(["--stage", PROOF_STAGE, ...r.args([0, 1, 2])], r.deps)).not.toBe(0);
    expect(lastError(w).message).toContain("HARDWARE_ADDRESS_MISMATCH");
    expect(r.events).toEqual(["prompt:address:0", "cast:address:0", "prompt:address:1", "cast:address:1"]);
    expect(w.safeCalls).not.toContain("connectSafe:prove");
    expect(w.safeCalls).not.toContain("proposeTx");
    expect(executed(w)).toEqual([]);
  });
});

describe("the real chain reader walks the log range in windows and reads only", () => {
  test("realProveChain.executions: windows of LOG_WINDOW from the safe stage block, ExecutionSuccess and ExecutionFailure of the Safe address only, and it stops at the window that holds the event (QA plan v1 E7)", async () => {
    const calls: any[] = [];
    const handle: any = { address: SAFE_ADDR, client: {
      getBlockNumber: async () => 5000n,
      getLogs: async (a: any) => { calls.push(a); return a.fromBlock === 2000n ? [{ transactionHash: LANDED_TX, blockNumber: 2100n, logIndex: 3, eventName: "ExecutionSuccess", args: { txHash: `0x${"11".repeat(32)}` } }] : []; },
    } };
    const out = await realProveChain.executions(handle, 0);
    expect(calls.map((c) => [c.fromBlock, c.toBlock])).toEqual([[0n, 1999n], [2000n, 3999n]]); // the window 4000 to 5000 is never read
    expect(LOG_WINDOW).toBe(2000n);
    expect(MAX_LOG_WINDOWS).toBe(2000n);
    expect(calls.every((c) => c.address === SAFE_ADDR && c.events.length === 2)).toBe(true);
    expect(out).toEqual([{ txHash: LANDED_TX, safeTxHash: `0x${"11".repeat(32)}`, success: true, block: 2100, logIndex: 3 }]);
  });
  test("a log read that fails is refused, not treated as an empty range", async () => {
    const handle: any = { address: SAFE_ADDR, client: { getBlockNumber: async () => 10n, getLogs: async () => { throw new Error("upstream connect error"); } } };
    let waits = 0;
    await expect(realProveChain.executions(handle, 0, { retry: { sleep: async () => { waits++; } } })).rejects.toThrow(/^RPC_REFUSED: .* eth_getLogs for blocks 0 to 10 .*upstream connect error/);
    expect(waits).toBe(LOG_READ_TRIES - 1);
  });
});

// ---- QA plan v1 E7 (issue 1724): the adoption's chain reads against stub JSON-RPC servers (Bun.serve on loopback: no chain, no network) -------------------------
// On the first mainnet run mainnet.base.org refused the scan (HTTP 429, range and rate limits) and a pruned node refused eth_getTransactionReceipt. Each stub answers
// eth_chainId, eth_blockNumber, eth_getLogs (the proof's ExecutionSuccess at `eventBlock`), eth_getTransactionByHash and eth_getTransactionReceipt (the landed proof),
// and records every call. `on` overrides a method on its n-th call (from 1): an HTTP status, a JSON-RPC error or another result. The clients have no viem retry, so every
// read the reader makes reaches the stub exactly once.
const stubs: { stop: (force?: boolean) => void }[] = [];
afterAll(() => { for (const x of stubs) x.stop(true); });
type StubReply = { status: number; body?: string } | { error: { code: number; message: string } } | { result: unknown };
const hexOf = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const EXEC_SUCCESS = parseAbiItem("event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)");
const BLOCK_HASH = `0x${"bb".repeat(32)}`;

function stubRpc(o: { chainId?: number; head?: bigint; eventBlock?: bigint; input?: Hex; on?: (method: string, params: any[], n: number) => StubReply | undefined } = {}) {
  const calls: { method: string; params: any[] }[] = [];
  const count: Record<string, number> = {};
  const at = o.eventBlock ?? 9n;
  const answer = (method: string, params: any[]): unknown => {
    switch (method) {
      case "eth_chainId": return hexOf(o.chainId ?? CHAIN);
      case "eth_blockNumber": return hexOf(o.head ?? 100_000n);
      case "eth_getLogs": {
        const f = params[0];
        if (o.eventBlock === undefined || o.eventBlock < BigInt(f.fromBlock) || o.eventBlock > BigInt(f.toBlock)) return [];
        return [{
          address: SAFE_ADDR, topics: encodeEventTopics({ abi: [EXEC_SUCCESS], eventName: "ExecutionSuccess", args: { txHash: localSafeTxHash(CHAIN, SAFE_ADDR, SAFE_ADDR, "0x", 0) } }),
          data: encodeAbiParameters([{ type: "uint256" }], [0n]), blockNumber: hexOf(o.eventBlock), blockHash: BLOCK_HASH, transactionHash: LANDED_TX, transactionIndex: "0x0", logIndex: "0x2", removed: false,
        }];
      }
      case "eth_getTransactionByHash": return {
        hash: LANDED_TX, from: ADMIN, to: SAFE_ADDR, input: o.input ?? "0x", value: "0x0", blockNumber: hexOf(at), blockHash: BLOCK_HASH, transactionIndex: "0x0",
        nonce: "0x7", gas: "0x30000", gasPrice: "0x1", type: "0x0", v: "0x1b", r: "0x1", s: "0x1", chainId: hexOf(o.chainId ?? CHAIN),
      };
      case "eth_getTransactionReceipt": return {
        transactionHash: LANDED_TX, blockHash: BLOCK_HASH, blockNumber: hexOf(at), transactionIndex: "0x0", from: ADMIN, to: SAFE_ADDR, cumulativeGasUsed: "0x1", gasUsed: "0x1",
        effectiveGasPrice: "0x1", contractAddress: null, logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x0",
      };
    }
    throw new Error(`stub: ${method}`);
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const b = (await req.json()) as { id: number; method: string; params?: any[] };
      const params = b.params ?? [];
      calls.push({ method: b.method, params });
      count[b.method] = (count[b.method] ?? 0) + 1;
      const r = o.on?.(b.method, params, count[b.method]!) ?? { result: answer(b.method, params) };
      if ("status" in r) return new Response(r.body ?? "Too Many Requests", { status: r.status });
      return Response.json({ jsonrpc: "2.0", id: b.id, ...r });
    },
  });
  stubs.push(server);
  return {
    url: `http://127.0.0.1:${server.port}`,
    methods: () => calls.map((c) => c.method),
    ranges: () => calls.filter((c) => c.method === "eth_getLogs").map((c) => [BigInt(c.params[0].fromBlock), BigInt(c.params[0].toBlock)]),
  };
}
/** A Safe handle whose client reads the stub at `url`, without viem's own retry. */
const stubHandle = (url: string): SafeHandle => ({ address: SAFE_ADDR, chain: { rpcUrl: url, chainId: CHAIN }, client: createPublicClient({ transport: http(url, { retryCount: 0 }) }) }) as unknown as SafeHandle;
/** The backoff seam: records each wait, never sleeps. */
const noWait = () => { const waits: number[] = []; return { waits, retry: { sleep: async (ms: number) => { waits.push(ms); } } }; };
const rejection = (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error("expected a refusal"); }, (e) => e);
/** prove-control's api with the REAL chain reader: the fake Safe (owners, nonce) whose client reads the stub `--rpc` at `url`. */
function realReaderApi(w: ReturnType<typeof world>, url: string): ProveApi {
  const api = fakeProveApi(w);
  return { ...api, chain: realProveChain, connectSafe: async (o) => ({ ...(await api.connectSafe(o)), chain: { rpcUrl: url, chainId: CHAIN }, client: createPublicClient({ transport: http(url, { retryCount: 0 }) }) }) as unknown as SafeHandle };
}
const proofEvent = { txHash: LANDED_TX, safeTxHash: localSafeTxHash(CHAIN, SAFE_ADDR, SAFE_ADDR, "0x", 0), success: true, logIndex: 2 };

describe("QA plan v1 E7 (issue 1724): the adoption's log scan rides out a public RPC and refuses by name", () => {
  test("a failing eth_getLogs is a refusal, never an empty answer", async () => {
    const w = world({ writeSafeManifest: true });
    await landed(w); // a Safe at nonce 1: --resume adopts, and the adoption reads the chain
    const rpc = stubRpc({ eventBlock: 9n, on: (m) => (m === "eth_getLogs" ? { status: 503, body: "upstream unavailable" } : undefined) });
    expect(await w.run(["--stage", PROOF_STAGE, "--resume"], { prove: { api: realReaderApi(w, rpc.url), ownerSigners: PROVE_SIGNERS } })).toBe(EXIT_CODES.SAFE);
    const err = lastError(w);
    expect(err.message).toStartWith("RPC_REFUSED: the RPC at 127.0.0.1 refused eth_getLogs for blocks 7 to 2006 of Safe");
    expect(err.message).toContain("HTTP 503");
    expect(err.message).not.toContain("no execution event"); // a refused read never reads as "nothing landed"
    expect(rpc.ranges()).toEqual(Array.from({ length: LOG_READ_TRIES }, () => [7n, 2006n])); // the same window, LOG_READ_TRIES reads, then the refusal
    expect(w.logs().filter((l) => l.event === "prove_control.rpc_retry")).toHaveLength(LOG_READ_TRIES - 1);
    expect(sends(w)).toEqual([]);
    expect(forgeBroadcasts(w)).toEqual([]);
    expect(existsSync(manifestPath(w)) ? manifest(w).stages[PROOF_STAGE] : undefined).toBeUndefined();
  });

  test("HTTP 429 on the first three eth_getLogs reads, then the logs: the event is found after three doubling waits, four reads of that window", async () => {
    const rpc = stubRpc({ eventBlock: 900n, on: (m, _p, n) => (m === "eth_getLogs" && n <= 3 ? { status: 429 } : undefined) });
    const t = noWait();
    expect(await realProveChain.executions(stubHandle(rpc.url), 7, { retry: t.retry })).toEqual([{ ...proofEvent, block: 900 }]);
    expect(rpc.ranges()).toEqual(Array.from({ length: 4 }, () => [7n, 2006n]));
    expect(t.waits).toEqual([LOG_RETRY_DELAY_MS, 2 * LOG_RETRY_DELAY_MS, 4 * LOG_RETRY_DELAY_MS]);
  });

  test("HTTP 429 on every read: RPC_REFUSED names the RPC host, eth_getLogs and the block range, after LOG_READ_TRIES reads (bounded)", async () => {
    const rpc = stubRpc({ eventBlock: 900n, on: (m) => (m === "eth_getLogs" ? { status: 429 } : undefined) });
    const t = noWait();
    const err = await rejection(realProveChain.executions(stubHandle(rpc.url), 7, { retry: t.retry }));
    expect(err.kind).toBe("SAFE");
    expect(EXIT_CODES[err.kind as keyof typeof EXIT_CODES]).toBe(19);
    expect(err.details).toMatchObject({ error: "RPC_REFUSED", rpc_host: "127.0.0.1", method: "eth_getLogs", subject: `blocks 7 to 2006 of Safe ${SAFE_ADDR}`, reads: LOG_READ_TRIES, status: 429 });
    expect(err.message).toContain("HTTP 429");
    expect(err.message).toContain("--logs-rpc");
    expect(rpc.ranges()).toHaveLength(LOG_READ_TRIES);
    expect(t.waits).toEqual([1, 2, 4, 8, 16].map((x) => x * LOG_RETRY_DELAY_MS));
  });

  test("a range-limit refusal halves the window until the provider takes it, and the scan still finds the one execution event, with no wait", async () => {
    const tooWide = (p: any[]) => BigInt(p[0].toBlock) - BigInt(p[0].fromBlock) + 1n > 500n;
    const rpc = stubRpc({ eventBlock: 1300n, on: (m, p) => (m === "eth_getLogs" && tooWide(p) ? { error: { code: -32005, message: "query exceeds max block range 500" } } : undefined) });
    const t = noWait();
    expect(await realProveChain.executions(stubHandle(rpc.url), 7, { retry: t.retry })).toEqual([{ ...proofEvent, block: 1300 }]);
    expect(rpc.ranges()).toEqual([[7n, 2006n], [7n, 1006n], [7n, 506n], [507n, 1006n], [1007n, 1506n]]);
    expect(t.waits).toEqual([]);
  });

  test("a proof near the safe stage block costs two eth_getLogs reads, not a walk to a head 5 000 000 blocks on", async () => {
    const rpc = stubRpc({ head: 5_000_000n, eventBlock: 2500n });
    expect(await realProveChain.executions(stubHandle(rpc.url), 7, noWait())).toEqual([{ ...proofEvent, block: 2500 }]);
    expect(rpc.ranges()).toEqual([[7n, 2006n], [2007n, 4006n]]);
  });

  test("no event up to the head is an empty answer only after every window up to the head was read", async () => {
    const rpc = stubRpc({ head: 4100n });
    expect(await realProveChain.executions(stubHandle(rpc.url), 7, noWait())).toEqual([]);
    expect(rpc.ranges()).toEqual([[7n, 2006n], [2007n, 4006n], [4007n, 4100n]]);
  });

  test("a scan that reaches its bound with no event is refused by name (LOG_SCAN_LIMIT), never walked further", async () => {
    const rpc = stubRpc({ head: 1_000_000n });
    const err = await rejection(realProveChain.executions(stubHandle(rpc.url), 7, { maxWindows: 3n, ...noWait() }));
    expect(err.kind).toBe("SAFE");
    expect(err.message).toStartWith(`LOG_SCAN_LIMIT: no execution event of Safe ${SAFE_ADDR} in blocks 7 to 6006`);
    expect(err.details).toMatchObject({ error: "LOG_SCAN_LIMIT", from: 7, to: 6006, windows: 3 });
    expect(rpc.ranges()).toHaveLength(3);
  });

  test("--logs-rpc: eth_getLogs and one eth_chainId read go to the logs RPC, every other read stays on --rpc", async () => {
    const main = stubRpc({ eventBlock: 900n }), logs = stubRpc({ eventBlock: 900n });
    const handle = stubHandle(main.url);
    const o = { logsRpc: logs.url, chainId: CHAIN, ...noWait() };
    const found = await realProveChain.executions(handle, 7, o);
    expect(found).toEqual([{ ...proofEvent, block: 900 }]);
    expect(await realProveChain.transaction(handle, found[0]!.txHash, o)).toMatchObject({ to: SAFE_ADDR, value: 0n, status: "success", block: 900 });
    expect(logs.methods()).toEqual(["eth_chainId", "eth_getLogs"]);
    expect(main.methods()).toEqual(["eth_blockNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt"]);
  });

  test("--logs-rpc that serves another chain is refused before any log is read (LOGS_RPC_WRONG_CHAIN)", async () => {
    const main = stubRpc({ eventBlock: 900n }), logs = stubRpc({ chainId: 8453, eventBlock: 900n });
    const err = await rejection(realProveChain.executions(stubHandle(main.url), 7, { logsRpc: logs.url, chainId: CHAIN, ...noWait() }));
    expect(err.kind).toBe("CHAIN");
    expect(err.message).toStartWith("LOGS_RPC_WRONG_CHAIN: --logs-rpc 127.0.0.1 answers chain id 8453");
    expect([...main.methods(), ...logs.methods()]).not.toContain("eth_getLogs");
  });

  test("a refused eth_getTransactionReceipt (a pruned node) is RPC_REFUSED naming that RPC and method, never 'transaction not found'", async () => {
    const rpc = stubRpc({ on: (m) => (m === "eth_getTransactionReceipt" ? { error: { code: -32000, message: "historical state not available: pruned" } } : undefined) });
    const t = noWait();
    const err = await rejection(realProveChain.transaction(stubHandle(rpc.url), LANDED_TX, { retry: t.retry }));
    expect(err.kind).toBe("SAFE");
    expect(err.details).toMatchObject({ error: "RPC_REFUSED", rpc_host: "127.0.0.1", method: "eth_getTransactionReceipt", subject: `transaction ${LANDED_TX}`, reads: LOG_READ_TRIES, code: -32000 });
    expect(err.message).toContain("pruned");
    expect(err.message).not.toMatch(/not found|does not know/);
    expect(rpc.methods().filter((m) => m === "eth_getTransactionReceipt")).toHaveLength(LOG_READ_TRIES);
  });

  test("a transaction the RPC does not know is the adoption's 'cannot be read' (null), after one read", async () => {
    const rpc = stubRpc({ on: (m) => (m === "eth_getTransactionByHash" ? { result: null } : undefined) });
    expect(await realProveChain.transaction(stubHandle(rpc.url), LANDED_TX, noWait())).toBeNull();
    expect(rpc.methods()).toEqual(["eth_getTransactionByHash"]);
  });

  test("through main() with --logs-rpc: the adoption reads the Safe's events from the logs RPC and every other read from --rpc, adopts the proof and sends nothing", async () => {
    const w = world({ writeSafeManifest: true });
    await landed(w);
    const main = stubRpc({ eventBlock: 9n, input: await execCalldata() });
    const logs = stubRpc({ eventBlock: 9n });
    expect(await w.run(["--stage", PROOF_STAGE, "--resume", "--logs-rpc", logs.url], { prove: { api: realReaderApi(w, main.url), ownerSigners: PROVE_SIGNERS } })).toBe(0);
    expect(manifest(w).stages[PROOF_STAGE]).toMatchObject({ status: "done", adopted: true, txHash: LANDED_TX, nonce: 0, block: 9 });
    expect(logs.methods()).toEqual(["eth_chainId", "eth_getLogs"]);
    expect(main.methods()).toEqual(["eth_blockNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt"]);
    expect(sends(w)).toEqual([]);
    expect(w.logs().find((l) => l.event === "stage.control_proof_adopted")?.logs_rpc_host).toBe("127.0.0.1");
  });

  test("--logs-rpc goes with a run that reaches prove-control only, and is an http(s) URL", () => {
    const base = ["--chain", "918453", "--core-sha", SHA, "--rpc", "http://x", "--sheet", "s", "--signer", "keystore:/k"];
    expect(parseCli(["publish", ...base, "--logs-rpc", "https://logs.example/key"]).logsRpc).toBe("https://logs.example/key");
    expect(parseCli([...base, "--logs-rpc", "http://l"]).logsRpc).toBe("http://l"); // the default stage set reaches prove-control
    expect(parseCli([...base, "--stage", `safe,${PROOF_STAGE}`, "--logs-rpc", "http://l"]).logsRpc).toBe("http://l");
    expect(parseCli(["publish", ...base]).logsRpc).toBeUndefined();
    for (const run of [["govern", ...base], ["verify", ...base], [...base, "--stage", "plan"], [...base, "--stage", "timelock"]]) {
      expect(() => parseCli([...run, "--logs-rpc", "http://l"])).toThrow("--logs-rpc goes with a run that reaches");
    }
    expect(() => parseCli(["publish", ...base, "--logs-rpc", "ws://l"])).toThrow("--logs-rpc must be an http(s) URL");
  });
});
