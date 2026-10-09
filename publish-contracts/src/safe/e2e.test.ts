// Runs against a REAL SafeL2 1.4.1 created through the canonical factory on the Twin chain (918453). Skipped unless configured.
// Nothing here is a stand-in: the Safe, the factory and the contracts are the real ones, the keystores are encrypted Foundry keystores.
//   SAFE_TEST_RPC            Twin chain RPC (chain id from SAFE_TEST_CHAIN_ID, default 918453). Base mainnet is refused.
//   SAFE_TEST_DEPLOYER       keystore path of a funded account (creates the Safe, pays for execution)
//   SAFE_TEST_OWNERS         three or more owner keystore paths, comma-separated (distinct from the deployer)
//   SAFE_TEST_PASSFILE       0600 file holding the passphrase shared by those keystores
// Threshold used: 2 of N. Needs the canonical Safe 1.4.1 infrastructure on the chain.
import { describe, expect, test } from "bun:test";
import { getAddress, encodeFunctionData, parseAbi, type Address } from "viem";
import { MAINNET_CHAIN_ID, TWIN_CHAIN_ID } from "../chains.ts";
import {
  SAFE_141, SAFE_ABI, SafeRevertError, createSafe, executeTx, importSignatureBundle, keystoreSigner, proposeTx, signTx,
  checkSignaturesOnChain, addSignature, type SafeHandle, type Signer, type SafeTxBundle,
} from "./index.ts";

const RPC = process.env.SAFE_TEST_RPC;
const CHAIN_ID = Number(process.env.SAFE_TEST_CHAIN_ID ?? TWIN_CHAIN_ID);
const enabled = Boolean(RPC && process.env.SAFE_TEST_DEPLOYER && process.env.SAFE_TEST_OWNERS && process.env.SAFE_TEST_PASSFILE) && CHAIN_ID !== MAINNET_CHAIN_ID;
const MODULE_ABI = parseAbi(["function enableModule(address module)", "function isModuleEnabled(address module) view returns (bool)"]);

describe.skipIf(!enabled)("real SafeL2 1.4.1 on the Twin chain", () => {
  let handle: SafeHandle, deployer: Signer, owners: Signer[];
  const chain = { rpcUrl: RPC ?? "", chainId: CHAIN_ID };

  async function freshModuleTx(n: number): Promise<{ bundle: SafeTxBundle; module: Address }> {
    const module = getAddress(`0x${(0xabc000 + n + Date.now() % 100000).toString(16).padStart(40, "0")}`);
    const bundle = await proposeTx(handle, { to: handle.address, data: encodeFunctionData({ abi: MODULE_ABI, functionName: "enableModule", args: [module] }), action: "enableModule" });
    return { bundle, module };
  }

  test("create the Safe through the canonical factory and verify it from the chain", async () => {
    const pass = { file: process.env.SAFE_TEST_PASSFILE! };
    deployer = await keystoreSigner({ path: process.env.SAFE_TEST_DEPLOYER!, passphrase: pass });
    owners = await Promise.all(process.env.SAFE_TEST_OWNERS!.split(",").map((p) => keystoreSigner({ path: p, passphrase: pass })));
    const addrs = await Promise.all(owners.map((o) => o.address()));
    const res = await createSafe({ ...chain, owners: addrs, threshold: 2, deployer, deploySha: "e2e" , saltNonce: String(Date.now()) });
    expect(res.created).toBe(true);
    handle = res.handle!;
    expect(await handle.nonce()).toBe(0);
    expect(res.manifest!.singleton).toBe(SAFE_141.singletonL2);
  }, 120_000);

  test("propose, sign by threshold owners, execute: on-chain effect and nonce increment", async () => {
    const { bundle, module } = await freshModuleTx(1);
    let b = bundle;
    for (const o of owners.slice(0, 2)) b = await signTx(handle, b, o);
    const before = await handle.nonce();
    const r = await executeTx(handle, b, deployer);
    expect(await handle.nonce()).toBe(before + 1);
    expect(r.nonceAfter).toBe(before + 1);
    expect(await handle.client.readContract({ address: handle.address, abi: MODULE_ABI, functionName: "isModuleEnabled", args: [module] })).toBe(true);
  }, 120_000);

  test("a prefixed eth_sign signature from a keystore is accepted by execTransaction", async () => {
    const { bundle, module } = await freshModuleTx(2);
    let b = bundle;
    for (const o of owners.slice(0, 2)) b = await signTx(handle, b, o, { mode: "eth_sign" });
    expect(b.signatures.every((s) => ["1f", "20"].includes(s.signature.slice(-2)))).toBe(true);
    await executeTx(handle, b, deployer);
    expect(await handle.client.readContract({ address: handle.address, abi: MODULE_ABI, functionName: "isModuleEnabled", args: [module] })).toBe(true);
  }, 120_000);

  test("a signature bundle import executes the transaction", async () => {
    const { bundle, module } = await freshModuleTx(3);
    let signed = bundle;
    for (const o of owners.slice(0, 2)) signed = await signTx(handle, signed, o);
    const exported = { safeTxHash: bundle.safe_tx_hash, signatures: signed.signatures.map((s) => ({ signer: s.owner, data: s.signature })) };
    const imported = await importSignatureBundle(handle, bundle, exported);
    await executeTx(handle, imported, deployer);
    expect(await handle.client.readContract({ address: handle.address, abi: MODULE_ABI, functionName: "isModuleEnabled", args: [module] })).toBe(true);
  }, 120_000);

  test("below-threshold fails with GS020 and a non-owner signature fails with GS026", async () => {
    const { bundle } = await freshModuleTx(4);
    const one = await signTx(handle, bundle, owners[0]!);
    const e20 = await executeTx(handle, one, deployer, { localChecks: false }).catch((e) => e);
    expect(e20).toBeInstanceOf(SafeRevertError);
    expect((e20 as SafeRevertError).gsCode).toBe("GS020");
    // the deployer is not an owner: its signature recovers to an address the Safe does not know
    const outsider = await signTx(handle, bundle, deployer, { allowNonOwner: true, skipChainChecks: true });
    const mixed = addSignature(outsider, one.signatures[0]!);
    const e26 = await checkSignaturesOnChain(handle, mixed, mixed.signatures).catch((e) => e);
    expect(e26).toBeInstanceOf(SafeRevertError);
    expect((e26 as SafeRevertError).gsCode).toBe("GS026");
  }, 120_000);

  test("the SAFE_ABI nonce read matches the handle", async () => {
    expect(Number(await handle.client.readContract({ address: handle.address, abi: SAFE_ABI, functionName: "nonce" }))).toBe(await handle.nonce());
  });
});
