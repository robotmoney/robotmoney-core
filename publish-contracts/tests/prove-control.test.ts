// The Safe control proof (core 1618, plan decision 21): before stage 11 the real Safe executes one self-call signed by EVERY owner.
// What is real here: the owner keys sign, the hashes are the Safe tool's own, every signature is recovered, and the verifier decodes the proof
// calldata and recovers the signers. What is a fake: the chain (the runner tests stub forge and cast). The proof against a real Safe contract
// on a real fork is the Twin rehearsal (suite 28, and the suite 14 twin_publish test).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, encodeFunctionData, http, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { assertControlProven, inspectProofTx, PROOF_STAGE } from "../src/control-proof.ts";
import { EXIT_CODES } from "../src/errors.ts";
import { assertEveryOwnerSigned, LOG_BACKOFF_MAX_MS, LOG_BACKOFF_MS, LOG_TRIES, LOG_WINDOW, proveChain, realProveChain } from "../src/prove-control.ts";
import { parseCli } from "../src/cli.ts";
import { logsRpc, type LogsRpcOpts } from "./logs-rpc.ts";
import { localSafeTxHash, ownerHardwareSigner, signTx, type SafeTxBundle } from "../src/safe/index.ts";
import { privateKeyToAccount } from "viem/accounts";
import { ADMIN, PROVE_OWNERS, PROVE_SIGNERS, fakeProveApi, keySigner, typedPrompt, world } from "./harness.ts";
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
  test("the healthy world passes all three proof labels with real signatures", async () => {
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

// ---- a stale load-balanced RPC right after the proof landed (issue 1723) -----------------------------------------------------------------
// The Safe handle answers the nonce as a node behind the proof's block would: 0 for the first `k` reads, then the chain's nonce.
// The clock is injected: `sleep` only counts.
describe("prove-control on a stale RPC: a stale nonce 0 after the proof landed never re-runs the proof", () => {
  const staleApi = (w: ReturnType<typeof world>, k: number, api = fakeProveApi(w)) => {
    const served = { stale: 0 };
    return { served, api: { ...api, connectSafe: async (o: Parameters<typeof api.connectSafe>[0]) => {
      const h = await api.connectSafe(o);
      return { ...h, nonce: async () => (served.stale < k ? (served.stale++, 0) : h.nonce()) };
    } } };
  };
  const sleeps = () => { const c = { n: 0, sleep: async () => { c.n++; } }; return c; };

  test("on entry (--resume): the proof landed, the RPC answers nonce 0 three times, then 1: adopted, nothing proposed, signed or sent", async () => {
    const w = world({ writeSafeManifest: true });
    await landed(w);
    const { api, served } = staleApi(w, 3);
    const c = sleeps();
    expect(await w.run(["--stage", PROOF_STAGE, "--resume"], { prove: { api, ownerSigners: PROVE_SIGNERS, staleRead: { sleep: c.sleep } } })).toBe(0);
    expect(served.stale).toBe(3);
    expect(c.n).toBe(2); // the entry read, then two stale re-reads, then 1
    expect(sends(w)).toEqual([]);
    expect(manifest(w).stages[PROOF_STAGE]).toMatchObject({ status: "done", adopted: true, txHash: LANDED_TX, nonce: 0 });
    expect(w.logs().filter((l) => l.event === "safe.stale_read")).toHaveLength(2);
  });

  test("after the proof: the run dies right after its proof landed, --resume meets a stale nonce 0: the nonce converges to 1, the proof is adopted and sent once", async () => {
    const w = world({ writeSafeManifest: true });
    const api = fakeProveApi(w);
    const crashing = { ...api, executeTx: async (...a: Parameters<typeof api.executeTx>) => {
      await api.executeTx(...a);
      await landed(w);
      throw new Error("the process died before the run manifest was written");
    } };
    expect(await w.run(["--stage", PROOF_STAGE], { prove: { api: crashing, ownerSigners: PROVE_SIGNERS } })).not.toBe(0);
    expect(executed(w)).toHaveLength(1);
    const { api: stale, served } = staleApi(w, 4);
    expect(await w.run(["--stage", PROOF_STAGE, "--resume"], { prove: { api: stale, ownerSigners: PROVE_SIGNERS, staleRead: { sleep: sleeps().sleep } } })).toBe(0);
    expect(served.stale).toBe(4);
    expect(executed(w)).toHaveLength(1); // not taken a second time
    expect(manifest(w).stages[PROOF_STAGE]).toMatchObject({ status: "done", adopted: true });
  });

  test("a nonce that never leaves 0 while an execution exists fails with STALE_READ_TIMEOUT naming the expected value, the last value and the RPC host: nothing is sent", async () => {
    const w = world({ writeSafeManifest: true });
    await landed(w);
    const { api } = staleApi(w, Infinity);
    const c = sleeps();
    expect(await w.run(["--stage", PROOF_STAGE, "--resume"], { prove: { api, ownerSigners: PROVE_SIGNERS, staleRead: { tries: 4, sleep: c.sleep } } })).not.toBe(0);
    expect(lastError(w).message).toContain("expected 1 or more, last read 0, after 4 read(s)");
    expect(lastError(w).message).toContain("rpc.test");
    expect(c.n).toBe(3);
    expect(sends(w)).toEqual([]);
    expect(existsSync(manifestPath(w)) ? manifest(w).stages[PROOF_STAGE] : undefined).toBeUndefined();
  });

  test("a consistent nonce 2 on --resume is not retried: the adoption refuses it as before", async () => {
    const w = world({ writeSafeManifest: true });
    await landed(w, { nonce: 2 });
    const c = sleeps();
    expect(await w.run(["--stage", PROOF_STAGE, "--resume"], { prove: { api: fakeProveApi(w), ownerSigners: PROVE_SIGNERS, staleRead: { sleep: c.sleep } } })).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(lastError(w).message).toContain("the Safe nonce is 2");
    expect(c.n).toBe(0);
    expect(sends(w)).toEqual([]);
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
  /** The same devices through main(): the CLI's own device prompt (recorded like `rig`'s) and cast runner (QA plan v1 A5, the 1693 hunk). */
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


// ---- the real chain reader on public RPCs (issue 1724) ----------------------------------------------------------------------------------
// The chain is a fake JSON-RPC on loopback (tests/logs-rpc.ts) that throttles, caps the eth_getLogs range or refuses like a pruned node.
// The reader is the real one (proveChain over viem). The backoff clock is injected: `sleep` only records.
const SELF_HASH = localSafeTxHash(CHAIN, SAFE_ADDR, SAFE_ADDR, "0x", 0);
const rpcHandle = (url: string): any => ({ address: SAFE_ADDR, chain: { rpcUrl: url, chainId: CHAIN }, client: createPublicClient({ transport: http(url) }), logger: { log() {} } });
/** The fake Safe tool of the runner tests, with a handle whose client reads `url` (the --rpc of the run). */
const rpcApi = (w: ReturnType<typeof world>, url: string) => {
  const api = fakeProveApi(w);
  return { ...api, connectSafe: async (o: Parameters<typeof api.connectSafe>[0]) => ({ ...(await api.connectSafe(o)), chain: { rpcUrl: url, chainId: CHAIN }, client: createPublicClient({ transport: http(url) }) }) };
};
/** A Safe at nonce 1 whose valid proof landed at block 9 (stage block 7), served by fake RPCs. */
async function landedOnRpc(o: Partial<LogsRpcOpts> = {}, logs?: Partial<LogsRpcOpts>) {
  const tx = { from: ADMIN as Address, to: SAFE_ADDR, input: await execCalldata(), value: 0n, status: "success" as const, block: 9 };
  const main = logsRpc({ safe: SAFE_ADDR, latest: 5000, executions: [{ block: 9, txHash: LANDED_TX, safeTxHash: SELF_HASH }], txs: { [LANDED_TX]: tx }, ...o });
  const side = logs ? logsRpc({ safe: SAFE_ADDR, latest: 5000, executions: [{ block: 9, txHash: LANDED_TX, safeTxHash: SELF_HASH }], ...logs }) : undefined;
  const w = world({ writeSafeManifest: true });
  w.safeNonce = 1;
  const waits: number[] = [];
  const run = (extra: string[] = []) => w.run(["--stage", PROOF_STAGE, "--resume", ...extra], { prove: { api: rpcApi(w, main.url), logs: { sleep: async (ms: number) => { waits.push(ms); } } } });
  return { w, main, side, waits, run, stop: () => { main.stop(); side?.stop(); } };
}

describe("the adoption scan is bounded, retried and diagnosable on public RPCs (issue 1724)", () => {
  test("HTTP 429 for the first 3 eth_getLogs calls, then the logs: adopted after an exponential backoff, 4 calls in all, nothing sent", async () => {
    const t = await landedOnRpc({ throttle: 3 });
    try {
      expect(await t.run()).toBe(0);
      expect(t.main.ranges).toEqual([[7, 2006], [7, 2006], [7, 2006], [7, 2006]]);
      expect(t.waits).toEqual([LOG_BACKOFF_MS, 2 * LOG_BACKOFF_MS, 4 * LOG_BACKOFF_MS]);
      expect(sends(t.w)).toEqual([]);
      expect(manifest(t.w).stages[PROOF_STAGE]).toMatchObject({ status: "done", adopted: true, txHash: LANDED_TX, block: 9 });
    } finally { t.stop(); }
  });

  test("a Retry-After header sets the wait, capped", async () => {
    const t = await landedOnRpc({ throttle: 2, retryAfter: "120" });
    try {
      expect(await t.run()).toBe(0);
      expect(t.waits).toEqual([LOG_BACKOFF_MAX_MS, LOG_BACKOFF_MAX_MS]);
    } finally { t.stop(); }
  });

  test("an RPC that always answers 429 fails with RPC_REFUSED naming the host, eth_getLogs and the block range, after exactly --logs-tries calls", async () => {
    const t = await landedOnRpc({ throttle: Infinity });
    try {
      expect(await t.run(["--logs-tries", "3"])).toBe(EXIT_CODES.RPC_REFUSED);
      expect(t.main.ranges).toHaveLength(3);
      expect(t.waits).toHaveLength(2);
      const err = lastError(t.w);
      expect(err.message).toContain("RPC 127.0.0.1 refused eth_getLogs for blocks 7 to 2006");
      expect(err.message).toContain("HTTP 429");
      expect(JSON.stringify(err)).not.toContain("secret-key"); // the RPC path may carry an API key: the host only
      expect(sends(t.w)).toEqual([]);
      expect(existsSync(manifestPath(t.w)) ? manifest(t.w).stages[PROOF_STAGE] : undefined).toBeUndefined();
    } finally { t.stop(); }
  });

  test("the default bound is LOG_TRIES calls of one window", async () => {
    const t = await landedOnRpc({ throttle: Infinity });
    try {
      expect(await t.run()).toBe(EXIT_CODES.RPC_REFUSED);
      expect(t.main.ranges).toHaveLength(LOG_TRIES);
      expect(t.waits).toEqual([1, 2, 4, 8, 16].map((x) => Math.min(x * LOG_BACKOFF_MS, LOG_BACKOFF_MAX_MS)));
    } finally { t.stop(); }
  });

  test("a range-limit error shrinks the window and the scan still finds the single execution event", async () => {
    const rpc = logsRpc({ safe: SAFE_ADDR, latest: 5000, maxRange: 500, executions: [{ block: 1500, txHash: LANDED_TX, safeTxHash: SELF_HASH }] });
    try {
      const out = await proveChain({ sleep: async () => {} }).executions(rpcHandle(rpc.url), 7);
      expect(out).toEqual([{ txHash: LANDED_TX, safeTxHash: SELF_HASH, success: true, block: 1500, logIndex: 0 }]);
      expect(rpc.ranges).toEqual([[7, 2006], [7, 1006], [7, 506], [507, 1006], [1007, 1506]]);
    } finally { rpc.stop(); }
  });

  test("a range limit even at one block is RPC_REFUSED, not an empty scan", async () => {
    const rpc = logsRpc({ safe: SAFE_ADDR, latest: 5000, maxRange: 0 });
    try {
      await expect(proveChain({ window: 4n }).executions(rpcHandle(rpc.url), 7)).rejects.toMatchObject({ kind: "RPC_REFUSED" });
      expect(rpc.ranges).toEqual([[7, 10], [7, 8], [7, 7]]);
    } finally { rpc.stop(); }
  });

  test("a pruned node that refuses eth_getTransactionReceipt fails with RPC_REFUSED naming the RPC and the method, not 'cannot be read'", async () => {
    const t = await landedOnRpc({ refuse: ["eth_getTransactionReceipt"] });
    try {
      expect(await t.run()).toBe(EXIT_CODES.RPC_REFUSED);
      const err = lastError(t.w);
      expect(err.message).toContain("RPC 127.0.0.1 refused eth_getTransactionReceipt for transaction " + LANDED_TX);
      expect(err.message).toContain("code -32000");
      expect(err.message).not.toContain("cannot be read");
      expect(sends(t.w)).toEqual([]);
    } finally { t.stop(); }
  });

  test("a refused eth_getTransactionByHash is RPC_REFUSED too; a transaction that does not exist is still null ('cannot be read')", async () => {
    const rpc = logsRpc({ safe: SAFE_ADDR, latest: 5000, refuse: ["eth_getTransactionByHash"] });
    const empty = logsRpc({ safe: SAFE_ADDR, latest: 5000 });
    try {
      await expect(proveChain().transaction(rpcHandle(rpc.url), LANDED_TX)).rejects.toThrow(/refused eth_getTransactionByHash/);
      expect(await proveChain().transaction(rpcHandle(empty.url), LANDED_TX)).toBeNull();
    } finally { rpc.stop(); empty.stop(); }
  });

  test("with --logs-rpc, eth_getLogs goes to the logs RPC and every other call stays on --rpc", async () => {
    const t = await landedOnRpc({ executions: [], refuse: ["eth_getLogs"] }, {});
    try {
      expect(await t.run(["--logs-rpc", t.side!.url])).toBe(0);
      expect(t.side!.calls).toEqual(["eth_getLogs"]);
      expect(t.main.calls).not.toContain("eth_getLogs");
      expect(t.main.calls).toEqual(expect.arrayContaining(["eth_blockNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt"]));
      expect(manifest(t.w).stages[PROOF_STAGE]).toMatchObject({ status: "done", adopted: true, txHash: LANDED_TX });
    } finally { t.stop(); }
  });

  test("a proof near the Safe stage block costs one eth_getLogs call, even three million blocks behind the latest block", async () => {
    const t = await landedOnRpc({ latest: 3_000_000 });
    try {
      expect(await t.run()).toBe(0);
      expect(t.main.ranges).toEqual([[7, 2006]]);
    } finally { t.stop(); }
  });

  test("--logs-window sets the window", async () => {
    const t = await landedOnRpc();
    try {
      expect(await t.run(["--logs-window", "5"])).toBe(0);
      expect(t.main.ranges).toEqual([[7, 11]]);
    } finally { t.stop(); }
  });

  test("bad --logs-rpc, --logs-window or --logs-tries is a usage error", () => {
    const base = ["--chain", "918453", "--rpc", "http://rpc.test", "--sheet", "s", "--signer", "keystore:/k", "--core-sha", "a".repeat(40)];
    expect(parseCli(base).logs).toBeUndefined();
    expect(parseCli([...base, "--logs-rpc", "http://logs.test"]).logs).toMatchObject({ logsRpc: "http://logs.test" });
    for (const bad of [["--logs-rpc", "logs.test"], ["--logs-window", "0"], ["--logs-tries", "x"], ["--logs-window", "-5"]]) {
      expect(() => parseCli([...base, ...bad])).toThrow(expect.objectContaining({ kind: "USAGE" }));
    }
  });
});

describe("the real chain reader walks the log range in windows and reads only", () => {
  test("windows of LOG_WINDOW from the stage block, ExecutionSuccess and ExecutionFailure of the Safe address only, oldest first, stopping at the first window that holds an event", async () => {
    const rpc = logsRpc({ safe: SAFE_ADDR, latest: 9000, executions: [
      { block: 2100, txHash: LANDED_TX, safeTxHash: `0x${"11".repeat(32)}`, logIndex: 3, success: false },
      { block: 2050, txHash: LANDED_TX, safeTxHash: `0x${"22".repeat(32)}`, logIndex: 1 },
      { block: 4500, txHash: LANDED_TX, safeTxHash: `0x${"33".repeat(32)}` },
    ] });
    try {
      const out = await realProveChain.executions(rpcHandle(rpc.url), 0);
      expect(LOG_WINDOW).toBe(2000n);
      expect(rpc.ranges).toEqual([[0, 1999], [2000, 3999]]);
      expect(out).toEqual([
        { txHash: LANDED_TX, safeTxHash: `0x${"22".repeat(32)}`, success: true, block: 2050, logIndex: 1 },
        { txHash: LANDED_TX, safeTxHash: `0x${"11".repeat(32)}`, success: false, block: 2100, logIndex: 3 },
      ]);
      expect(rpc.calls.every((m) => m === "eth_blockNumber" || m === "eth_getLogs")).toBe(true);
    } finally { rpc.stop(); }
  });
  test("with no event the scan walks to the latest block and returns nothing", async () => {
    const rpc = logsRpc({ safe: SAFE_ADDR, latest: 5000 });
    try {
      expect(await realProveChain.executions(rpcHandle(rpc.url), 0)).toEqual([]);
      expect(rpc.ranges).toEqual([[0, 1999], [2000, 3999], [4000, 5000]]);
    } finally { rpc.stop(); }
  });
  test("a log read that fails is refused (RPC_REFUSED), not treated as an empty range, and not retried", async () => {
    const rpc = logsRpc({ safe: SAFE_ADDR, latest: 10, refuse: ["eth_getLogs"] });
    try {
      await expect(realProveChain.executions(rpcHandle(rpc.url), 0)).rejects.toThrow(/RPC 127\.0\.0\.1 refused eth_getLogs for blocks 0 to 10/);
      expect(rpc.calls.filter((m) => m === "eth_getLogs")).toHaveLength(1);
    } finally { rpc.stop(); }
  });
});
