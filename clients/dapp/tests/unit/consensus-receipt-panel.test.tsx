// Canonical: docs/architecture.md §4.9 — Consensus Recommendation Receipt Contract
// Implements: issue #1247 acceptance criterion 6 and task 4.14
//
// The four claims the surface must make correctly, asserted individually:
//   - the payload signature count is labelled as OFF-CHAIN analyst signatures
//   - verified vs unverified renders distinctly, and names which failure it was
//   - released vs recorded-only renders distinctly
//   - applied / not-applied / cannot-determine are three distinct states

import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { ConsensusReceiptPanel } from "../../src/components/ConsensusReceiptPanel";
import {
  computeAppliedState,
  parseVaultAddressMap,
  payloadSignatureCount,
  type ReceiptPayload,
} from "../../src/lib/consensusReceiptApi";

const RECEIPT_A = "0xaaaa000000000000000000000000000000000000000000000000000000000001";
const RECEIPT_B = "0xbbbb000000000000000000000000000000000000000000000000000000000002";

const VAULTS = {
  rmAGENT: "0x1111111111111111111111111111111111111111",
  rmUSDC: "0x2222222222222222222222222222222222222222",
  rmPROTO: "0x3333333333333333333333333333333333333333",
  rmRWA: "0x4444444444444444444444444444444444444444",
};

const PAYLOAD: ReceiptPayload = {
  schema_version: "1.0",
  session_id: "12440000-0000-4000-8000-000000000001",
  subject_id: "treasury-allocation",
  created_at: "2026-08-26T16:00:00Z",
  quorum: { active: 3, submitted: 2, absent: 1, participation_bps: 6667 },
  analyst_signatures: [
    {
      member_id: "analyst-alpha",
      public_key: "k1",
      canonical_submission: "{}",
      signature: "s1",
    },
    { member_id: "analyst-beta", public_key: "k2", canonical_submission: "{}", signature: "s2" },
  ],
  weights: [
    { bucket: "agent_tokens", weight_bps: 1250 },
    { bucket: "conservative_defi_yield", weight_bps: 6000 },
    { bucket: "protocol_tokens", weight_bps: 1750 },
    { bucket: "real_world_assets", weight_bps: 1000 },
  ],
};

const MATCHING_ROUTER_WEIGHTS = [
  { vault: VAULTS.rmAGENT, bps: 1250 },
  { vault: VAULTS.rmUSDC, bps: 6000 },
  { vault: VAULTS.rmPROTO, bps: 1750 },
  { vault: VAULTS.rmRWA, bps: 1000 },
];

function ok(json: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) });
}

function makeFetch(opts: {
  receipts: unknown[];
  routerWeights?: { vault: string; bps: number }[] | "fail";
  payloadFor?: Record<string, ReceiptPayload | "fail">;
}) {
  return (url: string) => {
    if (url.includes("/v1/consensus-receipts")) {
      return ok({ receipts: opts.receipts });
    }
    if (url.includes("/v1/router/weights")) {
      if (opts.routerWeights === "fail") {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
        });
      }
      return ok({
        current_weights: opts.routerWeights ?? MATCHING_ROUTER_WEIGHTS,
        history: [],
        block_number: 1,
        indexed_at: "2026-08-27T00:00:00Z",
      });
    }
    const payload = opts.payloadFor?.[url];
    if (payload === undefined || payload === "fail") {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    }
    return ok(payload);
  };
}

const BASE_RECEIPT = {
  receipt_index: 0,
  submitter: "0x9999999999999999999999999999999999999999",
  payload_digest: "0xeecdaf43ef720ec445b8fe9c405be84a550c77fc43cfaf4be975795e8c491177",
  recorded_at: 1_772_000_000,
  block_number: 100,
  tx_hash: "0xdead",
};

describe("computeAppliedState", () => {
  it("reports applied when every bucket matches the live router weights", () => {
    expect(computeAppliedState(PAYLOAD, MATCHING_ROUTER_WEIGHTS, VAULTS)).toBe("applied");
  });

  it("reports not_applied when any bucket differs", () => {
    const drifted = MATCHING_ROUTER_WEIGHTS.map((w) =>
      w.vault === VAULTS.rmRWA ? { ...w, bps: 0 } : w,
    );
    expect(computeAppliedState(PAYLOAD, drifted, VAULTS)).toBe("not_applied");
  });

  it("reports unknown rather than not_applied when it cannot tell", () => {
    // No payload at all.
    expect(computeAppliedState(null, MATCHING_ROUTER_WEIGHTS, VAULTS)).toBe("unknown");
    // Payload carries no weights (a non-actionable session).
    expect(
      computeAppliedState({ ...PAYLOAD, weights: undefined }, MATCHING_ROUTER_WEIGHTS, VAULTS),
    ).toBe("unknown");
    // Router weights unavailable.
    expect(computeAppliedState(PAYLOAD, null, VAULTS)).toBe("unknown");
    // Deployment vault map unavailable — never substitute a zero address.
    expect(computeAppliedState(PAYLOAD, MATCHING_ROUTER_WEIGHTS, null)).toBe("unknown");
    // A vault symbol missing from the deployment map.
    expect(computeAppliedState(PAYLOAD, MATCHING_ROUTER_WEIGHTS, { rmAGENT: VAULTS.rmAGENT })).toBe(
      "unknown",
    );
  });
});

describe("parseVaultAddressMap", () => {
  it("accepts a complete, well-formed deployment map", () => {
    expect(parseVaultAddressMap(JSON.stringify(VAULTS))).toEqual(VAULTS);
  });

  it("refuses an incomplete map rather than substituting a zero address", () => {
    const partial = { rmUSDC: VAULTS.rmUSDC, rmPROTO: VAULTS.rmPROTO };
    expect(parseVaultAddressMap(JSON.stringify(partial))).toBeUndefined();
  });

  it("refuses a malformed address, malformed JSON, and an absent value", () => {
    expect(parseVaultAddressMap(JSON.stringify({ ...VAULTS, rmRWA: "0xnope" }))).toBeUndefined();
    expect(parseVaultAddressMap("{not json")).toBeUndefined();
    expect(parseVaultAddressMap(undefined)).toBeUndefined();
    expect(parseVaultAddressMap(JSON.stringify([VAULTS]))).toBeUndefined();
  });
});

describe("payloadSignatureCount", () => {
  it("counts the embedded analyst signatures", () => {
    expect(payloadSignatureCount(PAYLOAD)).toBe(2);
  });

  it("returns null rather than 0 when the payload is unavailable", () => {
    expect(payloadSignatureCount(null)).toBeNull();
  });
});

describe("ConsensusReceiptPanel", () => {
  it("labels the signature count as off-chain payload signatures, never on-chain approvals", async () => {
    const fetchImpl = makeFetch({
      receipts: [
        {
          ...BASE_RECEIPT,
          receipt_id: RECEIPT_A,
          payload_uri: "https://rm.test/api/swarm/receipts/a",
          verified: true,
          released: true,
          released_at: 1_772_100_000,
        },
      ],
      payloadFor: { "https://rm.test/api/swarm/receipts/a": PAYLOAD },
    });

    render(
      <ConsensusReceiptPanel
        explorerApiUrl="https://api.test"
        fetch={fetchImpl}
        vaultAddressBySymbol={VAULTS}
      />,
    );

    const el = await screen.findByTestId(`signatures-${RECEIPT_A}`);
    expect(el.textContent).toContain("2 off-chain analyst signatures");
    expect(el.textContent).toContain("not on-chain approvals");
    // The whole panel must never claim the record is tamper-proof at v0.1.
    const disclosure = screen.getByTestId("consensus-receipt-disclosure");
    expect(disclosure.textContent).toContain("single submitter");
    expect(disclosure.textContent?.toLowerCase()).not.toContain("tamper-proof");
    expect(disclosure.textContent?.toLowerCase()).not.toContain("censorship-resistant");
  });

  it("renders verified, released and applied states distinctly", async () => {
    const fetchImpl = makeFetch({
      receipts: [
        {
          ...BASE_RECEIPT,
          receipt_id: RECEIPT_A,
          payload_uri: "https://rm.test/api/swarm/receipts/a",
          verified: true,
          released: true,
          released_at: 1_772_100_000,
        },
      ],
      payloadFor: { "https://rm.test/api/swarm/receipts/a": PAYLOAD },
    });

    render(
      <ConsensusReceiptPanel
        explorerApiUrl="https://api.test"
        fetch={fetchImpl}
        vaultAddressBySymbol={VAULTS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId(`verification-${RECEIPT_A}`).textContent).toContain("Verified");
    });
    expect(screen.getByTestId(`release-${RECEIPT_A}`).textContent).toContain("Released");
    expect(screen.getByTestId(`applied-${RECEIPT_A}`).textContent).toContain("Applied");
  });

  it("renders unverified, unreleased and not-applied states distinctly", async () => {
    const drifted = MATCHING_ROUTER_WEIGHTS.map((w) =>
      w.vault === VAULTS.rmRWA ? { ...w, bps: 500 } : w,
    );
    const fetchImpl = makeFetch({
      receipts: [
        {
          ...BASE_RECEIPT,
          receipt_id: RECEIPT_B,
          payload_uri: "https://rm.test/api/swarm/receipts/b",
          verified: false,
          released: false,
          released_at: null,
        },
      ],
      routerWeights: drifted,
      payloadFor: { "https://rm.test/api/swarm/receipts/b": PAYLOAD },
    });

    render(
      <ConsensusReceiptPanel
        explorerApiUrl="https://api.test"
        fetch={fetchImpl}
        vaultAddressBySymbol={VAULTS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId(`verification-${RECEIPT_B}`).textContent).toContain("Unverified");
    });
    expect(screen.getByTestId(`release-${RECEIPT_B}`).textContent).toContain(
      "Recorded, not released",
    );
    expect(screen.getByTestId(`applied-${RECEIPT_B}`).textContent).toContain("Not applied");
  });

  it("says the payload is unavailable rather than showing a zero signature count", async () => {
    const fetchImpl = makeFetch({
      receipts: [
        {
          ...BASE_RECEIPT,
          receipt_id: RECEIPT_B,
          payload_uri: "https://rm.test/api/swarm/receipts/gone",
          verified: false,
          released: false,
          released_at: null,
        },
      ],
      payloadFor: {},
    });

    render(
      <ConsensusReceiptPanel
        explorerApiUrl="https://api.test"
        fetch={fetchImpl}
        vaultAddressBySymbol={VAULTS}
      />,
    );

    const sig = await screen.findByTestId(`signatures-${RECEIPT_B}`);
    expect(sig.textContent).toContain("unavailable");
    expect(sig.textContent).not.toContain("0 off-chain");
    expect(screen.getByTestId(`verification-${RECEIPT_B}`).textContent).toContain(
      "could not be fetched",
    );
    expect(screen.getByTestId(`applied-${RECEIPT_B}`).textContent).toContain("Cannot determine");
  });
});
