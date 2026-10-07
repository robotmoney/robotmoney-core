/**
 * Unit tests — safeProposal (core 1544).
 *
 * The golden fixture (tests/fixtures/safe-tx/typed-data.golden.json) was computed
 * with foundry `cast`, independent of viem and of the module under test. The
 * first block rebuilds it from its documented `inputs` and asserts byte equality
 * of the typed-data JSON, both type hashes, the domain separator, the struct hash
 * and the digest. The second block asserts the builder refuses every field the
 * dapp never signs, and produces no typed data when it does.
 */
import { describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import golden from "../fixtures/safe-tx/typed-data.golden.json";
import {
  BUNDLE_FORMAT,
  DOMAIN_SEPARATOR_TYPEHASH,
  SAFE_TX_TYPEHASH,
  SafeProposalError,
  ZERO_ADDRESS,
  addSignature,
  buildSafeTx,
  encodeExecute,
  encodeSchedule,
  execTransactionArgs,
  exportBundle,
  importSignatures,
  newBundle,
  packSignatures,
  parseBundle,
  proposalSalt,
  recoverSigner,
  timelockOperationId,
  toSafeSignature,
  verifyBundleFields,
  type SafeTxBundle,
} from "../../src/lib/safeProposal";
import { gatewayAbi } from "../../src/lib/abi";

const { inputs } = golden;
const SAFE = inputs.safe as Address;
const TIMELOCK = inputs.timelock as Address;
const TARGET = inputs.target as Address;
const ACCOUNT = inputs.account as Address;

function fixtureInner(): Hex {
  return encodeFunctionData({
    abi: gatewayAbi,
    functionName: "grantRole",
    args: [keccak256(toBytes(inputs.roleName)), ACCOUNT],
  });
}

function fixtureOperation() {
  const data = fixtureInner();
  const salt = proposalSalt({
    chainId: inputs.chainId,
    safe: SAFE,
    nonce: BigInt(inputs.safeNonce),
    target: TARGET,
    data,
  });
  return { target: TARGET, data, predecessor: inputs.predecessor as Hex, salt };
}

function fixtureBuild() {
  const op = fixtureOperation();
  return buildSafeTx({
    chainId: inputs.chainId,
    safe: SAFE,
    timelock: TIMELOCK,
    to: TIMELOCK,
    data: encodeSchedule(op, BigInt(inputs.delaySeconds)),
    nonce: BigInt(inputs.safeNonce),
  });
}

describe("safeProposal — core 1544 golden fixture", () => {
  it("rebuilds every derived value from the documented fields", () => {
    const op = fixtureOperation();
    expect(op.data).toBe(golden.derived.innerData);
    expect(keccak256(toBytes(inputs.roleName))).toBe(golden.derived.role);
    expect(op.salt).toBe(golden.derived.salt);
    expect(encodeSchedule(op, BigInt(inputs.delaySeconds))).toBe(golden.derived.scheduleData);
    expect(timelockOperationId(op)).toBe(golden.derived.operationId);
  });

  it("asserts the typed-data JSON, both type hashes, the domain separator and the digest are byte-equal", () => {
    const built = fixtureBuild();
    expect(built.typedDataJson).toBe(JSON.stringify(golden.typedData));
    expect(built.typedData).toEqual(golden.typedData);
    expect(DOMAIN_SEPARATOR_TYPEHASH).toBe(golden.typeHashes.EIP712Domain);
    expect(SAFE_TX_TYPEHASH).toBe(golden.typeHashes.SafeTx);
    expect(built.domainSeparator).toBe(golden.domainSeparator);
    expect(built.structHash).toBe(golden.structHash);
    expect(built.safeTxHash).toBe(golden.safeTxHash);
    expect(built.timelockFunction).toBe("schedule");
  });

  it("builds the execute payload the timelock expects", () => {
    const op = fixtureOperation();
    const built = buildSafeTx({
      chainId: inputs.chainId,
      safe: SAFE,
      timelock: TIMELOCK,
      to: TIMELOCK,
      data: encodeExecute(op),
      nonce: BigInt(inputs.safeNonce) + 1n,
    });
    expect(built.timelockFunction).toBe("execute");
    expect(built.typedData.message.nonce).toBe(String(inputs.safeNonce + 1));
    expect(built.safeTxHash).not.toBe(golden.safeTxHash);
  });
});

describe("safeProposal — builder refusals produce no typed data", () => {
  const base = () => {
    const op = fixtureOperation();
    return {
      chainId: inputs.chainId,
      safe: SAFE,
      timelock: TIMELOCK,
      to: TIMELOCK,
      data: encodeSchedule(op, BigInt(inputs.delaySeconds)),
      nonce: BigInt(inputs.safeNonce),
    };
  };

  const cases: Array<[string, Record<string, unknown>]> = [
    ["operation 1 (delegatecall)", { operation: 1 }],
    ["a non-zero value", { value: 1n }],
    ["a non-zero safeTxGas", { safeTxGas: 1n }],
    ["a non-zero baseGas", { baseGas: 1n }],
    ["a non-zero gasPrice", { gasPrice: 1n }],
    ["a gasToken", { gasToken: "0x3333333333333333333333333333333333333333" }],
    ["a refundReceiver", { refundReceiver: "0x4444444444444444444444444444444444444444" }],
    ["a `to` other than the configured timelock", { to: TARGET }],
  ];

  it.each(cases)("throws for %s", (_name, override) => {
    let built: unknown;
    let err: unknown;
    try {
      built = buildSafeTx({ ...base(), ...override });
    } catch (e) {
      err = e;
    }
    expect(built).toBeUndefined();
    expect(err).toBeInstanceOf(SafeProposalError);
  });

  it("accepts an explicit zero for every refused field", () => {
    const built = buildSafeTx({
      ...base(),
      operation: 0,
      value: 0n,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO_ADDRESS,
      refundReceiver: ZERO_ADDRESS,
    });
    expect(built.safeTxHash).toBe(golden.safeTxHash);
  });

  it("refuses calldata that is not a timelock schedule or execute", () => {
    expect(() =>
      buildSafeTx({
        ...base(),
        data: encodeFunctionData({
          abi: gatewayAbi,
          functionName: "grantRole",
          args: [keccak256(toBytes("ADMIN_ROLE")), ACCOUNT],
        }),
      }),
    ).toThrow(SafeProposalError);
    expect(() => buildSafeTx({ ...base(), data: "0x" })).toThrow(SafeProposalError);
  });
});

describe("safeProposal — signatures and the robotmoney-safe-tx/1 bundle", () => {
  // Hardhat's first three well-known throwaway keys. Test-only, never used on a live chain.
  const keys: Hex[] = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  ];
  const accounts = keys.map((k) => privateKeyToAccount(k));

  async function signed(i: number, build = fixtureBuild()) {
    const acct = accounts[i];
    if (!acct) throw new Error("no account");
    const sig = await acct.signTypedData({
      domain: build.typedData.domain,
      types: { SafeTx: build.typedData.types.SafeTx },
      primaryType: "SafeTx",
      message: {
        to: build.typedData.message.to,
        value: 0n,
        data: build.typedData.message.data,
        operation: 0,
        safeTxGas: 0n,
        baseGas: 0n,
        gasPrice: 0n,
        gasToken: ZERO_ADDRESS,
        refundReceiver: ZERO_ADDRESS,
        nonce: BigInt(build.typedData.message.nonce),
      },
    });
    return { owner: acct.address, signature: sig };
  }

  function bundleFor(build = fixtureBuild()): SafeTxBundle {
    return newBundle({
      chainId: inputs.chainId,
      safe: SAFE,
      timelock: TIMELOCK,
      to: TIMELOCK,
      data: build.typedData.message.data,
      nonce: BigInt(inputs.safeNonce),
      safeTxHash: build.safeTxHash,
      action: "schedule",
      description: "grant DEPOSIT_PAUSER_ROLE",
      operationId: golden.derived.operationId as Hex,
      minDelay: BigInt(inputs.delaySeconds),
      threshold: 2,
      owners: accounts.map((a) => a.address),
      proposedAt: "2026-10-07T00:00:00.000Z",
    });
  }

  it("a typed-data signature recovers to its owner over the local digest", async () => {
    const s = await signed(0);
    expect(await recoverSigner(fixtureBuild().safeTxHash, s.signature)).toBe(s.owner);
  });

  it("normalises v 0 and 1 to 27 and 28, and refuses other recovery bytes", async () => {
    const s = await signed(0);
    const v = parseInt(s.signature.slice(130), 16);
    const low = `${s.signature.slice(0, 130)}${(v - 27).toString(16).padStart(2, "0")}`;
    expect(toSafeSignature(low)).toBe(s.signature);
    expect(() => toSafeSignature(`${s.signature.slice(0, 130)}1f`)).toThrow(SafeProposalError);
    expect(() => toSafeSignature("0x1234")).toThrow(SafeProposalError);
  });

  it("packs signatures ascending by owner address regardless of insertion order", async () => {
    const all = await Promise.all([signed(0), signed(1), signed(2)]);
    const shuffled = [all[2], all[0], all[1]].filter((x): x is (typeof all)[number] => !!x);
    const packed = packSignatures(shuffled);
    expect(packed.length).toBe(2 + 3 * 130);
    const ascending = [...all].sort((a, b) =>
      a.owner.toLowerCase() < b.owner.toLowerCase() ? -1 : 1,
    );
    expect(packed).toBe(`0x${ascending.map((s) => s.signature.slice(2)).join("")}`);
  });

  it("refuses the same owner twice", async () => {
    const a = await signed(0);
    expect(() => packSignatures([a, a])).toThrow(SafeProposalError);
    expect(addSignature([a], a)).toHaveLength(1);
  });

  it("exports a bundle that round-trips and whose digest verifies from its own fields", () => {
    const bundle = bundleFor();
    const parsed = parseBundle(exportBundle(bundle));
    expect(parsed).toEqual(bundle);
    expect(parsed.format).toBe(BUNDLE_FORMAT);
    expect(verifyBundleFields(parsed).safeTxHash).toBe(golden.safeTxHash);
  });

  it("refuses a bundle whose hash or fields were tampered with", () => {
    const bundle = bundleFor();
    expect(() => verifyBundleFields({ ...bundle, safe_tx_hash: `0x${"11".repeat(32)}` })).toThrow(
      SafeProposalError,
    );
    expect(() => verifyBundleFields({ ...bundle, nonce: bundle.nonce + 1 })).toThrow(
      SafeProposalError,
    );
    const delegate = JSON.parse(exportBundle(bundle)) as Record<string, unknown>;
    delegate.operation = 1;
    expect(() => parseBundle(JSON.stringify(delegate))).toThrow(SafeProposalError);
    const gas = JSON.parse(exportBundle(bundle)) as Record<string, unknown>;
    gas.safe_tx_gas = "5";
    expect(() => parseBundle(JSON.stringify(gas))).toThrow(SafeProposalError);
  });

  it("imports a second owner's bundle, and reaches the threshold", async () => {
    const mine = { ...bundleFor(), signatures: [await signed(0)] };
    const theirs = { ...bundleFor(), signatures: [await signed(1)] };
    const merged = await importSignatures(mine, exportBundle(theirs));
    expect(merged.signatures).toHaveLength(2);
    expect(() => execTransactionArgs(mine)).toThrow(SafeProposalError);
    const args = execTransactionArgs(merged);
    expect(args[0]).toBe(TIMELOCK);
    expect(args[3]).toBe(0);
    expect(args[9]).toBe(packSignatures(merged.signatures));
  });

  it("refuses imported signatures for another hash, from a non-owner, or with a lying owner claim", async () => {
    const mine = bundleFor();
    const other = fixtureBuild();
    const wrongHash = { ...bundleFor(), safe_tx_hash: `0x${"22".repeat(32)}` as Hex };
    await expect(importSignatures(mine, exportBundle(wrongHash))).rejects.toBeInstanceOf(
      SafeProposalError,
    );

    const outsider = privateKeyToAccount(
      "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    );
    const sig = await outsider.signTypedData({
      domain: other.typedData.domain,
      types: { SafeTx: other.typedData.types.SafeTx },
      primaryType: "SafeTx",
      message: {
        to: other.typedData.message.to,
        value: 0n,
        data: other.typedData.message.data,
        operation: 0,
        safeTxGas: 0n,
        baseGas: 0n,
        gasPrice: 0n,
        gasToken: ZERO_ADDRESS,
        refundReceiver: ZERO_ADDRESS,
        nonce: BigInt(other.typedData.message.nonce),
      },
    });
    await expect(
      importSignatures(
        mine,
        JSON.stringify({ signatures: [{ owner: outsider.address, signature: sig }] }),
      ),
    ).rejects.toMatchObject({ code: "NOT_OWNER" });

    const real = await signed(0);
    await expect(
      importSignatures(
        mine,
        JSON.stringify({
          signatures: [{ owner: accounts[1]?.address, signature: real.signature }],
        }),
      ),
    ).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
  });
});
