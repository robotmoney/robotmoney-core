/**
 * Unit tests — the agent's EIP-712 consent to a depositor binding (issue
 * 1791, QA plan D2/U4).
 *
 * The gateway's `revealAuthorization(agent, salt, policy, agentConsent)` binds
 * an agent other than the revealer only with the agent's `AgentConsent`
 * signature. These tests pin:
 *   - the digest and signature of one golden consent, the same vector
 *     `clients/rust-payment-client/src/signer/consent.rs` pins (computed with
 *     `cast` step by step and by `cast wallet sign --data`), so the dapp, rmpc
 *     and the contract agree byte for byte;
 *   - that the dapp refuses malformed, high-s and foreign consents before any
 *     commit is spent, and accepts the agent's own;
 *   - that the reveal the dapp signs is the 4-argument selector the deployed
 *     gateway has, never the removed 3-argument one.
 */
import { describe, expect, it } from "vitest";
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  toFunctionSelector,
  toHex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  agentConsentDigest,
  agentConsentRequired,
  agentConsentTypedData,
  checkAgentConsent,
  consentBytes,
  NO_AGENT_CONSENT,
  parseAgentConsent,
  rmpcAgentConsentCommand,
  type AgentConsentFields,
} from "../../src/lib/agentConsent";
import { revealAuthorizationCall } from "../../src/lib/commitReveal";
import { gatewayAbi } from "../../src/lib/abi";
import { gatewayAbiGenerated } from "../../src/lib/abi.generated";
import type { AgentPolicy } from "../../src/lib/preview";

/** Anvil #1 signs for anvil #2 on Base at gateway 0x…0b00, nonce 3. */
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const GOLDEN: AgentConsentFields = {
  agent: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  owner: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  shareReceiver: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  nonce: 3n,
  chainId: 8453,
  gateway: "0x0000000000000000000000000000000000000b00",
};
const GOLDEN_DIGEST = "0x3ac1860ad8706f9a902e92d0657147f83d27f3a7c64bd38132d667196db1cdbf";
const GOLDEN_SIGNATURE =
  "0xe38b75ee922654c47fc343bb040b28fa809f2302b4e05f99fd2090da06f897ff5d60b64ba17d2729dd8df7d7e15f7fec9059d8dcba7ffba665dc5d24924d8fb51b";

/** secp256k1 order, to build the malleable high-s twin of a signature. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe("agent consent typed data (issue 1791)", () => {
  it("the type hash is the gateway's AGENT_CONSENT_TYPEHASH", () => {
    expect(
      keccak256(
        toHex("AgentConsent(address agent,address owner,address shareReceiver,uint256 nonce)"),
      ),
    ).toBe("0x40acaac9d2c4fc03092a72bcf893dc85aaed8a0c370d54cc7c6e60e6f209f062");
    const generated = gatewayAbiGenerated.find(
      (e) => e.type === "function" && e.name === "AGENT_CONSENT_TYPEHASH",
    );
    expect(generated).toBeDefined();
  });

  it("matches the golden digest and signature rmpc and cast produce", async () => {
    expect(agentConsentDigest(GOLDEN)).toBe(GOLDEN_DIGEST);
    const signature = await privateKeyToAccount(AGENT_KEY).signTypedData(
      agentConsentTypedData(GOLDEN),
    );
    expect(signature).toBe(GOLDEN_SIGNATURE);
    expect(await checkAgentConsent(GOLDEN_SIGNATURE, GOLDEN)).toEqual({
      status: "ok",
      signature: GOLDEN_SIGNATURE,
    });
  });

  it("refuses a consent for any other owner, receiver, nonce, chain or gateway", async () => {
    const other = "0x00000000000000000000000000000000000000aa" as Address;
    for (const fields of [
      { ...GOLDEN, owner: other },
      { ...GOLDEN, shareReceiver: other },
      { ...GOLDEN, nonce: 4n },
      { ...GOLDEN, chainId: 84532 },
      { ...GOLDEN, gateway: other },
    ]) {
      const check = await checkAgentConsent(GOLDEN_SIGNATURE, fields);
      expect(check.status).toBe("wrong-signer");
      expect(consentBytes(check)).toBeNull();
    }
  });

  it("refuses malformed bytes, a bad v and the high-s twin before recovering", async () => {
    expect(await checkAgentConsent("", GOLDEN)).toEqual({ status: "missing" });
    expect((await checkAgentConsent("0x1234", GOLDEN)).status).toBe("malformed");
    expect((await checkAgentConsent("not hex", GOLDEN)).status).toBe("malformed");
    const badV = `${GOLDEN_SIGNATURE.slice(0, -2)}01`;
    expect(parseAgentConsent(badV)).toEqual({ reason: "v is 1, expected 27 or 28" });
    const s = BigInt(`0x${GOLDEN_SIGNATURE.slice(66, 130)}`);
    const highS = `${GOLDEN_SIGNATURE.slice(0, 66)}${(SECP256K1_N - s).toString(16).padStart(64, "0")}1c`;
    expect("reason" in parseAgentConsent(highS)).toBe(true);
    // The nonce read has not landed: nothing to check against yet.
    expect((await checkAgentConsent(GOLDEN_SIGNATURE, null)).status).toBe("nonce-unknown");
  });

  it("needs no consent when the revealer is the agent, and then sends empty bytes", () => {
    expect(agentConsentRequired(GOLDEN.agent, GOLDEN.agent.toLowerCase() as Address)).toBe(false);
    expect(agentConsentRequired(GOLDEN.agent, GOLDEN.owner)).toBe(true);
    expect(consentBytes({ status: "not-required" })).toBe(NO_AGENT_CONSENT);
    expect(rmpcAgentConsentCommand(GOLDEN.owner)).toBe(
      `rmpc agent-consent --config <CONFIG> --owner ${getAddress(GOLDEN.owner)}`,
    );
  });
});

describe("revealAuthorization carries the consent (issue 1791)", () => {
  const policy: AgentPolicy = {
    active: true,
    validUntil: 1_900_000_000n,
    maxPerPayment: 1n,
    maxPerWindow: 2n,
    shareReceiver: GOLDEN.owner,
    allowedDestinations: [],
    assetRecipient: "0x0000000000000000000000000000000000000000",
    maxWithdrawPerPayment: 0n,
    maxWithdrawPerWindow: 0n,
    allowedSourceVaults: [],
  };
  const salt = `0x${"11".repeat(32)}` as const;

  it("signs the 4-argument selector the deployed gateway has", () => {
    const fourArg = toFunctionSelector(
      "revealAuthorization(address,bytes32,(bool,uint64,uint256,uint256,address,address[],address,uint256,uint256,address[]),bytes)",
    );
    const threeArg = toFunctionSelector(
      "revealAuthorization(address,bytes32,(bool,uint64,uint256,uint256,address,address[],address,uint256,uint256,address[]))",
    );
    const generated = gatewayAbiGenerated.find(
      (e) => e.type === "function" && e.name === "revealAuthorization",
    );
    expect(generated && "inputs" in generated ? generated.inputs.length : 0).toBe(4);

    const calldata = encodeFunctionData({
      abi: gatewayAbi,
      ...revealAuthorizationCall({
        agent: GOLDEN.agent,
        salt,
        policy,
        agentConsent: GOLDEN_SIGNATURE,
      }),
    });
    expect(calldata.slice(0, 10)).toBe(fourArg);
    expect(calldata.slice(0, 10)).not.toBe(threeArg);
    expect(calldata).toContain(GOLDEN_SIGNATURE.slice(2));
  });

  it("a self-reveal sends empty consent bytes", () => {
    const call = revealAuthorizationCall({
      agent: GOLDEN.owner,
      salt,
      policy,
      agentConsent: NO_AGENT_CONSENT,
    });
    expect(call.args[3]).toBe("0x");
  });
});
