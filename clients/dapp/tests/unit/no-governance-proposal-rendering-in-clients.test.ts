// Source scan (issue 1698): no client renders RouterGovernance proposals or votes.
// RouterGovernance has no voting. The Safe applies a recorded consensus receipt through the
// weight setter (docs/technical/governance-decisions.md), so a proposal list, a vote button,
// a quorum, a voting period or a voting power shown anywhere would describe a contract that
// does not exist. This gate scans every client (dapp, explorer-api, rust-payment-client) for
// the deleted contract surface and the explorer routes that served it.
//
// A Safe proposal (SafeProposalPanel, safeProposal.ts: a Safe multisig transaction proposed to
// the timelock) is a different concept. No pattern below matches it: none matches the bare
// word "proposal" or "propose".
// Runs in the vitest node project.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join, relative } from "node:path";

const CLIENTS = fileURLToPath(new URL("../../..", import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));

const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "playwright-report",
  "test-results",
  ".vite",
]);
const SCANNED_EXT = /\.(ts|tsx|js|mjs|cjs|rs|sql|json|html)$/;

/** The deleted RouterGovernance voting surface and the explorer routes and tables that indexed it. */
const FORBIDDEN: readonly { readonly name: string; readonly re: RegExp }[] = [
  // Deleted events.
  {
    name: "voting event",
    re: /\b(ProposalCreated|VoteCast|ProposalExecuted|ProposalCancelled|WeightsApplied|QuorumThresholdSet|VotingPeriodSet|ExecutionDelaySet|VotingPowerSet)\b/,
  },
  // Deleted functions and parameters, camelCase or snake_case (setQuorumThreshold, voting_power, ...).
  {
    name: "voting function or parameter",
    re: /(proposal_?state|active_?proposal|cadence_?params|proposal_?vote_?snapshot|has_?voted|quorum_?threshold|voting_?period|execution_?delay|voting_?power|next_?proposal_?id)/i,
  },
  // Explorer routes, tables and event types that served proposals and votes.
  { name: "explorer proposal route", re: /\/v1\/governance\/proposals/ },
  {
    name: "explorer vote table or event",
    re: /\bgovernance_(votes?|proposals?)\b|\bGovernanceVote\b/,
  },
  // Dapp components and clients that rendered them.
  { name: "dapp proposal surface", re: /\b(GovernancePanel|governanceApi)\b/ },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SCANNED_EXT.test(entry) && entry !== SELF) out.push(full);
  }
  return out;
}

describe("no governance proposal rendering in clients (issue 1698)", () => {
  const files = walk(CLIENTS);

  it("scans the dapp, the explorer API and the payment client", () => {
    const rel = files.map((f) => relative(CLIENTS, f));
    for (const client of ["dapp/", "explorer-api/", "rust-payment-client/"]) {
      expect(rel.some((f) => f.startsWith(client))).toBe(true);
    }
  });

  it("finds no RouterGovernance proposal, vote, quorum or voting-power surface", () => {
    const hits: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const { name, re } of FORBIDDEN) {
          if (re.test(line))
            hits.push(`${relative(CLIENTS, file)}:${i + 1} [${name}] ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
