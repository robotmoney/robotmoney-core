/**
 * Issue 1741: the Router Governance tab shows the EFFECTIVE weights read from the router, labelled by whether the
 * voted vector is in effect.
 *
 * On the Base 8453 rehearsal router `votedWeightsActive()` is true and `getEffectiveWeights()` is the USDC vault
 * at 10000 bps. The 9500/500 vector the tab used to show is the DEFAULT vector (the last DefaultWeightsSet event),
 * which the voted WeightsSet vector overrides. The explorer's `current_weights` (the last event of either kind)
 * is deliberately the 9500/500 default here: the tab must not show it as the effective vector.
 *
 * The chain is a fake in-memory EIP-1193 transport behind the real wagmi hooks (helpers/fakeChain.tsx); the
 * explorer is a fake `fetch`. Nothing is mocked inside the component under test.
 */
import { describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { encodeFunctionResult, toFunctionSelector, type Address } from "viem";
import { RouterView } from "../../src/components/RouterView";
import { routerAbi } from "../../src/lib/abi";
import type { FetchLike } from "../../src/lib/explorerApi";
import { makeFakeChain, renderOnFakeChain } from "./helpers/fakeChain";

const ROUTER = "0x00000000000000000000000000000000000000f1" as Address;
const USDC_V = "0x00000000000000000000000000000000000000a1" as Address;
const PROTO_V = "0x00000000000000000000000000000000000000a2" as Address;
const AGENT_V = "0x00000000000000000000000000000000000000a3" as Address;
const RWA_V = "0x00000000000000000000000000000000000000a4" as Address;

type Fn = "getEffectiveWeights" | "votedWeightsActive" | "getWeights" | "getDefaultWeights";
const SELECTOR: Record<Fn, string> = {
  getEffectiveWeights: toFunctionSelector("getEffectiveWeights()"),
  votedWeightsActive: toFunctionSelector("votedWeightsActive()"),
  getWeights: toFunctionSelector("getWeights()"),
  getDefaultWeights: toFunctionSelector("getDefaultWeights()"),
};

interface RouterState {
  /** undefined makes the call revert (the router cannot be read). */
  effective?: [Address[], bigint[]];
  active?: boolean;
  voted?: [Address[], bigint[]];
  defaults?: [Address[], bigint[]];
}

const DEFAULT_VECTOR: [Address[], bigint[]] = [
  [USDC_V, PROTO_V, AGENT_V, RWA_V],
  [9500n, 500n, 0n, 0n],
];
const VOTED_USDC: [Address[], bigint[]] = [[USDC_V], [10000n]];

function fakeRouter(state: RouterState) {
  const fake = makeFakeChain();
  fake.respond = (to, data) => {
    if (to !== ROUTER.toLowerCase()) return undefined;
    const answer = (fn: Fn, value: unknown): `0x${string}` | undefined =>
      value === undefined
        ? undefined
        : encodeFunctionResult({ abi: routerAbi, functionName: fn, result: value as never });
    if (data.startsWith(SELECTOR.getEffectiveWeights)) {
      return answer("getEffectiveWeights", state.effective);
    }
    if (data.startsWith(SELECTOR.votedWeightsActive)) {
      return answer("votedWeightsActive", state.active);
    }
    if (data.startsWith(SELECTOR.getWeights)) return answer("getWeights", state.voted);
    if (data.startsWith(SELECTOR.getDefaultWeights)) {
      return answer("getDefaultWeights", state.defaults);
    }
    return undefined;
  };
  return fake;
}

const names = {
  [USDC_V]: "Robot Money USDC",
  [PROTO_V]: "Robot Money Protocol",
  [AGENT_V]: "Robot Money Agent Tokens",
  [RWA_V]: "Robot Money RWA",
};

/** The explorer as the rehearsal showed it: current_weights is the DEFAULT event's 9500/500 vector. */
const explorerFetch: FetchLike = vi.fn(async (url: string) => {
  if (url.includes("/v1/router/weights")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        current_weights: [
          { vault: USDC_V, bps: 9500 },
          { vault: PROTO_V, bps: 500 },
        ],
        history: [],
        block_number: 52424271,
        indexed_at: "2026-10-10T12:00:00Z",
      }),
    };
  }
  if (url.includes("/v1/vaults")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        vaults: Object.entries(names).map(([address, name]) => ({
          chain_id: 8453,
          address,
          name,
          risk_label: "STABLE_YIELD",
          status: 0,
          total_assets: "0",
          exit_fee_bps: 0,
          indexed_at: "2026-10-10T12:00:00Z",
        })),
        block_number: 52424271,
        indexed_at: "2026-10-10T12:00:00Z",
      }),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ proposals: [], block_number: 1, indexed_at: "2026-10-10T12:00:00Z" }),
  };
}) as unknown as FetchLike;

/** A reverting eth_call is retried by the transport before it fails: allow for it. */
const SLOW = { timeout: 15_000 };

const text = (el: HTMLElement[]) => el.map((n) => n.textContent);

describe("RouterView effective weights", () => {
  it("voted vector active: shows 'Effective: voted' with the voted vector, never the default as effective", async () => {
    const fake = fakeRouter({
      effective: VOTED_USDC,
      active: true,
      voted: VOTED_USDC,
      defaults: DEFAULT_VECTOR,
    });
    const { findByTestId, getAllByTestId, getByTestId } = await renderOnFakeChain(
      <RouterView apiUrl="http://api" fetchImpl={explorerFetch} routerAddress={ROUTER} />,
      fake,
    );
    const label = await findByTestId("router-view-weight-source");
    expect(label.textContent).toBe("Effective: voted");
    expect(label.getAttribute("data-weight-source")).toBe("voted");
    // The effective table is the USDC vault at 100%.
    expect(text(getAllByTestId("router-view-weight-vault"))).toEqual(["Robot Money USDC"]);
    expect(text(getAllByTestId("router-view-weight-bps-raw"))).toEqual(["10000"]);
    expect(text(getAllByTestId("router-view-weight-bps-pct"))).toEqual(["100.00%"]);
    // Both vectors are shown and labelled: the voted one in effect, the default one overridden.
    expect(text(getAllByTestId("router-view-voted-weight-bps-raw"))).toEqual(["10000"]);
    expect(text(getAllByTestId("router-view-default-weight-bps-raw"))).toEqual([
      "9500",
      "500",
      "0",
      "0",
    ]);
    expect(getByTestId("router-view").textContent).toContain("Voted vector (in effect)");
    expect(getByTestId("router-view").textContent).toContain(
      "Default vector (overridden by the voted vector)",
    );
    // 9500 bps is never shown as an EFFECTIVE weight.
    expect(text(getAllByTestId("router-view-weight-bps-raw"))).not.toContain("9500");
  });

  it("default only: shows 'Effective: default' and says no voted vector exists", async () => {
    const fake = fakeRouter({
      effective: DEFAULT_VECTOR,
      active: false,
      voted: [[], []],
      defaults: DEFAULT_VECTOR,
    });
    const { findByTestId, getAllByTestId, getByTestId } = await renderOnFakeChain(
      <RouterView apiUrl="http://api" fetchImpl={explorerFetch} routerAddress={ROUTER} />,
      fake,
    );
    const label = await findByTestId("router-view-weight-source");
    expect(label.textContent).toBe("Effective: default");
    expect(label.getAttribute("data-weight-source")).toBe("default");
    expect(text(getAllByTestId("router-view-weight-bps-raw"))).toEqual(["9500", "500", "0", "0"]);
    expect(getByTestId("router-view-voted-empty").textContent).toContain("No voted vector");
    expect(getByTestId("router-view").textContent).toContain("Default vector (in effect)");
  });

  it("a router that cannot be read is 'unknown' with no label and no table", async () => {
    const fake = fakeRouter({});
    const { findByTestId, queryByTestId } = await renderOnFakeChain(
      <RouterView apiUrl="http://api" fetchImpl={explorerFetch} routerAddress={ROUTER} />,
      fake,
    );
    const unknown = await findByTestId("router-view-weights-unknown", {}, SLOW);
    expect(unknown.textContent).toContain("could not be read");
    expect(queryByTestId("router-view-weight-source")).toBeNull();
    expect(queryByTestId("router-view-weights-table")).toBeNull();
  });

  it("an unreadable voted flag is 'unknown', not a guess of default", async () => {
    const fake = fakeRouter({ effective: VOTED_USDC, voted: VOTED_USDC, defaults: DEFAULT_VECTOR });
    const { findByTestId, queryByTestId } = await renderOnFakeChain(
      <RouterView apiUrl="http://api" fetchImpl={explorerFetch} routerAddress={ROUTER} />,
      fake,
    );
    await findByTestId("router-view-weights-unknown", {}, SLOW);
    expect(queryByTestId("router-view-weight-source")).toBeNull();
  });

  it("an unreadable voted or default vector is 'unknown' for that vector only", async () => {
    const fake = fakeRouter({ effective: VOTED_USDC, active: true, defaults: DEFAULT_VECTOR });
    const { findByTestId } = await renderOnFakeChain(
      <RouterView apiUrl="http://api" fetchImpl={explorerFetch} routerAddress={ROUTER} />,
      fake,
    );
    expect((await findByTestId("router-view-weight-source", {}, SLOW)).textContent).toBe(
      "Effective: voted",
    );
    expect((await findByTestId("router-view-voted-unknown", {}, SLOW)).textContent).toBe("unknown");
  });

  it("no router address configured is 'unknown' and makes no router call", async () => {
    const fake = fakeRouter({ effective: VOTED_USDC, active: true });
    const { findByTestId, queryByTestId } = await renderOnFakeChain(
      <RouterView apiUrl="http://api" fetchImpl={explorerFetch} />,
      fake,
    );
    const unknown = await findByTestId("router-view-weights-unknown", {}, SLOW);
    expect(unknown.textContent).toContain("not configured");
    expect(queryByTestId("router-view-weight-source")).toBeNull();
    expect(fake.calls.filter((c) => c.method === "eth_call")).toEqual([]);
  });

  it("the weights stay on screen when the explorer is down", async () => {
    const fake = fakeRouter({
      effective: VOTED_USDC,
      active: true,
      voted: VOTED_USDC,
      defaults: DEFAULT_VECTOR,
    });
    const down = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const { findByTestId } = await renderOnFakeChain(
      <RouterView
        apiUrl="http://api"
        fetchImpl={down as unknown as FetchLike}
        routerAddress={ROUTER}
      />,
      fake,
    );
    expect((await findByTestId("router-view-weight-source")).textContent).toBe("Effective: voted");
    await waitFor(async () =>
      expect((await findByTestId("router-view-error")).textContent).toContain("503"),
    );
  });
});
