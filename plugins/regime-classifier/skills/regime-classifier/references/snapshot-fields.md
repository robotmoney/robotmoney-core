# Regime Snapshot — Field Reference

Source: `https://www.robotmoney.net/data/regime-snapshot.json`

This document describes the top-level fields in the regime snapshot JSON.
The `fetch-regime-snapshot.sh` helper validates and surfaces the **required**
fields listed below. All other fields are present in the full snapshot but are
not surfaced by the skill's default output path.

## Required top-level fields (validated before surfacing)

| Field | Type | Description |
|---|---|---|
| `asof` | ISO-8601 string | UTC timestamp when the snapshot was computed |
| `regime` | `"risk_off"` \| `"neutral"` \| `"risk_on"` | Current regime bucket |
| `composite` | number (0–100) | Weighted composite risk score |
| `composite_percentile` | number (0–100) | Historical percentile rank of the composite score |
| `macro_regime` | string | Macro sub-regime label (e.g. `"contraction"`, `"expansion"`) |
| `onchain_regime` | string | On-chain sub-regime label (e.g. `"accumulation"`, `"distribution"`) |
| `macro_index` | number (0–100) | Macro sub-component score |
| `onchain_index` | number (0–100) | On-chain sub-component score |
| `bucket_thresholds` | object | Score thresholds that define each regime bucket |

### `bucket_thresholds` shape

```json
{
  "risk_off":  { "max": <number> },
  "neutral":   { "min": <number>, "max": <number> },
  "risk_on":   { "min": <number> }
}
```

## Optional / historical fields (not surfaced by default)

| Field | Type | Description |
|---|---|---|
| `history` | array | Daily composite scores — **not parsed** in the default path |
| `indicator_weights` | object | Per-indicator weight map used for the composite |
| `panel` | object | Full panel of sub-regime scores by indicator group |
| `generated_at` | ISO-8601 string | Server-side generation timestamp (may differ from `asof`) |

## Validation rules enforced by the fetch helper

1. Response HTTP status must be 200.
2. Response body must parse as JSON.
3. All five required fields (`asof`, `regime`, `composite`, `macro_regime`,
   `onchain_regime`) must be present at the top level.
4. `regime` must be one of `risk_off`, `neutral`, `risk_on`.
5. `composite` must be a number in [0, 100].

Any validation failure causes the helper to exit non-zero with a message that
names the failing field or rule.
