/**
 * Playwright E2E — suite-10: GovernancePanel on the REAL governance topology (issue #322, #1647).
 *
 * Nothing here is stubbed. The explorer API, the indexer and the RPC are the devnet's own, and
 * every governance fact is created on chain through the real 2-of-3 Safe and the real
 * TimelockController (security-model.md §16: Dapp e2e, no mocking):
 *
 *   (C) No proposal exists yet: the panel renders the "No proposals found" notice from the real
 *       explorer API, without an error.
 *   setup  Two full Safe -> Timelock rounds (schedule, advance the clock past getMinDelay, execute),
 *       each signed by two Safe owners through the publish-contracts Safe tool:
 *         1. RouterGovernance.setVotingPower(connected wallet, VOTING_POWER)
 *         2. RouterGovernance.propose(current router weights)
 *       RouterGovernance is admin-only, and after the handover only the timelock holds ADMIN_ROLE.
 *   (A) The panel renders the proposal the indexer read from the chain: id, proposer (the
 *       timelock), status, deadline and tally, equal to the explorer API row.
 *   (B) The connected wallet holds real, snapshot-checkpointed voting power, the Vote button is
 *       enabled by the real `useSimulateContract`, the click hands `vote()` to the wallet, and
 *       the on-chain `hasVoted` and the indexed tally move.
 *
 * The rounds advance the Twin chain clock, so this spec runs in the `safe-governance` project,
 * after every other spec has finished with the chain (playwright.config.ts).
 *
 * The spec is listed in REQUIRED_SPECS (reporters/requiredCoverage.ts) and never skips: a missing
 * panel fails the run instead of passing with zero executed tests.
 *
 * Canonical: issue #322, issue #1647, docs/technical/security-model.md §16,
 * docs/development/smoke-test-design.md.
 */

import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { test, expect } from "./helpers/fixtures";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { injectWallet, connectInjectedWallet, dismissOnboardingIfPresent } from "./helpers/wallet";
import { runTimelockRound } from "./helpers/safeGovernance";

/**
 * Raw units of admin-assigned voting power. Small on purpose: the indexer keeps tallies in a
 * BIGINT column.
 */
const VOTING_POWER = 5100n;

const governanceAbi = parseAbi([
  "function setVotingPower(address voter, uint256 power)",
  "function propose(address[] vaults, uint256[] bps) returns (uint256)",
  "function currentWeights() view returns (address[] vaults, uint256[] bps)",
  "function currentProposalId() view returns (uint256)",
  "function votingPower(address voter) view returns (uint256)",
  "function hasVoted(uint256 proposalId, address voter) view returns (bool)",
]);

interface ApiProposal {
  proposal_id: number;
  proposer: string;
  deadline_block: number;
  status: string | number;
  votes_for: number;
  votes_against: number;
}

test.describe.configure({ mode: "serial" });

let endpoints: DevnetEndpoints;
let chain: ReturnType<typeof createPublicClient>;
let governance: Address;

test.beforeAll(() => {
  endpoints = loadEndpoints();
  chain = createPublicClient({ transport: http(endpoints.rpc_url) });
  governance = endpoints.governance_addr as Address;
});

/**
 * Open the dapp with the harness wallet (`admin_*`, a funded plain EOA that holds no governance
 * role) and the "Router Governance" tab. The tab must exist: a dropped tab fails the spec.
 */
async function openGovernancePanel(page: import("@playwright/test").Page): Promise<void> {
  await injectWallet(page, {
    privateKey: endpoints.admin_private_key as Hex,
    rpcUrl: endpoints.rpc_url,
    chainId: endpoints.chain_id,
  });
  await page.goto(endpoints.dapp_url);
  await connectInjectedWallet(page);
  await dismissOnboardingIfPresent(page);
  await page.getByTestId("tab-router-governance").click();
  await expect(page.getByTestId("governance-panel")).toBeVisible({ timeout: 15_000 });
}

/** The explorer API's own proposal list, read the way the panel reads it. */
async function apiProposals(): Promise<ApiProposal[]> {
  const res = await fetch(`${endpoints.explorer_api_url}/v1/governance/proposals`);
  if (!res.ok) throw new Error(`GET /v1/governance/proposals -> ${res.status}`);
  return ((await res.json()) as { proposals: ApiProposal[] }).proposals;
}

test.describe("suite-10: GovernancePanel E2E on the real Safe topology", () => {
  test("(C) no-proposal state renders gracefully from the real explorer API", async ({ page }) => {
    // Precondition on chain and in the API, so the empty state is not vacuous.
    expect(
      await chain.readContract({
        address: governance,
        abi: governanceAbi,
        functionName: "currentProposalId",
      }),
    ).toBe(0n);
    expect(await apiProposals()).toHaveLength(0);

    await openGovernancePanel(page);
    await expect(page.getByTestId("governance-no-proposal")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("governance-error")).toHaveCount(0);
  });

  test("setup: the Safe and the timelock grant voting power and open a proposal", async () => {
    test.setTimeout(20 * 60 * 1000);
    const voter = endpoints.admin_addr as Address;
    expect(
      await chain.readContract({
        address: governance,
        abi: governanceAbi,
        functionName: "votingPower",
        args: [voter],
      }),
    ).toBe(0n);

    await runTimelockRound(endpoints, {
      target: governance,
      data: encodeFunctionData({
        abi: governanceAbi,
        functionName: "setVotingPower",
        args: [voter, VOTING_POWER],
      }),
      label: "governance e2e: setVotingPower",
    });
    expect(
      await chain.readContract({
        address: governance,
        abi: governanceAbi,
        functionName: "votingPower",
        args: [voter],
      }),
    ).toBe(VOTING_POWER);

    // Re-propose the router's current weights: every vault in them is router-eligible and Active.
    const [vaults, bps] = (await chain.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "currentWeights",
    })) as readonly [readonly Address[], readonly bigint[]];
    await runTimelockRound(endpoints, {
      target: governance,
      data: encodeFunctionData({
        abi: governanceAbi,
        functionName: "propose",
        args: [vaults, bps],
      }),
      label: "governance e2e: propose",
    });
    expect(
      await chain.readContract({
        address: governance,
        abi: governanceAbi,
        functionName: "currentProposalId",
      }),
    ).toBe(1n);

    // The indexer has to read the ProposalCreated event the timelock caused.
    await expect
      .poll(async () => (await apiProposals()).length, { timeout: 120_000, intervals: [2_000] })
      .toBe(1);
  });

  test("(A) view the open proposal the indexer read from the chain", async ({ page }) => {
    const [row] = await apiProposals();
    expect(row, "the explorer API must list the proposal").toBeTruthy();
    expect(row.proposal_id).toBe(1);
    // The proposer is the timelock: RouterGovernance.propose is admin-only and the timelock is admin.
    expect(row.proposer.toLowerCase()).toBe(endpoints.timelock_addr.toLowerCase());

    await openGovernancePanel(page);
    await expect(page.getByTestId("governance-freshness")).toBeVisible();
    await expect(page.getByTestId("governance-proposal-detail")).toBeVisible();
    await expect(page.getByTestId("governance-proposal-id")).toContainText("1");
    await expect(page.getByTestId("governance-proposal-proposer")).toContainText(
      new RegExp(endpoints.timelock_addr, "i"),
    );
    await expect(page.getByTestId("governance-proposal-status")).toContainText(
      "Open — voting in progress",
    );
    await expect(page.getByTestId("governance-proposal-deadline-block")).toContainText(
      String(row.deadline_block),
    );
    await expect(page.getByTestId("governance-proposal-votes-for")).toHaveText("0");
    await expect(page.getByTestId("governance-proposal-votes-against")).toHaveText("0");
    await expect(page.getByTestId("governance-voting-prompt")).toBeVisible();
  });

  test("(B) the wallet with real voting power votes and the tally moves", async ({
    page,
    browser,
  }) => {
    const voter = endpoints.admin_addr as Address;
    await openGovernancePanel(page);

    // The real simulate enables the button: the voter's power was checkpointed before the proposal.
    const voteBtn = page.getByTestId("governance-vote-button");
    await expect(voteBtn).toBeVisible({ timeout: 15_000 });
    await expect(voteBtn).toBeEnabled({ timeout: 60_000 });
    await voteBtn.click();
    await expect(page.getByTestId("governance-vote-success")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("governance-vote-error")).toHaveCount(0);

    // On chain: the vote is recorded for this wallet.
    await expect
      .poll(
        async () =>
          chain.readContract({
            address: governance,
            abi: governanceAbi,
            functionName: "hasVoted",
            args: [1n, voter],
          }),
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBe(true);

    // In the index: the tally moved by the voter's power.
    await expect
      .poll(async () => (await apiProposals())[0]?.votes_for, {
        timeout: 120_000,
        intervals: [2_000],
      })
      .toBe(Number(VOTING_POWER));
    // A fresh context (a second page in this one reconnects the wallet): the panel shows the indexed tally.
    const ctx = await browser.newContext();
    const fresh = await ctx.newPage();
    await openGovernancePanel(fresh);
    await expect(fresh.getByTestId("governance-proposal-votes-for")).toHaveText(
      String(VOTING_POWER),
    );
    await ctx.close();
  });
});
