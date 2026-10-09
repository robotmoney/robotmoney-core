// Fast unit tests: no chain, no keys beyond a small-cost test keystore made in the test. Each runs in milliseconds.
import { describe, expect, test } from "bun:test";
import { createCipheriv, scryptSync } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, keccak256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  PRODUCTION_ROSTER, SAFE_141, SafeRevertError, SafeToolError, TIMELOCK_ABI, ZERO_BYTES32, addSignature, defaultSaltNonce, describeCalldata, importSignatureBundle,
  isLoopbackRpc, jsonLogger, ownerHardwareSigner, keystoreSigner, ledgerSigner, localSafeTxHash, loopbackKeySigner, modeOf, packSignatures, readPassphraseFile, recoverSafeSigner,
  redact, toSafeSignature, validateRoster, verifySafeSignature, type SafeTxBundle,
} from "./index.ts";
import { proxyRuntimeCodeOf } from "./safe.ts";
import { parseFlags, callsFromFlags } from "./cli.ts";
import { assertNoPlaintextKeys } from "./guard.ts";
import { revertReasonOf } from "./errors.ts";
import { MAINNET_CHAIN_ID, TWIN_CHAIN_ID } from "../chains.ts";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const code = (f: () => unknown): string | undefined => { try { f(); } catch (e) { return e instanceof SafeToolError ? e.code : "OTHER"; } return undefined; };

// A real Web3 v3 keystore with a cheap scrypt cost, so the decrypt path is exercised in milliseconds.
function makeKeystore(pk: Hex, password: string): string {
  const salt = Buffer.alloc(32, 7), iv = Buffer.alloc(16, 9);
  const dk = scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 });
  const c = createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
  const ct = Buffer.concat([c.update(Buffer.from(pk.slice(2), "hex")), c.final()]);
  const mac = keccak256(Buffer.concat([dk.subarray(16, 32), ct]) as unknown as Uint8Array).slice(2);
  return JSON.stringify({ version: 3, crypto: { cipher: "aes-128-ctr", cipherparams: { iv: iv.toString("hex") }, ciphertext: ct.toString("hex"), kdf: "scrypt", kdfparams: { dklen: 32, n: 1024, r: 8, p: 1, salt: salt.toString("hex") }, mac } });
}

const HASH = keccak256("0x1234");

describe("roster", () => {
  const ok = [A(1), A(2), A(3)];
  test("production policy accepts 2 of 3", () => expect(validateRoster(ok, 2, PRODUCTION_ROSTER)).toHaveLength(3));
  test("threshold 1 refused", () => expect(code(() => validateRoster(ok, 1, PRODUCTION_ROSTER))).toBe("ROSTER_INVALID"));
  test("threshold N refused", () => expect(code(() => validateRoster(ok, 3, PRODUCTION_ROSTER))).toBe("ROSTER_INVALID"));
  test("fewer than 3 owners refused", () => expect(code(() => validateRoster([A(1), A(2)], 2, PRODUCTION_ROSTER))).toBe("ROSTER_INVALID"));
  test("duplicate owner refused", () => expect(code(() => validateRoster([A(1), A(1), A(2)], 2, PRODUCTION_ROSTER))).toBe("ROSTER_INVALID"));
  test("zero address refused", () => expect(code(() => validateRoster([A(0), A(2), A(3)], 2, PRODUCTION_ROSTER))).toBe("ROSTER_INVALID"));
  test("an owner equal to the deployer refused", () => expect(code(() => validateRoster(ok, 2, PRODUCTION_ROSTER, { deployer: A(2) }))).toBe("ROSTER_INVALID"));
  test("salt is deterministic", () => expect(defaultSaltNonce(validateRoster(ok, 2, PRODUCTION_ROSTER), 2, "abc")).toBe(defaultSaltNonce(validateRoster(ok, 2, PRODUCTION_ROSTER), 2, "abc")));
});

describe("signatures", () => {
  test("raw and eth_sign signatures recover to the owner", async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const raw = toSafeSignature(await acct.sign({ hash: HASH }), "raw");
    const prefixed = toSafeSignature(await acct.signMessage({ message: { raw: HASH } }), "eth_sign");
    expect(modeOf(raw)).toBe("raw");
    expect(modeOf(prefixed)).toBe("eth_sign");
    expect(await recoverSafeSigner(HASH, raw)).toBe(acct.address);
    expect(await recoverSafeSigner(HASH, prefixed)).toBe(acct.address);
    expect(await verifySafeSignature(HASH, A(5), raw)).toBe(false);
  });
  test("contract-signature v bytes are refused", () => expect(code(() => modeOf(`0x${"11".repeat(64)}00` as Hex))).toBe("SIGNATURE_INVALID"));
  test("packing sorts by owner ascending", () => {
    const hi = { owner: A(9), signature: `0x${"aa".repeat(64)}1b` as Hex }, lo = { owner: A(2), signature: `0x${"bb".repeat(64)}1c` as Hex };
    const packed = packSignatures([hi, lo]);
    expect(packed.slice(2, 4)).toBe("bb");
    expect(packed.length).toBe(2 + 130 * 2);
  });
  test("local EIP-712 hash is a stable 32 bytes", () => expect(localSafeTxHash(TWIN_CHAIN_ID, A(1), A(2), "0x", 0)).toMatch(/^0x[0-9a-f]{64}$/));
});

describe("keystore signer", () => {
  const pk = generatePrivateKey();
  const dir = mkdtempSync(join(tmpdir(), "safe-ks-"));
  test("opens with a 0600 passphrase file and signs both modes", async () => {
    const pass = join(dir, "pw"); writeFileSync(pass, "correct horse\n", { mode: 0o600 });
    const s = await keystoreSigner({ json: makeKeystore(pk, "correct horse"), passphrase: { file: pass } });
    expect(await s.address()).toBe(privateKeyToAccount(pk).address);
    expect(await verifySafeSignature(HASH, await s.address(), await s.signSafeHash(HASH, "raw"))).toBe(true);
    expect(await verifySafeSignature(HASH, await s.address(), await s.signSafeHash(HASH, "eth_sign"))).toBe(true);
  });
  test("wrong passphrase is a typed error", async () => {
    await expect(keystoreSigner({ json: makeKeystore(pk, "right"), passphrase: { value: "wrong" } })).rejects.toMatchObject({ code: "WRONG_PASSPHRASE" });
  });
  test("a group-readable passphrase file is refused", () => {
    const p = join(dir, "loose"); writeFileSync(p, "x", { mode: 0o644 }); chmodSync(p, 0o644);
    expect(code(() => readPassphraseFile(p))).toBe("PASSPHRASE_FILE_PERMISSIONS");
  });
  test("a plaintext key is refused off loopback and on mainnet", () => {
    expect(code(() => loopbackKeySigner(pk, { rpcUrl: "https://mainnet.base.org", chainId: MAINNET_CHAIN_ID }))).toBe("PLAINTEXT_KEY_REFUSED");
    expect(code(() => loopbackKeySigner(pk, { rpcUrl: "http://127.0.0.1:8545", chainId: MAINNET_CHAIN_ID }))).toBe("PLAINTEXT_KEY_REFUSED");
    expect(code(() => loopbackKeySigner(pk, { rpcUrl: "http://127.0.0.1:8545", chainId: 31337, allowChainIds: [31337] }))).toBeUndefined();
  });
  test("env guard refuses a key in the environment off loopback", () => {
    expect(code(() => assertNoPlaintextKeys("https://rpc.example", { PRIVATE_KEY: "0x1" }))).toBe("PLAINTEXT_KEY_REFUSED");
    expect(code(() => assertNoPlaintextKeys("http://localhost:8545", { PRIVATE_KEY: "0x1" }))).toBeUndefined();
  });
  test("loopback detection", () => { expect(isLoopbackRpc("http://[::1]:8545")).toBe(true); expect(isLoopbackRpc("https://127.0.0.1.evil.com")).toBe(false); });
});

describe("hardware signers sign prefixed, with no secret in the arguments", () => {
  test("ledger goes through cast and returns v 31/32", async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const calls: string[][] = [];
    const signer = ledgerSigner({ runner: async (args) => {
      calls.push(args);
      if (args[1] === "address") return { code: 0, stdout: acct.address, stderr: "" };
      return { code: 0, stdout: await acct.signMessage({ message: { raw: args[args.length - 1] as Hex } }), stderr: "" };
    } });
    const sig = await signer.signSafeHash(HASH, "eth_sign");
    expect(modeOf(sig)).toBe("eth_sign");
    expect(await verifySafeSignature(HASH, acct.address, sig)).toBe(true);
    expect(calls.flat().join(" ")).toContain("--ledger");
    await expect(signer.signSafeHash(HASH, "raw")).rejects.toMatchObject({ code: "UNSUPPORTED_SIGN_MODE" });
  });
});

describe("signature bundle import", () => {
  test("accepts the Safe app export and a hex blob, refuses non-owners and a wrong hash", async () => {
    const o1 = privateKeyToAccount(generatePrivateKey()), o2 = privateKeyToAccount(generatePrivateKey()), out = privateKeyToAccount(generatePrivateKey());
    const handle = { owners: [o1.address, o2.address, A(77)], logger: { log() {} } };
    const bundle = { safe_tx_hash: HASH, threshold: 2, signatures: [] } as unknown as SafeTxBundle;
    const s1 = toSafeSignature(await o1.signMessage({ message: { raw: HASH } }), "eth_sign");
    const s2 = toSafeSignature(await o2.sign({ hash: HASH }), "raw");
    const viaApp = await importSignatureBundle(handle, bundle, { safeTxHash: HASH, signatures: [{ signer: o1.address, data: s1 }, { signer: o2.address, data: s2 }] });
    expect(viaApp.signatures).toHaveLength(2);
    const viaBlob = await importSignatureBundle(handle, bundle, `0x${s1.slice(2)}${s2.slice(2)}`);
    expect(viaBlob.signatures.map((s) => s.owner)).toEqual(viaApp.signatures.map((s) => s.owner));
    const bad = toSafeSignature(await out.sign({ hash: HASH }), "raw");
    await expect(importSignatureBundle(handle, bundle, [{ signer: out.address, data: bad }])).rejects.toMatchObject({ code: "NOT_OWNER" });
    await expect(importSignatureBundle(handle, bundle, { safeTxHash: keccak256("0x99"), signatures: [] })).rejects.toMatchObject({ code: "HASH_MISMATCH" });
    await expect(importSignatureBundle(handle, bundle, [{ signer: o2.address, data: s1 }])).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
  });
  test("a second signature from the same owner replaces the first", () => {
    const b = { signatures: [] } as unknown as SafeTxBundle;
    const s = (n: string) => ({ owner: A(4), signature: `0x${n.repeat(64)}1b` as Hex });
    expect(addSignature(addSignature(b, s("aa")), s("bb")).signatures).toHaveLength(1);
  });
});

describe("typed errors and logging", () => {
  test("GS020 and GS026 reasons become typed Safe reverts", () => {
    const e20 = new SafeRevertError(revertReasonOf({ reason: "GS020" })), e26 = new SafeRevertError(revertReasonOf(new Error("execution reverted: GS026")));
    expect(e20.gsCode).toBe("GS020");
    expect(e26.gsCode).toBe("GS026");
    expect(e26.code).toBe("SAFE_REVERT");
  });
  test("secrets are redacted by key and every line parses as JSON", () => {
    const lines: string[] = [];
    jsonLogger((l) => lines.push(l)).log("info", "x", { passphrase: "hunter2", privateKey: "0xdead", nested: { password: "p", keystore: "{}" }, safe: A(1), keystore_path: "/k" });
    const joined = lines.join("\n");
    expect(joined).not.toContain("hunter2"); expect(joined).not.toContain("0xdead"); expect(joined).toContain("keystore_path");
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
    expect(redact({ a: 1n })).toEqual({ a: "1" });
  });
});

describe("timelock calldata description and CLI flags", () => {
  test("updateDelay outside 1h..30d warns", () => {
    const inner = encodeFunctionData({ abi: TIMELOCK_ABI, functionName: "updateDelay", args: [5n] });
    const data = encodeFunctionData({ abi: TIMELOCK_ABI, functionName: "schedule", args: [A(1), 0n, inner, ZERO_BYTES32, ZERO_BYTES32, 0n] });
    expect(describeCalldata(data).join("\n")).toContain("WARNING");
  });
  test("flags parse and batch calls line up", () => {
    const f = parseFlags(["--action", "scheduleBatch", "--targets", `${A(1)},${A(2)}`, "--datas", "0x12,0x34", "--yes"]);
    expect(callsFromFlags(f)).toHaveLength(2);
    expect(code(() => parseFlags(["--private-key"]))).toBe("BAD_INPUT");
  });
  test("pinned canonical addresses are the Safe 1.4.1 L2 deployments", () => {
    expect(SAFE_141.singletonL2).toBe("0x29fcB43b46531BcA003ddC8FCB67FFE91900C762");
    expect(SAFE_141.proxyFactory).toBe("0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67");
  });
});

describe("proxyRuntimeCodeOf (the 1.4.1 factory has no proxyRuntimeCode())", () => {
  test("reads proxyCreationCode, appends the singleton argument and runs it as a creation call", async () => {
    const calls: { fn?: string; data?: string } = {};
    const client = {
      readContract: async (a: { functionName: string }) => { calls.fn = a.functionName; return "0xaabb" as Hex; },
      call: async (a: { data: Hex }) => { calls.data = a.data; return { data: "0x6000" as Hex }; },
    };
    const out = await proxyRuntimeCodeOf(client as never, SAFE_141.proxyFactory, SAFE_141.singletonL2);
    expect(calls.fn).toBe("proxyCreationCode");
    expect(calls.data).toBe(`0xaabb${"0".repeat(24)}${SAFE_141.singletonL2.slice(2).toLowerCase()}`);
    expect(out).toBe("0x6000");
  });
  test("empty runtime code is INFRA_MISSING", async () => {
    const client = { readContract: async () => "0xaabb" as Hex, call: async () => ({ data: undefined }) };
    await expect(proxyRuntimeCodeOf(client as never, SAFE_141.proxyFactory, SAFE_141.singletonL2)).rejects.toMatchObject({ code: "INFRA_MISSING" });
  });
});

describe("hardware owner signers: one device per owner, each checked against its named owner", () => {
  const accts = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
  const paths = ["m/44'/60'/0'/0/0", "m/44'/60'/1'/0/0"];
  /** A simulated cast: the device attached at each derivation path reports and signs as the account listed for it. */
  const fakeCast = (attached: () => (typeof accts)[number][]) => {
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      const i = paths.indexOf(args[args.indexOf("--mnemonic-derivation-path") + 1]!);
      const a = attached()[i]!;
      if (args[1] === "address") return { code: 0, stdout: a.address, stderr: "" };
      return { code: 0, stdout: await a.signMessage({ message: { raw: args[args.length - 1] as Hex } }), stderr: "" };
    };
    return { calls, runner };
  };
  const prompts: unknown[] = [];

  test("two specs with different derivation paths resolve to two owners, each cast call with its own path", async () => {
    const { calls, runner } = fakeCast(() => accts);
    const s = accts.map((a, i) => ownerHardwareSigner(`ledger:${paths[i]}@${a.address}`, { runner, prompt: async (r) => { prompts.push(r); } }));
    expect(await s[0]!.address()).toBe(accts[0]!.address);
    expect(await s[1]!.address()).toBe(accts[1]!.address);
    expect(calls.map((c) => c[c.indexOf("--mnemonic-derivation-path") + 1])).toEqual(paths);
    expect(calls.every((c) => c.includes("--ledger"))).toBe(true);
    expect(prompts).toHaveLength(2);
  });

  test("a device that reports another address than the named owner is refused with HARDWARE_ADDRESS_MISMATCH", async () => {
    const { runner } = fakeCast(() => [accts[1]!, accts[1]!]);
    const s = ownerHardwareSigner(`trezor:${paths[0]}@${accts[0]!.address}`, { runner, prompt: async () => {} });
    await expect(s.address()).rejects.toMatchObject({ code: "HARDWARE_ADDRESS_MISMATCH" });
  });

  test("a wrong owner attached between resolve and sign is refused before the device signs", async () => {
    let swapped = false;
    const { calls, runner } = fakeCast(() => (swapped ? [accts[1]!, accts[1]!] : accts));
    const s = ownerHardwareSigner(`ledger:${paths[0]}@${accts[0]!.address}`, { runner, prompt: async () => {} });
    await s.address();
    swapped = true;
    await expect(s.signSafeHash(HASH, "eth_sign")).rejects.toMatchObject({ code: "HARDWARE_ADDRESS_MISMATCH" });
    expect(calls.some((c) => c[1] === "sign")).toBe(false);
  });

  test("a malformed hardware owner spec is refused", () => {
    for (const bad of ["ledger", "ledger:m/44'/60'/0'/0/0", "ledger:@0x1", `ledger:44/60@${A(1)}`, `ledger:m/44'/60'/0'/0/0@0x12`, `keystore:x@${A(1)}`]) {
      expect(() => ownerHardwareSigner(bad, { prompt: async () => {} })).toThrow(SafeToolError);
    }
  });
});
