# Worked Examples

## Example 1 — Regime fetch → signal extraction → weight recommendation

This trace shows the full reasoning path an agent follows when a user asks it
to prepare a weight-reallocation recommendation.

### Step 1: Fetch the regime snapshot

The agent runs the fetch helper to obtain the current regime signal:

```bash
plugins/robotmoney-analyst/scripts/fetch-regime-snapshot.sh
```

Sample output:

```json
{
  "asof": "2026-06-05T00:00:00Z",
  "regime": "risk_on",
  "composite": 74.2,
  "composite_percentile": 81,
  "macro_regime": "expansion",
  "onchain_regime": "accumulation",
  "macro_index": 71.5,
  "onchain_index": 76.8,
  "bucket_thresholds": {
    "risk_off": { "max": 35 },
    "neutral":  { "min": 35, "max": 65 },
    "risk_on":  { "min": 65 }
  }
}
```

### Step 2: Extract the regime signal

The agent reads the key fields:

- **Regime bucket:** `risk_on` — composite score 74.2 is above the `risk_on`
  threshold of 65, and the 81st-percentile rank confirms historically strong
  conditions.
- **Macro sub-regime:** `expansion` — broad economic expansion supports
  higher-growth asset exposure.
- **On-chain sub-regime:** `accumulation` — on-chain capital flows favour
  long exposure.

The composite score is not near a bucket boundary (65 threshold ± 5), so no
borderline caveat is required.

### Step 3: Check research context

The agent fetches https://analytics.robotmoney.net/projects and scans for
active research threads relevant to the vaults targeted by the recommendation (here,
a growth vault weight increase from 20 % to 30 %).

Findings:

- **Thread "Growth Vault Signal Calibration" (status: active)** — methodology
  notes confirm that composite scores above 70 have historically supported
  overweighting growth vaults with a 90-day Sharpe improvement of +0.18.
- No conflicting completed research threads identified.

### Step 4: Construct the recommendation rationale

The agent drafts the recommendation rationale citing both sources:

> **Recommended weight change:** Growth Vault 20 % → 30 %; Stable Vault 30 % → 20 %
>
> **Regime signal (robotmoney.net/regime, asof 2026-06-05T00:00:00Z):**
> Current regime is `risk_on` with a composite score of 74.2
> (81st percentile). Macro sub-regime is `expansion`; on-chain sub-regime
> is `accumulation`. Score is 9.2 points above the risk-on threshold — no
> borderline caveat applies.
>
> **Research context (analytics.robotmoney.net/projects):**
> Active thread "Growth Vault Signal Calibration" supports overweighting
> growth vaults when composite > 70, citing a historical Sharpe improvement
> of +0.18 over 90 days.
>
> **Conclusion:** Both the regime signal and active research support increasing
> growth vault weight. The recommended change is consistent with documented allocation
> logic.

### Step 5: Hand the recommendation to the committee

The agent surfaces the rationale text to the user. There is no governance
write command: the recommendation reaches the chain only as a committee tilt
(`rmpc committee vote-submit`, a signed tilt that is not a vote on anything)
and then as the committee's consensus receipt, which `WEIGHT_SETTER_ROLE`
applies through the Safe and the timelock.
