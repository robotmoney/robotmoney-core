# Issue — User cost basis is never recorded; rolling-return computation has no data source

> Summary: PRD stories §4.1 and §4.3 both compute rolling returns against a cumulative cost basis ("7- and 30-day rolling returns against the cumulative cost basis", "weekly $ change, weekly realized APY"). The CLI emits USDC amounts at deposit/redeem time in `execute-*` output, but has no mechanism to persist them. There is no local ledger, no append-only log, no structured history file. SKILL.md and the reference files give agents no guidance on how to record cost basis, so an LLM-operated harness attempting to compute returns has no documented pattern to follow.

## 1. Severity

**Medium.** No command fails. But any agent trying to report performance as described in the user stories will either invent a tracking mechanism ad-hoc (fragile, non-portable across harnesses) or simply report current NAV with no baseline, which is not the same as a return figure.

## 2. Background

Story §4.1:
> "The harness stores a daily NAV snapshot (`shares × sharePrice` net of exit fee) and computes 7- and 30-day rolling returns against the cumulative cost basis."

Story §4.3:
> "diffs against the previous week's snapshot stored in the project's memory file, and reports: weekly $ change, weekly realized APY."

"Cost basis" here means the cumulative USDC deposited over time minus the USDC received from withdrawals — the net amount put in. Rolling returns need both the current NAV and the cost basis to compute a gain/loss figure. Neither is available from any CLI command today.

The snapshot diff itself is also unspecified. Story §4.3 mentions "the project's memory file" (Claude Code's per-project memory), and §4.1 mentions "Postgres ops log." These are harness-specific solutions with no defined schema, making the output non-portable and not described in SKILL.md.

## 3. Evidence

`packages/cli/src/commands/execute-deposit.ts` output:

```json
{
  "operation": { "type": "deposit", "summary": "..." },
  "transactions": [{ "hash": "0x...", "status": "confirmed", "blockNumber": "...", "gasUsed": "..." }],
  "preview": { "receiverShareBalance": "..." }
}
```

No `usdcDeposited` field in a history-friendly format. No write to any local file. No append to any ledger. The data is present in the JSON emitted to stdout, but it is the harness's responsibility to capture it — and the harness is given no schema or guidance for doing so.

`plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md`: no mention of cost basis, NAV snapshots, rolling returns, or how to track deposit history.

## 4. Proposed resolution

Two complementary changes:

**4.1 Structured deposit receipt**

Ensure `execute-deposit`, `execute-redeem`, and `execute-withdraw` emit a `receipt` field designed for harness logging:

```json
{
  "receipt": {
    "type": "deposit",
    "timestamp": "2026-04-29T02:00:00Z",
    "usdcIn": "500.00",
    "usdcInRaw": "500000000",
    "sharesReceived": "498.12",
    "sharesReceivedRaw": "498120000",
    "sharePrice": "1.003777",
    "navUsdcAfter": "501.25",
    "txHashes": ["0x..."]
  }
}
```

This gives every harness the fields needed to compute cost basis and NAV delta without screen-scraping the summary string.

**4.2 SKILL.md snapshot pattern**

Document the canonical harness-agnostic snapshot-and-diff pattern in SKILL.md:

1. On each `execute-deposit`: record `{ timestamp, usdcIn, sharesReceived, sharePrice }` to a ledger (harness-specific: Postgres, SQLite, Claude memory file).
2. On each performance check: call `get-balance` → compute `currentNAV = shares × sharePrice`. Compute `costBasis = Σ usdcIn − Σ usdcOut`. Compute `unrealizedReturn = currentNAV − costBasis`.
3. For APY: `annualizedAPY = (currentNAV / costBasis − 1) × (365 / daysSinceFirstDeposit)`.

The schema for the ledger entry should be stable and versioned so it can be diffed reliably across CLI versions.

## 5. Acceptance criteria

- `execute-deposit`, `execute-redeem`, `execute-withdraw` all emit a `receipt` object with `timestamp`, `usdcIn`/`usdcOut`, `sharesReceived`/`sharesBurned`, `sharePrice`, `navUsdcAfter`, and `txHashes`.
- `timestamp` is ISO8601 UTC, taken at the time the last receipt is confirmed.
- `sharesReceived` is the delta (shares minted in this tx), not the post-tx total balance. (The post-tx balance is already in `preview.receiverShareBalance`.)
- SKILL.md documents the cost-basis tracking pattern and defines the recommended ledger schema.
- Unit test: assert `receipt` fields are present and `sharesReceived = navUsdcAfter / sharePrice` within rounding.

## 6. Open questions

- **Multi-deposit cost basis.** Should `get-balance` optionally accept a `--cost-basis-usdc` argument to return an `unrealizedReturn` field inline? This would let agents get a single-call answer without maintaining their own ledger. Downside: the CLI has no access to historical deposit data, so the caller always has to supply the basis.
- **Redeem partial vs. full.** Cost basis accounting for partial redemptions requires either FIFO or average-cost accounting. The recommended harness pattern should specify which method to use to avoid portability issues between harnesses.

## 7. References

- PRD stories: [`../prd.md`](../prd.md) §4.1, §4.3
- Execute deposit output: [`../../packages/cli/src/commands/execute-deposit.ts`](../../packages/cli/src/commands/execute-deposit.ts)
- Data sources gap: [`data-sources.md`](data-sources.md) §6.4
- Related: [`issue-get-allocation-missing.md`](issue-get-allocation-missing.md)
