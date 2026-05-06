# Issue — `get-allocation` command missing; agents have no unified portfolio view

> Summary: PRD stories §4.1 and §4.3 both call `get-allocation` as the centrepiece of weekly treasury performance tracking. PRD §5.5 lists it as a required read command: "Unified view of vault-resident assets and externally delegated strategies." No such command exists. Without it, an agent must combine `get-balance` (vault shares) + `get-basket-holdings` (basket tokens) + any future delegated-strategy data manually — with no stable, time-comparable schema, no total portfolio value, and no timestamp for snapshot diffing. Performance tracking as described in both user stories is not implementable today.

## 1. Severity

**High.** Two of the three PRD user stories name `get-allocation` as part of their core monitoring loop. Its absence means there is no single command — and no stable JSON schema — for an agent to record and diff a portfolio snapshot over time. Rolling-return computation, NAV-drop anomaly detection (§4.1), and the weekly Monday report (§4.3) all depend on it.

## 2. Background

Story §4.1:
> "A weekly skill invokes `get-balance`, `get-vault`, and `get-allocation`. The harness stores a daily NAV snapshot (`shares × sharePrice` net of exit fee) and computes 7- and 30-day rolling returns against the cumulative cost basis. Anomalies — NAV drop > 1%, vault paused, cap full, governance proposal that materially changes weights — escalate to a founder-only Slack channel."

Story §4.3:
> "It runs `get-balance`, `get-apy`, `get-vault`, and `get-allocation`, diffs against the previous week's snapshot stored in the project's memory file, and reports: weekly $ change, weekly realized APY, current bucket weights, and any governance proposals open for vote."

PRD §5.5 table:
> `get-allocation` — "Unified view of vault-resident assets and externally delegated strategies."

PRD §5.8 (Allocation transparency):
> "Real-time, public, auditable allocation reporting across both vault-resident assets and externally delegated strategies. Both web and CLI surfaces expose the same allocation view."

The website changelog (2026-04-14) notes a delegated-strategy integration for ZYFAI and Giza positions (~$4,500 each) tracked on the allocation page — these are not reachable via any current CLI command. The website's allocation dashboard is ahead of the CLI.

## 3. Evidence

`packages/cli/src/index.ts`: no `get-allocation` command registered.

`packages/cli/src/commands/`: no `get-allocation.ts` file.

Existing commands that cover parts of the picture but not the whole:

| Command | What it covers | What it misses |
|---|---|---|
| `get-balance` | Vault shares + NAV | Basket token balances; delegated strategies; total portfolio value |
| `get-basket-holdings` | Basket token balances + USDC valuation | Vault position; delegated strategies; total |
| `get-vault` | Protocol-level TVL, caps, APY metadata | Per-user position; basket; delegated strategies |

There is no command that aggregates these into a single user-level portfolio snapshot with a consistent timestamp.

## 4. Proposed resolution

Add `get-allocation` command to `packages/cli/src/commands/get-allocation.ts` and register it in `index.ts`.

**Output schema:**

```json
{
  "user": "0x...",
  "timestamp": "2026-04-29T02:00:00Z",
  "vault": {
    "shares": "99.123456",
    "sharesRaw": "99123456",
    "navUsdc": "99.75",
    "navUsdcRaw": "99750000",
    "sharePrice": "1.006251"
  },
  "basket": [
    {
      "symbol": "VIRTUAL",
      "balance": "12.345678",
      "balanceRaw": "12345678000000000000",
      "valueUsdc": "8.21",
      "valueUsdcRaw": "8210000"
    }
  ],
  "delegatedStrategies": [
    {
      "name": "ZYFAI Stablecoin",
      "provider": "zyfai",
      "balanceUsdc": "4500.00",
      "balanceUsdcRaw": "4500000000",
      "apy": "5.2",
      "dataSource": "zyfai-api"
    }
  ],
  "totalValueUsdc": "4608.00",
  "totalValueUsdcRaw": "4608000000"
}
```

**Flags:**
- `--user-address <address>` (required)
- `--no-pricing` — skip basket quoter calls and delegated-strategy APY reads (faster; vault NAV still included)

**Implementation notes:**
- `vault` section: reuse `get-balance` logic.
- `basket` section: reuse `get-basket-holdings` logic.
- `delegatedStrategies` section: initially a static list of known strategies (ZYFAI, Giza) with their known API endpoints. Mark `dataSource` so consumers know the data freshness model. When governance makes the strategy list dynamic, this section reads from the governance contract.
- `totalValueUsdc`: sum of vault NAV + basket values + delegated balances. If `--no-pricing`, omit basket values and note in a `pricingNote` field.
- `timestamp`: ISO8601 UTC at time of the read. Consumers use this to align snapshots for diff computation.

**Snapshot diffing pattern (for SKILL.md):**
The skill should document how to store and compare snapshots:
1. Run `get-allocation` → store JSON with `timestamp`.
2. On next run, load previous JSON, diff `totalValueUsdc` and per-position `navUsdc`.
3. Compute: `weeklyChangeUsdc = current.totalValueUsdc - previous.totalValueUsdc`.
4. Compute: `realizedApy = (weeklyChangeUsdc / previous.totalValueUsdc) * 52 * 100`.

## 5. Acceptance criteria

- `get-allocation --user-address <addr> --chain base` returns the schema above with all three sections populated.
- `totalValueUsdc` equals the sum of vault NAV + all basket token values + all delegated strategy balances.
- `timestamp` is an ISO8601 UTC string accurate to the second of the RPC call.
- `--no-pricing` skips basket quoter calls and delegated-strategy API calls; `basket[].valueUsdc` and `delegatedStrategies[].balanceUsdc` are `null`; `totalValueUsdc` includes only vault NAV.
- `SKILL.md` is updated to document `get-allocation` and the snapshot-diff pattern.
- Unit test: mock all underlying reads; assert output structure, total value arithmetic, and timestamp format.
- If any sub-read fails (e.g. a delegated-strategy API is down), the command succeeds with a `warnings[]` entry rather than hard-erroring — the vault and basket data is still useful even if delegated data is unavailable.

## 6. Open questions

- **Delegated-strategy data sources.** ZYFAI and Giza positions are currently tracked via APIs on the website. Are those APIs stable enough to call from the CLI, or should the CLI read balances directly from on-chain contracts? Prefer on-chain if available (no third-party dependency in the deposit path).
- **Dynamic strategy list.** When governance eventually controls which strategies are delegated, `get-allocation` needs to read that list from chain. What's the migration path from the current static list?
- **Cost basis tracking.** Story §4.1 computes rolling returns "against cumulative cost basis." Cost basis is a per-user off-chain concept (the CLI doesn't know what the user paid). Should `get-allocation` accept an optional `--cost-basis-usdc` flag to include a realized-return field, or is that the harness's responsibility?
- **Schema versioning.** Snapshot diffing requires the schema to be stable across CLI versions. Add a `schemaVersion` field to the output so harnesses can detect breaking changes.

## 7. References

- PRD requirement: [`../prd.md`](../prd.md) §5.5, §5.8
- PRD stories: [`../prd.md`](../prd.md) §4.1, §4.3
- Partial implementations to reuse: [`../../packages/cli/src/commands/get-balance.ts`](../../packages/cli/src/commands/get-balance.ts), [`../../packages/cli/src/commands/get-basket-holdings.ts`](../../packages/cli/src/commands/get-basket-holdings.ts)
- Related: [`issue-get-balance-wallet-context.md`](issue-get-balance-wallet-context.md), [`issue-get-governance-missing.md`](issue-get-governance-missing.md)
