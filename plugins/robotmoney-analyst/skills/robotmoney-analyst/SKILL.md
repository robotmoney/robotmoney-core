---
name: robotmoney-analyst
description: >
  Fetch the current Robot Money macro + on-chain regime snapshot from
  https://www.robotmoney.net/data/regime-snapshot.json and surface
  asof, regime bucket (risk_off|neutral|risk_on), composite score,
  composite_percentile, macro_regime, onchain_regime, macro_index, and
  onchain_index as session context. Use this skill when the user asks about:
  current market regime, risk-on / risk-off conditions, macro or on-chain
  risk environment, whether now is a good time to deposit, or any question
  that needs the Robot Money regime signal as context. The skill is
  read-only and performs no on-chain action.
---

# robotmoney-analyst

> **Read-only.** This skill fetches a public JSON snapshot. It does not call
> `rmpc`, does not submit transactions, and does not modify any vault or
> gateway state.

## Invocation triggers

Invoke this skill when the user asks any of the following (or synonyms):

- "What is the current market regime?"
- "Is it risk-on or risk-off right now?"
- "What's the Robot Money regime score?"
- "Should I deposit now?" / "Is this a good time to deposit?"
- "What does the macro / on-chain regime look like?"
- "What is the composite score today?"

Do **not** invoke this skill for questions about vault balances, deposit
history, or on-chain state — use the `robotmoney-user` skill for those.

## Snapshot source

| Field | Value |
|---|---|
| Public dashboard | https://www.robotmoney.net/regime |
| JSON snapshot | https://www.robotmoney.net/data/regime-snapshot.json |
| Update cadence | Daily (UTC midnight) |

## Research datasources

The skill uses two external datasources when evaluating or creating governance
proposals. See [references/research-datasources.md](references/research-datasources.md)
for field-level schema, update frequencies, stability annotations, and
governance-decision interpretation guidance for each source.

### when to consult

#### https://www.robotmoney.net/regime

- **Required before every `propose` transaction.** Fetch the regime page to
  obtain the current regime bucket (`risk_on`, `neutral`, `risk_off`),
  composite score, and sub-regime labels. Cite these fields verbatim in the
  proposal rationale.
- When the user asks about current market conditions or whether a weight
  rebalance is appropriate.
- When evaluating a third-party governance proposal — verify the cited regime
  matches the current snapshot.

#### https://analytics.robotmoney.net/projects

- **Required before every `propose` transaction.** Check for active research
  threads relevant to the vaults or signals targeted by the proposal. Cite any
  relevant threads in the proposal rationale. If none apply, state "No active
  research threads identified for the targeted vaults."
- When the user asks about the analytical basis for a past or proposed weight
  change.
- When evaluating a third-party governance proposal — verify cited methodology
  notes are consistent with the analytics page.

## Worked examples

See [references/examples.md](references/examples.md) for a complete trace:
regime fetch → regime signal extraction → governance-proposal reasoning citing
both datasources.

## Fetch helper

Run the fetch helper to get the current snapshot:

```bash
plugins/robotmoney-analyst/scripts/fetch-regime-snapshot.sh
```

Optional flags:

| Flag | Description |
|---|---|
| `--offline <path>` | Load from a local file instead of fetching (for tests) |
| `--no-cache` | Force a fresh fetch even if a cache file exists for today |

The script exits **0** on success and writes surfaced fields to stdout as
JSON. On any fetch or schema error it exits **non-zero** and writes a clear
error message to stderr naming the missing or invalid field.

## Surfaced fields

The skill surfaces the following subset of the snapshot. See
[references/snapshot-fields.md](references/snapshot-fields.md) for the full
schema.

| Field | Type | Description |
|---|---|---|
| `asof` | ISO-8601 string | UTC timestamp of the snapshot |
| `regime` | `risk_off` \| `neutral` \| `risk_on` | Current regime bucket |
| `composite` | number | Composite risk score (0–100) |
| `composite_percentile` | number | Percentile rank of composite (0–100) |
| `macro_regime` | string | Macro sub-regime label |
| `onchain_regime` | string | On-chain sub-regime label |
| `macro_index` | number | Macro sub-index score |
| `onchain_index` | number | On-chain sub-index score |
| `bucket_thresholds` | object | Score thresholds defining each bucket |

## Caching

The helper caches responses under `/tmp/regime-snapshot-YYYY-MM-DD.json`
keyed by the **UTC date** of the fetch. A second call on the same calendar
day reads the cache file and produces byte-identical output without
re-fetching.

Cache files are never written inside the repository tree.

## Fail-closed behaviour

If the snapshot URL is unreachable, returns an HTTP error, or the response
JSON is missing any required top-level field (`regime`, `composite`, `asof`,
`macro_regime`, `onchain_regime`), the helper exits non-zero and the skill
must surface the error to the user verbatim rather than inventing a fallback
value.

## Out of scope

- Any write to the vault, gateway, or any contract
- Calling `rmpc`
- Modifying deposit decisions programmatically
- Parsing the full historical time series (only the latest snapshot is used
  by default)
- Persisting cache anywhere other than `/tmp`

## Governance read commands

The following governance read commands are thin stubs that delegate to `rmpc`
read subcommands. They are read-only and require a valid `--config` path.

### get-proposals

Fetch the active or most-recent governance proposal from the `RouterGovernance`
contract. Delegates to:

```bash
rmpc get-governance --config <CONFIG> --pretty
```

Surface the `active_proposal` field (if present) and the `cadence_params`
block. If no proposal is active, report that explicitly.

### get-weights

Read the current vault weight allocations from the `PortfolioRouter`. Delegates
to:

```bash
rmpc get-router --config <CONFIG> --pretty
```

Surface the `vault_addresses`, `weight_bps`, and `router_cap` fields.
Weight basis-points (`weight_bps`) sum to 10 000 (100 %).

### get-router

Read full `PortfolioRouter` state including vault list, weight bps, and router
cap. Delegates to:

```bash
rmpc get-router --config <CONFIG> --pretty
```

Surface all top-level fields in the response envelope. Use this when the user
asks for the full router state rather than a weights-only summary.

## Governance write commands

### propose

Submit a new weight-reallocation proposal to `RouterGovernance.propose()`.
Requires `governance_address` in the operator config and a configured signer.

**Preflight**: verify `governance_address` is set in config and `RMPC_KEYSTORE_PASSPHRASE`
is available before calling.

```bash
rmpc propose --config <CONFIG> \
  --vaults <ADDR1>,<ADDR2> \
  --weights-bps <BPS1>,<BPS2> \
  --pretty
```

Parameters:
- `--vaults` — comma-separated vault addresses (must be router-eligible)
- `--weights-bps` — comma-separated bps values summing to 10 000

Output envelope on success:
```json
{
  "ok": true,
  "result": {
    "proposal_id": "1",
    "tx_hash": "0x...",
    "block_number": 12345
  }
}
```

Exit codes: 0 success, 2 refusal (fee-cap, lock, broadcast), 3 startup failure
(missing `governance_address`, uninitialized signer).

### vote

Cast a vote on an active governance proposal.

```bash
rmpc vote --config <CONFIG> \
  --proposal-id <ID> \
  --choice yes \
  --pretty
```

Parameters:
- `--proposal-id` — decimal proposal id from `get-governance` output
- `--choice` — `yes`, `no`, or `abstain` (`yes` submits on-chain; `no`/`abstain` are client-side no-ops)

Idempotency: re-calling with the same choice exits 0 (no-op). A different
direction after an on-chain `yes` exits 2 with `ErrVoteAlreadyCast`.

Example trace (get-governance → propose → vote):

```bash
# Read current state
rmpc get-governance --config rmpc.toml --pretty

# Submit proposal
rmpc propose --config rmpc.toml --vaults 0xA...,0xB... --weights-bps 6000,4000

# Vote in favour
rmpc vote --config rmpc.toml --proposal-id 1 --choice yes

# Confirm vote recorded
rmpc get-governance --config rmpc.toml --pretty
```
