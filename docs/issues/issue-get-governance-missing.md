# Issue — `get-governance` command missing; agents are blind to bucket-weight changes and open votes

> Summary: PRD story §4.3 includes governance proposals in its weekly report. PRD §5.5 lists `get-governance` as a required read command: "Current bucket weights, active proposals, recent vote history." PRD §5.3 states both web and CLI surfaces expose governance state. No `get-governance` command exists. As a consequence: agents deposit without knowing whether a governance vote is about to change what they're buying; the basket composition in `lib/basket/constants.ts` can diverge from on-chain governance outcomes silently; and story §4.1's anomaly detection ("governance proposal that materially changes weights") is unimplementable.

## 1. Severity

**Medium.** Agents in stories §4.1 and §4.3 function today — deposits and withdrawals work. But they operate blind to governance state, which means they can silently buy a basket that is about to be, or has already been, changed by a vote. The longer-term risk is higher: when governance is fully live and the basket becomes dynamic, the current hardcoded basket in the CLI will produce incorrect deposits until each new CLI release ships.

## 2. Background

PRD §5.3:
> "Vote results and execution paths are observable on-chain. Both web and CLI surfaces expose current weights, active proposals, and recent vote history."

PRD §5.5 table:
> `get-governance` — "Current bucket weights, active proposals, recent vote history."

Story §4.3 weekly report:
> "any governance proposals open for vote that the builder may want to weigh in on."

Story §4.1 anomaly escalation:
> "governance proposal that materially changes weights — escalate to a founder-only Slack channel."

The website already has a governance/allocation page. The CLI has nothing.

A second, deeper issue: the basket composition is currently hardcoded in `packages/cli/src/lib/basket/constants.ts`. When a weekly governance vote changes bucket-B membership, the hardcoded CLI will continue buying the old set until a new version is published and operators upgrade. `get-governance` is the observable that would let an agent detect this drift; without it, the agent has no way to know the basket it's buying has diverged from what governance voted.

## 3. Evidence

`packages/cli/src/index.ts`: no `get-governance` command.

`packages/cli/src/lib/basket/constants.ts`: 6 tokens hardcoded with fixed pool routes. No runtime read from any governance source.

`plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md`: no mention of governance, `$ROBOTMONEY`, voting, bucket weights, or proposals. An agent using only the skill has no awareness that governance exists.

## 4. Proposed resolution

Two phases reflecting the current state of on-chain governance infrastructure.

### Phase 1 — Static / informational (shippable now)

Add `get-governance` that returns a useful response even before on-chain governance is live:

```json
{
  "dataSource": "static",
  "bucketWeights": {
    "A_stableYield": 95,
    "B_agentTokens": 5,
    "C_revenueLiquid": 0
  },
  "basketComposition": [
    { "symbol": "VIRTUAL", "weightBps": 1667, "address": "0x..." },
    { "symbol": "ROBOT",   "weightBps": 1667, "address": "0x..." },
    { "symbol": "BNKR",    "weightBps": 1667, "address": "0x..." },
    { "symbol": "JUNO",    "weightBps": 1667, "address": "0x..." },
    { "symbol": "ZFI",     "weightBps": 1666, "address": "0x..." },
    { "symbol": "GIZA",    "weightBps": 1666, "address": "0x..." }
  ],
  "activeProposals": [],
  "recentVotes": [],
  "nextWeeklyVote": null,
  "nextMonthlyVote": null,
  "note": "Governance not yet on-chain. Basket composition is fixed in CLI v0.2.x. Subscribe to releases for updates."
}
```

`dataSource: "static"` signals to agents that this data comes from the CLI binary, not from chain. An agent can check `dataSource` to know whether the data can go stale between releases.

This gives story §4.3 something to call and display in the weekly report, and story §4.1 something to check for anomalies (even if proposals array is empty for now).

### Phase 2 — Live governance reads (when on-chain)

Extend `get-governance` to read from the governance contract or indexer:

```json
{
  "dataSource": "on-chain",
  "bucketWeights": { "A_stableYield": 50, "B_agentTokens": 25, "C_revenueLiquid": 25 },
  "basketComposition": [ ... ],
  "activeProposals": [
    {
      "id": "0x...",
      "description": "Add AGENT token to bucket B",
      "votingEnds": "2026-05-05T00:00:00Z",
      "currentResult": { "for": "12500000", "against": "3200000" }
    }
  ],
  "recentVotes": [ ... ],
  "nextWeeklyVote": "2026-05-06T00:00:00Z",
  "nextMonthlyVote": "2026-06-01T00:00:00Z"
}
```

`SKILL.md` updates for both phases:
- Tell the agent to call `get-governance` before any `prepare-deposit` or `execute-deposit` when basket freshness matters.
- If `activeProposals` is non-empty, surface it to the user before depositing.
- If `dataSource === "static"` and a CLI update is available (future: CLI version check), warn that basket composition may differ from current governance.

## 5. Acceptance criteria

**Phase 1:**
- `get-governance --chain base` exits 0 and returns JSON with at minimum `dataSource`, `bucketWeights`, `basketComposition`, `activeProposals`, `recentVotes`.
- `basketComposition` matches the token list and weights in `lib/basket/constants.ts`.
- `dataSource` is `"static"`.
- `SKILL.md` documents `get-governance` and instructs the agent to call it in the weekly report flow.
- Unit test: assert output structure and that `basketComposition` totals to 10000 bps.

**Phase 2 (additional):**
- `dataSource` switches to `"on-chain"` when a governance contract address is configured.
- `activeProposals` reflects live contract state.
- `nextWeeklyVote` and `nextMonthlyVote` are ISO8601 timestamps derived from on-chain cadence parameters.

## 6. Open questions

- **Governance contract address.** Is the governance contract deployed? If not, Phase 1 is the complete scope for now.
- **Indexer vs. direct read.** Active proposals and vote history are hard to read efficiently via direct RPC (event scanning). Is there an indexer (The Graph, Goldsky, custom) for the governance contract, or does the CLI need to scan events?
- **Basket drift detection.** When Phase 2 ships and on-chain governance changes the basket, how does the CLI pick up the new token list and routes? Options: CLI reads basket from governance contract at runtime (requires route data on-chain); or CLI publishes a release with updated constants. The first is more autonomous; the second is simpler. This decision should be explicit in the governance contract design.
- **`$ROBOTMONEY` token balance.** Should `get-governance` optionally return the user's `$ROBOTMONEY` balance and voting power when `--user-address` is provided? Useful for story §4.3 (builder deciding whether to vote).

## 7. References

- PRD requirement: [`../prd.md`](../prd.md) §5.3, §5.5
- PRD stories: [`../prd.md`](../prd.md) §4.1, §4.3
- Hardcoded basket: [`../../packages/cli/src/lib/basket/constants.ts`](../../packages/cli/src/lib/basket/constants.ts)
- Skill (no governance coverage): [`../../plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md`](../../plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md)
- Related: [`issue-get-allocation-missing.md`](issue-get-allocation-missing.md)
