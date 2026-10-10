/**
 * Issue 1731: the deposit forms disable deposits, with the reason, when the vault's own `depositsPaused()` is
 * true, and leave withdraw and redeem alone (`pauseDeposits()` closes the deposit side only).
 *
 * Real wagmi hooks over a fake in-memory chain (helpers/fakeChain.tsx) with a connected mock wallet. Nothing
 * inside the components is mocked.
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { encodeFunctionResult, toFunctionSelector, type Address } from "viem";
import { erc20Abi, vaultAbi } from "../../src/lib/abi";
import { DepositWithdrawTab } from "../../src/components/DepositWithdrawTab";
import { RouterDepositTab } from "../../src/components/RouterDepositTab";
import { routerAbi } from "../../src/lib/abi";
import type { VaultPreviewContext } from "../../src/lib/vaultPreview";
import { DEPOSITS_PAUSED_SELECTOR, makeFakeChain, renderOnFakeChain } from "./helpers/fakeChain";

const VAULT = "0x2222222222222222222222222222222222222222" as Address;
const VAULT_B = "0x3333333333333333333333333333333333333333" as Address;
const USDC = "0x4444444444444444444444444444444444444444" as Address;
const ROUTER = "0x5555555555555555555555555555555555555555" as Address;

const ctx: VaultPreviewContext = {
  gateway: "0x1111111111111111111111111111111111111111",
  vault: VAULT,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

const tid = (c: ParentNode, id: string) => c.querySelector(`[data-testid="${id}"]`);

// ─── The state matrix: every state x every form (issue 1731 review) ─────────────────────────────────────
//
// A deposit form is enabled ONLY in the known-open state: the chain says open, or the chain cannot be asked
// and a FRESH explorer snapshot says open. Paused, retired and unknown (including a stale or unindexed
// explorer) all disable it, with the reason shown. The withdraw form is never disabled by any of them.

import { ExplorerProvider } from "../../src/lib/ExplorerContext";
import type { FetchLike } from "../../src/lib/explorerApi";
import { vi } from "vitest";

interface Scenario {
  name: string;
  env?: Record<string, string>;
  chainId?: number;
  /** Mock wallet connected? */
  connected: boolean;
  walletChainId?: number;
  /** depositsPaused() answers; omitted = the call reverts (read failure). */
  chain?: boolean;
  explorer?: { status?: number; paused?: boolean | null; block?: number; head?: number | null };
  expectEnabled: boolean;
  notice?: RegExp;
  noChainReads?: boolean;
  /** Router form needs a wallet to preview legs, so no-wallet scenarios are single-vault only. */
  singleOnly?: boolean;
}

const UNKNOWN_TEXT = /Deposit state unknown: cannot confirm deposits are open/;
const MAINNET = { env: { VITE_ENV_CLASS: "mainnet" }, chainId: 8453 };

const SCENARIOS: Scenario[] = [
  { name: "open: chain read false", connected: true, chain: false, expectEnabled: true },
  {
    name: "paused: chain read true",
    connected: true,
    chain: true,
    expectEnabled: false,
    notice: /Deposits paused \/ closed/,
  },
  {
    name: "paused beats a fresh explorer false",
    connected: true,
    chain: true,
    explorer: { paused: false, block: 1000, head: 1005 },
    expectEnabled: false,
    notice: /Deposits paused \/ closed/,
  },
  {
    name: "retired: registry status 2",
    connected: true,
    chain: false,
    explorer: { status: 2, paused: false, block: 1000, head: 1005 },
    expectEnabled: false,
    notice: /Retired/,
  },
  {
    name: "paused: registry status 1",
    connected: true,
    chain: false,
    explorer: { status: 1, paused: false, block: 1000, head: 1005 },
    expectEnabled: false,
    notice: /Deposits paused \/ closed/,
  },
  {
    name: "unknown: chain read fails and the explorer has no row",
    connected: true,
    expectEnabled: false,
    notice: UNKNOWN_TEXT,
  },
  {
    name: "read failure, fresh explorer says open: open per index",
    connected: true,
    explorer: { paused: false, block: 1000, head: 1005 },
    expectEnabled: true,
  },
  {
    name: "read failure, STALE explorer says open: unknown",
    connected: true,
    explorer: { paused: false, block: 1000, head: 1500 },
    expectEnabled: false,
    notice: UNKNOWN_TEXT,
  },
  {
    name: "read failure, unindexed explorer (block 0) says open: unknown",
    connected: true,
    explorer: { paused: false, block: 0, head: null },
    expectEnabled: false,
    notice: UNKNOWN_TEXT,
  },
  {
    name: "read failure, explorer says paused: paused",
    connected: true,
    explorer: { paused: true, block: 1000, head: 1005 },
    expectEnabled: false,
    notice: /Deposits paused \/ closed/,
  },
  {
    name: "mainnet, no wallet, fresh explorer open: no chain read, open per index",
    ...MAINNET,
    connected: false,
    chain: false,
    explorer: { paused: false, block: 1000, head: 1005 },
    expectEnabled: true,
    noChainReads: true,
    singleOnly: true,
  },
  {
    name: "mainnet, no wallet, stale explorer open: unknown",
    ...MAINNET,
    connected: false,
    chain: false,
    explorer: { paused: false, block: 1000, head: 1500 },
    expectEnabled: false,
    notice: UNKNOWN_TEXT,
    noChainReads: true,
    singleOnly: true,
  },
  {
    name: "mainnet, wallet on the wrong chain, chain would say open but is not asked, explorer paused",
    ...MAINNET,
    connected: true,
    walletChainId: 1,
    chain: false,
    explorer: { paused: true, block: 1000, head: 1005 },
    expectEnabled: false,
    notice: /Deposits paused \/ closed/,
    noChainReads: true,
  },
  {
    name: "mainnet, wallet on the wrong chain, no explorer row: unknown",
    ...MAINNET,
    connected: true,
    walletChainId: 1,
    chain: false,
    expectEnabled: false,
    notice: UNKNOWN_TEXT,
    noChainReads: true,
  },
  {
    name: "mainnet, wallet on Base, chain read true: paused",
    ...MAINNET,
    connected: true,
    chain: true,
    expectEnabled: false,
    notice: /Deposits paused \/ closed/,
  },
  {
    name: "mainnet, wallet on Base, chain read false: open",
    ...MAINNET,
    connected: true,
    chain: false,
    expectEnabled: true,
  },
];

function explorerFor(sc: Scenario) {
  const e = sc.explorer;
  const body = {
    vaults: e
      ? [
          {
            chain_id: 8453,
            address: VAULT,
            name: "V",
            risk_label: "STABLE_YIELD",
            status: e.status ?? 0,
            deposit_cap: "0",
            total_assets: "1",
            exit_fee_bps: 0,
            deposits_paused: e.paused ?? null,
            indexed_at: "",
          },
        ]
      : [],
    block_number: e?.block ?? 1000,
    chain_head_block: e ? (e.head ?? null) : 1005,
    indexed_at: "",
  };
  return vi.fn(async () => ({
    ok: true as const,
    status: 200,
    json: async () => body,
  })) as unknown as FetchLike;
}

function routerResponder(fake: ReturnType<typeof makeFakeChain>) {
  fake.respond = (to, data) => {
    if (
      to === ROUTER.toLowerCase() &&
      data.startsWith(toFunctionSelector("getEffectiveWeights()"))
    ) {
      return encodeFunctionResult({
        abi: routerAbi,
        functionName: "getEffectiveWeights",
        result: [[VAULT], [10000n]],
      });
    }
    if (
      to === ROUTER.toLowerCase() &&
      data.startsWith(toFunctionSelector("previewDeposit(uint256)"))
    ) {
      return encodeFunctionResult({
        abi: routerAbi,
        functionName: "previewDeposit",
        result: [
          {
            vault: VAULT,
            weightBps: 10000n,
            legAmount: 1000000n,
            estShares: 1000000n,
            unavailable: false,
          },
        ],
      });
    }
    return undefined;
  };
}

function setup(sc: Scenario) {
  const fake = makeFakeChain(sc.chain === undefined ? {} : { [VAULT]: sc.chain });
  routerResponder(fake);
  const opts = {
    env: sc.env,
    chainId: sc.chainId,
    connected: sc.connected,
    walletChainId: sc.walletChainId,
  };
  return { fake, opts, fetchImpl: explorerFor(sc) };
}

describe.each(SCENARIOS)("deposit state matrix, single-vault form: $name", (sc) => {
  it("DepositWithdrawTab (single vault)", async () => {
    const { fake, opts, fetchImpl } = setup(sc);
    const { container } = await renderOnFakeChain(
      <ExplorerProvider apiUrl="http://api" fetchImpl={fetchImpl}>
        <DepositWithdrawTab vaultAddress={VAULT} usdcAddress={USDC} ctx={ctx} />
      </ExplorerProvider>,
      fake,
      opts,
    );
    const amount = () => tid(container, "deposit-amount") as HTMLInputElement;
    if (sc.expectEnabled) {
      await waitFor(() => expect(amount().disabled).toBe(false));
      // let every query settle, then check it stayed enabled with no notice
      await act(async () => {
        await new Promise((r) => setTimeout(r, 150));
      });
      expect(amount().disabled).toBe(false);
      expect(tid(container, "deposit-closed-notice")).toBeNull();
    } else {
      await waitFor(() =>
        expect(tid(container, "deposit-closed-notice")?.textContent ?? "").toMatch(sc.notice!),
      );
      expect(amount().disabled).toBe(true);
      expect((tid(container, "deposit-submit") as HTMLButtonElement).disabled).toBe(true);
      expect(
        (tid(container, "deposit-approve") as HTMLButtonElement | null)?.disabled ?? true,
      ).toBe(true);
    }
    // The withdraw side is never disabled by a deposit state.
    expect((tid(container, "withdraw-amount") as HTMLInputElement).disabled).toBe(false);
    if (sc.noChainReads) {
      expect(
        fake.calls.filter(
          (c) =>
            c.method === "eth_call" &&
            c.to === VAULT.toLowerCase() &&
            c.data?.startsWith(DEPOSITS_PAUSED_SELECTOR),
        ),
      ).toHaveLength(0);
    }
  });
});

// The router form previews its legs through the wallet, so scenarios without a wallet do not apply to it.
describe.each(SCENARIOS.filter((sc) => sc.singleOnly !== true))(
  "deposit state matrix, router form: $name",
  (sc) => {
    it("RouterDepositTab", async () => {
      const { fake, opts, fetchImpl } = setup(sc);
      const { container } = await renderOnFakeChain(
        <ExplorerProvider apiUrl="http://api" fetchImpl={fetchImpl}>
          <RouterDepositTab
            routerAddress={ROUTER}
            usdcAddress={USDC}
            ctx={{ ...ctx, router: ROUTER }}
          />
        </ExplorerProvider>,
        fake,
        opts,
      );
      const amount = () => tid(container, "router-deposit-tab-amount") as HTMLInputElement;
      if (sc.expectEnabled) {
        // The input is closed until the leg vaults (getEffectiveWeights) are known to be open.
        await waitFor(() => expect(amount().disabled).toBe(false));
        fireEvent.change(amount(), { target: { value: "1" } });
        await waitFor(() =>
          expect(
            fake.calls.some(
              (c) =>
                c.method === "eth_call" &&
                c.to === ROUTER.toLowerCase() &&
                c.data?.startsWith(toFunctionSelector("previewDeposit(uint256)")),
            ),
          ).toBe(true),
        );
        await act(async () => {
          await new Promise((r) => setTimeout(r, 200));
        });
        expect(amount().disabled).toBe(false);
        expect(tid(container, "router-deposits-closed")).toBeNull();
      } else {
        await waitFor(() =>
          expect(tid(container, "router-deposits-closed")?.textContent ?? "").toMatch(sc.notice!),
        );
        // The notice is up with NO amount typed: it must not wait for a preview.
        expect(amount().value).toBe("");
        expect(amount().disabled).toBe(true);
        expect((tid(container, "router-deposit-tab-submit") as HTMLButtonElement).disabled).toBe(
          true,
        );
      }
      if (sc.noChainReads) {
        expect(
          fake.calls.filter(
            (c) =>
              c.method === "eth_call" &&
              c.to === VAULT.toLowerCase() &&
              c.data?.startsWith(DEPOSITS_PAUSED_SELECTOR),
          ),
        ).toHaveLength(0);
      }
    });
  },
);

describe("router form: any closed leg closes it, with the count", () => {
  it("one of two legs paused", async () => {
    const fake = makeFakeChain({ [VAULT]: false, [VAULT_B]: true });
    fake.respond = (to, data) => {
      if (
        to === ROUTER.toLowerCase() &&
        data.startsWith(toFunctionSelector("previewDeposit(uint256)"))
      ) {
        return encodeFunctionResult({
          abi: routerAbi,
          functionName: "previewDeposit",
          result: [
            {
              vault: VAULT,
              weightBps: 5000n,
              legAmount: 500000n,
              estShares: 500000n,
              unavailable: false,
            },
            {
              vault: VAULT_B,
              weightBps: 5000n,
              legAmount: 500000n,
              estShares: 500000n,
              unavailable: false,
            },
          ],
        });
      }
      return undefined;
    };
    const { container } = await renderOnFakeChain(
      <RouterDepositTab
        routerAddress={ROUTER}
        usdcAddress={USDC}
        ctx={{ ...ctx, router: ROUTER }}
      />,
      fake,
      { connected: true },
    );
    fireEvent.change(tid(container, "router-deposit-tab-amount")!, { target: { value: "1" } });
    await waitFor(() =>
      expect(tid(container, "router-deposits-closed")?.textContent ?? "").toContain(
        "1 of 2 leg vaults closed",
      ),
    );
    expect((tid(container, "router-deposit-tab-submit") as HTMLButtonElement).disabled).toBe(true);
  });
});

// ─── A pause that lands while the form is open ───────────────────────────────────────────────────────────
//
// The tests above show the closed state from the start, where the deposit is also disabled for want of a
// simulation. These start with a fully enabled form (allowance, simulation, preview all good), then flip the
// vault's flag on the chain and refetch. The submit button must follow the FLAG, not the stale simulation.

describe("a pause that lands while the form is open", () => {
  const ALLOWANCE = toFunctionSelector("allowance(address,address)");
  const DEPOSIT = toFunctionSelector("deposit(uint256,address)");
  const ROUTER_DEPOSIT = toFunctionSelector("deposit(uint256,uint256[])");
  const PREVIEW = toFunctionSelector("previewDeposit(uint256)");
  const WEIGHTS = toFunctionSelector("getEffectiveWeights()");

  function fullyEnabledFake(paused: Record<string, boolean>) {
    const fake = makeFakeChain(paused);
    fake.respond = (to, data) => {
      if (data.startsWith(ALLOWANCE)) {
        return encodeFunctionResult({
          abi: erc20Abi,
          functionName: "allowance",
          result: 10n ** 30n,
        });
      }
      if (data.startsWith(DEPOSIT) && to === VAULT.toLowerCase()) {
        return encodeFunctionResult({ abi: vaultAbi, functionName: "deposit", result: 1n });
      }
      if (to === ROUTER.toLowerCase()) {
        if (data.startsWith(PREVIEW)) {
          return encodeFunctionResult({
            abi: routerAbi,
            functionName: "previewDeposit",
            result: [
              {
                vault: VAULT,
                weightBps: 10000n,
                legAmount: 1000000n,
                estShares: 1000000n,
                unavailable: false,
              },
            ],
          });
        }
        if (data.startsWith(WEIGHTS)) {
          return encodeFunctionResult({
            abi: routerAbi,
            functionName: "getEffectiveWeights",
            result: [[VAULT], [10000n]],
          });
        }
        if (data.startsWith(ROUTER_DEPOSIT)) {
          return encodeFunctionResult({ abi: routerAbi, functionName: "deposit", result: [1n] });
        }
      }
      return undefined;
    };
    return fake;
  }

  it("single-vault form: submit is enabled while open, and disabled once the vault pauses", async () => {
    const fake = fullyEnabledFake({ [VAULT]: false });
    const { container, client } = await renderOnFakeChain(
      <DepositWithdrawTab vaultAddress={VAULT} usdcAddress={USDC} ctx={ctx} />,
      fake,
      { connected: true },
    );
    fireEvent.change(tid(container, "deposit-amount")!, { target: { value: "1" } });
    await waitFor(() =>
      expect((tid(container, "deposit-submit") as HTMLButtonElement).disabled).toBe(false),
    );
    fake.paused[VAULT.toLowerCase()] = true;
    await act(async () => {
      await client.invalidateQueries();
    });
    await waitFor(() => expect(tid(container, "deposit-closed-notice")).not.toBeNull());
    expect((tid(container, "deposit-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("router form: submit is enabled while open, and disabled once a leg vault pauses", async () => {
    const fake = fullyEnabledFake({ [VAULT]: false });
    const { container, client } = await renderOnFakeChain(
      <RouterDepositTab
        routerAddress={ROUTER}
        usdcAddress={USDC}
        ctx={{ ...ctx, router: ROUTER }}
      />,
      fake,
      { connected: true },
    );
    fireEvent.change(tid(container, "router-deposit-tab-amount")!, { target: { value: "1" } });
    await waitFor(() =>
      expect((tid(container, "router-deposit-tab-submit") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fake.paused[VAULT.toLowerCase()] = true;
    await act(async () => {
      await client.invalidateQueries();
    });
    await waitFor(() => expect(tid(container, "router-deposits-closed")).not.toBeNull());
    expect((tid(container, "router-deposit-tab-submit") as HTMLButtonElement).disabled).toBe(true);
  });
});
